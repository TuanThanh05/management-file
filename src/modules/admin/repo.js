import { pool } from '../../config/database.js';

// ---------- Phòng ban ----------

// Danh sách phòng ban kèm phòng cha, Trưởng phòng đang hoạt động, số tài khoản hoạt động
export async function listDepartments() {
  const [rows] = await pool.query(
    `SELECT d.code, d.name, d.status, p.code AS parent_code, d.created_at,
            (SELECT JSON_OBJECT('id', u.id, 'fullName', u.full_name, 'email', u.email)
             FROM user_roles ur JOIN users u ON u.id = ur.user_id
             WHERE ur.role_id = 2 AND ur.revoked_at IS NULL AND u.status = 'ACTIVE' AND u.department_id = d.id LIMIT 1) AS head,
            (SELECT COUNT(*) FROM users u WHERE u.department_id = d.id AND u.status = 'ACTIVE') AS active_users
     FROM departments d LEFT JOIN departments p ON p.id = d.parent_id
     ORDER BY d.code`);
  return rows;
}

// Lấy phòng ban theo mã (có khóa dòng nếu forUpdate)
export async function findDepartment(conn, code, { forUpdate = false } = {}) {
  const [[row]] = await conn.query(
    `SELECT d.id, d.code, d.name, d.status, d.parent_id, p.code AS parent_code
     FROM departments d LEFT JOIN departments p ON p.id = d.parent_id
     WHERE d.code = ?${forUpdate ? ' FOR UPDATE OF d' : ''}`, [code]);
  return row ?? null;
}

// Thêm phòng ban
export async function insertDepartment(conn, { code, name, parentId }) {
  const [res] = await conn.query('INSERT INTO departments (code, name, parent_id) VALUES (?, ?, ?)', [code, name, parentId]);
  return res.insertId;
}

// Sửa tên / phòng ban cha
export async function updateDepartment(conn, id, { name, parentId }) {
  await conn.query('UPDATE departments SET name = ?, parent_id = ? WHERE id = ?', [name, parentId, id]);
}

// Đổi trạng thái phòng ban
export async function setDepartmentStatus(conn, id, status) {
  await conn.query('UPDATE departments SET status = ? WHERE id = ?', [status, id]);
}

// Số tài khoản đang hoạt động thuộc phòng ban
export async function countActiveUsersInDepartment(conn, departmentId) {
  const [[row]] = await conn.query("SELECT COUNT(*) AS n FROM users WHERE department_id = ? AND status = 'ACTIVE'", [departmentId]);
  return Number(row.n);
}

// ---------- Tài khoản ----------

const USER_COLUMNS = `u.id, u.email, u.full_name, u.status, u.must_change_password, u.last_login_at, u.created_at,
  u.locked_at, d.code AS department_code, d.name AS department_name, cb.email AS created_by_email,
  (SELECT JSON_ARRAYAGG(r.code) FROM user_roles ur JOIN roles r ON r.id = ur.role_id
   WHERE ur.user_id = u.id AND ur.revoked_at IS NULL) AS roles`;

