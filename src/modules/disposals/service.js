import { pool } from '../../config/database.js';
import { withTx } from '../../core/tx.js';
import { AppError } from '../../core/errors.js';
import { nextCode } from '../../core/codes.js';
import { formatDateVN } from '../../core/time.js';
import { getSettings } from '../../core/settings.js';
import { notifyUsers, notifyRole, notifyDepartmentHead } from '../../core/notify.js';
import * as repo from './repo.js';

const PAGE_SIZE = 20;
const flag = (v) => Boolean(Number(v));
const sameId = (a, b) => String(a) === String(b);
const parseJson = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const DRAFT_REMOVE_REASON = 'Bỏ khỏi đợt khi lập nháp';
// Về Nháp thì xóa kết quả duyệt cũ: gửi lại phải duyệt lại từ cấp 1
const RESET_APPROVALS = { level1_approver_id: null, level1_approved_at: null, level1_comment: null,
  level2_approver_id: null, level2_approved_at: null, level2_comment: null, scheduled_at: null };

// Dạng gọn của đợt cho danh sách
function summary(b) {
  return {
    code: b.code, status: b.status, department: b.department_code, reason: b.reason, recordCount: Number(b.included_count),
    createdBy: b.created_by_email, createdAt: b.created_at, submittedAt: b.submitted_at, scheduledAt: b.scheduled_at,
    lastReturnReason: b.last_return_reason,
  };
}

// Chi tiết đợt (BM05, BM12): danh mục hồ sơ, hồ sơ bị loại / rút kèm lý do, lịch sử xét duyệt
async function detail(conn, code) {
  const b = await repo.findBatch(conn, code);
  const items = await repo.batchItems(conn, b.id);
  const history = await repo.batchHistory(conn, code);
  const item = (x) => ({
    code: x.code, title: x.title, recordStatus: x.record_status, documentType: { code: x.type_code, name: x.type_name },
    label: { code: x.label_code, versionNo: x.version_no }, documentDate: x.document_date, expiryDate: x.expiry_date,
    isOnHold: flag(x.is_on_hold), itemStatus: x.item_status, exclusionRequested: flag(x.exclusion_requested), reason: x.exclusion_reason,
  });
  return {
    ...summary(b), departmentName: b.department_name, cancelReason: b.cancel_reason,
    level1: b.level1_approver_id ? { approver: b.level1_email, approvedAt: b.level1_approved_at, comment: b.level1_comment } : null,
    level2: b.level2_approver_id ? { approver: b.level2_email, approvedAt: b.level2_approved_at, comment: b.level2_comment } : null,
    startedAt: b.started_at, completedAt: b.completed_at,
    records: items.filter((x) => x.item_status === 'INCLUDED' || x.item_status === 'DISPOSED').map(item),
    removed: items.filter((x) => x.item_status === 'EXCLUDED' || x.item_status === 'WITHDRAWN').map(item),
    history: history.map((h) => ({ seq: Number(h.seq), at: h.occurred_at, action: h.action, result: h.result, by: h.actor_email, details: parseJson(h.details) })),
  };
}

// Xem được đợt: phạm vi ALL hoặc cùng phòng ban
function requireVisible(user, scope, b) {
  if (!b || !(scope === 'ALL' || sameId(b.department_id, user.departmentId))) throw AppError.notFound('Không tìm thấy đợt hủy');
}

// Khóa đợt của Cán bộ lưu trữ đã lập, đang Nháp (5.3 CN14, CN15)
async function lockOwnDraft(conn, user, code) {
  const b = await repo.findBatch(conn, code, { forUpdate: true });
  if (!b) throw AppError.notFound('Không tìm thấy đợt hủy');
  if (!sameId(b.created_by, user.id)) throw new AppError(403, 'NOT_BATCH_OWNER', 'Chỉ người lập đợt được thao tác');
  if (b.status !== 'DRAFT') throw AppError.conflict('Chỉ thao tác được khi đợt ở trạng thái Nháp');
  return b;
}

