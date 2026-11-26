import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool, closeDb } from '../src/config/database.js';
import { checkRules } from '../src/modules/labels/service.js';
import { ROLE, rand, directorSession, sessionWithRoles, lastAudit } from './helpers/fixtures.js';

const app = createApp();
let officer;
let officerCookie;
let directorCookie;
let director;

// Gọi API bằng cookie cho trước
const as = (cookie) => ({
  get: (url) => request(app).get(url).set('Cookie', cookie),
  post: (url, body) => request(app).post(url).set('Cookie', cookie).send(body),
  patch: (url, body) => request(app).patch(url).set('Cookie', cookie).send(body),
});
const cb = () => as(officerCookie);
const gd = () => as(directorCookie);

// Tạo nhóm và các loại tài liệu bằng API Cán bộ lưu trữ
async function setupGroup(typeCount = 2) {
  const group = 'G' + rand(6);
  expect((await cb().post('/api/catalog/groups', { code: group, name: `Nhóm ${group}` })).status).toBe(201);
  const types = [];
  for (let i = 0; i < typeCount; i++) {
    const code = 'T' + rand(7);
    expect((await cb().post('/api/catalog/document-types', { code, name: `Loại ${code}`, groupCode: group })).status).toBe(201);
    types.push(code);
  }
  return { group, types };
}

// Thân đề xuất Tạo mới mặc định: 10 năm, tính từ cuối năm tài chính
const createBody = (labelCode, group, types, extra = {}) => ({
  proposalType: 'CREATE', labelCode, groupCode: group, labelName: `Nhãn ${labelCode}`,
  legalBasis: 'Điều 13 Nghị định 174/2016/NĐ-CP', retentionType: 'FIXED', retentionYears: 10,
  startTrigger: 'FISCAL_YEAR_END', containsPersonalData: false, documentTypeCodes: types,
  proposalReason: 'Thiết lập ban đầu cho chứng từ kế toán', ...extra,
});

// Lập, gửi và duyệt một đề xuất; trả về đề xuất sau duyệt
async function createAndApprove(body) {
  const p = await cb().post('/api/labels/proposals', body);
  expect(p.status).toBe(201);
  expect((await cb().post(`/api/labels/proposals/${p.body.id}/submit`)).status).toBe(200);
  const a = await gd().post(`/api/labels/proposals/${p.body.id}/approve`);
  expect(a.status).toBe(200);
  return a.body;
}

beforeAll(async () => {
  ({ user: officer, cookie: officerCookie } = await sessionWithRoles(app, [ROLE.RECORDS_OFFICER]));
  ({ director, cookie: directorCookie } = await directorSession(app));
});
afterAll(() => closeDb());

describe('Nhóm hồ sơ (BM14)', () => {
  it('thêm, sửa tên/mô tả; mã không sửa được; trùng mã bị 409', async () => {
    const code = 'G' + rand(6);
    const r = await cb().post('/api/catalog/groups', { code: code.toLowerCase(), name: 'Kế toán', description: 'Chứng từ kế toán' });
    expect(r.status).toBe(201);
    expect(r.body.code).toBe(code);
    expect((await cb().post('/api/catalog/groups', { code, name: 'Trùng' })).status).toBe(409);
    const u = await cb().patch(`/api/catalog/groups/${code}`, { name: 'Tài chính – Kế toán' });
    expect(u.body.name).toBe('Tài chính – Kế toán');
    expect((await cb().patch(`/api/catalog/groups/${code}`, { code: 'KHAC' })).status).toBe(422);
    expect((await lastAudit('GROUP_UPDATE', code)).details.after.name).toBe('Tài chính – Kế toán');
  });

  it('chỉ ngừng sử dụng khi không còn nhãn hiệu lực; mở lại được', async () => {
    const { group, types } = await setupGroup(1);
    await createAndApprove(createBody('L' + rand(6), group, types));
    const blocked = await cb().post(`/api/catalog/groups/${group}/deactivate`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.details.activeLabels).toBe(1);

    const empty = 'G' + rand(6);
    await cb().post('/api/catalog/groups', { code: empty, name: 'Trống' });
    expect((await cb().post(`/api/catalog/groups/${empty}/deactivate`)).body.status).toBe('INACTIVE');
    expect((await cb().post(`/api/catalog/groups/${empty}/activate`)).body.status).toBe('ACTIVE');
  });

  it('Nhân viên xem được danh mục nhưng không sửa được', async () => {
    const { cookie } = await sessionWithRoles(app, [ROLE.EMPLOYEE]);
    expect((await as(cookie).get('/api/catalog/document-types?usable=true')).status).toBe(200);
    expect((await as(cookie).post('/api/catalog/groups', { code: 'X' + rand(5), name: 'X' })).status).toBe(403);
    expect((await as(cookie).get('/api/labels')).status).toBe(403);
  });
});

