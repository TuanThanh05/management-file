import * as service from './service.js';

// GET /api/reports/summary
export async function summary(req, res) {
  res.json(await service.summary(req.user, req.scope, req.input.query));
}
