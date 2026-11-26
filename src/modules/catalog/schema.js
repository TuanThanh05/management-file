import { z } from 'zod';

const code = z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{1,20}$/, 'Mã: chữ in hoa, số, "-" hoặc "_", tối đa 20 ký tự');
const description = z.string().trim().max(500).nullish();

// Tham số đường dẫn
export const codeParam = z.object({ code });

// BM14 - Thêm nhóm hồ sơ
export const createGroupSchema = z.strictObject({
  code,
  name: z.string().trim().min(1, 'Bắt buộc nhập tên nhóm').max(150),
  description,
});

// BM14 - Sửa nhóm: chỉ tên và mô tả
export const updateGroupSchema = z.strictObject({
  name: z.string().trim().min(1).max(150).optional(),
  description,
}).refine((v) => v.name !== undefined || v.description !== undefined, 'Không có thông tin cần sửa');

// BM15 - Thêm loại tài liệu
export const createTypeSchema = z.strictObject({
  code,
  name: z.string().trim().min(1, 'Bắt buộc nhập tên loại tài liệu').max(150),
  groupCode: code,
  description,
});

// BM15 - Sửa loại: chỉ tên và mô tả (không đổi nhóm, không đổi nhãn trực tiếp)
export const updateTypeSchema = updateGroupSchema;

// Lọc danh sách loại tài liệu
export const listTypesQuery = z.object({
  groupCode: code.optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  usable: z.enum(['true', 'false']).optional(),
});