// Lý do một hồ sơ không vào được đợt; null = được
function entryProblem(r, departmentId, batchCode) {
  if (!sameId(r.department_id, departmentId)) return 'Hồ sơ không thuộc phòng ban của đợt';
  if (r.status !== 'EXPIRED') return 'Hồ sơ không ở trạng thái Hết hạn';
  if (flag(r.is_on_hold)) return 'Hồ sơ đang bị phong tỏa';
  if (flag(r.pending_extension)) return 'Hồ sơ có đề xuất gia hạn đang chờ duyệt';
  if (!flag(r.is_disposal_eligible)) return 'Hồ sơ chưa có dấu Đủ điều kiện hủy';
  if (r.open_batch && r.open_batch !== batchCode) return `Hồ sơ đang nằm trong đợt ${r.open_batch}`;
  return null;
}

// Khóa và kiểm tra danh sách hồ sơ đưa vào đợt; có hồ sơ sai thì báo lỗi theo từng mã
async function checkEntries(conn, codes, departmentId, batchCode) {
  const rows = await repo.lockCandidates(conn, codes);
  const found = new Map(rows.map((r) => [r.code, r]));
  const problems = codes.map((c) => {
    const r = found.get(c);
    const msg = r ? entryProblem(r, departmentId, batchCode) : 'Không tìm thấy hồ sơ';
    return msg && { field: c, message: msg };
  }).filter(Boolean);
  if (problems.length) throw AppError.unprocessable('Có hồ sơ không hợp lệ; chỉnh sửa lại đợt', problems);
  return rows;
}

// ---------- Cán bộ lưu trữ (5.3 CN13–16) ----------

// Lập đợt hủy Nháp cho một phòng ban (BM05)
export async function createBatch(actor, user, { departmentCode, reason, recordCodes }) {
  const code = await withTx(actor, async ({ conn, audit }) => {
    const [[d]] = await conn.query('SELECT id, code FROM departments WHERE code = ?', [departmentCode]);
    if (!d) throw AppError.unprocessable('Phòng ban không tồn tại', [{ field: 'departmentCode', message: 'Không tìm thấy phòng ban' }]);
    const rows = await checkEntries(conn, recordCodes, d.id, null);
    const c = await nextCode(conn, 'DISPOSAL_BATCH', { departmentCode: d.code });
    const id = await repo.insertBatch(conn, { code: c, departmentId: d.id, reason, createdBy: user.id });
    await repo.includeRecords(conn, id, rows.map((r) => r.id));
    await audit({ action: 'DISPOSAL_BATCH_CREATE', objectType: 'DISPOSAL_BATCH', objectCode: c, details: { department: d.code, records: recordCodes } });
    return c;
  });
  return detail(pool, code);
}

// Sửa đợt Nháp: lý do, thêm / bớt hồ sơ (bớt = rút kèm lý do vì không được xóa dòng)
export async function updateBatch(actor, user, code, { reason, addRecordCodes = [], removeRecordCodes = [], removeReason }) {
  await withTx(actor, async ({ conn, audit }) => {
    const b = await lockOwnDraft(conn, user, code);
    const items = await repo.batchItems(conn, b.id, { forUpdate: true });
    const included = new Map(items.filter((x) => x.item_status === 'INCLUDED').map((x) => [x.code, x]));
    const both = addRecordCodes.filter((c) => removeRecordCodes.includes(c));
    if (both.length) throw AppError.unprocessable('Một hồ sơ vừa thêm vừa bớt', both.map((c) => ({ field: c, message: 'Chọn thêm hoặc bớt' })));
    const missing = removeRecordCodes.filter((c) => !included.has(c));
    if (missing.length) throw AppError.unprocessable('Có hồ sơ không nằm trong đợt', missing.map((c) => ({ field: c, message: 'Hồ sơ không nằm trong đợt' })));
    const toAdd = addRecordCodes.filter((c) => !included.has(c));
    const rows = await checkEntries(conn, toAdd, b.department_id, b.code);
    if (included.size - removeRecordCodes.length + rows.length < 1) throw AppError.conflict('Đợt phải còn ít nhất 1 hồ sơ; muốn bỏ đợt thì dùng Hủy bỏ đợt');
    if (reason) await repo.updateBatch(conn, b.id, { reason });
    await repo.setItemStatus(conn, b.id, removeRecordCodes.map((c) => included.get(c).record_id), 'WITHDRAWN', removeReason ?? DRAFT_REMOVE_REASON);
    await repo.includeRecords(conn, b.id, rows.map((r) => r.id));
    await audit({ action: 'DISPOSAL_BATCH_UPDATE', objectType: 'DISPOSAL_BATCH', objectCode: code,
      details: { reasonChanged: Boolean(reason), added: toAdd, removed: removeRecordCodes, removeReason: removeRecordCodes.length ? removeReason ?? DRAFT_REMOVE_REASON : null } });
  });
  return detail(pool, code);
}

