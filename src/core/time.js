const VN_OFFSET_MS = 7 * 60 * 60 * 1000;

// Ngày hôm nay theo lịch Việt Nam (UTC+7), dạng 'YYYY-MM-DD'
export function todayVN(now = new Date()) {
  return new Date(now.getTime() + VN_OFFSET_MS).toISOString().slice(0, 10);
}

// Năm hiện tại theo lịch Việt Nam
export function yearVN(now = new Date()) {
  return Number(todayVN(now).slice(0, 4));
}

// Giờ:phút hiện tại theo giờ Việt Nam, dạng 'HH:MM'
export function timeVN(now = new Date()) {
  return new Date(now.getTime() + VN_OFFSET_MS).toISOString().slice(11, 16);
}

// Đổi 'YYYY-MM-DD' sang 'dd/mm/yyyy' để hiển thị trong thông báo
export function formatDateVN(dateStr) {
  const [y, m, d] = dateStr.split('-');
  return `${d}/${m}/${y}`;
}

// Đổi thời điểm (Date / chuỗi ISO, UTC) sang 'dd/mm/yyyy HH:MM' giờ Việt Nam
export function formatDateTimeVN(value) {
  if (!value) return '';
  const iso = new Date(new Date(value).getTime() + VN_OFFSET_MS).toISOString();
  return `${formatDateVN(iso.slice(0, 10))} ${iso.slice(11, 16)}`;
}
