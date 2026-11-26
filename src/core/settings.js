// Đọc tham số hệ thống (BM22) theo danh sách khóa; tham số INTEGER trả về số
export async function getSettings(conn, keys) {
  const [rows] = await conn.query(
    'SELECT setting_key, value, value_type FROM system_settings WHERE setting_key IN (?)', [keys]);
  const out = {};
  for (const r of rows) out[r.setting_key] = r.value_type === 'INTEGER' ? Number(r.value) : r.value;
  const missing = keys.filter((k) => !(k in out));
  if (missing.length) throw new Error(`Thiếu tham số hệ thống: ${missing.join(', ')}`);
  return out;
}
