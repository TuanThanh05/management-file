import { pool } from '../../config/database.js';

// ---------- Nhóm hồ sơ ----------

// Danh sách nhóm kèm số loại tài liệu và số nhãn đang hiệu lực
export async function listGroups() {
  const [rows] = await pool.query(
    `SELECT g.code, g.name, g.description, g.status, g.created_at,
            (SELECT COUNT(*) FROM document_types t WHERE t.group_id = g.id) AS type_count,
            (SELECT COUNT(*) FROM retention_labels l JOIN label_versions v ON v.label_id = l.id AND v.status = 'ACTIVE'
             WHERE l.group_id = g.id) AS active_labels
     FROM record_groups g ORDER BY g.code`);
  return rows;
}

// Lấy nhóm theo mã (khóa dòng nếu forUpdate)
export async function findGroup(conn, code, { forUpdate = false } = {}) {
  const [[row]] = await conn.query(`SELECT * FROM record_groups WHERE code = ?${forUpdate ? ' FOR UPDATE' : ''}`, [code]);
  return row ?? null;
}

// Thêm nhóm
export async function insertGroup(conn, { code, name, description, createdBy }) {
  await conn.query('INSERT INTO record_groups (code, name, description, created_by) VALUES (?, ?, ?, ?)',
    [code, name, description ?? null, createdBy]);
}

// Sửa tên / mô tả nhóm
export async function updateGroup(conn, id, { name, description }) {
  await conn.query('UPDATE record_groups SET name = ?, description = ? WHERE id = ?', [name, description, id]);
}

// Đổi trạng thái nhóm
export async function setGroupStatus(conn, id, status) {
  await conn.query('UPDATE record_groups SET status = ? WHERE id = ?', [status, id]);
}

// Số nhãn của nhóm đang có phiên bản hiệu lực
export async function countActiveLabelsInGroup(conn, groupId) {
  const [[row]] = await conn.query(
    `SELECT COUNT(*) AS n FROM retention_labels l JOIN label_versions v ON v.label_id = l.id AND v.status = 'ACTIVE'
     WHERE l.group_id = ?`, [groupId]);
  return Number(row.n);
}

// ---------- Loại tài liệu ----------

const TYPE_COLUMNS = `t.code, t.name, t.description, t.status, t.created_at, g.code AS group_code, g.name AS group_name,
  l.code AS label_code, v.version_no AS label_version_no, v.label_name, v.retention_type, v.retention_years,
  v.start_trigger, v.event_name, v.warning_days, v.contains_personal_data`;
const TYPE_FROM = `FROM document_types t JOIN record_groups g ON g.id = t.group_id
  LEFT JOIN label_versions v ON v.id = t.current_label_version_id AND v.status = 'ACTIVE'
  LEFT JOIN retention_labels l ON l.id = v.label_id`;

// Danh sách loại tài liệu kèm nhãn đang áp dụng; usable = đang sử dụng và có nhãn hiệu lực
export async function listTypes({ groupCode, status, usable }) {
  const where = [];
  const params = [];
  if (groupCode) { where.push('g.code = ?'); params.push(groupCode); }
  if (status) { where.push('t.status = ?'); params.push(status); }
  if (usable === 'true') where.push("t.status = 'ACTIVE' AND v.id IS NOT NULL");
  if (usable === 'false') where.push("NOT (t.status = 'ACTIVE' AND v.id IS NOT NULL)");
  const [rows] = await pool.query(
    `SELECT ${TYPE_COLUMNS} ${TYPE_FROM} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY t.code`, params);
  return rows;
}

// Một loại tài liệu kèm nhãn đang áp dụng
export async function getType(conn, code) {
  const [[row]] = await conn.query(`SELECT ${TYPE_COLUMNS} ${TYPE_FROM} WHERE t.code = ?`, [code]);
  return row ?? null;
}

// Lấy dòng loại tài liệu theo mã (khóa dòng nếu forUpdate)
export async function findType(conn, code, { forUpdate = false } = {}) {
  const [[row]] = await conn.query(`SELECT * FROM document_types WHERE code = ?${forUpdate ? ' FOR UPDATE' : ''}`, [code]);
  return row ?? null;
}

// Thêm loại tài liệu (chưa gắn nhãn)
export async function insertType(conn, { code, name, groupId, description, createdBy }) {
  await conn.query('INSERT INTO document_types (code, name, group_id, description, created_by) VALUES (?, ?, ?, ?, ?)',
    [code, name, groupId, description ?? null, createdBy]);
}

// Sửa tên / mô tả loại
export async function updateType(conn, id, { name, description }) {
  await conn.query('UPDATE document_types SET name = ?, description = ? WHERE id = ?', [name, description, id]);
}

// Đổi trạng thái loại
export async function setTypeStatus(conn, id, status) {
  await conn.query('UPDATE document_types SET status = ? WHERE id = ?', [status, id]);
}
