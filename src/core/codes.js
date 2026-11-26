import { yearVN } from './time.js';

// Sinh mã nghiệp vụ qua thủ tục sp_next_code_number.
// PHẢI gọi bằng kết nối đang trong transaction tạo đối tượng: rollback thì số thứ tự không bị tiêu.
//
//   Hồ sơ        HS-<PB>-<Năm>-<6 số>   ví dụ HS-KT-2026-000001
//   Đợt hủy      DH-<PB>-<Năm>-<3 số>   ví dụ DH-KT-2026-001
//   Gia hạn      GH-<Năm>-<4 số>        ví dụ GH-2026-0001
//   Phong tỏa    PT-<Năm>-<4 số>
//   Biên bản     BB-<Năm>-<4 số>
const FORMATS = {
  RECORD: { head: (d) => `HS-${d}`, digits: 6, needsDept: true },
  DISPOSAL_BATCH: { head: (d) => `DH-${d}`, digits: 3, needsDept: true },
  EXTENSION: { head: () => 'GH', digits: 4 },
  LEGAL_HOLD: { head: () => 'PT', digits: 4 },
  CERTIFICATE: { head: () => 'BB', digits: 4 },
};

export async function nextCode(conn, type, { departmentCode, now } = {}) {
  const fmt = FORMATS[type];
  if (!fmt) throw new Error(`Loại mã không hợp lệ: ${type}`);
  if (fmt.needsDept && !departmentCode) throw new Error(`Mã ${type} cần mã phòng ban`);

  const prefix = `${fmt.head(departmentCode)}-${yearVN(now)}`; // khóa bộ đếm, ví dụ HS-KT-2026
  await conn.query('CALL sp_next_code_number(?, @code_no)', [prefix]);
  const [[{ n }]] = await conn.query('SELECT @code_no AS n');
  const num = Number(n);
  if (num >= 10 ** fmt.digits) throw new Error(`Bộ đếm ${prefix} đã vượt ${fmt.digits} chữ số`);
  return `${prefix}-${String(num).padStart(fmt.digits, '0')}`;
}
