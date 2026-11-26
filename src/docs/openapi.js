import { z } from 'zod';
import { SUMMARIES, TAGS } from './summaries.js';

// Đổi schema zod sang JSON Schema (phía dữ liệu gửi lên); phần không biểu diễn được thì để tự do
function jsonSchema(schema) {
  try {
    const out = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
    delete out.$schema;
    return out;
  } catch {
    return {};
  }
}

// Gom metadata của các middleware trên một route: xác thực, quyền, schema, tải file
function collect(handlers) {
  const meta = { auth: false, permissions: [], schemas: {}, upload: null };
  for (const h of handlers) {
    if (h.auth) meta.auth = true;
    if (h.permissions) meta.permissions.push(h.permissions.join(' hoặc '));
    if (h.schemas) for (const [k, v] of Object.entries(h.schemas)) if (v) meta.schemas[k] = v;
    if (h.upload) meta.upload = h.upload;
  }
  return meta;
}

// Mô tả một thao tác OpenAPI từ metadata
function operation(method, fullPath, tag, meta) {
  const key = `${method.toUpperCase()} ${fullPath}`;
  const op = { tags: [TAGS[tag] ?? tag], summary: SUMMARIES[key] ?? key, operationId: key.replace(/[^A-Za-z0-9]+/g, '_') };
  const notes = [];
  if (meta.permissions.length) notes.push(`Quyền: ${meta.permissions.join(', ')}`);
  if (notes.length) op.description = notes.join('\n\n');
  if (!meta.auth) op.security = [];
  const params = [];
  for (const [where, schema] of [['path', meta.schemas.params], ['query', meta.schemas.query]]) {
    const js = schema ? jsonSchema(schema) : null;
    for (const [name, prop] of Object.entries(js?.properties ?? {})) {
      params.push({ name, in: where, required: where === 'path' || (js.required ?? []).includes(name), schema: prop });
    }
  }
  for (const m of fullPath.matchAll(/\{(\w+)\}/g)) {
    if (!params.some((p) => p.in === 'path' && p.name === m[1])) params.push({ name: m[1], in: 'path', required: true, schema: { type: 'string' } });
  }
  if (params.length) op.parameters = params;
  if (meta.upload) {
    const body = meta.schemas.body ? jsonSchema(meta.schemas.body) : { type: 'object', properties: {} };
    body.properties = { ...(body.properties ?? {}), [meta.upload.field]: { type: 'string', format: 'binary' } };
    if (!meta.upload.optional) body.required = [...(body.required ?? []), meta.upload.field];
    op.requestBody = { required: true, content: { 'multipart/form-data': { schema: body } } };
  } else if (meta.schemas.body) {
    op.requestBody = { required: true, content: { 'application/json': { schema: jsonSchema(meta.schemas.body) } } };
  }
  op.responses = {
    200: { description: 'Thành công' },
    ...(method === 'post' && { 201: { description: 'Đã tạo (với API tạo mới)' } }),
    401: { description: 'Chưa đăng nhập hoặc phiên hết hạn' },
    403: { description: 'Không có quyền' },
    404: { description: 'Không tìm thấy (hoặc ngoài phạm vi được xem)' },
    409: { description: 'Xung đột trạng thái / vi phạm quy tắc nghiệp vụ' },
    422: { description: 'Dữ liệu không hợp lệ', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
  };
  return op;
}

// Sinh tài liệu OpenAPI 3 bằng cách duyệt các route đã đăng ký trong app Express
export function buildOpenApi(app) {
  const paths = {};
  for (const layer of app.router.stack) {
    const router = layer.handle?.stack ? layer.handle : null;
    if (!router || typeof layer.rawPath !== 'string') continue;
    const prefix = layer.rawPath;
    const tag = prefix.replace('/api/', '');
    const routerLevel = router.stack.filter((l) => !l.route).map((l) => l.handle);
    for (const l of router.stack.filter((x) => x.route)) {
      const fullPath = (prefix + (l.route.path === '/' ? '' : l.route.path)).replace(/:(\w+)/g, '{$1}');
      const meta = collect([...routerLevel, ...l.route.stack.map((s) => s.handle)]);
      for (const method of Object.keys(l.route.methods)) {
        paths[fullPath] = { ...(paths[fullPath] ?? {}), [method]: operation(method, fullPath, tag, meta) };
      }
    }
  }
  paths['/api/health'] = { get: { tags: ['Hệ thống'], summary: 'Kiểm tra sống (không cần đăng nhập)', security: [], responses: { 200: { description: 'Thành công' } } } };
  return {
    openapi: '3.1.0',
    info: {
      title: 'API Hệ thống quản lý lưu trữ và hủy dữ liệu',
      version: '1.0.0',
      description: 'Xác thực bằng cookie phiên `rr_session` (httpOnly) cấp khi gọi POST /api/auth/login. '
        + 'Gọi từ frontend cần `credentials: "include"`. Ngày dạng YYYY-MM-DD theo lịch Việt Nam; thời điểm dạng ISO 8601 (UTC). '
        + 'Lỗi trả về dạng { error: { code, message, details, requestId } }.',
    },
    servers: [{ url: '/' }],
    components: {
      securitySchemes: { session: { type: 'apiKey', in: 'cookie', name: 'rr_session' } },
      schemas: {
        Error: {
          type: 'object',
          properties: { error: { type: 'object', properties: {
            code: { type: 'string' }, message: { type: 'string' }, requestId: { type: 'string' },
            details: { type: 'array', items: { type: 'object', properties: { field: { type: 'string' }, message: { type: 'string' } } } },
          } } },
        },
      },
    },
    security: [{ session: [] }],
    paths,
  };
}
