import { env } from './config/env.js';
import { pingDb, closeDb } from './config/database.js';
import { logger } from './core/logger.js';
import { createApp } from './app.js';

async function main() {
  // Không kết nối được CSDL thì không mở cổng
  await pingDb();
  const server = createApp().listen(env.PORT, () => {
    logger.info(`API chạy tại http://localhost:${env.PORT}`);
  });

  const shutdown = (signal) => {
    logger.info(`Nhận ${signal}, đang dừng...`);
    server.close(async () => {
      await closeDb();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.fatal({ err }, 'Không khởi động được server');
  process.exit(1);
});
