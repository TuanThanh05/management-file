import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { pool, closeDb } from '../src/config/database.js';
import { todayVN } from '../src/core/time.js';
import { addYears } from '../src/modules/records/retention.js';
import { ROLE, createUser, createDepartment, login, sessionWithRoles, lastAudit } from './helpers/fixtures.js';
import { createUsableType } from './helpers/catalog.js';

const app = createApp();
const pdf = readFileSync(path.join('tests/fixtures', 'sample.pdf'));

// Gọi API bằng cookie cho trước
const as = (cookie) => ({
  get: (url) => request(app).get(url).set('Cookie', cookie),
  post: (url, body) => request(app).post(url).set('Cookie', cookie).send(body),
  patch: (url, body) => request(app).patch(url).set('Cookie', cookie).send(body),
  upload: (url) => request(app).post(url).set('Cookie', cookie).attach('file', pdf, 'chung-tu.pdf'),
});

// Đăng nhập người dùng mới với vai trò và phòng ban cho trước
async function userIn(departmentId, roles) {
  const user = await createUser({ roles, departmentId });
  const { cookie } = await login(app, user.email, user.password);
  return { user, api: as(cookie) };
}

// Tạo hồ sơ (kèm 1 file nếu cần) bằng API của người dùng
async function newRecord(api, type, { withFile = true, ...extra } = {}) {
  const r = await api.post('/api/records', { title: 'Hợp đồng mua bán số 07', documentTypeCode: type, documentDate: '2026-06-15', ...extra });
  expect(r.status).toBe(201);
  if (withFile) expect((await api.upload(`/api/records/${r.body.code}/files`)).status).toBe(201);
  return r.body.code;
}

// Số thông báo người nhận có về một đối tượng
async function notesFor(userId, code, type) {
  const [[row]] = await pool.query('SELECT COUNT(*) AS n FROM notifications WHERE recipient_id = ? AND object_code = ? AND type = ?', [userId, code, type]);
  return Number(row.n);
}

let fiscal;
let byEvent;
let dept;
let emp;
let emp2;
let head;
let officer;

beforeAll(async () => {
  fiscal = await createUsableType(app);
  byEvent = await createUsableType(app, { retentionYears: 5, startTrigger: 'EVENT_END', eventName: 'Thanh lý hợp đồng' });
  dept = await createDepartment();
  emp = await userIn(dept.id, [ROLE.EMPLOYEE]);
  emp2 = await userIn(dept.id, [ROLE.EMPLOYEE]);
  head = await userIn(dept.id, [ROLE.DEPARTMENT_HEAD]);
  const o = await sessionWithRoles(app, [ROLE.RECORDS_OFFICER]);
  officer = { user: o.user, api: as(o.cookie) };
});
afterAll(() => closeDb());

describe('Gửi / rút yêu cầu lưu trữ (5.1 CN8, CN9)', () => {
  it('chưa có file → 422; người khác cùng phòng gửi → 403', async () => {
    const code = await newRecord(emp.api, fiscal.type, { withFile: false });
    const r = await emp.api.post(`/api/records/${code}/submit`);
    expect(r.status).toBe(422);
    expect(r.body.error.details[0].field).toBe('files');
    await emp.api.upload(`/api/records/${code}/files`).expect(201);
    expect((await emp2.api.post(`/api/records/${code}/submit`)).status).toBe(403);
  });

  it('gửi → Chờ duyệt, khóa sửa, báo Trưởng phòng; rút → Đang sử dụng', async () => {
    const code = await newRecord(emp.api, fiscal.type);
    const r = await emp.api.post(`/api/records/${code}/submit`);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('PENDING_ARCHIVE');
    expect(await notesFor(head.user.id, code, 'ACTION_REQUIRED')).toBe(1);
    expect((await emp.api.patch(`/api/records/${code}`, { title: 'Sửa sau khi gửi' })).status).toBe(409);
    expect((await emp.api.post(`/api/records/${code}/submit`)).status).toBe(409);
    expect((await lastAudit('RECORD_SUBMIT', code)).details.approver).toBe('DEPARTMENT_HEAD');

    const w = await emp.api.post(`/api/records/${code}/withdraw`);
    expect(w.body.status).toBe('IN_USE');
    expect(await notesFor(head.user.id, code, 'WITHDRAWN')).toBe(1);
    expect((await emp.api.post(`/api/records/${code}/withdraw`)).status).toBe(409);
  });

  it('loại tài liệu bị ngưng → 409, báo Cán bộ lưu trữ, ghi nhật ký thất bại', async () => {
    const t = await createUsableType(app);
    const code = await newRecord(emp.api, t.type);
    await officer.api.post(`/api/catalog/document-types/${t.type}/deactivate`).expect(200);
    const r = await emp.api.post(`/api/records/${code}/submit`);
    expect(r.status).toBe(409);
    expect(await notesFor(officer.user.id, t.type, 'ACTION_REQUIRED')).toBe(1);
    expect((await lastAudit('RECORD_SUBMIT', code)).result).toBe('FAILURE');
  });

  it('phòng chưa có Trưởng phòng: vẫn gửi được, báo Quản trị hệ thống', async () => {
    const lonely = await createDepartment();
    const solo = await userIn(lonely.id, [ROLE.EMPLOYEE]);
    const admin = await createUser({ roles: [ROLE.SYSTEM_ADMIN] });
    const code = await newRecord(solo.api, fiscal.type);
    expect((await solo.api.post(`/api/records/${code}/submit`)).status).toBe(200);
    expect(await notesFor(admin.id, code, 'ACTION_REQUIRED')).toBe(1);
  });
});

