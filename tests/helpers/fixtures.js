import bcrypt from 'bcrypt';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { pool } from '../../src/config/database.js';

export const ROLE = { EMPLOYEE: 1, DEPARTMENT_HEAD: 2, RECORDS_OFFICER: 3, DIRECTOR: 4, SYSTEM_ADMIN: 5 };

// Chuỗi ngẫu nhiên in hoa dùng làm mã phòng ban/email test
export const rand = (n = 7) => randomBytes(8).toString('hex').toUpperCase().slice(0, n);

// Id quản trị viên do init-admin tạo (người tạo tài khoản test)
export async function getAdminId() {
  const [[row]] = await pool.query('SELECT user_id FROM user_roles WHERE role_id = 5 AND revoked_at IS NULL ORDER BY id LIMIT 1');
  return row.user_id;
}

// Tạo phòng ban test
export async function createDepartment() {
  const code = 'T' + rand(7);
  const [ins] = await pool.query('INSERT INTO departments (code, name) VALUES (?, ?)', [code, `Phòng test ${code}`]);
  return { id: ins.insertId, code };
}

// Tạo tài khoản test kèm vai trò; mật khẩu băm cost 4 cho nhanh
export async function createUser({ roles = [ROLE.EMPLOYEE], password = 'MatKhauTest@2026', mustChange = false, departmentId } = {}) {
  const adminId = await getAdminId();
  const deptId = departmentId ?? (await createDepartment()).id;
  const email = `u${rand(10).toLowerCase()}@test.vn`;
  const [ins] = await pool.query(
    `INSERT INTO users (email, full_name, password_hash, department_id, must_change_password, created_by)
     VALUES (?, ?, ?, ?, ?, ?)`, [email, 'Người dùng test', await bcrypt.hash(password, 4), deptId, mustChange, adminId]);
  for (const r of roles) {
    await pool.query('INSERT INTO user_roles (user_id, role_id, granted_by) VALUES (?, ?, ?)', [ins.insertId, r, adminId]);
  }
  return { id: String(ins.insertId), email, password, departmentId: String(deptId) };
}

// Giám đốc đang hoạt động (doanh nghiệp chỉ có 1); chưa có thì tạo
export async function getOrCreateDirector() {
  const [[row]] = await pool.query(
    `SELECT u.id FROM user_roles ur JOIN users u ON u.id = ur.user_id
     WHERE ur.role_id = 4 AND ur.revoked_at IS NULL AND u.status = 'ACTIVE' LIMIT 1`);
  if (row) return { id: String(row.id) };
  return createUser({ roles: [ROLE.DIRECTOR] });
}

// Đăng nhập bằng Giám đốc đang hoạt động (đặt lại mật khẩu test cho Giám đốc có sẵn)
export async function directorSession(app, password = 'MatKhauTest@2026') {
  const d = await getOrCreateDirector();
  await pool.query('UPDATE users SET password_hash = ?, must_change_password = FALSE, failed_login_count = 0, login_locked_until = NULL WHERE id = ?',
    [await bcrypt.hash(password, 4), d.id]);
  const [[u]] = await pool.query('SELECT email FROM users WHERE id = ?', [d.id]);
  const { cookie } = await login(app, u.email, password);
  return { director: { id: d.id, email: u.email }, cookie };
}

// Tạo người dùng với vai trò cho trước và trả về cookie phiên
export async function sessionWithRoles(app, roles) {
  const user = await createUser({ roles });
  const { cookie } = await login(app, user.email, user.password);
  return { user, cookie };
}

// Tạo Quản trị viên test và trả về cookie phiên đã đăng nhập
export async function adminSession(app) {
  const admin = await createUser({ roles: [ROLE.SYSTEM_ADMIN] });
  const { cookie } = await login(app, admin.email, admin.password);
  return { admin, cookie };
}

// Lấy chuỗi cookie phiên từ response
export function sessionCookie(res) {
  const raw = (res.headers['set-cookie'] ?? []).find((c) => c.startsWith('rr_session='));
  return raw ? raw.split(';')[0] : null;
}

// Đăng nhập và trả về cookie phiên
export async function login(app, email, password) {
  const res = await request(app).post('/api/auth/login').send({ email, password });
  return { res, cookie: sessionCookie(res) };
}

// Dòng nhật ký mới nhất theo hành động và mã đối tượng
export async function lastAudit(action, objectCode) {
  const [[row]] = await pool.query(
    'SELECT * FROM audit_logs WHERE action = ? AND object_code = ? ORDER BY seq DESC LIMIT 1', [action, objectCode]);
  return row;
}
