import { pool } from '../../config/database.js';
import { withTx } from '../../core/tx.js';
import { AppError } from '../../core/errors.js';
import { nextCode } from '../../core/codes.js';
import { todayVN, formatDateVN } from '../../core/time.js';
import { getSettings } from '../../core/settings.js';
import { notifyUsers, notifyRole, notifyDepartmentHead } from '../../core/notify.js';
import { addYears, diffYMD, daysBetween } from '../records/retention.js';
import { findRecord } from '../records/repo.js';
import * as repo from './repo.js';

const PAGE_SIZE = 20;
const sameId = (a, b) => String(a) === String(b);

// Dạng trả về của một đề xuất gia hạn (BM03)
function toDto(e) {
  return {
    code: e.code, status: e.status, recordCode: e.record_code, recordTitle: e.record_title, department: e.department_code,
    oldExpiryDate: e.old_expiry_date, newExpiryDate: e.new_expiry_date, extendBy: diffYMD(e.old_expiry_date, e.new_expiry_date),
    reason: e.reason, requestedBy: { email: e.requested_by_email, fullName: e.requested_by_name }, requestedAt: e.requested_at,
    reviewedBy: e.reviewed_by_email ? { email: e.reviewed_by_email, fullName: e.reviewed_by_name } : null,
    reviewedAt: e.reviewed_at, reviewComment: e.review_comment,
    waitingDays: e.status === 'PENDING' ? daysBetween(todayVN(new Date(e.requested_at)), todayVN()) : null,
  };
}

// Xem được đề xuất không: phạm vi ALL hoặc cùng phòng với hồ sơ
function canSee(user, scope, e) {
  return scope === 'ALL' || sameId(e.department_id, user.departmentId);
}

// Lập đề xuất gia hạn (5.1 CN14, BM03): Nhân viên cùng phòng, hồ sơ Hết hạn, ngoài đợt hủy, chưa có đề xuất chờ
export async function createExtension(actor, user, { recordCode, newExpiryDate, reason }) {
  const code = await withTx(actor, async ({ conn, audit }) => {
    const r = await findRecord(conn, recordCode, { forUpdate: true });
    if (!r || !sameId(r.department_id, user.departmentId)) throw AppError.notFound('Không tìm thấy hồ sơ');
    if (r.status !== 'EXPIRED') throw AppError.conflict('Chỉ đề xuất gia hạn cho hồ sơ ở trạng thái Hết hạn');
    const b = await repo.recordBlockers(conn, r.id);
    if (b.inBatch) throw AppError.conflict('Hồ sơ đang nằm trong đợt hủy; báo Trưởng phòng loại hồ sơ khi duyệt cấp 1');
    if (b.pending) throw AppError.conflict('Hồ sơ đã có đề xuất gia hạn đang chờ duyệt');
    const today = todayVN();
    const { MAX_EXTENSION_YEARS } = await getSettings(conn, ['MAX_EXTENSION_YEARS']);
    const max = addYears(today, MAX_EXTENSION_YEARS);
    if (newExpiryDate <= today || newExpiryDate > max) {
      throw AppError.unprocessable('Ngày hết hạn mới không hợp lệ', [{ field: 'newExpiryDate',
        message: `Ngày hết hạn mới phải lớn hơn hôm nay và không quá ${formatDateVN(max)}` }]);
    }
    const c = await nextCode(conn, 'EXTENSION');
    await repo.insertExtension(conn, { code: c, recordId: r.id, oldExpiryDate: r.expiry_date, newExpiryDate, reason, requestedBy: user.id });
    const details = { extension: c, oldExpiryDate: r.expiry_date, newExpiryDate };
    await audit({ action: 'EXTENSION_REQUEST', objectType: 'EXTENSION', objectCode: c, details: { record: recordCode, ...details, reason } });
    await audit({ action: 'RECORD_EXTENSION_REQUEST', objectType: 'RECORD', objectCode: recordCode, details });
    await notifyDepartmentHead(conn, r.department_id, { type: 'ACTION_REQUIRED', objectType: 'EXTENSION', objectCode: c,
      message: `Đề xuất gia hạn ${c} cho hồ sơ ${recordCode} chờ duyệt` });
    return c;
  });
  return toDto(await repo.findExtension(pool, code));
}

