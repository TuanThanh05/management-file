import * as service from './service.js';
import { actorFromReq } from '../../core/tx.js';

// GET /api/retention/alerts
export async function expiryAlerts(req, res) {
  res.json(await service.expiryAlerts(req.user));
}

// GET /api/retention/expired
export async function listExpired(req, res) {
  res.json(await service.listExpired(req.input.query));
}

// POST /api/retention/eligibility
export async function setEligibility(req, res) {
  res.json(await service.setEligibility(actorFromReq(req), req.user, req.input.body));
}
