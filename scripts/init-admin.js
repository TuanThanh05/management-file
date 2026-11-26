#!/usr/bin/env node
// Tạo tài khoản Quản trị hệ thống ĐẦU TIÊN (chỉ chạy được khi hệ thống chưa có quản trị viên nào).
//
//   npm run init-admin -- --email admin@congty.vn --name "Quản trị hệ thống" \
//                         --dept-code CNTT --dept-name "Phòng Công nghệ thông tin"
//
// Mật khẩu tạm được sinh ngẫu nhiên và in ra MỘT lần; lần đăng nhập đầu bắt buộc đổi mật khẩu.
// Trigger trg_users_insert / trg_user_roles_insert trong CSDL chặn việc chạy lại khi đã có quản trị viên.
import { parseArgs } from 'node:util';
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { withTx, SYSTEM_ACTOR } from '../src/core/tx.js';
import { closeDb } from '../src/config/database.js';
import { toAppError } from '../src/core/errors.js';

const BCRYPT_COST = 12;
const ROLE_SYSTEM_ADMIN = 5;

const argsSchema = z.object({
  email: z.string().email().max(255).transform((s) => s.toLowerCase()),
  name: z.string().trim().min(1).max(100),
  'dept-code': z.string().regex(/^[A-Z0-9]{1,10}$/, 'Mã phòng ban: chữ in hoa/số, tối đa 10 ký tự'),
  'dept-name': z.string().trim().min(1).max(150).optional(),
});

function usage(msg) {
  if (msg) console.error(`Lỗi: ${msg}\n`);
  console.error('Cách dùng: npm run init-admin -- --email <email> --name "<họ tên>" --dept-code <MÃ> [--dept-name "<tên phòng>"]');
  process.exit(1);
}

async function main() {
  const { values } = parseArgs({
    options: {
      email: { type: 'string' },
      name: { type: 'string' },
      'dept-code': { type: 'string' },
      'dept-name': { type: 'string' },
    },
  });
  const parsed = argsSchema.safeParse(values);
  if (!parsed.success) usage(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const args = parsed.data;

  // Mật khẩu tạm: 18 byte ngẫu nhiên -> 24 ký tự base64url
  const tempPassword = randomBytes(18).toString('base64url');
  const passwordHash = await bcrypt.hash(tempPassword, BCRYPT_COST);

  const result = await withTx(SYSTEM_ACTOR, async ({ conn, audit }) => {
    const [[existing]] = await conn.query(
      `SELECT COUNT(*) AS n FROM user_roles WHERE role_id = ? AND revoked_at IS NULL`, [ROLE_SYSTEM_ADMIN]);
    if (Number(existing.n) > 0) throw new Error('Hệ thống đã có Quản trị viên; tạo tài khoản mới qua giao diện quản trị');

    // Phòng ban của quản trị viên: dùng lại nếu đã có, chưa có thì tạo
    let [[dept]] = await conn.query('SELECT id, code FROM departments WHERE code = ?', [args['dept-code']]);
    let deptCreated = false;
    if (!dept) {
      if (!args['dept-name']) throw new Error(`Phòng ban ${args['dept-code']} chưa có, cần thêm --dept-name`);
      const [ins] = await conn.query('INSERT INTO departments (code, name) VALUES (?, ?)', [args['dept-code'], args['dept-name']]);
      dept = { id: ins.insertId, code: args['dept-code'] };
      deptCreated = true;
    }

    const [userIns] = await conn.query(
      `INSERT INTO users (email, full_name, password_hash, department_id, must_change_password, created_by)
       VALUES (?, ?, ?, ?, TRUE, NULL)`,
      [args.email, args.name, passwordHash, dept.id]);
    const userId = userIns.insertId;

    await conn.query('INSERT INTO user_roles (user_id, role_id, granted_by) VALUES (?, ?, NULL)', [userId, ROLE_SYSTEM_ADMIN]);

    if (deptCreated) {
      await audit({ action: 'DEPARTMENT_CREATE', objectType: 'DEPARTMENT', objectCode: dept.code,
        details: { name: args['dept-name'], source: 'init-admin' } });
    }
    await audit({ action: 'SYSTEM_INIT_ADMIN', objectType: 'USER', objectCode: args.email,
      details: { userId: Number(userId), department: dept.code, role: 'SYSTEM_ADMIN' } });

    return { userId: Number(userId), department: dept.code };
  });

  console.log('Đã tạo Quản trị viên đầu tiên');
  console.log(`  Email       : ${args.email}`);
  console.log(`  Phòng ban   : ${result.department}`);
  console.log(`  Mật khẩu tạm: ${tempPassword}`);
  console.log('  (Chỉ hiển thị một lần. Đăng nhập lần đầu sẽ bắt buộc đổi mật khẩu.)');
}

main()
  .catch((err) => {
    const e = toAppError(err);
    console.error(`Không tạo được quản trị viên: ${e.status === 500 ? err.message : e.message}`);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
