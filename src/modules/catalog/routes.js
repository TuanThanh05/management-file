import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate.js';
import { authorize, authorizeAny } from '../../middlewares/authorize.js';
import { validate } from '../../middlewares/validate.js';
import * as s from './schema.js';
import * as ctrl from './controller.js';

// Nhóm API /api/catalog: ghi chỉ Cán bộ lưu trữ (CATALOG.MANAGE); đọc cho ai cần chọn loại tài liệu
export const catalogRoutes = Router();
catalogRoutes.use(authenticate());

const manage = authorize('CATALOG.MANAGE');
const read = authorizeAny('CATALOG.MANAGE', 'LABEL.VIEW', 'RECORD.CREATE', 'RECORD.VIEW');

catalogRoutes.get('/groups', read, ctrl.listGroups);
catalogRoutes.post('/groups', manage, validate({ body: s.createGroupSchema }), ctrl.createGroup);
catalogRoutes.patch('/groups/:code', manage, validate({ params: s.codeParam, body: s.updateGroupSchema }), ctrl.updateGroup);
catalogRoutes.post('/groups/:code/deactivate', manage, validate({ params: s.codeParam }), ctrl.deactivateGroup);
catalogRoutes.post('/groups/:code/activate', manage, validate({ params: s.codeParam }), ctrl.activateGroup);

catalogRoutes.get('/document-types', read, validate({ query: s.listTypesQuery }), ctrl.listTypes);
catalogRoutes.get('/document-types/:code', read, validate({ params: s.codeParam }), ctrl.getType);
catalogRoutes.post('/document-types', manage, validate({ body: s.createTypeSchema }), ctrl.createType);
catalogRoutes.patch('/document-types/:code', manage, validate({ params: s.codeParam, body: s.updateTypeSchema }), ctrl.updateType);
catalogRoutes.post('/document-types/:code/deactivate', manage, validate({ params: s.codeParam }), ctrl.deactivateType);
catalogRoutes.post('/document-types/:code/activate', manage, validate({ params: s.codeParam }), ctrl.activateType);
