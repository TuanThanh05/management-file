import { z } from 'zod';

export const idParam = z.object({ id: z.string().regex(/^\d{1,19}$/, 'Id không hợp lệ') });

// Danh sách thông báo của tôi: lọc chưa đọc, 20 dòng mỗi trang
export const listQuery = z.object({
  unread: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  page: z.coerce.number().int().min(1).default(1),
});
