import { AppError } from '../core/errors.js';
import { logger } from '../core/logger.js';
import { SESSION_COOKIE, verifySessionToken, clearSessionCookie } from '../core/session.js';
import { loadAuthContext, touchSession } from '../modules/auth/repo.js';

// Xác thực từ cookie phiên: JWT hợp lệ, phiên chưa thu hồi/chưa hết hạn, tài khoản hoạt động; gắn req.user
export function authenticate({ allowMustChange = false } = {}) {
  return async (req, res, next) => {
    const claims = verifySessionToken(req.cookies?.[SESSION_COOKIE] ?? '');
    const ctx = claims && (await loadAuthContext(claims.userId, claims.sessionId));
    if (!ctx) {
      if (req.cookies?.[SESSION_COOKIE]) clearSessionCookie(res);
      return next(AppError.unauthorized());
    }
    if (ctx.needs_touch) touchSession(claims.sessionId).catch((err) => logger.warn({ err }, 'touchSession failed'));

    req.user = {
      id: ctx.id,
      email: ctx.email,
      fullName: ctx.full_name,
      departmentId: ctx.department_id,
      department: { id: ctx.department_id, code: ctx.department_code, name: ctx.department_name },
      roles: ctx.roles.map((r) => r.code),
      roleList: ctx.roles,
      permissions: Object.fromEntries(ctx.perms.map((p) => [p.permission_code, p.scope])),
      mustChangePassword: ctx.must_change_password,
      sessionId: claims.sessionId,
      sessionExpiresAt: ctx.expires_at,
    };

    if (req.user.mustChangePassword && !allowMustChange) {
      return next(new AppError(403, 'PASSWORD_CHANGE_REQUIRED', 'Cần đổi mật khẩu trước khi sử dụng hệ thống'));
    }
    next();
  };
}
