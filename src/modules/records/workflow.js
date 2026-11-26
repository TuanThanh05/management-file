import { pool } from '../../config/database.js';
import { withTx } from '../../core/tx.js';
import { AppError } from '../../core/errors.js';
import { todayVN } from '../../core/time.js';
import { getSettings } from '../../core/settings.js';
import { notifyRole, notifyUsers } from '../../core/notify.js';
import { computeExpiry } from './retention.js';
import * as repo from './repo.js';
import { loadRecordDetail } from './service.js';
import { pendingLevel1, directorQueue } from '../disposals/repo.js';

const sameId = (a, b) => String(a) === String(b);

// Ai duyệt hồ sơ (xét tại thời điểm gọi): người tạo đang là Trưởng phòng → Cán bộ lưu trữ; còn lại → Trưởng phòng của phòng
async function approverMode(conn, record) {
  return (await repo.creatorIsDepartmentHead(conn, record.created_by)) ? 'RECORDS_OFFICER' : 'DEPARTMENT_HEAD';
}

// Báo cho người duyệt; phòng chưa có Trưởng phòng thì báo Quản trị hệ thống
async function notifyApprovers(conn, record, { type, message }) {
  const payload = { type, message, objectType: 'RECORD', objectCode: record.code };
  if (await approverMode(conn, record) === 'RECORDS_OFFICER') return notifyRole(conn, 'RECORDS_OFFICER', payload);
  const head = await repo.departmentHeadOf(conn, record.department_id);
  if (head) return notifyUsers(conn, [head], payload);
  const dept = await repo.departmentCode(conn, record.department_id);
  return notifyRole(conn, 'SYSTEM_ADMIN', { ...payload, type: 'ACTION_REQUIRED',
    message: `Phòng ${dept} chưa có Trưởng phòng; hồ sơ ${record.code} đang chờ duyệt lưu trữ` });
}

// Người dùng có đúng là người duyệt của hồ sơ này không (5.2 CN5, 5.3 CN3); người duyệt khác người tạo
async function requireApprover(conn, user, record) {
  if (sameId(user.id, record.created_by)) throw new AppError(403, 'SEPARATION_OF_DUTIES', 'Người duyệt phải khác người tạo hồ sơ');
  const mode = await approverMode(conn, record);
  const ok = mode === 'RECORDS_OFFICER'
    ? user.roles.includes('RECORDS_OFFICER')
    : user.roles.includes('DEPARTMENT_HEAD') && sameId(user.departmentId, record.department_id);
  if (!ok) {
    throw new AppError(403, 'NOT_APPROVER', mode === 'RECORDS_OFFICER'
      ? 'Hồ sơ do Trưởng phòng tạo phải do Cán bộ lưu trữ duyệt'
      : 'Chỉ Trưởng phòng của phòng ban được duyệt hồ sơ này');
  }
}

// Lấy hồ sơ để thao tác, khóa dòng; không thấy được thì 404
async function lockRecord(conn, user, code) {
  const r = await repo.findRecord(conn, code, { forUpdate: true });
  const scope = user.permissions?.['RECORD.VIEW'];
  const visible = r && (scope === 'ALL' || (scope === 'DEPARTMENT' && sameId(r.department_id, user.departmentId)));
  if (!visible) throw AppError.notFound('Không tìm thấy hồ sơ');
  return r;
}

// Loại tài liệu của hồ sơ kèm nhãn đang hiệu lực
async function typeOf(conn, record) {
  const [[t]] = await conn.query('SELECT code FROM document_types WHERE id = ?', [record.document_type_id]);
  return repo.findTypeWithLabel(conn, t.code);
}

// ---------- Gửi / rút yêu cầu lưu trữ (5.1 CN8, CN9) ----------

