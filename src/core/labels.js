// Tên tiếng Việt của các mã trạng thái, dùng khi xuất file và biên bản
export const RECORD_STATUS_VN = {
  IN_USE: 'Đang sử dụng', PENDING_ARCHIVE: 'Chờ duyệt lưu trữ', ARCHIVED: 'Lưu trữ', EXPIRED: 'Hết hạn',
  PENDING_DISPOSAL: 'Chờ duyệt hủy', DISPOSED: 'Đã hủy', CANCELLED: 'Đã hủy bỏ',
};
export const VALIDITY_VN = { VALID: 'Còn hiệu lực', ENDED: 'Hết hiệu lực' };
export const BATCH_STATUS_VN = {
  DRAFT: 'Nháp', PENDING_LEVEL_1: 'Chờ duyệt cấp 1', PENDING_LEVEL_2: 'Chờ duyệt cấp 2', APPROVED: 'Đã phê duyệt',
  COMPLETED: 'Hoàn tất', CANCELLED: 'Đã hủy bỏ',
};
