import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import ExcelJS from 'exceljs';
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile, utimes, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { pool, closeDb } from '../src/config/database.js';
import { env } from '../src/config/env.js';
import { ROLE, createUser, createDepartment, login, sessionWithRoles, adminSession, lastAudit } from './helpers/fixtures.js';
import { createUsableType } from './helpers/catalog.js';

const app = createApp();
const pdf = readFileSync(path.join('tests/fixtures', 'sample.pdf'));
const binary = (req) => req.buffer(true).parse((res, cb) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
const hasMysqldump = spawnSync(env.MYSQLDUMP_PATH, ['--version']).status === 0;

// Gọi API bằng cookie cho trước
const as = (cookie) => ({
  get: (url, query) => request(app).get(url).query(query ?? {}).set('Cookie', cookie),
  raw: (url, query) => binary(request(app).get(url).query(query ?? {}).set('Cookie', cookie)),
  post: (url, body) => request(app).post(url).set('Cookie', cookie).send(body),
  upload: (url) => request(app).post(url).set('Cookie', cookie).attach('file', pdf, 'chung-tu.pdf'),
});

// Đăng nhập người dùng mới với vai trò và phòng ban cho trước
async function userIn(departmentId, roles) {
  const user = await createUser({ roles, departmentId });
  const { cookie } = await login(app, user.email, user.password);
  return { user, api: as(cookie) };
}

// Đọc các dòng dữ liệu của sheet đầu tiên trong file XLSX (bỏ phần thông tin đầu trang)
async function xlsxRows(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const rows = [];
  wb.worksheets[0].eachRow((r) => rows.push(r.values.slice(1)));
  return rows;
}

let dept;
let emp;
let head;
let officer;
let admin;
let type;
let codes;

beforeAll(async () => {
  type = await createUsableType(app, { retentionYears: 1 });
  dept = await createDepartment();
  emp = await userIn(dept.id, [ROLE.EMPLOYEE]);
  head = await userIn(dept.id, [ROLE.DEPARTMENT_HEAD]);
  const o = await sessionWithRoles(app, [ROLE.RECORDS_OFFICER]);
  officer = { user: o.user, api: as(o.cookie) };
  admin = as((await adminSession(app)).cookie);
  codes = [];
  for (const t of ['Hóa đơn 01', 'Hóa đơn 02', 'Hóa đơn 03']) {
    const r = await emp.api.post('/api/records', { title: t, documentTypeCode: type.type, documentDate: '2019-05-01' });
    codes.push(r.body.code);
  }
  for (const c of codes.slice(0, 2)) {
    await emp.api.upload(`/api/records/${c}/files`).expect(201);
    await emp.api.post(`/api/records/${c}/submit`).expect(200);
    await head.api.post(`/api/records/${c}/approve`).expect(200);
  }
  await admin.post('/api/admin/jobs/expiry-scan/run').expect(200);
});
afterAll(() => closeDb());

describe('Thống kê (BM13)', () => {
  it('Trưởng phòng: chỉ phòng mình, đủ chỉ tiêu', async () => {
    const r = await head.api.get('/api/reports/summary');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ scope: 'DEPARTMENT', department: dept.code, total: 3 });
    expect(r.body.byStatus).toMatchObject({ IN_USE: 1, EXPIRED: 2, DISPOSED: 0 });
    expect(r.body.byGroup).toEqual([expect.objectContaining({ code: type.group, count: 3 })]);
    expect(r.body).toHaveProperty('expiringIn30Days');
    expect(r.body).not.toHaveProperty('byDepartment');
    expect((await emp.api.get('/api/reports/summary')).status).toBe(403);
  });

  it('Cán bộ lưu trữ: toàn doanh nghiệp, chia theo phòng, đợt hủy, gia hạn trong kỳ', async () => {
    const r = await officer.api.get('/api/reports/summary', { from: '2026-01-01', to: '2026-12-31' });
    expect(r.body.scope).toBe('ALL');
    expect(r.body.byDepartment.find((d) => d.code === dept.code)).toMatchObject({ total: 3 });
    expect(Object.keys(r.body.batchesByStatus)).toContain('COMPLETED');
    expect(r.body.extensions.period).toEqual({ from: '2026-01-01', to: '2026-12-31' });
    expect((await officer.api.get('/api/reports/summary', { from: '2026-12-31', to: '2026-01-01' })).status).toBe(422);
  });
});

