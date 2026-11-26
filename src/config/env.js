import 'dotenv/config';
import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

// Kiểm tra biến môi trường khi khởi động, sai là dừng
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.string().default('info'),
  DB_HOST: z.string().default('127.0.0.1'),
  DB_PORT: z.coerce.number().int().positive().default(3306),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().min(1),
  DB_NAME: z.string().default('records_retention'),
  DB_POOL_SIZE: z.coerce.number().int().positive().default(10),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET cần tối thiểu 32 ký tự'),
  COOKIE_SECURE: bool.default('true'),
  LOGIN_RATE_LIMIT: z.coerce.number().int().positive().default(10),
  MASTER_KEY_BASE64: z.string().refine((v) => Buffer.from(v, 'base64').length === 32, 'MASTER_KEY_BASE64 phải là 32 byte mã hóa base64'),
  STORAGE_DIR: z.string().default('./storage'),
  BACKUP_DIR: z.string().default('./backups'),
  BACKUP_KEY_BASE64: z.string().refine((v) => Buffer.from(v, 'base64').length === 32, 'BACKUP_KEY_BASE64 phải là 32 byte mã hóa base64').optional(),
  BACKUP_DB_USER: z.string().default('backup_retention'),
  BACKUP_DB_PASSWORD: z.string().optional(),
  MYSQLDUMP_PATH: z.string().default('mysqldump'),
}).refine((v) => !v.BACKUP_KEY_BASE64 || v.BACKUP_KEY_BASE64 !== v.MASTER_KEY_BASE64, {
  path: ['BACKUP_KEY_BASE64'], message: 'Khóa sao lưu phải khác khóa chủ',
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Cấu hình .env không hợp lệ:', z.flattenError(parsed.error).fieldErrors);
  process.exit(1);
}

export const env = {
  ...parsed.data,
  corsOrigins: parsed.data.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
  backupEnabled: Boolean(parsed.data.BACKUP_KEY_BASE64 && parsed.data.BACKUP_DB_PASSWORD),
};
