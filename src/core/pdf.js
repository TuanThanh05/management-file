import { createRequire } from 'node:module';
import path from 'node:path';
import pdfmake from 'pdfmake';

const require = createRequire(import.meta.url);
const Roboto = require('pdfmake/fonts/Roboto.js');
const FONT_DIR = path.dirname(Roboto.Roboto.normal);

// Phông Roboto (đủ dấu tiếng Việt); chặn tải URL ngoài, chỉ cho đọc file phông
pdfmake.addFonts(Roboto);
pdfmake.setUrlAccessPolicy(() => false);
pdfmake.setLocalAccessPolicy((p) => path.resolve(p).startsWith(FONT_DIR));

// Dựng PDF từ định nghĩa pdfmake, trả về Buffer
export async function renderPdf(docDefinition) {
  return pdfmake.createPdf({ defaultStyle: { font: 'Roboto', fontSize: 10 }, ...docDefinition }).getBuffer();
}
