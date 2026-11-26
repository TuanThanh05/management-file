import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { pool, closeDb } from '../src/config/database.js';
import { todayVN } from '../src/core/time.js';
import { addYears, daysBetween } from '../src/modules/records/retention.js';
import { tick } from '../src/jobs/scheduler.js';
import { ROLE, createUser, createDepartment, login, sessionWithRoles, adminSession, directorSession, lastAudit } from './helpers/fixtures.js';
import { createUsableType } from './helpers/catalog.js';

const app = createApp();
const fixture = (name) => readFileSync(path.join('tests/fixtures', name));
const pdf = fixture('sample.pdf');

// Gọi API bằng cookie cho trước
const as = (cookie) => ({
  cookie,
  get: (url, query) => request(app).get(url).query(query ?? {}).set('Cookie', cookie),
  post: (url, body) => request(app).post(url).set('Cookie', cookie).send(body),
  upload: (url) => request(app).post(url).set('Cookie', cookie).attach('file', pdf, 'chung-tu.pdf'),
});

// Đăng nhập người dùng mới với vai trò và phòng ban cho trước
async function userIn(departmentId, roles) {
  const user = await createUser({ roles, departmentId });
  const { cookie } = await login(app, user.email, user.password);
  return { user, api: as(cookie) };
}

// Số thông báo người nhận có về một đối tượng
async function notesFor(userId, objectCode, type) {
  const [[row]] = await pool.query('SELECT COUNT(*) AS n FROM notifications WHERE recipient_id = ? AND object_code = ? AND type = ?', [userId, objectCode, type]);
  return Number(row.n);
}

// Trạng thái hiện tại của hồ sơ trong CSDL
async function recordRow(code) {
  const [[r]] = await pool.query('SELECT status, expiry_date, is_warned, is_on_hold, is_disposal_eligible FROM records WHERE code = ?', [code]);
  return { ...r, is_warned: Boolean(Number(r.is_warned)), is_on_hold: Boolean(Number(r.is_on_hold)), is_disposal_eligible: Boolean(Number(r.is_disposal_eligible)) };
}

let dept;
let emp;
let head;
let officer;
let admin;
let director;
let types;

// Tạo hồ sơ, gửi và để Trưởng phòng duyệt lưu trữ
async function archived(type, documentDate) {
  const r = await emp.api.post('/api/records', { title: 'Chứng từ kế toán', documentTypeCode: type, documentDate });
  expect(r.status).toBe(201);
  await emp.api.upload(`/api/records/${r.body.code}/files`).expect(201);
  await emp.api.post(`/api/records/${r.body.code}/submit`).expect(200);
  await head.api.post(`/api/records/${r.body.code}/approve`).expect(200);
  return r.body.code;
}

// Chạy tay job quét hạn bằng Quản trị viên
const runScan = () => admin.post('/api/admin/jobs/expiry-scan/run');

const today = todayVN();
const lastYearStart = `${Number(today.slice(0, 4)) - 1}-01-01`;
let past;
let soon;
let far;
let undetermined;

beforeAll(async () => {
  types = {
    short: await createUsableType(app, { retentionYears: 1, warningDays: 30 }),
    soon: await createUsableType(app, { retentionYears: 1, warningDays: 365 }),
    far: await createUsableType(app, { retentionYears: 10, warningDays: 1 }),
    event: await createUsableType(app, { retentionYears: 5, startTrigger: 'EVENT_END', eventName: 'Thanh lý hợp đồng', warningDays: 30 }),
  };
  dept = await createDepartment();
  emp = await userIn(dept.id, [ROLE.EMPLOYEE]);
  head = await userIn(dept.id, [ROLE.DEPARTMENT_HEAD]);
  const o = await sessionWithRoles(app, [ROLE.RECORDS_OFFICER]);
  officer = { user: o.user, api: as(o.cookie) };
  admin = as((await adminSession(app)).cookie);
  const d = await directorSession(app);
  director = { user: d.director, api: as(d.cookie) };

  past = await archived(types.short.type, '2020-01-01');
  soon = await archived(types.soon.type, lastYearStart);
  far = await archived(types.far.type, '2026-01-01');
  undetermined = await archived(types.event.type, '2026-01-01');
});
afterAll(() => closeDb());

