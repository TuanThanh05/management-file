import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate.js';
import { authorize } from '../../middlewares/authorize.js';
import { validate } from '../../middlewares/validate.js';
import * as s from './schema.js';
import * as ctrl from './controller.js';

// Nhóm API /api/labels: Cán bộ lưu trữ lập đề xuất (LABEL.PROPOSE), Giám đốc duyệt (LABEL.APPROVE), cả hai tra cứu (LABEL.VIEW)
export const labelRoutes = Router();
labelRoutes.use(authenticate());

const view = authorize('LABEL.VIEW');
const propose = authorize('LABEL.PROPOSE');
const approve = authorize('LABEL.APPROVE');

labelRoutes.get('/proposals', view, validate({ query: s.listProposalsQuery }), ctrl.listProposals);
labelRoutes.post('/proposals', propose, validate({ body: s.createProposalSchema }), ctrl.createProposal);
labelRoutes.get('/proposals/:id', view, validate({ params: s.idParam }), ctrl.getProposal);
labelRoutes.patch('/proposals/:id', propose, validate({ params: s.idParam, body: s.updateProposalSchema }), ctrl.updateProposal);
labelRoutes.post('/proposals/:id/submit', propose, validate({ params: s.idParam }), ctrl.submitProposal);
labelRoutes.post('/proposals/:id/withdraw', propose, validate({ params: s.idParam }), ctrl.withdrawProposal);
labelRoutes.post('/proposals/:id/approve', approve, validate({ params: s.idParam }), ctrl.approveProposal);
labelRoutes.post('/proposals/:id/reject', approve, validate({ params: s.idParam, body: s.rejectSchema }), ctrl.rejectProposal);

labelRoutes.get('/', view, ctrl.listLabels);
labelRoutes.get('/:code', view, validate({ params: s.codeParam }), ctrl.getLabelHistory);
labelRoutes.get('/:code/compare', view, validate({ params: s.codeParam, query: s.compareQuery }), ctrl.compareVersions);
