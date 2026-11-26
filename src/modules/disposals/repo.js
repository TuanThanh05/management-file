const BATCH = `SELECT b.*, d.code AS department_code, d.name AS department_name,
    c.email AS created_by_email, c.full_name AS created_by_name, a1.email AS level1_email, a1.full_name AS level1_name,
    a2.email AS level2_email, a2.full_name AS level2_name,
    (SELECT COUNT(*) FROM disposal_batch_records x WHERE x.batch_id = b.id AND x.item_status = 'INCLUDED') AS included_count
  FROM disposal_batches b JOIN departments d ON d.id = b.department_id JOIN users c ON c.id = b.created_by
  LEFT JOIN users a1 ON a1.id = b.level1_approver_id LEFT JOIN users a2 ON a2.id = b.level2_approver_id`;

// Đợt hủy theo mã (forUpdate: khóa dòng đợt)
export async function findBatch(conn, code, { forUpdate = false } = {}) {
  const [[row]] = await conn.query(`${BATCH} WHERE b.code = ?${forUpdate ? ' FOR UPDATE OF b' : ''}`, [code]);
  return row ?? null;
}

// Hồ sơ trong đợt kèm thông tin hiển thị (BM05); forUpdate: khóa dòng đợt-hồ sơ và hồ sơ
export async function batchItems(conn, batchId, { forUpdate = false } = {}) {
  const [rows] = await conn.query(
    `SELECT x.*, r.code, r.title, r.status AS record_status, r.document_date, r.expiry_date, r.is_on_hold, r.is_disposal_eligible,
            t.code AS type_code, t.name AS type_name, l.code AS label_code, v.version_no,
            EXISTS (SELECT 1 FROM extension_requests e WHERE e.record_id = r.id AND e.status = 'PENDING') AS pending_extension
     FROM disposal_batch_records x JOIN records r ON r.id = x.record_id JOIN document_types t ON t.id = r.document_type_id
     JOIN label_versions v ON v.id = r.label_version_id JOIN retention_labels l ON l.id = v.label_id
     WHERE x.batch_id = ? ORDER BY r.code${forUpdate ? ' FOR UPDATE OF x, r' : ''}`, [batchId]);
  return rows;
}

// Khóa hồ sơ theo mã kèm điều kiện vào đợt: phòng, dấu hủy, phong tỏa, gia hạn chờ, đợt chưa kết thúc đang chứa
export async function lockCandidates(conn, codes) {
  if (!codes.length) return [];
  const [rows] = await conn.query(
    `SELECT r.id, r.code, r.status, r.department_id, r.is_disposal_eligible, r.is_on_hold,
            EXISTS (SELECT 1 FROM extension_requests e WHERE e.record_id = r.id AND e.status = 'PENDING') AS pending_extension,
            (SELECT b.code FROM disposal_batch_records x JOIN disposal_batches b ON b.id = x.batch_id
              WHERE x.record_id = r.id AND x.item_status = 'INCLUDED' LIMIT 1) AS open_batch
     FROM records r WHERE r.code IN (?) ORDER BY r.id FOR UPDATE OF r`, [codes]);
  return rows;
}

// Thêm đợt Nháp; trả về id
export async function insertBatch(conn, { code, departmentId, reason, createdBy }) {
  const [ins] = await conn.query('INSERT INTO disposal_batches (code, department_id, reason, created_by) VALUES (?, ?, ?, ?)',
    [code, departmentId, reason, createdBy]);
  return ins.insertId;
}

// Đưa hồ sơ vào đợt: dòng mới, hoặc đưa lại dòng đã rút trước đó (cùng đợt)
export async function includeRecords(conn, batchId, recordIds) {
  for (const id of recordIds) {
    await conn.query(
      `INSERT INTO disposal_batch_records (batch_id, record_id) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE item_status = 'INCLUDED', added_at = UTC_TIMESTAMP(3)`, [batchId, id]);
  }
}

// Cập nhật cột của đợt; giá trị 'NOW' = thời điểm hiện tại UTC
export async function updateBatch(conn, id, fields) {
  const cols = Object.keys(fields);
  const sets = cols.map((c) => (fields[c] === 'NOW' ? `${c} = UTC_TIMESTAMP(3)` : `${c} = ?`));
  await conn.query(`UPDATE disposal_batches SET ${sets.join(', ')} WHERE id = ?`,
    [...cols.filter((c) => fields[c] !== 'NOW').map((c) => fields[c]), id]);
}

// Đặt trạng thái dòng đợt-hồ sơ (WITHDRAWN / EXCLUDED kèm lý do); đề nghị loại hết tác dụng
export async function setItemStatus(conn, batchId, recordIds, status, reason) {
  if (!recordIds.length) return;
  await conn.query('UPDATE disposal_batch_records SET item_status = ?, exclusion_reason = ?, exclusion_requested = FALSE WHERE batch_id = ? AND record_id IN (?)',
    [status, reason, batchId, recordIds]);
}

// Đánh / bỏ đề nghị loại của Trưởng phòng trên một dòng
export async function setExclusion(conn, batchId, recordId, requested, reason) {
  await conn.query('UPDATE disposal_batch_records SET exclusion_requested = ?, exclusion_reason = ? WHERE batch_id = ? AND record_id = ?',
    [requested, requested ? reason : null, batchId, recordId]);
}

// Bỏ mọi đề nghị loại của đợt (khi trả lại cấp 1)
export async function clearExclusions(conn, batchId) {
  await conn.query(
    "UPDATE disposal_batch_records SET exclusion_requested = FALSE, exclusion_reason = NULL WHERE batch_id = ? AND item_status = 'INCLUDED' AND exclusion_requested",
    [batchId]);
}