// Gửi: người tạo, Đang sử dụng, có ít nhất 1 file, loại còn nhãn hiệu lực (không thì báo Cán bộ lưu trữ); khóa sửa, báo người duyệt
export async function submitRecord(actor, user, code) {
  const result = await withTx(actor, async ({ conn, audit }) => {
    const r = await lockRecord(conn, user, code);
    if (!sameId(r.created_by, user.id)) throw new AppError(403, 'NOT_RECORD_OWNER', 'Chỉ người tạo hồ sơ được gửi yêu cầu lưu trữ');
    if (r.status !== 'IN_USE') throw AppError.conflict('Chỉ gửi được hồ sơ ở trạng thái Đang sử dụng');
    if (await repo.countActiveFiles(conn, r.id) === 0) {
      throw AppError.unprocessable('Hồ sơ chưa có file', [{ field: 'files', message: 'Cần ít nhất 1 file đang dùng trước khi gửi lưu trữ' }]);
    }
    const t = await typeOf(conn, r);
    if (t.status !== 'ACTIVE' || !t.label_version_id) return { blockedType: t.code };
    await repo.setRecordStatus(conn, r.id, 'PENDING_ARCHIVE', { submitted_at: 'NOW' });
    await audit({ action: 'RECORD_SUBMIT', objectType: 'RECORD', objectCode: code, details: { approver: await approverMode(conn, r) } });
    await notifyApprovers(conn, r, { type: 'ACTION_REQUIRED', message: `Hồ sơ ${code} chờ duyệt lưu trữ` });
    return {};
  });
  if (result.blockedType) {
    await withTx(actor, async ({ conn, audit }) => {
      await audit({ action: 'RECORD_SUBMIT', objectType: 'RECORD', objectCode: code, result: 'FAILURE',
        details: { reason: 'TYPE_WITHOUT_ACTIVE_LABEL', documentType: result.blockedType } });
      await notifyRole(conn, 'RECORDS_OFFICER', { type: 'ACTION_REQUIRED', objectType: 'DOCUMENT_TYPE', objectCode: result.blockedType,
        message: `Loại tài liệu ${result.blockedType} chưa gắn nhãn đang hiệu lực; hồ sơ ${code} không gửi lưu trữ được` });
    });
    throw AppError.conflict(`Loại tài liệu ${result.blockedType} chưa gắn nhãn đang hiệu lực; đã báo Cán bộ lưu trữ`);
  }
  return loadRecordDetail(pool, code);
}

// Rút yêu cầu: người tạo, Chờ duyệt lưu trữ → Đang sử dụng, báo người duyệt
export async function withdrawRecord(actor, user, code) {
  await withTx(actor, async ({ conn, audit }) => {
    const r = await lockRecord(conn, user, code);
    if (!sameId(r.created_by, user.id)) throw new AppError(403, 'NOT_RECORD_OWNER', 'Chỉ người tạo hồ sơ được rút yêu cầu');
    if (r.status !== 'PENDING_ARCHIVE') throw AppError.conflict('Chỉ rút được hồ sơ đang Chờ duyệt lưu trữ');
    await repo.setRecordStatus(conn, r.id, 'IN_USE');
    await audit({ action: 'RECORD_WITHDRAW', objectType: 'RECORD', objectCode: code });
    await notifyApprovers(conn, r, { type: 'WITHDRAWN', message: `Hồ sơ ${code} đã được rút yêu cầu lưu trữ` });
  });
  return loadRecordDetail(pool, code);
}

// ---------- Duyệt / từ chối (5.2 CN5–7, 5.3 CN3) ----------

