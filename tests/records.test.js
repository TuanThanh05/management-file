import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { readFile, writeFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { pool, closeDb } from '../src/config/database.js';
import { env } from '../src/config/env.js';
import { todayVN } from '../src/core/time.js';
import { addYears, computeExpiry, fiscalYearEndFor } from '../src/modules/records/retention.js';
import { ROLE, createUser, createDepartment, login, directorSession, getAdminId, lastAudit } from './helpers/fixtures.js';
import { createUsableType } from './helpers/catalog.js';

const app = createApp();
const fixture = (name) => readFileSync(path.join('tests/fixtures', name));
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const blobPath = (name) => path.resolve(env.STORAGE_DIR, 'files', name);

let dept;
let owner;
let ownerCookie;
let usable;

// Gọi API bằng cookie cho trước
const as = (cookie) => ({
  get: (url) => request(app).get(url).set('Cookie', cookie),
  post: (url, body) => request(app).post(url).set('Cookie', cookie).send(body),
  patch: (url, body) => request(app).patch(url).set('Cookie', cookie).send(body),
  upload: (url, buf, name) => request(app).post(url).set('Cookie', cookie).attach('file', buf, name),
});
const me = () => as(ownerCookie);

// Tạo hồ sơ mặc định của nhân viên owner
async function newRecord(extra = {}) {
  const r = await me().post('/api/records', { title: 'Hóa đơn GTGT số 0012345', documentTypeCode: usable.type, documentDate: '2026-06-15', ...extra });
  expect(r.status).toBe(201);
  return r.body;
}

// Tên lưu trữ trên đĩa của phiên bản file
async function storageNameOf(fileId, versionNo = 1) {
  const [[row]] = await pool.query('SELECT storage_name FROM file_versions WHERE file_id = ? AND version_no = ?', [fileId, versionNo]);
  return row.storage_name;
}

beforeAll(async () => {
  usable = await createUsableType(app);
  dept = await createDepartment();
  owner = await createUser({ roles: [ROLE.EMPLOYEE], departmentId: dept.id });
  ({ cookie: ownerCookie } = await login(app, owner.email, owner.password));
});
afterAll(() => closeDb());

describe('Tính hạn lưu trữ (5.1 chức năng 7)', () => {
  it('ví dụ báo cáo: hóa đơn 15/06/2026, KT-10N từ cuối năm tài chính → 31/12/2036', () => {
    const r = computeExpiry({ retentionType: 'FIXED', retentionYears: 10, startTrigger: 'FISCAL_YEAR_END' },
      { documentDate: '2026-06-15', fiscalYearEnd: '31/12', archivedDate: '2026-11-26' });
    expect(r).toEqual({ kind: 'DATE', startDate: '2026-12-31', expiryDate: '2036-12-31' });
  });

  it('năm tài chính kết thúc 30/06; 29/02 sang năm không nhuận lấy 28/02', () => {
    expect(fiscalYearEndFor('2026-08-01', '30/06')).toBe('2027-06-30');
    expect(fiscalYearEndFor('2026-06-30', '30/06')).toBe('2026-06-30');
    expect(addYears('2024-02-29', 1)).toBe('2025-02-28');
    expect(addYears('2024-02-29', 4)).toBe('2028-02-29');
  });

  it('theo sự kiện chưa có ngày → Chưa xác định; vĩnh viễn', () => {
    expect(computeExpiry({ retentionType: 'FIXED', retentionYears: 5, startTrigger: 'EVENT_END' }, { documentDate: '2026-01-01' }).kind).toBe('UNDETERMINED');
    expect(computeExpiry({ retentionType: 'PERMANENT' }, {}).kind).toBe('PERMANENT');
  });
});

describe('Tạo, xem, sửa hồ sơ (BM01)', () => {
  it('tạo: mã HS-<PB>-<Năm>-<6 số>, Đang sử dụng, có hạn dự kiến; nhật ký không chứa tiêu đề', async () => {
    const r = await newRecord();
    expect(r.code).toMatch(new RegExp(`^HS-${dept.code}-${todayVN().slice(0, 4)}-\\d{6}$`));
    expect(r).toMatchObject({ status: 'IN_USE', validity: 'VALID', label: { code: usable.labelCode, applied: false },
      expiry: { kind: 'DATE', expiryDate: '2036-12-31', official: false }, department: { code: dept.code } });
    const log = await lastAudit('RECORD_CREATE', r.code);
    expect(JSON.stringify(log.details)).not.toContain('0012345');
  });

  it('xem trước hạn dự kiến khi đang điền phiếu', async () => {
    const r = await me().get(`/api/records/expiry-preview?documentTypeCode=${usable.type}&documentDate=2026-06-15`);
    expect(r.body.expected).toMatchObject({ kind: 'DATE', expiryDate: '2036-12-31' });
  });

  it('từ chối: loại chưa có nhãn, ngày tài liệu tương lai, ngày sự kiện khi nhãn không theo sự kiện, tiêu đề toàn khoảng trắng', async () => {
    const [[t]] = await pool.query('SELECT code FROM document_types WHERE current_label_version_id IS NULL LIMIT 1');
    if (t) expect((await me().post('/api/records', { title: 'X', documentTypeCode: t.code, documentDate: '2026-01-01' })).status).toBe(422);
    expect((await me().post('/api/records', { title: 'X', documentTypeCode: usable.type, documentDate: '2999-01-01' })).body.error.details[0].field).toBe('documentDate');
    expect((await me().post('/api/records', { title: 'X', documentTypeCode: usable.type, documentDate: '2026-01-01', eventEndDate: '2026-02-01' })).body.error.details[0].field).toBe('eventEndDate');
    expect((await me().post('/api/records', { title: '   ', documentTypeCode: usable.type, documentDate: '2026-01-01' })).status).toBe(422);
  });

  it('nhãn theo sự kiện: có ngày kết thúc → Hết hiệu lực + hạn dự kiến; chưa có → Chưa xác định', async () => {
    const ev = await createUsableType(app, { startTrigger: 'EVENT_END', eventName: 'Nhân viên nghỉ việc', retentionYears: 5 });
    const a = await me().post('/api/records', { title: 'HĐLĐ A', documentTypeCode: ev.type, documentDate: '2026-01-01', eventEndDate: '2026-03-31' });
    expect(a.body).toMatchObject({ validity: 'ENDED', eventNote: 'Nhân viên nghỉ việc', expiry: { kind: 'DATE', expiryDate: '2031-03-31' } });
    const b = await me().post('/api/records', { title: 'HĐLĐ B', documentTypeCode: ev.type, documentDate: '2026-01-01' });
    expect(b.body).toMatchObject({ validity: 'VALID', expiry: { kind: 'UNDETERMINED' } });
  });

  it('sửa: chỉ người tạo; cùng phòng xem được nhưng không sửa được; khác phòng không thấy (404)', async () => {
    const r = await newRecord();
    const u = await me().patch(`/api/records/${r.code}`, { title: 'Hóa đơn GTGT số 0099999', documentDate: '2026-07-01' });
    expect(u.body).toMatchObject({ title: 'Hóa đơn GTGT số 0099999', documentDate: '2026-07-01' });
    expect((await lastAudit('RECORD_UPDATE', r.code)).details).toMatchObject({ titleChanged: true, after: { documentDate: '2026-07-01' } });

    const mate = await createUser({ departmentId: dept.id });
    const { cookie: mateCookie } = await login(app, mate.email, mate.password);
    expect((await as(mateCookie).get(`/api/records/${r.code}`)).status).toBe(200);
    expect((await as(mateCookie).patch(`/api/records/${r.code}`, { title: 'Sửa trộm' })).status).toBe(403);

    const stranger = await createUser();
    const { cookie: strangerCookie } = await login(app, stranger.email, stranger.password);
    expect((await as(strangerCookie).get(`/api/records/${r.code}`)).status).toBe(404);

    const { cookie: gd } = await directorSession(app);
    expect((await as(gd).get(`/api/records/${r.code}`)).status).toBe(200);
    expect((await lastAudit('RECORD_VIEW', r.code)).result).toBe('SUCCESS');
  });
});

describe('File: tải lên, mã hóa, tải về (5.1 chức năng 5, 13)', () => {
  it('tải PDF lên rồi tải về đúng SHA-256; trên đĩa chỉ có bản mã; tên tiếng Việt giữ nguyên', async () => {
    const r = await newRecord();
    const pdf = fixture('sample.pdf');
    const up = await me().upload(`/api/records/${r.code}/files`, pdf, 'Hóa đơn tháng 6.pdf');
    expect(up.status).toBe(201);
    const f = up.body.files[0];
    expect(f).toMatchObject({ originalName: 'Hóa đơn tháng 6.pdf', isActive: true });
    expect(f.versions[0]).toMatchObject({ versionNo: 1, format: 'PDF', sizeBytes: pdf.length, sha256: sha(pdf), contentAvailable: true });

    const onDisk = await readFile(blobPath(await storageNameOf(f.id)));
    expect(onDisk.equals(pdf)).toBe(false);
    expect(onDisk.includes(Buffer.from('%PDF'))).toBe(false);

    const dl = await me().get(`/api/records/${r.code}/files/${f.id}/content`).buffer(true).parse((res, cb) => {
      const parts = []; res.on('data', (c) => parts.push(c)); res.on('end', () => cb(null, Buffer.concat(parts)));
    });
    expect(dl.status).toBe(200);
    expect(sha(dl.body)).toBe(sha(pdf));
    expect(dl.headers['content-disposition']).toMatch(/^attachment; .*filename\*=UTF-8''H%C3%B3a/);
    expect(dl.headers['cache-control']).toBe('no-store');
    expect((await lastAudit('FILE_DOWNLOAD', r.code)).details).toMatchObject({ fileId: f.id, versionNo: 1 });
    expect((await lastAudit('FILE_UPLOAD', r.code)).details).toMatchObject({ sha256: sha(pdf), versionNo: 1 });
  });

  it('nhận đủ 5 định dạng; ảnh xem trực tiếp được, DOCX luôn tải về', async () => {
    const r = await newRecord();
    for (const [name, file] of [['a.png', 'sample.png'], ['b.jpeg', 'sample.jpg'], ['c.docx', 'sample.docx'], ['d.xlsx', 'sample.xlsx']]) {
      expect((await me().upload(`/api/records/${r.code}/files`, fixture(file), name)).status).toBe(201);
    }
    const files = (await me().get(`/api/records/${r.code}`)).body.files;
    expect(files.map((f) => f.versions[0].format)).toEqual(['PNG', 'JPG', 'DOCX', 'XLSX']);
    const png = await me().get(`/api/records/${r.code}/files/${files[0].id}/content?download=0`);
    expect(png.headers['content-type']).toBe('image/png');
    expect(png.headers['content-disposition']).toMatch(/^inline/);
    const docx = await me().get(`/api/records/${r.code}/files/${files[2].id}/content?download=0`);
    expect(docx.headers['content-disposition']).toMatch(/^attachment/);
    expect((await lastAudit('FILE_VIEW', r.code)).result).toBe('SUCCESS');
  });

  it('chặn file .exe đổi đuôi .pdf, đuôi không khớp nội dung, file rỗng', async () => {
    const r = await newRecord();
    const exe = await me().upload(`/api/records/${r.code}/files`, fixture('fake.exe'), 'hoadon.pdf');
    expect(exe.status).toBe(422);
    expect(exe.body.error.details[0].message).toMatch(/thực tế: EXE/);
    const mismatch = await me().upload(`/api/records/${r.code}/files`, fixture('sample.png'), 'hoadon.pdf');
    expect(mismatch.body.error.message).toBe('Đuôi file không khớp nội dung');
    expect(mismatch.body.error.details[0].message).toMatch(/thực tế là PNG/);
    expect((await me().upload(`/api/records/${r.code}/files`, Buffer.alloc(0), 'x.pdf')).status).toBe(422);
  });

  it('vượt dung lượng theo tham số MAX_FILE_SIZE_MB thì 413', async () => {
    const r = await newRecord();
    const admin = await getAdminId();
    await pool.query("UPDATE system_settings SET value = '1', updated_by = ? WHERE setting_key = 'MAX_FILE_SIZE_MB'", [admin]);
    try {
      const big = Buffer.concat([fixture('sample.pdf'), Buffer.alloc(1024 * 1024 + 10)]);
      const res = await me().upload(`/api/records/${r.code}/files`, big, 'big.pdf');
      expect(res.status).toBe(413);
      expect(res.body.error.message).toBe('File vượt quá 1 MB');
    } finally {
      await pool.query("UPDATE system_settings SET value = '20', updated_by = ? WHERE setting_key = 'MAX_FILE_SIZE_MB'", [admin]);
    }
  });

  it('sửa 1 byte bản mã trong kho → từ chối trả file, ghi nhật ký, cảnh báo Quản trị và Giám đốc', async () => {
    const r = await newRecord();
    const up = await me().upload(`/api/records/${r.code}/files`, fixture('sample.pdf'), 'x.pdf');
    const fileId = up.body.files[0].id;
    const p = blobPath(await storageNameOf(fileId));
    const buf = await readFile(p);
    buf[5] ^= 0xff;
    await writeFile(p, buf);

    const res = await me().get(`/api/records/${r.code}/files/${fileId}/content`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('FILE_INTEGRITY_FAILED');
    const log = await lastAudit('FILE_INTEGRITY_FAILED', r.code);
    expect(log).toMatchObject({ result: 'FAILURE' });
    expect(log.details.reason).toBe('AUTH_TAG');
    const [alerts] = await pool.query("SELECT recipient_id FROM notifications WHERE type = 'SECURITY_ALERT' AND object_code = ?", [r.code]);
    expect(alerts.length).toBeGreaterThanOrEqual(2);
  });

  it('thay file: tạo phiên bản 2, phiên bản 1 vẫn tải được; gỡ file vẫn giữ lịch sử', async () => {
    const r = await newRecord();
    const up = await me().upload(`/api/records/${r.code}/files`, fixture('sample.pdf'), 'v1.pdf');
    const fileId = up.body.files[0].id;
    const v2 = await me().upload(`/api/records/${r.code}/files/${fileId}/versions`, fixture('sample.png'), 'v2.png');
    expect(v2.body.files[0].versions.map((v) => v.versionNo)).toEqual([1, 2]);
    const old = await me().get(`/api/records/${r.code}/files/${fileId}/content?version=1`);
    expect(old.headers['content-type']).toBe('application/pdf');
    expect(old.headers['x-file-version']).toBe('1');

    const rm = await me().post(`/api/records/${r.code}/files/${fileId}/remove`);
    expect(rm.body.files[0]).toMatchObject({ isActive: false });
    expect(rm.body.files[0].versions).toHaveLength(2);
    expect((await me().upload(`/api/records/${r.code}/files/${fileId}/versions`, fixture('sample.pdf'), 'v3.pdf')).status).toBe(404);
  });
});

describe('Hủy bỏ hồ sơ tạo nhầm (BM06)', () => {
  it('bắt buộc lý do và xác nhận; hủy xong: khóa bị xóa, bản mã bị xóa khỏi kho, không mở lại được', async () => {
    const r = await newRecord();
    const up = await me().upload(`/api/records/${r.code}/files`, fixture('sample.pdf'), 'x.pdf');
    const fileId = up.body.files[0].id;
    const p = blobPath(await storageNameOf(fileId));

    expect((await me().post(`/api/records/${r.code}/cancel`, { reason: 'Tạo nhầm loại tài liệu' })).status).toBe(422);
    expect((await me().post(`/api/records/${r.code}/cancel`, { reason: 'ngắn', confirm: true })).status).toBe(422);
    const c = await me().post(`/api/records/${r.code}/cancel`, { reason: 'Tạo nhầm loại tài liệu', confirm: true });
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ status: 'CANCELLED', cancelReason: 'Tạo nhầm loại tài liệu' });
    expect(c.body.files[0].versions[0]).toMatchObject({ contentAvailable: false, purged: true, sha256: up.body.files[0].versions[0].sha256 });

    const [[v]] = await pool.query('SELECT wrapped_key, is_purged FROM file_versions WHERE file_id = ?', [fileId]);
    expect(v.wrapped_key).toBeNull();
    await expect(access(p)).rejects.toThrow();
    expect((await me().get(`/api/records/${r.code}/files/${fileId}/content`)).status).toBe(410);
    expect((await me().upload(`/api/records/${r.code}/files`, fixture('sample.pdf'), 'y.pdf')).status).toBe(409);
    expect((await lastAudit('RECORD_CANCEL', r.code)).details).toMatchObject({ destroyedKeys: 1 });
  });

  it('người khác không hủy bỏ được', async () => {
    const r = await newRecord();
    const mate = await createUser({ departmentId: dept.id });
    const { cookie } = await login(app, mate.email, mate.password);
    expect((await as(cookie).post(`/api/records/${r.code}/cancel`, { reason: 'Không phải của tôi', confirm: true })).status).toBe(403);
  });
});
