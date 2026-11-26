import bcrypt from 'bcrypt';
import { randomBytes } from 'node:crypto';

export const BCRYPT_COST = 12;
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 64;

// Băm mật khẩu bằng bcrypt cost 12
export function hashPassword(plain) {
  return bcrypt.hash(plain, BCRYPT_COST);
}

// So khớp mật khẩu với giá trị băm
export function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

// Băm giả dùng khi không có tài khoản, để thời gian phản hồi như nhau
let dummyHashPromise;
export function dummyVerify(plain) {
  dummyHashPromise ??= bcrypt.hash(randomBytes(16).toString('hex'), BCRYPT_COST);
  return dummyHashPromise.then((h) => bcrypt.compare(plain, h)).then(() => false);
}

// Sinh mật khẩu tạm ngẫu nhiên 24 ký tự (BM21: tối thiểu 16)
export function generateTempPassword() {
  return randomBytes(18).toString('base64url');
}

// Kiểm tra mật khẩu mới theo BM09; trả về danh sách lỗi { field, message }
export function checkNewPassword({ email, currentPassword, newPassword, confirmPassword }) {
  const errors = [];
  const len = [...newPassword].length;
  if (len < PASSWORD_MIN || len > PASSWORD_MAX) {
    errors.push({ field: 'newPassword', message: `Mật khẩu mới dài từ ${PASSWORD_MIN} đến ${PASSWORD_MAX} ký tự` });
  }
  if (newPassword === currentPassword) {
    errors.push({ field: 'newPassword', message: 'Mật khẩu mới phải khác mật khẩu hiện tại' });
  }
  const lower = newPassword.toLowerCase();
  const localPart = email.toLowerCase().split('@')[0];
  if (lower.includes(email.toLowerCase()) || (localPart.length >= 3 && lower.includes(localPart))) {
    errors.push({ field: 'newPassword', message: 'Mật khẩu mới không được chứa tên đăng nhập' });
  }
  if (newPassword !== confirmPassword) {
    errors.push({ field: 'confirmPassword', message: 'Xác nhận mật khẩu không trùng khớp' });
  }
  return errors;
}