// Danh sách tài khoản có lọc và phân trang
export async function listUsers({ q, departmentCode, status, role, page, pageSize }) {
  const where = [];
  const params = [];
  if (q) { where.push('(u.full_name LIKE ? OR u.email LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  if (departmentCode) { where.push('d.code = ?'); params.push(departmentCode); }
  if (status) { where.push('u.status = ?'); params.push(status); }
  if (role) {
    where.push(`EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                WHERE ur.user_id = u.id AND ur.revoked_at IS NULL AND r.code = ?)`);
    params.push(role);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const from = 'FROM users u JOIN departments d ON d.id = u.department_id LEFT JOIN users cb ON cb.id = u.created_by';
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${from} ${whereSql}`, params);
  const [rows] = await pool.query(
    `SELECT ${USER_COLUMNS} ${from} ${whereSql} ORDER BY u.id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize]);
  return { total: Number(total), rows };
}

// Chi tiết một tài khoản
export async function getUser(conn, id) {
  const [[row]] = await conn.query(
    `SELECT ${USER_COLUMNS}, u.department_id
     FROM users u JOIN departments d ON d.id = u.department_id LEFT JOIN users cb ON cb.id = u.created_by
     WHERE u.id = ?`, [id]);
  return row ?? null;
}

// Khóa dòng tài khoản để sửa
export async function lockUserRow(conn, id) {
  const [[row]] = await conn.query('SELECT id, email, full_name, status, department_id FROM users WHERE id = ? FOR UPDATE', [id]);
  return row ?? null;
}

// Thêm tài khoản (created_by là Quản trị viên, trigger kiểm tra)
export async function insertUser(conn, { email, fullName, passwordHash, departmentId, createdBy }) {
  const [res] = await conn.query(
    `INSERT INTO users (email, full_name, password_hash, department_id, must_change_password, created_by)
     VALUES (?, ?, ?, ?, TRUE, ?)`, [email, fullName, passwordHash, departmentId, createdBy]);
  return String(res.insertId);
}

// Sửa họ tên / phòng ban
export async function updateUser(conn, id, { fullName, departmentId }) {
  await conn.query('UPDATE users SET full_name = ?, department_id = ? WHERE id = ?', [fullName, departmentId, id]);
}

// Khóa tài khoản
export async function lockUser(conn, id, lockedBy) {
  await conn.query("UPDATE users SET status = 'LOCKED', locked_by = ?, locked_at = UTC_TIMESTAMP(3) WHERE id = ?", [lockedBy, id]);
}

// Mở khóa tài khoản, đặt lại bộ đếm đăng nhập sai
export async function unlockUser(conn, id) {
  await conn.query(
    `UPDATE users SET status = 'ACTIVE', locked_by = NULL, locked_at = NULL, failed_login_count = 0, login_locked_until = NULL
     WHERE id = ?`, [id]);
}

// Đặt mật khẩu tạm và bật cờ bắt buộc đổi mật khẩu
export async function resetPassword(conn, id, passwordHash) {
  await conn.query(
    `UPDATE users SET password_hash = ?, must_change_password = TRUE, failed_login_count = 0, login_locked_until = NULL
     WHERE id = ?`, [passwordHash, id]);
}

// ---------- Vai trò ----------

// Vai trò đang hiệu lực của tài khoản (mã)
export async function getActiveRoleCodes(conn, userId) {
  const [rows] = await conn.query(
    `SELECT r.code FROM user_roles ur JOIN roles r ON r.id = ur.role_id
     WHERE ur.user_id = ? AND ur.revoked_at IS NULL ORDER BY r.id FOR UPDATE OF ur`, [userId]);
  return rows.map((r) => r.code);
}

// Gán vai trò (trigger kiểm tra quy tắc kiêm nhiệm, 1 Trưởng phòng/phòng, 1 Giám đốc)
export async function grantRole(conn, userId, roleCode, grantedBy) {
  await conn.query(
    'INSERT INTO user_roles (user_id, role_id, granted_by) SELECT ?, id, ? FROM roles WHERE code = ?', [userId, grantedBy, roleCode]);
}

// Thu hồi vai trò bằng cách ghi người và thời điểm thu hồi
export async function revokeRole(conn, userId, roleCode, revokedBy) {
  await conn.query(
    `UPDATE user_roles ur JOIN roles r ON r.id = ur.role_id
     SET ur.revoked_by = ?, ur.revoked_at = UTC_TIMESTAMP(3)
     WHERE ur.user_id = ? AND r.code = ? AND ur.revoked_at IS NULL`, [revokedBy, userId, roleCode]);
}

// Có tài khoản hoạt động khác đang giữ vai trò này (trong phòng ban nếu truyền departmentId) không
export async function otherActiveHolderExists(conn, { roleCode, excludeUserId, departmentId = null }) {
  const [[row]] = await conn.query(
    `SELECT COUNT(*) AS n FROM user_roles ur JOIN roles r ON r.id = ur.role_id JOIN users u ON u.id = ur.user_id
     WHERE r.code = ? AND ur.revoked_at IS NULL AND u.status = 'ACTIVE' AND u.id <> ?
       AND (? IS NULL OR u.department_id = ?)`, [roleCode, excludeUserId, departmentId, departmentId]);
  return Number(row.n) > 0;
}

// ---------- Tham số hệ thống ----------

// Toàn bộ tham số BM22
export async function listSettings() {
  const [rows] = await pool.query(
    `SELECT s.setting_key, s.value, s.value_type, s.min_value, s.max_value, s.description, s.updated_at, u.email AS updated_by_email
     FROM system_settings s LEFT JOIN users u ON u.id = s.updated_by ORDER BY s.setting_key`);
  return rows;
}

// Lấy một tham số và khóa dòng
export async function findSettingForUpdate(conn, key) {
  const [[row]] = await conn.query('SELECT * FROM system_settings WHERE setting_key = ? FOR UPDATE', [key]);
  return row ?? null;
}

// Lưu giá trị tham số mới
export async function updateSetting(conn, key, value, updatedBy) {
  await conn.query('UPDATE system_settings SET value = ?, updated_by = ?, updated_at = UTC_TIMESTAMP(3) WHERE setting_key = ?',
    [value, updatedBy, key]);
}