// Duyệt: gắn phiên bản nhãn đang hiệu lực, tính hạn chính thức (mốc ngày lưu trữ = ngày duyệt), Chờ duyệt → Lưu trữ
export async function approveRecord(actor, user, code) {
  await withTx(actor, async ({ conn, audit }) => {
    const r = await lockRecord(conn, user, code);
    if (r.status !== 'PENDING_ARCHIVE') throw AppError.conflict('Chỉ duyệt được hồ sơ đang Chờ duyệt lưu trữ');
    await requireApprover(conn, user, r);
    const t = await typeOf(conn, r);
    if (t.status !== 'ACTIVE' || !t.label_version_id) throw AppError.conflict(`Loại tài liệu ${t.code} không còn nhãn đang hiệu lực; chưa duyệt được`);
    const { FISCAL_YEAR_END } = await getSettings(conn, ['FISCAL_YEAR_END']);
    const exp = computeExpiry({ retentionType: t.retention_type, retentionYears: t.retention_years, startTrigger: t.start_trigger },
      { archivedDate: todayVN(), documentDate: r.document_date, eventEndDate: r.event_end_date, fiscalYearEnd: FISCAL_YEAR_END });
    await repo.setRecordStatus(conn, r.id, 'ARCHIVED', {
      label_version_id: t.label_version_id, retention_start_date: exp.startDate, expiry_date: exp.expiryDate,
      archive_approved_by: user.id, archive_approved_at: 'NOW',
    });
    await audit({ action: 'RECORD_ARCHIVE_APPROVE', objectType: 'RECORD', objectCode: code, details: {
      label: t.label_code, labelVersionNo: t.version_no, expiryKind: exp.kind, retentionStartDate: exp.startDate, expiryDate: exp.expiryDate,
    } });
    await notifyUsers(conn, [r.created_by], { type: 'REVIEW_RESULT', objectType: 'RECORD', objectCode: code,
      message: `Hồ sơ ${code} đã được duyệt lưu trữ` });
  });
  return loadRecordDetail(pool, code);
}

// Từ chối: bắt buộc lý do; Chờ duyệt → Đang sử dụng; báo lý do cho người tạo
export async function rejectRecord(actor, user, code, { reason }) {
  await withTx(actor, async ({ conn, audit }) => {
    const r = await lockRecord(conn, user, code);
    if (r.status !== 'PENDING_ARCHIVE') throw AppError.conflict('Chỉ từ chối được hồ sơ đang Chờ duyệt lưu trữ');
    await requireApprover(conn, user, r);
    await repo.setRecordStatus(conn, r.id, 'IN_USE', { last_rejection_reason: reason });
    await audit({ action: 'RECORD_ARCHIVE_REJECT', objectType: 'RECORD', objectCode: code, details: { reason } });
    await notifyUsers(conn, [r.created_by], { type: 'REVIEW_RESULT', objectType: 'RECORD', objectCode: code,
      message: `Hồ sơ ${code} bị từ chối lưu trữ: ${reason}` });
  });
  return loadRecordDetail(pool, code);
}

// Hàng chờ duyệt (5.2 CN4, 5.4 CN3): yêu cầu lưu trữ; Trưởng phòng thêm gia hạn, đợt chờ cấp 1; Giám đốc thêm đề xuất nhãn, đợt chờ cấp 2, đợt đang chờ hủy
export async function listApprovals(user) {
  const isHead = user.roles.includes('DEPARTMENT_HEAD');
  const rows = await repo.listPendingApprovals(pool, {
    headOfDepartmentId: isHead ? user.departmentId : null,
    asRecordsOfficer: user.roles.includes('RECORDS_OFFICER'),
    excludeUserId: user.id,
  });
  const ext = isHead ? await repo.listPendingExtensions(pool, user.departmentId, user.id) : [];
  const batches = isHead ? await pendingLevel1(pool, user.departmentId, user.id) : [];
  const director = user.roles.includes('DIRECTOR') ? await directorQueue(pool, user.id) : null;
  return {
    items: rows.map((r) => ({
      code: r.code, title: r.title, documentDate: r.document_date, submittedAt: r.submitted_at, waitingDays: Number(r.waiting_days),
      documentType: { code: r.type_code, name: r.type_name }, department: r.department_code,
      createdBy: { email: r.created_by_email, fullName: r.created_by_name },
    })),
    extensions: ext.map((e) => ({
      code: e.code, recordCode: e.record_code, oldExpiryDate: e.old_expiry_date, newExpiryDate: e.new_expiry_date,
      requestedAt: e.requested_at, waitingDays: Number(e.waiting_days), requestedBy: { email: e.requested_by_email, fullName: e.requested_by_name },
    })),
    disposals: batches.map((b) => ({
      code: b.code, reason: b.reason, recordCount: Number(b.record_count), submittedAt: b.submitted_at,
      waitingDays: Number(b.waiting_days), createdBy: b.created_by_email,
    })),
    ...(director && {
      labelProposals: director.labels.map((l) => ({ id: String(l.id), labelCode: l.label_code, versionNo: l.version_no, proposalType: l.proposal_type,
        submittedAt: l.submitted_at, waitingDays: Number(l.waiting_days) })),
      disposalsLevel2: director.level2.map((b) => ({ code: b.code, department: b.department_code, recordCount: Number(b.record_count),
        level1ApprovedAt: b.level1_approved_at, waitingDays: Number(b.waiting_days) })),
      disposalsScheduled: director.scheduled.map((b) => ({ code: b.code, department: b.department_code, recordCount: Number(b.record_count),
        scheduledAt: b.scheduled_at, minutesLeft: Math.max(0, Number(b.minutes_left)) })),
    }),
  };
}

