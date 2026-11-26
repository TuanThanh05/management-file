import { pool } from '../config/database.js';
import { getSettings } from '../core/settings.js';
import { todayVN, timeVN } from '../core/time.js';
import { logger } from '../core/logger.js';
import { runExpiryScan } from './expiryScan.js';

const JOBS = { EXPIRY_SCAN: runExpiryScan };

// Hôm nay (giờ VN) tác vụ đã chạy theo lịch chưa (bỏ qua lần SKIPPED)
async function ranToday(jobName) {
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS n FROM job_runs WHERE job_name = ? AND run_type = 'SCHEDULED' AND result <> 'SKIPPED'
       AND started_at >= TIMESTAMP(?) - INTERVAL 7 HOUR`, [jobName, todayVN()]);
  return Number(row.n) > 0;
}

// Mỗi phút: đã qua giờ JOB_RUN_TIME mà hôm nay chưa chạy thì chạy (máy tắt qua giờ chạy thì chạy bù khi bật lại)
export async function tick(now = new Date()) {
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
