import { defineConfig } from 'vitest/config';

// Test chạy tuần tự trên CSDL thật; globalSetup kiểm tra kết nối trước
export default defineConfig({
  test: {
    environment: 'node',
    env: {
      NODE_ENV: 'test',
      JWT_SECRET: 'test-secret-only-for-vitest-0123456789abcdef',
      COOKIE_SECURE: 'false',
      LOGIN_RATE_LIMIT: '1000',
      MASTER_KEY_BASE64: 'dGVzdC1tYXN0ZXIta2V5LTMyLWJ5dGVzLW9ubHkhISE=',
      STORAGE_DIR: './storage-test',
      BACKUP_DIR: './backups-test',
      BACKUP_KEY_BASE64: 'dGVzdC1iYWNrdXAta2V5LTMyLWJ5dGVzLW9ubHkhISE=',
      BACKUP_DB_PASSWORD: 'ChangeMe_Backup_2026!',
    },
    globalSetup: ['./tests/setup/global-setup.js'],
    fileParallelism: false,
    testTimeout: 30000,
  },
});
