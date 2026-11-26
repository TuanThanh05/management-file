import multer from 'multer';
import { pool } from '../config/database.js';
import { getSettings } from '../core/settings.js';
import { AppError } from '../core/errors.js';

// Nhận 1 file trường "file" vào bộ nhớ, giới hạn dung lượng theo tham số MAX_FILE_SIZE_MB (BM22)
export function uploadSingle(field = 'file') {
  return async (req, res, next) => {
    const { MAX_FILE_SIZE_MB } = await getSettings(pool, ['MAX_FILE_SIZE_MB']);
    const handler = multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: MAX_FILE_SIZE_MB * 1024 * 1024, files: 1, fields: 0 },
    }).single(field);
    handler(req, res, (err) => {
      if (!err) {
        if (!req.file) return next(AppError.unprocessable('Thiếu file', [{ field, message: `Gửi file trong trường "${field}"` }]));
        return next();
      }
      if (err.code === 'LIMIT_FILE_SIZE') return next(new AppError(413, 'FILE_TOO_LARGE', `File vượt quá ${MAX_FILE_SIZE_MB} MB`));
      if (err instanceof multer.MulterError) return next(AppError.badRequest(`Dữ liệu tải lên không hợp lệ (${err.code})`));
      next(err);
    });
  };
}
