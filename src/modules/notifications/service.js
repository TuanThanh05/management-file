import { pool } from '../../config/database.js';
import { AppError } from '../../core/errors.js';

const PAGE_SIZE = 20;

// Thông báo của người dùng, mới nhất trước, kèm số chưa đọc (5.1 CN3)
export async function listNotifications(user, { unread, page }) {
  const where = `recipient_id = ?${unread ? ' AND NOT is_read' : ''}`;
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM notifications WHERE ${where}`, [user.id]);
  const [rows] = await pool.query(
    `SELECT id, type, message, object_type, object_code, is_read, created_at, read_at FROM notifications WHERE ${where}
     ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, [user.id, PAGE_SIZE, (page - 1) * PAGE_SIZE]);
  return {
    page, pageSize: PAGE_SIZE, total: Number(total), unreadCount: await unreadCount(user),
    items: rows.map((n) => ({ id: String(n.id), type: n.type, message: n.message, objectType: n.object_type, objectCode: n.object_code,
      isRead: Boolean(Number(n.is_read)), createdAt: n.created_at, readAt: n.read_at })),
  };
}

// Số thông báo chưa đọc
export async function unreadCount(user) {
  const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM notifications WHERE recipient_id = ? AND NOT is_read', [user.id]);
  return Number(n);
}

// Đánh dấu một thông báo của mình là đã đọc
export async function markRead(user, id) {
  const [res] = await pool.query(
    'UPDATE notifications SET is_read = TRUE, read_at = COALESCE(read_at, UTC_TIMESTAMP(3)) WHERE id = ? AND recipient_id = ?', [id, user.id]);
  if (!res.affectedRows) throw AppError.notFound('Không tìm thấy thông báo');
  return { unreadCount: await unreadCount(user) };
}

// Đánh dấu tất cả thông báo của mình là đã đọc
export async function markAllRead(user) {
  const [res] = await pool.query(
    'UPDATE notifications SET is_read = TRUE, read_at = UTC_TIMESTAMP(3) WHERE recipient_id = ? AND NOT is_read', [user.id]);
  return { updated: res.affectedRows, unreadCount: 0 };
}