describe('Xuất file', () => {
  it('xuất danh sách hồ sơ XLSX theo điều kiện tra cứu, ghi nhật ký số dòng', async () => {
    const r = await head.api.raw('/api/records/export', { format: 'xlsx', status: 'EXPIRED,IN_USE', sortBy: 'code', sortDir: 'asc' });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('spreadsheetml');
    const rows = await xlsxRows(r.body);
    const header = rows.findIndex((x) => x[0] === 'Mã hồ sơ');
    expect(rows.slice(header + 1).map((x) => x[0])).toEqual([...codes].sort());
    expect(rows.slice(header + 1).find((x) => x[0] === codes[0])[4]).toBe('Hết hạn');
    const [[log]] = await pool.query("SELECT details FROM audit_logs WHERE action = 'RECORD_EXPORT' ORDER BY seq DESC LIMIT 1");
    expect((typeof log.details === 'string' ? JSON.parse(log.details) : log.details).rows).toBe(3);
    expect((await emp.api.get('/api/records/export')).status).toBe(403);
  });

  it('xuất PDF; phòng khác không thấy hồ sơ của phòng này', async () => {
    const p = await officer.api.raw('/api/records/export', { format: 'pdf', q: codes[0] });
    expect(p.body.subarray(0, 5).toString()).toBe('%PDF-');
    const otherHead = await userIn((await createDepartment()).id, [ROLE.DEPARTMENT_HEAD]);
    const rows = await xlsxRows((await otherHead.api.raw('/api/records/export', { q: codes[0] })).body);
    expect(rows.some((x) => x[0] === codes[0])).toBe(false);
  });

  it('xuất danh mục đề nghị hủy BM05 của một đợt', async () => {
    await officer.api.post('/api/retention/eligibility', { recordCodes: codes.slice(0, 2), eligible: true }).expect(200);
    const b = (await officer.api.post('/api/disposals', { departmentCode: dept.code, reason: 'Hóa đơn hết thời hạn lưu trữ', recordCodes: codes.slice(0, 2) })).body.code;
    const r = await officer.api.raw(`/api/disposals/${b}/export`, { format: 'xlsx' });
    expect(r.status).toBe(200);
    const rows = await xlsxRows(r.body);
    expect(rows.find((x) => x[0] === 'Mã đợt hủy')[1]).toBe(b);
    const header = rows.findIndex((x) => x[0] === 'STT');
    expect(rows.slice(header + 1)).toHaveLength(2);
    expect(rows[header + 1][7]).toBe(1);
    expect((await officer.api.raw(`/api/disposals/${b}/export`, { format: 'pdf' })).body.subarray(0, 5).toString()).toBe('%PDF-');
    expect(await lastAudit('DISPOSAL_BATCH_EXPORT', b)).toBeTruthy();
    expect((await head.api.get(`/api/disposals/${b}/export`)).status).toBe(403);
  });
});

describe.skipIf(!hasMysqldump)('Sao lưu (5.5 CN7)', () => {
  it('chạy tay: tạo bản mã hóa, xóa bản quá hạn, giải mã được bằng khóa sao lưu', async () => {
    await mkdir(env.BACKUP_DIR, { recursive: true });
    const old = path.join(env.BACKUP_DIR, 'rr-backup-2020-01-01T00-00-00Z.rrbk');
    await writeFile(old, 'cũ');
    await utimes(old, new Date('2020-01-01'), new Date('2020-01-01'));
    expect((await officer.api.post('/api/admin/backups/run')).status).toBe(403);
    const r = await admin.post('/api/admin/backups/run');
    expect(r.status).toBe(200);
    expect(r.body.result).toBe('SUCCESS');
    const list = await admin.get('/api/admin/backups');
    expect(list.body.lastRun.result).toBe('SUCCESS');
    expect(list.body.items.some((i) => i.name.includes('2020-01-01'))).toBe(false);
    const file = path.join(env.BACKUP_DIR, list.body.items[0].name);
    const raw = await readFile(file);
    expect(raw.subarray(0, 6).toString()).toBe('RRBK1\n');
    expect(raw.includes(Buffer.from('CREATE TABLE'))).toBe(false);
    const out = path.resolve('backups-test', `restore-${Date.now()}`);
    execFileSync(process.execPath, ['scripts/restore-backup.js', file, out], { env: { ...process.env, BACKUP_KEY_BASE64: env.BACKUP_KEY_BASE64 } });
    const sql = await readFile(path.join(out, 'database.sql'), 'utf8');
    expect(sql).toContain('CREATE TABLE `records`');
    expect(sql).toContain('trg_audit_logs_no_update');
    expect(await lastAudit('BACKUP_CREATE', list.body.items[0].name)).toBeTruthy();
    await rm(out, { recursive: true, force: true });
  });
});

describe('Tài liệu API', () => {
  it('Swagger UI và OpenAPI JSON (ngoài production)', async () => {
    const spec = await request(app).get('/api/docs/openapi.json');
    expect(spec.status).toBe(200);
    expect(spec.body.openapi).toBe('3.1.0');
    expect(Object.keys(spec.body.paths).length).toBeGreaterThan(80);
    expect(spec.body.paths['/api/records'].post.summary).toBe('Tạo hồ sơ (BM01)');
    expect(spec.body.paths['/api/auth/login'].post.security).toEqual([]);
    const ui = await request(app).get('/api/docs/');
    expect(ui.status).toBe(200);
    expect(ui.text).toContain('swagger-ui');
  });
});
