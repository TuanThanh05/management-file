import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate.js';
import { authorize } from '../../middlewares/authorize.js';
import { validate } from '../../middlewares/validate.js';
import * as s from './schema.js';
import * as ctrl from './controller.js';

// Nhóm API /api/disposals: lập đợt hủy (Cán bộ lưu trữ), duyệt cấp 1 (Trưởng phòng), cấp 2 và thu hồi (Giám đốc), tải biên bản – QT4.1, QT4.2
export const disposalRoutes = Router();
disposalRoutes.use(authenticate());

const manage = authorize('DISPOSAL.MANAGE');
const level1 = authorize('DISPOSAL.APPROVE_LEVEL_1');
const level2 = authorize('DISPOSAL.APPROVE_LEVEL_2');
const p = { params: s.codeParam };

disposalRoutes.get('/', authorize('DISPOSAL.VIEW'), validate({ query: s.listBatchesQuery }), ctrl.listBatches);
disposalRoutes.post('/', manage, validate({ body: s.createBatchSchema }), ctrl.createBatch);
disposalRoutes.get('/:code', authorize('DISPOSAL.VIEW'), validate(p), ctrl.getBatch);
disposalRoutes.patch('/:code', manage, validate({ ...p, body: s.updateBatchSchema }), ctrl.updateBatch);
disposalRoutes.post('/:code/cancel', manage, validate({ ...p, body: s.reasonSchema }), ctrl.cancelBatch);
disposalRoutes.post('/:code/submit', manage, validate(p), ctrl.submitBatch);
disposalRoutes.post('/:code/exclusions', level1, validate({ ...p, body: s.exclusionSchema }), ctrl.requestExclusion);
disposalRoutes.post('/:code/exclusions/remove', level1, validate({ ...p, body: s.removeExclusionSchema }), ctrl.removeExclusion);
disposalRoutes.post('/:code/approve-level-1', level1, validate({ ...p, body: s.approveSchema }), ctrl.approveLevel1);
disposalRoutes.post('/:code/return-level-1', level1, validate({ ...p, body: s.reasonSchema }), ctrl.returnLevel1);
disposalRoutes.post('/:code/approve-level-2', level2, validate({ ...p, body: s.approveSchema }), ctrl.approveLevel2);
disposalRoutes.post('/:code/return-level-2', level2, validate({ ...p, body: s.reasonSchema }), ctrl.returnLevel2);
disposalRoutes.post('/:code/revoke', authorize('DISPOSAL.REVOKE'), validate({ ...p, body: s.revokeSchema }), ctrl.revokeBatch);
disposalRoutes.get('/:code/certificate', authorize('CERTIFICATE.DOWNLOAD'), validate(p), ctrl.downloadCertificate);
