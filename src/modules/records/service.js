import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileTypeFromBuffer } from 'file-type';
import { pool } from '../../config/database.js';
import { withTx } from '../../core/tx.js';
import { AppError } from '../../core/errors.js';
import { nextCode } from '../../core/codes.js';
import { todayVN } from '../../core/time.js';
import { getSettings } from '../../core/settings.js';
import { notifyRole } from '../../core/notify.js';
import { logger } from '../../core/logger.js';
import { writeBlob, readBlob, deleteBlob } from '../../core/storage.js';
import { encryptFile, decryptFile, IntegrityError } from '../../crypto/envelope.js';
import { computeExpiry } from './retention.js';
import * as repo from './repo.js';

const FILE_AREA = 'files';
const sameId = (a, b) => String(a) === String(b);
const parseJson = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

// Định dạng cho phép (BM01 trường 15): mã nhận diện theo nội dung -> đuôi tên file hợp lệ, MIME trả về
const FORMATS = {
  pdf: { format: 'PDF', exts: ['.pdf'], mime: 'application/pdf', inline: true },
  docx: { format: 'DOCX', exts: ['.docx'], mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', inline: false },
  xlsx: { format: 'XLSX', exts: ['.xlsx'], mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', inline: false },
  jpg: { format: 'JPG', exts: ['.jpg', '.jpeg'], mime: 'image/jpeg', inline: true },
  png: { format: 'PNG', exts: ['.png'], mime: 'image/png', inline: true },
};
const BY_FORMAT = Object.fromEntries(Object.values(FORMATS).map((f) => [f.format, f]));

// Hồ sơ có nằm trong phạm vi dữ liệu của người dùng không (OWN / DEPARTMENT / ALL)
function inScope(scope, user, record) {
  if (scope === 'ALL') return true;
  if (scope === 'DEPARTMENT') return sameId(record.department_id, user.departmentId);
  if (scope === 'OWN') return sameId(record.created_by, user.id);
  return false;
}

// Thao tác ghi: người không xem được hồ sơ nhận 404 (không lộ hồ sơ tồn tại), xem được nhưng không phải người tạo nhận 403
function requireVisible(user, record) {
  const viewScope = user.permissions?.['RECORD.VIEW'];
  if (!record || !inScope(viewScope, user, record)) throw AppError.notFound('Không tìm thấy hồ sơ');
}

// Chỉ người tạo, khi hồ sơ Đang sử dụng, mới sửa / tải file / hủy bỏ được
function requireEditable(user, record) {
  if (!sameId(record.created_by, user.id)) throw new AppError(403, 'NOT_RECORD_OWNER', 'Chỉ người tạo hồ sơ được thực hiện thao tác này');
  if (record.status !== 'IN_USE') throw AppError.conflict('Chỉ thao tác được khi hồ sơ ở trạng thái Đang sử dụng');
}

// Loại tài liệu phải đang sử dụng và gắn nhãn có phiên bản hiệu lực
async function requireUsableType(conn, code) {
  const t = await repo.findTypeWithLabel(conn, code);
  if (!t || t.status !== 'ACTIVE' || !t.label_version_id) {
    throw AppError.unprocessable('Loại tài liệu không dùng được', [{ field: 'documentTypeCode', message: 'Chỉ chọn loại đang gắn với nhãn có phiên bản hiệu lực' }]);
  }
  return t;
}

// Kiểm tra ngày theo BM01: ngày tài liệu ≤ hôm nay; ngày kết thúc sự kiện chỉ khi nhãn tính theo sự kiện, trong [ngày tài liệu, hôm nay]
function checkDates(type, { documentDate, eventEndDate }) {
  const today = todayVN();
  const errors = [];
  if (documentDate > today) errors.push({ field: 'documentDate', message: 'Ngày tài liệu không được lớn hơn ngày hiện tại' });
  if (eventEndDate) {
    if (type.start_trigger !== 'EVENT_END') errors.push({ field: 'eventEndDate', message: 'Nhãn của loại tài liệu này không tính hạn theo sự kiện; bỏ trống ngày kết thúc sự kiện' });
    else if (eventEndDate < documentDate) errors.push({ field: 'eventEndDate', message: 'Ngày kết thúc sự kiện không nhỏ hơn ngày tài liệu' });
    else if (eventEndDate > today) errors.push({ field: 'eventEndDate', message: 'Ngày kết thúc sự kiện không lớn hơn ngày hiện tại' });
  }
  if (errors.length) throw AppError.unprocessable('Ngày không hợp lệ', errors);
}

// Luật lưu trữ của phiên bản nhãn dạng gọn
function labelRule(row, prefix = '') {
  const get = (k) => row[`${prefix}${k}`];
  if (!get('retention_type')) return null;
  return { retentionType: get('retention_type'), retentionYears: get('retention_years'), startTrigger: get('start_trigger') };
}

// Hạn lưu trữ dự kiến (5.1 chức năng 7) cho một loại tài liệu và các ngày khai báo
async function expectedExpiry(conn, rule, { documentDate, eventEndDate }) {
  const { FISCAL_YEAR_END } = await getSettings(conn, ['FISCAL_YEAR_END']);
  return computeExpiry(rule, { archivedDate: todayVN(), documentDate, eventEndDate, fiscalYearEnd: FISCAL_YEAR_END });
}

// ---------- Hồ sơ (5.1 chức năng 4, 6, 7, 10, 12) ----------

// Xem trước hạn lưu trữ dự kiến khi đang điền BM01
export async function previewExpiry({ documentTypeCode, documentDate, eventEndDate }) {
  const t = await requireUsableType(pool, documentTypeCode);
  return {
    label: { code: t.label_code, versionNo: t.version_no, name: t.label_name, retentionType: t.retention_type,
      retentionYears: t.retention_years, startTrigger: t.start_trigger, eventName: t.event_name },
    expected: await expectedExpiry(pool, labelRule(t), { documentDate, eventEndDate }),
  };
}

// Tạo hồ sơ Đang sử dụng; mã HS-<PB>-<Năm>-<6 số>; nhật ký không ghi tiêu đề (có thể chứa dữ liệu cá nhân)
export async function createRecord(actor, user, body) {
  return withTx(actor, async ({ conn, audit }) => {
    const t = await requireUsableType(conn, body.documentTypeCode);
    checkDates(t, body);
    const code = await nextCode(conn, 'RECORD', { departmentCode: await repo.departmentCode(conn, user.departmentId) });
    await repo.insertRecord(conn, {
      code, title: body.title, description: body.description, documentTypeId: t.id, departmentId: user.departmentId,
      createdBy: user.id, documentDate: body.documentDate, eventEndDate: body.eventEndDate,
      eventNote: body.eventEndDate ? t.event_name : null, validity: body.eventEndDate ? 'ENDED' : 'VALID',
    });
    await audit({ action: 'RECORD_CREATE', objectType: 'RECORD', objectCode: code,
      details: { documentType: t.code, documentDate: body.documentDate, eventEndDate: body.eventEndDate ?? null } });
    return code;
  }).then((code) => loadDetail(pool, code));
}

// Cập nhật hồ sơ Đang sử dụng (chỉ người tạo); nhật ký ghi trước/sau, tiêu đề và mô tả chỉ ghi có đổi hay không
export async function updateRecord(actor, user, scope, code, changes) {
  await withTx(actor, async ({ conn, audit }) => {
    const r = await repo.findRecord(conn, code, { forUpdate: true });
    requireVisible(user, r);
    requireEditable(user, r);
    const [[oldType]] = await conn.query('SELECT code FROM document_types WHERE id = ?', [r.document_type_id]);
    const t = await requireUsableType(conn, changes.documentTypeCode ?? oldType.code);
    const next = {
      title: changes.title ?? r.title,
      description: changes.description !== undefined ? changes.description : r.description,
      documentTypeId: t.id,
      documentDate: changes.documentDate ?? r.document_date,
      eventEndDate: changes.eventEndDate !== undefined ? changes.eventEndDate : r.event_end_date,
    };
    checkDates(t, next);
    next.eventNote = next.eventEndDate ? t.event_name : null;
    next.validity = next.eventEndDate ? 'ENDED' : 'VALID';
    await repo.updateRecord(conn, r.id, next);
    await audit({ action: 'RECORD_UPDATE', objectType: 'RECORD', objectCode: code, details: {
      before: { documentType: oldType.code, documentDate: r.document_date, eventEndDate: r.event_end_date },
      after: { documentType: t.code, documentDate: next.documentDate, eventEndDate: next.eventEndDate },
      titleChanged: next.title !== r.title, descriptionChanged: (next.description ?? null) !== (r.description ?? null),
    } });
  });
  return loadDetail(pool, code);
}

// Hủy bỏ hồ sơ tạo nhầm (BM06): xóa khóa dữ liệu mọi phiên bản, chuyển Đã hủy bỏ, rồi xóa bản mã khỏi kho
export async function cancelRecord(actor, user, scope, code, { reason }) {
  const destroyed = await withTx(actor, async ({ conn, audit }) => {
    const r = await repo.findRecord(conn, code, { forUpdate: true });
    requireVisible(user, r);
    requireEditable(user, r);
    const keys = await repo.destroyKeysOfRecord(conn, r.id);
    await repo.cancelRecord(conn, r.id, reason);
    await audit({ action: 'RECORD_CANCEL', objectType: 'RECORD', objectCode: code, details: { reason, destroyedKeys: keys.length } });
    return keys;
  });
  await purgeBlobs(destroyed);
  return loadDetail(pool, code);
}

// Xóa bản mã đã mất khóa khỏi kho và đánh dấu is_purged; lỗi thì để lần dọn sau
export async function purgeBlobs(versions) {
  const done = [];
  for (const v of versions) {
    try {
      if (await deleteBlob(FILE_AREA, v.storage_name)) done.push(v.id);
    } catch (err) {
      logger.error({ err, storage: v.storage_name }, 'purge blob failed');
    }
  }
  await repo.markPurged(pool, done);
  return done.length;
}

// Chi tiết hồ sơ (5.1 chức năng 12); mỗi lượt xem đều ghi nhật ký
export async function getRecord(actor, user, scope, code) {
  const r = await repo.findRecord(pool, code);
  if (!r || !inScope(scope, user, r)) throw AppError.notFound('Không tìm thấy hồ sơ');
  await withTx(actor, ({ audit }) => audit({ action: 'RECORD_VIEW', objectType: 'RECORD', objectCode: code }));
  return loadDetail(pool, code);
}

// Gộp dữ liệu chi tiết hồ sơ: khai báo, nhãn, hạn lưu trữ, file và phiên bản, lịch sử xử lý
async function loadDetail(conn, code) {
  const d = await repo.getRecordDetail(conn, code);
  const ended = ['DISPOSED', 'CANCELLED'].includes(d.status);
  const rule = labelRule(d, 'lv_');
  let expiry;
  if (d.label_version_id) {
    expiry = d.lv_retention_type === 'PERMANENT' ? { kind: 'PERMANENT', startDate: null, expiryDate: null }
      : d.expiry_date ? { kind: 'DATE', startDate: d.retention_start_date, expiryDate: d.expiry_date }
        : { kind: 'UNDETERMINED', startDate: null, expiryDate: null };
    expiry.official = true;
  } else {
    expiry = { ...(await expectedExpiry(conn, rule, { documentDate: d.document_date, eventEndDate: d.event_end_date })), official: false };
  }
  const files = new Map();
  for (const f of await repo.listFiles(conn, d.id)) {
    if (!files.has(f.file_id)) {
      files.set(f.file_id, { id: String(f.file_id), originalName: f.original_name, isActive: Boolean(Number(f.is_active)), versions: [] });
    }
    files.get(f.file_id).versions.push({
      versionNo: f.version_no, format: f.format, sizeBytes: Number(f.size_bytes), sha256: f.sha256,
      uploadedBy: f.uploaded_by_email, uploadedAt: f.uploaded_at,
      contentAvailable: !ended && !Number(f.key_destroyed), purged: Boolean(Number(f.is_purged)),
    });
  }
  const history = (await repo.recordHistory(conn, code)).map((h) => ({
    seq: Number(h.seq), at: h.occurred_at, action: h.action, result: h.result, by: h.actor_email ?? 'Hệ thống',
    reason: parseJson(h.details)?.reason ?? null,
  }));
  return {
    code: d.code, title: d.title, description: d.description, status: d.status, validity: d.validity,
    isOnHold: Boolean(Number(d.is_on_hold)), isDisposalEligible: Boolean(Number(d.is_disposal_eligible)),
    documentDate: d.document_date, eventEndDate: d.event_end_date, eventNote: d.event_note,
    documentType: { code: d.type_code, name: d.type_name }, group: { code: d.group_code, name: d.group_name },
    department: { code: d.department_code, name: d.department_name },
    createdBy: { email: d.created_by_email, fullName: d.created_by_name }, createdAt: d.created_at,
    label: d.lv_id ? { code: d.lv_label_code, versionNo: d.lv_version_no, name: d.lv_label_name, ...rule,
      eventName: d.lv_event_name, containsPersonalData: Boolean(Number(d.lv_personal)), applied: Boolean(Number(d.lv_applied)) } : null,
    expiry, lastRejectionReason: d.last_rejection_reason, cancelReason: d.cancel_reason, cancelledAt: d.cancelled_at,
    disposedAt: d.disposed_at, files: [...files.values()], history,
  };
}

// ---------- File (5.1 chức năng 5, 6, 13) ----------

// Sửa tên file do multipart gửi ở dạng latin1, bỏ đường dẫn và ký tự điều khiển
function cleanFileName(name) {
  let n = name ?? 'file';
  const asUtf8 = Buffer.from(n, 'latin1').toString('utf8');
  if (/[\u0080-ÿ]/.test(n) && !asUtf8.includes('�')) n = asUtf8;
  n = path.basename(n.replace(/\\/g, '/')).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (n || 'file').slice(0, 255);
}

// Nhận diện định dạng theo nội dung (magic bytes) và đối chiếu đuôi tên file
async function detectFormat(buffer, fileName) {
  if (!buffer?.length) throw AppError.unprocessable('File rỗng', [{ field: 'file', message: 'File không có nội dung' }]);
  const ft = await fileTypeFromBuffer(buffer);
  const f = ft && FORMATS[ft.ext];
  if (!f) {
    throw AppError.unprocessable('Định dạng file không được phép', [{ field: 'file',
      message: `Chỉ nhận PDF, DOCX, XLSX, JPG, PNG (nội dung thực tế: ${ft ? ft.ext.toUpperCase() : 'không xác định'})` }]);
  }
  const ext = path.extname(fileName).toLowerCase();
  if (!f.exts.includes(ext)) {
    throw AppError.unprocessable('Đuôi file không khớp nội dung', [{ field: 'file',
      message: `Đuôi file không khớp nội dung (thực tế là ${f.format}, đuôi hợp lệ: ${f.exts.join(', ')})` }]);
  }
  return f.format;
}

// Tải file lên: kiểm tra định dạng, băm SHA-256, mã hóa AES-256-GCM khóa riêng, ghi kho rồi ghi CSDL; fileId có thì là phiên bản mới
export async function uploadFile(actor, user, scope, code, upload, { fileId } = {}) {
  const originalName = cleanFileName(upload?.originalname);
  const format = await detectFormat(upload?.buffer, originalName);
  const storageName = randomUUID();
  const enc = encryptFile(upload.buffer, storageName);
  await writeBlob(FILE_AREA, storageName, enc.ciphertext);
  try {
    await withTx(actor, async ({ conn, audit }) => {
      const r = await repo.findRecord(conn, code, { forUpdate: true });
      requireVisible(user, r);
      requireEditable(user, r);
      let id = fileId;
      let versionNo = 1;
      if (id) {
        const f = await repo.findFile(conn, r.id, id, { forUpdate: true });
        if (!f || !Number(f.is_active)) throw AppError.notFound('Không tìm thấy file đang dùng trong hồ sơ');
        versionNo = await repo.nextFileVersionNo(conn, id);
      } else {
        const { MAX_FILES_PER_RECORD } = await getSettings(conn, ['MAX_FILES_PER_RECORD']);
        if (await repo.countActiveFiles(conn, r.id) >= MAX_FILES_PER_RECORD) {
          throw AppError.conflict(`Hồ sơ đã đủ ${MAX_FILES_PER_RECORD} file đang dùng`);
        }
        id = await repo.insertFile(conn, { recordId: r.id, originalName, createdBy: user.id });
      }
      await repo.insertFileVersion(conn, {
        fileId: id, versionNo, storageName, format, sizeBytes: upload.buffer.length, sha256: enc.sha256,
        wrappedKey: enc.wrappedKey, iv: enc.iv, authTag: enc.authTag, uploadedBy: user.id,
      });
      await audit({ action: 'FILE_UPLOAD', objectType: 'RECORD', objectCode: code,
        details: { fileId: id, name: originalName, sizeBytes: upload.buffer.length, sha256: enc.sha256, versionNo, format } });
    });
  } catch (err) {
    await deleteBlob(FILE_AREA, storageName).catch(() => {});
    throw err;
  }
  return loadDetail(pool, code);
}

// Gỡ file khỏi danh sách đang dùng (phiên bản vẫn giữ trong lịch sử)
export async function removeFile(actor, user, scope, code, fileId) {
  await withTx(actor, async ({ conn, audit }) => {
    const r = await repo.findRecord(conn, code, { forUpdate: true });
    requireVisible(user, r);
    requireEditable(user, r);
    const f = await repo.findFile(conn, r.id, fileId, { forUpdate: true });
    if (!f || !Number(f.is_active)) throw AppError.notFound('Không tìm thấy file đang dùng trong hồ sơ');
    await repo.deactivateFile(conn, fileId);
    await audit({ action: 'FILE_REMOVE', objectType: 'RECORD', objectCode: code, details: { fileId: String(fileId), name: f.original_name } });
  });
  return loadDetail(pool, code);
}

// Xem / tải file: giải mã, kiểm tra thẻ GCM và SHA-256; sai thì từ chối, ghi nhật ký, cảnh báo Quản trị và Giám đốc
export async function getFileContent(actor, user, scope, code, fileId, { version, download }) {
  const r = await repo.findRecord(pool, code);
  if (!r || !inScope(scope, user, r)) throw AppError.notFound('Không tìm thấy hồ sơ');
  if (['DISPOSED', 'CANCELLED'].includes(r.status)) throw new AppError(410, 'CONTENT_DESTROYED', 'Hồ sơ đã hủy, nội dung file không còn');
  const f = await repo.findFile(pool, r.id, fileId);
  const v = f && await repo.findFileVersion(pool, fileId, version);
  if (!v) throw AppError.notFound('Không tìm thấy file hoặc phiên bản');

  let plain;
  try {
    const ciphertext = await readBlob(FILE_AREA, v.storage_name);
    if (!ciphertext) throw new IntegrityError('MISSING_BLOB');
    plain = decryptFile({ ciphertext, iv: v.iv, authTag: v.auth_tag, wrappedKey: v.wrapped_key, aad: v.storage_name, expectedSha256: v.sha256 });
  } catch (err) {
    if (!(err instanceof IntegrityError)) throw err;
    await withTx(actor, async ({ conn, audit }) => {
      const details = { fileId: String(fileId), versionNo: v.version_no, reason: err.reason };
      await audit({ action: 'FILE_INTEGRITY_FAILED', objectType: 'RECORD', objectCode: code, result: 'FAILURE', details });
      const payload = { type: 'SECURITY_ALERT', objectType: 'RECORD', objectCode: code,
        message: `Phát hiện file của hồ sơ ${code} (phiên bản ${v.version_no}) bị thay đổi hoặc mất trong kho lưu trữ` };
      await notifyRole(conn, 'SYSTEM_ADMIN', payload);
      await notifyRole(conn, 'DIRECTOR', payload);
    });
    throw new AppError(409, 'FILE_INTEGRITY_FAILED', 'File không vượt qua kiểm tra toàn vẹn; đã báo Quản trị hệ thống và Giám đốc');
  }

  const fmt = BY_FORMAT[v.format];
  const asDownload = download === '1' || !fmt.inline;
  await withTx(actor, ({ audit }) => audit({ action: asDownload ? 'FILE_DOWNLOAD' : 'FILE_VIEW', objectType: 'RECORD', objectCode: code,
    details: { fileId: String(fileId), versionNo: v.version_no } }));
  return { buffer: plain, mime: fmt.mime, fileName: f.original_name, versionNo: v.version_no, asDownload };
}
