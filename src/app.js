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
import { adminRoutes } from './modules/admin/routes.js';
import { catalogRoutes } from './modules/catalog/routes.js';
import { labelRoutes } from './modules/labels/routes.js';
import { recordRoutes } from './modules/records/routes.js';
import { retentionRoutes } from './modules/retention/routes.js';
import { extensionRoutes } from './modules/extensions/routes.js';
import { holdRoutes } from './modules/holds/routes.js';
import { notificationRoutes } from './modules/notifications/routes.js';
import { disposalRoutes } from './modules/disposals/routes.js';
import { auditRoutes } from './modules/audit/routes.js';

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
  app.use('/api/admin', adminRoutes);
  app.use('/api/catalog', catalogRoutes);
  app.use('/api/labels', labelRoutes);
  app.use('/api/records', recordRoutes);
  app.use('/api/retention', retentionRoutes);
  app.use('/api/extensions', extensionRoutes);
  app.use('/api/holds', holdRoutes);
  app.use('/api/notifications', notificationRoutes);
  app.use('/api/disposals', disposalRoutes);
  app.use('/api/audit', auditRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
