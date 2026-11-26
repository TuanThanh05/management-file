import { pool } from '../config/database.js';
import { isRetryableDbError } from './errors.js';
import { logger } from './logger.js';

/**
 * actor: ai đang thực hiện thao tác, dùng để ghi nhật ký.
 *   { userId: number|null, roles: string[]|string|null, ip: string|null }
 *   userId = null khi là tác vụ hệ thống (job định kỳ, khởi tạo).
 */
export const SYSTEM_ACTOR = Object.freeze({ userId: null, roles: 'SYSTEM', ip: null });

function rolesToString(roles) {
  if (!roles) return null;
  return Array.isArray(roles) ? roles.join(',') : String(roles);
}

/**
 * Ghi một dòng nhật ký bằng kết nối đang mở transaction (gọi sp_write_audit_log).
 * Không tự commit: dòng nhật ký sống/chết cùng thao tác nghiệp vụ.
 * details: object giá trị trước/sau. TUYỆT ĐỐI không đưa mật khẩu, khóa, nội dung file vào.
 */
export async function writeAudit(conn, actor, { action, objectType = null, objectCode = null, result = 'SUCCESS', details = null }) {
  await conn.query('CALL sp_write_audit_log(?, ?, ?, ?, ?, ?, ?, ?, @audit_seq)', [
    actor?.userId ?? null,
    rolesToString(actor?.roles),
    actor?.ip ?? null,
    action,
    objectType,
    objectCode,
    result,
    details == null ? null : JSON.stringify(details),
  ]);
  const [[{ seq }]] = await conn.query('SELECT @audit_seq AS seq');
  return Number(seq);
}

/**
 * Chạy fn trong một transaction.
 *   const out = await withTx(actor, async (tx) => {
 *     await tx.conn.query('UPDATE ...');
 *     await tx.audit({ action: 'RECORD_CREATE', objectType: 'RECORD', objectCode: code, details });
 *     return something;
 *   });
 * - fn thành công  -> COMMIT (dữ liệu + nhật ký cùng lúc).
 * - fn ném lỗi     -> ROLLBACK toàn bộ, kể cả dòng nhật ký đã ghi; lỗi được ném tiếp.
 * - Deadlock / lock wait timeout -> tự thử lại tối đa `retries` lần (fn phải chạy lại được an toàn).
 */
export async function withTx(actor, fn, { retries = 2 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const tx = {
        conn,
        actor,
        audit: (entry) => writeAudit(conn, actor, entry),
      };
      const out = await fn(tx);
      await conn.commit();
      return out;
    } catch (err) {
      try {
        await conn.rollback();
      } catch (rbErr) {
        logger.error({ err: rbErr }, 'Rollback failed');
      }
      if (isRetryableDbError(err) && attempt < retries) {
        logger.warn({ attempt, errno: err.errno }, 'Retrying transaction');
        continue;
      }
      throw err;
    } finally {
      conn.release();
    }
  }
}

/**
 * Ghi nhật ký THẤT BẠI trong transaction riêng, dùng khi thao tác chính đã rollback
 * nhưng vẫn phải để lại dấu vết (đăng nhập sai, bị từ chối quyền, vi phạm quy tắc...).
 * Không ném lỗi ra ngoài để không che mất lỗi gốc.
 */
export async function auditFailure(actor, { action, objectType = null, objectCode = null, error, details = null }) {
  try {
    await withTx(actor, (tx) =>
      tx.audit({
        action,
        objectType,
        objectCode,
        result: 'FAILURE',
        details: { ...(details ?? {}), reason: error?.code ?? error?.message ?? String(error) },
      }),
    );
  } catch (err) {
    logger.error({ err, action }, 'Could not write failure audit');
  }
}
