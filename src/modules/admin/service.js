import { pool } from '../../config/database.js';
import { withTx } from '../../core/tx.js';
import { AppError } from '../../core/errors.js';
import { notifyRole, notifyUsers } from '../../core/notify.js';
import { hashPassword, generateTempPassword } from '../../core/password.js';
import { revokeAllSessions } from '../auth/repo.js';
import * as repo from './repo.js';
import { runExpiryScan } from '../../jobs/expiryScan.js';
import { runDisposalExecution } from '../../jobs/disposalExecution.js';

const ROLE_NAMES = {
  EMPLOYEE: 'Nhân viên', DEPARTMENT_HEAD: 'Trưởng phòng', RECORDS_OFFICER: 'Cán bộ lưu trữ',
  DIRECTOR: 'Giám đốc', SYSTEM_ADMIN: 'Quản trị hệ thống',
};
const userCode = (email) => email.slice(0, 50);
const parseJson = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

// Chặn thao tác lên chính tài khoản của mình
function forbidSelf(actor, userId, message) {
  if (String(actor.userId) === String(userId)) throw new AppError(403, 'SELF_ACTION_FORBIDDEN', message);
}

// Lấy phòng ban đang hoạt động theo mã, không có thì báo lỗi
async function requireActiveDepartment(conn, code, field = 'departmentCode') {
  const dept = await repo.findDepartment(conn, code);
  if (!dept || dept.status !== 'ACTIVE') {
    throw AppError.unprocessable('Phòng ban không tồn tại hoặc đã ngừng hoạt động', [{ field, message: `Không có phòng ban hoạt động mã ${code}` }]);
  }
  return dept;
}

// ---------- Phòng ban (5.5 chức năng 2, BM20) ----------

// Dữ liệu phòng ban trả về client
function toDepartment(r) {
  return {
    code: r.code, name: r.name, status: r.status, parentCode: r.parent_code ?? null,
    head: parseJson(r.head) ?? null, activeUsers: Number(r.active_users ?? 0), createdAt: r.created_at,
  };
}

// Danh sách phòng ban
export async function listDepartments() {
  return (await repo.listDepartments()).map(toDepartment);
}

// Thêm phòng ban: mã duy nhất viết hoa, phòng cha phải đang hoạt động
export async function createDepartment(actor, { code, name, parentCode }) {
  return withTx(actor, async ({ conn, audit }) => {
    const parent = parentCode ? await requireActiveDepartment(conn, parentCode, 'parentCode') : null;
    await repo.insertDepartment(conn, { code, name, parentId: parent?.id ?? null });
    await audit({ action: 'DEPARTMENT_CREATE', objectType: 'DEPARTMENT', objectCode: code, details: { name, parentCode: parent?.code ?? null } });
    return { code, name, status: 'ACTIVE', parentCode: parent?.code ?? null };
  });
}

// Sửa tên / phòng ban cha; trigger chặn vòng lặp trong cây
export async function updateDepartment(actor, code, changes) {
  return withTx(actor, async ({ conn, audit }) => {
    const dept = await repo.findDepartment(conn, code, { forUpdate: true });
    if (!dept) throw AppError.notFound('Không tìm thấy phòng ban');
    let parentId = dept.parent_id;
    let parentCode = dept.parent_code ?? null;
    if (changes.parentCode !== undefined) {
      if (changes.parentCode === null) {
        parentId = null;
        parentCode = null;
      } else {
        if (changes.parentCode === code) throw AppError.conflict('Phòng ban không thể là cha của chính nó');
        const parent = await requireActiveDepartment(conn, changes.parentCode, 'parentCode');
        parentId = parent.id;
        parentCode = parent.code;
      }
    }
    const name = changes.name ?? dept.name;
    await repo.updateDepartment(conn, dept.id, { name, parentId });
    await audit({ action: 'DEPARTMENT_UPDATE', objectType: 'DEPARTMENT', objectCode: code,
      details: { before: { name: dept.name, parentCode: dept.parent_code ?? null }, after: { name, parentCode } } });
    return { code, name, status: dept.status, parentCode };
  });
}

