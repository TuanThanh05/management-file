import request from 'supertest';
import { rand, ROLE, sessionWithRoles, directorSession } from './fixtures.js';

// Tạo nhóm + loại tài liệu + nhãn đã được Giám đốc duyệt qua API; trả về mã loại dùng được để tạo hồ sơ
export async function createUsableType(app, rule = {}) {
  const { cookie: cb } = await sessionWithRoles(app, [ROLE.RECORDS_OFFICER]);
  const { cookie: gd } = await directorSession(app);
  const group = 'G' + rand(6);
  const type = 'T' + rand(7);
  await request(app).post('/api/catalog/groups').set('Cookie', cb).send({ code: group, name: `Nhóm ${group}` }).expect(201);
  await request(app).post('/api/catalog/document-types').set('Cookie', cb).send({ code: type, name: `Loại ${type}`, groupCode: group }).expect(201);
  const p = await request(app).post('/api/labels/proposals').set('Cookie', cb).send({
    proposalType: 'CREATE', labelCode: 'L' + rand(6), groupCode: group, labelName: 'Nhãn test', legalBasis: 'Quy định nội bộ',
    retentionType: 'FIXED', retentionYears: 10, startTrigger: 'FISCAL_YEAR_END', containsPersonalData: false,
    documentTypeCodes: [type], proposalReason: 'Tạo nhãn phục vụ kiểm thử', ...rule,
  }).expect(201);
  await request(app).post(`/api/labels/proposals/${p.body.id}/submit`).set('Cookie', cb).expect(200);
  await request(app).post(`/api/labels/proposals/${p.body.id}/approve`).set('Cookie', gd).expect(200);
  return { type, group, labelCode: p.body.labelCode };
}