// Hủy bỏ đợt Nháp (trạng thái cuối); hồ sơ giữ Hết hạn và dấu Đủ điều kiện hủy
export async function cancelBatch(actor, user, code, { reason }) {
  await withTx(actor, async ({ conn, audit }) => {
    const b = await lockOwnDraft(conn, user, code);
    const items = await repo.batchItems(conn, b.id, { forUpdate: true });
    await repo.setItemStatus(conn, b.id, items.filter((x) => x.item_status === 'INCLUDED').map((x) => x.record_id), 'WITHDRAWN', `Đợt bị hủy bỏ: ${reason}`.slice(0, 500));
    await repo.updateBatch(conn, b.id, { status: 'CANCELLED', cancel_reason: reason });
    await audit({ action: 'DISPOSAL_BATCH_CANCEL', objectType: 'DISPOSAL_BATCH', objectCode: code, details: { reason } });
  });
  return detail(pool, code);
}

// Gửi đợt duyệt cấp 1: kiểm tra lại từng hồ sơ, hồ sơ sang Chờ duyệt hủy, khóa danh mục, báo Trưởng phòng
export async function submitBatch(actor, user, code) {
  await withTx(actor, async ({ conn, audit }) => {
    const b = await lockOwnDraft(conn, user, code);
    const items = (await repo.batchItems(conn, b.id, { forUpdate: true })).filter((x) => x.item_status === 'INCLUDED');
    if (!items.length) throw AppError.conflict('Đợt chưa có hồ sơ');
    const rows = await checkEntries(conn, items.map((x) => x.code), b.department_id, b.code);
    await repo.setRecordsStatus(conn, rows.map((r) => r.id), 'PENDING_DISPOSAL');
    await repo.updateBatch(conn, b.id, { status: 'PENDING_LEVEL_1', submitted_at: 'NOW' });
    await audit({ action: 'DISPOSAL_BATCH_SUBMIT', objectType: 'DISPOSAL_BATCH', objectCode: code, details: { records: rows.map((r) => r.code) } });
    for (const r of rows) await audit({ action: 'RECORD_DISPOSAL_SUBMIT', objectType: 'RECORD', objectCode: r.code, details: { batch: code } });
    await notifyDepartmentHead(conn, b.department_id, { type: 'ACTION_REQUIRED', objectType: 'DISPOSAL_BATCH', objectCode: code,
      message: `Đợt hủy ${code} (${rows.length} hồ sơ) chờ duyệt cấp 1` });
  });
  return detail(pool, code);
}

// ---------- Trưởng phòng – cấp 1 (5.2 CN12–15) ----------

// Khóa đợt đang Chờ duyệt cấp 1 của phòng mình; người duyệt khác người lập
async function lockLevel1(conn, user, code) {
  const b = await repo.findBatch(conn, code, { forUpdate: true });
  if (!b || !sameId(b.department_id, user.departmentId)) throw AppError.notFound('Không tìm thấy đợt hủy');
  if (!user.roles.includes('DEPARTMENT_HEAD')) throw new AppError(403, 'NOT_DEPARTMENT_HEAD', 'Chỉ Trưởng phòng của phòng ban duyệt cấp 1');
  if (sameId(b.created_by, user.id)) throw new AppError(403, 'SEPARATION_OF_DUTIES', 'Người duyệt phải khác người lập đợt');
  if (b.status !== 'PENDING_LEVEL_1') throw AppError.conflict('Đợt không ở trạng thái Chờ duyệt cấp 1');
  return b;
}

// Đề nghị loại một hồ sơ kèm lý do; có hiệu lực khi đồng ý đợt
export async function requestExclusion(actor, user, code, { recordCode, reason }) {
  await withTx(actor, async ({ conn, audit }) => {
    const b = await lockLevel1(conn, user, code);
    const x = (await repo.batchItems(conn, b.id, { forUpdate: true })).find((i) => i.code === recordCode && i.item_status === 'INCLUDED');
    if (!x) throw AppError.notFound('Hồ sơ không nằm trong đợt');
    await repo.setExclusion(conn, b.id, x.record_id, true, reason);
    await audit({ action: 'DISPOSAL_EXCLUSION_REQUEST', objectType: 'DISPOSAL_BATCH', objectCode: code, details: { record: recordCode, reason } });
  });
  return detail(pool, code);
}

