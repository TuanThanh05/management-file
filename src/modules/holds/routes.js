import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate.js';
import { authorize } from '../../middlewares/authorize.js';
import { validate } from '../../middlewares/validate.js';
import { uploadSingle } from '../../middlewares/upload.js';
import * as s from './schema.js';
import * as ctrl from './controller.js';

// Nhóm API /api/holds: Giám đốc đặt, gỡ, tra cứu lệnh phong tỏa (QT3.3, BM04)
export const holdRoutes = Router();
holdRoutes.use(authenticate(), authorize('HOLD.MANAGE'));

holdRoutes.get('/', validate({ query: s.listHoldsQuery }), ctrl.listHolds);
holdRoutes.post('/', uploadSingle('evidence', { optional: true }), validate({ body: s.placeHoldSchema }), ctrl.placeHold);
holdRoutes.get('/:code', validate({ params: s.codeParam }), ctrl.getHold);
holdRoutes.get('/:code/evidence', validate({ params: s.codeParam }), ctrl.getEvidence);
holdRoutes.post('/:code/release', validate({ params: s.codeParam, body: s.releaseHoldSchema }), ctrl.releaseHold);
