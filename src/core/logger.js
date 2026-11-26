import pino from 'pino';
import { env } from '../config/env.js';

// Log ứng dụng (khác với nhật ký nghiệp vụ audit_logs trong CSDL).
// Không bao giờ ghi mật khẩu, token hay nội dung file ra log.
export const logger = pino({
  level: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.password_hash', '*.token'],
    censor: '[REDACTED]',
  },
  transport: env.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
});
