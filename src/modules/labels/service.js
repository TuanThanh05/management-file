import { pool } from '../../config/database.js';
import { withTx } from '../../core/tx.js';
import { AppError } from '../../core/errors.js';
import { notifyRole, notifyUsers } from '../../core/notify.js';
import * as repo from './repo.js';

const DEFAULT_WARNING_DAYS = 30;
const parseJson = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const versionCode = (labelCode, no) => `${labelCode}/v${no}`;
const sameId = (a, b) => String(a) === String(b);

// Tên hiển thị các trường khi so sánh phiên bản
const FIELD_LABELS = {
  labelName: 'Tên nhãn', retentionType: 'Kiểu thời hạn', retentionYears: 'Thời hạn T (năm)', startTrigger: 'Mốc tính',
  eventName: 'Tên sự kiện', warningDays: 'Số ngày cảnh báo N', containsPersonalData: 'Có chứa dữ liệu cá nhân',
  legalBasis: 'Căn cứ pháp lý', documentTypes: 'Loại tài liệu áp dụng',
};

// Dữ liệu phiên bản trả về client
function toVersion(v, types) {
  return {
    id: String(v.id), labelCode: v.label_code, groupCode: v.group_code, versionNo: v.version_no, proposalType: v.proposal_type,
    status: v.status, labelName: v.label_name, retentionType: v.retention_type, retentionYears: v.retention_years,
    startTrigger: v.start_trigger, eventName: v.event_name, warningDays: v.warning_days,
    containsPersonalData: Boolean(Number(v.contains_personal_data)), legalBasis: v.legal_basis, proposalReason: v.proposal_reason,
    documentTypes: types ?? parseJson(v.document_types) ?? [],
    createdBy: v.created_by_email, createdAt: v.created_at, submittedAt: v.submitted_at,
    reviewedBy: v.reviewed_by_email ?? null, reviewedAt: v.reviewed_at, reviewComment: v.review_comment,
    effectiveAt: v.effective_at, retiredAt: v.retired_at,
    ...(v.record_count !== undefined ? { recordCount: Number(v.record_count) } : {}),
  };
}

// Chuẩn hóa luật lưu trữ: Vĩnh viễn thì bỏ T/mốc/N; có thời hạn thì N mặc định 30; không theo sự kiện thì bỏ tên sự kiện
function normalizeRules(d) {
  if (d.retentionType === 'PERMANENT') return { ...d, retentionYears: null, startTrigger: null, eventName: null, warningDays: null };
  return {
    ...d,
    warningDays: d.warningDays ?? DEFAULT_WARNING_DAYS,
    eventName: d.startTrigger === 'EVENT_END' ? (d.eventName?.trim() || null) : null,
  };
}

// Kiểm tra ràng buộc liên trường của BM02 phần B; trả về danh sách lỗi
export function checkRules(d) {
  const e = [];
  if (d.retentionType === 'FIXED') {
    if (!Number.isInteger(d.retentionYears) || d.retentionYears < 1 || d.retentionYears > 100) {
      e.push({ field: 'retentionYears', message: 'Thời hạn T là số nguyên từ 1 đến 100 năm' });
    }
    if (!d.startTrigger) e.push({ field: 'startTrigger', message: 'Có thời hạn thì bắt buộc chọn mốc tính' });
    if (!Number.isInteger(d.warningDays) || d.warningDays < 1 || d.warningDays > 365) {
      e.push({ field: 'warningDays', message: 'Số ngày cảnh báo N từ 1 đến 365' });
    }
    if (d.startTrigger === 'EVENT_END' && !d.eventName) e.push({ field: 'eventName', message: 'Mốc tính Kết thúc sự kiện thì bắt buộc nhập tên sự kiện' });
  }
  return e;
}

