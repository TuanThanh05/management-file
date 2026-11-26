import * as service from './service.js';
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
