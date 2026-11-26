import { z } from 'zod';

const labelCode = z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{1,20}$/, 'Mã nhãn: chữ in hoa, số hoặc "-", tối đa 20 ký tự (ví dụ KT-10N)');
const typeCode = z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{1,20}$/);

// Các trường luật lưu trữ của BM02 phần A, B, C; ràng buộc liên trường kiểm tra ở checkRules
const ruleFields = {
  labelName: z.string().trim().min(1).max(150),
  legalBasis: z.string().trim().min(1).max(1000),
  retentionType: z.enum(['FIXED', 'PERMANENT']),
  retentionYears: z.number().int().nullish(),
  startTrigger: z.enum(['ARCHIVED_DATE', 'FISCAL_YEAR_END', 'EVENT_END']).nullish(),
  eventName: z.string().trim().max(100).nullish(),
  warningDays: z.number().int().nullish(),
  containsPersonalData: z.boolean(),
  documentTypeCodes: z.array(typeCode).max(200).transform((a) => [...new Set(a)]),
  proposalReason: z.string().trim().min(10, 'Lý do đề xuất từ 10 đến 1.000 ký tự').max(1000),
};

// Tham số đường dẫn
export const codeParam = z.object({ code: labelCode });
export const idParam = z.object({ id: z.string().regex(/^\d{1,19}$/, 'Id không hợp lệ') });

// BM02 - Lập đề xuất: Tạo mới (có groupCode) / Sửa / Ngừng áp dụng (chỉ cần lý do, căn cứ)
export const createProposalSchema = z.discriminatedUnion('proposalType', [
  z.strictObject({ proposalType: z.literal('CREATE'), labelCode, groupCode: typeCode, ...ruleFields }),
  z.strictObject({ proposalType: z.literal('UPDATE'), labelCode, ...ruleFields }),
  z.strictObject({
    proposalType: z.literal('DEACTIVATE'), labelCode,
    legalBasis: ruleFields.legalBasis.optional(), proposalReason: ruleFields.proposalReason,
  }),
]);

// Sửa đề xuất đang Nháp / Bị từ chối: gửi trường nào sửa trường đó
export const updateProposalSchema = z.strictObject(Object.fromEntries(
  Object.entries(ruleFields).map(([k, v]) => [k, v.optional()]),
));

// Từ chối đề xuất: lý do 10–500 ký tự (5.4 chức năng 6)
export const rejectSchema = z.strictObject({
  comment: z.string().trim().min(10, 'Lý do từ chối từ 10 đến 500 ký tự').max(500),
});

// So sánh hai phiên bản của một nhãn
export const compareQuery = z.object({
  from: z.coerce.number().int().min(1),
  to: z.coerce.number().int().min(1),
});

// Lọc danh sách đề xuất
export const listProposalsQuery = z.object({
  status: z.enum(['DRAFT', 'PENDING', 'ACTIVE', 'RETIRED', 'REJECTED']).optional(),
});
