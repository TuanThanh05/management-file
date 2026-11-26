import { writeFile } from 'node:fs/promises';
import { createApp } from '../src/app.js';
import { buildOpenApi } from '../src/docs/openapi.js';
import { closeDb } from '../src/config/database.js';

// Ghi tài liệu OpenAPI ra docs/openapi.json để gửi cho frontend (mở bằng editor.swagger.io hoặc Postman)
async function main() {
  const spec = buildOpenApi(createApp());
  await writeFile('docs/openapi.json', `${JSON.stringify(spec, null, 2)}\n`);
  console.log(`Đã ghi docs/openapi.json (${Object.keys(spec.paths).length} đường dẫn)`);
  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