// Kiểm tra người xét duyệt: Trưởng phòng của phòng sở hữu hồ sơ, khác người đề xuất; đề xuất còn Chờ duyệt
async function lockForReview(conn, user, code) {
  const e = await repo.findExtension(conn, code, { forUpdate: true });
  if (!e || !sameId(e.department_id, user.departmentId)) throw AppError.notFound('Không tìm thấy đề xuất gia hạn');
  if (sameId(e.requested_by, user.id)) throw new AppError(403, 'SEPARATION_OF_DUTIES', 'Người duyệt phải khác người đề xuất');
  if (e.status !== 'PENDING') throw AppError.conflict('Đề xuất đã được xét duyệt');
  return e;
}

// Duyệt gia hạn (5.2 CN10): hồ sơ Hết hạn → Lưu trữ với ngày hết hạn mới; báo người đề xuất và Cán bộ lưu trữ
export async function approveExtension(actor, user, code, { comment }) {
  await withTx(actor, async ({ conn, audit }) => {
    const e = await lockForReview(conn, user, code);
    const r = await findRecord(conn, e.record_code, { forUpdate: true });
    if (r.status !== 'EXPIRED') throw AppError.conflict('Hồ sơ không còn ở trạng thái Hết hạn');
    if (e.new_expiry_date <= todayVN()) throw AppError.conflict('Ngày hết hạn mới đã qua; từ chối và đề xuất lại');
    await repo.reviewExtension(conn, e.id, { status: 'APPROVED', reviewedBy: user.id, comment });
    await repo.applyExtension(conn, r.id, e.new_expiry_date);
    const details = { extension: code, oldExpiryDate: e.old_expiry_date, newExpiryDate: e.new_expiry_date };
    await audit({ action: 'EXTENSION_APPROVE', objectType: 'EXTENSION', objectCode: code, details: { record: e.record_code, ...details, comment: comment ?? null } });
    await audit({ action: 'RECORD_EXTEND', objectType: 'RECORD', objectCode: e.record_code, details });
    const payload = { type: 'REVIEW_RESULT', objectType: 'EXTENSION', objectCode: code,
      message: `Đề xuất gia hạn ${code} (hồ sơ ${e.record_code}) đã được duyệt; hạn mới ${formatDateVN(e.new_expiry_date)}` };
    await notifyUsers(conn, [e.requested_by], payload);
    await notifyRole(conn, 'RECORDS_OFFICER', payload);
  });
  return toDto(await repo.findExtension(pool, code));
}

// Từ chối gia hạn (5.2 CN11): hồ sơ giữ Hết hạn; báo lý do cho người đề xuất và Cán bộ lưu trữ
export async function rejectExtension(actor, user, code, { comment }) {
  await withTx(actor, async ({ conn, audit }) => {
    const e = await lockForReview(conn, user, code);
    await repo.reviewExtension(conn, e.id, { status: 'REJECTED', reviewedBy: user.id, comment });
    await audit({ action: 'EXTENSION_REJECT', objectType: 'EXTENSION', objectCode: code, details: { record: e.record_code, comment } });
    await audit({ action: 'RECORD_EXTENSION_REJECT', objectType: 'RECORD', objectCode: e.record_code, details: { extension: code, comment } });
    const payload = { type: 'REVIEW_RESULT', objectType: 'EXTENSION', objectCode: code,
      message: `Đề xuất gia hạn ${code} (hồ sơ ${e.record_code}) bị từ chối: ${comment}` };
    await notifyUsers(conn, [e.requested_by], payload);
    await notifyRole(conn, 'RECORDS_OFFICER', payload);
  });
  return toDto(await repo.findExtension(pool, code));
}

// Theo dõi đề xuất gia hạn (5.3 CN12 toàn bộ; Nhân viên/Trưởng phòng theo phòng)
export async function listExtensions(user, scope, q) {
  const { total, rows } = await repo.listExtensions(pool, q, {
    departmentId: scope === 'ALL' ? null : user.departmentId, page: q.page, pageSize: PAGE_SIZE });
  return { page: q.page, pageSize: PAGE_SIZE, total, items: rows.map(toDto) };
}

// Xem một đề xuất gia hạn trong phạm vi
export async function getExtension(user, scope, code) {
  const e = await repo.findExtension(pool, code);
  if (!e || !canSee(user, scope, e)) throw AppError.notFound('Không tìm thấy đề xuất gia hạn');
  return toDto(e);
}
