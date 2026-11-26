import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { createApp } from '../src/app.js';
import { pool, closeDb } from '../src/config/database.js';
import { authenticate } from '../src/middlewares/authenticate.js';
import { authorize, scopeFilter } from '../src/middlewares/authorize.js';
import { errorHandler } from '../src/core/errors.js';
import { checkNewPassword } from '../src/core/password.js';
import { ROLE, createUser, getAdminId, login, sessionCookie, lastAudit } from './helpers/fixtures.js';

const app = createApp();
const INVALID = 'Tên đăng nhập hoặc mật khẩu không đúng';

// App phụ có một API cần quyền ADMIN.USERS để kiểm tra authenticate + authorize
const guarded = express();
guarded.use(cookieParser());
guarded.get('/admin-only', authenticate(), authorize('ADMIN.USERS'), (req, res) => res.json({ scope: req.scope }));
guarded.use(errorHandler);

afterAll(() => closeDb());

describe('POST /api/auth/login', () => {
  it('đăng nhập đúng: cookie httpOnly + SameSite=Strict, ghi nhật ký LOGIN_SUCCESS', async () => {
    const u = await createUser();
    const { res, cookie } = await login(app, u.email.toUpperCase(), u.password);
    expect(res.status).toBe(200);
    expect(res.body.mustChangePassword).toBe(false);
    const raw = res.headers['set-cookie'].find((c) => c.startsWith('rr_session='));
    expect(raw).toMatch(/HttpOnly/);
    expect(raw).toMatch(/SameSite=Strict/);
    expect(cookie).toBeTruthy();
    const log = await lastAudit('LOGIN_SUCCESS', u.email);
    expect(log.result).toBe('SUCCESS');
    expect(String(log.user_id)).toBe(u.id);
  });

  it('sai mật khẩu và email không tồn tại trả cùng một câu thông báo', async () => {
    const u = await createUser();
    const wrong = await request(app).post('/api/auth/login').send({ email: u.email, password: 'sai-mat-khau' });
    const unknown = await request(app).post('/api/auth/login').send({ email: 'khongco@test.vn', password: 'x' });
    for (const r of [wrong, unknown]) {
      expect(r.status).toBe(401);
      expect(r.body.error).toMatchObject({ code: 'INVALID_CREDENTIALS', message: INVALID });
    }
    expect((await lastAudit('LOGIN_FAILED', 'khongco@test.vn')).details.reason).toBe('UNKNOWN_ACCOUNT');
    const log = await lastAudit('LOGIN_FAILED', u.email);
    expect(log.details).toMatchObject({ reason: 'WRONG_PASSWORD', failedCount: 1 });
    expect(JSON.stringify(log.details)).not.toContain('sai-mat-khau');
  });

  it('sai 5 lần liên tiếp thì tạm khóa; hết thời gian khóa thì đăng nhập lại được', async () => {
    const u = await createUser();
    for (let i = 0; i < 5; i++) {
      await request(app).post('/api/auth/login').send({ email: u.email, password: 'sai' }).expect(401);
    }
    const blocked = await request(app).post('/api/auth/login').send({ email: u.email, password: u.password });
    expect(blocked.status).toBe(401);
    expect(blocked.body.error.message).toBe(INVALID);
    expect((await lastAudit('LOGIN_FAILED', u.email)).details.reason).toBe('TEMPORARILY_LOCKED');

    const [[row]] = await pool.query(
      'SELECT TIMESTAMPDIFF(MINUTE, UTC_TIMESTAMP(3), login_locked_until) AS mins FROM users WHERE id = ?', [u.id]);
    expect(Number(row.mins)).toBeGreaterThanOrEqual(14);

    await pool.query('UPDATE users SET login_locked_until = UTC_TIMESTAMP(3) - INTERVAL 1 SECOND WHERE id = ?', [u.id]);
    const { res } = await login(app, u.email, u.password);
    expect(res.status).toBe(200);
  });

  it('tài khoản bị Quản trị viên khóa không đăng nhập được', async () => {
    const u = await createUser();
    await pool.query("UPDATE users SET status = 'LOCKED', locked_by = ?, locked_at = UTC_TIMESTAMP(3) WHERE id = ?", [await getAdminId(), u.id]);
    const r = await request(app).post('/api/auth/login').send({ email: u.email, password: u.password });
    expect(r.status).toBe(401);
    expect(r.body.error.message).toBe(INVALID);
    expect((await lastAudit('LOGIN_FAILED', u.email)).details.reason).toBe('ACCOUNT_LOCKED');
  });

  it('email sai định dạng trả 422', async () => {
    const r = await request(app).post('/api/auth/login').send({ email: 'abc', password: 'x' });
    expect(r.status).toBe(422);
    expect(r.body.error.details[0].field).toBe('email');
  });

  it('Origin lạ bị chặn (CSRF lớp 2)', async () => {
    const r = await request(app).post('/api/auth/login').set('Origin', 'https://evil.example').send({ email: 'a@b.vn', password: 'x' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('BAD_ORIGIN');
  });
});

describe('Phiên đăng nhập', () => {
  it('GET /me trả vai trò và quyền kèm phạm vi', async () => {
    const u = await createUser({ roles: [ROLE.EMPLOYEE] });
    const { cookie } = await login(app, u.email, u.password);
    const r = await request(app).get('/api/auth/me').set('Cookie', cookie);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ email: u.email, mustChangePassword: false, roles: [{ code: 'EMPLOYEE', name: 'Nhân viên' }] });
    expect(r.body.permissions).toContainEqual({ code: 'RECORD.VIEW', scope: 'DEPARTMENT' });
    expect(r.body.permissions).toContainEqual({ code: 'RECORD.UPDATE', scope: 'OWN' });
  });

  it('không có cookie hoặc cookie bị sửa thì 401', async () => {
    expect((await request(app).get('/api/auth/me')).status).toBe(401);
    const u = await createUser();
    const { cookie } = await login(app, u.email, u.password);
    expect((await request(app).get('/api/auth/me').set('Cookie', cookie.slice(0, -3) + 'abc')).status).toBe(401);
  });

  it('đăng xuất thì cookie cũ không dùng được nữa', async () => {
    const u = await createUser();
    const { cookie } = await login(app, u.email, u.password);
    expect((await request(app).post('/api/auth/logout').set('Cookie', cookie)).status).toBe(204);
    expect((await request(app).get('/api/auth/me').set('Cookie', cookie)).status).toBe(401);
    expect((await lastAudit('LOGOUT', u.email)).result).toBe('SUCCESS');
  });
});

