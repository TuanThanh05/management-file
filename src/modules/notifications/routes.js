import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate.js';
import { authorize } from '../../middlewares/authorize.js';
import { validate } from '../../middlewares/validate.js';
import * as s from './schema.js';
import * as ctrl from './controller.js';

// Nhóm API /api/notifications: xem và đánh dấu đã đọc thông báo của chính mình
export const notificationRoutes = Router();
notificationRoutes.use(authenticate(), authorize('NOTIFICATION.VIEW'));

notificationRoutes.get('/', validate({ query: s.listQuery }), ctrl.listNotifications);
notificationRoutes.get('/unread-count', ctrl.unreadCount);
notificationRoutes.post('/read-all', ctrl.markAllRead);
notificationRoutes.post('/:id/read', validate({ params: s.idParam }), ctrl.markRead);
