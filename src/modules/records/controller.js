import * as service from './service.js';
import * as workflow from './workflow.js';
import { actorFromReq } from '../../core/tx.js';

// GET /api/records/expiry-preview?documentTypeCode=&documentDate=&eventEndDate=
export async function previewExpiry(req, res) {
  res.json(await service.previewExpiry(req.input.query));
}

// POST /api/records
export async function createRecord(req, res) {
  res.status(201).json(await service.createRecord(actorFromReq(req), req.user, req.input.body));
}

// GET /api/records/:code
export async function getRecord(req, res) {
  res.json(await service.getRecord(actorFromReq(req), req.user, req.scope, req.input.params.code));
}

// PATCH /api/records/:code
export async function updateRecord(req, res) {
  res.json(await service.updateRecord(actorFromReq(req), req.user, req.scope, req.input.params.code, req.input.body));
}

// POST /api/records/:code/cancel
export async function cancelRecord(req, res) {
  res.json(await service.cancelRecord(actorFromReq(req), req.user, req.scope, req.input.params.code, req.input.body));
}

// POST /api/records/:code/files (multipart, trường "file")
export async function uploadFile(req, res) {
  res.status(201).json(await service.uploadFile(actorFromReq(req), req.user, req.scope, req.input.params.code, req.file));
}

// POST /api/records/:code/files/:fileId/versions (multipart, trường "file")
export async function uploadVersion(req, res) {
  const { code, fileId } = req.input.params;
  res.status(201).json(await service.uploadFile(actorFromReq(req), req.user, req.scope, code, req.file, { fileId }));
}

// POST /api/records/:code/files/:fileId/remove
export async function removeFile(req, res) {
  const { code, fileId } = req.input.params;
  res.json(await service.removeFile(actorFromReq(req), req.user, req.scope, code, fileId));
}

// GET /api/records/:code/files/:fileId/content?version=&download=0|1
export async function getFileContent(req, res) {
  const { code, fileId } = req.input.params;
  const out = await service.getFileContent(actorFromReq(req), req.user, req.scope, code, fileId, req.input.query);
  const encoded = encodeURIComponent(out.fileName);
  res.set({
    'Content-Type': out.mime,
    'Content-Length': out.buffer.length,
    'Content-Disposition': `${out.asDownload ? 'attachment' : 'inline'}; filename="file"; filename*=UTF-8''${encoded}`,
    'Cache-Control': 'no-store',
    'X-File-Version': out.versionNo,
  });
  res.end(out.buffer);
}

// GET /api/records?…(BM07)
export async function searchRecords(req, res) {
  res.json(await service.searchRecords(req.user, req.scope, req.input.query));
}

// GET /api/records/approvals
export async function listApprovals(req, res) {
  res.json(await workflow.listApprovals(req.user));
}

// POST /api/records/:code/submit
export async function submitRecord(req, res) {
  res.json(await workflow.submitRecord(actorFromReq(req), req.user, req.input.params.code));
}

// POST /api/records/:code/withdraw
export async function withdrawRecord(req, res) {
  res.json(await workflow.withdrawRecord(actorFromReq(req), req.user, req.input.params.code));
}

// POST /api/records/:code/approve
export async function approveRecord(req, res) {
  res.json(await workflow.approveRecord(actorFromReq(req), req.user, req.input.params.code));
}

// POST /api/records/:code/reject
export async function rejectRecord(req, res) {
  res.json(await workflow.rejectRecord(actorFromReq(req), req.user, req.input.params.code, req.input.body));
}

// POST /api/records/:code/mark-ended
export async function markRecordEnded(req, res) {
  res.json(await workflow.markRecordEnded(actorFromReq(req), req.user, req.input.params.code, req.input.body));
}