describe('Bắt buộc đổi mật khẩu', () => {
  it('chỉ được gọi me/logout/change-password, API khác trả 403 PASSWORD_CHANGE_REQUIRED', async () => {
    const u = await createUser({ roles: [ROLE.SYSTEM_ADMIN], mustChange: true });
    const { res, cookie } = await login(app, u.email, u.password);
    expect(res.body.mustChangePassword).toBe(true);
    expect((await request(app).get('/api/auth/me').set('Cookie', cookie)).body.mustChangePassword).toBe(true);
    const blocked = await request(guarded).get('/admin-only').set('Cookie', cookie);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
  });
});

describe('POST /api/auth/change-password', () => {
  const change = (cookie, body) => request(app).post('/api/auth/change-password').set('Cookie', cookie).send(body);

  it('vi phạm quy tắc BM09 trả 422 kèm từng lỗi', async () => {
    const u = await createUser();
    const { cookie } = await login(app, u.email, u.password);
    const short = await change(cookie, { currentPassword: u.password, newPassword: 'ngan', confirmPassword: 'ngan' });
    expect(short.status).toBe(422);
    expect(short.body.error.details[0].message).toMatch(/12 đến 64/);
    const same = await change(cookie, { currentPassword: u.password, newPassword: u.password, confirmPassword: u.password });
    expect(same.body.error.details.map((d) => d.message)).toContain('Mật khẩu mới phải khác mật khẩu hiện tại');
    const local = u.email.split('@')[0];
    const withName = await change(cookie, { currentPassword: u.password, newPassword: `${local}Abc!2026`, confirmPassword: `${local}Abc!2026` });
    expect(withName.body.error.details.map((d) => d.message)).toContain('Mật khẩu mới không được chứa tên đăng nhập');
    const mismatch = await change(cookie, { currentPassword: u.password, newPassword: 'MatKhauMoi@2026x', confirmPassword: 'khac' });
    expect(mismatch.body.error.details).toContainEqual({ field: 'confirmPassword', message: 'Xác nhận mật khẩu không trùng khớp' });
  });

  it('mật khẩu hiện tại sai trả 422 và ghi nhật ký thất bại', async () => {
    const u = await createUser();
    const { cookie } = await login(app, u.email, u.password);
    const r = await change(cookie, { currentPassword: 'sai-roi', newPassword: 'MatKhauMoi@2026x', confirmPassword: 'MatKhauMoi@2026x' });
    expect(r.status).toBe(422);
    expect(r.body.error.details[0].field).toBe('currentPassword');
    const log = await lastAudit('PASSWORD_CHANGE', u.email);
    expect(log.result).toBe('FAILURE');
  });

  it('đổi thành công: hủy mọi phiên cũ, cấp phiên mới, bỏ cờ bắt buộc đổi', async () => {
    const u = await createUser({ mustChange: true });
    const first = await login(app, u.email, u.password);
    const second = await login(app, u.email, u.password);
    const newPassword = 'MatKhauMoi@2026x';
    const r = await change(first.cookie, { currentPassword: u.password, newPassword, confirmPassword: newPassword });
    expect(r.status).toBe(200);
    const fresh = sessionCookie(r);
    expect(fresh).toBeTruthy();

    expect((await request(app).get('/api/auth/me').set('Cookie', first.cookie)).status).toBe(401);
    expect((await request(app).get('/api/auth/me').set('Cookie', second.cookie)).status).toBe(401);
    const me = await request(app).get('/api/auth/me').set('Cookie', fresh);
    expect(me.status).toBe(200);
    expect(me.body.mustChangePassword).toBe(false);

    expect((await login(app, u.email, u.password)).res.status).toBe(401);
    expect((await login(app, u.email, newPassword)).res.status).toBe(200);

    const [[row]] = await pool.query('SELECT password_hash FROM users WHERE id = ?', [u.id]);
    expect(row.password_hash).toMatch(/^\$2[aby]\$12\$/);
    const log = await lastAudit('PASSWORD_CHANGE', u.email);
    expect(log.result).toBe('SUCCESS');
    expect(JSON.stringify(log.details)).not.toContain(newPassword);
  });
});

