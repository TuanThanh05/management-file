import { pool } from '../config/database.js';
import { getSettings } from '../core/settings.js';
import { todayVN, timeVN } from '../core/time.js';
import { logger } from '../core/logger.js';
import { runExpiryScan } from './expiryScan.js';
import { runDisposalExecution, hasDueBatches } from './disposalExecution.js';
import { runBackup } from './backup.js';
import { env } from '../config/env.js';

// Tác vụ hằng ngày theo JOB_RUN_TIME; sao lưu chỉ chạy khi đã cấu hình khóa và tài khoản sao lưu
const JOBS = { EXPIRY_SCAN: runExpiryScan, ...(env.backupEnabled && { BACKUP: runBackup }) };

// Hôm nay (giờ VN) tác vụ đã chạy theo lịch chưa (bỏ qua lần SKIPPED)
async function ranToday(jobName) {
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS n FROM job_runs WHERE job_name = ? AND run_type = 'SCHEDULED' AND result <> 'SKIPPED'
       AND started_at >= TIMESTAMP(?) - INTERVAL 7 HOUR`, [jobName, todayVN()]);
  return Number(row.n) > 0;
}

// Lần chạy thực hiện hủy gần đây (15 phút) có lỗi không: có thì chờ, tránh thử lại liên tục mỗi phút
async function failedRecently() {
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS n FROM job_runs WHERE job_name = 'DISPOSAL_EXECUTION' AND result IN ('PARTIAL','FAILED')
       AND started_at >= UTC_TIMESTAMP(3) - INTERVAL 15 MINUTE`);
  return Number(row.n) > 0;
}

// Mỗi phút: có đợt đến giờ hủy thì thực hiện hủy; đã qua giờ JOB_RUN_TIME mà hôm nay chưa quét hạn thì quét (chạy bù khi máy bật lại)
export async function tick(now = new Date()) {
  if (await hasDueBatches() && !(await failedRecently())) await runDisposalExecution();
  const { JOB_RUN_TIME } = await getSettings(pool, ['JOB_RUN_TIME']);
  if (timeVN(now) < JOB_RUN_TIME) return;
  for (const [name, run] of Object.entries(JOBS)) {
    if (!(await ranToday(name))) await run();
  }
}

// Bật bộ hẹn giờ tác vụ định kỳ; trả về hàm dừng
export function startScheduler() {
  let busy = false;
  const loop = async () => {
    if (busy) return;
    busy = true;
    try {
      await tick();
    } catch (err) {
      logger.error({ err }, 'Bộ hẹn giờ tác vụ lỗi');
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(loop, 60_000);
  timer.unref();
  loop();
  return () => clearInterval(timer);
}
