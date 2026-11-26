import 'dotenv/config';
import { createDecipheriv } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readdir, rm, stat } from 'node:fs/promises';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import path from 'node:path';

const MAGIC = Buffer.from('RRBK1\n');

// Giải mã và bung bản sao lưu ra thư mục: database.sql + storage/... (khôi phục làm thủ công, ngoài giao diện hệ thống)
async function main() {
  const [file, outDir] = process.argv.slice(2);
  if (!file || !outDir) throw new Error('Cách dùng: node scripts/restore-backup.js <file.rrbk> <thư-mục-ra>');
  const key = Buffer.from(process.env.BACKUP_KEY_BASE64 ?? '', 'base64');
  if (key.length !== 32) throw new Error('Thiếu BACKUP_KEY_BASE64 (32 byte base64) trong .env');
  const { size } = await stat(file);
  const fh = await open(file, 'r');
  const head = Buffer.alloc(MAGIC.length + 12);
  const tag = Buffer.alloc(16);
  await fh.read(head, 0, head.length, 0);
  await fh.read(tag, 0, 16, size - 16);
  await fh.close();
  if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Không phải file sao lưu của hệ thống');
  // Giải mã kèm thẻ xác thực; lượt 1 chỉ kiểm tra toàn vẹn, đạt mới bung ra đĩa ở lượt 2
  const decipher = () => {
    const d = createDecipheriv('aes-256-gcm', key, head.subarray(MAGIC.length));
    d.setAAD(MAGIC);
    d.setAuthTag(tag);
    return d;
  };
  const body = () => createReadStream(file, { start: head.length, end: size - 17 });
  try {
    await pipeline(body(), decipher(), new Writable({ write: (c, e, cb) => cb() }));
  } catch {
    throw new Error('Bản sao lưu không vượt qua kiểm tra toàn vẹn (sai khóa hoặc file bị sửa); không bung gì cả');
  }
  const root = path.resolve(outDir);
  if ((await readdir(root).catch(() => [])).length) throw new Error('Thư mục ra phải chưa có hoặc đang trống');
  await mkdir(root, { recursive: true });
  let buf = Buffer.alloc(0);
  let current = null;
  let count = 0;
  // Đọc lần lượt từng mục của gói và ghi ra đĩa (chặn đường dẫn thoát khỏi thư mục ra)
  const sink = new Writable({
    async write(chunk, enc, cb) {
      try {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          if (current) {
            const take = Math.min(current.left, buf.length);
            if (take) { current.out.write(buf.subarray(0, take)); current.left -= take; buf = buf.subarray(take); }
            if (current.left > 0) break;
            await new Promise((r) => current.out.end(r));
            current = null;
            count++;
          }
          if (buf.length < 4) break;
          const len = buf.readUInt32BE(0);
          if (len === 0) { buf = Buffer.alloc(0); break; }
          if (buf.length < 4 + len) break;
          const meta = JSON.parse(buf.subarray(4, 4 + len).toString());
          buf = buf.subarray(4 + len);
          const target = path.resolve(root, meta.name);
          if (!target.startsWith(root + path.sep)) throw new Error(`Đường dẫn không hợp lệ: ${meta.name}`);
          await mkdir(path.dirname(target), { recursive: true });
          const out = createWriteStream(target, { mode: 0o600 });
          out.on('error', (e) => sink.destroy(e));
          current = { out, left: meta.size };
        }
        cb();
      } catch (err) { cb(err); }
    },
  });
  try {
    await pipeline(body(), decipher(), createGunzip(), sink);
  } catch (err) {
    await rm(root, { recursive: true, force: true });
    throw new Error(`Bung bản sao lưu thất bại: ${err.message}`);
  }
  console.log(`Đã bung ${count} mục vào ${root}. Nạp CSDL: mysql -u root records_retention < ${path.join(root, 'database.sql')}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
