import * as service from './service.js';
import { actorFromReq } from '../../core/tx.js';

// GET /api/audit/logs
export async function listLogs(req, res) {
  res.json(await service.listLogs(actorFromReq(req), req.input.query));
}

// POST /api/audit/verify
export async function verifyChain(req, res) {
  res.json(await service.verifyChain(actorFromReq(req), req.user, req.input.body));
}

// GET /api/audit/checks
export async function listChecks(req, res) {
  res.json(await service.listChecks(req.input.query));
}
