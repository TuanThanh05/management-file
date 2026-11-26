import { z } from 'zod';

const ROLE_CODES = ['EMPLOYEE', 'DEPARTMENT_HEAD', 'RECORDS_OFFICER', 'DIRECTOR', 'SYSTEM_ADMIN'];
const deptCode = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,10}$/, 'Mã phòng ban: chữ in hoa hoặc số, tối đa 10 ký tự');
const roleList = z.array(z.enum(ROLE_CODES)).min(1, 'Chọn ít nhất 1 vai trò').transform((a) => [...new Set(a)]);

// Tham số đường dẫn
export const codeParam = z.object({ code: deptCode });
export const idParam = z.object({ id: z.string().regex(/^\d{1,19}$/, 'Id không hợp lệ') });
export const keyParam = z.object({ key: z.string().regex(/^[A-Z_]{1,50}$/, 'Khóa tham số không hợp lệ') });

// BM20 - Thêm phòng ban
export const createDepartmentSchema = z.strictObject({
  code: deptCode,
  name: z.string().trim().min(1, 'Bắt buộc nhập tên phòng ban').max(150),
  parentCode: deptCode.nullish(),
});

// BM20 - Sửa phòng ban: chỉ tên và phòng ban cha
export const updateDepartmentSchema = z.strictObject({
  name: z.string().trim().min(1).max(150).optional(),
  parentCode: deptCode.nullable().optional(),
}).refine((v) => v.name !== undefined || v.parentCode !== undefined, 'Không có thông tin cần sửa');

// BM21 - Tạo tài khoản
export const createUserSchema = z.strictObject({
  email: z.string().trim().toLowerCase().pipe(z.email('Email không đúng định dạng').max(255)),
  fullName: z.string().trim().min(1, 'Bắt buộc nhập họ tên').max(100),
  departmentCode: deptCode,
  roles: roleList,
});

// BM21 - Sửa tài khoản: chỉ họ tên và phòng ban
export const updateUserSchema = z.strictObject({
  fullName: z.string().trim().min(1).max(100).optional(),
  departmentCode: deptCode.optional(),
}).refine((v) => v.fullName !== undefined || v.departmentCode !== undefined, 'Không có thông tin cần sửa');

// BM21 phần B - Danh sách vai trò mới
export const setRolesSchema = z.strictObject({ roles: roleList });

// Lọc danh sách tài khoản
export const listUsersQuery = z.object({
  q: z.string().trim().max(100).optional(),
  departmentCode: deptCode.optional(),
  status: z.enum(['ACTIVE', 'LOCKED']).optional(),
  role: z.enum(ROLE_CODES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

// BM22 - Giá trị tham số mới (kiểm tra theo kiểu ở service)
export const updateSettingSchema = z.strictObject({ value: z.union([z.string(), z.number()]).transform((v) => String(v).trim()) });
