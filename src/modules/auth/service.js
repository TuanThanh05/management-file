import { randomUUID } from 'node:crypto';
import { withTx, writeAudit } from '../../core/tx.js';
import { AppError } from '../../core/errors.js';
import { getSettings } from '../../core/settings.js';
import { hashPassword, verifyPassword, dummyVerify, checkNewPassword } from '../../core/password.js';
import { signSessionToken } from '../../core/session.js';
import * as repo from './repo.js';

const INVALID_LOGIN_MESSAGE = 'Tên đăng nhập hoặc mật khẩu không đúng';

// Mã đối tượng USER trong nhật ký (cột object_code tối đa 50 ký tự)
const userCode = (email) => email.slice(0, 50);

// Tạo phiên mới trong transaction và ký JWT tương ứng
async function issueSession(conn, { userId, hours, ip, userAgent }) {
  const session = await repo.createSession(conn, { id: randomUUID(), userId, hours, ip, userAgent });
  const expiresInSec = hours * 3600;
  return {
    token: signSessionToken({ userId, sessionId: session.id, expiresInSec }),
    maxAgeMs: expiresInSec * 1000,
    expiresAt: session.expiresAt,
  };
}

// Đăng nhập (5.1 mục 1): mọi lỗi trả một câu chung, mọi lần thành công/thất bại đều ghi nhật ký
export async function login({ email, password, ip, userAgent }) {
  const outcome = await withTx({ userId: null, roles: null, ip }, async ({ conn }) => {
    const s = await getSettings(conn, ['MAX_FAILED_LOGINS', 'LOGIN_LOCK_MINUTES', 'SESSION_HOURS']);
    const user = await repo.findUserForLogin(conn, email);

    if (!user) {
      await dummyVerify(password);
      await writeAudit(conn, { ip }, {
        action: 'LOGIN_FAILED', objectType: 'USER', objectCode: userCode(email), result: 'FAILURE',
        details: { reason: 'UNKNOWN_ACCOUNT' },
      });
      return { ok: false };
    }

    const actor = { userId: user.id, roles: await repo.getRoleCodes(conn, user.id), ip };
    const fail = async (reason, extra = {}) => {
      await writeAudit(conn, actor, {
        action: 'LOGIN_FAILED', objectType: 'USER', objectCode: userCode(user.email), result: 'FAILURE',
        details: { reason, ...extra },
      });
      return { ok: false };
    };

    if (user.status !== 'ACTIVE') {
      await dummyVerify(password);
      return fail('ACCOUNT_LOCKED');
    }
    if (user.is_temp_locked) {
      await dummyVerify(password);
      return fail('TEMPORARILY_LOCKED');
    }
    if (!(await verifyPassword(password, user.password_hash))) {
      const r = await repo.recordFailedLogin(conn, user.id, { maxFailed: s.MAX_FAILED_LOGINS, lockMinutes: s.LOGIN_LOCK_MINUTES });
      return fail('WRONG_PASSWORD', r.lockedNow ? { lockedMinutes: s.LOGIN_LOCK_MINUTES } : { failedCount: r.failedCount });
    }

    await repo.recordSuccessfulLogin(conn, user.id);
    const issued = await issueSession(conn, { userId: user.id, hours: s.SESSION_HOURS, ip, userAgent });
    await writeAudit(conn, actor, { action: 'LOGIN_SUCCESS', objectType: 'USER', objectCode: userCode(user.email) });
    return { ok: true, issued, mustChangePassword: user.must_change_password };
  });

  if (!outcome.ok) throw new AppError(401, 'INVALID_CREDENTIALS', INVALID_LOGIN_MESSAGE);
  return { ...outcome.issued, mustChangePassword: outcome.mustChangePassword };
}

// Đăng xuất: thu hồi phiên hiện tại
export async function logout(user, actor) {
  await withTx(actor, async ({ conn, audit }) => {
    await repo.revokeSession(conn, user.sessionId, 'LOGOUT');
    await audit({ action: 'LOGOUT', objectType: 'USER', objectCode: userCode(user.email) });
  });
}

// Đổi mật khẩu (5.1 mục 2, BM09): kiểm tra quy tắc, lưu bcrypt, hủy mọi phiên cũ, cấp phiên mới
export async function changePassword(user, actor, { currentPassword, newPassword, confirmPassword }, { userAgent }) {
  const ruleErrors = checkNewPassword({ email: user.email, currentPassword, newPassword, confirmPassword });
  if (ruleErrors.length) throw AppError.unprocessable('Mật khẩu mới không hợp lệ', ruleErrors);
  const newHash = await hashPassword(newPassword);

  const outcome = await withTx(actor, async ({ conn, audit }) => {
    const row = await repo.findPasswordHashForUpdate(conn, user.id);
    if (!(await verifyPassword(currentPassword, row.password_hash))) {
      await audit({ action: 'PASSWORD_CHANGE', objectType: 'USER', objectCode: userCode(user.email), result: 'FAILURE',
        details: { reason: 'WRONG_CURRENT_PASSWORD' } });
      return { ok: false };
    }
    const s = await getSettings(conn, ['SESSION_HOURS']);
    await repo.updatePassword(conn, user.id, newHash);
    const revoked = await repo.revokeAllSessions(conn, user.id, 'PASSWORD_CHANGED');
    const issued = await issueSession(conn, { userId: user.id, hours: s.SESSION_HOURS, ip: actor.ip, userAgent });
    await audit({ action: 'PASSWORD_CHANGE', objectType: 'USER', objectCode: userCode(user.email), details: { revokedSessions: revoked } });
    return { ok: true, issued };
  });

  if (!outcome.ok) {
    throw AppError.unprocessable('Mật khẩu hiện tại không đúng', [{ field: 'currentPassword', message: 'Mật khẩu hiện tại không đúng' }]);
  }
  return outcome.issued;
}

// Thông tin người đang đăng nhập cho GET /me
export function toMe(user) {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    department: user.department,
    roles: user.roleList,
    permissions: Object.entries(user.permissions).map(([code, scope]) => ({ code, scope })),
    mustChangePassword: user.mustChangePassword,
    sessionExpiresAt: user.sessionExpiresAt,
  };
}
