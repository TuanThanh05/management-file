import { createHash } from 'node:crypto';
import { formatDateVN, formatDateTimeVN } from '../../core/time.js';

export const DISPOSAL_METHOD = 'Xóa bằng mật mã (hủy khóa giải mã) theo NIST SP 800-88 Rev.2';
export const FINAL_CHECK_PREFIX = 'Không đạt kiểm tra lần cuối';

// Mã băm SHA-256 của nội dung biên bản (bản chụp JSON), in ở chân trang
export function snapshotHash(snapshot) {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

// Gom dữ liệu BM16 của đợt tại thời điểm lập: đợt, người duyệt, danh mục đã hủy, hồ sơ bị rút khi kiểm tra lần cuối
export async function buildSnapshot(conn, batchId, { certificateNo, companyName }) {
  const [[b]] = await conn.query(
    `SELECT b.*, d.code AS department_code, d.name AS department_name, c.full_name AS created_by_name, c.email AS created_by_email,
            a1.full_name AS l1_name, a1.email AS l1_email, a2.full_name AS l2_name, a2.email AS l2_email
     FROM disposal_batches b JOIN departments d ON d.id = b.department_id JOIN users c ON c.id = b.created_by
     LEFT JOIN users a1 ON a1.id = b.level1_approver_id LEFT JOIN users a2 ON a2.id = b.level2_approver_id WHERE b.id = ?`, [batchId]);
  const [items] = await conn.query(
    `SELECT x.item_status, x.exclusion_reason, x.disposed_at, r.id AS record_id, r.code, r.title, r.document_date, r.expiry_date,
            t.name AS type_name
     FROM disposal_batch_records x JOIN records r ON r.id = x.record_id JOIN document_types t ON t.id = r.document_type_id
     WHERE x.batch_id = ? AND (x.item_status = 'DISPOSED' OR (x.item_status = 'WITHDRAWN' AND x.exclusion_reason LIKE ?))
     ORDER BY r.code`, [batchId, `${FINAL_CHECK_PREFIX}%`]);
  const disposed = items.filter((x) => x.item_status === 'DISPOSED');
  const [files] = disposed.length ? await conn.query(
    `SELECT f.record_id, v.version_no, v.sha256, v.size_bytes FROM file_versions v JOIN files f ON f.id = v.file_id
     WHERE f.record_id IN (?) ORDER BY f.id, v.version_no`, [disposed.map((x) => x.record_id)]) : [[]];
  return {
    certificateNo, companyName, issuedAt: new Date().toISOString(), method: DISPOSAL_METHOD,
    batch: {
      code: b.code, department: { code: b.department_code, name: b.department_name }, reason: b.reason,
      createdBy: { name: b.created_by_name, email: b.created_by_email }, submittedAt: b.submitted_at,
      level1: { name: b.l1_name, email: b.l1_email, approvedAt: b.level1_approved_at, comment: b.level1_comment },
      level2: { name: b.l2_name, email: b.l2_email, approvedAt: b.level2_approved_at, comment: b.level2_comment },
      startedAt: b.started_at, completedAt: new Date().toISOString(),
    },
    records: disposed.map((x) => {
      const fv = files.filter((f) => String(f.record_id) === String(x.record_id));
      return {
        code: x.code, title: x.title, documentType: x.type_name, documentDate: x.document_date, expiryDate: x.expiry_date,
        fileCount: fv.length, files: fv.map((f) => ({ versionNo: f.version_no, sha256: f.sha256, sizeBytes: Number(f.size_bytes) })),
        result: 'Đã hủy', disposedAt: x.disposed_at,
      };
    }),
    withdrawn: items.filter((x) => x.item_status === 'WITHDRAWN').map((x) => ({ code: x.code, reason: x.exclusion_reason })),
  };
}

// Định nghĩa pdfmake của biên bản BM16 từ bản chụp
export function certificateDocument(s) {
  const hash = snapshotHash(s);
  const b = s.batch;
  const person = (p, at, comment) => [p?.name ? `${p.name} (${p.email})` : '', at ? formatDateTimeVN(at) : '', comment || ''];
  const head = (cols) => cols.map((t) => ({ text: t, bold: true, fillColor: '#eeeeee' }));
  return {
    pageSize: 'A4',
    pageMargins: [40, 50, 40, 60],
    footer: (page, pages) => ({
      margin: [40, 10, 40, 0], fontSize: 7, color: '#555555',
      columns: [{ text: `${s.certificateNo} – SHA-256 nội dung: ${hash}` }, { text: `Trang ${page}/${pages}`, alignment: 'right', width: 60 }],
    }),
    content: [
      { text: s.companyName.toUpperCase(), bold: true },
      { text: 'BIÊN BẢN HỦY HỒ SƠ', fontSize: 16, bold: true, alignment: 'center', margin: [0, 16, 0, 4] },
      { text: `Số: ${s.certificateNo} – Ngày lập: ${formatDateVN(new Date(Date.parse(s.issuedAt) + 7 * 3600_000).toISOString().slice(0, 10))}`, alignment: 'center', margin: [0, 0, 0, 16] },
      { text: 'I. Thông tin đợt hủy', bold: true, margin: [0, 0, 0, 6] },
      {
        table: { widths: [150, '*'], body: [
          ['Mã đợt hủy', b.code],
          ['Phòng ban', `${b.department.name} (${b.department.code})`],
          ['Lý do đề xuất hủy', b.reason],
          ['Người lập đợt, thời điểm gửi', `${b.createdBy.name} (${b.createdBy.email}) – ${formatDateTimeVN(b.submittedAt)}`],
          ['Bắt đầu – hoàn tất hủy', `${formatDateTimeVN(b.startedAt)} – ${formatDateTimeVN(b.completedAt)}`],
          ['Phương pháp hủy', s.method],
        ] },
        layout: 'lightHorizontalLines',
      },
      { text: 'II. Xét duyệt', bold: true, margin: [0, 14, 0, 6] },
      {
        table: { widths: [70, '*', 90, '*'], body: [
          head(['Cấp', 'Người duyệt', 'Thời điểm', 'Ý kiến']),
          ['Cấp 1', ...person(b.level1, b.level1.approvedAt, b.level1.comment)],
          ['Cấp 2', ...person(b.level2, b.level2.approvedAt, b.level2.comment)],
        ] },
      },
      { text: `III. Danh mục hồ sơ đã hủy (${s.records.length} hồ sơ)`, bold: true, margin: [0, 14, 0, 6] },
      {
        fontSize: 8,
        table: { headerRows: 1, widths: [18, 100, '*', 52, 52, 58, 26, 40], body: [
          head(['STT', 'Mã hồ sơ', 'Tiêu đề / Loại tài liệu', 'Ngày tài liệu', 'Ngày hết hạn', 'Thời điểm hủy', 'Số file', 'Kết quả']),
          ...s.records.map((r, i) => [String(i + 1), r.code, `${r.title}\n${r.documentType}`, formatDateVN(r.documentDate), formatDateVN(r.expiryDate),
            formatDateTimeVN(r.disposedAt), String(r.fileCount), r.result]),
        ] },
      },
      { text: 'Mã băm SHA-256 các phiên bản file đã hủy', bold: true, margin: [0, 14, 0, 6] },
      {
        fontSize: 7,
        table: { headerRows: 1, widths: [100, 40, '*'], body: [
          head(['Mã hồ sơ', 'Phiên bản', 'SHA-256']),
          ...s.records.flatMap((r) => (r.files.length ? r.files : [{ versionNo: '', sha256: '(không có file)' }]).map((f) => [r.code, String(f.versionNo), f.sha256])),
        ] },
      },
      { text: 'IV. Hồ sơ bị rút khỏi đợt khi kiểm tra lần cuối', bold: true, margin: [0, 14, 0, 6] },
      s.withdrawn.length
        ? { table: { widths: [100, '*'], body: [head(['Mã hồ sơ', 'Lý do']), ...s.withdrawn.map((w) => [w.code, w.reason])] } }
        : { text: 'Không có.', italics: true },
      { text: 'V. Ký xác nhận', bold: true, margin: [0, 20, 0, 6] },
      {
        columns: ['Người lập đợt', 'Người duyệt cấp 1', 'Người duyệt cấp 2'].map((t, i) => ({
          stack: [{ text: t, bold: true }, { text: '(Ký, ghi rõ họ tên)', italics: true, fontSize: 8 }, { text: '\n\n\n\n' },
            { text: [b.createdBy, b.level1, b.level2][i]?.name ?? '' }],
          alignment: 'center',
        })),
      },
    ],
  };
}
