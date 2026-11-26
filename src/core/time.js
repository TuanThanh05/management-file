const VN_OFFSET_MS = 7 * 60 * 60 * 1000;

// Ngày hôm nay theo lịch Việt Nam (UTC+7), dạng 'YYYY-MM-DD'
export function todayVN(now = new Date()) {
  return new Date(now.getTime() + VN_OFFSET_MS).toISOString().slice(0, 10);
}

// Năm hiện tại theo lịch Việt Nam
export function yearVN(now = new Date()) {
  return Number(todayVN(now).slice(0, 4));
}
