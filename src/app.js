import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import pinoHttp from 'pino-http';
import { randomUUID } from 'node:crypto';
import { env } from './config/env.js';
import { pingDb } from './config/database.js';
import { logger } from './core/logger.js';
import { errorHandler, notFoundHandler } from './core/errors.js';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  // Chạy sau reverse proxy (nginx) thì bật để lấy đúng IP người dùng cho nhật ký
  app.set('trust proxy', 'loopback');

  app.use(helmet());
  app.use(cors({ origin: env.corsOrigins, credentials: true }));
  app.use(express.json({ limit: '100kb' })); // file upload đi qua multer, không qua đây
  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const id = randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
    }),
  );

  // Kiểm tra sống: không cần đăng nhập, không lộ thông tin nhạy cảm
  app.get('/api/health', async (req, res, next) => {
    try {
      const db = await pingDb();
      res.json({ status: 'ok', db: db.ok ? 'ok' : 'error', time: new Date().toISOString() });
    } catch (err) {
      next(err);
    }
  });

  // Các module nghiệp vụ gắn từ ngày 2 trở đi:
  // app.use('/api/auth', authRoutes);
  // app.use('/api/admin', adminRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
