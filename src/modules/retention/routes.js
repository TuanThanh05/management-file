import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate.js';
import { authorize } from '../../middlewares/authorize.js';
import { validate } from '../../middlewares/validate.js';
import * as s from './schema.js';
import * as ctrl from './controller.js';

// Nhóm API /api/retention: cảnh báo hạn (Trưởng phòng), rà soát hồ sơ hết hạn và đánh dấu đủ điều kiện hủy (Cán bộ lưu trữ)
export const retentionRoutes = Router();
retentionRoutes.use(authenticate());

retentionRoutes.get('/alerts', authorize('RECORD.VIEW_EXPIRY_ALERTS'), ctrl.expiryAlerts);
retentionRoutes.get('/expired', authorize('RECORD.REVIEW_EXPIRED'), validate({ query: s.expiredQuery }), ctrl.listExpired);
retentionRoutes.post('/eligibility', authorize('RECORD.MARK_ELIGIBLE'), validate({ body: s.eligibleSchema }), ctrl.setEligibility);
