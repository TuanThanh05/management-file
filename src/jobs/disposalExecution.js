import { pool } from '../config/database.js';
import { withTx, SYSTEM_ACTOR } from '../core/tx.js';
import { logger } from '../core/logger.js';
import { notifyUsers, notifyRole, notifyDepartmentHead } from '../core/notify.js';
import { destroyKeysOfRecord } from '../modules/records/repo.js';
import { purgeBlobs } from '../modules/records/service.js';
import { issueCertificate, discardCertificateFile } from '../modules/certificates/service.js';
import { FINAL_CHECK_PREFIX } from '../modules/certificates/document.js';
import { runJob } from './runner.js';

const ALERT_AFTER = 3;
const RESET_APPROVALS = { level1_approver_id: null, level1_approved_at: null, level1_comment: null,
  level2_approver_id: null, level2_approved_at: null, level2_comment: null, scheduled_at: null };

// Thực hiện hủy (QT4.2): đợt Đã phê duyệt đã hết thời gian chờ → kiểm tra lần cuối, xóa khóa, xóa bản mã, lập biên bản
export function runDisposalExecution({ runType = 'SCHEDULED', triggeredBy = null } = {}) {
  return runJob('DISPOSAL_EXECUTION', { runType, triggeredBy }, execute);
}

// Có đợt đến giờ hủy không (bộ hẹn giờ gọi mỗi phút)
export async function hasDueBatches() {
  const [[row]] = await pool.query("SELECT COUNT(*) AS n FROM disposal_batches WHERE status = 'APPROVED' AND scheduled_at <= UTC_TIMESTAMP(3)");
  return Number(row.n) > 0;
}

async function execute() {
  const stats = { processed: 0, errors: 0 };
  await sweepPurge();
  const [batches] = await pool.query(
    "SELECT id, code FROM disposal_batches WHERE status = 'APPROVED' AND scheduled_at <= UTC_TIMESTAMP(3) ORDER BY scheduled_at, id");
  for (const b of batches) {
    try {
      await processBatch(b.id, stats);
    } catch (err) {
      stats.errors++;
      logger.error({ err, batch: b.code }, 'Thực hiện hủy: lỗi đợt');
    }
  }
  return { ...stats, note: `Đợt: ${batches.length}; hồ sơ đã hủy: ${stats.processed}; lỗi: ${stats.errors}` };
}

// Xóa nốt bản mã của phiên bản đã mất khóa mà chưa xóa trên đĩa (lần trước bị gián đoạn)
async function sweepPurge() {
  const [rows] = await pool.query(
    `SELECT v.id, v.storage_name FROM file_versions v JOIN files f ON f.id = v.file_id JOIN records r ON r.id = f.record_id
     WHERE v.wrapped_key IS NULL AND NOT v.is_purged AND r.status IN ('DISPOSED','CANCELLED')`);
  if (rows.length) await purgeBlobs(rows);
}

// Rút một hồ sơ khỏi đợt khi kiểm tra lần cuối không đạt; Chờ duyệt hủy → Hết hạn
async function withdrawItem(conn, audit, batch, item, why) {
  const reason = `${FINAL_CHECK_PREFIX}: ${why}`;
  await conn.query("UPDATE disposal_batch_records SET item_status = 'WITHDRAWN', exclusion_reason = ?, exclusion_requested = FALSE WHERE batch_id = ? AND record_id = ?",
    [reason, batch.id, item.record_id]);
  if (item.status === 'PENDING_DISPOSAL') await conn.query("UPDATE records SET status = 'EXPIRED' WHERE id = ?", [item.record_id]);
  await audit({ action: 'RECORD_DISPOSAL_WITHDRAW', objectType: 'RECORD', objectCode: item.code, details: { batch: batch.code, reason } });
  return { code: item.code, reason };
}

// Lý do hồ sơ không đạt kiểm tra lần cuối; null = đạt
const finalCheck = (r) => (r.status !== 'PENDING_DISPOSAL' ? 'hồ sơ không còn ở trạng thái Chờ duyệt hủy' : Number(r.is_on_hold) ? 'hồ sơ đang bị phong tỏa' : null);

