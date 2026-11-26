import { z } from 'zod';

// BM08 - Đăng nhập
export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email('Tên đăng nhập phải là email').max(255)),
  password: z.string().min(1, 'Bắt buộc nhập mật khẩu').max(128),
});

// BM09 - Đổi mật khẩu (quy tắc độ dài, trùng lặp kiểm tra ở checkNewPassword)
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Bắt buộc nhập mật khẩu hiện tại').max(128),
  newPassword: z.string().min(1, 'Bắt buộc nhập mật khẩu mới').max(256),
  confirmPassword: z.string().min(1, 'Bắt buộc nhập xác nhận mật khẩu').max(256),
});
