// Thêm lệnh phong tỏa (kèm thông tin tệp căn cứ đã mã hóa nếu có); trả về id
export async function insertHold(conn, h) {
  const [ins] = await conn.query(
    `INSERT INTO legal_holds (code, reason, legal_basis, expected_release_date, evidence_original_name, evidence_storage_name,
       evidence_sha256, evidence_wrapped_key, evidence_iv, evidence_auth_tag, placed_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [h.code, h.reason, h.legalBasis, h.expectedReleaseDate ?? null, h.evidence?.originalName ?? null, h.evidence?.storageName ?? null,
      h.evidence?.sha256 ?? null, h.evidence?.wrappedKey ?? null, h.evidence?.iv ?? null, h.evidence?.authTag ?? null, h.placedBy]);
  return ins.insertId;
}

// Khóa các hồ sơ được chọn theo mã
export async function lockRecords(conn, codes) {
  const [rows] = await conn.query(
    'SELECT id, code, status, is_on_hold, department_id FROM records WHERE code IN (?) ORDER BY id FOR UPDATE', [codes]);
  return rows;
}

// Gắn hồ sơ vào lệnh (trigger bật cờ phong tỏa, bỏ dấu đủ điều kiện hủy)
export async function addHoldRecords(conn, holdId, recordIds) {
  await conn.query('INSERT INTO legal_hold_records (legal_hold_id, record_id) VALUES ?', [recordIds.map((id) => [holdId, id])]);
}

// Lệnh phong tỏa theo mã (bảng chỉ thêm, không sửa: khóa ở legal_hold_records khi gỡ)
export async function findHold(conn, code) {
  const [[row]] = await conn.query(
    `SELECT h.*, u.email AS placed_by_email, u.full_name AS placed_by_name FROM legal_holds h JOIN users u ON u.id = h.placed_by
     WHERE h.code = ?`, [code]);
  return row ?? null;
}

// Hồ sơ trong lệnh, kèm người gỡ (forUpdate: khóa dòng legal_hold_records)
export async function holdRecords(conn, holdId, { forUpdate = false } = {}) {
  const [rows] = await conn.query(
    `SELECT x.*, r.code, r.title, r.status AS record_status, r.department_id, d.code AS department_code, u.email AS released_by_email
     FROM legal_hold_records x JOIN records r ON r.id = x.record_id JOIN departments d ON d.id = r.department_id
     LEFT JOIN users u ON u.id = x.released_by WHERE x.legal_hold_id = ? ORDER BY r.code${forUpdate ? ' FOR UPDATE OF x' : ''}`, [holdId]);
  return rows;
}

// Gỡ phong tỏa một hồ sơ (trigger tắt cờ)
export async function releaseHoldRecord(conn, holdId, recordId, { releasedBy, reason }) {
  await conn.query(
    `UPDATE legal_hold_records SET status = 'RELEASED', released_by = ?, released_at = UTC_TIMESTAMP(3), release_reason = ?
     WHERE legal_hold_id = ? AND record_id = ?`, [releasedBy, reason, holdId, recordId]);
}

// Danh sách lệnh kèm số hồ sơ còn phong tỏa / đã gỡ
export async function listHolds(conn, { status, overdue, today, page, pageSize }) {
  const having = [];
  if (status === 'ACTIVE') having.push('active_count > 0');
  if (status === 'RELEASED') having.push('active_count = 0');
  if (overdue) having.push('active_count > 0 AND h.expected_release_date < ?');
  const sql = `SELECT h.id, h.code, h.reason, h.legal_basis, h.expected_release_date, h.placed_at, h.evidence_original_name,
      u.email AS placed_by_email, SUM(x.status = 'ACTIVE') AS active_count, COUNT(*) AS record_count
    FROM legal_holds h JOIN users u ON u.id = h.placed_by JOIN legal_hold_records x ON x.legal_hold_id = h.id
    GROUP BY h.id ${having.length ? `HAVING ${having.join(' AND ')}` : ''}`;
  const params = overdue ? [today] : [];
  const [[{ total }]] = await conn.query(`SELECT COUNT(*) AS total FROM (${sql}) t`, params);
  const [rows] = await conn.query(`${sql} ORDER BY h.placed_at DESC, h.id DESC LIMIT ? OFFSET ?`, [...params, pageSize, (page - 1) * pageSize]);
  return { total: Number(total), rows };
}
