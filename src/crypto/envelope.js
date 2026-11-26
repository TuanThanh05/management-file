import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { env } from '../config/env.js';

const ALGO = 'aes-256-gcm';
const KEY_AAD = Buffer.from('records-retention/data-key/v1');

// Lỗi toàn vẹn: thẻ xác thực GCM sai hoặc SHA-256 không khớp
export class IntegrityError extends Error {
  constructor(reason) {
    super(`Integrity check failed: ${reason}`);
    this.reason = reason;
  }
}

// Khóa chủ 32 byte lấy từ MASTER_KEY_BASE64 (.env)
function masterKey() {
  const key = Buffer.from(env.MASTER_KEY_BASE64 ?? '', 'base64');
  if (key.length !== 32) throw new Error('MASTER_KEY_BASE64 phải là 32 byte mã hóa base64');
  return key;
}

// Băm SHA-256 dạng hex
export function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

// Bọc khóa dữ liệu bằng khóa chủ: iv(12) | tag(16) | khóa đã mã hóa(32)
function wrapKey(dataKey) {
  const iv = randomBytes(12);
  const c = createCipheriv(ALGO, masterKey(), iv).setAAD(KEY_AAD);
  const enc = Buffer.concat([c.update(dataKey), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]);
}

// Mở khóa dữ liệu đã bọc
function unwrapKey(wrapped) {
  try {
    const d = createDecipheriv(ALGO, masterKey(), wrapped.subarray(0, 12)).setAAD(KEY_AAD);
    d.setAuthTag(wrapped.subarray(12, 28));
    return Buffer.concat([d.update(wrapped.subarray(28)), d.final()]);
  } catch {
    throw new IntegrityError('WRAPPED_KEY');
  }
}

// Mã hóa file bằng khóa dữ liệu riêng (AES-256-GCM); aad gắn bản mã với tên lưu trữ để chống tráo file
export function encryptFile(plain, aad) {
  const dataKey = randomBytes(32);
  const iv = randomBytes(12);
  const c = createCipheriv(ALGO, dataKey, iv).setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([c.update(plain), c.final()]);
  const out = { ciphertext, iv, authTag: c.getAuthTag(), wrappedKey: wrapKey(dataKey), sha256: sha256Hex(plain) };
  dataKey.fill(0);
  return out;
}

// Giải mã và kiểm tra 2 lớp: thẻ GCM, rồi SHA-256 so với mã băm lưu lúc tải lên
export function decryptFile({ ciphertext, iv, authTag, wrappedKey, aad, expectedSha256 }) {
  if (!wrappedKey) throw new IntegrityError('KEY_DESTROYED');
  const dataKey = unwrapKey(wrappedKey);
  let plain;
  try {
    const d = createDecipheriv(ALGO, dataKey, iv).setAAD(Buffer.from(aad));
    d.setAuthTag(authTag);
    plain = Buffer.concat([d.update(ciphertext), d.final()]);
  } catch {
    throw new IntegrityError('AUTH_TAG');
  } finally {
    dataKey.fill(0);
  }
  if (sha256Hex(plain) !== expectedSha256) throw new IntegrityError('SHA256_MISMATCH');
  return plain;
}
