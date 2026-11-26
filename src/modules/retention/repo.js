// Hồ sơ của phòng cho màn hình cảnh báo hạn: Lưu trữ (có hoặc chưa có ngày hết hạn) và Hết hạn
export async function alertRows(conn, departmentId) {
  const [rows] = await conn.query(
    `SELECT r.code, r.title, r.status, r.is_on_hold, r.expiry_date, r.validity, v.retention_type, v.warning_days,
            t.code AS type_code, t.name AS type_name, l.code AS label_code
     FROM records r JOIN label_versions v ON v.id = r.label_version_id JOIN retention_labels l ON l.id = v.label_id
     JOIN document_types t ON t.id = r.document_type_id
     WHERE r.department_id = ? AND r.status IN ('ARCHIVED','EXPIRED') ORDER BY r.expiry_date, r.code`, [departmentId]);
  return rows;
}

// Hồ sơ Hết hạn của mọi phòng kèm phong tỏa, đề xuất gia hạn đang chờ, lý do bị loại/rút gần nhất (5.3 CN10)
export async function expiredRows(conn, f, { page, pageSize }) {
  const where = ["r.status = 'EXPIRED'"];
  const params = [];
  if (f.departmentCode) { where.push('d.code = ?'); params.push(f.departmentCode); }
  if (f.groupCode) { where.push('g.code = ?'); params.push(f.groupCode); }
  if (f.documentTypeCode) { where.push('t.code = ?'); params.push(f.documentTypeCode); }
  if (f.labelCode) { where.push('l.code = ?'); params.push(f.labelCode); }
  if (f.expiryDateFrom) { where.push('r.expiry_date >= ?'); params.push(f.expiryDateFrom); }
  if (f.expiryDateTo) { where.push('r.expiry_date <= ?'); params.push(f.expiryDateTo); }
  if (f.eligibleOnly) where.push("r.is_disposal_eligible AND NOT EXISTS (SELECT 1 FROM disposal_batch_records x WHERE x.record_id = r.id AND x.item_status = 'INCLUDED')");
  const from = `FROM records r JOIN departments d ON d.id = r.department_id JOIN document_types t ON t.id = r.document_type_id
    JOIN record_groups g ON g.id = t.group_id JOIN label_versions v ON v.id = r.label_version_id JOIN retention_labels l ON l.id = v.label_id
    WHERE ${where.join(' AND ')}`;
  const [[{ total }]] = await conn.query(`SELECT COUNT(*) AS total ${from}`, params);
  const [rows] = await conn.query(
    `SELECT r.code, r.title, r.expiry_date, r.is_on_hold, r.is_disposal_eligible, d.code AS department_code,
            t.code AS type_code, t.name AS type_name, g.code AS group_code, l.code AS label_code, v.version_no,
            (SELECT e.code FROM extension_requests e WHERE e.record_id = r.id AND e.status = 'PENDING') AS pending_extension,
            (SELECT x.exclusion_reason FROM disposal_batch_records x WHERE x.record_id = r.id AND x.item_status IN ('EXCLUDED','WITHDRAWN')
              ORDER BY x.added_at DESC LIMIT 1) AS last_exclusion_reason,
            EXISTS (SELECT 1 FROM disposal_batch_records x WHERE x.record_id = r.id AND x.item_status = 'INCLUDED') AS in_batch
     ${from} ORDER BY r.expiry_date, r.code LIMIT ? OFFSET ?`, [...params, pageSize, (page - 1) * pageSize]);
  return { total: Number(total), rows };
}

// Khóa các hồ sơ theo mã kèm tình trạng gia hạn chờ duyệt và đợt hủy chưa kết thúc
export async function lockForEligibility(conn, codes) {
  const [rows] = await conn.query(
    `SELECT r.id, r.code, r.status, r.is_on_hold, r.is_disposal_eligible,
            EXISTS (SELECT 1 FROM extension_requests e WHERE e.record_id = r.id AND e.status = 'PENDING') AS pending_extension,
            EXISTS (SELECT 1 FROM disposal_batch_records x WHERE x.record_id = r.id AND x.item_status = 'INCLUDED') AS in_batch
     FROM records r WHERE r.code IN (?) FOR UPDATE OF r`, [codes]);
  return rows;
}

// Đặt hoặc bỏ dấu đủ điều kiện hủy
export async function setEligible(conn, id, eligible, userId) {
  await conn.query(
    `UPDATE records SET is_disposal_eligible = ?, eligible_marked_by = ?, eligible_marked_at = IF(?, UTC_TIMESTAMP(3), NULL) WHERE id = ?`,
    [eligible, eligible ? userId : null, eligible, id]);
}