// Hồ sơ còn trong đợt kèm trạng thái hiện tại (khóa dòng)
async function includedItems(conn, batchId) {
  const [rows] = await conn.query(
    `SELECT x.record_id, x.attempt_count, r.code, r.status, r.is_on_hold FROM disposal_batch_records x JOIN records r ON r.id = x.record_id
     WHERE x.batch_id = ? AND x.item_status = 'INCLUDED' ORDER BY r.code FOR UPDATE OF x, r`, [batchId]);
  return rows;
}

// Báo Cán bộ lập đợt và Trưởng phòng của phòng
async function notifyOfficerAndHead(conn, b, payload) {
  await notifyUsers(conn, [b.created_by], payload);
  await notifyDepartmentHead(conn, b.department_id, payload);
}

async function processBatch(batchId, stats) {
  // Bước 1: kiểm tra lần cuối trước khi bắt đầu; không còn hồ sơ đạt thì đợt về Nháp
  const started = await withTx(SYSTEM_ACTOR, async ({ conn, audit }) => {
    const [[b]] = await conn.query('SELECT * FROM disposal_batches WHERE id = ? FOR UPDATE', [batchId]);
    if (b.status !== 'APPROVED' || new Date(b.scheduled_at) > new Date()) return null;
    if (b.started_at) return b;
    const items = await includedItems(conn, batchId);
    const withdrawn = [];
    for (const it of items) {
      const why = finalCheck(it);
      if (why) withdrawn.push(await withdrawItem(conn, audit, b, it, why));
    }
    if (withdrawn.length === items.length) {
      const reason = 'Không còn hồ sơ đạt kiểm tra lần cuối';
      await conn.query(`UPDATE disposal_batches SET status = 'DRAFT', last_return_reason = ?, ${Object.keys(RESET_APPROVALS).map((k) => `${k} = NULL`).join(', ')} WHERE id = ?`,
        [reason, batchId]);
      await audit({ action: 'DISPOSAL_BATCH_RETURN_SYSTEM', objectType: 'DISPOSAL_BATCH', objectCode: b.code, details: { reason, withdrawn } });
      await notifyOfficerAndHead(conn, b, { type: 'SYSTEM_CHANGE', objectType: 'DISPOSAL_BATCH', objectCode: b.code,
        message: `Đợt hủy ${b.code} về Nháp: ${reason}` });
      return null;
    }
    await conn.query('UPDATE disposal_batches SET started_at = UTC_TIMESTAMP(3) WHERE id = ?', [batchId]);
    await audit({ action: 'DISPOSAL_BATCH_START', objectType: 'DISPOSAL_BATCH', objectCode: b.code,
      details: { records: items.length - withdrawn.length, withdrawn } });
    return b;
  });
  if (!started) return;

  // Bước 2: hủy từng hồ sơ trong giao dịch riêng; lỗi thì giữ Chờ duyệt hủy, ghi lỗi để thử lại
  const [pending] = await pool.query(
    `SELECT x.record_id, r.code FROM disposal_batch_records x JOIN records r ON r.id = x.record_id
     WHERE x.batch_id = ? AND x.item_status = 'INCLUDED' ORDER BY r.code`, [batchId]);
  for (const p of pending) {
    try {
      const versions = await withTx(SYSTEM_ACTOR, ({ conn, audit }) => disposeRecord(conn, audit, started, p.record_id));
      if (versions) {
        stats.processed++;
        await purgeBlobs(versions);
      }
    } catch (err) {
      stats.errors++;
      await recordFailure(started, p, err);
    }
  }

  // Bước 3: không còn hồ sơ chờ hủy thì lập biên bản và hoàn tất đợt
  let issued = null;
  try {
    await withTx(SYSTEM_ACTOR, async ({ conn, audit }) => {
      const [[b]] = await conn.query('SELECT * FROM disposal_batches WHERE id = ? FOR UPDATE', [batchId]);
      if (b.status !== 'APPROVED') return;
      const [[{ left, done }]] = await conn.query(
        "SELECT SUM(item_status = 'INCLUDED') AS `left`, SUM(item_status = 'DISPOSED') AS done FROM disposal_batch_records WHERE batch_id = ?", [batchId]);
      if (Number(left) > 0 || Number(done) === 0) return;
      issued = await issueCertificate(conn, batchId);
      await conn.query("UPDATE disposal_batches SET status = 'COMPLETED', completed_at = UTC_TIMESTAMP(3) WHERE id = ?", [batchId]);
      await audit({ action: 'CERTIFICATE_ISSUE', objectType: 'CERTIFICATE', objectCode: issued.certificateNo,
        details: { batch: b.code, pdfSha256: issued.sha256, contentSha256: issued.contentHash } });
      await audit({ action: 'DISPOSAL_BATCH_COMPLETE', objectType: 'DISPOSAL_BATCH', objectCode: b.code,
        details: { certificate: issued.certificateNo, disposed: Number(done) } });
      const payload = { type: 'REVIEW_RESULT', objectType: 'DISPOSAL_BATCH', objectCode: b.code,
        message: `Đợt hủy ${b.code} đã hoàn tất (${done} hồ sơ); biên bản ${issued.certificateNo}` };
      await notifyOfficerAndHead(conn, b, payload);
      await notifyRole(conn, 'DIRECTOR', payload);
    });
  } catch (err) {
    if (issued) await discardCertificateFile(issued.storageName);
    throw err;
  }
}

