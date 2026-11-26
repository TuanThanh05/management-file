import { pool } from '../../config/database.js';
import { todayVN } from '../../core/time.js';

const STATUSES = ['IN_USE', 'PENDING_ARCHIVE', 'ARCHIVED', 'EXPIRED', 'PENDING_DISPOSAL', 'DISPOSED', 'CANCELLED'];
const BATCH_STATUSES = ['DRAFT', 'PENDING_LEVEL_1', 'PENDING_LEVEL_2', 'APPROVED', 'COMPLETED', 'CANCELLED'];
const n = (v) => Number(v ?? 0);

// Chỉ tiêu hồ sơ của một phạm vi (deptId null = toàn doanh nghiệp), tính tại thời điểm xem (5.2 CN16)
async function recordMetrics(deptId) {
  const today = todayVN();
  const w = deptId ? 'r.department_id = ?' : '1 = 1';
  const p = deptId ? [deptId] : [];
  const [byStatus] = await pool.query(`SELECT r.status, COUNT(*) AS c FROM records r WHERE ${w} GROUP BY r.status`, p);
  const [byGroup] = await pool.query(
    `SELECT g.code, g.name, COUNT(*) AS c FROM records r JOIN document_types t ON t.id = r.document_type_id JOIN record_groups g ON g.id = t.group_id
     WHERE ${w} GROUP BY g.id ORDER BY g.code`, p);
  const [[k]] = await pool.query(
    `SELECT SUM(r.is_on_hold) AS on_hold,
            SUM(r.status = 'ARCHIVED' AND r.expiry_date BETWEEN ? AND ? + INTERVAL 30 DAY) AS exp30,
            SUM(r.status = 'ARCHIVED' AND r.expiry_date BETWEEN ? AND ? + INTERVAL 90 DAY) AS exp90,
            SUM(r.status = 'ARCHIVED' AND r.expiry_date IS NULL AND v.retention_type <> 'PERMANENT') AS undetermined
     FROM records r LEFT JOIN label_versions v ON v.id = r.label_version_id WHERE ${w}`, [today, today, today, today, ...p]);
  const [disposed] = await pool.query(
    `SELECT YEAR(r.disposed_at + INTERVAL 7 HOUR) AS y, COUNT(*) AS c FROM records r WHERE ${w} AND r.status = 'DISPOSED' GROUP BY y ORDER BY y`, p);
  const statusMap = Object.fromEntries(byStatus.map((s) => [s.status, n(s.c)]));
  return {
    total: byStatus.reduce((a, s) => a + n(s.c), 0),
    byStatus: Object.fromEntries(STATUSES.map((s) => [s, statusMap[s] ?? 0])),
    byGroup: byGroup.map((g) => ({ code: g.code, name: g.name, count: n(g.c) })),
    onHold: n(k.on_hold), expiringIn30Days: n(k.exp30), expiringIn90Days: n(k.exp90), undetermined: n(k.undetermined),
    disposedByYear: disposed.map((d) => ({ year: n(d.y), count: n(d.c) })),
  };
}

// Thống kê (BM13): Trưởng phòng – phòng mình (5.2 CN16); Cán bộ lưu trữ, Giám đốc – toàn doanh nghiệp, chia theo phòng (5.3 CN19)
export async function summary(user, scope, q) {
  const today = todayVN();
  if (scope !== 'ALL') {
    return { scope: 'DEPARTMENT', department: user.department?.code ?? null, asOf: today, ...(await recordMetrics(user.departmentId)) };
  }
  const from = q.from ?? `${today.slice(0, 4)}-01-01`;
  const to = q.to ?? today;
  const [depts] = await pool.query('SELECT id, code, name FROM departments ORDER BY code');
  const [batches] = await pool.query('SELECT status, COUNT(*) AS c FROM disposal_batches GROUP BY status');
  const [disposedByDept] = await pool.query(
    `SELECT d.code, YEAR(r.disposed_at + INTERVAL 7 HOUR) AS y, COUNT(*) AS c FROM records r JOIN departments d ON d.id = r.department_id
     WHERE r.status = 'DISPOSED' GROUP BY d.code, y ORDER BY y, d.code`);
  const [[ext]] = await pool.query(
    `SELECT SUM(status = 'APPROVED') AS approved, SUM(status = 'REJECTED') AS rejected, SUM(status = 'PENDING') AS pending
     FROM extension_requests WHERE reviewed_at IS NULL OR (reviewed_at >= TIMESTAMP(?) - INTERVAL 7 HOUR AND reviewed_at < TIMESTAMP(?) + INTERVAL 17 HOUR)`,
    [from, to]);
  const batchMap = Object.fromEntries(batches.map((b) => [b.status, n(b.c)]));
  return {
    scope: 'ALL', asOf: today, ...(await recordMetrics(null)),
    byDepartment: await Promise.all(depts.map(async (d) => ({ code: d.code, name: d.name, ...(await recordMetrics(d.id)) }))),
    batchesByStatus: Object.fromEntries(BATCH_STATUSES.map((s) => [s, batchMap[s] ?? 0])),
    disposedByYearAndDepartment: disposedByDept.map((r) => ({ year: n(r.y), department: r.code, count: n(r.c) })),
    extensions: { period: { from, to }, approved: n(ext.approved), rejected: n(ext.rejected), pendingNow: n(ext.pending) },
  };
}
