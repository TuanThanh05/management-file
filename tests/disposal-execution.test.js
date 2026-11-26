import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { access, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { pool, closeDb } from '../src/config/database.js';
import { env } from '../src/config/env.js';
import { ROLE, createUser, createDepartment, login, sessionWithRoles, adminSession, directorSession, lastAudit } from './helpers/fixtures.js';
import { createUsableType } from './helpers/catalog.js';

const app = createApp();
const pdf = readFileSync(path.join('tests/fixtures', 'sample.pdf'));
const png = readFileSync(path.join('tests/fixtures', 'sample.png'));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const exists = (p) => access(p).then(() => true, () => false);
const binary = (req) => req.buffer(true).parse((res, cb) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });

// Gọi API bằng cookie cho trước
const as = (cookie) => ({
  get: (url, query) => request(app).get(url).query(query ?? {}).set('Cookie', cookie),
  post: (url, body) => request(app).post(url).set('Cookie', cookie).send(body),
  raw: (url) => binary(request(app).get(url).set('Cookie', cookie)),
  upload: (url, buf = pdf, name = 'chung-tu.pdf') => request(app).post(url).set('Cookie', cookie).attach('file', buf, name),
});

// Đăng nhập người dùng mới với vai trò và phòng ban cho trước
async function userIn(departmentId, roles) {
  const user = await createUser({ roles, departmentId });
  const { cookie } = await login(app, user.email, user.password);
  return { user, api: as(cookie) };
}

let dept;
let emp;
let head;
let officer;
let director;
let admin;
let types;

// Tạo hồ sơ Hết hạn có dấu hủy; personal = nhãn có dữ liệu cá nhân; extraVersion = thêm phiên bản file thứ 2
async function eligible({ personal = false, extraVersion = false, title = 'Hợp đồng lao động Nguyễn Văn A' } = {}) {
  const r = await emp.api.post('/api/records', { title, documentTypeCode: personal ? types.personal : types.plain, documentDate: '2019-03-01' });
  const up = await emp.api.upload(`/api/records/${r.body.code}/files`);
  if (extraVersion) await emp.api.upload(`/api/records/${r.body.code}/files/${up.body.files[0].id}/versions`, png, 'chung-tu.png').expect(201);
  await emp.api.post(`/api/records/${r.body.code}/submit`).expect(200);
  await head.api.post(`/api/records/${r.body.code}/approve`).expect(200);
  return r.body.code;
}

// Đưa các hồ sơ vào đợt, duyệt đủ 2 cấp, rồi lùi giờ hẹn hủy về quá khứ
async function dueBatch(codes) {
  await admin.post('/api/admin/jobs/expiry-scan/run').expect(200);
  await officer.api.post('/api/retention/eligibility', { recordCodes: codes, eligible: true }).expect(200);
  const c = (await officer.api.post('/api/disposals', { departmentCode: dept.code, reason: 'Hồ sơ nhân sự quá hạn lưu trữ', recordCodes: codes })).body.code;
  await officer.api.post(`/api/disposals/${c}/submit`).expect(200);
  await head.api.post(`/api/disposals/${c}/approve-level-1`, { comment: 'Đồng ý' }).expect(200);
  await director.api.post(`/api/disposals/${c}/approve-level-2`, { comment: 'Đồng ý hủy' }).expect(200);
  await pool.query(
    `UPDATE disposal_batches SET level2_approved_at = level2_approved_at - INTERVAL 4 DAY, scheduled_at = UTC_TIMESTAMP(3) - INTERVAL 1 SECOND WHERE code = ?`, [c]);
  return c;
}

const runExecution = () => admin.post('/api/admin/jobs/disposal-execution/run');

// Phiên bản file của hồ sơ trong CSDL
async function versionsOf(code) {
  const [rows] = await pool.query(
    `SELECT v.storage_name, v.wrapped_key, v.is_purged FROM file_versions v JOIN files f ON f.id = v.file_id JOIN records r ON r.id = f.record_id WHERE r.code = ?`, [code]);
  return rows;
}

beforeAll(async () => {
  types = {
    plain: (await createUsableType(app, { retentionYears: 1 })).type,
    personal: (await createUsableType(app, { retentionYears: 1, containsPersonalData: true })).type,
  };
  dept = await createDepartment();
  emp = await userIn(dept.id, [ROLE.EMPLOYEE]);
  head = await userIn(dept.id, [ROLE.DEPARTMENT_HEAD]);
  const o = await sessionWithRoles(app, [ROLE.RECORDS_OFFICER]);
  officer = { user: o.user, api: as(o.cookie) };
  admin = as((await adminSession(app)).cookie);
  const d = await directorSession(app);
  director = { user: d.director, api: as(d.cookie) };
});
afterAll(() => closeDb());

