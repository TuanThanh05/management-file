import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate.js';
import { authorize } from '../../middlewares/authorize.js';
import { validate } from '../../middlewares/validate.js';
import * as s from './schema.js';
import * as ctrl from './controller.js';

// Nhóm API /api/reports: thống kê hồ sơ theo phạm vi (BM13)
export const reportRoutes = Router();
reportRoutes.use(authenticate());

reportRoutes.get('/summary', authorize('REPORT.VIEW'), validate({ query: s.summaryQuery }), ctrl.summary);
