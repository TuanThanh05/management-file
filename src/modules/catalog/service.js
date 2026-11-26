import { pool } from '../../config/database.js';
import { withTx } from '../../core/tx.js';
import { AppError } from '../../core/errors.js';
import * as repo from './repo.js';

// Dữ liệu nhóm trả về client
function toGroup(r) {
  return {
    code: r.code, name: r.name, description: r.description ?? null, status: r.status,
    typeCount: Number(r.type_count ?? 0), activeLabels: Number(r.active_labels ?? 0), createdAt: r.created_at,
  };
}

// Dữ liệu loại tài liệu trả về client; label = nhãn đang hiệu lực (null nếu chưa gắn)
export function toType(r) {
  const label = r.label_code ? {
    code: r.label_code, versionNo: r.label_version_no, name: r.label_name, retentionType: r.retention_type,
    retentionYears: r.retention_years, startTrigger: r.start_trigger, eventName: r.event_name,
    warningDays: r.warning_days, containsPersonalData: Boolean(Number(r.contains_personal_data)),
  } : null;
  return {
    code: r.code, name: r.name, description: r.description ?? null, status: r.status,
    group: { code: r.group_code, name: r.group_name }, label, usable: r.status === 'ACTIVE' && label !== null, createdAt: r.created_at,
  };
}

// Lấy nhóm đang sử dụng theo mã, không có thì báo lỗi
async function requireActiveGroup(conn, code) {
  const g = await repo.findGroup(conn, code);
  if (!g || g.status !== 'ACTIVE') {
    throw AppError.unprocessable('Nhóm hồ sơ không tồn tại hoặc đã ngừng sử dụng', [{ field: 'groupCode', message: `Không có nhóm đang sử dụng mã ${code}` }]);
  }
  return g;
}

// ---------- Nhóm hồ sơ (5.3 chức năng 4, BM14) ----------

// Danh sách nhóm hồ sơ
export async function listGroups() {
  return (await repo.listGroups()).map(toGroup);
}

// Thêm nhóm: mã duy nhất, không sửa được
export async function createGroup(actor, { code, name, description }) {
  return withTx(actor, async ({ conn, audit }) => {
    await repo.insertGroup(conn, { code, name, description, createdBy: actor.userId });
    await audit({ action: 'GROUP_CREATE', objectType: 'RECORD_GROUP', objectCode: code, details: { name, description: description ?? null } });
    return { code, name, description: description ?? null, status: 'ACTIVE' };
  });
}

// Sửa tên / mô tả nhóm
export async function updateGroup(actor, code, changes) {
  return withTx(actor, async ({ conn, audit }) => {
    const g = await repo.findGroup(conn, code, { forUpdate: true });
    if (!g) throw AppError.notFound('Không tìm thấy nhóm hồ sơ');
    const name = changes.name ?? g.name;
    const description = changes.description !== undefined ? changes.description : g.description;
    await repo.updateGroup(conn, g.id, { name, description });
    await audit({ action: 'GROUP_UPDATE', objectType: 'RECORD_GROUP', objectCode: code,
      details: { before: { name: g.name, description: g.description }, after: { name, description } } });
    return { code, name, description, status: g.status };
  });
}

// Ngừng sử dụng nhóm: chỉ khi không còn nhãn nào đang hiệu lực
export async function deactivateGroup(actor, code) {
  return withTx(actor, async ({ conn, audit }) => {
    const g = await repo.findGroup(conn, code, { forUpdate: true });
    if (!g) throw AppError.notFound('Không tìm thấy nhóm hồ sơ');
    if (g.status === 'INACTIVE') throw AppError.conflict('Nhóm hồ sơ đã ngừng sử dụng');
    const n = await repo.countActiveLabelsInGroup(conn, g.id);
    if (n > 0) throw AppError.conflict(`Nhóm còn ${n} nhãn đang hiệu lực`, { activeLabels: n });
    await repo.setGroupStatus(conn, g.id, 'INACTIVE');
    await audit({ action: 'GROUP_DEACTIVATE', objectType: 'RECORD_GROUP', objectCode: code });
    return { code, status: 'INACTIVE' };
  });
}