describe('Thực hiện hủy và lập biên bản (QT4.2, BM16)', () => {
  let batch;
  let personal;
  let plain;

  it('Giám đốc thấy đợt đang trong thời gian chờ ở hàng chờ duyệt', async () => {
    const tmp = await eligible({ title: 'Chờ hủy' });
    await admin.post('/api/admin/jobs/expiry-scan/run').expect(200);
    await officer.api.post('/api/retention/eligibility', { recordCodes: [tmp], eligible: true }).expect(200);
    const c = (await officer.api.post('/api/disposals', { departmentCode: dept.code, reason: 'Hồ sơ nhân sự quá hạn lưu trữ', recordCodes: [tmp] })).body.code;
    await officer.api.post(`/api/disposals/${c}/submit`).expect(200);
    await head.api.post(`/api/disposals/${c}/approve-level-1`, {}).expect(200);
    expect((await director.api.get('/api/records/approvals')).body.disposalsLevel2.some((b) => b.code === c)).toBe(true);
    await director.api.post(`/api/disposals/${c}/approve-level-2`, {}).expect(200);
    const q = await director.api.get('/api/records/approvals');
    const item = q.body.disposalsScheduled.find((b) => b.code === c);
    expect(item.minutesLeft).toBeGreaterThan(60 * 24);
    expect(Array.isArray(q.body.labelProposals)).toBe(true);
  });

  it('xóa khóa mọi phiên bản, xóa bản mã, che tiêu đề nếu có dữ liệu cá nhân, đợt Hoàn tất có biên bản', async () => {
    personal = await eligible({ personal: true, extraVersion: true });
    plain = await eligible({ title: 'Bảng chấm công tháng 3' });
    batch = await dueBatch([personal, plain]);
    const before = await versionsOf(personal);
    expect(before).toHaveLength(2);

    const r = await runExecution();
    expect(r.status).toBe(200);
    expect(r.body.result).toBe('SUCCESS');

    for (const v of await versionsOf(personal)) {
      expect(v.wrapped_key).toBeNull();
      expect(Number(v.is_purged)).toBe(1);
      expect(await exists(path.resolve(env.STORAGE_DIR, 'files', v.storage_name))).toBe(false);
    }
    const [[p]] = await pool.query('SELECT status, title, description, disposed_at FROM records WHERE code = ?', [personal]);
    expect(p).toMatchObject({ status: 'DISPOSED', title: personal, description: null });
    const [[n]] = await pool.query('SELECT status, title FROM records WHERE code = ?', [plain]);
    expect(n).toMatchObject({ status: 'DISPOSED', title: 'Bảng chấm công tháng 3' });

    const d = (await officer.api.get(`/api/disposals/${batch}`)).body;
    expect(d.status).toBe('COMPLETED');
    expect(d.certificate.no).toMatch(/^BB-\d{4}-\d{4}$/);
    expect(d.records.every((x) => x.itemStatus === 'DISPOSED' && x.disposedAt)).toBe(true);
    expect((await lastAudit('RECORD_DISPOSE', personal)).details.titleMasked).toBe(true);
    const [[{ n: notes }]] = await pool.query('SELECT COUNT(*) AS n FROM notifications WHERE recipient_id = ? AND object_code = ? AND type = ?', [director.user.id, batch, 'REVIEW_RESULT']);
    expect(Number(notes)).toBeGreaterThanOrEqual(1);
  });

  it('hồ sơ đã hủy: chỉ còn dấu vết, không mở được file, không thu hồi được đợt', async () => {
    const rec = await head.api.get(`/api/records/${personal}`);
    expect(rec.body).toMatchObject({ status: 'DISPOSED', title: personal });
    const fileId = rec.body.files[0].id;
    expect((await emp.api.get(`/api/records/${personal}/files/${fileId}/content`)).status).toBe(410);
    expect((await director.api.post(`/api/disposals/${batch}/revoke`, { reason: 'Thử thu hồi sau khi hủy', confirm: true })).status).toBe(409);
  });

  it('tải biên bản: PDF đúng mã băm; chỉ Cán bộ lưu trữ; bản chụp không chứa tiêu đề đã che', async () => {
    const res = await officer.api.raw(`/api/disposals/${batch}/certificate`);
    expect(res.status).toBe(200);
    expect(res.body.subarray(0, 5).toString()).toBe('%PDF-');
    const [[c]] = await pool.query('SELECT c.pdf_sha256, c.snapshot FROM disposal_certificates c JOIN disposal_batches b ON b.id = c.batch_id WHERE b.code = ?', [batch]);
    expect(sha(res.body)).toBe(c.pdf_sha256);
    expect(res.headers['x-content-sha256']).toBe(c.pdf_sha256);
    const snap = typeof c.snapshot === 'string' ? JSON.parse(c.snapshot) : c.snapshot;
    expect(snap.records.map((x) => x.code).sort()).toEqual([personal, plain].sort());
    expect(snap.records.find((x) => x.code === personal)).toMatchObject({ title: personal, fileCount: 2 });
    expect(JSON.stringify(snap)).not.toContain('Nguyễn Văn A');
    expect(snap.batch.level2.comment).toBe('Đồng ý hủy');
    expect((await director.api.get(`/api/disposals/${batch}/certificate`)).status).toBe(403);
    expect(await lastAudit('CERTIFICATE_DOWNLOAD', snap.certificateNo)).toBeTruthy();
  });

  it('biên bản bị sửa trong kho → 409, cảnh báo Giám đốc', async () => {
    const [[c]] = await pool.query('SELECT c.certificate_no, c.pdf_storage_name FROM disposal_certificates c JOIN disposal_batches b ON b.id = c.batch_id WHERE b.code = ?', [batch]);
    await writeFile(path.resolve(env.STORAGE_DIR, 'certificates', c.pdf_storage_name), Buffer.from('%PDF-1.3 bị sửa'));
    const r = await officer.api.get(`/api/disposals/${batch}/certificate`);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('FILE_INTEGRITY_FAILED');
    const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM notifications WHERE recipient_id = ? AND object_code = ? AND type = 'SECURITY_ALERT'", [director.user.id, c.certificate_no]);
    expect(Number(n)).toBe(1);
  });

  it('kiểm tra lần cuối: hồ sơ không còn Chờ duyệt hủy bị rút, ghi vào biên bản', async () => {
    const ok = await eligible({ title: 'Phiếu lương A' });
    const bad = await eligible({ title: 'Phiếu lương B' });
    const c = await dueBatch([ok, bad]);
    await pool.query("UPDATE records SET status = 'EXPIRED' WHERE code = ?", [bad]);
    expect((await runExecution()).body.result).toBe('SUCCESS');
    const d = (await officer.api.get(`/api/disposals/${c}`)).body;
    expect(d.status).toBe('COMPLETED');
    expect(d.removed[0]).toMatchObject({ code: bad, itemStatus: 'WITHDRAWN' });
    expect(d.removed[0].reason).toMatch(/^Không đạt kiểm tra lần cuối/);
    const [[s]] = await pool.query('SELECT c.snapshot FROM disposal_certificates c JOIN disposal_batches b ON b.id = c.batch_id WHERE b.code = ?', [c]);
    const snap = typeof s.snapshot === 'string' ? JSON.parse(s.snapshot) : s.snapshot;
    expect(snap.withdrawn.map((w) => w.code)).toEqual([bad]);
    expect((await versionsOf(bad))[0].wrapped_key).not.toBeNull();
  });

  it('không còn hồ sơ đạt kiểm tra lần cuối → đợt về Nháp, không lập biên bản', async () => {
    const only = await eligible({ title: 'Phiếu lương C' });
    const c = await dueBatch([only]);
    await pool.query("UPDATE records SET status = 'EXPIRED' WHERE code = ?", [only]);
    await runExecution().expect(200);
    const d = (await officer.api.get(`/api/disposals/${c}`)).body;
    expect(d).toMatchObject({ status: 'DRAFT', lastReturnReason: 'Không còn hồ sơ đạt kiểm tra lần cuối', certificate: null, level2: null });
  });
});

