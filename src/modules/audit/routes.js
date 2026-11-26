import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate.js';
import { authorize } from '../../middlewares/authorize.js';
import { validate } from '../../middlewares/validate.js';
import * as s from './schema.js';
import * as ctrl from './controller.js';

// Nhóm API /api/audit: xem nhật ký (chỉ đọc) và kiểm tra toàn vẹn chuỗi băm – Giám đốc, Quản trị hệ thống
export const auditRoutes = Router();
auditRoutes.use(authenticate());

auditRoutes.get('/logs', authorize('AUDIT.VIEW'), validate({ query: s.logsQuery }), ctrl.listLogs);
auditRoutes.post('/verify', authorize('AUDIT.VERIFY'), validate({ body: s.verifySchema }), ctrl.verifyChain);
auditRoutes.get('/checks', authorize('AUDIT.VERIFY'), validate({ query: s.checksQuery }), ctrl.listChecks);
