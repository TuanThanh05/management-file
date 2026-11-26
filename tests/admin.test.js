import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool, closeDb } from '../src/config/database.js';
import { checkSettingValue } from '../src/modules/admin/service.js';
import { ROLE, rand, createUser, createDepartment, getOrCreateDirector, adminSession, login, lastAudit } from './helpers/fixtures.js';

const app = createApp();
let cookie;
let admin;
const api = () => ({
  get: (url) => request(app).get(url).set('Cookie', cookie),
  post: (url, body) => request(app).post(url).set('Cookie', cookie).send(body),
  patch: (url, body) => request(app).patch(url).set('Cookie', cookie).send(body),
  put: (url, body) => request(app).put(url).set('Cookie', cookie).send(body),
});
const newDeptCode = () => 'D' + rand(7);

// Tạo tài khoản qua API và đăng nhập bằng mật khẩu tạm
async function createViaApi(roles, departmentCode) {
  const email = `a${rand(10).toLowerCase()}@test.vn`;
  const r = await api().post('/api/admin/users', { email, fullName: 'Người dùng API', departmentCode, roles });
  return { r, email, id: r.body.user?.id, tempPassword: r.body.tempPassword };
}

beforeAll(async () => {
  ({ admin, cookie } = await adminSession(app));
});
afterAll(() => closeDb());

describe('Phân quyền nhóm API /api/admin', () => {
  it('Nhân viên gọi API quản trị bị 403; chưa đăng nhập bị 401', async () => {
    const emp = await createUser();
    const { cookie: empCookie } = await login(app, emp.email, emp.password);
    expect((await request(app).get('/api/admin/users').set('Cookie', empCookie)).status).toBe(403);
    expect((await request(app).get('/api/admin/users')).status).toBe(401);
  });
});

