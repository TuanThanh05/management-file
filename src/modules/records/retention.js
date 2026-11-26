// Cộng n năm vào ngày 'YYYY-MM-DD'; 29/02 sang năm không nhuận thì lấy 28/02 (5.1 chức năng 7)
export function addYears(dateStr, years) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const ty = y + years;
  const lastDay = new Date(Date.UTC(ty, m, 0)).getUTCDate();
  return `${ty}-${String(m).padStart(2, '0')}-${String(Math.min(d, lastDay)).padStart(2, '0')}`;
}

// Ngày kết thúc năm tài chính chứa ngày tài liệu; fiscalYearEnd dạng 'dd/mm'
export function fiscalYearEndFor(documentDate, fiscalYearEnd) {
  const [dd, mm] = fiscalYearEnd.split('/').map(Number);
  const y = Number(documentDate.slice(0, 4));
  const candidate = `${y}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  return documentDate <= candidate ? candidate : `${y + 1}${candidate.slice(4)}`;
}

// Tính mốc và ngày hết hạn theo nhãn: kind = DATE | PERMANENT | UNDETERMINED
export function computeExpiry(label, { archivedDate, documentDate, eventEndDate, fiscalYearEnd }) {
  if (!label) return { kind: 'UNDETERMINED', startDate: null, expiryDate: null };
  if (label.retentionType === 'PERMANENT') return { kind: 'PERMANENT', startDate: null, expiryDate: null };
  let startDate = null;
  if (label.startTrigger === 'ARCHIVED_DATE') startDate = archivedDate;
  else if (label.startTrigger === 'FISCAL_YEAR_END') startDate = fiscalYearEndFor(documentDate, fiscalYearEnd);
  else if (label.startTrigger === 'EVENT_END') startDate = eventEndDate ?? null;
  if (!startDate) return { kind: 'UNDETERMINED', startDate: null, expiryDate: null };
  return { kind: 'DATE', startDate, expiryDate: addYears(startDate, label.retentionYears) };
}

// Khoảng cách giữa hai ngày 'YYYY-MM-DD' theo năm, tháng, ngày (to ≥ from), dùng cho "thời gian gia hạn thêm" của BM03
export function diffYMD(from, to) {
  const [y1, m1, d1] = from.split('-').map(Number);
  const [y2, m2, d2] = to.split('-').map(Number);
  let years = y2 - y1;
  let months = m2 - m1;
  let days = d2 - d1;
  if (days < 0) { months -= 1; days += new Date(Date.UTC(y2, m2 - 1, 0)).getUTCDate(); }
  if (months < 0) { years -= 1; months += 12; }
  return { years, months, days };
}

// Số ngày từ a đến b (b − a), hai ngày dạng 'YYYY-MM-DD'
export function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}