describe('Loại tài liệu (BM15)', () => {
  it('loại mới chưa gắn nhãn nên chưa dùng được; nhóm ngừng sử dụng thì không thêm loại được', async () => {
    const { group, types } = await setupGroup(1);
    const t = await cb().get(`/api/catalog/document-types/${types[0]}`);
    expect(t.body).toMatchObject({ label: null, usable: false, group: { code: group } });
    const closed = 'G' + rand(6);
    await cb().post('/api/catalog/groups', { code: closed, name: 'Đóng' });
    await cb().post(`/api/catalog/groups/${closed}/deactivate`);
    expect((await cb().post('/api/catalog/document-types', { code: 'T' + rand(7), name: 'X', groupCode: closed })).status).toBe(422);
  });

  it('không đổi nhóm/nhãn trực tiếp; ngừng và mở lại được', async () => {
    const { types } = await setupGroup(1);
    expect((await cb().patch(`/api/catalog/document-types/${types[0]}`, { groupCode: 'KHAC' })).status).toBe(422);
    expect((await cb().patch(`/api/catalog/document-types/${types[0]}`, { name: 'Hóa đơn GTGT' })).body.name).toBe('Hóa đơn GTGT');
    expect((await cb().post(`/api/catalog/document-types/${types[0]}/deactivate`)).body.status).toBe('INACTIVE');
    expect((await cb().post(`/api/catalog/document-types/${types[0]}/activate`)).body.status).toBe('ACTIVE');
  });
});

