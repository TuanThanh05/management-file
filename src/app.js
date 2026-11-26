import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import { randomUUID } from 'node:crypto';
import { env } from './config/env.js';
import { pingDb } from './config/database.js';
import { logger } from './core/logger.js';
import { errorHandler, notFoundHandler } from './core/errors.js';
import { originCheck } from './middlewares/originCheck.js';
import { authRoutes } from './modules/auth/routes.js';

// Tạo ứng dụng Express với middleware bảo mật và các nhóm API
export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');

  app.use(helmet());
  app.use(cors({ origin: env.corsOrigins, credentials: true }));
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());
  app.use(pinoHttp({
    logger,
    genReqId: (req, res) => {
      const id = randomUUID();
      res.setHeader('X-Request-Id', id);
      return id;
    },
  }));
  app.use(originCheck);

  // Kiểm tra sống, không cần đăng nhập
  app.get('/api/health', async (req, res) => {
    const db = await pingDb();
    res.json({ status: 'ok', db: db.ok ? 'ok' : 'error', time: new Date().toISOString() });
  });

  app.use('/api/auth', authRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
