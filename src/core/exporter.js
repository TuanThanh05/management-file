import ExcelJS from 'exceljs';
import { renderPdf } from './pdf.js';
import { formatDateTimeVN } from './time.js';

export const EXPORT_MIME = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
};

// Xuất bảng ra XLSX: phần thông tin (meta) ở đầu, sau đó tiêu đề cột và dữ liệu
async function toXlsx({ title, meta = [], columns, rows }) {
  const wb = new ExcelJS.Workbook();
  wb.created = new Date();
  const ws = wb.addWorksheet(title.slice(0, 31).replace(/[\\/?*[\]:]/g, ' '));
  ws.addRow([title]).font = { bold: true, size: 14 };
  for (const [k, v] of meta) ws.addRow([k, v ?? '']);
  ws.addRow([]);
  const head = ws.addRow(columns.map((c) => c.header));
  head.font = { bold: true };
  head.eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEEEEE' } }; });
  for (const r of rows) ws.addRow(columns.map((c) => r[c.key] ?? ''));
  columns.forEach((c, i) => { ws.getColumn(i + 1).width = c.width ?? 18; });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// Xuất bảng ra PDF A4 ngang bằng pdfmake (tiếng Việt)
function toPdf({ title, meta = [], columns, rows }) {
  return renderPdf({
    pageSize: 'A4', pageOrientation: 'landscape', pageMargins: [30, 40, 30, 40],
    footer: (page, pages) => ({ text: `Xuất lúc ${formatDateTimeVN(new Date())} – Trang ${page}/${pages}`, fontSize: 7, alignment: 'right', margin: [30, 10] }),
    content: [
      { text: title, fontSize: 14, bold: true, margin: [0, 0, 0, 8] },
      ...(meta.length ? [{ table: { widths: [140, '*'], body: meta.map(([k, v]) => [k, String(v ?? '')]) }, layout: 'noBorders', margin: [0, 0, 0, 8] }] : []),
      {
        fontSize: 8,
        table: {
          headerRows: 1, widths: columns.map((c) => c.pdfWidth ?? '*'),
          body: [columns.map((c) => ({ text: c.header, bold: true, fillColor: '#eeeeee' })), ...rows.map((r) => columns.map((c) => String(r[c.key] ?? '')))],
        },
      },
    ],
  });
}

// Xuất theo định dạng yêu cầu: trả về { buffer, mime, ext }
export async function exportTable(format, spec) {
  const buffer = format === 'pdf' ? await toPdf(spec) : await toXlsx(spec);
  return { buffer, mime: EXPORT_MIME[format], ext: format };
}

// Gửi file xuất về trình duyệt dạng tải về
export function sendExport(res, { buffer, mime, ext }, baseName) {
  res.set({
    'Content-Type': mime,
    'Content-Length': buffer.length,
    'Content-Disposition': `attachment; filename="${baseName}.${ext}"`,
    'Cache-Control': 'no-store',
  });
  res.end(buffer);
}
