import { pool } from '../../config/database.js';

const VERSION_COLUMNS = `v.*, l.code AS label_code, l.group_id, g.code AS group_code, g.status AS group_status,
  cu.email AS created_by_email, ru.email AS reviewed_by_email`;
const VERSION_FROM = `FROM label_versions v JOIN retention_labels l ON l.id = v.label_id JOIN record_groups g ON g.id = l.group_id
  JOIN users cu ON cu.id = v.created_by LEFT JOIN users ru ON ru.id = v.reviewed_by`;

// Lấy nhãn theo mã (khóa dòng nếu forUpdate)
export async function findLabel(conn, code, { forUpdate = false } = {}) {
  const [[row]] = await conn.query(`SELECT * FROM retention_labels WHERE code = ?${forUpdate ? ' FOR UPDATE' : ''}`, [code]);
  return row ?? null;
}

// Thêm nhãn (chỉ định danh, luật nằm ở phiên bản)
export async function insertLabel(conn, { code, name, groupId, createdBy }) {
  const [res] = await conn.query('INSERT INTO retention_labels (code, name, group_id, created_by) VALUES (?, ?, ?, ?)',
    [code, name, groupId, createdBy]);
  return String(res.insertId);
}

// Đổi tên hiển thị của nhãn theo phiên bản vừa có hiệu lực
export async function renameLabel(conn, labelId, name) {
  await conn.query('UPDATE retention_labels SET name = ? WHERE id = ?', [name, labelId]);
}

// Phiên bản đang hiệu lực của nhãn
export async function getActiveVersion(conn, labelId) {
  const [[row]] = await conn.query(`SELECT ${VERSION_COLUMNS} ${VERSION_FROM} WHERE v.label_id = ? AND v.status = 'ACTIVE'`, [labelId]);
  return row ?? null;
}

// Phiên bản đang Nháp/Chờ duyệt của nhãn (mỗi nhãn tối đa 1)
export async function getOpenVersion(conn, labelId) {
  const [[row]] = await conn.query("SELECT id, version_no, status FROM label_versions WHERE label_id = ? AND status IN ('DRAFT','PENDING')", [labelId]);
  return row ?? null;
}

// Số phiên bản tiếp theo của nhãn
export async function nextVersionNo(conn, labelId) {
  const [[row]] = await conn.query('SELECT COALESCE(MAX(version_no), 0) + 1 AS n FROM label_versions WHERE label_id = ?', [labelId]);
  return Number(row.n);
}

