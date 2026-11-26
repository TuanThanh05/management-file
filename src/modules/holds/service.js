import { randomUUID } from 'node:crypto';
import { pool } from '../../config/database.js';
import { withTx } from '../../core/tx.js';
import { AppError } from '../../core/errors.js';
import { nextCode } from '../../core/codes.js';
import { todayVN } from '../../core/time.js';
import { notifyRole, departmentHeads, notifyUsers } from '../../core/notify.js';
import { writeBlob, readBlob, deleteBlob } from '../../core/storage.js';
import { encryptFile, decryptFile, IntegrityError } from '../../crypto/envelope.js';
import { cleanFileName, detectFormat, BY_FORMAT } from '../records/service.js';
import * as repo from './repo.js';

const PAGE_SIZE = 20;
const EVIDENCE_AREA = 'holds';
const HOLDABLE = ['ARCHIVED', 'EXPIRED', 'PENDING_DISPOSAL'];

// Báo Cán bộ lưu trữ và Trưởng phòng các phòng có hồ sơ liên quan
async function notifyHoldChange(conn, departmentIds, payload) {
  await notifyRole(conn, 'RECORDS_OFFICER', payload);
  const heads = await departmentHeads(conn, departmentIds);
  await notifyUsers(conn, [...heads.values()], payload);
}

// Dạng trả về của một lệnh phong tỏa kèm hồ sơ
function toDto(h, records) {
  const active = records.filter((x) => x.status === 'ACTIVE').length;
  return {
    code: h.code, reason: h.reason, legalBasis: h.legal_basis, expectedReleaseDate: h.expected_release_date,
    placedBy: { email: h.placed_by_email, fullName: h.placed_by_name }, placedAt: h.placed_at,
    evidence: h.evidence_storage_name ? { originalName: h.evidence_original_name, sha256: h.evidence_sha256 } : null,
    status: active ? 'ACTIVE' : 'RELEASED', activeCount: active,
    overdue: Boolean(active && h.expected_release_date && h.expected_release_date < todayVN()),
    records: records.map((x) => ({
      code: x.code, title: x.title, status: x.record_status, department: x.department_code, holdStatus: x.status,
      releasedBy: x.released_by_email ?? null, releasedAt: x.released_at, releaseReason: x.release_reason,
    })),
  };
}

// Đặt phong tỏa (5.4 CN11, BM04): hồ sơ Lưu trữ / Hết hạn / Chờ duyệt hủy, chưa bị phong tỏa; có hồ sơ sai thì không đặt hồ sơ nào
export async function placeHold(actor, user, body, upload) {
  if (body.expectedReleaseDate && body.expectedReleaseDate < todayVN()) {
    throw AppError.unprocessable('Ngày dự kiến gỡ không hợp lệ', [{ field: 'expectedReleaseDate', message: 'Không nhỏ hơn ngày hiện tại' }]);
  }
  let evidence = null;
  if (upload) {
    const originalName = cleanFileName(upload.originalname);
    await detectFormat(upload.buffer, originalName);
    const storageName = randomUUID();
    const enc = encryptFile(upload.buffer, storageName);
    await writeBlob(EVIDENCE_AREA, storageName, enc.ciphertext);
    evidence = { originalName, storageName, sha256: enc.sha256, wrappedKey: enc.wrappedKey, iv: enc.iv, authTag: enc.authTag };
  }
  try {
    const code = await withTx(actor, async ({ conn, audit }) => {
      const rows = await repo.lockRecords(conn, body.recordCodes);
      const found = new Map(rows.map((r) => [r.code, r]));
      const problems = body.recordCodes.map((c) => {
        const r = found.get(c);
        const msg = !r ? 'Không tìm thấy hồ sơ'
          : !HOLDABLE.includes(r.status) ? 'Chỉ phong tỏa hồ sơ Lưu trữ, Hết hạn hoặc Chờ duyệt hủy'
            : Number(r.is_on_hold) ? 'Hồ sơ đang bị phong tỏa bởi lệnh khác' : null;
        return msg && { field: c, message: msg };
      }).filter(Boolean);
      if (problems.length) throw AppError.unprocessable('Có hồ sơ không hợp lệ; chọn lại', problems);
      const c = await nextCode(conn, 'LEGAL_HOLD');
      const holdId = await repo.insertHold(conn, { code: c, ...body, evidence, placedBy: user.id });
      await repo.addHoldRecords(conn, holdId, rows.map((r) => r.id));
      await audit({ action: 'LEGAL_HOLD_PLACE', objectType: 'LEGAL_HOLD', objectCode: c, details: {
        records: body.recordCodes, legalBasis: body.legalBasis, expectedReleaseDate: body.expectedReleaseDate ?? null, evidenceSha256: evidence?.sha256 ?? null } });
      for (const r of rows) await audit({ action: 'RECORD_HOLD', objectType: 'RECORD', objectCode: r.code, details: { hold: c } });
      await notifyHoldChange(conn, rows.map((r) => r.department_id), { type: 'SYSTEM_CHANGE', objectType: 'LEGAL_HOLD', objectCode: c,
        message: `Lệnh phong tỏa ${c}: ${rows.length} hồ sơ bị phong tỏa (${body.recordCodes.slice(0, 10).join(', ')}${rows.length > 10 ? ', …' : ''})` });
      return c;
    });
    return getHold(code);
  } catch (err) {
    if (evidence) await deleteBlob(EVIDENCE_AREA, evidence.storageName).catch(() => {});
    throw err;
  }
}