// Kiểm tra danh sách loại tài liệu: tồn tại, đang sử dụng, cùng nhóm nhãn, không nằm trong đề xuất khác chưa xử lý
async function checkTypes(conn, codes, groupId, excludeVersionId) {
  if (!codes.length) throw AppError.unprocessable('Đề xuất phải có ít nhất 1 loại tài liệu', [{ field: 'documentTypeCodes', message: 'Chọn ít nhất 1 loại tài liệu' }]);
  const rows = await repo.findTypesByCodes(conn, codes);
  const errors = [];
  for (const c of codes) {
    const t = rows.find((r) => r.code === c);
    if (!t) errors.push({ field: 'documentTypeCodes', message: `Không có loại tài liệu ${c}` });
    else if (t.status !== 'ACTIVE') errors.push({ field: 'documentTypeCodes', message: `Loại ${c} đã ngừng sử dụng` });
    else if (!sameId(t.group_id, groupId)) errors.push({ field: 'documentTypeCodes', message: `Loại ${c} không cùng nhóm với nhãn` });
  }
  if (errors.length) throw AppError.unprocessable('Loại tài liệu áp dụng không hợp lệ', errors);
  const busy = await repo.typesInOtherOpenProposals(conn, rows.map((r) => r.id), excludeVersionId);
  if (busy.length) {
    throw AppError.conflict('Loại tài liệu đang nằm trong đề xuất khác chưa xử lý',
      busy.map((b) => ({ documentType: b.code, label: b.label_code })));
  }
  return rows;
}

// Kiểm tra lại toàn bộ ràng buộc của đề xuất trước khi gửi / phê duyệt (5.3 CN7, 5.4 CN5)
async function revalidate(conn, v) {
  if (v.group_status !== 'ACTIVE' && v.proposal_type !== 'DEACTIVATE') throw AppError.conflict(`Nhóm ${v.group_code} đã ngừng sử dụng`);
  if (v.proposal_type === 'DEACTIVATE') {
    const active = await repo.getActiveVersion(conn, v.label_id);
    if (!active) throw AppError.conflict('Nhãn không còn phiên bản hiệu lực để ngừng áp dụng');
    const n = await repo.countTypesInUse(conn, active.id);
    if (n > 0) throw AppError.conflict(`Nhãn còn gắn với ${n} loại tài liệu đang sử dụng`, { typesInUse: n });
    return [];
  }
  const rules = normalizeRules(fromRow(v));
  const ruleErrors = checkRules(rules);
  if (ruleErrors.length) throw AppError.unprocessable('Luật lưu trữ không hợp lệ', ruleErrors);
  const types = await repo.getVersionTypes(conn, v.id);
  await checkTypes(conn, types.map((t) => t.code), v.group_id, v.id);
  return types;
}

// Đọc các trường luật từ dòng label_versions
function fromRow(v) {
  return {
    labelName: v.label_name, retentionType: v.retention_type, retentionYears: v.retention_years, startTrigger: v.start_trigger,
    eventName: v.event_name, warningDays: v.warning_days, containsPersonalData: Boolean(Number(v.contains_personal_data)),
    legalBasis: v.legal_basis, proposalReason: v.proposal_reason,
  };
}

// Chỉ người lập đề xuất được sửa / gửi / rút
function requireCreator(actor, v) {
  if (!sameId(actor.userId, v.created_by)) throw new AppError(403, 'NOT_PROPOSAL_OWNER', 'Chỉ người lập đề xuất được thực hiện thao tác này');
}

// ---------- Lập, sửa, gửi, rút đề xuất (5.3 chức năng 6–8, BM02) ----------

