import 'dotenv/config';
import mysql from 'mysql2/promise';

// Dừng sớm với một thông báo dễ hiểu nếu chưa có MySQL hoặc chưa chạy init-admin
export default async function setup() {
  const host = process.env.DB_HOST ?? '127.0.0.1';
  const port = Number(process.env.DB_PORT ?? 3306);
  let conn;
  try {
    conn = await mysql.createConnection({
      host, port, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME ?? 'records_retention',
    });
  } catch (err) {
    throw new Error(`Không kết nối được MySQL tại ${host}:${port} (${err.code ?? err.message}). `
      + 'Đã chạy "docker compose up -d" hoặc bật MySQL chưa? Kiểm tra DB_USER/DB_PASSWORD trong .env.');
  }
  try {
    const [[row]] = await conn.query("SELECT COUNT(*) AS n FROM user_roles WHERE role_id = 5 AND revoked_at IS NULL");
    if (Number(row.n) === 0) throw new Error('Chưa có Quản trị viên. Chạy "npm run init-admin -- ..." trước khi test.');
  } finally {
    await conn.end();
  }
}