// Mở lại nhóm đã ngừng sử dụng
export async function activateGroup(actor, code) {
  return withTx(actor, async ({ conn, audit }) => {
    const g = await repo.findGroup(conn, code, { forUpdate: true });
    if (!g) throw AppError.notFound('Không tìm thấy nhóm hồ sơ');
    if (g.status === 'ACTIVE') throw AppError.conflict('Nhóm hồ sơ đang sử dụng');
    await repo.setGroupStatus(conn, g.id, 'ACTIVE');
    await audit({ action: 'GROUP_ACTIVATE', objectType: 'RECORD_GROUP', objectCode: code });
    return { code, status: 'ACTIVE' };
  });
}

// ---------- Loại tài liệu (5.3 chức năng 5, BM15) ----------

// Danh sách loại tài liệu
export async function listTypes(query) {
  return (await repo.listTypes(query)).map(toType);
}

// Chi tiết loại tài liệu
export async function getType(code) {
  const row = await repo.getType(pool, code);
  if (!row) throw AppError.notFound('Không tìm thấy loại tài liệu');
  return toType(row);
}

// Thêm loại: mã duy nhất, nhóm đang sử dụng; chưa gắn nhãn nên chưa dùng tạo hồ sơ được
export async function createType(actor, { code, name, groupCode, description }) {
  return withTx(actor, async ({ conn, audit }) => {
    const g = await requireActiveGroup(conn, groupCode);
    await repo.insertType(conn, { code, name, groupId: g.id, description, createdBy: actor.userId });
    await audit({ action: 'DOCTYPE_CREATE', objectType: 'DOCUMENT_TYPE', objectCode: code, details: { name, group: g.code } });
    return toType(await repo.getType(conn, code));
  });
}

// Sửa tên / mô tả loại
export async function updateType(actor, code, changes) {
  return withTx(actor, async ({ conn, audit }) => {
    const t = await repo.findType(conn, code, { forUpdate: true });
    if (!t) throw AppError.notFound('Không tìm thấy loại tài liệu');
    const name = changes.name ?? t.name;
    const description = changes.description !== undefined ? changes.description : t.description;
    await repo.updateType(conn, t.id, { name, description });
    await audit({ action: 'DOCTYPE_UPDATE', objectType: 'DOCUMENT_TYPE', objectCode: code,
      details: { before: { name: t.name, description: t.description }, after: { name, description } } });
    return toType(await repo.getType(conn, code));
  });
}

// Ngừng sử dụng loại: không chọn được khi tạo hồ sơ mới, hồ sơ cũ giữ nguyên
export async function deactivateType(actor, code) {
  return withTx(actor, async ({ conn, audit }) => {
    const t = await repo.findType(conn, code, { forUpdate: true });
    if (!t) throw AppError.notFound('Không tìm thấy loại tài liệu');
    if (t.status === 'INACTIVE') throw AppError.conflict('Loại tài liệu đã ngừng sử dụng');
    await repo.setTypeStatus(conn, t.id, 'INACTIVE');
    await audit({ action: 'DOCTYPE_DEACTIVATE', objectType: 'DOCUMENT_TYPE', objectCode: code });
    return toType(await repo.getType(conn, code));
  });
}

// Mở lại loại đã ngừng; nhóm của loại phải đang sử dụng
export async function activateType(actor, code) {
  return withTx(actor, async ({ conn, audit }) => {
    const t = await repo.findType(conn, code, { forUpdate: true });
    if (!t) throw AppError.notFound('Không tìm thấy loại tài liệu');
    if (t.status === 'ACTIVE') throw AppError.conflict('Loại tài liệu đang sử dụng');
    const [[g]] = await conn.query('SELECT code, status FROM record_groups WHERE id = ?', [t.group_id]);
    if (g.status !== 'ACTIVE') throw AppError.conflict(`Nhóm ${g.code} đã ngừng sử dụng; mở lại nhóm trước`);
    await repo.setTypeStatus(conn, t.id, 'ACTIVE');
    await audit({ action: 'DOCTYPE_ACTIVATE', objectType: 'DOCUMENT_TYPE', objectCode: code });
    return toType(await repo.getType(conn, code));
  });
}