describe('Phòng ban (BM20)', () => {
  it('thêm: mã tự viết hoa, trùng mã bị 409, có ghi nhật ký', async () => {
    const code = newDeptCode();
    const r = await api().post('/api/admin/departments', { code: code.toLowerCase(), name: 'Phòng Kế toán test' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ code, status: 'ACTIVE', parentCode: null });
    expect((await lastAudit('DEPARTMENT_CREATE', code)).result).toBe('SUCCESS');
    const dup = await api().post('/api/admin/departments', { code, name: 'Trùng' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE');
  });

  it('chỉ sửa tên và phòng cha; gửi mã thì bị từ chối', async () => {
    const code = newDeptCode();
    await api().post('/api/admin/departments', { code, name: 'Tên cũ' });
    const r = await api().patch(`/api/admin/departments/${code}`, { name: 'Tên mới' });
    expect(r.status).toBe(200);
    expect(r.body.name).toBe('Tên mới');
    expect((await lastAudit('DEPARTMENT_UPDATE', code)).details).toMatchObject({ before: { name: 'Tên cũ' }, after: { name: 'Tên mới' } });
    expect((await api().patch(`/api/admin/departments/${code}`, { code: 'KHAC' })).status).toBe(422);
  });

  it('không cho tạo vòng lặp trong cây phòng ban', async () => {
    const a = newDeptCode();
    const b = newDeptCode();
    await api().post('/api/admin/departments', { code: a, name: 'Khối A' });
    await api().post('/api/admin/departments', { code: b, name: 'Phòng B', parentCode: a });
    const loop = await api().patch(`/api/admin/departments/${a}`, { parentCode: b });
    expect(loop.status).toBe(409);
    expect(loop.body.error.message).toBe('Không được tạo vòng lặp trong cây phòng ban');
    expect((await api().patch(`/api/admin/departments/${a}`, { parentCode: a })).status).toBe(409);
  });

  it('ngừng hoạt động chỉ khi không còn tài khoản hoạt động; mở lại được', async () => {
    const dept = await createDepartment();
    await createUser({ departmentId: dept.id });
    const blocked = await api().post(`/api/admin/departments/${dept.code}/deactivate`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.details.activeUsers).toBe(1);

    const empty = newDeptCode();
    await api().post('/api/admin/departments', { code: empty, name: 'Phòng trống' });
    expect((await api().post(`/api/admin/departments/${empty}/deactivate`)).body.status).toBe('INACTIVE');
    expect((await api().post(`/api/admin/departments/${empty}/deactivate`)).status).toBe(409);
    const reopen = await api().post(`/api/admin/departments/${empty}/activate`);
    expect(reopen.status).toBe(200);
    expect(reopen.body.status).toBe('ACTIVE');
    expect((await lastAudit('DEPARTMENT_ACTIVATE', empty)).result).toBe('SUCCESS');
  });

  it('danh sách có Trưởng phòng và số tài khoản hoạt động', async () => {
    const dept = await createDepartment();
    const head = await createUser({ roles: [ROLE.DEPARTMENT_HEAD], departmentId: dept.id });
    const r = await api().get('/api/admin/departments');
    const row = r.body.items.find((d) => d.code === dept.code);
    expect(row).toMatchObject({ activeUsers: 1, head: { email: head.email } });
  });
});

describe('Tài khoản (BM21 phần A)', () => {
  it('tạo đủ 5 vai trò qua API; mật khẩu tạm dùng được và bắt buộc đổi', async () => {
    const dept = await createDepartment();
    await getOrCreateDirector();
    const emp = await createViaApi(['EMPLOYEE'], dept.code);
    const head = await createViaApi(['DEPARTMENT_HEAD'], dept.code);
    const officer = await createViaApi(['RECORDS_OFFICER', 'EMPLOYEE'], dept.code);
    const sysadmin = await createViaApi(['SYSTEM_ADMIN'], dept.code);
    for (const x of [emp, head, officer, sysadmin]) {
      expect(x.r.status).toBe(201);
      expect(x.tempPassword.length).toBeGreaterThanOrEqual(16);
      expect(x.r.headers['cache-control']).toBe('no-store');
    }
    expect(officer.r.body.user.roles).toEqual(['EMPLOYEE', 'RECORDS_OFFICER']);
    const { res } = await login(app, emp.email, emp.tempPassword);
    expect(res.status).toBe(200);
    expect(res.body.mustChangePassword).toBe(true);
    expect((await lastAudit('USER_CREATE', emp.email)).details).toMatchObject({ department: dept.code, roles: ['EMPLOYEE'] });
  });

  it('tạo tài khoản: thiếu vai trò, email trùng, phòng ban ngừng hoạt động đều bị từ chối', async () => {
    const dept = await createDepartment();
    const noRole = await api().post('/api/admin/users', { email: `n${rand()}@test.vn`.toLowerCase(), fullName: 'X', departmentCode: dept.code, roles: [] });
    expect(noRole.status).toBe(422);
    const first = await createViaApi(['EMPLOYEE'], dept.code);
    const dup = await api().post('/api/admin/users', { email: first.email, fullName: 'Y', departmentCode: dept.code, roles: ['EMPLOYEE'] });
    expect(dup.status).toBe(409);
    const closed = newDeptCode();
    await api().post('/api/admin/departments', { code: closed, name: 'Đã đóng' });
    await api().post(`/api/admin/departments/${closed}/deactivate`);
    expect((await createViaApi(['EMPLOYEE'], closed)).r.status).toBe(422);
  });

  it('sửa họ tên, chuyển phòng; không sửa được email', async () => {
    const d1 = await createDepartment();
    const d2 = await createDepartment();
    const u = await createViaApi(['EMPLOYEE'], d1.code);
    const r = await api().patch(`/api/admin/users/${u.id}`, { fullName: 'Tên mới', departmentCode: d2.code });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ fullName: 'Tên mới', department: { code: d2.code } });
    expect((await api().patch(`/api/admin/users/${u.id}`, { email: 'moi@test.vn' })).status).toBe(422);
  });

  it('Trưởng phòng phải thu hồi vai trò trước khi chuyển phòng', async () => {
    const d1 = await createDepartment();
    const d2 = await createDepartment();
    const head = await createViaApi(['DEPARTMENT_HEAD'], d1.code);
    const r = await api().patch(`/api/admin/users/${head.id}`, { departmentCode: d2.code });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/thu hồi vai trò Trưởng phòng/);
  });

  it('khóa: hủy phiên đang mở, không đăng nhập được; mở khóa thì dùng lại được', async () => {
    const u = await createUser();
    const { cookie: userCookie } = await login(app, u.email, u.password);
    const r = await api().post(`/api/admin/users/${u.id}/lock`);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('LOCKED');
    expect((await request(app).get('/api/auth/me').set('Cookie', userCookie)).status).toBe(401);
    expect((await login(app, u.email, u.password)).res.status).toBe(401);
    expect((await lastAudit('USER_LOCK', u.email)).details).toMatchObject({ revokedSessions: 1 });
    expect((await api().post(`/api/admin/users/${u.id}/unlock`)).body.status).toBe('ACTIVE');
    expect((await login(app, u.email, u.password)).res.status).toBe(200);
  });

  it('không được khóa hoặc đặt lại mật khẩu cho chính mình', async () => {
    const lock = await api().post(`/api/admin/users/${admin.id}/lock`);
    expect(lock.status).toBe(403);
    expect(lock.body.error.code).toBe('SELF_ACTION_FORBIDDEN');
    expect((await api().post(`/api/admin/users/${admin.id}/reset-password`)).status).toBe(403);
  });

  it('mở khóa Trưởng phòng bị chặn nếu phòng đã có Trưởng phòng khác', async () => {
    const dept = await createDepartment();
    const oldHead = await createViaApi(['DEPARTMENT_HEAD'], dept.code);
    await api().post(`/api/admin/users/${oldHead.id}/lock`);
    const newHead = await createViaApi(['DEPARTMENT_HEAD'], dept.code);
    expect(newHead.r.status).toBe(201);
    const r = await api().post(`/api/admin/users/${oldHead.id}/unlock`);
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/đã có Trưởng phòng khác/);
  });

  it('đặt lại mật khẩu: hủy phiên, bắt buộc đổi, gửi thông báo cho người dùng', async () => {
    const u = await createUser();
    const { cookie: userCookie } = await login(app, u.email, u.password);
    const r = await api().post(`/api/admin/users/${u.id}/reset-password`);
    expect(r.status).toBe(200);
    expect(r.body.tempPassword.length).toBeGreaterThanOrEqual(16);
    expect((await request(app).get('/api/auth/me').set('Cookie', userCookie)).status).toBe(401);
    expect((await login(app, u.email, u.password)).res.status).toBe(401);
    expect((await login(app, u.email, r.body.tempPassword)).res.body.mustChangePassword).toBe(true);
    const [[n]] = await pool.query("SELECT * FROM notifications WHERE recipient_id = ? AND type = 'SECURITY_ALERT'", [u.id]);
    expect(n).toBeTruthy();
  });

  it('danh sách có lọc theo phòng ban và vai trò, có phân trang', async () => {
    const dept = await createDepartment();
    await createViaApi(['EMPLOYEE'], dept.code);
    await createViaApi(['DEPARTMENT_HEAD'], dept.code);
    const all = await api().get(`/api/admin/users?departmentCode=${dept.code}`);
    expect(all.body.total).toBe(2);
    const heads = await api().get(`/api/admin/users?departmentCode=${dept.code}&role=DEPARTMENT_HEAD&pageSize=1`);
    expect(heads.body).toMatchObject({ total: 1, page: 1, pageSize: 1 });
    expect(heads.body.items[0].roles).toEqual(['DEPARTMENT_HEAD']);
  });
});

