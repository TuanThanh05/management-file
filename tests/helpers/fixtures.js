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
