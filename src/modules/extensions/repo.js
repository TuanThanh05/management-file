const SELECT = `SELECT e.*, r.code AS record_code, r.title AS record_title, r.department_id, r.status AS record_status,
    d.code AS department_code, ru.email AS requested_by_email, ru.full_name AS requested_by_name,
    vu.email AS reviewed_by_email, vu.full_name AS reviewed_by_name
  FROM extension_requests e JOIN records r ON r.id = e.record_id JOIN departments d ON d.id = r.department_id
  JOIN users ru ON ru.id = e.requested_by LEFT JOIN users vu ON vu.id = e.reviewed_by`;

// Đề xuất gia hạn theo mã (forUpdate: khóa dòng đề xuất)
export async function findExtension(conn, code, { forUpdate = false } = {}) {
  const [[row]] = await conn.query(`${SELECT} WHERE e.code = ?${forUpdate ? ' FOR UPDATE OF e' : ''}`, [code]);
  return row ?? null;
}

// Hồ sơ có đang nằm trong đợt hủy chưa kết thúc / có đề xuất gia hạn đang chờ không
export async function recordBlockers(conn, recordId) {
  const [[row]] = await conn.query(
    `SELECT EXISTS (SELECT 1 FROM disposal_batch_records WHERE record_id = ? AND item_status = 'INCLUDED') AS in_batch,
            EXISTS (SELECT 1 FROM extension_requests WHERE record_id = ? AND status = 'PENDING') AS pending`, [recordId, recordId]);
  return { inBatch: Boolean(Number(row.in_batch)), pending: Boolean(Number(row.pending)) };
}

// Thêm đề xuất gia hạn ở Chờ duyệt
export async function insertExtension(conn, { code, recordId, oldExpiryDate, newExpiryDate, reason, requestedBy }) {
  await conn.query(
    `INSERT INTO extension_requests (code, record_id, old_expiry_date, new_expiry_date, reason, requested_by) VALUES (?, ?, ?, ?, ?, ?)`,
    [code, recordId, oldExpiryDate, newExpiryDate, reason, requestedBy]);
}

// Ghi kết quả xét duyệt (một lần)
export async function reviewExtension(conn, id, { status, reviewedBy, comment }) {
  await conn.query(
    'UPDATE extension_requests SET status = ?, reviewed_by = ?, reviewed_at = UTC_TIMESTAMP(3), review_comment = ? WHERE id = ?',
    [status, reviewedBy, comment ?? null, id]);
}

// Hồ sơ về Lưu trữ với ngày hết hạn mới, xóa dấu đã cảnh báo
export async function applyExtension(conn, recordId, newExpiryDate) {
  await conn.query("UPDATE records SET status = 'ARCHIVED', expiry_date = ?, is_warned = FALSE WHERE id = ?", [newExpiryDate, recordId]);
}

// Danh sách đề xuất có lọc; departmentId khác null thì chỉ phòng đó
export async function listExtensions(conn, f, { departmentId, page, pageSize }) {
  const where = ['1 = 1'];
  const params = [];
  if (departmentId) { where.push('r.department_id = ?'); params.push(departmentId); }
  if (f.status) { where.push('e.status = ?'); params.push(f.status); }
  if (f.departmentCode) { where.push('d.code = ?'); params.push(f.departmentCode); }
  if (f.recordCode) { where.push('r.code = ?'); params.push(f.recordCode); }
  if (f.from) { where.push('e.requested_at >= TIMESTAMP(?) - INTERVAL 7 HOUR'); params.push(f.from); }
  if (f.to) { where.push('e.requested_at < TIMESTAMP(?) + INTERVAL 17 HOUR'); params.push(f.to); }
  const w = `WHERE ${where.join(' AND ')}`;
  const [[{ total }]] = await conn.query(
    `SELECT COUNT(*) AS total FROM extension_requests e JOIN records r ON r.id = e.record_id JOIN departments d ON d.id = r.department_id ${w}`, params);
  const [rows] = await conn.query(`${SELECT} ${w} ORDER BY e.status = 'PENDING' DESC, e.requested_at DESC, e.id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize]);
  return { total: Number(total), rows };
}