describe('Vai trò (BM21 phần B)', () => {
  it('đổi vai trò: hủy phiên của người bị đổi, nhật ký có trước/sau, báo Giám đốc', async () => {
    const director = await getOrCreateDirector();
    const u = await createUser({ roles: [ROLE.EMPLOYEE] });
    const { cookie: userCookie } = await login(app, u.email, u.password);
    const r = await api().put(`/api/admin/users/${u.id}/roles`, { roles: ['EMPLOYEE', 'RECORDS_OFFICER'] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ changed: true, roles: ['EMPLOYEE', 'RECORDS_OFFICER'] });
    expect((await request(app).get('/api/auth/me').set('Cookie', userCookie)).status).toBe(401);
    expect((await lastAudit('USER_ROLES_CHANGE', u.email)).details).toMatchObject({ before: ['EMPLOYEE'], after: ['EMPLOYEE', 'RECORDS_OFFICER'] });
    const [[n]] = await pool.query(
      "SELECT * FROM notifications WHERE recipient_id = ? AND type = 'SYSTEM_CHANGE' AND object_code = ?", [director.id, u.email]);
    expect(n.message).toMatch(/Cán bộ lưu trữ/);
    const [[hist]] = await pool.query('SELECT COUNT(*) AS n FROM user_roles WHERE user_id = ?', [u.id]);
    expect(Number(hist.n)).toBe(2);
  });

  it('thu hồi được ghi dấu, không xóa dòng (giữ lịch sử phân quyền)', async () => {
    const u = await createUser({ roles: [ROLE.EMPLOYEE, ROLE.RECORDS_OFFICER] });
    await api().put(`/api/admin/users/${u.id}/roles`, { roles: ['EMPLOYEE'] });
    const [rows] = await pool.query('SELECT role_id, revoked_by, revoked_at FROM user_roles WHERE user_id = ? ORDER BY role_id', [u.id]);
    expect(rows).toHaveLength(2);
    expect(String(rows[1].revoked_by)).toBe(admin.id);
  });

  it('không tự đổi vai trò của mình', async () => {
    const r = await api().put(`/api/admin/users/${admin.id}/roles`, { roles: ['DIRECTOR'] });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('SELF_ACTION_FORBIDDEN');
  });

  it('Quản trị không kiêm Giám đốc / Trưởng phòng / Cán bộ lưu trữ', async () => {
    const u = await createUser({ roles: [ROLE.SYSTEM_ADMIN] });
    const r = await api().put(`/api/admin/users/${u.id}/roles`, { roles: ['SYSTEM_ADMIN', 'RECORDS_OFFICER'] });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toBe('Quản trị hệ thống không được kiêm Trưởng phòng, Cán bộ lưu trữ hoặc Giám đốc');
  });

  it('mỗi phòng 1 Trưởng phòng, cả doanh nghiệp 1 Giám đốc', async () => {
    const dept = await createDepartment();
    await createUser({ roles: [ROLE.DEPARTMENT_HEAD], departmentId: dept.id });
    const second = await createUser({ departmentId: dept.id });
    const r = await api().put(`/api/admin/users/${second.id}/roles`, { roles: ['DEPARTMENT_HEAD'] });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toBe('Phòng ban đã có Trưởng phòng đang hoạt động');

    await getOrCreateDirector();
    const other = await createUser();
    const d = await api().put(`/api/admin/users/${other.id}/roles`, { roles: ['DIRECTOR'] });
    expect(d.status).toBe(409);
    expect(d.body.error.message).toBe('Doanh nghiệp đã có Giám đốc đang hoạt động');
    expect((await api().get(`/api/admin/users/${other.id}`)).body.roles).toEqual(['EMPLOYEE']);
  });

  it('không thay đổi thì không ghi nhật ký, không hủy phiên', async () => {
    const u = await createUser();
    const { cookie: userCookie } = await login(app, u.email, u.password);
    const r = await api().put(`/api/admin/users/${u.id}/roles`, { roles: ['EMPLOYEE'] });
    expect(r.body.changed).toBe(false);
    expect((await request(app).get('/api/auth/me').set('Cookie', userCookie)).status).toBe(200);
  });
});