// ---------- Đánh dấu hết hiệu lực (5.2 CN8, BM11) ----------

// Trưởng phòng của phòng, hồ sơ Lưu trữ + Còn hiệu lực; nhãn theo sự kiện thì bắt buộc ngày kết thúc và tính hạn; nội dung sự kiện đã có thì giữ; chỉ một lần
export async function markRecordEnded(actor, user, code, { eventEndDate, eventNote }) {
  await withTx(actor, async ({ conn, audit }) => {
    const r = await lockRecord(conn, user, code);
    if (!user.roles.includes('DEPARTMENT_HEAD') || !sameId(user.departmentId, r.department_id)) {
      throw new AppError(403, 'NOT_DEPARTMENT_HEAD', 'Chỉ Trưởng phòng của phòng ban được đánh dấu hết hiệu lực');
    }
    if (r.status !== 'ARCHIVED') throw AppError.conflict('Chỉ đánh dấu được hồ sơ ở trạng thái Lưu trữ');
    if (r.validity !== 'VALID') throw AppError.conflict('Hồ sơ đã được đánh dấu hết hiệu lực; không sửa lại được');
    const [[v]] = await conn.query('SELECT retention_type, retention_years, start_trigger, event_name FROM label_versions WHERE id = ?', [r.label_version_id]);
    const byEvent = v.start_trigger === 'EVENT_END';
    const errs = [];
    if (byEvent && !eventEndDate) errs.push({ field: 'eventEndDate', message: 'Nhãn tính hạn theo sự kiện: bắt buộc nhập ngày kết thúc sự kiện' });
    else if (eventEndDate && eventEndDate < r.document_date) errs.push({ field: 'eventEndDate', message: 'Ngày kết thúc sự kiện không nhỏ hơn ngày tài liệu' });
    else if (eventEndDate && eventEndDate > todayVN()) errs.push({ field: 'eventEndDate', message: 'Ngày kết thúc sự kiện không lớn hơn ngày hiện tại' });
    if (errs.length) throw AppError.unprocessable('Ngày kết thúc sự kiện không hợp lệ', errs);
    const exp = byEvent
      ? computeExpiry({ retentionType: v.retention_type, retentionYears: v.retention_years, startTrigger: v.start_trigger }, { eventEndDate })
      : null;
    await repo.markEnded(conn, r.id, {
      eventEndDate: eventEndDate ?? null, eventNote: r.event_note || eventNote || v.event_name || 'Hết hiệu lực nghiệp vụ',
      endedBy: user.id, retentionStartDate: exp?.startDate, expiryDate: exp?.expiryDate,
    });
    await audit({ action: 'RECORD_MARK_ENDED', objectType: 'RECORD', objectCode: code,
      details: { eventEndDate: eventEndDate ?? null, expiryDate: exp?.expiryDate ?? r.expiry_date ?? null } });
  });
  return loadRecordDetail(pool, code);
}
