// Truy vấn hồ sơ, file, phiên bản file (mọi hàm nhận conn để chạy trong hoặc ngoài transaction)

// Loại tài liệu kèm nhãn đang hiệu lực (dùng khi tạo/sửa hồ sơ)
export async function findTypeWithLabel(conn, code) {
  const [[row]] = await conn.query(
    `SELECT t.id, t.code, t.name, t.status, g.code AS group_code, g.name AS group_name,
            v.id AS label_version_id, l.code AS label_code, v.version_no, v.label_name, v.retention_type, v.retention_years,
            v.start_trigger, v.event_name, v.warning_days, v.contains_personal_data
     FROM document_types t JOIN record_groups g ON g.id = t.group_id
     LEFT JOIN label_versions v ON v.id = t.current_label_version_id AND v.status = 'ACTIVE'
     LEFT JOIN retention_labels l ON l.id = v.label_id
     WHERE t.code = ?`, [code]);
  return row ?? null;
}

// Mã phòng ban theo id
export async function departmentCode(conn, departmentId) {
  const [[row]] = await conn.query('SELECT code FROM departments WHERE id = ?', [departmentId]);
  return row?.code ?? null;
}

// Thêm hồ sơ ở trạng thái Đang sử dụng
export async function insertRecord(conn, r) {
  const [res] = await conn.query(
    `INSERT INTO records (code, title, description, document_type_id, department_id, created_by, document_date,
       event_end_date, event_note, validity)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [r.code, r.title, r.description ?? null, r.documentTypeId, r.departmentId, r.createdBy, r.documentDate,
      r.eventEndDate ?? null, r.eventNote ?? null, r.validity]);
  return String(res.insertId);
}

// Lấy hồ sơ theo mã (khóa dòng hồ sơ nếu forUpdate)
export async function findRecord(conn, code, { forUpdate = false } = {}) {
  const [[row]] = await conn.query(`SELECT * FROM records WHERE code = ?${forUpdate ? ' FOR UPDATE' : ''}`, [code]);
  return row ?? null;
}

// Chi tiết hồ sơ kèm loại, nhóm, phòng ban, người tạo và nhãn (đã gắn khi duyệt, hoặc nhãn hiện tại của loại)
export async function getRecordDetail(conn, code) {
  const [[row]] = await conn.query(
    `SELECT r.*, t.code AS type_code, t.name AS type_name, g.code AS group_code, g.name AS group_name,
            d.code AS department_code, d.name AS department_name, u.email AS created_by_email, u.full_name AS created_by_name,
            COALESCE(av.id, cv.id) AS lv_id, COALESCE(al.code, cl.code) AS lv_label_code,
            COALESCE(av.version_no, cv.version_no) AS lv_version_no, COALESCE(av.label_name, cv.label_name) AS lv_label_name,
            COALESCE(av.retention_type, cv.retention_type) AS lv_retention_type,
            COALESCE(av.retention_years, cv.retention_years) AS lv_retention_years,
            COALESCE(av.start_trigger, cv.start_trigger) AS lv_start_trigger, COALESCE(av.event_name, cv.event_name) AS lv_event_name,
            COALESCE(av.contains_personal_data, cv.contains_personal_data) AS lv_personal, (av.id IS NOT NULL) AS lv_applied
     FROM records r JOIN document_types t ON t.id = r.document_type_id JOIN record_groups g ON g.id = t.group_id
     JOIN departments d ON d.id = r.department_id JOIN users u ON u.id = r.created_by
     LEFT JOIN label_versions av ON av.id = r.label_version_id LEFT JOIN retention_labels al ON al.id = av.label_id
     LEFT JOIN label_versions cv ON cv.id = t.current_label_version_id AND cv.status = 'ACTIVE' AND r.label_version_id IS NULL
     LEFT JOIN retention_labels cl ON cl.id = cv.label_id
     WHERE r.code = ?`, [code]);
  return row ?? null;
}

// Sửa các trường khai báo của hồ sơ Đang sử dụng
export async function updateRecord(conn, id, r) {
  await conn.query(
    `UPDATE records SET title = ?, description = ?, document_type_id = ?, document_date = ?, event_end_date = ?,
       event_note = ?, validity = ? WHERE id = ?`,
    [r.title, r.description, r.documentTypeId, r.documentDate, r.eventEndDate, r.eventNote, r.validity, id]);
}

// Chuyển hồ sơ sang Đã hủy bỏ
export async function cancelRecord(conn, id, reason) {
  await conn.query("UPDATE records SET status = 'CANCELLED', cancel_reason = ?, cancelled_at = UTC_TIMESTAMP(3) WHERE id = ?", [reason, id]);
}

// Số file đang dùng của hồ sơ
export async function countActiveFiles(conn, recordId) {
  const [[row]] = await conn.query('SELECT COUNT(*) AS n FROM files WHERE record_id = ? AND is_active', [recordId]);
  return Number(row.n);
}

// Thêm file logic vào hồ sơ
export async function insertFile(conn, { recordId, originalName, createdBy }) {
  const [res] = await conn.query('INSERT INTO files (record_id, original_name, created_by) VALUES (?, ?, ?)', [recordId, originalName, createdBy]);
  return String(res.insertId);
}

// Lấy file thuộc hồ sơ (khóa dòng nếu forUpdate)
export async function findFile(conn, recordId, fileId, { forUpdate = false } = {}) {
  const [[row]] = await conn.query(`SELECT * FROM files WHERE id = ? AND record_id = ?${forUpdate ? ' FOR UPDATE' : ''}`, [fileId, recordId]);
  return row ?? null;
}

// Gỡ file khỏi danh sách đang dùng (vẫn giữ lịch sử)
export async function deactivateFile(conn, fileId) {
  await conn.query('UPDATE files SET is_active = FALSE WHERE id = ?', [fileId]);
}

// Số phiên bản tiếp theo của file
export async function nextFileVersionNo(conn, fileId) {
  const [[row]] = await conn.query('SELECT COALESCE(MAX(version_no), 0) + 1 AS n FROM file_versions WHERE file_id = ?', [fileId]);
  return Number(row.n);
}

// Thêm phiên bản file đã mã hóa
export async function insertFileVersion(conn, v) {
  await conn.query(
    `INSERT INTO file_versions (file_id, version_no, storage_name, format, size_bytes, sha256, wrapped_key, iv, auth_tag, uploaded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [v.fileId, v.versionNo, v.storageName, v.format, v.sizeBytes, v.sha256, v.wrappedKey, v.iv, v.authTag, v.uploadedBy]);
}

// Lấy một phiên bản của file (mặc định mới nhất)
export async function findFileVersion(conn, fileId, versionNo) {
  const [[row]] = await conn.query(
    `SELECT * FROM file_versions WHERE file_id = ? ${versionNo ? 'AND version_no = ?' : ''} ORDER BY version_no DESC LIMIT 1`,
    versionNo ? [fileId, versionNo] : [fileId]);
  return row ?? null;
}

// Danh sách file và mọi phiên bản của hồ sơ (không lấy khóa)
export async function listFiles(conn, recordId) {
  const [rows] = await conn.query(
    `SELECT f.id AS file_id, f.original_name, f.is_active, f.created_at AS file_created_at,
            v.version_no, v.format, v.size_bytes, v.sha256, v.is_purged, (v.wrapped_key IS NULL) AS key_destroyed,
            v.uploaded_at, u.email AS uploaded_by_email
     FROM files f JOIN file_versions v ON v.file_id = f.id JOIN users u ON u.id = v.uploaded_by
     WHERE f.record_id = ? ORDER BY f.id, v.version_no`, [recordId]);
  return rows;
}

// Hủy bằng mật mã: xóa khóa dữ liệu của mọi phiên bản file thuộc hồ sơ; trả về tên lưu trữ cần xóa khỏi kho
export async function destroyKeysOfRecord(conn, recordId) {
  const [rows] = await conn.query(
    `SELECT v.id, v.storage_name FROM file_versions v JOIN files f ON f.id = v.file_id
     WHERE f.record_id = ? AND v.wrapped_key IS NOT NULL FOR UPDATE OF v`, [recordId]);
  if (rows.length) await conn.query('UPDATE file_versions SET wrapped_key = NULL WHERE id IN (?)', [rows.map((r) => r.id)]);
  return rows;
}

// Đánh dấu đã xóa bản mã khỏi kho
export async function markPurged(conn, versionIds) {
  if (!versionIds.length) return;
  await conn.query('UPDATE file_versions SET is_purged = TRUE WHERE id IN (?) AND wrapped_key IS NULL', [versionIds]);
}

// Lịch sử xử lý hồ sơ lấy từ nhật ký (không lấy chi tiết nhạy cảm)
export async function recordHistory(conn, code) {
  const [rows] = await conn.query(
    `SELECT a.seq, a.occurred_at, a.action, a.result, a.details, u.email AS actor_email
     FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
     WHERE a.object_type = 'RECORD' AND a.object_code = ? AND a.action NOT IN ('RECORD_VIEW','FILE_VIEW','FILE_DOWNLOAD')
     ORDER BY a.seq`, [code]);
  return rows;
}
