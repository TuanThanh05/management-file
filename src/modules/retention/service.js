import { pool } from '../../config/database.js';
import { withTx } from '../../core/tx.js';
import { AppError } from '../../core/errors.js';
import { todayVN } from '../../core/time.js';
import { daysBetween } from '../records/retention.js';
import * as repo from './repo.js';

const PAGE_SIZE = 20;
const flag = (v) => Boolean(Number(v));

// Cảnh báo hạn của phòng (5.2 CN9): sắp hết hạn (≤ N ngày của nhãn), đã hết hạn, chưa xác định ngày hết hạn
export async function expiryAlerts(user) {
  const today = todayVN();
  const rows = await repo.alertRows(pool, user.departmentId);
  const base = (r) => ({ code: r.code, title: r.title, status: r.status, isOnHold: flag(r.is_on_hold),
    documentType: { code: r.type_code, name: r.type_name }, label: r.label_code, expiryDate: r.expiry_date });
  const upcoming = [];
  const expired = [];
  const undetermined = [];
  for (const r of rows) {
    if (r.status === 'EXPIRED') expired.push({ ...base(r), overdueDays: daysBetween(r.expiry_date, today) });
    else if (r.expiry_date) {
      const left = daysBetween(today, r.expiry_date);
      if (left <= Number(r.warning_days)) upcoming.push({ ...base(r), daysLeft: left, warningDays: Number(r.warning_days) });
    } else if (r.retention_type !== 'PERMANENT') undetermined.push({ ...base(r), validity: r.validity });
  }
  expired.sort((a, b) => b.overdueDays - a.overdueDays);
  return { today, upcoming, expired, undetermined };
}

// Rà soát hồ sơ hết hạn mọi phòng ban (5.3 CN10); canMark = được chọn để đánh dấu hủy
export async function listExpired(q) {
  const today = todayVN();
  const { total, rows } = await repo.expiredRows(pool, q, { page: q.page, pageSize: PAGE_SIZE });
  return {
    page: q.page, pageSize: PAGE_SIZE, total,
    items: rows.map((r) => ({
      code: r.code, title: r.title, department: r.department_code, group: r.group_code,
      documentType: { code: r.type_code, name: r.type_name }, label: { code: r.label_code, versionNo: r.version_no },
      expiryDate: r.expiry_date, overdueDays: daysBetween(r.expiry_date, today),
      isOnHold: flag(r.is_on_hold), pendingExtension: r.pending_extension, lastExclusionReason: r.last_exclusion_reason,
      isDisposalEligible: flag(r.is_disposal_eligible), inBatch: flag(r.in_batch),
      canMark: !flag(r.is_on_hold) && !r.pending_extension,
    })),
  };
}

// Lý do một hồ sơ không đổi được dấu đủ điều kiện hủy; null = được
function eligibilityProblem(r, eligible) {
  if (eligible) {
    if (r.status !== 'EXPIRED') return 'Chỉ đánh dấu hồ sơ ở trạng thái Hết hạn';
    if (flag(r.is_on_hold)) return 'Hồ sơ đang bị phong tỏa';
    if (flag(r.pending_extension)) return 'Hồ sơ có đề xuất gia hạn đang chờ duyệt';
  } else {
    if (!flag(r.is_disposal_eligible)) return 'Hồ sơ chưa được đánh dấu';
    if (flag(r.in_batch)) return 'Hồ sơ đang nằm trong đợt hủy; không bỏ dấu được';
  }
  return null;
}

// Đánh / bỏ dấu đủ điều kiện hủy nhiều hồ sơ (5.3 CN11): có hồ sơ không hợp lệ thì không đổi hồ sơ nào
export async function setEligibility(actor, user, { recordCodes, eligible }) {
  return withTx(actor, async ({ conn, audit }) => {
    const rows = await repo.lockForEligibility(conn, recordCodes);
    const found = new Map(rows.map((r) => [r.code, r]));
    const problems = recordCodes.map((c) => {
      const r = found.get(c);
      const msg = r ? eligibilityProblem(r, eligible) : 'Không tìm thấy hồ sơ';
      return msg && { field: c, message: msg };
    }).filter(Boolean);
    if (problems.length) throw AppError.unprocessable('Có hồ sơ không hợp lệ; chọn lại', problems);
    const changed = rows.filter((r) => flag(r.is_disposal_eligible) !== eligible);
    for (const r of changed) {
      await repo.setEligible(conn, r.id, eligible, user.id);
      await audit({ action: eligible ? 'RECORD_MARK_ELIGIBLE' : 'RECORD_UNMARK_ELIGIBLE', objectType: 'RECORD', objectCode: r.code });
    }
    return { updated: changed.map((r) => r.code), unchanged: rows.filter((r) => !changed.includes(r)).map((r) => r.code) };
  });
}
