import * as service from './service.js';
import { actorFromReq } from '../../core/tx.js';

// POST /api/holds (JSON hoặc multipart có tệp "evidence")
export async function placeHold(req, res) {
  res.status(201).json(await service.placeHold(actorFromReq(req), req.user, req.input.body, req.file));
}

// GET /api/holds
export async function listHolds(req, res) {
  res.json(await service.listHolds(req.input.query));
}

// GET /api/holds/:code
export async function getHold(req, res) {
  res.json(await service.getHold(req.input.params.code));
}

// POST /api/holds/:code/release
export async function releaseHold(req, res) {
  res.json(await service.releaseHold(actorFromReq(req), req.user, req.input.params.code, req.input.body));
}

// GET /api/holds/:code/evidence
export async function getEvidence(req, res) {
  const out = await service.getEvidence(actorFromReq(req), req.input.params.code);
  res.set({
    'Content-Type': out.mime,
    'Content-Length': out.buffer.length,
    'Content-Disposition': `attachment; filename="file"; filename*=UTF-8''${encodeURIComponent(out.fileName)}`,
    'Cache-Control': 'no-store',
  });
  res.end(out.buffer);
}