// Lập đề xuất Tạo mới / Sửa / Ngừng áp dụng; lưu thành phiên bản Nháp
export async function createProposal(actor, body) {
  return withTx(actor, async ({ conn, audit }) => {
    let label = await repo.findLabel(conn, body.labelCode, { forUpdate: true });
    let rules;
    let typeRows = [];

    if (body.proposalType === 'CREATE') {
      if (label) throw AppError.conflict(`Mã nhãn ${body.labelCode} đã tồn tại`);
      const [[g]] = await conn.query('SELECT id, status FROM record_groups WHERE code = ?', [body.groupCode]);
      if (!g || g.status !== 'ACTIVE') throw AppError.unprocessable('Nhóm hồ sơ không tồn tại hoặc đã ngừng sử dụng', [{ field: 'groupCode', message: `Không có nhóm đang sử dụng mã ${body.groupCode}` }]);
      rules = normalizeRules(body);
      const ruleErrors = checkRules(rules);
      if (ruleErrors.length) throw AppError.unprocessable('Luật lưu trữ không hợp lệ', ruleErrors);
      typeRows = await checkTypes(conn, body.documentTypeCodes, g.id, null);
      const id = await repo.insertLabel(conn, { code: body.labelCode, name: body.labelName, groupId: g.id, createdBy: actor.userId });
      label = { id, code: body.labelCode, group_id: g.id };
    } else {
      if (!label) throw AppError.notFound('Không tìm thấy nhãn');
      const open = await repo.getOpenVersion(conn, label.id);
      if (open) throw AppError.conflict(`Nhãn đang có đề xuất phiên bản ${open.version_no} chưa xử lý`);
      const active = await repo.getActiveVersion(conn, label.id);
      if (!active) throw AppError.conflict('Nhãn chưa có phiên bản hiệu lực');
      if (body.proposalType === 'UPDATE') {
        rules = normalizeRules(body);
        const ruleErrors = checkRules(rules);
        if (ruleErrors.length) throw AppError.unprocessable('Luật lưu trữ không hợp lệ', ruleErrors);
        typeRows = await checkTypes(conn, body.documentTypeCodes, label.group_id, null);
      } else {
        const n = await repo.countTypesInUse(conn, active.id);
        if (n > 0) throw AppError.conflict(`Chỉ ngừng áp dụng khi nhãn không còn gắn với loại tài liệu đang sử dụng (còn ${n})`, { typesInUse: n });
        rules = { ...fromRow(active), legalBasis: body.legalBasis ?? active.legal_basis, proposalReason: body.proposalReason };
      }
    }

    const versionNo = await repo.nextVersionNo(conn, label.id);
    const id = await repo.insertVersion(conn, {
      ...rules, labelId: label.id, versionNo, proposalType: body.proposalType, createdBy: actor.userId,
    });
    await repo.addVersionTypes(conn, id, typeRows.map((t) => t.id));
    await audit({ action: 'LABEL_PROPOSAL_CREATE', objectType: 'LABEL', objectCode: versionCode(body.labelCode, versionNo),
      details: { proposalType: body.proposalType, documentTypes: typeRows.map((t) => t.code) } });
    return getVersionDetail(conn, id);
  });
}

// Sửa đề xuất ở Nháp hoặc Bị từ chối (Bị từ chối chuyển về Nháp); thay được cả danh sách loại tài liệu
export async function updateProposal(actor, id, changes) {
  return withTx(actor, async ({ conn, audit }) => {
    const v = await repo.getVersion(conn, id, { forUpdate: true });
    if (!v) throw AppError.notFound('Không tìm thấy đề xuất');
    requireCreator(actor, v);
    if (!['DRAFT', 'REJECTED'].includes(v.status)) throw AppError.conflict('Chỉ sửa được đề xuất ở Nháp hoặc Bị từ chối');
    if (v.proposal_type === 'DEACTIVATE') {
      const extra = Object.keys(changes).filter((k) => !['legalBasis', 'proposalReason'].includes(k));
      if (extra.length) throw AppError.unprocessable('Đề xuất ngừng áp dụng chỉ sửa được căn cứ và lý do', extra.map((f) => ({ field: f, message: 'Không sửa được' })));
    }
    if (v.status === 'REJECTED') await repo.setVersionStatus(conn, id, 'DRAFT');

    const { documentTypeCodes, ...ruleChanges } = changes;
    const merged = normalizeRules({ ...fromRow(v), ...ruleChanges });
    const ruleErrors = checkRules(merged);
    if (ruleErrors.length) throw AppError.unprocessable('Luật lưu trữ không hợp lệ', ruleErrors);
    await repo.updateVersionFields(conn, id, merged);

    let typeChange = null;
    if (documentTypeCodes && v.proposal_type !== 'DEACTIVATE') {
      const current = await repo.getVersionTypes(conn, id);
      const wanted = await checkTypes(conn, documentTypeCodes, v.group_id, id);
      const add = wanted.filter((w) => !current.some((c) => sameId(c.id, w.id)));
      const remove = current.filter((c) => !wanted.some((w) => sameId(c.id, w.id)));
      await repo.removeVersionTypes(conn, id, remove.map((t) => t.id));
      await repo.addVersionTypes(conn, id, add.map((t) => t.id));
      typeChange = { added: add.map((t) => t.code), removed: remove.map((t) => t.code) };
    }
    await audit({ action: 'LABEL_PROPOSAL_UPDATE', objectType: 'LABEL', objectCode: versionCode(v.label_code, v.version_no),
      details: { fromStatus: v.status, before: fromRow(v), after: merged, documentTypes: typeChange } });
    return getVersionDetail(conn, id);
  });
}