describe('authorize', () => {
  let employee;
  beforeAll(async () => {
    employee = await createUser({ roles: [ROLE.EMPLOYEE] });
  });

  it('không có quyền trả 403 và ghi nhật ký ACCESS_DENIED', async () => {
    const { cookie } = await login(app, employee.email, employee.password);
    const r = await request(guarded).get('/admin-only').set('Cookie', cookie);
    expect(r.status).toBe(403);
    const [[log]] = await pool.query(
      "SELECT * FROM audit_logs WHERE action = 'ACCESS_DENIED' AND user_id = ? ORDER BY seq DESC LIMIT 1", [employee.id]);
    expect(log).toMatchObject({ object_code: 'ADMIN.USERS', result: 'FAILURE' });
  });

  it('có quyền thì qua và nhận phạm vi ALL', async () => {
    const admin = await createUser({ roles: [ROLE.SYSTEM_ADMIN] });
    const { cookie } = await login(app, admin.email, admin.password);
    const r = await request(guarded).get('/admin-only').set('Cookie', cookie);
    expect(r.status).toBe(200);
    expect(r.body.scope).toBe('ALL');
  });

  it('scopeFilter sinh điều kiện theo phạm vi', () => {
    const user = { id: '7', departmentId: '3' };
    const cols = { departmentColumn: 'r.department_id', ownerColumn: 'r.created_by' };
    expect(scopeFilter({ scope: 'ALL', user }, cols)).toEqual({ sql: '1 = 1', params: [] });
    expect(scopeFilter({ scope: 'DEPARTMENT', user }, cols)).toEqual({ sql: 'r.department_id = ?', params: ['3'] });
    expect(scopeFilter({ scope: 'OWN', user }, cols)).toEqual({ sql: 'r.created_by = ?', params: ['7'] });
    expect(() => scopeFilter({ user }, cols)).toThrow();
  });
});

describe('checkNewPassword', () => {
  it('chấp nhận mật khẩu hợp lệ, đếm độ dài theo ký tự Unicode', () => {
    const base = { email: 'nguyenvana@congty.vn', currentPassword: 'cu' };
    expect(checkNewPassword({ ...base, newPassword: 'Mật-khẩu-mới-2026', confirmPassword: 'Mật-khẩu-mới-2026' })).toEqual([]);
    expect(checkNewPassword({ ...base, newPassword: 'x'.repeat(65), confirmPassword: 'x'.repeat(65) })).toHaveLength(1);
  });
});