// Ngừng hoạt động: chỉ khi phòng không còn tài khoản đang hoạt động
export async function deactivateDepartment(actor, code) {
  return withTx(actor, async ({ conn, audit }) => {
    const dept = await repo.findDepartment(conn, code, { forUpdate: true });
    if (!dept) throw AppError.notFound('Không tìm thấy phòng ban');
    if (dept.status === 'INACTIVE') throw AppError.conflict('Phòng ban đã ngừng hoạt động');
    const n = await repo.countActiveUsersInDepartment(conn, dept.id);
    if (n > 0) throw AppError.conflict(`Phòng ban còn ${n} tài khoản đang hoạt động`, { activeUsers: n });
    await repo.setDepartmentStatus(conn, dept.id, 'INACTIVE');
    await audit({ action: 'DEPARTMENT_DEACTIVATE', objectType: 'DEPARTMENT', objectCode: code });
    return { code, status: 'INACTIVE' };
  });
}

// Mở lại phòng ban đã ngừng hoạt động
export async function activateDepartment(actor, code) {
  return withTx(actor, async ({ conn, audit }) => {
    const dept = await repo.findDepartment(conn, code, { forUpdate: true });
    if (!dept) throw AppError.notFound('Không tìm thấy phòng ban');
    if (dept.status === 'ACTIVE') throw AppError.conflict('Phòng ban đang hoạt động');
    await repo.setDepartmentStatus(conn, dept.id, 'ACTIVE');
    await audit({ action: 'DEPARTMENT_ACTIVATE', objectType: 'DEPARTMENT', objectCode: code });
    return { code, status: 'ACTIVE' };
  });
}

// ---------- Tài khoản (5.5 chức năng 3, 5; BM21 phần A) ----------

// Dữ liệu tài khoản trả về client
function toUser(r) {
  return {
    id: String(r.id), email: r.email, fullName: r.full_name, status: r.status,
    department: { code: r.department_code, name: r.department_name },
    roles: parseJson(r.roles) ?? [], mustChangePassword: Boolean(Number(r.must_change_password)),
    lastLoginAt: r.last_login_at, lockedAt: r.locked_at, createdAt: r.created_at, createdBy: r.created_by_email ?? null,
  };
}

// Danh sách tài khoản có lọc, phân trang
export async function listUsers(query) {
  const { total, rows } = await repo.listUsers(query);
  return { items: rows.map(toUser), page: query.page, pageSize: query.pageSize, total };
}

// Chi tiết tài khoản
export async function getUser(id) {
  const row = await repo.getUser(pool, id);
  if (!row) throw AppError.notFound('Không tìm thấy tài khoản');
  return toUser(row);
}

// Tạo tài khoản kèm vai trò; mật khẩu tạm chỉ trả về một lần
export async function createUser(actor, { email, fullName, departmentCode, roles }) {
  const tempPassword = generateTempPassword();
  const passwordHash = await hashPassword(tempPassword);
  const user = await withTx(actor, async ({ conn, audit }) => {
    const dept = await requireActiveDepartment(conn, departmentCode);
    const id = await repo.insertUser(conn, { email, fullName, passwordHash, departmentId: dept.id, createdBy: actor.userId });
    for (const role of roles) await repo.grantRole(conn, id, role, actor.userId);
    await audit({ action: 'USER_CREATE', objectType: 'USER', objectCode: userCode(email),
      details: { userId: id, fullName, department: dept.code, roles } });
    await notifyRole(conn, 'DIRECTOR', { type: 'SYSTEM_CHANGE', objectType: 'USER', objectCode: userCode(email),
      message: `Tài khoản ${email} được tạo với vai trò: ${roles.map((r) => ROLE_NAMES[r]).join(', ')}` });
    return toUser(await repo.getUser(conn, id));
  });
  return { user, tempPassword };
}