// Gửi đề xuất cho Giám đốc: kiểm tra lại ràng buộc, Nháp sang Chờ duyệt, báo Giám đốc
export async function submitProposal(actor, id) {
  return withTx(actor, async ({ conn, audit }) => {
    const v = await repo.getVersion(conn, id, { forUpdate: true });
    if (!v) throw AppError.notFound('Không tìm thấy đề xuất');
    requireCreator(actor, v);
    if (v.status !== 'DRAFT') throw AppError.conflict('Chỉ gửi được đề xuất ở Nháp');
    await revalidate(conn, v);
    await repo.setVersionStatus(conn, id, 'PENDING', { submitted_at: 'NOW' });
    const code = versionCode(v.label_code, v.version_no);
    await audit({ action: 'LABEL_PROPOSAL_SUBMIT', objectType: 'LABEL', objectCode: code });
    await notifyRole(conn, 'DIRECTOR', { type: 'ACTION_REQUIRED', objectType: 'LABEL', objectCode: code,
      message: `Đề xuất nhãn ${code} chờ phê duyệt` });
    return getVersionDetail(conn, id);
  });
}

// Rút đề xuất: Chờ duyệt về Nháp, báo Giám đốc
export async function withdrawProposal(actor, id) {
  return withTx(actor, async ({ conn, audit }) => {
    const v = await repo.getVersion(conn, id, { forUpdate: true });
    if (!v) throw AppError.notFound('Không tìm thấy đề xuất');
    requireCreator(actor, v);
    if (v.status !== 'PENDING') throw AppError.conflict('Chỉ rút được đề xuất đang Chờ duyệt');
    await repo.setVersionStatus(conn, id, 'DRAFT');
    const code = versionCode(v.label_code, v.version_no);
    await audit({ action: 'LABEL_PROPOSAL_WITHDRAW', objectType: 'LABEL', objectCode: code });
    await notifyRole(conn, 'DIRECTOR', { type: 'WITHDRAWN', objectType: 'LABEL', objectCode: code, message: `Đề xuất nhãn ${code} đã được rút lại` });
    return getVersionDetail(conn, id);
  });
}

// ---------- So sánh, cảnh báo rút ngắn (5.4 chức năng 4) ----------

// a có thời hạn dài hơn b không (Vĩnh viễn dài nhất)
function isLonger(a, b) {
  if (a.retention_type === 'PERMANENT') return b.retention_type === 'FIXED';
  return b.retention_type === 'FIXED' && a.retention_years > b.retention_years;
}

// So sánh từng trường giữa hai phiên bản; trả về các trường khác nhau (giá trị cũ, mới)
export function diffVersions(oldV, oldTypes, newV, newTypes) {
  const a = { ...fromRow(oldV), documentTypes: oldTypes };
  const b = { ...fromRow(newV), documentTypes: newTypes };
  const out = [];
  for (const f of Object.keys(FIELD_LABELS)) {
    const same = f === 'documentTypes' ? [...a[f]].sort().join() === [...b[f]].sort().join() : (a[f] ?? null) === (b[f] ?? null);
    if (!same) out.push({ field: f, label: FIELD_LABELS[f], old: a[f] ?? null, new: b[f] ?? null });
  }
  return out;
}

