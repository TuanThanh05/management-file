import { pool } from '../../config/database.js';

// Chuyển giá trị 0/1 từ MySQL (có thể là số hoặc chuỗi) sang boolean
const toBool = (v) => v === true || Number(v) === 1;

// Lấy tài khoản theo email và khóa dòng để đếm số lần sai chính xác khi đăng nhập đồng thời
export async function findUserForLogin(conn, email) {
  const [[row]] = await conn.query(
    `SELECT id, email, password_hash, status, must_change_password, failed_login_count,
            (login_locked_until IS NOT NULL AND login_locked_until > UTC_TIMESTAMP(3)) AS is_temp_locked
     FROM users WHERE email = ? FOR UPDATE`, [email]);
  return row ? { ...row, is_temp_locked: toBool(row.is_temp_locked), must_change_password: toBool(row.must_change_password) } : null;
}

// Lấy mật khẩu băm của người dùng và khóa dòng (đổi mật khẩu)
export async function findPasswordHashForUpdate(conn, userId) {
  const [[row]] = await conn.query('SELECT email, password_hash FROM users WHERE id = ? FOR UPDATE', [userId]);
  return row ?? null;
}

// Danh sách mã vai trò đang hiệu lực của người dùng
export async function getRoleCodes(conn, userId) {
  const [rows] = await conn.query(
    `SELECT r.code FROM user_roles ur JOIN roles r ON r.id = ur.role_id
     WHERE ur.user_id = ? AND ur.revoked_at IS NULL ORDER BY r.id`, [userId]);
  return rows.map((r) => r.code);
}

// Tăng số lần sai; đạt ngưỡng thì tạm khóa N phút và đặt lại bộ đếm
export async function recordFailedLogin(conn, userId, { maxFailed, lockMinutes }) {
  await conn.query(
    `UPDATE users
     SET login_locked_until = IF(failed_login_count + 1 >= ?, UTC_TIMESTAMP(3) + INTERVAL ? MINUTE, login_locked_until),
         failed_login_count = IF(failed_login_count + 1 >= ?, 0, failed_login_count + 1)
     WHERE id = ?`, [maxFailed, lockMinutes, maxFailed, userId]);
  const [[row]] = await conn.query(
    `SELECT failed_login_count, (login_locked_until > UTC_TIMESTAMP(3)) AS locked FROM users WHERE id = ?`, [userId]);
  return { failedCount: Number(row.failed_login_count), lockedNow: toBool(row.locked) };
}

// Đăng nhập đúng: đặt lại bộ đếm sai và ghi thời điểm đăng nhập
export async function recordSuccessfulLogin(conn, userId) {
  await conn.query(
    `UPDATE users SET failed_login_count = 0, login_locked_until = NULL, last_login_at = UTC_TIMESTAMP(3) WHERE id = ?`, [userId]);
}

// Tạo phiên đăng nhập mới, hết hạn sau `hours` giờ
export async function createSession(conn, { id, userId, hours, ip, userAgent }) {
  await conn.query(
    `INSERT INTO login_sessions (id, user_id, created_at, expires_at, ip_address, user_agent)
     VALUES (?, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3) + INTERVAL ? HOUR, ?, ?)`,
    [id, userId, hours, ip?.slice(0, 45) ?? null, userAgent?.slice(0, 255) ?? null]);
  const [[row]] = await conn.query('SELECT expires_at FROM login_sessions WHERE id = ?', [id]);
  return { id, expiresAt: row.expires_at };
}

// Thu hồi một phiên
export async function revokeSession(conn, sessionId, reason) {
  await conn.query(
    `UPDATE login_sessions SET revoked_at = UTC_TIMESTAMP(3), revoke_reason = ? WHERE id = ? AND revoked_at IS NULL`,
    [reason, sessionId]);
}

// Thu hồi mọi phiên còn hiệu lực của người dùng; trả về số phiên bị thu hồi
export async function revokeAllSessions(conn, userId, reason) {
  const [res] = await conn.query(
    `UPDATE login_sessions SET revoked_at = UTC_TIMESTAMP(3), revoke_reason = ?
     WHERE user_id = ? AND revoked_at IS NULL AND expires_at > UTC_TIMESTAMP(3)`, [reason, userId]);
  return res.affectedRows;
}

// Lưu mật khẩu mới, bỏ cờ bắt buộc đổi mật khẩu
export async function updatePassword(conn, userId, passwordHash) {
  await conn.query(
    `UPDATE users SET password_hash = ?, must_change_password = FALSE, password_changed_at = UTC_TIMESTAMP(3),
            failed_login_count = 0, login_locked_until = NULL
     WHERE id = ?`, [passwordHash, userId]);
}

// Nạp ngữ cảnh đăng nhập: phiên còn hiệu lực + tài khoản hoạt động + vai trò + quyền
export async function loadAuthContext(userId, sessionId) {
  const [[row]] = await pool.query(
    `SELECT u.id, u.email, u.full_name, u.must_change_password, u.department_id,
            d.code AS department_code, d.name AS department_name,
            s.expires_at, (s.last_seen_at IS NULL OR s.last_seen_at < UTC_TIMESTAMP(3) - INTERVAL 1 MINUTE) AS needs_touch
     FROM login_sessions s
     JOIN users u ON u.id = s.user_id
     JOIN departments d ON d.id = u.department_id
     WHERE s.id = ? AND s.user_id = ? AND s.revoked_at IS NULL AND s.expires_at > UTC_TIMESTAMP(3) AND u.status = 'ACTIVE'`,
    [sessionId, userId]);
  if (!row) return null;
  const [roles] = await pool.query(
    `SELECT r.code, r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id
     WHERE ur.user_id = ? AND ur.revoked_at IS NULL ORDER BY r.id`, [userId]);
  const [perms] = await pool.query(
    'SELECT permission_code, scope FROM v_user_permissions WHERE user_id = ? ORDER BY permission_code', [userId]);
  return { ...row, needs_touch: toBool(row.needs_touch), must_change_password: toBool(row.must_change_password), roles, perms };
}

// Cập nhật thời điểm hoạt động cuối của phiên
export async function touchSession(sessionId) {
  await pool.query('UPDATE login_sessions SET last_seen_at = UTC_TIMESTAMP(3) WHERE id = ? AND revoked_at IS NULL', [sessionId]);
}