describe('Đề xuất nhãn (BM02) và phê duyệt', () => {
  it('trọn vòng: lập → gửi (báo Giám đốc) → duyệt → loại tài liệu có nhãn hiệu lực', async () => {
    const { group, types } = await setupGroup(2);
    const labelCode = 'KT-' + rand(5);
    const p = await cb().post('/api/labels/proposals', createBody(labelCode, group, types));
    expect(p.status).toBe(201);
    expect(p.body).toMatchObject({ status: 'DRAFT', versionNo: 1, warningDays: 30, documentTypes: [...types].sort() });

    const sub = await cb().post(`/api/labels/proposals/${p.body.id}/submit`);
    expect(sub.body.status).toBe('PENDING');
    const [[n]] = await pool.query("SELECT type FROM notifications WHERE recipient_id = ? AND object_code = ?", [director.id, `${labelCode}/v1`]);
    expect(n.type).toBe('ACTION_REQUIRED');

    const a = await gd().post(`/api/labels/proposals/${p.body.id}/approve`);
    expect(a.body).toMatchObject({ status: 'ACTIVE', reviewedBy: director.email });
    expect(a.body.effectiveAt).toBeTruthy();
    const t = await cb().get(`/api/catalog/document-types/${types[0]}`);
    expect(t.body).toMatchObject({ usable: true, label: { code: labelCode, versionNo: 1, retentionYears: 10, startTrigger: 'FISCAL_YEAR_END' } });
    expect((await lastAudit('LABEL_APPROVE', `${labelCode}/v1`)).result).toBe('SUCCESS');
    const [[back]] = await pool.query("SELECT type FROM notifications WHERE recipient_id = ? AND object_code = ? AND type = 'REVIEW_RESULT'", [officer.id, `${labelCode}/v1`]);
    expect(back).toBeTruthy();
  });

  it('kiểm tra luật BM02: thiếu mốc tính, T ngoài 1–100, sự kiện thiếu tên, lý do ngắn, không có loại', async () => {
    const { group, types } = await setupGroup(1);
    const post = (extra) => cb().post('/api/labels/proposals', createBody('L' + rand(6), group, types, extra));
    expect((await post({ startTrigger: null })).body.error.details[0].field).toBe('startTrigger');
    expect((await post({ retentionYears: 101 })).body.error.details[0].field).toBe('retentionYears');
    expect((await post({ startTrigger: 'EVENT_END' })).body.error.details[0].field).toBe('eventName');
    expect((await post({ proposalReason: 'ngắn' })).status).toBe(422);
    expect((await post({ documentTypeCodes: [] })).status).toBe(422);
    const perm = await post({ retentionType: 'PERMANENT', retentionYears: 5, startTrigger: 'ARCHIVED_DATE' });
    expect(perm.status).toBe(201);
    expect(perm.body).toMatchObject({ retentionYears: null, startTrigger: null, warningDays: null });
  });

  it('loại khác nhóm bị 422; loại đang nằm trong đề xuất khác chưa xử lý bị 409', async () => {
    const a = await setupGroup(1);
    const b = await setupGroup(1);
    expect((await cb().post('/api/labels/proposals', createBody('L' + rand(6), a.group, b.types))).status).toBe(422);
    await cb().post('/api/labels/proposals', createBody('L' + rand(6), a.group, a.types));
    const busy = await cb().post('/api/labels/proposals', createBody('L' + rand(6), a.group, a.types));
    expect(busy.status).toBe(409);
    expect(busy.body.error.details[0].documentType).toBe(a.types[0]);
  });

  it('sửa Nháp được cả danh sách loại tài liệu; người khác không sửa/gửi được', async () => {
    const { group, types } = await setupGroup(3);
    const p = await cb().post('/api/labels/proposals', createBody('L' + rand(6), group, types));
    const e = await cb().patch(`/api/labels/proposals/${p.body.id}`, { retentionYears: 5, documentTypeCodes: [types[0]] });
    expect(e.status).toBe(200);
    expect(e.body).toMatchObject({ retentionYears: 5, documentTypes: [types[0]] });
    expect((await lastAudit('LABEL_PROPOSAL_UPDATE', `${p.body.labelCode}/v1`)).details.documentTypes.removed).toHaveLength(2);

    const { cookie: other } = await sessionWithRoles(app, [ROLE.RECORDS_OFFICER]);
    expect((await as(other).patch(`/api/labels/proposals/${p.body.id}`, { retentionYears: 7 })).status).toBe(403);
    expect((await as(other).post(`/api/labels/proposals/${p.body.id}/submit`)).status).toBe(403);
  });

  it('đã gửi thì khóa sửa; rút về Nháp thì sửa lại được và báo Giám đốc', async () => {
    const { group, types } = await setupGroup(1);
    const p = await cb().post('/api/labels/proposals', createBody('L' + rand(6), group, types));
    await cb().post(`/api/labels/proposals/${p.body.id}/submit`);
    expect((await cb().patch(`/api/labels/proposals/${p.body.id}`, { retentionYears: 7 })).status).toBe(409);
    const w = await cb().post(`/api/labels/proposals/${p.body.id}/withdraw`);
    expect(w.body.status).toBe('DRAFT');
    const [[n]] = await pool.query("SELECT 1 FROM notifications WHERE recipient_id = ? AND type = 'WITHDRAWN' AND object_code = ?", [director.id, `${p.body.labelCode}/v1`]);
    expect(n).toBeTruthy();
    expect((await cb().patch(`/api/labels/proposals/${p.body.id}`, { retentionYears: 7 })).body.retentionYears).toBe(7);
  });

  it('từ chối: bắt buộc lý do; sửa lại thành Nháp và gửi lại được', async () => {
    const { group, types } = await setupGroup(1);
    const p = await cb().post('/api/labels/proposals', createBody('L' + rand(6), group, types));
    await cb().post(`/api/labels/proposals/${p.body.id}/submit`);
    expect((await gd().post(`/api/labels/proposals/${p.body.id}/reject`, { comment: 'ngắn' })).status).toBe(422);
    const r = await gd().post(`/api/labels/proposals/${p.body.id}/reject`, { comment: 'Căn cứ pháp lý chưa đúng điều khoản' });
    expect(r.body).toMatchObject({ status: 'REJECTED', reviewComment: 'Căn cứ pháp lý chưa đúng điều khoản' });
    const e = await cb().patch(`/api/labels/proposals/${p.body.id}`, { legalBasis: 'Điều 41 Luật Kế toán 2015' });
    expect(e.body.status).toBe('DRAFT');
    expect((await cb().post(`/api/labels/proposals/${p.body.id}/submit`)).body.status).toBe('PENDING');
  });

  it('Cán bộ lưu trữ không duyệt được; Giám đốc không lập đề xuất được', async () => {
    const { group, types } = await setupGroup(1);
    const p = await cb().post('/api/labels/proposals', createBody('L' + rand(6), group, types));
    await cb().post(`/api/labels/proposals/${p.body.id}/submit`);
    expect((await cb().post(`/api/labels/proposals/${p.body.id}/approve`)).status).toBe(403);
    expect((await gd().post('/api/labels/proposals', createBody('L' + rand(6), group, types))).status).toBe(403);
  });
});