// Chuyển trạng thái nhiều hồ sơ
export async function setRecordsStatus(conn, recordIds, status) {
  if (!recordIds.length) return;
  await conn.query('UPDATE records SET status = ? WHERE id IN (?)', [status, recordIds]);
}

// Bỏ dấu đủ điều kiện hủy (hồ sơ bị Trưởng phòng loại)
export async function clearEligible(conn, recordIds) {
  if (!recordIds.length) return;
  await conn.query('UPDATE records SET is_disposal_eligible = FALSE, eligible_marked_by = NULL, eligible_marked_at = NULL WHERE id IN (?)', [recordIds]);
}

// Danh sách đợt có lọc; departmentId khác null thì chỉ phòng đó
export async function listBatches(conn, f, { departmentId, page, pageSize }) {
  const where = ['1 = 1'];
  const params = [];
  if (departmentId) { where.push('b.department_id = ?'); params.push(departmentId); }
  if (f.status) { where.push('b.status = ?'); params.push(f.status); }
  if (f.departmentCode) { where.push('d.code = ?'); params.push(f.departmentCode); }
  if (f.from) { where.push('b.created_at >= TIMESTAMP(?) - INTERVAL 7 HOUR'); params.push(f.from); }
  if (f.to) { where.push('b.created_at < TIMESTAMP(?) + INTERVAL 17 HOUR'); params.push(f.to); }
  const w = `WHERE ${where.join(' AND ')}`;
  const [[{ total }]] = await conn.query(
    `SELECT COUNT(*) AS total FROM disposal_batches b JOIN departments d ON d.id = b.department_id ${w}`, params);
  const [rows] = await conn.query(`${BATCH} ${w} ORDER BY b.created_at DESC, b.id DESC LIMIT ? OFFSET ?`, [...params, pageSize, (page - 1) * pageSize]);
  return { total: Number(total), rows };
}

// Lịch sử xử lý của đợt từ nhật ký
export async function batchHistory(conn, code) {
  const [rows] = await conn.query(
    `SELECT a.seq, a.occurred_at, a.action, a.result, a.details, u.email AS actor_email FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
     WHERE a.object_type = 'DISPOSAL_BATCH' AND a.object_code = ? ORDER BY a.seq`, [code]);
  return rows;
}

// Đợt chờ Trưởng phòng duyệt cấp 1 (không gồm đợt do chính người duyệt lập), chờ lâu nhất trước
export async function pendingLevel1(conn, departmentId, excludeUserId) {
  const [rows] = await conn.query(
    `SELECT b.code, b.reason, b.submitted_at, u.email AS created_by_email,
            (SELECT COUNT(*) FROM disposal_batch_records x WHERE x.batch_id = b.id AND x.item_status = 'INCLUDED') AS record_count,
            DATEDIFF(DATE(UTC_TIMESTAMP() + INTERVAL 7 HOUR), DATE(b.submitted_at + INTERVAL 7 HOUR)) AS waiting_days
     FROM disposal_batches b JOIN users u ON u.id = b.created_by
     WHERE b.status = 'PENDING_LEVEL_1' AND b.department_id = ? AND b.created_by <> ? ORDER BY b.submitted_at`, [departmentId, excludeUserId]);
  return rows;
}

// Các đợt chưa kết thúc đang chứa hồ sơ (dùng khi phong tỏa để rút hồ sơ khỏi đợt)
export async function openBatchesOf(conn, recordIds) {
  if (!recordIds.length) return [];
  const [rows] = await conn.query(
    `SELECT b.id, b.code, b.status, b.started_at, b.created_by, b.department_id, x.record_id, r.code AS record_code, r.status AS record_status
     FROM disposal_batch_records x JOIN disposal_batches b ON b.id = x.batch_id JOIN records r ON r.id = x.record_id
     WHERE x.record_id IN (?) AND x.item_status = 'INCLUDED' AND b.status NOT IN ('COMPLETED','CANCELLED')
     ORDER BY b.id FOR UPDATE OF b, x`, [recordIds]);
  return rows;
}

// Hàng chờ của Giám đốc: đề xuất nhãn Chờ duyệt, đợt Chờ duyệt cấp 2, đợt Đã phê duyệt đang trong thời gian chờ
export async function directorQueue(conn) {
  const days = (col) => `DATEDIFF(DATE(UTC_TIMESTAMP() + INTERVAL 7 HOUR), DATE(${col} + INTERVAL 7 HOUR))`;
  const count = "(SELECT COUNT(*) FROM disposal_batch_records x WHERE x.batch_id = b.id AND x.item_status = 'INCLUDED')";
  const [labels] = await conn.query(
    `SELECT v.id, l.code AS label_code, v.version_no, v.proposal_type, v.submitted_at, ${days('v.submitted_at')} AS waiting_days
     FROM label_versions v JOIN retention_labels l ON l.id = v.label_id WHERE v.status = 'PENDING' ORDER BY v.submitted_at`);
  const [level2] = await conn.query(
    `SELECT b.code, d.code AS department_code, b.level1_approved_at, ${count} AS record_count, ${days('b.level1_approved_at')} AS waiting_days
     FROM disposal_batches b JOIN departments d ON d.id = b.department_id WHERE b.status = 'PENDING_LEVEL_2' ORDER BY b.level1_approved_at`);
  const [scheduled] = await conn.query(
    `SELECT b.code, d.code AS department_code, b.scheduled_at, ${count} AS record_count,
            TIMESTAMPDIFF(MINUTE, UTC_TIMESTAMP(3), b.scheduled_at) AS minutes_left
     FROM disposal_batches b JOIN departments d ON d.id = b.department_id
     WHERE b.status = 'APPROVED' AND b.started_at IS NULL ORDER BY b.scheduled_at`);
  return { labels, level2, scheduled };
}