// Bỏ đề nghị loại trước khi đồng ý đợt
export async function removeExclusion(actor, user, code, { recordCode }) {
  await withTx(actor, async ({ conn, audit }) => {
    const b = await lockLevel1(conn, user, code);
    const x = (await repo.batchItems(conn, b.id, { forUpdate: true })).find((i) => i.code === recordCode && i.item_status === 'INCLUDED');
    if (!x || !flag(x.exclusion_requested)) throw AppError.notFound('Hồ sơ chưa được đề nghị loại');
    await repo.setExclusion(conn, b.id, x.record_id, false, null);
    await audit({ action: 'DISPOSAL_EXCLUSION_CANCEL', objectType: 'DISPOSAL_BATCH', objectCode: code, details: { record: recordCode } });
  });
  return detail(pool, code);
}

// Đồng ý đợt (cấp 1): áp dụng việc loại (hồ sơ về Hết hạn, mất dấu hủy), đợt còn ≥ 1 hồ sơ, sang Chờ duyệt cấp 2, báo Giám đốc
export async function approveLevel1(actor, user, code, { comment }) {
  await withTx(actor, async ({ conn, audit }) => {
    const b = await lockLevel1(conn, user, code);
    const items = (await repo.batchItems(conn, b.id, { forUpdate: true })).filter((x) => x.item_status === 'INCLUDED');
    const excluded = items.filter((x) => flag(x.exclusion_requested));
    if (excluded.length === items.length) throw AppError.conflict('Không được loại toàn bộ hồ sơ; không đồng ý hủy hồ sơ nào thì dùng Trả lại');
    for (const x of excluded) await repo.setItemStatus(conn, b.id, [x.record_id], 'EXCLUDED', x.exclusion_reason);
    await repo.setRecordsStatus(conn, excluded.map((x) => x.record_id), 'EXPIRED');
    await repo.clearEligible(conn, excluded.map((x) => x.record_id));
    await repo.updateBatch(conn, b.id, { status: 'PENDING_LEVEL_2', level1_approver_id: user.id, level1_approved_at: 'NOW', level1_comment: comment ?? null });
    await audit({ action: 'DISPOSAL_BATCH_APPROVE_L1', objectType: 'DISPOSAL_BATCH', objectCode: code,
      details: { comment: comment ?? null, excluded: excluded.map((x) => ({ record: x.code, reason: x.exclusion_reason })) } });
    for (const x of excluded) await audit({ action: 'RECORD_DISPOSAL_EXCLUDE', objectType: 'RECORD', objectCode: x.code, details: { batch: code, reason: x.exclusion_reason } });
    await notifyRole(conn, 'DIRECTOR', { type: 'ACTION_REQUIRED', objectType: 'DISPOSAL_BATCH', objectCode: code,
      message: `Đợt hủy ${code} (${items.length - excluded.length} hồ sơ) chờ phê duyệt cấp 2` });
    if (excluded.length) {
      await notifyUsers(conn, [b.created_by], { type: 'REVIEW_RESULT', objectType: 'DISPOSAL_BATCH', objectCode: code,
        message: `Đợt hủy ${code}: Trưởng phòng loại ${excluded.length} hồ sơ (${excluded.map((x) => x.code).join(', ')})` });
    }
  });
  return detail(pool, code);
}

// Đưa đợt về Nháp (trả lại / thu hồi): hồ sơ Chờ duyệt hủy → Hết hạn, xóa kết quả duyệt cũ
async function backToDraft(conn, audit, b, { action, reason, extra = {} }) {
  const items = (await repo.batchItems(conn, b.id, { forUpdate: true })).filter((x) => x.item_status === 'INCLUDED');
  await repo.clearExclusions(conn, b.id);
  await repo.setRecordsStatus(conn, items.filter((x) => x.record_status === 'PENDING_DISPOSAL').map((x) => x.record_id), 'EXPIRED');
  await repo.updateBatch(conn, b.id, { status: 'DRAFT', last_return_reason: reason, ...RESET_APPROVALS, ...extra });
  await audit({ action, objectType: 'DISPOSAL_BATCH', objectCode: b.code, details: { reason, fromStatus: b.status } });
  for (const x of items) await audit({ action: 'RECORD_DISPOSAL_RETURN', objectType: 'RECORD', objectCode: x.code, details: { batch: b.code } });
}