// Cảnh báo "Rút ngắn thời hạn" kèm số hồ sơ đang lưu trữ bị ảnh hưởng
async function shorteningWarnings(conn, v, typeRows, active) {
  const warnings = [];
  if (v.proposal_type === 'DEACTIVATE') return warnings;
  const typeIds = typeRows.map((t) => t.id);
  if (active && v.proposal_type === 'UPDATE') {
    if (isLonger(active, v)) {
      warnings.push({ code: 'SHORTENED_PERIOD', message: 'Rút ngắn thời hạn: thời hạn mới ngắn hơn phiên bản đang hiệu lực',
        old: active.retention_type === 'PERMANENT' ? 'Vĩnh viễn' : `${active.retention_years} năm`,
        new: v.retention_type === 'PERMANENT' ? 'Vĩnh viễn' : `${v.retention_years} năm`,
        affectedRecords: await repo.countStoredRecordsOfTypes(conn, typeIds) });
    }
    if (active.retention_type === 'FIXED' && v.retention_type === 'FIXED' && active.start_trigger !== v.start_trigger) {
      warnings.push({ code: 'START_TRIGGER_CHANGED', message: 'Rút ngắn thời hạn: mốc tính thay đổi',
        old: active.start_trigger, new: v.start_trigger, affectedRecords: await repo.countStoredRecordsOfTypes(conn, typeIds) });
    }
  }
  const moved = (await repo.currentVersionsOfTypes(conn, typeIds)).filter((c) => !sameId(c.label_id, v.label_id) && isLonger(c, v));
  if (moved.length) {
    warnings.push({ code: 'TYPE_MOVED_FROM_LONGER', message: 'Rút ngắn thời hạn: loại tài liệu được chuyển từ nhãn có thời hạn dài hơn',
      types: moved.map((m) => ({ documentType: m.type_code, fromLabel: m.label_code,
        fromPeriod: m.retention_type === 'PERMANENT' ? 'Vĩnh viễn' : `${m.retention_years} năm` })),
      affectedRecords: await repo.countStoredRecordsOfTypes(conn, moved.map((m) => m.type_id)) });
  }
  return warnings;
}

// Chi tiết một phiên bản; nếu là đề xuất thì kèm so sánh với bản đang hiệu lực và cảnh báo
async function getVersionDetail(conn, id) {
  const v = await repo.getVersion(conn, id);
  if (!v) throw AppError.notFound('Không tìm thấy phiên bản nhãn');
  const types = await repo.getVersionTypes(conn, id);
  const detail = toVersion(v, types.map((t) => t.code));
  if (['DRAFT', 'PENDING', 'REJECTED'].includes(v.status)) {
    const active = await repo.getActiveVersion(conn, v.label_id);
    const activeTypes = active ? (await repo.getVersionTypes(conn, active.id)).map((t) => t.code) : [];
    detail.comparison = active ? { againstVersionNo: active.version_no, changes: diffVersions(active, activeTypes, v, detail.documentTypes) } : null;
    detail.warnings = await shorteningWarnings(conn, v, types, active);
  }
  return detail;
}

// Xem chi tiết phiên bản / đề xuất
export function getVersion(id) {
  return getVersionDetail(pool, id);
}

// ---------- Phê duyệt / từ chối (5.4 chức năng 5–6) ----------

// Phê duyệt: bản mới Đang hiệu lực, bản cũ Ngừng áp dụng, gắn loại tài liệu theo bản mới; loại bị bỏ ra thì mất nhãn
export async function approveProposal(actor, id) {
  return withTx(actor, async ({ conn, audit }) => {
    const v = await repo.getVersion(conn, id, { forUpdate: true });
    if (!v) throw AppError.notFound('Không tìm thấy đề xuất');
    if (v.status !== 'PENDING') throw AppError.conflict('Chỉ phê duyệt được đề xuất đang Chờ duyệt');
    if (sameId(actor.userId, v.created_by)) throw new AppError(403, 'SEPARATION_OF_DUTIES', 'Người duyệt phải khác người lập đề xuất');
    await repo.findLabel(conn, v.label_code, { forUpdate: true });
    const types = await revalidate(conn, v);
    const active = await repo.getActiveVersion(conn, v.label_id);
    const warnings = (await shorteningWarnings(conn, v, types, active)).map((w) => w.code);

    let detached = [];
    if (active) {
      await repo.setVersionStatus(conn, active.id, 'RETIRED', { retired_at: 'NOW' });
      detached = await repo.detachTypesFromVersion(conn, active.id);
    }
    if (v.proposal_type === 'DEACTIVATE') {
      await repo.setVersionStatus(conn, id, 'RETIRED', { reviewed_by: actor.userId, reviewed_at: 'NOW', effective_at: 'NOW', retired_at: 'NOW' });
    } else {
      await repo.setVersionStatus(conn, id, 'ACTIVE', { reviewed_by: actor.userId, reviewed_at: 'NOW', effective_at: 'NOW' });
      await repo.pointTypesToVersion(conn, types.map((t) => t.id), id);
      await repo.renameLabel(conn, v.label_id, v.label_name);
    }
    const dropped = detached.filter((c) => !types.some((t) => t.code === c));
    const code = versionCode(v.label_code, v.version_no);
    await audit({ action: 'LABEL_APPROVE', objectType: 'LABEL', objectCode: code,
      details: { proposalType: v.proposal_type, retiredVersionNo: active?.version_no ?? null,
        documentTypes: types.map((t) => t.code), typesWithoutLabel: dropped, warnings } });
    await notifyUsers(conn, [v.created_by], { type: 'REVIEW_RESULT', objectType: 'LABEL', objectCode: code,
      message: `Đề xuất nhãn ${code} đã được phê duyệt` });
    return { ...(await getVersionDetail(conn, id)), typesWithoutLabel: dropped };
  });
}

