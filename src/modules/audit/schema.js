import { z } from 'zod';

const dateTime = z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'Thời điểm dạng ISO 8601, ví dụ 2026-11-26T08:00:00+07:00');
const list = (v) => (v === undefined ? undefined : (Array.isArray(v) ? v : String(v).split(',')).map((x) => x.trim()).filter(Boolean));

// BM18 - Phiếu tra cứu nhật ký; mặc định 7 ngày gần nhất, 50 dòng mỗi trang
export const logsQuery = z.object({
  from: dateTime.optional(),
  to: dateTime.optional(),
  userEmail: z.string().trim().toLowerCase().max(255).optional(),
  actions: z.preprocess(list, z.array(z.string().regex(/^[A-Z0-9_]{1,50}$/, 'Mã thao tác không hợp lệ')).max(50).optional()),
  objectCode: z.string().trim().max(50).optional(),
  result: z.enum(['SUCCESS', 'FAILURE']).optional(),
  ip: z.string().trim().max(45).optional(),
  page: z.coerce.number().int().min(1).default(1),
}).refine((v) => !(v.from && v.to && Date.parse(v.from) > Date.parse(v.to)), { path: ['from'], message: '"Từ" không được lớn hơn "đến"' });

// BM19 - Phạm vi kiểm tra toàn vẹn: bỏ trống là toàn bộ; a ≤ b
export const verifySchema = z.strictObject({
  fromSeq: z.number().int().min(1).optional(),
  toSeq: z.number().int().min(1).optional(),
}).refine((v) => !(v.fromSeq && v.toSeq && v.fromSeq > v.toSeq), { path: ['fromSeq'], message: 'Bản ghi "từ" không được lớn hơn "đến"' });

export const checksQuery = z.object({ page: z.coerce.number().int().min(1).default(1) });
