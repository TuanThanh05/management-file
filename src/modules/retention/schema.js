import { z } from 'zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Ngày dạng YYYY-MM-DD');
const code = z.string().trim().toUpperCase().max(20);
const recordCode = z.string().trim().toUpperCase().regex(/^HS-[A-Z0-9]{1,10}-\d{4}-\d{6}$/, 'Mã hồ sơ không hợp lệ');

// Lọc danh sách rà soát hồ sơ hết hạn (5.3 CN10)
export const expiredQuery = z.object({
  departmentCode: code.optional(),
  groupCode: code.optional(),
  documentTypeCode: code.optional(),
  labelCode: code.optional(),
  expiryDateFrom: isoDate.optional(),
  expiryDateTo: isoDate.optional(),
  eligibleOnly: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  page: z.coerce.number().int().min(1).default(1),
}).refine((v) => !(v.expiryDateFrom && v.expiryDateTo && v.expiryDateFrom > v.expiryDateTo),
  { path: ['expiryDateFrom'], message: 'Ngày hết hạn "từ" không được lớn hơn "đến"' });

// Đánh / bỏ dấu đủ điều kiện hủy cho nhiều hồ sơ (5.3 CN11)
export const eligibleSchema = z.strictObject({
  recordCodes: z.array(recordCode).min(1, 'Chọn ít nhất 1 hồ sơ').max(100).transform((a) => [...new Set(a)]),
  eligible: z.boolean(),
});
