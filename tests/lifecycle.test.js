import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { pool, closeDb } from '../src/config/database.js';
import { ROLE, createUser, createDepartment, login, sessionWithRoles, adminSession, directorSession } from './helpers/fixtures.js';

const app = createApp();
const pdf = readFileSync(path.join('tests/fixtures', 'sample.pdf'));

// Gọi API bằng cookie cho trước; kiểm tra mã trạng thái mong đợi
const as = (cookie) => {
  const call = (method, url, body, expected) => {
    let r = request(app)[method](url).set('Cookie', cookie);
    if (body !== undefined) r = r.send(body);
    return r.then((res) => {
      if (expected) expect(res.status, `${method.toUpperCase()} ${url}: ${JSON.stringify(res.body)}`).toBe(expected);
      return res;
    });
  };
  return {
    get: (url, expected = 200) => call('get', url, undefined, expected),
    post: (url, body = {}, expected = 200) => call('post', url, body, expected),
    upload: (url) => request(app).post(url).set('Cookie', cookie).attach('file', pdf, 'hop-dong.pdf').expect(201),
  };
};

let cbl;
let gd;
let tp;
let nv;
let qt;
let dept;

beforeAll(async () => {
  dept = await createDepartment();
  const mk = async (roles) => { const u = await createUser({ roles, departmentId: dept.id }); return { user: u, api: as((await login(app, u.email, u.password)).cookie) }; };
  nv = await mk([ROLE.EMPLOYEE]);
  tp = await mk([ROLE.DEPARTMENT_HEAD]);
  const o = await sessionWithRoles(app, [ROLE.RECORDS_OFFICER]);
  cbl = { user: o.user, api: as(o.cookie) };
  const d = await directorSession(app);
  gd = { user: d.director, api: as(d.cookie) };
  qt = as((await adminSession(app)).cookie);
});
afterAll(() => closeDb());

describe('Vòng đời hồ sơ từ tạo đến hủy (QT1 → QT4)', () => {
  it('nhãn → hồ sơ → lưu trữ → hết hạn → đợt hủy 2 cấp → hủy bằng mật mã → biên bản → nhật ký toàn vẹn', async () => {
    const sfx = String(Date.now()).slice(-6);
    // QT2: Cán bộ lưu trữ lập nhóm, loại tài liệu, đề xuất nhãn; Giám đốc phê duyệt
    await cbl.api.post('/api/catalog/groups', { code: `NS${sfx}`, name: 'Hồ sơ nhân sự' }, 201);
    await cbl.api.post('/api/catalog/document-types', { code: `HDLD${sfx}`, name: 'Hợp đồng lao động', groupCode: `NS${sfx}` }, 201);
    const prop = (await cbl.api.post('/api/labels/proposals', {
      proposalType: 'CREATE', labelCode: `NS-1N-${sfx}`, groupCode: `NS${sfx}`, labelName: 'Hồ sơ nhân sự 1 năm', legalBasis: 'Quy chế nội bộ',
      retentionType: 'FIXED', retentionYears: 1, startTrigger: 'EVENT_END', eventName: 'Nhân viên nghỉ việc', warningDays: 30,
      containsPersonalData: true, documentTypeCodes: [`HDLD${sfx}`], proposalReason: 'Ban hành nhãn cho hợp đồng lao động',
    }, 201)).body;
    await cbl.api.post(`/api/labels/proposals/${prop.id}/submit`);
    await gd.api.post(`/api/labels/proposals/${prop.id}/approve`);

    // QT1: Nhân viên tạo hồ sơ, tải file, gửi; Trưởng phòng duyệt lưu trữ
    const code = (await nv.api.post('/api/records', { title: 'HĐLĐ Trần Thị B', documentTypeCode: `HDLD${sfx}`, documentDate: '2019-01-02' }, 201)).body.code;
    await nv.api.upload(`/api/records/${code}/files`);
    await nv.api.post(`/api/records/${code}/submit`);
    const archived = (await tp.api.post(`/api/records/${code}/approve`)).body;
    expect(archived.expiry.kind).toBe('UNDETERMINED');

    // QT3.1: Trưởng phòng ghi nhận nghỉ việc → hạn = 2020-06-30 + 1 năm; job quét chuyển Hết hạn
    const ended = (await tp.api.post(`/api/records/${code}/mark-ended`, { eventEndDate: '2020-06-30', eventNote: 'Nghỉ việc theo QĐ 15/QĐ-NS' })).body;
    expect(ended.expiry).toMatchObject({ kind: 'DATE', expiryDate: '2021-06-30' });
    await qt.post('/api/admin/jobs/expiry-scan/run');
    expect((await nv.api.get(`/api/records/${code}`)).body.status).toBe('EXPIRED');

    // QT3.2 + QT4.1: Cán bộ lưu trữ đánh dấu, lập đợt; Trưởng phòng cấp 1; Giám đốc cấp 2
    await cbl.api.post('/api/retention/eligibility', { recordCodes: [code], eligible: true });
    const batch = (await cbl.api.post('/api/disposals', { departmentCode: dept.code, reason: 'Hợp đồng lao động đã hết thời hạn lưu', recordCodes: [code] }, 201)).body.code;
    await cbl.api.post(`/api/disposals/${batch}/submit`);
    await tp.api.post(`/api/disposals/${batch}/approve-level-1`, { comment: 'Đồng ý' });
    await gd.api.post(`/api/disposals/${batch}/approve-level-2`, { comment: 'Đồng ý hủy' });

    // QT4.2: hết thời gian chờ → hủy bằng mật mã, che tiêu đề, lập biên bản
    await pool.query('UPDATE disposal_batches SET level2_approved_at = level2_approved_at - INTERVAL 4 DAY, scheduled_at = UTC_TIMESTAMP(3) - INTERVAL 1 SECOND WHERE code = ?', [batch]);
    expect((await qt.post('/api/admin/jobs/disposal-execution/run')).body.result).toBe('SUCCESS');
    const rec = (await tp.api.get(`/api/records/${code}`)).body;
    expect(rec).toMatchObject({ status: 'DISPOSED', title: code });
    await nv.api.get(`/api/records/${code}/files/${rec.files[0].id}/content`, 410);
    const b = (await cbl.api.get(`/api/disposals/${batch}`)).body;
    expect(b.status).toBe('COMPLETED');
    expect(b.certificate.no).toMatch(/^BB-/);
    await cbl.api.get(`/api/disposals/${batch}/certificate`);

    // Lịch sử hồ sơ đủ các bước; nhật ký toàn vẹn
    const actions = rec.history.map((h) => h.action);
    for (const a of ['RECORD_CREATE', 'RECORD_SUBMIT', 'RECORD_ARCHIVE_APPROVE', 'RECORD_MARK_ENDED', 'RECORD_EXPIRE', 'RECORD_MARK_ELIGIBLE', 'RECORD_DISPOSAL_SUBMIT', 'RECORD_DISPOSE']) {
      expect(actions).toContain(a);
    }
    const v = (await gd.api.post('/api/audit/verify', {})).body;
    expect(v.result).toBe('INTACT');
  });
});
