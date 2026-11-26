import { pool } from '../../config/database.js';
import { withTx } from '../../core/tx.js';
import { notifyRole } from '../../core/notify.js';

const LOG_PAGE = 50;
const CHECK_PAGE = 20;
const parseJson = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

// Tra cứu nhật ký (5.4 CN14, BM18): chỉ đọc; lượt xem cũng được ghi nhật ký
export async function listLogs(actor, q) {
  const to = q.to ? new Date(q.to) : new Date();
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - 7 * 86_400_000);
  const where = ['a.occurred_at BETWEEN ? AND ?'];
  const params = [from, to];
  if (q.userEmail) { where.push('u.email = ?'); params.push(q.userEmail); }
  if (q.actions?.length) { where.push('a.action IN (?)'); params.push(q.actions); }
  if (q.objectCode) { where.push('a.object_code = ?'); params.push(q.objectCode); }
  if (q.result) { where.push('a.result = ?'); params.push(q.result); }
  if (q.ip) { where.push('a.ip_address = ?'); params.push(q.ip); }
  const sql = `FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id WHERE ${where.join(' AND ')}`;
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${sql}`, params);
  const [rows] = await pool.query(
    `SELECT a.seq, a.occurred_at, a.roles, a.ip_address, a.action, a.object_type, a.object_code, a.result, a.details, a.prev_hash, a.hash,
            u.email AS user_email, u.full_name AS user_name
     ${sql} ORDER BY a.seq DESC LIMIT ? OFFSET ?`, [...params, LOG_PAGE, (q.page - 1) * LOG_PAGE]);
  await withTx(actor, ({ audit }) => audit({ action: 'AUDIT_VIEW', objectType: 'AUDIT_LOG',
    details: { from: from.toISOString(), to: to.toISOString(), filters: { ...q, from: undefined, to: undefined }, page: q.page } }));
  return {
    from: from.toISOString(), to: to.toISOString(), page: q.page, pageSize: LOG_PAGE, total: Number(total),
    items: rows.map((r) => ({
      seq: Number(r.seq), occurredAt: r.occurred_at, user: r.user_email ? { email: r.user_email, fullName: r.user_name } : null,
      roles: r.roles, ip: r.ip_address, action: r.action, objectType: r.object_type, objectCode: r.object_code, result: r.result,
      details: parseJson(r.details), prevHash: r.prev_hash, hash: r.hash,
    })),
  };
}

// Kiểm tra toàn vẹn chuỗi băm (5.4 CN15, BM19): gọi sp_verify_audit_chain, lưu kết quả; sai lệch thì cảnh báo
export async function verifyChain(actor, user, { fromSeq, toSeq }) {
  return withTx(actor, async ({ conn, audit }) => {
    const [[head]] = await conn.query('SELECT last_seq FROM audit_chain_head WHERE id = 1');
    const a = fromSeq ?? 1;
    const b = Math.min(toSeq ?? Number(head.last_seq), Number(head.last_seq));
    await conn.query('CALL sp_verify_audit_chain(?, ?, @checked, @result, @bad, @issue, @last)', [a, b]);
    const [[r]] = await conn.query('SELECT @checked AS checked, @result AS result, @bad AS bad, @issue AS issue, @last AS last');
    const bad = r.bad == null ? null : Number(r.bad);
    const [ins] = await conn.query(
      `INSERT INTO integrity_checks (checked_by, from_seq, to_seq, checked_count, result, first_bad_seq, issue_type, last_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [user.id, a, b, Number(r.checked), r.result, bad, r.issue, r.last]);
    let badAt = null;
    if (bad != null) [[{ occurred_at: badAt } = {}]] = await conn.query('SELECT occurred_at FROM audit_logs WHERE seq = ?', [bad]);
    await audit({ action: 'AUDIT_VERIFY', objectType: 'AUDIT_LOG', result: r.result === 'INTACT' ? 'SUCCESS' : 'FAILURE',
      details: { checkId: String(ins.insertId), fromSeq: a, toSeq: b, checked: Number(r.checked), result: r.result, firstBadSeq: bad, issue: r.issue } });
    if (r.result !== 'INTACT') {
      const payload = { type: 'SECURITY_ALERT', objectType: 'AUDIT_LOG', objectCode: String(bad),
        message: `Kiểm tra toàn vẹn nhật ký phát hiện sai lệch tại bản ghi số ${bad} (${r.issue})` };
      await notifyRole(conn, 'SYSTEM_ADMIN', payload);
      await notifyRole(conn, 'DIRECTOR', payload);
    }
    return {
      id: String(ins.insertId), fromSeq: a, toSeq: b, checkedCount: Number(r.checked), result: r.result,
      firstBad: bad == null ? null : { seq: bad, occurredAt: badAt ?? null, issue: r.issue }, lastHash: r.last,
      checkedBy: user.email, checkedAt: new Date().toISOString(),
    };
  });
}

// Lịch sử các lần kiểm tra toàn vẹn, mới nhất trước
export async function listChecks({ page }) {
  const [[{ total }]] = await pool.query('SELECT COUNT(*) AS total FROM integrity_checks');
  const [rows] = await pool.query(
    `SELECT c.*, u.email FROM integrity_checks c JOIN users u ON u.id = c.checked_by ORDER BY c.id DESC LIMIT ? OFFSET ?`,
    [CHECK_PAGE, (page - 1) * CHECK_PAGE]);
  return {
    page, pageSize: CHECK_PAGE, total: Number(total),
    items: rows.map((c) => ({ id: String(c.id), checkedBy: c.email, checkedAt: c.checked_at, fromSeq: Number(c.from_seq), toSeq: Number(c.to_seq),
      checkedCount: Number(c.checked_count), result: c.result, firstBadSeq: c.first_bad_seq == null ? null : Number(c.first_bad_seq),
      issue: c.issue_type, lastHash: c.last_hash })),
  };
}