// Trả lại đợt (cấp 1): bắt buộc lý do; đề nghị loại bị bỏ; báo Cán bộ lưu trữ lập đợt
export async function returnLevel1(actor, user, code, { reason }) {
  await withTx(actor, async ({ conn, audit }) => {
    const b = await lockLevel1(conn, user, code);
    await backToDraft(conn, audit, b, { action: 'DISPOSAL_BATCH_RETURN_L1', reason });
    await notifyUsers(conn, [b.created_by], { type: 'REVIEW_RESULT', objectType: 'DISPOSAL_BATCH', objectCode: code,
      message: `Đợt hủy ${code} bị Trưởng phòng trả lại: ${reason}` });
  });
  return detail(pool, code);
}

// ---------- Giám đốc – cấp 2 (5.4 CN7–10) ----------

// Khóa đợt cho Giám đốc ở trạng thái cho trước; người duyệt khác người lập và người duyệt cấp 1
async function lockDirector(conn, user, code, status) {
  const b = await repo.findBatch(conn, code, { forUpdate: true });
  if (!b) throw AppError.notFound('Không tìm thấy đợt hủy');
  if (sameId(b.created_by, user.id) || sameId(b.level1_approver_id, user.id)) {
    throw new AppError(403, 'SEPARATION_OF_DUTIES', 'Người duyệt cấp 2 phải khác người lập đợt và người duyệt cấp 1');
  }
  if (b.status !== status) throw AppError.conflict(status === 'APPROVED' ? 'Chỉ thu hồi được đợt Đã phê duyệt' : 'Đợt không ở trạng thái Chờ duyệt cấp 2');
  return b;
}

// Báo Cán bộ lập đợt và Trưởng phòng của phòng
async function notifyOfficerAndHead(conn, b, payload) {
  await notifyUsers(conn, [b.created_by], payload);
  await notifyDepartmentHead(conn, b.department_id, payload);
}

// Phê duyệt cấp 2: thời điểm hủy dự kiến = lúc duyệt + DISPOSAL_WAIT_DAYS
export async function approveLevel2(actor, user, code, { comment }) {
  await withTx(actor, async ({ conn, audit }) => {
    const b = await lockDirector(conn, user, code, 'PENDING_LEVEL_2');
    const { DISPOSAL_WAIT_DAYS } = await getSettings(conn, ['DISPOSAL_WAIT_DAYS']);
    await conn.query(
      `UPDATE disposal_batches SET status = 'APPROVED', level2_approver_id = ?, level2_approved_at = UTC_TIMESTAMP(3), level2_comment = ?,
         scheduled_at = UTC_TIMESTAMP(3) + INTERVAL ? DAY WHERE id = ?`, [user.id, comment ?? null, DISPOSAL_WAIT_DAYS, b.id]);
    const [[{ scheduled_at: at }]] = await conn.query('SELECT scheduled_at FROM disposal_batches WHERE id = ?', [b.id]);
    await audit({ action: 'DISPOSAL_BATCH_APPROVE_L2', objectType: 'DISPOSAL_BATCH', objectCode: code,
      details: { comment: comment ?? null, scheduledAt: at, waitDays: DISPOSAL_WAIT_DAYS } });
    const vn = new Date(new Date(at).getTime() + 7 * 3600_000).toISOString();
    await notifyOfficerAndHead(conn, b, { type: 'REVIEW_RESULT', objectType: 'DISPOSAL_BATCH', objectCode: code,
      message: `Đợt hủy ${code} đã được phê duyệt; dự kiến thực hiện hủy ${vn.slice(11, 16)} ngày ${formatDateVN(vn.slice(0, 10))}` });
  });
  return detail(pool, code);
}

