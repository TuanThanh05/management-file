// Thông báo tiếng Việt có dấu cho lỗi SIGNAL 45000 của trigger (trigger ghi không dấu); thiếu thì giữ nguyên
export const DB_MESSAGES = {
  'Khong duoc sua ma phong ban': 'Không được sửa mã phòng ban',
  'Cay phong ban bi vong lap': 'Không được tạo vòng lặp trong cây phòng ban',
  'Tai khoan phai do Quan tri vien tao': 'Tài khoản phải do Quản trị viên tạo',
  'Khong duoc sua email hoac nguoi tao': 'Không được sửa email hoặc người tạo',
  'Chi Quan tri vien duoc khoa tai khoan nguoi khac': 'Chỉ Quản trị viên được khóa tài khoản người khác',
  'Quan tri khong duoc kiem TP, CBLT hoac GD': 'Quản trị hệ thống không được kiêm Trưởng phòng, Cán bộ lưu trữ hoặc Giám đốc',
  'Phong ban da co Truong phong': 'Phòng ban đã có Trưởng phòng đang hoạt động',
  'Doanh nghiep da co Giam doc': 'Doanh nghiệp đã có Giám đốc đang hoạt động',
  'Vai tro phai do Quan tri vien gan': 'Vai trò phải do Quản trị viên gán',
  'Chi Quan tri vien duoc thu hoi vai tro': 'Chỉ Quản trị viên được thu hồi vai trò',
  'Gan vai tro chi duoc thu hoi mot lan': 'Vai trò chỉ được thu hồi một lần',
  'Gia tri tham so ngoai khoang cho phep': 'Giá trị tham số ngoài khoảng cho phép',
  'Chi Quan tri vien duoc sua tham so': 'Chỉ Quản trị viên được sửa tham số',
};

// Dịch thông báo trigger sang tiếng Việt có dấu
export function translateDbMessage(msg) {
  return DB_MESSAGES[msg] ?? msg;
}