describe('Nhật ký và kiểm tra toàn vẹn (5.4 CN14–15, BM18–19)', () => {
  it('xem nhật ký: mặc định 7 ngày, 50 dòng/trang, lọc theo đối tượng; lượt xem được ghi lại', async () => {
    const r = await director.api.get('/api/audit/logs', { objectCode: dept.code });
    expect(r.status).toBe(200);
    expect(r.body.pageSize).toBe(50);
    expect(Date.parse(r.body.to) - Date.parse(r.body.from)).toBe(7 * 86_400_000);
    const all = await admin.get('/api/audit/logs', { actions: 'RECORD_DISPOSE', result: 'SUCCESS' });
    expect(all.body.items.length).toBeGreaterThan(0);
    expect(all.body.items.every((i) => i.action === 'RECORD_DISPOSE' && i.hash.length === 64)).toBe(true);
    const [[last]] = await pool.query("SELECT action, user_id FROM audit_logs ORDER BY seq DESC LIMIT 1");
    expect(last.action).toBe('AUDIT_VIEW');
    expect((await officer.api.get('/api/audit/logs')).status).toBe(403);
    expect((await director.api.get('/api/audit/logs', { from: '2026-12-01T00:00:00Z', to: '2026-11-01T00:00:00Z' })).status).toBe(422);
  });

  it('kiểm tra toàn vẹn toàn bộ chuỗi → INTACT; lưu lịch sử; phạm vi sai → 422', async () => {
    const [[head]] = await pool.query('SELECT last_seq FROM audit_chain_head WHERE id = 1');
    const r = await director.api.post('/api/audit/verify', {});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ result: 'INTACT', fromSeq: 1, firstBad: null });
    expect(r.body.checkedCount).toBe(Number(head.last_seq));
    expect(r.body.lastHash).toMatch(/^[0-9a-f]{64}$/);
    const part = await admin.post('/api/audit/verify', { fromSeq: 2, toSeq: 5 });
    expect(part.body).toMatchObject({ result: 'INTACT', checkedCount: 4 });
    expect((await admin.post('/api/audit/verify', { fromSeq: 5, toSeq: 2 })).status).toBe(422);
    const checks = await admin.get('/api/audit/checks');
    expect(checks.body.items[0]).toMatchObject({ fromSeq: 2, toSeq: 5, result: 'INTACT' });
    expect((await officer.api.post('/api/audit/verify', {})).status).toBe(403);
  });
});
