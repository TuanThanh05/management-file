import * as service from './service.js';
import { actorFromReq } from '../../core/tx.js';

// GET /api/labels
export async function listLabels(req, res) {
  res.json({ items: await service.listLabels() });
}

// GET /api/labels/:code
export async function getLabelHistory(req, res) {
  res.json(await service.getLabelHistory(req.input.params.code));
}

// GET /api/labels/:code/compare?from=&to=
export async function compareVersions(req, res) {
  res.json(await service.compareVersions(req.input.params.code, req.input.query));
}

// GET /api/labels/proposals?status=
export async function listProposals(req, res) {
  res.json({ items: await service.listProposals(req.input.query) });
}

// POST /api/labels/proposals
export async function createProposal(req, res) {
  res.status(201).json(await service.createProposal(actorFromReq(req), req.input.body));
}

// GET /api/labels/proposals/:id
export async function getProposal(req, res) {
  res.json(await service.getVersion(req.input.params.id));
}

// PATCH /api/labels/proposals/:id
export async function updateProposal(req, res) {
  res.json(await service.updateProposal(actorFromReq(req), req.input.params.id, req.input.body));
}

// POST /api/labels/proposals/:id/submit
export async function submitProposal(req, res) {
  res.json(await service.submitProposal(actorFromReq(req), req.input.params.id));
}

// POST /api/labels/proposals/:id/withdraw
export async function withdrawProposal(req, res) {
  res.json(await service.withdrawProposal(actorFromReq(req), req.input.params.id));
}

// POST /api/labels/proposals/:id/approve
export async function approveProposal(req, res) {
  res.json(await service.approveProposal(actorFromReq(req), req.input.params.id));
}

// POST /api/labels/proposals/:id/reject
export async function rejectProposal(req, res) {
  res.json(await service.rejectProposal(actorFromReq(req), req.input.params.id, req.input.body));
}