// Từ chối: bắt buộc lý do; bản đang hiệu lực không đổi; báo lý do cho người lập
export async function rejectProposal(actor, id, { comment }) {
  return withTx(actor, async ({ conn, audit }) => {
    const v = await repo.getVersion(conn, id, { forUpdate: true });
    if (!v) throw AppError.notFound('Không tìm thấy đề xuất');
    if (v.status !== 'PENDING') throw AppError.conflict('Chỉ từ chối được đề xuất đang Chờ duyệt');
    if (sameId(actor.userId, v.created_by)) throw new AppError(403, 'SEPARATION_OF_DUTIES', 'Người duyệt phải khác người lập đề xuất');
    await repo.setVersionStatus(conn, id, 'REJECTED', { reviewed_by: actor.userId, reviewed_at: 'NOW', review_comment: comment });
    const code = versionCode(v.label_code, v.version_no);
    await audit({ action: 'LABEL_REJECT', objectType: 'LABEL', objectCode: code, details: { comment } });
    await notifyUsers(conn, [v.created_by], { type: 'REVIEW_RESULT', objectType: 'LABEL', objectCode: code,
      message: `Đề xuất nhãn ${code} bị từ chối: ${comment}` });
    return getVersionDetail(conn, id);
  });
}

// ---------- Tra cứu nhãn và lịch sử (5.3 chức năng 9) ----------

// Danh sách nhãn kèm phiên bản đang hiệu lực và loại tài liệu đang gắn
export async function listLabels() {
  return (await repo.listLabels()).map((r) => ({
    code: r.code, name: r.name, group: { code: r.group_code, name: r.group_name },
    active: r.active_id ? {
      versionNo: r.active_no, retentionType: r.retention_type, retentionYears: r.retention_years, startTrigger: r.start_trigger,
      eventName: r.event_name, warningDays: r.warning_days, containsPersonalData: Boolean(Number(r.contains_personal_data)),
      effectiveAt: r.effective_at,
    } : null,
    documentTypes: parseJson(r.document_types) ?? [],
    openProposal: r.open_id ? { id: String(r.open_id), versionNo: r.open_no, status: r.open_status, proposalType: r.open_type } : null,
  }));
}

// Nhãn kèm toàn bộ phiên bản (kể cả bản cũ) và số hồ sơ đang gắn với từng phiên bản
export async function getLabelHistory(code) {
  const label = await repo.findLabel(pool, code);
  if (!label) throw AppError.notFound('Không tìm thấy nhãn');
  const versions = await repo.listVersionsOfLabel(label.id);
  return { code: label.code, name: label.name, versions: versions.map((v) => toVersion(v)) };
}

// So sánh hai phiên bản bất kỳ của một nhãn theo từng trường
export async function compareVersions(code, { from, to }) {
  const label = await repo.findLabel(pool, code);
  if (!label) throw AppError.notFound('Không tìm thấy nhãn');
  const a = await repo.getVersionByNo(pool, label.id, from);
  const b = await repo.getVersionByNo(pool, label.id, to);
  if (!a || !b) throw AppError.notFound('Không tìm thấy phiên bản cần so sánh');
  const aTypes = (await repo.getVersionTypes(pool, a.id)).map((t) => t.code);
  const bTypes = (await repo.getVersionTypes(pool, b.id)).map((t) => t.code);
  return { labelCode: code, from, to, changes: diffVersions(a, aTypes, b, bTypes) };
}

// Danh sách đề xuất / phiên bản theo trạng thái
export async function listProposals({ status }) {
  return (await repo.listVersionsByStatus(status)).map((v) => toVersion(v, undefined));
}