// Sửa họ tên / phòng ban; Trưởng phòng phải thu hồi vai trò trước khi chuyển phòng
export async function updateUser(actor, id, changes) {
  return withTx(actor, async ({ conn, audit }) => {
    const cur = await repo.lockUserRow(conn, id);
    if (!cur) throw AppError.notFound('Không tìm thấy tài khoản');
    const before = await repo.getUser(conn, id);
    let departmentId = cur.department_id;
    if (changes.departmentCode && changes.departmentCode !== before.department_code) {
      const roles = await repo.getActiveRoleCodes(conn, id);
      if (roles.includes('DEPARTMENT_HEAD')) {
        throw AppError.conflict('Tài khoản đang là Trưởng phòng; thu hồi vai trò Trưởng phòng trước khi chuyển phòng');
      }
      departmentId = (await requireActiveDepartment(conn, changes.departmentCode)).id;
    }
    const fullName = changes.fullName ?? cur.full_name;
    await repo.updateUser(conn, id, { fullName, departmentId });
    const after = await repo.getUser(conn, id);
    await audit({ action: 'USER_UPDATE', objectType: 'USER', objectCode: userCode(cur.email),
      details: { before: { fullName: cur.full_name, department: before.department_code },
        after: { fullName, department: after.department_code } } });
    return toUser(after);
  });
}

// Khóa tài khoản: không khóa chính mình, hủy mọi phiên đang mở
export async function lockUser(actor, id) {
  forbidSelf(actor, id, 'Không được khóa tài khoản của chính mình');
  return withTx(actor, async ({ conn, audit }) => {
    const cur = await repo.lockUserRow(conn, id);
    if (!cur) throw AppError.notFound('Không tìm thấy tài khoản');
    if (cur.status === 'LOCKED') throw AppError.conflict('Tài khoản đã bị khóa');
    await repo.lockUser(conn, id, actor.userId);
    const revoked = await revokeAllSessions(conn, id, 'ACCOUNT_LOCKED');
    await audit({ action: 'USER_LOCK', objectType: 'USER', objectCode: userCode(cur.email), details: { revokedSessions: revoked } });
    return toUser(await repo.getUser(conn, id));
  });
}

// Mở khóa: không để phòng có 2 Trưởng phòng hoặc doanh nghiệp có 2 Giám đốc đang hoạt động
export async function unlockUser(actor, id) {
  return withTx(actor, async ({ conn, audit }) => {
    const cur = await repo.lockUserRow(conn, id);
    if (!cur) throw AppError.notFound('Không tìm thấy tài khoản');
    if (cur.status === 'ACTIVE') throw AppError.conflict('Tài khoản đang hoạt động');
    const roles = await repo.getActiveRoleCodes(conn, id);
    if (roles.includes('DEPARTMENT_HEAD')
      && await repo.otherActiveHolderExists(conn, { roleCode: 'DEPARTMENT_HEAD', excludeUserId: id, departmentId: cur.department_id })) {
      throw AppError.conflict('Phòng ban đã có Trưởng phòng khác; thu hồi vai trò Trưởng phòng của tài khoản này trước khi mở khóa');
    }
    if (roles.includes('DIRECTOR') && await repo.otherActiveHolderExists(conn, { roleCode: 'DIRECTOR', excludeUserId: id })) {
      throw AppError.conflict('Doanh nghiệp đã có Giám đốc khác; thu hồi vai trò Giám đốc của tài khoản này trước khi mở khóa');
    }
    await repo.unlockUser(conn, id);
    await audit({ action: 'USER_UNLOCK', objectType: 'USER', objectCode: userCode(cur.email) });
    return toUser(await repo.getUser(conn, id));
  });
}

