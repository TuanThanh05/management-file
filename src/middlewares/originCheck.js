import { env } from '../config/env.js';
import { AppError } from '../core/errors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Chặn CSRF lớp 2: request ghi có header Origin lạ (không thuộc CORS_ORIGINS) thì từ chối
export function originCheck(req, res, next) {
  const origin = req.get('origin');
  if (SAFE_METHODS.has(req.method) || !origin) return next();
  const self = `${req.protocol}://${req.get('host')}`;
  if (origin === self || env.corsOrigins.includes(origin)) return next();
  next(new AppError(403, 'BAD_ORIGIN', 'Nguồn gửi yêu cầu không hợp lệ'));
}