// Hủy một hồ sơ: kiểm tra lại, xóa khóa mọi phiên bản, che tiêu đề nếu nhãn có dữ liệu cá nhân, Đã hủy; trả về phiên bản cần xóa bản mã
async function disposeRecord(conn, audit, batch, recordId) {
  const [[r]] = await conn.query(
    `SELECT r.id, r.code, r.status, r.is_on_hold, v.contains_personal_data, x.item_status
     FROM records r JOIN label_versions v ON v.id = r.label_version_id
     JOIN disposal_batch_records x ON x.record_id = r.id AND x.batch_id = ? WHERE r.id = ? FOR UPDATE OF r, x`, [batch.id, recordId]);
  if (r.item_status !== 'INCLUDED') return null;
  const why = finalCheck(r);
  if (why) {
    await withdrawItem(conn, audit, batch, { record_id: r.id, code: r.code, status: r.status }, why);
    return null;
  }
  const versions = await destroyKeysOfRecord(conn, r.id);
  const personal = Boolean(Number(r.contains_personal_data));
  await conn.query(
    `UPDATE records SET status = 'DISPOSED', disposed_at = UTC_TIMESTAMP(3)${personal ? ', title = code, description = NULL, event_note = NULL' : ''} WHERE id = ?`,
    [r.id]);
  await conn.query("UPDATE disposal_batch_records SET item_status = 'DISPOSED', disposed_at = UTC_TIMESTAMP(3), last_error = NULL WHERE batch_id = ? AND record_id = ?",
    [batch.id, r.id]);
  await audit({ action: 'RECORD_DISPOSE', objectType: 'RECORD', objectCode: r.code,
    details: { batch: batch.code, keysDestroyed: versions.length, titleMasked: personal } });
  return versions;
}

// Ghi lỗi hủy để thử lại; từ lần thứ ALERT_AFTER thì báo Quản trị hệ thống và Cán bộ lưu trữ
async function recordFailure(batch, item, err) {
  logger.error({ err, record: item.code }, 'Thực hiện hủy: lỗi hồ sơ');
  try {
    await withTx(SYSTEM_ACTOR, async ({ conn, audit }) => {
      await conn.query('UPDATE disposal_batch_records SET attempt_count = LEAST(attempt_count + 1, 255), last_error = ? WHERE batch_id = ? AND record_id = ?',
        [String(err.message ?? err).slice(0, 500), batch.id, item.record_id]);
      const [[{ attempt_count: n }]] = await conn.query('SELECT attempt_count FROM disposal_batch_records WHERE batch_id = ? AND record_id = ?', [batch.id, item.record_id]);
      await audit({ action: 'RECORD_DISPOSE', objectType: 'RECORD', objectCode: item.code, result: 'FAILURE',
        details: { batch: batch.code, attempt: n, error: String(err.code ?? err.message ?? err).slice(0, 200) } });
      if (n >= ALERT_AFTER) {
        const payload = { type: 'SECURITY_ALERT', objectType: 'DISPOSAL_BATCH', objectCode: batch.code,
          message: `Hủy hồ sơ ${item.code} (đợt ${batch.code}) lỗi ${n} lần; cần kiểm tra kho lưu trữ` };
        await notifyRole(conn, 'SYSTEM_ADMIN', payload);
        await notifyRole(conn, 'RECORDS_OFFICER', payload);
      }
    });
  } catch (e) {
    logger.error({ err: e }, 'Không ghi được lỗi hủy');
  }
}
