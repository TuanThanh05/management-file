import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middlewares/authenticate.js';
import { authorize } from '../../middlewares/authorize.js';
import { validate } from '../../middlewares/validate.js';
import { uploadSingle } from '../../middlewares/upload.js';
import * as s from './schema.js';
import * as ctrl from './controller.js';

// Nhóm API /api/records: tạo, sửa, hủy bỏ hồ sơ; tải lên, gỡ, xem, tải về file
export const recordRoutes = Router();
recordRoutes.use(authenticate());

const previewQuery = z.object({
  documentTypeCode: s.createRecordSchema.shape.documentTypeCode,
  documentDate: s.createRecordSchema.shape.documentDate,
  eventEndDate: s.createRecordSchema.shape.eventEndDate,
});

recordRoutes.get('/expiry-preview', authorize('RECORD.CREATE'), validate({ query: previewQuery }), ctrl.previewExpiry);
recordRoutes.post('/', authorize('RECORD.CREATE'), validate({ body: s.createRecordSchema }), ctrl.createRecord);
recordRoutes.get('/:code', authorize('RECORD.VIEW'), validate({ params: s.codeParam }), ctrl.getRecord);
recordRoutes.patch('/:code', authorize('RECORD.UPDATE'), validate({ params: s.codeParam, body: s.updateRecordSchema }), ctrl.updateRecord);
recordRoutes.post('/:code/cancel', authorize('RECORD.CANCEL'), validate({ params: s.codeParam, body: s.cancelRecordSchema }), ctrl.cancelRecord);

recordRoutes.post('/:code/files', authorize('RECORD.UPDATE'), validate({ params: s.codeParam }), uploadSingle(), ctrl.uploadFile);
recordRoutes.post('/:code/files/:fileId/versions', authorize('RECORD.UPDATE'), validate({ params: s.fileParam }), uploadSingle(), ctrl.uploadVersion);
recordRoutes.post('/:code/files/:fileId/remove', authorize('RECORD.UPDATE'), validate({ params: s.fileParam }), ctrl.removeFile);
recordRoutes.get('/:code/files/:fileId/content', authorize('RECORD.DOWNLOAD'), validate({ params: s.fileParam, query: s.contentQuery }), ctrl.getFileContent);
