import rateLimit from 'express-rate-limit';
import { env } from '../config/env.js';
import { AppError } from '../core/errors.js';

// Giới hạn số lần gọi đăng nhập mỗi IP trong 1 phút (bổ sung cho khóa theo tài khoản)
export const loginRateLimit = rateLimit({
  windowMs: 60_000,
  limit: env.LOGIN_RATE_LIMIT,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (req, res, next) => next(new AppError(429, 'TOO_MANY_REQUESTS', 'Gửi yêu cầu quá nhiều lần, vui lòng thử lại sau')),
});