describe('Job quét hạn (QT3.1 nhánh B)', () => {
  it('đến hạn → Hết hạn, báo người tạo; còn ≤ N ngày → cảnh báo một lần; còn xa → bỏ qua', async () => {
    expect((await recordRow(past)).expiry_date).toBe('2021-12-31');
    const r = await runScan();
    expect(r.status).toBe(200);
    expect(['SUCCESS', 'PARTIAL']).toContain(r.body.result);

    expect((await recordRow(past)).status).toBe('EXPIRED');
    expect(await notesFor(emp.user.id, past, 'EXPIRY_WARNING')).toBe(1);
    expect((await lastAudit('RECORD_EXPIRE', past)).user_id).toBeNull();

    const s = await recordRow(soon);
    if (s.expiry_date <= today) expect(s.status).toBe('EXPIRED');
    else expect(s).toMatchObject({ status: 'ARCHIVED', is_warned: true });
    expect(await recordRow(far)).toMatchObject({ status: 'ARCHIVED', is_warned: false });
    expect(await notesFor(head.user.id, dept.code, 'EXPIRY_WARNING')).toBe(1);

    await runScan().expect(200);
    const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'RECORD_EXPIRY_WARNING' AND object_code = ?", [soon]);
    expect(Number(n)).toBeLessThanOrEqual(1);
    expect(await notesFor(emp.user.id, past, 'EXPIRY_WARNING')).toBe(1);
  });

  it('lịch sử chạy ghi người bấm chạy; chỉ Quản trị viên chạy được', async () => {
    const runs = await admin.get('/api/admin/jobs/runs', { jobName: 'EXPIRY_SCAN' });
    expect(runs.body.items[0]).toMatchObject({ jobName: 'EXPIRY_SCAN', runType: 'MANUAL' });
    expect(runs.body.items[0].triggeredBy).toMatch(/@test\.vn$/);
    expect((await officer.api.post('/api/admin/jobs/expiry-scan/run')).status).toBe(403);
    expect((await admin.post('/api/admin/jobs/backup/run')).status).toBe(422);
  });

  it('bộ hẹn giờ: đã qua giờ chạy thì chạy bù, mỗi ngày một lần', async () => {
    await tick();
    await tick();
    const [[{ n }]] = await pool.query(
      `SELECT COUNT(*) AS n FROM job_runs WHERE job_name = 'EXPIRY_SCAN' AND run_type = 'SCHEDULED' AND result <> 'SKIPPED'
         AND started_at >= TIMESTAMP(?) - INTERVAL 7 HOUR`, [today]);
    expect(Number(n)).toBe(1);
  });

  it('Trưởng phòng xem cảnh báo hạn: sắp hết hạn, đã hết hạn, chưa xác định (5.2 CN9)', async () => {
    const r = await head.api.get('/api/retention/alerts');
    expect(r.status).toBe(200);
    const exp = r.body.expired.find((i) => i.code === past);
    expect(exp.overdueDays).toBe(daysBetween('2021-12-31', today));
    expect(r.body.undetermined.some((i) => i.code === undetermined)).toBe(true);
    expect(r.body.upcoming.some((i) => i.code === far)).toBe(false);
    if ((await recordRow(soon)).status === 'ARCHIVED') expect(r.body.upcoming.some((i) => i.code === soon)).toBe(true);
    expect((await emp.api.get('/api/retention/alerts')).status).toBe(403);
  });
});

