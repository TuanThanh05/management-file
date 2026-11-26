import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { pool, closeDb } from '../src/config/database.js';
import { ROLE, createUser, createDepartment, login, sessionWithRoles, adminSession, directorSession, lastAudit } from './helpers/fixtures.js';
import { createUsableType } from './helpers/catalog.js';

const app = createApp();
const pdf = readFileSync(path.join('tests/fixtures', 'sample.pdf'));

// Gọi API bằng cookie cho trước
const as = (cookie) => ({
  get: (url, query) => request(app).get(url).query(query ?? {}).set('Cookie', cookie),
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

// Số thông báo người nhận có về một đối tượng
async function notesFor(userId, objectCode) {
  const [[row]] = await pool.query('SELECT COUNT(*) AS n FROM notifications WHERE recipient_id = ? AND object_code = ?', [userId, objectCode]);
  return Number(row.n);
}

// Trạng thái hồ sơ trong CSDL
async function rec(code) {
  const [[r]] = await pool.query('SELECT status, is_on_hold, is_disposal_eligible FROM records WHERE code = ?', [code]);
  return { status: r.status, onHold: Boolean(Number(r.is_on_hold)), eligible: Boolean(Number(r.is_disposal_eligible)) };
}

let dept;
let emp;
let head;
let officer;
let officer2;
let director;
let admin;
let type;

// Tạo n hồ sơ Hết hạn (đã duyệt lưu trữ, đã quét hạn) và có dấu đủ điều kiện hủy
async function eligibleRecords(n) {
  const codes = [];
  for (let i = 0; i < n; i++) {
    const r = await emp.api.post('/api/records', { title: 'Chứng từ cũ', documentTypeCode: type, documentDate: '2019-03-01' });
    await emp.api.upload(`/api/records/${r.body.code}/files`).expect(201);
    await emp.api.post(`/api/records/${r.body.code}/submit`).expect(200);
    await head.api.post(`/api/records/${r.body.code}/approve`).expect(200);
    codes.push(r.body.code);
  }
  await admin.post('/api/admin/jobs/expiry-scan/run').expect(200);
  await officer.api.post('/api/retention/eligibility', { recordCodes: codes, eligible: true }).expect(200);
  return codes;
}

// Lập đợt bằng Cán bộ lưu trữ officer
async function newBatch(codes) {
  const r = await officer.api.post('/api/disposals', { departmentCode: dept.code, reason: 'Hồ sơ kế toán quá hạn lưu trữ', recordCodes: codes });
  expect(r.status).toBe(201);
  return r.body.code;
}

beforeAll(async () => {
  type = (await createUsableType(app, { retentionYears: 1, warningDays: 30 })).type;
  dept = await createDepartment();
  emp = await userIn(dept.id, [ROLE.EMPLOYEE]);
  head = await userIn(dept.id, [ROLE.DEPARTMENT_HEAD]);
  const o = await sessionWithRoles(app, [ROLE.RECORDS_OFFICER]);
  officer = { user: o.user, api: as(o.cookie) };
  const o2 = await sessionWithRoles(app, [ROLE.RECORDS_OFFICER]);
  officer2 = { user: o2.user, api: as(o2.cookie) };
  admin = as((await adminSession(app)).cookie);
  const d = await directorSession(app);
  director = { user: d.director, api: as(d.cookie) };
});
afterAll(() => closeDb());

describe('Lập, sửa, hủy bỏ đợt (5.3 CN13–14, BM05)', () => {
  it('chỉ nhận hồ sơ Hết hạn có dấu hủy của đúng phòng; báo lỗi theo từng mã', async () => {
    const [a, b] = await eligibleRecords(2);
    const fresh = (await emp.api.post('/api/records', { title: 'Mới', documentTypeCode: type, documentDate: '2026-01-01' })).body.code;
    const bad = await officer.api.post('/api/disposals', { departmentCode: dept.code, reason: 'Hồ sơ kế toán quá hạn lưu trữ', recordCodes: [a, fresh] });
    expect(bad.status).toBe(422);
    expect(bad.body.error.details).toEqual([{ field: fresh, message: 'Hồ sơ không ở trạng thái Hết hạn' }]);
    const other = await createDepartment();
    expect((await officer.api.post('/api/disposals', { departmentCode: other.code, reason: 'Hồ sơ kế toán quá hạn lưu trữ', recordCodes: [a] })).status).toBe(422);
    expect((await head.api.post('/api/disposals', { departmentCode: dept.code, reason: 'Hồ sơ kế toán quá hạn lưu trữ', recordCodes: [a] })).status).toBe(403);

    const code = await newBatch([a, b]);
    expect(code).toMatch(new RegExp(`^DH-${dept.code}-\\d{4}-\\d{3}$`));
    const again = await officer.api.post('/api/disposals', { departmentCode: dept.code, reason: 'Lập trùng hồ sơ đã trong đợt', recordCodes: [a] });
    expect(again.body.error.details[0].message).toContain(code);
    expect((await rec(a)).status).toBe('EXPIRED');
  });

  it('sửa Nháp: bớt (ghi rút kèm lý do), thêm lại; không bớt hết; chỉ người lập', async () => {
    const [a, b] = await eligibleRecords(2);
    const code = await newBatch([a, b]);
    expect((await officer2.api.patch(`/api/disposals/${code}`, { reason: 'Người khác sửa đợt này' })).status).toBe(403);
    const r1 = await officer.api.patch(`/api/disposals/${code}`, { removeRecordCodes: [b] });
    expect(r1.body.records.map((x) => x.code)).toEqual([a]);
    expect(r1.body.removed[0]).toMatchObject({ code: b, itemStatus: 'WITHDRAWN', reason: 'Bỏ khỏi đợt khi lập nháp' });
    expect((await officer.api.patch(`/api/disposals/${code}`, { removeRecordCodes: [a] })).status).toBe(409);
    const r2 = await officer.api.patch(`/api/disposals/${code}`, { addRecordCodes: [b], reason: 'Lý do mới cho đợt hủy' });
    expect(r2.body.records).toHaveLength(2);
    expect(r2.body.reason).toBe('Lý do mới cho đợt hủy');
  });

  it('hủy bỏ đợt: trạng thái cuối, hồ sơ giữ Hết hạn và dấu hủy, đưa được vào đợt khác', async () => {
    const [a] = await eligibleRecords(1);
    const code = await newBatch([a]);
    expect((await officer.api.post(`/api/disposals/${code}/cancel`, { reason: 'ngắn' })).status).toBe(422);
    const r = await officer.api.post(`/api/disposals/${code}/cancel`, { reason: 'Lập nhầm phòng ban, làm lại' });
    expect(r.body.status).toBe('CANCELLED');
    expect(await rec(a)).toMatchObject({ status: 'EXPIRED', eligible: true });
    expect((await officer.api.post(`/api/disposals/${code}/submit`)).status).toBe(409);
    await newBatch([a]);
  });
});

describe('Gửi và duyệt cấp 1 (5.3 CN15, 5.2 CN12–15)', () => {
  let code;
  let recs;

  it('gửi: hồ sơ sang Chờ duyệt hủy, khóa danh mục, báo Trưởng phòng, có trong hàng chờ', async () => {
    recs = await eligibleRecords(3);
    code = await newBatch(recs);
    const r = await officer.api.post(`/api/disposals/${code}/submit`);
    expect(r.body.status).toBe('PENDING_LEVEL_1');
    expect((await rec(recs[0])).status).toBe('PENDING_DISPOSAL');
    expect(await notesFor(head.user.id, code)).toBe(1);
    expect((await officer.api.patch(`/api/disposals/${code}`, { reason: 'Sửa sau khi gửi duyệt' })).status).toBe(409);
    const q = await head.api.get('/api/records/approvals');
    expect(q.body.disposals.find((d) => d.code === code)).toMatchObject({ recordCount: 3, waitingDays: 0 });
    expect((await emp.api.post('/api/extensions', { recordCode: recs[0], newExpiryDate: '2027-12-31', reason: 'Đang trong đợt hủy' })).status).toBe(409);
  });

  it('đề nghị loại, bỏ đề nghị; loại hết thì không đồng ý được', async () => {
    expect((await emp.api.post(`/api/disposals/${code}/exclusions`, { recordCode: recs[0], reason: 'Còn cần cho kiểm toán' })).status).toBe(403);
    for (const c of recs) await head.api.post(`/api/disposals/${code}/exclusions`, { recordCode: c, reason: 'Còn cần cho kiểm toán' }).expect(200);
    expect((await head.api.post(`/api/disposals/${code}/approve-level-1`, {})).status).toBe(409);
    await head.api.post(`/api/disposals/${code}/exclusions/remove`, { recordCode: recs[1] }).expect(200);
    const r = await head.api.post(`/api/disposals/${code}/exclusions/remove`, { recordCode: recs[2] });
    expect(r.body.records.filter((x) => x.exclusionRequested).map((x) => x.code)).toEqual([recs[0]]);
  });

  it('đồng ý cấp 1: hồ sơ bị loại về Hết hạn, mất dấu hủy; đợt sang Chờ cấp 2; báo Giám đốc', async () => {
    const r = await head.api.post(`/api/disposals/${code}/approve-level-1`, { comment: 'Đồng ý, loại 1 hồ sơ' });
    expect(r.body.status).toBe('PENDING_LEVEL_2');
    expect(r.body.records).toHaveLength(2);
    expect(r.body.removed[0]).toMatchObject({ code: recs[0], itemStatus: 'EXCLUDED', reason: 'Còn cần cho kiểm toán' });
    expect(await rec(recs[0])).toMatchObject({ status: 'EXPIRED', eligible: false });
    expect(r.body.level1).toMatchObject({ approver: head.user.email, comment: 'Đồng ý, loại 1 hồ sơ' });
    expect(await notesFor(director.user.id, code)).toBeGreaterThanOrEqual(1);
    const exp = await officer.api.get('/api/retention/expired', { departmentCode: dept.code });
    expect(exp.body.items.find((i) => i.code === recs[0]).lastExclusionReason).toBe('Còn cần cho kiểm toán');
  });

  it('trả lại cấp 1: về Nháp, hồ sơ về Hết hạn, báo người lập; gửi lại được', async () => {
    const list = await eligibleRecords(2);
    const c = await newBatch(list);
    await officer.api.post(`/api/disposals/${c}/submit`).expect(200);
    await head.api.post(`/api/disposals/${c}/exclusions`, { recordCode: list[0], reason: 'Còn cần cho kiểm toán' }).expect(200);
    const r = await head.api.post(`/api/disposals/${c}/return-level-1`, { reason: 'Thiếu căn cứ đề nghị hủy' });
    expect(r.body).toMatchObject({ status: 'DRAFT', lastReturnReason: 'Thiếu căn cứ đề nghị hủy' });
    expect(r.body.records.every((x) => !x.exclusionRequested)).toBe(true);
    expect((await rec(list[0])).status).toBe('EXPIRED');
    expect(await notesFor(officer.user.id, c)).toBeGreaterThanOrEqual(1);
    expect((await officer.api.post(`/api/disposals/${c}/submit`)).body.status).toBe('PENDING_LEVEL_1');
  });
});

describe('Cấp 2, trả lại, thu hồi (5.4 CN7–10, BM17)', () => {
  // Đợt đã qua cấp 1
  async function atLevel2(n = 1) {
    const list = await eligibleRecords(n);
    const c = await newBatch(list);
    await officer.api.post(`/api/disposals/${c}/submit`).expect(200);
    await head.api.post(`/api/disposals/${c}/approve-level-1`, {}).expect(200);
    return { c, list };
  }

  it('phê duyệt: thời điểm hủy = lúc duyệt + DISPOSAL_WAIT_DAYS; chỉ Giám đốc', async () => {
    const { c } = await atLevel2();
    expect((await head.api.post(`/api/disposals/${c}/approve-level-2`, {})).status).toBe(403);
    const r = await director.api.post(`/api/disposals/${c}/approve-level-2`, { comment: 'Đồng ý hủy' });
    expect(r.body.status).toBe('APPROVED');
    const [[b]] = await pool.query('SELECT TIMESTAMPDIFF(HOUR, level2_approved_at, scheduled_at) AS h FROM disposal_batches WHERE code = ?', [c]);
    const [[{ value }]] = await pool.query("SELECT value FROM system_settings WHERE setting_key = 'DISPOSAL_WAIT_DAYS'");
    expect(Number(b.h)).toBe(Number(value) * 24);
    expect(await notesFor(head.user.id, c)).toBeGreaterThanOrEqual(1);
    expect((await director.api.post(`/api/disposals/${c}/approve-level-2`, {})).status).toBe(409);
  });

  it('thu hồi: phải xác nhận; về Nháp, xóa kết quả duyệt, hồ sơ về Hết hạn; gửi lại phải duyệt từ cấp 1', async () => {
    const { c, list } = await atLevel2();
    await director.api.post(`/api/disposals/${c}/approve-level-2`, {}).expect(200);
    expect((await director.api.post(`/api/disposals/${c}/revoke`, { reason: 'Có yêu cầu thanh tra mới' })).status).toBe(422);
    const r = await director.api.post(`/api/disposals/${c}/revoke`, { reason: 'Có yêu cầu thanh tra mới', confirm: true });
    expect(r.body).toMatchObject({ status: 'DRAFT', level1: null, level2: null, scheduledAt: null });
    expect((await rec(list[0])).status).toBe('EXPIRED');
    expect((await lastAudit('DISPOSAL_BATCH_REVOKE', c)).details.reason).toBe('Có yêu cầu thanh tra mới');
    await officer.api.post(`/api/disposals/${c}/submit`).expect(200);
    expect((await director.api.post(`/api/disposals/${c}/approve-level-2`, {})).status).toBe(409);
  });

  it('trả lại cấp 2: về Nháp kèm lý do, báo Cán bộ lưu trữ và Trưởng phòng', async () => {
    const { c } = await atLevel2();
    expect((await director.api.post(`/api/disposals/${c}/return-level-2`, { reason: 'ngắn' })).status).toBe(422);
    const r = await director.api.post(`/api/disposals/${c}/return-level-2`, { reason: 'Danh mục chưa đủ căn cứ pháp lý' });
    expect(r.body).toMatchObject({ status: 'DRAFT', lastReturnReason: 'Danh mục chưa đủ căn cứ pháp lý' });
    expect(r.body.history.map((h) => h.action)).toContain('DISPOSAL_BATCH_RETURN_L2');
  });
});

describe('Phong tỏa rút hồ sơ khỏi đợt (5.4 CN11)', () => {
  it('đợt còn hồ sơ khác: rút hồ sơ bị phong tỏa, đợt giữ trạng thái', async () => {
    const list = await eligibleRecords(2);
    const c = await newBatch(list);
    await officer.api.post(`/api/disposals/${c}/submit`).expect(200);
    const h = await director.api.post('/api/holds', { recordCodes: [list[0]], reason: 'Thanh tra thuế năm 2026', legalBasis: 'QĐ 12/QĐ-TTr' });
    expect(h.status).toBe(201);
    const d = (await officer.api.get(`/api/disposals/${c}`)).body;
    expect(d.status).toBe('PENDING_LEVEL_1');
    expect(d.removed[0]).toMatchObject({ code: list[0], itemStatus: 'WITHDRAWN', reason: `Rút do phong tỏa theo lệnh ${h.body.code}` });
    expect(await rec(list[0])).toMatchObject({ status: 'EXPIRED', onHold: true, eligible: false });
  });

  it('đợt đã phê duyệt hết hồ sơ: tự về Nháp, báo người lập', async () => {
    const list = await eligibleRecords(1);
    const c = await newBatch(list);
    await officer.api.post(`/api/disposals/${c}/submit`).expect(200);
    await head.api.post(`/api/disposals/${c}/approve-level-1`, {}).expect(200);
    await director.api.post(`/api/disposals/${c}/approve-level-2`, {}).expect(200);
    await director.api.post('/api/holds', { recordCodes: list, reason: 'Tranh chấp hợp đồng mua bán', legalBasis: 'TB 05/TB-TA' }).expect(201);
    const d = (await officer.api.get(`/api/disposals/${c}`)).body;
    expect(d).toMatchObject({ status: 'DRAFT', lastReturnReason: 'Mọi hồ sơ trong đợt bị rút do phong tỏa', recordCount: 0, level2: null });
    expect((await lastAudit('DISPOSAL_BATCH_WITHDRAW', c)).details.backToDraft).toBe(true);
  });
});

describe('Theo dõi đợt hủy (5.3 CN16)', () => {
  it('Trưởng phòng chỉ thấy phòng mình; Cán bộ lưu trữ thấy tất cả; Nhân viên không xem được', async () => {
    const mine = await head.api.get('/api/disposals', { departmentCode: dept.code });
    expect(mine.body.total).toBeGreaterThan(0);
    const otherHead = await userIn((await createDepartment()).id, [ROLE.DEPARTMENT_HEAD]);
    expect((await otherHead.api.get('/api/disposals', { departmentCode: dept.code })).body.total).toBe(0);
    const code = mine.body.items[0].code;
    expect((await otherHead.api.get(`/api/disposals/${code}`)).status).toBe(404);
    expect((await officer2.api.get('/api/disposals', { departmentCode: dept.code })).body.total).toBe(mine.body.total);
    expect((await emp.api.get('/api/disposals')).status).toBe(403);
  });
});