describe('Sửa nhãn, cảnh báo rút ngắn, ngừng áp dụng', () => {
  it('sửa rút ngắn T: Giám đốc thấy so sánh + cảnh báo; duyệt thì bản cũ Ngừng áp dụng, loại bị bỏ ra mất nhãn', async () => {
    const { group, types } = await setupGroup(2);
    const labelCode = 'L' + rand(6);
    await createAndApprove(createBody(labelCode, group, types));

    const upd = await cb().post('/api/labels/proposals', {
      proposalType: 'UPDATE', labelCode, labelName: `Nhãn ${labelCode}`, legalBasis: 'Quy định nội bộ 2026',
      retentionType: 'FIXED', retentionYears: 5, startTrigger: 'FISCAL_YEAR_END', containsPersonalData: false,
      documentTypeCodes: [types[0]], proposalReason: 'Rút ngắn theo quy định nội bộ mới',
    });
    expect(upd.body.versionNo).toBe(2);
    await cb().post(`/api/labels/proposals/${upd.body.id}/submit`);

    const view = await gd().get(`/api/labels/proposals/${upd.body.id}`);
    expect(view.body.comparison.againstVersionNo).toBe(1);
    expect(view.body.comparison.changes.map((c) => c.field)).toEqual(expect.arrayContaining(['retentionYears', 'legalBasis', 'documentTypes']));
    expect(view.body.warnings[0]).toMatchObject({ code: 'SHORTENED_PERIOD', old: '10 năm', new: '5 năm', affectedRecords: 0 });

    const a = await gd().post(`/api/labels/proposals/${upd.body.id}/approve`);
    expect(a.body.typesWithoutLabel).toEqual([types[1]]);
    const hist = await cb().get(`/api/labels/${labelCode}`);
    expect(hist.body.versions.map((v) => v.status)).toEqual(['RETIRED', 'ACTIVE']);
    expect(hist.body.versions[0]).toMatchObject({ recordCount: 0 });
    expect((await cb().get(`/api/catalog/document-types/${types[0]}`)).body.label.versionNo).toBe(2);
    expect((await cb().get(`/api/catalog/document-types/${types[1]}`)).body).toMatchObject({ label: null, usable: false });

    const cmp = await gd().get(`/api/labels/${labelCode}/compare?from=1&to=2`);
    expect(cmp.body.changes.find((c) => c.field === 'retentionYears')).toMatchObject({ old: 10, new: 5 });
  });

  it('cảnh báo khi kéo loại tài liệu từ nhãn có thời hạn dài hơn sang', async () => {
    const { group, types } = await setupGroup(1);
    const longLabel = 'L' + rand(6);
    await createAndApprove(createBody(longLabel, group, types, { retentionType: 'PERMANENT' }));
    const shortLabel = 'L' + rand(6);
    const p = await cb().post('/api/labels/proposals', createBody(shortLabel, group, types, { retentionYears: 3 }));
    const view = await cb().get(`/api/labels/proposals/${p.body.id}`);
    expect(view.body.warnings[0]).toMatchObject({ code: 'TYPE_MOVED_FROM_LONGER', types: [{ documentType: types[0], fromLabel: longLabel, fromPeriod: 'Vĩnh viễn' }] });
  });

  it('ngừng áp dụng chỉ khi không còn loại đang sử dụng; duyệt xong nhãn không còn bản hiệu lực', async () => {
    const { group, types } = await setupGroup(1);
    const labelCode = 'L' + rand(6);
    await createAndApprove(createBody(labelCode, group, types));
    const deact = { proposalType: 'DEACTIVATE', labelCode, proposalReason: 'Loại tài liệu không còn phát sinh' };
    const blocked = await cb().post('/api/labels/proposals', deact);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.details.typesInUse).toBe(1);

    await cb().post(`/api/catalog/document-types/${types[0]}/deactivate`);
    const done = await createAndApprove(deact);
    expect(done.status).toBe('RETIRED');
    const list = await cb().get('/api/labels');
    expect(list.body.items.find((l) => l.code === labelCode).active).toBeNull();
    expect((await cb().post(`/api/catalog/groups/${group}/deactivate`)).body.status).toBe('INACTIVE');
  });

  it('mỗi nhãn chỉ có 1 đề xuất đang mở', async () => {
    const { group, types } = await setupGroup(1);
    const labelCode = 'L' + rand(6);
    await createAndApprove(createBody(labelCode, group, types));
    const upd = (years) => cb().post('/api/labels/proposals', {
      proposalType: 'UPDATE', labelCode, labelName: 'X', legalBasis: 'Y', retentionType: 'FIXED', retentionYears: years,
      startTrigger: 'ARCHIVED_DATE', containsPersonalData: true, documentTypeCodes: types, proposalReason: 'Điều chỉnh lần một',
    });
    expect((await upd(12)).status).toBe(201);
    const second = await upd(15);
    expect(second.status).toBe(409);
    expect(second.body.error.message).toMatch(/phiên bản 2 chưa xử lý/);
  });
});

describe('checkRules', () => {
  it('Vĩnh viễn không cần T/mốc/N; có thời hạn bắt buộc đủ', () => {
    expect(checkRules({ retentionType: 'PERMANENT' })).toEqual([]);
    expect(checkRules({ retentionType: 'FIXED', retentionYears: 10, startTrigger: 'ARCHIVED_DATE', warningDays: 30 })).toEqual([]);
    expect(checkRules({ retentionType: 'FIXED', retentionYears: 0, startTrigger: null, warningDays: 400 }).map((e) => e.field))
      .toEqual(['retentionYears', 'startTrigger', 'warningDays']);
  });
});
