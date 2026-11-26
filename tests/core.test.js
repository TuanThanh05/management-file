// Kiểm thử phần lõi ngày 1 trên CSDL thật (cần đã nạp database/records_retention.sql và chạy init-admin)
import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import { randomBytes } from 'node:crypto';
import { createApp } from '../src/app.js';
import { pool, closeDb } from '../src/config/database.js';
import { withTx, writeAudit, SYSTEM_ACTOR } from '../src/core/tx.js';
import { toAppError } from '../src/core/errors.js';
import { nextCode } from '../src/core/codes.js';
import { todayVN } from '../src/core/time.js';

const randCode = () => 'T' + randomBytes(4).toString('hex').toUpperCase().slice(0, 7);
const lastSeq = async () => Number((await pool.query('SELECT last_seq FROM audit_chain_head'))[0][0].last_seq);

afterAll(() => closeDb());

describe('GET /api/health', () => {
  it('trả 200 và db ok', async () => {
    const res = await request(createApp()).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', db: 'ok' });
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('API không tồn tại trả 404 đúng định dạng lỗi', async () => {
    const res = await request(createApp()).get('/api/khong-co');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('withTx', () => {
  it('commit: dữ liệu và nhật ký cùng được ghi', async () => {
    const code = randCode();
    const before = await lastSeq();
    await withTx(SYSTEM_ACTOR, async ({ conn, audit }) => {
      await conn.query('INSERT INTO departments (code, name) VALUES (?, ?)', [code, 'Phòng test commit']);
      await audit({ action: 'DEPARTMENT_CREATE', objectType: 'DEPARTMENT', objectCode: code });
    });
    const [rows] = await pool.query('SELECT 1 FROM departments WHERE code = ?', [code]);
    expect(rows).toHaveLength(1);
    expect(await lastSeq()).toBe(before + 1);
  });

  it('rollback: lỗi giữa chừng thì không còn dữ liệu lẫn nhật ký', async () => {
    const code = randCode();
    const before = await lastSeq();
    await expect(
      withTx(SYSTEM_ACTOR, async ({ conn, audit }) => {
        await conn.query('INSERT INTO departments (code, name) VALUES (?, ?)', [code, 'Phòng test rollback']);
        await audit({ action: 'DEPARTMENT_CREATE', objectType: 'DEPARTMENT', objectCode: code });
        throw new Error('lỗi giả lập');
      }),
    ).rejects.toThrow('lỗi giả lập');
    const [rows] = await pool.query('SELECT 1 FROM departments WHERE code = ?', [code]);
    expect(rows).toHaveLength(0);
    expect(await lastSeq()).toBe(before);
  });
});

describe('Map lỗi CSDL', () => {
  it('trigger SIGNAL 45000 -> 409 BUSINESS_RULE_VIOLATION', async () => {
    const code = randCode();
    await pool.query('INSERT INTO departments (code, name) VALUES (?, ?)', [code, 'Phòng test trigger']);
    const err = await pool.query('UPDATE departments SET code = ? WHERE code = ?', [randCode(), code]).catch((e) => e);
    const appErr = toAppError(err);
    expect(appErr.status).toBe(409);
    expect(appErr.code).toBe('BUSINESS_RULE_VIOLATION');
    expect(appErr.message).toBe('Không được sửa mã phòng ban');
  });

  it('trùng khóa UNIQUE -> 409 DUPLICATE', async () => {
    const code = randCode();
    await pool.query('INSERT INTO departments (code, name) VALUES (?, ?)', [code, 'A']);
    const err = await pool.query('INSERT INTO departments (code, name) VALUES (?, ?)', [code, 'B']).catch((e) => e);
    expect(toAppError(err)).toMatchObject({ status: 409, code: 'DUPLICATE', details: { constraint: 'departments.uq_departments_code' } });
  });

  it('CHECK constraint -> 422', async () => {
    const err = await pool.query('INSERT INTO departments (code, name) VALUES (?, ?)', ['ma-thuong', 'X']).catch((e) => e);
    expect(toAppError(err)).toMatchObject({ status: 422, code: 'CONSTRAINT_VIOLATION', details: { constraint: 'ck_departments_code' } });
  });

  it('tài khoản ứng dụng KHÔNG xóa được dòng (lớp bảo vệ 1)', async () => {
    const err = await pool.query('DELETE FROM audit_logs WHERE seq = 1').catch((e) => e);
    expect(err.errno).toBe(1142); // DELETE command denied
    expect(toAppError(err).status).toBe(500);
  });

  it('tài khoản ứng dụng KHÔNG ghi thẳng vào audit_logs được', async () => {
    const err = await pool.query("UPDATE audit_logs SET action = 'X' WHERE seq = 1").catch((e) => e);
    expect(err.errno).toBe(1142);
  });
});

describe('nextCode', () => {
  it('sinh mã đúng định dạng và tăng dần', async () => {
    const dept = randCode();
    const [a, b] = await withTx(SYSTEM_ACTOR, async ({ conn }) => [
      await nextCode(conn, 'RECORD', { departmentCode: dept }),
      await nextCode(conn, 'RECORD', { departmentCode: dept }),
    ]);
    const year = todayVN().slice(0, 4);
    expect(a).toBe(`HS-${dept}-${year}-000001`);
    expect(b).toBe(`HS-${dept}-${year}-000002`);
  });

  it('rollback thì số thứ tự không bị tiêu', async () => {
    const dept = randCode();
    await withTx(SYSTEM_ACTOR, async ({ conn }) => {
      await nextCode(conn, 'DISPOSAL_BATCH', { departmentCode: dept });
      throw new Error('hủy');
    }).catch(() => {});
    const code = await withTx(SYSTEM_ACTOR, ({ conn }) => nextCode(conn, 'DISPOSAL_BATCH', { departmentCode: dept }));
    expect(code).toMatch(/-001$/);
  });

  it('mã không theo phòng ban', async () => {
    const code = await withTx(SYSTEM_ACTOR, ({ conn }) => nextCode(conn, 'EXTENSION'));
    expect(code).toMatch(/^GH-\d{4}-\d{4}$/);
  });
});

describe('Chuỗi băm nhật ký', () => {
  it('ghi nhiều dòng rồi kiểm tra toàn vẹn -> INTACT', async () => {
    await withTx({ userId: null, roles: ['SYSTEM'], ip: '127.0.0.1' }, async ({ conn }) => {
      for (let i = 0; i < 3; i++) {
        await writeAudit(conn, { roles: 'SYSTEM' }, { action: 'TEST_EVENT', details: { i, note: 'tiếng Việt có dấu' } });
      }
    });
    const head = await lastSeq();
    await pool.query('CALL sp_verify_audit_chain(1, ?, @c, @r, @b, @i, @h)', [head]);
    const [[out]] = await pool.query('SELECT @c AS checked, @r AS result, @b AS badSeq');
    expect(out.result).toBe('INTACT');
    expect(Number(out.checked)).toBe(head);
    expect(out.badSeq).toBeNull();
  });
});

describe('todayVN', () => {
  it('18:00 UTC đã là ngày hôm sau ở Việt Nam', () => {
    expect(todayVN(new Date('2026-11-25T18:00:00Z'))).toBe('2026-11-26');
    expect(todayVN(new Date('2026-11-25T16:59:59Z'))).toBe('2026-11-25');
  });
});