// Gỡ phong tỏa (5.4 CN12): theo cả lệnh hoặc từng hồ sơ đang bị phong tỏa trong lệnh
export async function releaseHold(actor, user, code, { recordCodes, reason }) {
  await withTx(actor, async ({ conn, audit }) => {
    const h = await repo.findHold(conn, code);
    if (!h) throw AppError.notFound('Không tìm thấy lệnh phong tỏa');
    const items = await repo.holdRecords(conn, h.id, { forUpdate: true });
    const active = items.filter((x) => x.status === 'ACTIVE');
    if (!active.length) throw AppError.conflict('Lệnh đã được gỡ hết');
    let targets = active;
    if (recordCodes) {
      const byCode = new Map(active.map((x) => [x.code, x]));
      const problems = recordCodes.filter((c) => !byCode.has(c)).map((c) => ({ field: c, message: 'Hồ sơ không đang bị phong tỏa bởi lệnh này' }));
      if (problems.length) throw AppError.unprocessable('Có hồ sơ không hợp lệ; chọn lại', problems);
      targets = recordCodes.map((c) => byCode.get(c));
    }
    for (const x of targets) {
      await repo.releaseHoldRecord(conn, h.id, x.record_id, { releasedBy: user.id, reason });
      await audit({ action: 'RECORD_HOLD_RELEASE', objectType: 'RECORD', objectCode: x.code, details: { hold: code, reason } });
    }
    await audit({ action: 'LEGAL_HOLD_RELEASE', objectType: 'LEGAL_HOLD', objectCode: code,
      details: { records: targets.map((x) => x.code), reason, remaining: active.length - targets.length } });
    await notifyHoldChange(conn, targets.map((x) => x.department_id), { type: 'SYSTEM_CHANGE', objectType: 'LEGAL_HOLD', objectCode: code,
      message: `Lệnh phong tỏa ${code}: đã gỡ ${targets.length} hồ sơ (${targets.slice(0, 10).map((x) => x.code).join(', ')}${targets.length > 10 ? ', …' : ''})` });
  });
  return getHold(code);
}

// Chi tiết lệnh phong tỏa
export async function getHold(code) {
  const h = await repo.findHold(pool, code);
  if (!h) throw AppError.notFound('Không tìm thấy lệnh phong tỏa');
  return toDto(h, await repo.holdRecords(pool, h.id));
}

// Tra cứu lệnh phong tỏa (5.4 CN13); overdue = quá ngày dự kiến gỡ mà còn hồ sơ bị phong tỏa
export async function listHolds(q) {
  const today = todayVN();
  const { total, rows } = await repo.listHolds(pool, { ...q, today, pageSize: PAGE_SIZE });
  return {
    page: q.page, pageSize: PAGE_SIZE, total,
    items: rows.map((h) => {
      const active = Number(h.active_count);
      return {
        code: h.code, reason: h.reason, legalBasis: h.legal_basis, expectedReleaseDate: h.expected_release_date, placedAt: h.placed_at,
        placedBy: h.placed_by_email, hasEvidence: Boolean(h.evidence_original_name), recordCount: Number(h.record_count), activeCount: active,
        status: active ? 'ACTIVE' : 'RELEASED', overdue: Boolean(active && h.expected_release_date && h.expected_release_date < today),
      };
    }),
  };
}

// Tải tệp căn cứ: giải mã và kiểm tra toàn vẹn như file hồ sơ; ghi nhật ký lượt tải
export async function getEvidence(actor, code) {
  const h = await repo.findHold(pool, code);
  if (!h?.evidence_storage_name) throw AppError.notFound('Lệnh không có tệp căn cứ');
  let plain;
  try {
    const ciphertext = await readBlob(EVIDENCE_AREA, h.evidence_storage_name);
    if (!ciphertext) throw new IntegrityError('MISSING_BLOB');
    plain = decryptFile({ ciphertext, iv: h.evidence_iv, authTag: h.evidence_auth_tag, wrappedKey: h.evidence_wrapped_key,
      aad: h.evidence_storage_name, expectedSha256: h.evidence_sha256 });
  } catch (err) {
    if (!(err instanceof IntegrityError)) throw err;
    await withTx(actor, async ({ conn, audit }) => {
      await audit({ action: 'FILE_INTEGRITY_FAILED', objectType: 'LEGAL_HOLD', objectCode: code, result: 'FAILURE', details: { reason: err.reason } });
      const payload = { type: 'SECURITY_ALERT', objectType: 'LEGAL_HOLD', objectCode: code, message: `Tệp căn cứ của lệnh ${code} bị thay đổi hoặc mất trong kho` };
      await notifyRole(conn, 'SYSTEM_ADMIN', payload);
      await notifyRole(conn, 'DIRECTOR', payload);
    });
    throw new AppError(409, 'FILE_INTEGRITY_FAILED', 'Tệp căn cứ không vượt qua kiểm tra toàn vẹn; đã báo Quản trị hệ thống và Giám đốc');
  }
  const format = await detectFormat(plain, h.evidence_original_name);
  await withTx(actor, ({ audit }) => audit({ action: 'LEGAL_HOLD_EVIDENCE_DOWNLOAD', objectType: 'LEGAL_HOLD', objectCode: code }));
  return { buffer: plain, mime: BY_FORMAT[format].mime, fileName: h.evidence_original_name };
}