// Đặt lại mật khẩu: không áp dụng cho chính mình, hủy phiên, thông báo cho người dùng
export async function resetUserPassword(actor, id) {
  forbidSelf(actor, id, 'Dùng chức năng Đổi mật khẩu cho tài khoản của mình');
  const tempPassword = generateTempPassword();
  const passwordHash = await hashPassword(tempPassword);
  await withTx(actor, async ({ conn, audit }) => {
    const cur = await repo.lockUserRow(conn, id);
    if (!cur) throw AppError.notFound('Không tìm thấy tài khoản');
    await repo.resetPassword(conn, id, passwordHash);
    const revoked = await revokeAllSessions(conn, id, 'PASSWORD_RESET');
    await audit({ action: 'USER_PASSWORD_RESET', objectType: 'USER', objectCode: userCode(cur.email), details: { revokedSessions: revoked } });
    await notifyUsers(conn, [id], { type: 'SECURITY_ALERT', objectType: 'USER', objectCode: userCode(cur.email),
      message: 'Mật khẩu của bạn đã được Quản trị viên đặt lại; hãy đổi mật khẩu ở lần đăng nhập tiếp theo' });
  });
  return { tempPassword };
}

// ---------- Vai trò (5.5 chức năng 4, BM21 phần B) ----------

// Đặt lại danh sách vai trò: thu hồi trước rồi gán; hủy phiên của người bị đổi; báo Giám đốc
export async function setUserRoles(actor, id, { roles }) {
  forbidSelf(actor, id, 'Không được tự gán hoặc thu hồi vai trò của chính mình');
  return withTx(actor, async ({ conn, audit }) => {
    const cur = await repo.lockUserRow(conn, id);
    if (!cur) throw AppError.notFound('Không tìm thấy tài khoản');
    const before = await repo.getActiveRoleCodes(conn, id);
    const toRevoke = before.filter((r) => !roles.includes(r));
    const toGrant = roles.filter((r) => !before.includes(r));
    if (!toRevoke.length && !toGrant.length) return { userId: id, roles: before, changed: false };

    for (const r of toRevoke) await repo.revokeRole(conn, id, r, actor.userId);
    for (const r of toGrant) await repo.grantRole(conn, id, r, actor.userId);
    const after = await repo.getActiveRoleCodes(conn, id);
    const revoked = await revokeAllSessions(conn, id, 'ROLES_CHANGED');
    await audit({ action: 'USER_ROLES_CHANGE', objectType: 'USER', objectCode: userCode(cur.email),
      details: { before, after, revokedSessions: revoked } });
    await notifyRole(conn, 'DIRECTOR', { type: 'SYSTEM_CHANGE', objectType: 'USER', objectCode: userCode(cur.email),
      message: `Vai trò của ${cur.email} thay đổi: ${before.map((r) => ROLE_NAMES[r]).join(', ') || '(không)'} → ${after.map((r) => ROLE_NAMES[r]).join(', ')}` });
    return { userId: id, roles: after, changed: true };
  });
}

// ---------- Tham số hệ thống (5.5 chức năng 6, BM22) ----------

// Dữ liệu tham số trả về client
function toSetting(r) {
  return {
    key: r.setting_key, value: r.value_type === 'INTEGER' ? Number(r.value) : r.value, type: r.value_type,
    min: r.min_value, max: r.max_value, description: r.description, updatedAt: r.updated_at, updatedBy: r.updated_by_email ?? null,
  };
}

