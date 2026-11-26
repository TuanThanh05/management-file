import * as service from './service.js';
import { actorFromReq } from '../../core/tx.js';

// POST /api/extensions
export async function createExtension(req, res) {
  res.status(201).json(await service.createExtension(actorFromReq(req), req.user, req.input.body));
}

// GET /api/extensions
export async function listExtensions(req, res) {
  res.json(await service.listExtensions(req.user, req.scope, req.input.query));
}

// GET /api/extensions/:code
export async function getExtension(req, res) {
  res.json(await service.getExtension(req.user, req.scope, req.input.params.code));
}

// POST /api/extensions/:code/approve
export async function approveExtension(req, res) {
  res.json(await service.approveExtension(actorFromReq(req), req.user, req.input.params.code, req.input.body));
}

// POST /api/extensions/:code/reject
export async function rejectExtension(req, res) {
  res.json(await service.rejectExtension(actorFromReq(req), req.user, req.input.params.code, req.input.body));
}