describe('Duyệt / từ chối lưu trữ (5.2 CN4–7, 5.3 CN3)', () => {
  it('hồ sơ Nhân viên: Cán bộ lưu trữ không duyệt được; Trưởng phòng thấy trong hàng chờ', async () => {
    const code = await newRecord(emp.api, fiscal.type);
    await emp.api.post(`/api/records/${code}/submit`).expect(200);
    expect((await officer.api.post(`/api/records/${code}/approve`)).body.error.code).toBe('NOT_APPROVER');
    const q = await head.api.get('/api/records/approvals');
    const item = q.body.items.find((i) => i.code === code);
    expect(item.waitingDays).toBe(0);
    expect(item.title).toBe('Hợp đồng mua bán số 07');
    expect((await officer.api.get('/api/records/approvals')).body.items.some((i) => i.code === code)).toBe(false);
    expect((await emp.api.get('/api/records/approvals')).status).toBe(403);
  });

  it('từ chối: lý do ngắn → 422; hợp lệ → Đang sử dụng kèm lý do, báo người tạo', async () => {
    const code = await newRecord(emp.api, fiscal.type);
    await emp.api.post(`/api/records/${code}/submit`).expect(200);
    expect((await head.api.post(`/api/records/${code}/reject`, { reason: 'Thiếu' })).status).toBe(422);
    const r = await head.api.post(`/api/records/${code}/reject`, { reason: 'Thiếu phụ lục hợp đồng số 2' });
    expect(r.body.status).toBe('IN_USE');
    expect(r.body.lastRejectionReason).toBe('Thiếu phụ lục hợp đồng số 2');
    expect(await notesFor(emp.user.id, code, 'REVIEW_RESULT')).toBe(1);
  });

  it('Trưởng phòng duyệt: gắn nhãn, tính hạn chính thức 31/12/2036, nhật ký không chứa tiêu đề', async () => {
    const code = await newRecord(emp.api, fiscal.type);
    await emp.api.post(`/api/records/${code}/submit`).expect(200);
    const r = await head.api.post(`/api/records/${code}/approve`);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('ARCHIVED');
    expect(r.body.label.applied).toBe(true);
    expect(r.body.expiry).toMatchObject({ kind: 'DATE', startDate: '2026-12-31', expiryDate: '2036-12-31', official: true });
    const log = await lastAudit('RECORD_ARCHIVE_APPROVE', code);
    expect(JSON.stringify(log.details)).not.toContain('Hợp đồng mua bán');
    expect(log.details.expiryDate).toBe('2036-12-31');
    expect((await head.api.post(`/api/records/${code}/approve`)).status).toBe(409);
  });

  it('hồ sơ do Trưởng phòng tạo: tự duyệt → 403; Cán bộ lưu trữ duyệt được', async () => {
    const code = await newRecord(head.api, fiscal.type);
    await head.api.post(`/api/records/${code}/submit`).expect(200);
    expect(await notesFor(officer.user.id, code, 'ACTION_REQUIRED')).toBe(1);
    expect((await head.api.post(`/api/records/${code}/approve`)).body.error.code).toBe('SEPARATION_OF_DUTIES');
    expect((await head.api.get('/api/records/approvals')).body.items.some((i) => i.code === code)).toBe(false);
    expect((await officer.api.get('/api/records/approvals')).body.items.some((i) => i.code === code)).toBe(true);
    expect((await officer.api.post(`/api/records/${code}/approve`)).body.status).toBe('ARCHIVED');
  });
});

