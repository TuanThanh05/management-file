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
  'Khong duoc sua ma nhom': 'Không được sửa mã nhóm hồ sơ',
  'Khong duoc sua ma nhan hoac nhom cua nhan': 'Không được sửa mã nhãn hoặc nhóm của nhãn',
  'Chuyen trang thai phien ban nhan khong hop le': 'Chuyển trạng thái phiên bản nhãn không hợp lệ',
  'Noi dung phien ban nhan da khoa': 'Nội dung phiên bản nhãn đã khóa (chỉ sửa được khi ở Nháp)',
  'Chi them loai tai lieu khi phien ban o Nhap': 'Chỉ thêm loại tài liệu khi phiên bản ở Nháp',
  'Loai tai lieu phai cung nhom voi nhan': 'Loại tài liệu phải cùng nhóm với nhãn',
  'Khong duoc xoa lich su ap dung nhan': 'Không được bỏ loại tài liệu khỏi phiên bản đã gửi duyệt',
  'Loai moi chua gan nhan; gan qua de xuat nhan': 'Loại mới chưa gắn nhãn; gắn nhãn qua đề xuất nhãn',
  'Khong duoc sua ma loai': 'Không được sửa mã loại tài liệu',
  'Loai da gan nhan khong duoc doi nhom': 'Loại tài liệu đã gắn nhãn không được đổi nhóm',
  'Chi gan loai vao phien ban nhan dang hieu luc co chua loai nay': 'Chỉ gắn loại tài liệu vào phiên bản nhãn đang hiệu lực có chứa loại này',
};

// Dịch thông báo trigger sang tiếng Việt có dấu
export function translateDbMessage(msg) {
  return DB_MESSAGES[msg] ?? msg;
}
