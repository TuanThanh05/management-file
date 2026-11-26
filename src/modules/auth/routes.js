import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate.js';
import { authorize } from '../../middlewares/authorize.js';
import { validate } from '../../middlewares/validate.js';
import { loginRateLimit } from '../../middlewares/rateLimit.js';
import { loginSchema, changePasswordSchema } from './schema.js';
import * as ctrl from './controller.js';

// Nhóm API /api/auth; các API sau đăng nhập vẫn dùng được khi đang bắt buộc đổi mật khẩu
export const authRoutes = Router();

authRoutes.post('/login', loginRateLimit, validate({ body: loginSchema }), ctrl.login);
authRoutes.post('/logout', authenticate({ allowMustChange: true }), ctrl.logout);
authRoutes.post('/change-password', authenticate({ allowMustChange: true }), authorize('ACCOUNT.CHANGE_PASSWORD'),
  validate({ body: changePasswordSchema }), ctrl.changePassword);
authRoutes.get('/me', authenticate({ allowMustChange: true }), ctrl.me);
