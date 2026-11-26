import { z } from 'zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Ngày dạng YYYY-MM-DD');

// BM13 - Kỳ thống kê cho chỉ tiêu gia hạn (mặc định từ đầu năm đến hôm nay)
export const summaryQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
}).refine((v) => !(v.from && v.to && v.from > v.to), { path: ['from'], message: '"Từ ngày" không được lớn hơn "đến ngày"' });
