// Ngày theo lịch Việt Nam (UTC+7). Cột DATE trong CSDL (document_date, expiry_date...) là ngày VN,
// còn DATETIME lưu UTC. Dùng hàm này thay cho new Date().toISOString().slice(0,10) (sẽ sai trước 7h sáng).
const VN_OFFSET_MS = 7 * 60 * 60 * 1000;

export function todayVN(now = new Date()) {
  return new Date(now.getTime() + VN_OFFSET_MS).toISOString().slice(0, 10);
}

export function yearVN(now = new Date()) {
  return Number(todayVN(now).slice(0, 4));
}
