import { createHash, randomUUID } from 'node:crypto';
import { pool } from '../../config/database.js';
import { withTx } from '../../core/tx.js';
import { AppError } from '../../core/errors.js';
import { nextCode } from '../../core/codes.js';
import { getSettings } from '../../core/settings.js';
import { notifyRole } from '../../core/notify.js';
import { renderPdf } from '../../core/pdf.js';
import { writeBlob, readBlob, deleteBlob } from '../../core/storage.js';
import { buildSnapshot, certificateDocument, snapshotHash } from './document.js';

const AREA = 'certificates';

// Lập biên bản BM16 trong giao dịch đang mở: cấp số, chụp nội dung, sinh PDF, lưu mã băm; trả về số biên bản và tên file
export async function issueCertificate(conn, batchId) {
  const certificateNo = await nextCode(conn, 'CERTIFICATE');
  const { COMPANY_NAME } = await getSettings(conn, ['COMPANY_NAME']);
  const snapshot = await buildSnapshot(conn, batchId, { certificateNo, companyName: COMPANY_NAME });
  const pdf = await renderPdf(certificateDocument(snapshot));
  const sha256 = createHash('sha256').update(pdf).digest('hex');
  const storageName = randomUUID();
  await writeBlob(AREA, storageName, pdf);
  try {
    await conn.query(
      'INSERT INTO disposal_certificates (certificate_no, batch_id, snapshot, pdf_storage_name, pdf_sha256) VALUES (?, ?, ?, ?, ?)',
      [certificateNo, batchId, JSON.stringify(snapshot), storageName, sha256]);
  } catch (err) {
    await deleteBlob(AREA, storageName).catch(() => {});
    throw err;
  }
  return { certificateNo, storageName, sha256, contentHash: snapshotHash(snapshot), recordCount: snapshot.records.length };
}

// Xóa file PDF đã ghi khi giao dịch lập biên bản bị hủy
export function discardCertificateFile(storageName) {
  return deleteBlob(AREA, storageName).catch(() => {});
}

// Thông tin biên bản của đợt (nếu có)
export async function certificateOf(conn, batchId) {
  const [[row]] = await conn.query(
    'SELECT certificate_no, issued_at, pdf_sha256, pdf_storage_name, snapshot FROM disposal_certificates WHERE batch_id = ?', [batchId]);
  return row ?? null;
}

// Tải biên bản (5.3 CN18): đợt Hoàn tất; tính lại SHA-256, không khớp thì chặn, ghi nhật ký và cảnh báo
export async function downloadCertificate(actor, batchCode) {
  const [[b]] = await pool.query('SELECT id, code, status FROM disposal_batches WHERE code = ?', [batchCode]);
  if (!b) throw AppError.notFound('Không tìm thấy đợt hủy');
  if (b.status !== 'COMPLETED') throw AppError.conflict('Chỉ tải biên bản của đợt đã Hoàn tất');
  const c = await certificateOf(pool, b.id);
  const pdf = await readBlob(AREA, c.pdf_storage_name);
  const actual = pdf && createHash('sha256').update(pdf).digest('hex');
  if (actual !== c.pdf_sha256) {
    await withTx(actor, async ({ conn, audit }) => {
      await audit({ action: 'FILE_INTEGRITY_FAILED', objectType: 'CERTIFICATE', objectCode: c.certificate_no, result: 'FAILURE',
        details: { batch: batchCode, reason: pdf ? 'SHA256_MISMATCH' : 'MISSING_BLOB' } });
      const payload = { type: 'SECURITY_ALERT', objectType: 'CERTIFICATE', objectCode: c.certificate_no,
        message: `Biên bản ${c.certificate_no} (đợt ${batchCode}) không khớp mã băm hoặc bị mất trong kho` };
      await notifyRole(conn, 'SYSTEM_ADMIN', payload);
      await notifyRole(conn, 'DIRECTOR', payload);
    });
    throw new AppError(409, 'FILE_INTEGRITY_FAILED', 'Biên bản không vượt qua kiểm tra toàn vẹn; đã báo Quản trị hệ thống và Giám đốc');
  }
  await withTx(actor, ({ audit }) => audit({ action: 'CERTIFICATE_DOWNLOAD', objectType: 'CERTIFICATE', objectCode: c.certificate_no, details: { batch: batchCode } }));
  return { buffer: pdf, fileName: `${c.certificate_no}.pdf`, sha256: c.pdf_sha256 };
}
