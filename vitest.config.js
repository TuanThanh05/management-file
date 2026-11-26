import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    env: { NODE_ENV: 'test' },
    // Các test dùng chung một CSDL thật nên chạy tuần tự
    fileParallelism: false,
    testTimeout: 20000,
  },
});
