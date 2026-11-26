import { pool } from '../config/database.js';
import { withTx, SYSTEM_ACTOR } from '../core/tx.js';
import { todayVN, formatDateVN } from '../core/time.js';
import { logger } from '../core/logger.js';
import { notifyUsers, notifyRole, notifyDepartmentHead } from '../core/notify.js';
import { runJob } from './runner.js';

// Quét hạn hằng ngày (QT3.1 nhánh B): đến hạn → Hết hạn; còn ≤ N ngày và chưa cảnh báo → cảnh báo; gửi thông báo tổng hợp
export function runExpiryScan({ runType = 'SCHEDULED', triggeredBy = null } = {}) {
  return runJob('EXPIRY_SCAN', { runType, triggeredBy }, () => scan(todayVN()));
}

// Hồ sơ Lưu trữ đã đến hạn (hồ sơ phong tỏa vẫn chuyển Hết hạn; phong tỏa chỉ chặn hủy)
async function dueRecords(today) {
  const [rows] = await pool.query(
    `SELECT id, code FROM records WHERE status = 'ARCHIVED' AND expiry_date IS NOT NULL AND expiry_date <= ? ORDER BY expiry_date, id`, [today]);
  return rows;
}

// Hồ sơ Lưu trữ còn không quá N ngày (N = số ngày cảnh báo của phiên bản nhãn) và chưa được cảnh báo
async function warnRecords(today) {
  const [rows] = await pool.query(
    `SELECT r.id, r.code FROM records r JOIN label_versions v ON v.id = r.label_version_id
     WHERE r.status = 'ARCHIVED' AND NOT r.is_warned AND r.expiry_date > ? AND DATEDIFF(r.expiry_date, ?) <= v.warning_days
     ORDER BY r.expiry_date, r.id`, [today, today]);
  return rows;
}

// Xử lý từng hồ sơ trong giao dịch riêng: một hồ sơ lỗi không chặn các hồ sơ khác
async function eachRecord(rows, handle, stats) {
  for (const row of rows) {
    try {
      const done = await withTx(SYSTEM_ACTOR, (tx) => handle(tx, row));
      if (done) stats.processed++;
    } catch (err) {
      stats.errors++;
      logger.error({ err, record: row.code }, 'Quét hạn: lỗi xử lý hồ sơ');
    }
  }
}

async function scan(today) {
  const stats = { processed: 0, errors: 0 };
  const byDept = new Map();
  const tally = (r, key) => {
    const d = byDept.get(String(r.department_id)) ?? { code: r.department_code, expired: 0, warned: 0 };
    d[key]++;
    byDept.set(String(r.department_id), d);
  };

  await eachRecord(await dueRecords(today), async ({ conn, audit }, { id }) => {
    const [[r]] = await conn.query(
      `SELECT r.*, d.code AS department_code FROM records r JOIN departments d ON d.id = r.department_id
       WHERE r.id = ? FOR UPDATE OF r`, [id]);
    if (r.status !== 'ARCHIVED' || !r.expiry_date || r.expiry_date > today) return false;
    await conn.query("UPDATE records SET status = 'EXPIRED' WHERE id = ?", [id]);
    await audit({ action: 'RECORD_EXPIRE', objectType: 'RECORD', objectCode: r.code, details: { expiryDate: r.expiry_date, isOnHold: Boolean(Number(r.is_on_hold)) } });
    await notifyUsers(conn, [r.created_by], { type: 'EXPIRY_WARNING', objectType: 'RECORD', objectCode: r.code,
      message: `Hồ sơ ${r.code} đã hết hạn lưu trữ ngày ${formatDateVN(r.expiry_date)}` });
    tally(r, 'expired');
    return true;
  }, stats);

  await eachRecord(await warnRecords(today), async ({ conn, audit }, { id }) => {
    const [[r]] = await conn.query(
      `SELECT r.*, d.code AS department_code FROM records r JOIN departments d ON d.id = r.department_id
       WHERE r.id = ? FOR UPDATE OF r`, [id]);
    if (r.status !== 'ARCHIVED' || Number(r.is_warned)) return false;
    await conn.query('UPDATE records SET is_warned = TRUE WHERE id = ?', [id]);
    await audit({ action: 'RECORD_EXPIRY_WARNING', objectType: 'RECORD', objectCode: r.code, details: { expiryDate: r.expiry_date } });
    tally(r, 'warned');
    return true;
  }, stats);

  const depts = [...byDept.entries()];
  const total = depts.reduce((a, [, d]) => ({ expired: a.expired + d.expired, warned: a.warned + d.warned }), { expired: 0, warned: 0 });
  const day = formatDateVN(today);
  await withTx(SYSTEM_ACTOR, async ({ conn, audit }) => {
    for (const [deptId, d] of depts) {
      await notifyDepartmentHead(conn, deptId, { type: 'EXPIRY_WARNING', objectType: 'DEPARTMENT', objectCode: d.code,
        message: `Quét hạn ngày ${day}: phòng ${d.code} có ${d.expired} hồ sơ đã hết hạn, ${d.warned} hồ sơ sắp hết hạn` });
    }
    if (depts.length) {
      const parts = depts.map(([, d]) => `${d.code}: ${d.expired} hết hạn, ${d.warned} sắp hết hạn`).join('; ');
      await notifyRole(conn, 'RECORDS_OFFICER', { type: 'EXPIRY_WARNING',
        message: `Quét hạn ngày ${day}: ${total.expired} hồ sơ đã hết hạn, ${total.warned} hồ sơ sắp hết hạn (${parts})` });
    }
    await audit({ action: 'JOB_EXPIRY_SCAN', objectType: 'JOB', objectCode: 'EXPIRY_SCAN',
      result: stats.errors ? 'FAILURE' : 'SUCCESS', details: { day: today, ...total, errors: stats.errors } });
  });
  return { ...stats, note: `Hết hạn: ${total.expired}; cảnh báo: ${total.warned}; lỗi: ${stats.errors}` };
}
