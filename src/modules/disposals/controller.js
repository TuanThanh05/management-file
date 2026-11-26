import * as service from './service.js';
import { actorFromReq } from '../../core/tx.js';

// Gọi service với (actor, user, code, body) và trả JSON
const action = (fn, status = 200) => async (req, res) => {
  res.status(status).json(await fn(actorFromReq(req), req.user, req.input.params.code, req.input.body));
};

// GET /api/disposals
export async function listBatches(req, res) {
  res.json(await service.listBatches(req.user, req.scope, req.input.query));
}

// GET /api/disposals/:code
export async function getBatch(req, res) {
  res.json(await service.getBatch(req.user, req.scope, req.input.params.code));
}

// POST /api/disposals
export async function createBatch(req, res) {
  res.status(201).json(await service.createBatch(actorFromReq(req), req.user, req.input.body));
}

// PATCH /api/disposals/:code, POST /:code/{cancel,submit,exclusions,exclusions/remove,approve-level-1,return-level-1,approve-level-2,return-level-2,revoke}
export const updateBatch = action(service.updateBatch);
export const cancelBatch = action(service.cancelBatch);
export const submitBatch = action((a, u, c) => service.submitBatch(a, u, c));
export const requestExclusion = action(service.requestExclusion);
export const removeExclusion = action(service.removeExclusion);
export const approveLevel1 = action(service.approveLevel1);
export const returnLevel1 = action(service.returnLevel1);
export const approveLevel2 = action(service.approveLevel2);
export const returnLevel2 = action(service.returnLevel2);
export const revokeBatch = action(service.revokeBatch);
