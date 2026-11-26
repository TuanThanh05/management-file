import { spawn } from 'node:child_process';
import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, writeFile, appendFile, readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import path from 'node:path';
import { env } from '../config/env.js';
import { pool } from '../config/database.js';
import { withTx, SYSTEM_ACTOR } from '../core/tx.js';
import { getSettings } from '../core/settings.js';
import { runJob } from './runner.js';

export const BACKUP_MAGIC = Buffer.from('RRBK1\n');
export const BACKUP_FILE_RE = /^rr-backup-[0-9TZ-]+\.rrbk$/;
const STORAGE_AREAS = ['files', 'holds', 'certificates'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Sao lưu (5.5 CN7): dump CSDL + kho file đã mã hóa → nén → mã hóa AES-256-GCM bằng khóa sao lưu; xóa bản quá hạn giữ
export function runBackup({ runType = 'SCHEDULED', triggeredBy = null } = {}) {
  return runJob('BACKUP', { runType, triggeredBy }, backup);
}

// Chạy mysqldump bằng tài khoản chỉ đọc; mật khẩu đưa qua file cấu hình tạm quyền 600 (không lộ trên dòng lệnh)
async function dumpDatabase(target) {
  const cnf = path.join(path.dirname(target), `.my-${randomUUID()}.cnf`);
  await writeFile(cnf, `[client]\npassword="${env.BACKUP_DB_PASSWORD.replace(/["\\]/g, '\\$&')}"\n`, { mode: 0o600 });
  try {
    await new Promise((resolve, reject) => {
      const p = spawn(env.MYSQLDUMP_PATH, [
        `--defaults-extra-file=${cnf}`, '--host', env.DB_HOST, '--port', String(env.DB_PORT), '--user', env.BACKUP_DB_USER,
        '--single-transaction', '--routines', '--triggers', '--no-tablespaces', '--set-gtid-purged=OFF',
        '--default-character-set=utf8mb4', `--result-file=${target}`, env.DB_NAME,
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      p.stderr.on('data', (d) => { err += d; });
      p.on('error', (e) => reject(new Error(`Không chạy được mysqldump (${env.MYSQLDUMP_PATH}): ${e.message}`)));
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`mysqldump lỗi (${code}): ${err.trim().slice(0, 300)}`))));
    });
  } finally {
    await rm(cnf, { force: true });
  }
}

// Danh sách file trong kho (chỉ tên UUID, bỏ file tạm)
async function storageEntries() {
  const out = [];
  for (const area of STORAGE_AREAS) {
    const dir = path.resolve(env.STORAGE_DIR, area);
    const names = await readdir(dir).catch(() => []);
    for (const n of names.filter((x) => UUID_RE.test(x)).sort()) out.push({ name: `storage/${area}/${n}`, file: path.join(dir, n) });
  }
  return out;
}

// Luồng gói: mỗi mục = 4 byte độ dài + JSON {name, size} + nội dung; kết thúc bằng độ dài 0
function archiveStream(entries) {
  return Readable.from((async function* gen() {
    for (const e of entries) {
      const { size } = await stat(e.file);
      const head = Buffer.from(JSON.stringify({ name: e.name, size }));
      const len = Buffer.alloc(4);
      len.writeUInt32BE(head.length);
      yield Buffer.concat([len, head]);
      for await (const chunk of createReadStream(e.file)) yield chunk;
    }
    yield Buffer.alloc(4);
  })());
}

// Xóa bản sao lưu cũ hơn BACKUP_RETENTION_DAYS ngày
async function pruneOld(days) {
  const cutoff = Date.now() - days * 86_400_000;
  const removed = [];
  for (const n of await readdir(env.BACKUP_DIR)) {
    if (!BACKUP_FILE_RE.test(n)) continue;
    const { mtimeMs } = await stat(path.join(env.BACKUP_DIR, n));
    if (mtimeMs < cutoff) {
      await rm(path.join(env.BACKUP_DIR, n), { force: true });
      removed.push(n);
    }
  }
  return removed;
}

async function backup() {
  if (!env.backupEnabled) throw new Error('Chưa cấu hình sao lưu: cần BACKUP_KEY_BASE64 và BACKUP_DB_PASSWORD');
  await mkdir(env.BACKUP_DIR, { recursive: true, mode: 0o700 });
  const name = `rr-backup-${new Date().toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z')}.rrbk`;
  const final = path.join(env.BACKUP_DIR, name);
  const tmp = `${final}.${randomUUID()}.tmp`;
  const sql = path.join(env.BACKUP_DIR, `.dump-${randomUUID()}.sql`);
  try {
    await dumpDatabase(sql);
    const entries = [{ name: 'database.sql', file: sql }, ...(await storageEntries())];
    const iv = randomBytes(12);
    await writeFile(tmp, Buffer.concat([BACKUP_MAGIC, iv]), { mode: 0o600 });
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(env.BACKUP_KEY_BASE64, 'base64'), iv);
    cipher.setAAD(BACKUP_MAGIC);
    await pipeline(archiveStream(entries), createGzip(), cipher, createWriteStream(tmp, { flags: 'a' }));
    await appendFile(tmp, cipher.getAuthTag());
    await rename(tmp, final);
    const sha256 = createHash('sha256').update(await readFile(final)).digest('hex');
    const { size } = await stat(final);
    const { BACKUP_RETENTION_DAYS } = await getSettings(pool, ['BACKUP_RETENTION_DAYS']);
    const removed = await pruneOld(BACKUP_RETENTION_DAYS);
    await withTx(SYSTEM_ACTOR, ({ audit }) => audit({ action: 'BACKUP_CREATE', objectType: 'BACKUP', objectCode: name,
      details: { sizeBytes: size, sha256, files: entries.length - 1, retentionDays: BACKUP_RETENTION_DAYS, removed } }));
    return { processed: entries.length, errors: 0, note: `${name} (${size} byte, ${entries.length - 1} file kho); xóa ${removed.length} bản cũ` };
  } finally {
    await rm(sql, { force: true });
    await rm(tmp, { force: true });
  }
}

// Danh sách bản sao lưu hiện có, mới nhất trước
export async function listBackups() {
  const names = (await readdir(env.BACKUP_DIR).catch(() => [])).filter((n) => BACKUP_FILE_RE.test(n));
  const items = await Promise.all(names.map(async (n) => {
    const s = await stat(path.join(env.BACKUP_DIR, n));
    return { name: n, sizeBytes: s.size, createdAt: s.mtime.toISOString() };
  }));
  return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