describe('Gia hạn (QT3.2, BM03)', () => {
  let ext;

  it('kiểm tra ngày, lập đề xuất, chặn trùng, báo Trưởng phòng', async () => {
    expect((await emp.api.post('/api/extensions', { recordCode: past, newExpiryDate: today, reason: 'Còn cần đối chiếu thanh tra' })).status).toBe(422);
    expect((await emp.api.post('/api/extensions', { recordCode: past, newExpiryDate: `${Number(today.slice(0, 4)) + 6}-01-01`, reason: 'Còn cần đối chiếu thanh tra' })).status).toBe(422);
    expect((await emp.api.post('/api/extensions', { recordCode: far, newExpiryDate: '2040-01-01', reason: 'Còn cần đối chiếu thanh tra' })).status).toBe(409);
    expect((await head.api.post('/api/extensions', { recordCode: past, newExpiryDate: addYears(today, 1), reason: 'Còn cần đối chiếu thanh tra' })).status).toBe(403);

    const r = await emp.api.post('/api/extensions', { recordCode: past, newExpiryDate: addYears(today, 1), reason: 'Còn cần đối chiếu thanh tra' });
    expect(r.status).toBe(201);
    expect(r.body.code).toMatch(/^GH-\d{4}-\d{4}$/);
    expect(r.body).toMatchObject({ status: 'PENDING', oldExpiryDate: '2021-12-31' });
    expect(r.body.extendBy.years).toBeGreaterThanOrEqual(4);
    ext = r.body.code;
    expect(await notesFor(head.user.id, ext, 'ACTION_REQUIRED')).toBe(1);
    expect((await emp.api.post('/api/extensions', { recordCode: past, newExpiryDate: addYears(today, 2), reason: 'Lần thứ hai cho cùng hồ sơ' })).status).toBe(409);

    const q = await head.api.get('/api/records/approvals');
    expect(q.body.extensions.some((e) => e.code === ext && e.waitingDays === 0)).toBe(true);
  });

  it('đang chờ gia hạn thì không đánh dấu đủ điều kiện hủy được', async () => {
    const r = await officer.api.post('/api/retention/eligibility', { recordCodes: [past], eligible: true });
    expect(r.status).toBe(422);
    expect(r.body.error.details[0].message).toContain('gia hạn');
  });

  it('từ chối: bắt buộc lý do, hồ sơ giữ Hết hạn, báo người đề xuất và Cán bộ lưu trữ', async () => {
    expect((await head.api.post(`/api/extensions/${ext}/reject`, { comment: 'ngắn' })).status).toBe(422);
    const r = await head.api.post(`/api/extensions/${ext}/reject`, { comment: 'Hồ sơ đã đối chiếu xong, không cần giữ' });
    expect(r.body.status).toBe('REJECTED');
    expect((await recordRow(past)).status).toBe('EXPIRED');
    expect(await notesFor(emp.user.id, ext, 'REVIEW_RESULT')).toBe(1);
    expect(await notesFor(officer.user.id, ext, 'REVIEW_RESULT')).toBe(1);
    expect((await head.api.post(`/api/extensions/${ext}/approve`, {})).status).toBe(409);
  });

  it('duyệt: hồ sơ về Lưu trữ với hạn mới, xóa dấu đã cảnh báo, có trong lịch sử hồ sơ', async () => {
    const tmp = await archived(types.short.type, '2020-02-01');
    await runScan().expect(200);
    const newDate = addYears(today, 2);
    const c = (await emp.api.post('/api/extensions', { recordCode: tmp, newExpiryDate: newDate, reason: 'Còn tranh chấp với khách hàng' })).body.code;
    expect((await emp.api.post(`/api/extensions/${c}/approve`, {})).status).toBe(403);
    const r = await head.api.post(`/api/extensions/${c}/approve`, { comment: 'Đồng ý' });
    expect(r.body).toMatchObject({ status: 'APPROVED', newExpiryDate: newDate });
    expect(await recordRow(tmp)).toMatchObject({ status: 'ARCHIVED', expiry_date: newDate, is_warned: false });
    const detail = await emp.api.get(`/api/records/${tmp}`);
    expect(detail.body.history.some((h) => h.action === 'RECORD_EXTEND')).toBe(true);
    expect(await notesFor(officer.user.id, c, 'REVIEW_RESULT')).toBe(1);
  });

  it('theo dõi: Cán bộ lưu trữ thấy mọi phòng, phòng khác không thấy', async () => {
    expect((await officer.api.get('/api/extensions', { recordCode: past })).body.total).toBe(1);
    const other = await userIn((await createDepartment()).id, [ROLE.EMPLOYEE]);
    expect((await other.api.get('/api/extensions', { recordCode: past })).body.total).toBe(0);
    expect((await other.api.get(`/api/extensions/${ext}`)).status).toBe(404);
    expect((await officer.api.post('/api/extensions', { recordCode: past, newExpiryDate: addYears(today, 1), reason: 'Cán bộ lưu trữ không được lập' })).status).toBe(403);
  });
});