// Thêm phiên bản ở trạng thái Nháp
export async function insertVersion(conn, d) {
  const [res] = await conn.query(
    `INSERT INTO label_versions (label_id, version_no, proposal_type, label_name, retention_type, retention_years, start_trigger,
       event_name, warning_days, contains_personal_data, legal_basis, proposal_reason, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [d.labelId, d.versionNo, d.proposalType, d.labelName, d.retentionType, d.retentionYears, d.startTrigger, d.eventName,
      d.warningDays, d.containsPersonalData, d.legalBasis, d.proposalReason, d.createdBy]);
  return String(res.insertId);
}

// Lấy phiên bản theo id kèm mã nhãn, nhóm (khóa dòng phiên bản nếu forUpdate)
export async function getVersion(conn, id, { forUpdate = false } = {}) {
  const [[row]] = await conn.query(`SELECT ${VERSION_COLUMNS} ${VERSION_FROM} WHERE v.id = ?${forUpdate ? ' FOR UPDATE OF v' : ''}`, [id]);
  return row ?? null;
}

// Lấy phiên bản theo mã nhãn và số phiên bản
export async function getVersionByNo(conn, labelId, versionNo) {
  const [[row]] = await conn.query(`SELECT ${VERSION_COLUMNS} ${VERSION_FROM} WHERE v.label_id = ? AND v.version_no = ?`, [labelId, versionNo]);
  return row ?? null;
}

// Lưu các trường luật của phiên bản Nháp
export async function updateVersionFields(conn, id, d) {
  await conn.query(
    `UPDATE label_versions SET label_name = ?, retention_type = ?, retention_years = ?, start_trigger = ?, event_name = ?,
       warning_days = ?, contains_personal_data = ?, legal_basis = ?, proposal_reason = ? WHERE id = ?`,
    [d.labelName, d.retentionType, d.retentionYears, d.startTrigger, d.eventName, d.warningDays, d.containsPersonalData,
      d.legalBasis, d.proposalReason, id]);
}

// Chuyển trạng thái phiên bản và ghi thêm các cột liên quan
export async function setVersionStatus(conn, id, status, extra = {}) {
  const cols = Object.keys(extra);
  const sets = ['status = ?', ...cols.map((c) => (extra[c] === 'NOW' ? `${c} = UTC_TIMESTAMP(3)` : `${c} = ?`))];
  const params = [status, ...cols.filter((c) => extra[c] !== 'NOW').map((c) => extra[c]), id];
  await conn.query(`UPDATE label_versions SET ${sets.join(', ')} WHERE id = ?`, params);
}

// Loại tài liệu của một phiên bản (id, mã, nhóm, trạng thái, phiên bản nhãn hiện tại)
export async function getVersionTypes(conn, versionId) {
  const [rows] = await conn.query(
    `SELECT t.id, t.code, t.name, t.status, t.group_id, t.current_label_version_id
     FROM label_version_document_types x JOIN document_types t ON t.id = x.document_type_id
     WHERE x.label_version_id = ? ORDER BY t.code`, [versionId]);
  return rows;
}

// Tìm loại tài liệu theo danh sách mã
export async function findTypesByCodes(conn, codes) {
  if (!codes.length) return [];
  const [rows] = await conn.query('SELECT id, code, status, group_id, current_label_version_id FROM document_types WHERE code IN (?)', [codes]);
  return rows;
}

// Thêm loại tài liệu vào phiên bản Nháp
export async function addVersionTypes(conn, versionId, typeIds) {
  if (!typeIds.length) return;
  await conn.query('INSERT INTO label_version_document_types (label_version_id, document_type_id) VALUES ?', [typeIds.map((t) => [versionId, t])]);
}

// Bỏ loại tài liệu khỏi phiên bản Nháp (trigger chỉ cho phép khi Nháp)
export async function removeVersionTypes(conn, versionId, typeIds) {
  if (!typeIds.length) return;
  await conn.query('DELETE FROM label_version_document_types WHERE label_version_id = ? AND document_type_id IN (?)', [versionId, typeIds]);
}

// Mã các loại đang nằm trong đề xuất khác ở Nháp hoặc Chờ duyệt
export async function typesInOtherOpenProposals(conn, typeIds, excludeVersionId) {
  if (!typeIds.length) return [];
  const [rows] = await conn.query(
    `SELECT DISTINCT t.code, l.code AS label_code FROM label_version_document_types x
     JOIN label_versions v ON v.id = x.label_version_id JOIN retention_labels l ON l.id = v.label_id
     JOIN document_types t ON t.id = x.document_type_id
     WHERE x.document_type_id IN (?) AND v.status IN ('DRAFT','PENDING') AND v.id <> ?`, [typeIds, excludeVersionId ?? 0]);
  return rows;
}

// Số loại tài liệu đang sử dụng còn gắn với phiên bản
export async function countTypesInUse(conn, versionId) {
  const [[row]] = await conn.query("SELECT COUNT(*) AS n FROM document_types WHERE current_label_version_id = ? AND status = 'ACTIVE'", [versionId]);
  return Number(row.n);
}

// Gắn các loại tài liệu vào phiên bản vừa có hiệu lực
export async function pointTypesToVersion(conn, typeIds, versionId) {
  if (!typeIds.length) return;
  await conn.query('UPDATE document_types SET current_label_version_id = ? WHERE id IN (?)', [versionId, typeIds]);
}

// Bỏ nhãn của các loại còn trỏ vào phiên bản cũ (loại bị bỏ khỏi phiên bản mới); trả về mã loại
export async function detachTypesFromVersion(conn, oldVersionId) {
  const [rows] = await conn.query('SELECT id, code FROM document_types WHERE current_label_version_id = ? FOR UPDATE', [oldVersionId]);
  if (rows.length) await conn.query('UPDATE document_types SET current_label_version_id = NULL WHERE current_label_version_id = ?', [oldVersionId]);
  return rows.map((r) => r.code);
}

// Phiên bản đang hiệu lực mà từng loại tài liệu đang gắn (để phát hiện chuyển loại từ nhãn khác)
export async function currentVersionsOfTypes(conn, typeIds) {
  if (!typeIds.length) return [];
  const [rows] = await conn.query(
    `SELECT t.id AS type_id, t.code AS type_code, v.id AS version_id, v.label_id, l.code AS label_code,
            v.retention_type, v.retention_years
     FROM document_types t JOIN label_versions v ON v.id = t.current_label_version_id AND v.status = 'ACTIVE'
     JOIN retention_labels l ON l.id = v.label_id WHERE t.id IN (?)`, [typeIds]);
  return rows;
}

// Số hồ sơ đang lưu trữ (Lưu trữ, Hết hạn, Chờ duyệt hủy) thuộc các loại tài liệu
export async function countStoredRecordsOfTypes(conn, typeIds) {
  if (!typeIds.length) return 0;
  const [[row]] = await conn.query(
    "SELECT COUNT(*) AS n FROM records WHERE document_type_id IN (?) AND status IN ('ARCHIVED','EXPIRED','PENDING_DISPOSAL')", [typeIds]);
  return Number(row.n);
}

// Danh sách nhãn kèm phiên bản hiệu lực, đề xuất đang mở, loại tài liệu đang gắn
export async function listLabels() {
  const [rows] = await pool.query(
    `SELECT l.id, l.code, l.name, g.code AS group_code, g.name AS group_name,
            v.id AS active_id, v.version_no AS active_no, v.retention_type, v.retention_years, v.start_trigger, v.event_name,
            v.warning_days, v.contains_personal_data, v.effective_at,
            o.id AS open_id, o.version_no AS open_no, o.status AS open_status, o.proposal_type AS open_type,
            (SELECT JSON_ARRAYAGG(t.code) FROM document_types t WHERE t.current_label_version_id = v.id) AS document_types
     FROM retention_labels l JOIN record_groups g ON g.id = l.group_id
     LEFT JOIN label_versions v ON v.label_id = l.id AND v.status = 'ACTIVE'
     LEFT JOIN label_versions o ON o.label_id = l.id AND o.status IN ('DRAFT','PENDING')
     ORDER BY l.code`);
  return rows;
}

// Mọi phiên bản của nhãn kèm số hồ sơ đang gắn và danh sách loại tài liệu
export async function listVersionsOfLabel(labelId) {
  const [rows] = await pool.query(
    `SELECT ${VERSION_COLUMNS},
            (SELECT COUNT(*) FROM records r WHERE r.label_version_id = v.id) AS record_count,
            (SELECT JSON_ARRAYAGG(t.code) FROM label_version_document_types x JOIN document_types t ON t.id = x.document_type_id
             WHERE x.label_version_id = v.id) AS document_types
     ${VERSION_FROM} WHERE v.label_id = ? ORDER BY v.version_no`, [labelId]);
  return rows;
}

// Danh sách phiên bản theo trạng thái (Giám đốc xem đề xuất chờ duyệt)
export async function listVersionsByStatus(status) {
  const [rows] = await pool.query(
    `SELECT ${VERSION_COLUMNS} ${VERSION_FROM} ${status ? 'WHERE v.status = ?' : ''} ORDER BY v.id DESC LIMIT 200`,
    status ? [status] : []);
  return rows;
}
