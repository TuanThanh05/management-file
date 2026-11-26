import 'dotenv/config';
import { z } from 'zod';

// Kiểm tra biến môi trường ngay khi khởi động: thiếu hoặc sai là dừng luôn, không chạy nửa vời.
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
  JWT_SECRET: z.string().optional(),
  MASTER_KEY_BASE64: z.string().optional(),
  STORAGE_DIR: z.string().default('./storage'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Cấu hình .env không hợp lệ:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = {
  ...parsed.data,
  corsOrigins: parsed.data.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
};
