import * as service from './service.js';
import { actorFromReq } from '../../core/tx.js';

// GET /api/admin/departments
export async function listDepartments(req, res) {
  res.json({ items: await service.listDepartments() });
}

// POST /api/admin/departments
export async function createDepartment(req, res) {
  res.status(201).json(await service.createDepartment(actorFromReq(req), req.input.body));
}

// PATCH /api/admin/departments/:code
export async function updateDepartment(req, res) {
  res.json(await service.updateDepartment(actorFromReq(req), req.input.params.code, req.input.body));
}

// POST /api/admin/departments/:code/deactivate
export async function deactivateDepartment(req, res) {
  res.json(await service.deactivateDepartment(actorFromReq(req), req.input.params.code));
}

// POST /api/admin/departments/:code/activate
export async function activateDepartment(req, res) {
  res.json(await service.activateDepartment(actorFromReq(req), req.input.params.code));
}

// GET /api/admin/users
export async function listUsers(req, res) {
  res.json(await service.listUsers(req.input.query));
}

// GET /api/admin/users/:id
export async function getUser(req, res) {
  res.json(await service.getUser(req.input.params.id));
}

// POST /api/admin/users – mật khẩu tạm chỉ trả về một lần, không lưu cache
export async function createUser(req, res) {
  res.set('Cache-Control', 'no-store');
  res.status(201).json(await service.createUser(actorFromReq(req), req.input.body));
}

// PATCH /api/admin/users/:id
export async function updateUser(req, res) {
  res.json(await service.updateUser(actorFromReq(req), req.input.params.id, req.input.body));
}

// POST /api/admin/users/:id/lock
export async function lockUser(req, res) {
  res.json(await service.lockUser(actorFromReq(req), req.input.params.id));
}

// POST /api/admin/users/:id/unlock
export async function unlockUser(req, res) {
  res.json(await service.unlockUser(actorFromReq(req), req.input.params.id));
}

// POST /api/admin/users/:id/reset-password – mật khẩu tạm chỉ trả về một lần
export async function resetUserPassword(req, res) {
  res.set('Cache-Control', 'no-store');
  res.json(await service.resetUserPassword(actorFromReq(req), req.input.params.id));
}

// PUT /api/admin/users/:id/roles
export async function setUserRoles(req, res) {
  res.json(await service.setUserRoles(actorFromReq(req), req.input.params.id, req.input.body));
}

// GET /api/admin/settings
export async function listSettings(req, res) {
  res.json({ items: await service.listSettings() });
}

// PATCH /api/admin/settings/:key
export async function updateSetting(req, res) {
  res.json(await service.updateSetting(actorFromReq(req), req.input.params.key, req.input.body));
}

// GET /api/admin/jobs/runs
export async function listJobRuns(req, res) {
  res.json(await service.listJobRuns(req.input.query));
}

// POST /api/admin/jobs/:job/run
export async function runJobNow(req, res) {
  res.json(await service.runJobNow(actorFromReq(req), req.input.params.job));
}
