import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate.js';
import { authorize } from '../../middlewares/authorize.js';
import { validate } from '../../middlewares/validate.js';
import * as s from './schema.js';
import * as ctrl from './controller.js';

// Nhóm API /api/extensions: Nhân viên lập đề xuất gia hạn, Trưởng phòng duyệt / từ chối, Cán bộ lưu trữ theo dõi (QT3.2)
export const extensionRoutes = Router();
extensionRoutes.use(authenticate());

extensionRoutes.get('/', authorize('EXTENSION.VIEW'), validate({ query: s.listExtensionsQuery }), ctrl.listExtensions);
extensionRoutes.post('/', authorize('EXTENSION.REQUEST'), validate({ body: s.createExtensionSchema }), ctrl.createExtension);
extensionRoutes.get('/:code', authorize('EXTENSION.VIEW'), validate({ params: s.codeParam }), ctrl.getExtension);
extensionRoutes.post('/:code/approve', authorize('EXTENSION.APPROVE'), validate({ params: s.codeParam, body: s.approveExtensionSchema }), ctrl.approveExtension);
extensionRoutes.post('/:code/reject', authorize('EXTENSION.APPROVE'), validate({ params: s.codeParam, body: s.rejectExtensionSchema }), ctrl.rejectExtension);
