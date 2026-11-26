import { AppError } from '../core/errors.js';
import { auditFailure, actorFromReq } from '../core/tx.js';

// Kiểm tra quyền theo ma trận role_permissions (không có = từ chối); gắn req.scope = OWN | DEPARTMENT | ALL
export function authorize(permissionCode) {
  return async (req, res, next) => {
    const scope = req.user?.permissions?.[permissionCode];
    if (!scope) {
      await auditFailure(actorFromReq(req), {
        action: 'ACCESS_DENIED', objectType: 'PERMISSION', objectCode: permissionCode,
        error: { code: 'FORBIDDEN' }, details: { method: req.method, path: req.originalUrl.slice(0, 200) },
      });
      return next(AppError.forbidden());
    }
    req.scope = scope;
    next();
  };
}

// Cho qua nếu có ít nhất một trong các quyền (dùng cho API chỉ đọc danh mục dùng chung)
export function authorizeAny(...permissionCodes) {
  return async (req, res, next) => {
    const code = permissionCodes.find((c) => req.user?.permissions?.[c]);
    if (!code) {
      await auditFailure(actorFromReq(req), {
        action: 'ACCESS_DENIED', objectType: 'PERMISSION', objectCode: permissionCodes.join('|').slice(0, 50),
        error: { code: 'FORBIDDEN' }, details: { method: req.method, path: req.originalUrl.slice(0, 200) },
      });
      return next(AppError.forbidden());
    }
    req.scope = req.user.permissions[code];
    next();
  };
}

// Sinh điều kiện WHERE theo phạm vi dữ liệu của người dùng
export function scopeFilter(req, { departmentColumn, ownerColumn } = {}) {
  switch (req.scope) {
    case 'ALL':
      return { sql: '1 = 1', params: [] };
    case 'DEPARTMENT':
      if (!departmentColumn) throw new Error('scopeFilter: thiếu departmentColumn');
      return { sql: `${departmentColumn} = ?`, params: [req.user.departmentId] };
    case 'OWN':
      if (!ownerColumn) throw new Error('scopeFilter: thiếu ownerColumn');
      return { sql: `${ownerColumn} = ?`, params: [req.user.id] };
    default:
      throw new Error('scopeFilter: chưa qua authorize');
  }
}
