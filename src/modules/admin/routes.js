import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate.js';
import { authorize } from '../../middlewares/authorize.js';
import { validate } from '../../middlewares/validate.js';
import * as s from './schema.js';
import * as ctrl from './controller.js';

// Nhóm API /api/admin: chỉ Quản trị hệ thống (quyền ADMIN.*)
export const adminRoutes = Router();
adminRoutes.use(authenticate());

const dept = authorize('ADMIN.DEPARTMENTS');
adminRoutes.get('/departments', dept, ctrl.listDepartments);
adminRoutes.post('/departments', dept, validate({ body: s.createDepartmentSchema }), ctrl.createDepartment);
adminRoutes.patch('/departments/:code', dept, validate({ params: s.codeParam, body: s.updateDepartmentSchema }), ctrl.updateDepartment);
adminRoutes.post('/departments/:code/deactivate', dept, validate({ params: s.codeParam }), ctrl.deactivateDepartment);
adminRoutes.post('/departments/:code/activate', dept, validate({ params: s.codeParam }), ctrl.activateDepartment);

const users = authorize('ADMIN.USERS');
adminRoutes.get('/users', users, validate({ query: s.listUsersQuery }), ctrl.listUsers);
adminRoutes.get('/users/:id', users, validate({ params: s.idParam }), ctrl.getUser);
adminRoutes.post('/users', users, validate({ body: s.createUserSchema }), ctrl.createUser);
adminRoutes.patch('/users/:id', users, validate({ params: s.idParam, body: s.updateUserSchema }), ctrl.updateUser);
adminRoutes.post('/users/:id/lock', users, validate({ params: s.idParam }), ctrl.lockUser);
adminRoutes.post('/users/:id/unlock', users, validate({ params: s.idParam }), ctrl.unlockUser);
adminRoutes.post('/users/:id/reset-password', users, validate({ params: s.idParam }), ctrl.resetUserPassword);

adminRoutes.put('/users/:id/roles', authorize('ADMIN.ROLES'), validate({ params: s.idParam, body: s.setRolesSchema }), ctrl.setUserRoles);

const settings = authorize('ADMIN.SETTINGS');
adminRoutes.get('/settings', settings, ctrl.listSettings);
adminRoutes.patch('/settings/:key', settings, validate({ params: s.keyParam, body: s.updateSettingSchema }), ctrl.updateSetting);

const jobs = authorize('ADMIN.JOBS');
adminRoutes.get('/jobs/runs', jobs, validate({ query: s.jobRunsQuery }), ctrl.listJobRuns);
adminRoutes.post('/jobs/:job/run', jobs, validate({ params: s.jobParam }), ctrl.runJobNow);

const backups = authorize('ADMIN.BACKUP');
adminRoutes.get('/backups', backups, ctrl.listBackups);
adminRoutes.post('/backups/run', backups, ctrl.runBackupNow);