describe('Tham số hệ thống (BM22)', () => {
  let originalCompany;
  beforeAll(async () => {
    originalCompany = (await api().get('/api/admin/settings')).body.items.find((s) => s.key === 'COMPANY_NAME').value;
  });
  afterAll(async () => {
    await api().patch('/api/admin/settings/COMPANY_NAME', { value: originalCompany });
    await api().patch('/api/admin/settings/BACKUP_RETENTION_DAYS', { value: 30 });
  });

  it('liệt kê đủ 11 tham số kèm khoảng cho phép', async () => {
    const r = await api().get('/api/admin/settings');
    expect(r.body.items).toHaveLength(11);
    expect(r.body.items.find((s) => s.key === 'DISPOSAL_WAIT_DAYS')).toMatchObject({ type: 'INTEGER', min: 1, max: 30 });
  });

  it('sửa trong khoảng: ghi nhật ký giá trị cũ và mới, báo Giám đốc', async () => {
    const director = await getOrCreateDirector();
    const r = await api().patch('/api/admin/settings/BACKUP_RETENTION_DAYS', { value: 14 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ key: 'BACKUP_RETENTION_DAYS', value: 14, updatedBy: admin.email });
    expect((await lastAudit('SETTING_UPDATE', 'BACKUP_RETENTION_DAYS')).details).toMatchObject({ new: '14' });
    const [[n]] = await pool.query(
      "SELECT message FROM notifications WHERE recipient_id = ? AND object_code = 'BACKUP_RETENTION_DAYS' ORDER BY id DESC LIMIT 1", [director.id]);
    expect(n.message).toMatch(/→ 14/);
  });

  it('ngoài khoảng, sai định dạng, khóa không có đều bị từ chối', async () => {
    expect((await api().patch('/api/admin/settings/BACKUP_RETENTION_DAYS', { value: 31 })).status).toBe(422);
    expect((await api().patch('/api/admin/settings/FISCAL_YEAR_END', { value: '31/02' })).status).toBe(422);
    expect((await api().patch('/api/admin/settings/JOB_RUN_TIME', { value: '24:00' })).status).toBe(422);
    expect((await api().patch('/api/admin/settings/KHONG_CO', { value: '1' })).status).toBe(404);
  });

  it('sửa tên doanh nghiệp (chuỗi tiếng Việt)', async () => {
    const r = await api().patch('/api/admin/settings/COMPANY_NAME', { value: '  Công ty Cổ phần Thử nghiệm  ' });
    expect(r.body.value).toBe('Công ty Cổ phần Thử nghiệm');
  });

  it('checkSettingValue kiểm tra ngày tháng thật', () => {
    const dm = { value_type: 'DAY_MONTH' };
    expect(checkSettingValue(dm, '31/12')).toBeNull();
    expect(checkSettingValue(dm, '30/06')).toBeNull();
    expect(checkSettingValue(dm, '31/04')).toBeTruthy();
    expect(checkSettingValue(dm, '29/02')).toBeTruthy();
  });
});
