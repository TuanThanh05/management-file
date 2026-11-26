import pino from 'pino';
import { env } from '../config/env.js';

// Log ứng dụng (tách khỏi audit_logs); che cookie, token, mật khẩu
export const logger = pino({
  level: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]', '*.password', '*.password_hash', '*.token'],
    censor: '[REDACTED]',
  },
  transport: env.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
});
