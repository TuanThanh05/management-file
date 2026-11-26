// Gửi thông báo cho danh sách người nhận (nội dung chỉ ghi mã đối tượng, không ghi tiêu đề hồ sơ)
export async function notifyUsers(conn, recipientIds, { type, message, objectType = null, objectCode = null }) {
  const ids = [...new Set(recipientIds.map(String))];
  if (!ids.length) return 0;
  const rows = ids.map((id) => [id, type, message.slice(0, 500), objectType, objectCode]);
  await conn.query('INSERT INTO notifications (recipient_id, type, message, object_type, object_code) VALUES ?', [rows]);
  return ids.length;
}

// Gửi thông báo cho mọi tài khoản đang hoạt động giữ vai trò roleCode
export async function notifyRole(conn, roleCode, payload) {
  const [rows] = await conn.query(
    `SELECT ur.user_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id JOIN users u ON u.id = ur.user_id
     WHERE r.code = ? AND ur.revoked_at IS NULL AND u.status = 'ACTIVE'`, [roleCode]);
  return notifyUsers(conn, rows.map((r) => r.user_id), payload);
}

// Trưởng phòng đang hoạt động của các phòng ban: Map departmentId -> userId
export async function departmentHeads(conn, departmentIds) {
  const ids = [...new Set(departmentIds.map(String))];
  if (!ids.length) return new Map();
  const [rows] = await conn.query(
    `SELECT u.department_id, u.id FROM user_roles ur JOIN roles r ON r.id = ur.role_id JOIN users u ON u.id = ur.user_id
     WHERE r.code = 'DEPARTMENT_HEAD' AND ur.revoked_at IS NULL AND u.status = 'ACTIVE' AND u.department_id IN (?)`, [ids]);
  return new Map(rows.map((r) => [String(r.department_id), String(r.id)]));
}

// Báo Trưởng phòng của phòng ban; phòng chưa có Trưởng phòng thì báo Quản trị hệ thống kèm ghi chú
export async function notifyDepartmentHead(conn, departmentId, payload) {
  const head = (await departmentHeads(conn, [departmentId])).get(String(departmentId));
  if (head) return notifyUsers(conn, [head], payload);
  const [[d]] = await conn.query('SELECT code FROM departments WHERE id = ?', [departmentId]);
  return notifyRole(conn, 'SYSTEM_ADMIN', { ...payload, message: `Phòng ${d.code} chưa có Trưởng phòng – ${payload.message}` });
}
