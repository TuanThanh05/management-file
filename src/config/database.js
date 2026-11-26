import mysql from 'mysql2/promise';
import { env } from './env.js';

// Pool dùng chung: DATETIME theo UTC, cột DATE giữ chuỗi 'YYYY-MM-DD', BIGINT trả về chuỗi
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

// Mỗi kết nối mới đặt time_zone phiên về UTC
pool.on('connection', (conn) => {
  conn.query("SET time_zone = '+00:00'");
});

// Kiểm tra kết nối CSDL và đọc số thứ tự nhật ký cuối
export async function pingDb() {
  const [rows] = await pool.query('SELECT 1 AS ok, last_seq FROM audit_chain_head WHERE id = 1');
  return { ok: rows.length === 1, auditLastSeq: Number(rows[0]?.last_seq ?? 0) };
}

// Đóng pool khi dừng ứng dụng
export async function closeDb() {
  await pool.end();
}
