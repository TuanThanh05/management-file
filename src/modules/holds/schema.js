import { z } from 'zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Ngày dạng YYYY-MM-DD');
const recordCode = z.string().trim().toUpperCase().regex(/^HS-[A-Z0-9]{1,10}-\d{4}-\d{6}$/, 'Mã hồ sơ không hợp lệ');
// Danh sách mã hồ sơ nhận được cả mảng JSON lẫn chuỗi cách nhau dấu phẩy (form multipart)
const codeList = z.preprocess(
  (v) => (typeof v === 'string' ? v.split(',').map((x) => x.trim()).filter(Boolean) : v),
  z.array(recordCode).min(1, 'Chọn ít nhất 1 hồ sơ').max(200).transform((a) => [...new Set(a)]),
);
const emptyToUndef = (v) => (v === '' ? undefined : v);

export const codeParam = z.object({ code: z.string().trim().toUpperCase().regex(/^PT-\d{4}-\d{4}$/, 'Mã lệnh phong tỏa không hợp lệ') });

// BM04 - Đặt phong tỏa (JSON hoặc multipart kèm tệp căn cứ "evidence")
export const placeHoldSchema = z.strictObject({
  recordCodes: codeList,
  reason: z.string().trim().min(10, 'Lý do từ 10 đến 1.000 ký tự').max(1000),
  legalBasis: z.string().trim().min(1, 'Bắt buộc nhập căn cứ').max(255),
  expectedReleaseDate: z.preprocess(emptyToUndef, isoDate.nullish()),
});

// BM04 - Gỡ phong tỏa: cả lệnh (bỏ trống recordCodes) hoặc từng hồ sơ
export const releaseHoldSchema = z.strictObject({
  recordCodes: codeList.optional(),
  reason: z.string().trim().min(10, 'Lý do gỡ từ 10 đến 500 ký tự').max(500),
});

// Tra cứu lệnh phong tỏa (5.4 CN13)
export const listHoldsQuery = z.object({
  status: z.enum(['ACTIVE', 'RELEASED']).optional(),
  overdue: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  page: z.coerce.number().int().min(1).default(1),
});
