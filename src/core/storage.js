import { mkdir, writeFile, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Đường dẫn file trong kho theo tên lưu trữ (UUID), chặn đường dẫn lạ
function blobPath(area, name) {
  if (!UUID_RE.test(name)) throw new Error('Tên lưu trữ không hợp lệ');
  return path.resolve(env.STORAGE_DIR, area, name);
}

// Ghi bản mã vào kho: ghi file tạm rồi đổi tên, quyền 600
export async function writeBlob(area, name, data) {
  const target = blobPath(area, name);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.${randomUUID()}.tmp`;
  await writeFile(tmp, data, { mode: 0o600, flag: 'wx' });
  await rename(tmp, target);
}

// Đọc bản mã từ kho; không có file thì trả null
export async function readBlob(area, name) {
  try {
    return await readFile(blobPath(area, name));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// Xóa bản mã khỏi kho; trả true nếu đã xóa hoặc không còn file
export async function deleteBlob(area, name) {
  try {
    await unlink(blobPath(area, name));
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return true;
    throw err;
  }
}
