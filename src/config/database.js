import mysql from 'mysql2/promise';
import { env } from './env.js';

// Pool kết nối dùng chung cho toàn ứng dụng.
// - timezone 'Z': DATETIME đọc/ghi theo UTC, khớp quy ước của CSDL.
// - dateStrings ['DATE']: cột DATE (ngày theo lịch Việt Nam) giữ nguyên chuỗi 'YYYY-MM-DD',
//   tránh bị đổi múi giờ thành ngày hôm trước.
// - supportBigNumbers/bigNumberStrings: BIGINT không bị mất chính xác.
export const pool = mysql.createPool({
  host: env.DB_HOST,
  port: env.DB_PORT,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
  connectionLimit: env.DB_POOL_SIZE,
  waitForConnections: true,
  timezone: 'Z',
  dateStrings: ['DATE'],
  supportBigNumbers: true,
  bigNumberStrings: true,
  charset: 'utf8mb4',
});

// Mỗi kết nối mới đặt time_zone của phiên về UTC (phòng khi máy chủ MySQL cấu hình khác).
pool.on('connection', (conn) => {
  conn.query("SET time_zone = '+00:00'");
});

export async function pingDb() {
  const [rows] = await pool.query('SELECT 1 AS ok, last_seq FROM audit_chain_head WHERE id = 1');
  return { ok: rows.length === 1, auditLastSeq: Number(rows[0]?.last_seq ?? 0) };
}

export async function closeDb() {
  await pool.end();
}
