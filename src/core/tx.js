import { pool } from '../config/database.js';
import { isRetryableDbError } from './errors.js';
import { logger } from './logger.js';

// Người thực hiện cho tác vụ hệ thống (job, khởi tạo)
export const SYSTEM_ACTOR = Object.freeze({ userId: null, roles: 'SYSTEM', ip: null });

// Lấy actor { userId, roles, ip } từ request đã đăng nhập
export function actorFromReq(req) {
  return { userId: req.user?.id ?? null, roles: req.user?.roles ?? null, ip: req.ip ?? null };
}

function rolesToString(roles) {
  if (!roles) return null;
  return Array.isArray(roles) ? roles.join(',') : String(roles);
}

// Ghi 1 dòng nhật ký qua sp_write_audit_log trong transaction đang mở (không ghi mật khẩu, khóa)
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

// Chạy fn trong transaction: thành công thì commit cả dữ liệu và nhật ký, lỗi thì rollback hết; deadlock thì thử lại
export async function withTx(actor, fn, { retries = 2 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const out = await fn({ conn, actor, audit: (entry) => writeAudit(conn, actor, entry) });
      await conn.commit();
      return out;
    } catch (err) {
      try {
        await conn.rollback();
      } catch (rbErr) {
        logger.error({ err: rbErr }, 'Rollback failed');
      }
      if (isRetryableDbError(err) && attempt < retries) continue;
      throw err;
    } finally {
      conn.release();
    }
  }
}

// Ghi nhật ký FAILURE trong transaction riêng khi thao tác chính đã rollback; không ném lỗi ra ngoài
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
