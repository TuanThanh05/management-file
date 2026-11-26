import { ZodError } from 'zod';
import { logger } from './logger.js';

// Lỗi nghiệp vụ chủ động ném ra từ service. Luôn trả về dạng { error: { code, message, details } }.
export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
  static badRequest(msg, details) { return new AppError(400, 'BAD_REQUEST', msg, details); }
  static unauthorized(msg = 'Chưa đăng nhập hoặc phiên đã hết hạn') { return new AppError(401, 'UNAUTHORIZED', msg); }
  static forbidden(msg = 'Không có quyền thực hiện thao tác này') { return new AppError(403, 'FORBIDDEN', msg); }
  static notFound(msg = 'Không tìm thấy đối tượng') { return new AppError(404, 'NOT_FOUND', msg); }
  static conflict(msg, details) { return new AppError(409, 'CONFLICT', msg, details); }
  static unprocessable(msg, details) { return new AppError(422, 'VALIDATION_ERROR', msg, details); }
}

// Mã lỗi MySQL dùng để phân loại
const ER = {
  DUP_ENTRY: 1062,
  NO_REFERENCED_ROW: 1452,
  ROW_IS_REFERENCED: 1451,
  CHECK_VIOLATED: 3819,
  TABLE_ACCESS_DENIED: 1142,
  PROC_ACCESS_DENIED: 1370,
  LOCK_WAIT_TIMEOUT: 1205,
  DEADLOCK: 1213,
};

// Chuyển lỗi bất kỳ (zod, MySQL, AppError, lỗi lạ) về AppError.
// Đây là nơi duy nhất quyết định HTTP status cho lỗi CSDL.
export function toAppError(err) {
  if (err instanceof AppError) return err;

  if (err instanceof ZodError) {
    return AppError.unprocessable('Dữ liệu gửi lên không hợp lệ',
      err.issues.map((i) => ({ field: i.path.join('.'), message: i.message })));
  }

  // Trigger/thủ tục chặn thao tác trái quy tắc: SIGNAL SQLSTATE '45000'
  if (err?.sqlState === '45000') {
    return new AppError(409, 'BUSINESS_RULE_VIOLATION', err.sqlMessage);
  }

  switch (err?.errno) {
    case ER.DUP_ENTRY:
      return new AppError(409, 'DUPLICATE', 'Dữ liệu bị trùng', { constraint: extractKey(err.sqlMessage) });
    case ER.CHECK_VIOLATED:
      return new AppError(422, 'CONSTRAINT_VIOLATION', 'Dữ liệu vi phạm ràng buộc', { constraint: extractCheck(err.sqlMessage) });
    case ER.NO_REFERENCED_ROW:
      return new AppError(422, 'INVALID_REFERENCE', 'Đối tượng tham chiếu không tồn tại');
    case ER.LOCK_WAIT_TIMEOUT:
    case ER.DEADLOCK:
      return new AppError(503, 'BUSY', 'Hệ thống đang bận, vui lòng thử lại');
    case ER.TABLE_ACCESS_DENIED:
    case ER.PROC_ACCESS_DENIED:
      // Tài khoản ứng dụng bị từ chối quyền CSDL (ví dụ cố DELETE): lỗi lập trình hoặc dấu hiệu tấn công
      logger.warn({ errno: err.errno, msg: err.sqlMessage }, 'DB privilege denied');
      return new AppError(500, 'INTERNAL_ERROR', 'Lỗi hệ thống');
    default:
      return new AppError(500, 'INTERNAL_ERROR', 'Lỗi hệ thống');
  }
}

export const isRetryableDbError = (err) => err?.errno === ER.DEADLOCK || err?.errno === ER.LOCK_WAIT_TIMEOUT;

function extractKey(msg = '') {
  return /for key '([^']+)'/.exec(msg)?.[1];
}
function extractCheck(msg = '') {
  return /constraint '([^']+)'/.exec(msg)?.[1];
}

// Middleware cuối cùng của Express
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  // JSON hỏng trong body
  if (err?.type === 'entity.parse.failed') err = AppError.badRequest('Body không phải JSON hợp lệ');
  if (err?.type === 'entity.too.large') err = new AppError(413, 'PAYLOAD_TOO_LARGE', 'Dữ liệu gửi lên quá lớn');

  const appErr = toAppError(err);
  if (appErr.status >= 500) {
    req.log?.error({ err }, 'Unhandled error');
  }
  res.status(appErr.status).json({
    error: { code: appErr.code, message: appErr.message, details: appErr.details, requestId: req.id },
  });
}

export function notFoundHandler(req, res) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `Không có API ${req.method} ${req.path}` } });
}
