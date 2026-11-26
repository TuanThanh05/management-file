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