describe('Đánh dấu hết hiệu lực (5.2 CN8, BM11)', () => {
  // Hồ sơ đã được Trưởng phòng duyệt lưu trữ
  async function archived(type) {
    const code = await newRecord(emp.api, type);
    await emp.api.post(`/api/records/${code}/submit`).expect(200);
    await head.api.post(`/api/records/${code}/approve`).expect(200);
    return code;
  }

  it('nhãn theo sự kiện: chưa xác định hạn → bắt buộc ngày → tính hạn; chỉ một lần', async () => {
    const code = await archived(byEvent.type);
    expect((await head.api.get(`/api/records/${code}`)).body.expiry.kind).toBe('UNDETERMINED');
    expect((await emp.api.post(`/api/records/${code}/mark-ended`, {})).status).toBe(403);
    expect((await head.api.post(`/api/records/${code}/mark-ended`, {})).status).toBe(422);
    expect((await head.api.post(`/api/records/${code}/mark-ended`, { eventEndDate: '2026-01-01' })).status).toBe(422);
    const end = todayVN();
    const r = await head.api.post(`/api/records/${code}/mark-ended`, { eventEndDate: end });
    expect(r.status).toBe(200);
    expect(r.body.validity).toBe('ENDED');
    expect(r.body.expiry).toMatchObject({ kind: 'DATE', startDate: end, expiryDate: addYears(end, 5) });
    expect((await head.api.post(`/api/records/${code}/mark-ended`, { eventEndDate: end })).status).toBe(409);
  });

  it('nhãn không theo sự kiện: chỉ đổi hiệu lực, giữ ngày hết hạn', async () => {
    const code = await archived(fiscal.type);
    const r = await head.api.post(`/api/records/${code}/mark-ended`, { eventNote: 'Đã quyết toán xong' });
    expect(r.body.validity).toBe('ENDED');
    expect(r.body.expiry.expiryDate).toBe('2036-12-31');
  });

  it('hồ sơ chưa lưu trữ → 409', async () => {
    const code = await newRecord(emp.api, fiscal.type);
    expect((await head.api.post(`/api/records/${code}/mark-ended`, {})).status).toBe(409);
  });
});

describe('Tra cứu hồ sơ (5.1 CN11, BM07)', () => {
  let other;
  let marker;
  beforeAll(async () => {
    other = await userIn((await createDepartment()).id, [ROLE.EMPLOYEE]);
    marker = `Mã-${Date.now()}`;
    await newRecord(emp.api, fiscal.type, { withFile: false, title: `Biên bản 100%_${marker}` });
    await newRecord(emp.api, fiscal.type, { withFile: false, title: `Biên bản 100x${marker}` });
  });

  it('LIKE thoát ký tự đặc biệt; chỉ thấy hồ sơ trong phạm vi', async () => {
    const r = await emp.api.get('/api/records').query({ q: `100%_${marker}` });
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(1);
    expect(r.body.items[0].department).toBe(dept.code);
    expect((await emp.api.get('/api/records').query({ q: marker })).body.total).toBe(2);
    expect((await other.api.get('/api/records').query({ q: marker })).body.total).toBe(0);
    expect((await officer.api.get('/api/records').query({ q: marker })).body.total).toBe(2);
  });

  it('lọc trạng thái, của tôi, nhóm; sắp xếp; khoảng ngày sai → 422', async () => {
    const pending = await emp.api.get('/api/records').query({ status: 'IN_USE,ARCHIVED', mine: 'true', groupCode: fiscal.group, sortBy: 'code', sortDir: 'asc' });
    expect(pending.status).toBe(200);
    expect(pending.body.pageSize).toBe(20);
    expect(pending.body.items.every((i) => ['IN_USE', 'ARCHIVED'].includes(i.status))).toBe(true);
    const codes = pending.body.items.map((i) => i.code);
    expect([...codes].sort()).toEqual(codes);
    expect((await head.api.get('/api/records').query({ mine: 'true', q: marker })).body.total).toBe(0);
    expect((await emp.api.get('/api/records').query({ expiryDateFrom: '2037-01-01', expiryDateTo: '2036-01-01' })).status).toBe(422);
    expect((await emp.api.get('/api/records').query({ status: 'XYZ' })).status).toBe(422);
    const arch = await emp.api.get('/api/records').query({ status: 'ARCHIVED', expiryDateFrom: '2036-12-31', expiryDateTo: '2036-12-31' });
    expect(arch.body.items.every((i) => i.expiry.expiryDate === '2036-12-31')).toBe(true);
  });
});
