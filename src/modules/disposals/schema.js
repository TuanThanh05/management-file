import { z } from 'zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Ngày dạng YYYY-MM-DD');
const recordCode = z.string().trim().toUpperCase().regex(/^HS-[A-Z0-9]{1,10}-\d{4}-\d{6}$/, 'Mã hồ sơ không hợp lệ');
const codes = z.array(recordCode).max(500).transform((a) => [...new Set(a)]);
const reason = (min, max, label) => z.string().trim().min(min, `${label} từ ${min} đến ${max} ký tự`).max(max);
const comment = z.strictObject({ comment: z.string().trim().max(500).nullish() });

export const codeParam = z.object({ code: z.string().trim().toUpperCase().regex(/^DH-[A-Z0-9]{1,10}-\d{4}-\d{3}$/, 'Mã đợt hủy không hợp lệ') });

// BM05 - Lập đợt hủy: một phòng ban, lý do, ít nhất 1 hồ sơ
export const createBatchSchema = z.strictObject({
  departmentCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,10}$/, 'Mã phòng ban không hợp lệ'),
  reason: reason(10, 1000, 'Lý do đề xuất hủy'),
  recordCodes: codes.refine((a) => a.length > 0, 'Chọn ít nhất 1 hồ sơ'),
});

// Sửa đợt Nháp: sửa lý do, thêm / bớt hồ sơ (bớt kèm lý do, mặc định "Bỏ khỏi đợt khi lập nháp")
export const updateBatchSchema = z.strictObject({
  reason: reason(10, 1000, 'Lý do đề xuất hủy').optional(),
  addRecordCodes: codes.optional(),
  removeRecordCodes: codes.optional(),
  removeReason: reason(10, 500, 'Lý do bỏ hồ sơ').optional(),
}).refine((v) => v.reason || v.addRecordCodes?.length || v.removeRecordCodes?.length, { message: 'Không có gì để sửa' });

// Lý do bắt buộc: hủy bỏ đợt, trả lại cấp 1 / cấp 2
export const reasonSchema = z.strictObject({ reason: reason(10, 500, 'Lý do') });

// BM17 - Thu hồi quyết định hủy: lý do và xác nhận
export const revokeSchema = z.strictObject({
  reason: reason(10, 500, 'Lý do thu hồi'),
  confirm: z.literal(true, { message: 'Phải xác nhận thu hồi quyết định hủy' }),
});

// BM12 phần B - Đề nghị loại / bỏ đề nghị loại một hồ sơ
export const exclusionSchema = z.strictObject({ recordCode, reason: reason(10, 500, 'Lý do loại') });
export const removeExclusionSchema = z.strictObject({ recordCode });

// BM12 phần A - Ý kiến khi đồng ý (tùy chọn)
export const approveSchema = comment;

// Theo dõi đợt hủy (5.3 CN16): lọc trạng thái, phòng ban, khoảng ngày lập
export const listBatchesQuery = z.object({
  status: z.enum(['DRAFT', 'PENDING_LEVEL_1', 'PENDING_LEVEL_2', 'APPROVED', 'COMPLETED', 'CANCELLED']).optional(),
  departmentCode: z.string().trim().toUpperCase().max(10).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  page: z.coerce.number().int().min(1).default(1),
}).refine((v) => !(v.from && v.to && v.from > v.to), { path: ['from'], message: 'Ngày "từ" không được lớn hơn "đến"' });