describe('Rà soát và đánh dấu đủ điều kiện hủy (5.3 CN10–11)', () => {
  it('danh sách hết hạn có số ngày quá hạn; đánh dấu / bỏ dấu; có hồ sơ sai thì không đổi hồ sơ nào', async () => {
    const list = await officer.api.get('/api/retention/expired', { departmentCode: dept.code });
    const item = list.body.items.find((i) => i.code === past);
    expect(item).toMatchObject({ canMark: true, isDisposalEligible: false, overdueDays: daysBetween('2021-12-31', today) });

    const bad = await officer.api.post('/api/retention/eligibility', { recordCodes: [past, far], eligible: true });
    expect(bad.status).toBe(422);
    expect((await recordRow(past)).is_disposal_eligible).toBe(false);

    const ok = await officer.api.post('/api/retention/eligibility', { recordCodes: [past], eligible: true });
    expect(ok.body.updated).toEqual([past]);
    expect((await recordRow(past)).is_disposal_eligible).toBe(true);
    expect((await lastAudit('RECORD_MARK_ELIGIBLE', past))).toBeTruthy();
    expect((await head.api.post('/api/retention/eligibility', { recordCodes: [past], eligible: false })).status).toBe(403);
  });
});

describe('Phong tỏa (QT3.3, BM04)', () => {
  let hold;

  it('chỉ Giám đốc; hồ sơ sai trạng thái → 422 không đặt hồ sơ nào', async () => {
    expect((await officer.api.post('/api/holds', { recordCodes: [past], reason: 'Thanh tra thuế năm 2026', legalBasis: 'QĐ 12/QĐ-TTr' })).status).toBe(403);
    const inUse = (await emp.api.post('/api/records', { title: 'Đang soạn', documentTypeCode: types.far.type, documentDate: '2026-01-01' })).body.code;
    const r = await director.api.post('/api/holds', { recordCodes: [past, inUse], reason: 'Thanh tra thuế năm 2026', legalBasis: 'QĐ 12/QĐ-TTr' });
    expect(r.status).toBe(422);
    expect(r.body.error.details.map((d) => d.field)).toEqual([inUse]);
    expect((await recordRow(past)).is_on_hold).toBe(false);
  });

  it('đặt phong tỏa: bật cờ, bỏ dấu đủ điều kiện hủy, báo Cán bộ lưu trữ và Trưởng phòng; hồ sơ đã bị phong tỏa → 422', async () => {
    const r = await director.api.post('/api/holds', { recordCodes: [past, far], reason: 'Thanh tra thuế năm 2026', legalBasis: 'QĐ 12/QĐ-TTr', expectedReleaseDate: today });
    expect(r.status).toBe(201);
    hold = r.body.code;
    expect(hold).toMatch(/^PT-\d{4}-\d{4}$/);
    expect(r.body).toMatchObject({ status: 'ACTIVE', activeCount: 2, overdue: false });
    expect(await recordRow(past)).toMatchObject({ is_on_hold: true, is_disposal_eligible: false, status: 'EXPIRED' });
    expect(await notesFor(officer.user.id, hold, 'SYSTEM_CHANGE')).toBe(1);
    expect(await notesFor(head.user.id, hold, 'SYSTEM_CHANGE')).toBe(1);
    expect((await director.api.post('/api/holds', { recordCodes: [far], reason: 'Lệnh thứ hai cùng hồ sơ', legalBasis: 'QĐ 13' })).status).toBe(422);
    expect((await officer.api.post('/api/retention/eligibility', { recordCodes: [past], eligible: true })).status).toBe(422);
    const detail = await emp.api.get(`/api/records/${past}`);
    expect(detail.body.isOnHold).toBe(true);
    expect(detail.body.history.some((h) => h.action === 'RECORD_HOLD')).toBe(true);
  });

  it('gỡ từng hồ sơ rồi cả lệnh; gỡ lại → 409', async () => {
    expect((await director.api.post(`/api/holds/${hold}/release`, { recordCodes: [soon], reason: 'Hồ sơ không thuộc lệnh này' })).status).toBe(422);
    const one = await director.api.post(`/api/holds/${hold}/release`, { recordCodes: [far], reason: 'Đã đối chiếu xong hồ sơ này' });
    expect(one.body).toMatchObject({ status: 'ACTIVE', activeCount: 1 });
    expect((await recordRow(far)).is_on_hold).toBe(false);
    const all = await director.api.post(`/api/holds/${hold}/release`, { reason: 'Kết thúc đợt thanh tra thuế' });
    expect(all.body).toMatchObject({ status: 'RELEASED', activeCount: 0 });
    expect((await recordRow(past)).is_on_hold).toBe(false);
    expect((await director.api.post(`/api/holds/${hold}/release`, { reason: 'Kết thúc đợt thanh tra thuế' })).status).toBe(409);
    const list = await director.api.get('/api/holds', { status: 'RELEASED' });
    expect(list.body.items.some((h) => h.code === hold)).toBe(true);
  });

  it('kèm tệp căn cứ: mã hóa, tải về đúng nội dung; tệp sai định dạng → 422', async () => {
    const { cookie } = director.api;
    const wrong = await request(app).post('/api/holds').set('Cookie', cookie)
      .field('recordCodes', far).field('reason', 'Tranh chấp hợp đồng mua bán').field('legalBasis', 'Thông báo thụ lý 05/TB-TA')
      .attach('evidence', fixture('fake.exe'), 'quyet-dinh.pdf');
    expect(wrong.status).toBe(422);
    const r = await request(app).post('/api/holds').set('Cookie', cookie)
      .field('recordCodes', `${far},${soon}`).field('reason', 'Tranh chấp hợp đồng mua bán').field('legalBasis', 'Thông báo thụ lý 05/TB-TA')
      .attach('evidence', pdf, 'quyet-dinh.pdf');
    expect(r.status).toBe(201);
    expect(r.body.evidence.sha256).toBe(createHash('sha256').update(pdf).digest('hex'));
    const file = await request(app).get(`/api/holds/${r.body.code}/evidence`).set('Cookie', cookie).buffer(true)
      .parse((res, cb) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });
    expect(file.status).toBe(200);
    expect(Buffer.compare(file.body, pdf)).toBe(0);
    await request(app).post(`/api/holds/${r.body.code}/release`).set('Cookie', cookie).send({ reason: 'Tòa án đình chỉ vụ việc' }).expect(200);
  });
});

describe('Thông báo của tôi (5.1 CN3)', () => {
  it('danh sách, số chưa đọc, đánh dấu đã đọc; không đụng được thông báo người khác', async () => {
    const list = await emp.api.get('/api/notifications', { unread: 'true' });
    expect(list.status).toBe(200);
    expect(list.body.unreadCount).toBeGreaterThan(0);
    const id = list.body.items[0].id;
    const r = await emp.api.post(`/api/notifications/${id}/read`);
    expect(r.body.unreadCount).toBe(list.body.unreadCount - 1);
    expect((await head.api.post(`/api/notifications/${id}/read`)).status).toBe(404);
    await emp.api.post('/api/notifications/read-all').expect(200);
    expect((await emp.api.get('/api/notifications/unread-count')).body.unreadCount).toBe(0);
  });
});