// Trả lại đợt (cấp 2): về Nháp, phải duyệt lại từ cấp 1
export async function returnLevel2(actor, user, code, { reason }) {
  await withTx(actor, async ({ conn, audit }) => {
    const b = await lockDirector(conn, user, code, 'PENDING_LEVEL_2');
    await backToDraft(conn, audit, b, { action: 'DISPOSAL_BATCH_RETURN_L2', reason });
    await notifyOfficerAndHead(conn, b, { type: 'REVIEW_RESULT', objectType: 'DISPOSAL_BATCH', objectCode: code,
      message: `Đợt hủy ${code} bị Giám đốc trả lại: ${reason}` });
  });
  return detail(pool, code);
}

// Thu hồi quyết định hủy (BM17): chỉ khi hệ thống chưa bắt đầu hủy
export async function revokeBatch(actor, user, code, { reason }) {
  await withTx(actor, async ({ conn, audit }) => {
    const b = await lockDirector(conn, user, code, 'APPROVED');
    if (b.started_at) throw AppError.conflict('Hệ thống đã bắt đầu thực hiện hủy; không thu hồi được');
    await backToDraft(conn, audit, b, { action: 'DISPOSAL_BATCH_REVOKE', reason });
    await notifyOfficerAndHead(conn, b, { type: 'REVIEW_RESULT', objectType: 'DISPOSAL_BATCH', objectCode: code,
      message: `Giám đốc thu hồi quyết định hủy đợt ${code}: ${reason}` });
  });
  return detail(pool, code);
}

// ---------- Xem ----------

// Theo dõi đợt hủy theo phạm vi (Trưởng phòng: phòng mình; Cán bộ lưu trữ, Giám đốc: tất cả)
export async function listBatches(user, scope, q) {
  const { total, rows } = await repo.listBatches(pool, q, { departmentId: scope === 'ALL' ? null : user.departmentId, page: q.page, pageSize: PAGE_SIZE });
  return { page: q.page, pageSize: PAGE_SIZE, total, items: rows.map(summary) };
}

// Chi tiết một đợt trong phạm vi
export async function getBatch(user, scope, code) {
  requireVisible(user, scope, await repo.findBatch(pool, code));
  return detail(pool, code);
}

// ---------- Phong tỏa rút hồ sơ khỏi đợt (5.4 CN11) ----------

// Rút hồ sơ vừa bị phong tỏa khỏi đợt chưa kết thúc; đợt hết hồ sơ thì về Nháp (trừ đợt đã bắt đầu hủy)
export async function withdrawForHold(conn, audit, recordIds, holdCode) {
  const rows = await repo.openBatchesOf(conn, recordIds);
  const reason = `Rút do phong tỏa theo lệnh ${holdCode}`;
  const batches = new Map();
  for (const r of rows) {
    await repo.setItemStatus(conn, r.id, [r.record_id], 'WITHDRAWN', reason);
    if (r.record_status === 'PENDING_DISPOSAL') await repo.setRecordsStatus(conn, [r.record_id], 'EXPIRED');
    await audit({ action: 'RECORD_DISPOSAL_WITHDRAW', objectType: 'RECORD', objectCode: r.record_code, details: { batch: r.code, hold: holdCode } });
    batches.set(r.id, [...(batches.get(r.id) ?? []), r]);
  }
  for (const [id, list] of batches) {
    const b = list[0];
    const [[{ n }]] = await conn.query("SELECT COUNT(*) AS n FROM disposal_batch_records WHERE batch_id = ? AND item_status = 'INCLUDED'", [id]);
    const empty = Number(n) === 0;
    const toDraft = empty && b.status !== 'DRAFT' && !b.started_at;
    if (toDraft) await repo.updateBatch(conn, id, { status: 'DRAFT', last_return_reason: 'Mọi hồ sơ trong đợt bị rút do phong tỏa', ...RESET_APPROVALS });
    await audit({ action: 'DISPOSAL_BATCH_WITHDRAW', objectType: 'DISPOSAL_BATCH', objectCode: b.code,
      details: { records: list.map((x) => x.record_code), hold: holdCode, backToDraft: toDraft } });
    await notifyOfficerAndHead(conn, b, { type: 'SYSTEM_CHANGE', objectType: 'DISPOSAL_BATCH', objectCode: b.code,
      message: `Đợt hủy ${b.code}: rút ${list.length} hồ sơ do phong tỏa ${holdCode}${toDraft ? '; đợt không còn hồ sơ nên về Nháp' : ''}` });
  }
}
