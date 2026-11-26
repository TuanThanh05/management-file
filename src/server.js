import { env } from './config/env.js';
import { pingDb, closeDb } from './config/database.js';
import { logger } from './core/logger.js';
import { createApp } from './app.js';
import { startScheduler } from './jobs/scheduler.js';

// Kiểm tra CSDL, mở cổng, bật tác vụ định kỳ; dừng êm khi nhận SIGINT/SIGTERM
async function main() {
  await pingDb();
  const server = createApp().listen(env.PORT, () => logger.info(`API chạy tại http://localhost:${env.PORT}`));
  const stopJobs = startScheduler();

  const shutdown = (signal) => {
    logger.info(`Nhận ${signal}, đang dừng...`);
    stopJobs();
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
