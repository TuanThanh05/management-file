import * as service from './service.js';
import { actorFromReq } from '../../core/tx.js';

// GET /api/catalog/groups
export async function listGroups(req, res) {
  res.json({ items: await service.listGroups() });
}

// POST /api/catalog/groups
export async function createGroup(req, res) {
  res.status(201).json(await service.createGroup(actorFromReq(req), req.input.body));
}

// PATCH /api/catalog/groups/:code
export async function updateGroup(req, res) {
  res.json(await service.updateGroup(actorFromReq(req), req.input.params.code, req.input.body));
}

// POST /api/catalog/groups/:code/deactivate
export async function deactivateGroup(req, res) {
  res.json(await service.deactivateGroup(actorFromReq(req), req.input.params.code));
}

// POST /api/catalog/groups/:code/activate
export async function activateGroup(req, res) {
  res.json(await service.activateGroup(actorFromReq(req), req.input.params.code));
}

// GET /api/catalog/document-types
export async function listTypes(req, res) {
  res.json({ items: await service.listTypes(req.input.query) });
}

// GET /api/catalog/document-types/:code
export async function getType(req, res) {
  res.json(await service.getType(req.input.params.code));
}

// POST /api/catalog/document-types
export async function createType(req, res) {
  res.status(201).json(await service.createType(actorFromReq(req), req.input.body));
}

// PATCH /api/catalog/document-types/:code
export async function updateType(req, res) {
  res.json(await service.updateType(actorFromReq(req), req.input.params.code, req.input.body));
}

// POST /api/catalog/document-types/:code/deactivate
export async function deactivateType(req, res) {
  res.json(await service.deactivateType(actorFromReq(req), req.input.params.code));
}

// POST /api/catalog/document-types/:code/activate
export async function activateType(req, res) {
  res.json(await service.activateType(actorFromReq(req), req.input.params.code));
}
