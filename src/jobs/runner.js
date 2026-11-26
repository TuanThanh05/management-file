import { pool } from '../config/database.js';
import { logger } from '../core/logger.js';

// Chạy một tác vụ có khóa GET_LOCK (không chạy trùng giữa các tiến trình) và ghi lịch sử vào job_runs
export async function runJob(jobName, { runType = 'SCHEDULED', triggeredBy = null } = {}, work) {
  const lockConn = await pool.getConnection();
  try {
    const [[{ got }]] = await lockConn.query('SELECT GET_LOCK(?, 0) AS got', [`rr_job_${jobName}`]);
    if (Number(got) !== 1) {
      const id = await insertRun(jobName, runType, triggeredBy, 'SKIPPED', 'Tác vụ đang chạy ở tiến trình khác');
      return { id, result: 'SKIPPED', processed: 0, errors: 0 };
    }
    const id = await insertRun(jobName, runType, triggeredBy, 'RUNNING', null);
    let out;
    try {
      out = await work();
    } catch (err) {
      logger.error({ err, jobName }, 'Tác vụ lỗi');
      await finishRun(id, 'FAILED', 0, 1, String(err.message ?? err).slice(0, 1000));
      return { id, result: 'FAILED', processed: 0, errors: 1 };
    }
    const result = out.errors === 0 ? 'SUCCESS' : out.processed > 0 ? 'PARTIAL' : 'FAILED';
    await finishRun(id, result, out.processed, out.errors, out.note ?? null);
    return { id, result, ...out };
  } finally {
    await lockConn.query('SELECT RELEASE_LOCK(?)', [`rr_job_${jobName}`]).catch(() => {});
    lockConn.release();
  }
}

// Ghi dòng job_runs mới; trả về id
async function insertRun(jobName, runType, triggeredBy, result, note) {
  const [ins] = await pool.query(
    `INSERT INTO job_runs (job_name, run_type, triggered_by, started_at, result, note, finished_at)
     VALUES (?, ?, ?, UTC_TIMESTAMP(3), ?, ?, IF(? = 'RUNNING', NULL, UTC_TIMESTAMP(3)))`,
    [jobName, runType, triggeredBy, result, note, result]);
  return String(ins.insertId);
}

// Kết thúc dòng job_runs với kết quả và số lượng đã xử lý
async function finishRun(id, result, processed, errors, note) {
  await pool.query('UPDATE job_runs SET finished_at = UTC_TIMESTAMP(3), result = ?, processed_count = ?, error_count = ?, note = ? WHERE id = ?',
    [result, processed, errors, note, id]);
}
