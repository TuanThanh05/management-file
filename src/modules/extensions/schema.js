import { z } from 'zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Ngày dạng YYYY-MM-DD');

export const codeParam = z.object({ code: z.string().trim().toUpperCase().regex(/^GH-\d{4}-\d{4}$/, 'Mã đề xuất gia hạn không hợp lệ') });

// BM03 - Phiếu đề xuất gia hạn
export const createExtensionSchema = z.strictObject({
  recordCode: z.string().trim().toUpperCase().regex(/^HS-[A-Z0-9]{1,10}-\d{4}-\d{6}$/, 'Mã hồ sơ không hợp lệ'),
  newExpiryDate: isoDate,
  reason: z.string().trim().min(10, 'Lý do gia hạn từ 10 đến 500 ký tự').max(500),
});

// BM10 - Duyệt gia hạn: ý kiến tùy chọn
export const approveExtensionSchema = z.strictObject({ comment: z.string().trim().max(500).nullish() });

// BM10 - Từ chối gia hạn: lý do 10–500 ký tự
export const rejectExtensionSchema = z.strictObject({
  comment: z.string().trim().min(10, 'Lý do từ chối từ 10 đến 500 ký tự').max(500),
});

// Theo dõi đề xuất gia hạn (5.3 CN12): lọc trạng thái, phòng ban, khoảng ngày đề xuất
export const listExtensionsQuery = z.object({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional(),
  departmentCode: z.string().trim().toUpperCase().max(10).optional(),
  recordCode: z.string().trim().toUpperCase().max(30).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  page: z.coerce.number().int().min(1).default(1),
}).refine((v) => !(v.from && v.to && v.from > v.to), { path: ['from'], message: 'Ngày "từ" không được lớn hơn "đến"' });
