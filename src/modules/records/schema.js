import { z } from 'zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Ngày dạng YYYY-MM-DD')
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s), 'Ngày không hợp lệ');
const title = z.string().max(255).refine((s) => s.trim().length > 0, 'Tiêu đề không được chỉ gồm khoảng trắng').transform((s) => s.trim());
const typeCode = z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{1,20}$/);

// Tham số đường dẫn
export const codeParam = z.object({ code: z.string().regex(/^HS-[A-Z0-9]{1,10}-\d{4}-\d{6}$/, 'Mã hồ sơ không hợp lệ') });
export const fileParam = codeParam.extend({ fileId: z.string().regex(/^\d{1,19}$/) });

// BM01 phần A - Tạo hồ sơ
export const createRecordSchema = z.strictObject({
  title,
  documentTypeCode: typeCode,
  documentDate: isoDate,
  eventEndDate: isoDate.nullish(),
  description: z.string().trim().max(2000).nullish(),
});

// BM01 - Cập nhật hồ sơ: tiêu đề, loại, ngày tài liệu, ngày kết thúc sự kiện, mô tả
export const updateRecordSchema = z.strictObject({
  title: title.optional(),
  documentTypeCode: typeCode.optional(),
  documentDate: isoDate.optional(),
  eventEndDate: isoDate.nullable().optional(),
  description: z.string().trim().max(2000).nullable().optional(),
}).refine((v) => Object.keys(v).length > 0, 'Không có thông tin cần sửa');

// BM06 - Hủy bỏ hồ sơ tạo nhầm
export const cancelRecordSchema = z.strictObject({
  reason: z.string().trim().min(10, 'Lý do hủy bỏ từ 10 đến 500 ký tự').max(500),
  confirm: z.literal(true, { error: 'Phải xác nhận "Tôi hiểu thao tác này không thể hoàn tác"' }),
});

// Xem / tải file: phiên bản (mặc định mới nhất), xem trực tiếp hay tải về
export const contentQuery = z.object({
  version: z.coerce.number().int().min(1).optional(),
  download: z.enum(['0', '1']).default('1'),
});

const STATUSES = ['IN_USE', 'PENDING_ARCHIVE', 'ARCHIVED', 'EXPIRED', 'PENDING_DISPOSAL', 'DISPOSED', 'CANCELLED'];
const list = (v) => (v === undefined ? undefined : (Array.isArray(v) ? v : String(v).split(',')).map((x) => x.trim()).filter(Boolean));

// Từ chối yêu cầu lưu trữ: lý do 10–500 ký tự (5.2 CN7)
export const rejectRecordSchema = z.strictObject({
  reason: z.string().trim().min(10, 'Lý do từ chối từ 10 đến 500 ký tự').max(500),
});

// BM11 - Đánh dấu hết hiệu lực
export const markEndedSchema = z.strictObject({
  eventEndDate: isoDate.nullish(),
  eventNote: z.string().trim().min(1).max(255).nullish(),
});

// BM07 - Phiếu tra cứu hồ sơ; khoảng ngày "từ" không lớn hơn "đến"
export const searchQuery = z.object({
  q: z.string().trim().max(100).optional(),
  groupCode: z.string().trim().toUpperCase().max(20).optional(),
  documentTypeCode: typeCode.optional(),
  status: z.preprocess(list, z.array(z.enum(STATUSES)).optional()),
  validity: z.enum(['VALID', 'ENDED']).optional(),
  onHold: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  documentDateFrom: isoDate.optional(),
  documentDateTo: isoDate.optional(),
  expiryDateFrom: isoDate.optional(),
  expiryDateTo: isoDate.optional(),
  mine: z.enum(['true', 'false']).transform((v) => v === 'true').default(false),
  sortBy: z.enum(['createdAt', 'expiryDate', 'code']).default('createdAt'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
}).superRefine((v, ctx) => {
  if (v.documentDateFrom && v.documentDateTo && v.documentDateFrom > v.documentDateTo) {
    ctx.addIssue({ code: 'custom', path: ['documentDateFrom'], message: 'Ngày tài liệu "từ" không được lớn hơn "đến"' });
  }
  if (v.expiryDateFrom && v.expiryDateTo && v.expiryDateFrom > v.expiryDateTo) {
    ctx.addIssue({ code: 'custom', path: ['expiryDateFrom'], message: 'Ngày hết hạn "từ" không được lớn hơn "đến"' });
  }
});