// Danh sách tham số
export async function listSettings() {
  return (await repo.listSettings()).map(toSetting);
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

// Kiểm tra giá trị theo kiểu và khoảng cho phép của tham số; trả về chuỗi lỗi hoặc null
export function checkSettingValue(setting, value) {
  switch (setting.value_type) {
    case 'INTEGER': {
      if (!/^\d{1,9}$/.test(value)) return 'Giá trị phải là số nguyên không âm';
      const n = Number(value);
      if ((setting.min_value != null && n < setting.min_value) || (setting.max_value != null && n > setting.max_value)) {
        return `Giá trị phải từ ${setting.min_value} đến ${setting.max_value}`;
      }
      return null;
    }
    case 'DAY_MONTH': {
      const m = /^(\d{2})\/(\d{2})$/.exec(value);
      if (!m) return 'Định dạng dd/mm';
      const day = Number(m[1]);
      const month = Number(m[2]);
      if (month < 1 || month > 12 || day < 1 || day > DAYS_IN_MONTH[month - 1]) return 'Ngày tháng không hợp lệ';
      return null;
    }
    case 'TIME':
      return /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? null : 'Định dạng hh:mm (00:00 đến 23:59)';
    default:
      return value.length >= 1 && value.length <= 255 ? null : 'Độ dài từ 1 đến 255 ký tự';
  }
}

// Sửa một tham số; ghi nhật ký giá trị cũ và mới; báo Giám đốc
export async function updateSetting(actor, key, { value }) {
  return withTx(actor, async ({ conn, audit }) => {
    const s = await repo.findSettingForUpdate(conn, key);
    if (!s) throw AppError.notFound('Không có tham số này');
    const err = checkSettingValue(s, value);
    if (err) throw AppError.unprocessable('Giá trị tham số không hợp lệ', [{ field: 'value', message: err }]);
    if (s.value !== value) {
      await repo.updateSetting(conn, key, value, actor.userId);
      await audit({ action: 'SETTING_UPDATE', objectType: 'SETTING', objectCode: key, details: { old: s.value, new: value } });
      await notifyRole(conn, 'DIRECTOR', { type: 'SYSTEM_CHANGE', objectType: 'SETTING', objectCode: key,
        message: `Tham số ${key} thay đổi: ${s.value} → ${value}` });
    }
    const [[row]] = await conn.query(
      `SELECT s.*, u.email AS updated_by_email FROM system_settings s LEFT JOIN users u ON u.id = s.updated_by WHERE s.setting_key = ?`, [key]);
    return toSetting(row);
  });
}

// ---------- Tác vụ định kỳ (5.5, theo dõi job_runs) ----------

const RUNNERS = { 'expiry-scan': runExpiryScan, 'disposal-execution': runDisposalExecution };

// Lịch sử chạy tác vụ, mới nhất trước, 20 dòng mỗi trang
export async function listJobRuns({ jobName, page }) {
  const where = jobName ? 'WHERE j.job_name = ?' : '';
  const params = jobName ? [jobName] : [];
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM job_runs j ${where}`, params);
  const [rows] = await pool.query(
    `SELECT j.*, u.email AS triggered_by_email FROM job_runs j LEFT JOIN users u ON u.id = j.triggered_by ${where}
     ORDER BY j.id DESC LIMIT 20 OFFSET ?`, [...params, (page - 1) * 20]);
  return {
    page, pageSize: 20, total: Number(total),
    items: rows.map((r) => ({
      id: String(r.id), jobName: r.job_name, runType: r.run_type, triggeredBy: r.triggered_by_email, startedAt: r.started_at,
      finishedAt: r.finished_at, result: r.result, processedCount: r.processed_count, errorCount: r.error_count, note: r.note,
    })),
  };
}

// Chạy tay một tác vụ (Quản trị hệ thống); ghi nhật ký người bấm chạy
export async function runJobNow(actor, job) {
  const out = await RUNNERS[job]({ runType: 'MANUAL', triggeredBy: actor.userId });
  await withTx(actor, ({ audit }) => audit({ action: 'JOB_RUN_MANUAL', objectType: 'JOB', objectCode: job,
    result: out.result === 'FAILED' ? 'FAILURE' : 'SUCCESS', details: { runId: out.id, result: out.result, processed: out.processed, errors: out.errors } }));
  return { runId: out.id, result: out.result, processedCount: out.processed, errorCount: out.errors, note: out.note ?? null };
}
