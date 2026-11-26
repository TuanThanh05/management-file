
-- 0. XÓA CSDL VÀ TÀI KHOẢN CŨ, TẠO MỚI

-- Client gửi dữ liệu dạng UTF-8 (tránh lỗi font khi nạp bằng client mặc định latin1, ví dụ trong Docker)
SET NAMES utf8mb4;
DROP DATABASE IF EXISTS records_retention;
DROP DATABASE IF EXISTS luu_tru_huy;
DROP USER IF EXISTS 'app_retention'@'%';
DROP USER IF EXISTS 'app_luutru'@'%';

CREATE DATABASE records_retention CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE records_retention;
SET time_zone = '+00:00';


-- CỤM A. TỔ CHỨC, TÀI KHOẢN, PHÂN QUYỀN, PHIÊN ĐĂNG NHẬP


-- A1. Phòng ban (BM20)
CREATE TABLE departments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, code VARCHAR(10) NOT NULL COMMENT 'Mã phòng ban, dùng trong mã hồ sơ và mã đợt hủy; không sửa', name VARCHAR(150) NOT NULL,
  parent_id BIGINT UNSIGNED NULL COMMENT 'Phòng ban cấp trên (khối, chi nhánh); NULL = cấp cao nhất', status ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_departments_code (code),
  CONSTRAINT ck_departments_code CHECK (REGEXP_LIKE(code, '^[A-Z0-9]{1,10}$', 'c')),
  CONSTRAINT fk_departments_parent FOREIGN KEY (parent_id) REFERENCES departments (id)
) ENGINE=InnoDB COMMENT='Phòng ban';

-- A2. Người dùng (BM21 – phần A)
CREATE TABLE users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  email VARCHAR(255) NOT NULL COMMENT 'Tên đăng nhập; không sửa',
  full_name VARCHAR(100) NOT NULL,
  password_hash VARCHAR(100) NOT NULL COMMENT 'bcrypt cost >= 12; không lưu mật khẩu gốc',
  department_id BIGINT UNSIGNED NOT NULL, status ENUM('ACTIVE','LOCKED') NOT NULL DEFAULT 'ACTIVE',
  locked_by BIGINT UNSIGNED NULL COMMENT 'Quản trị viên khóa tài khoản',
  locked_at DATETIME(3) NULL,
  must_change_password BOOLEAN NOT NULL DEFAULT TRUE COMMENT 'TRUE khi tạo mới hoặc đặt lại mật khẩu',
  failed_login_count TINYINT UNSIGNED NOT NULL DEFAULT 0,
  login_locked_until DATETIME(3) NULL COMMENT 'Tạm khóa đăng nhập do nhập sai nhiều lần (tự động)',
  password_changed_at DATETIME(3) NULL,
  last_login_at DATETIME(3) NULL,
  created_by BIGINT UNSIGNED NULL COMMENT 'Quản trị viên tạo; NULL chỉ với tài khoản khởi tạo đầu tiên',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email),
  KEY idx_users_department (department_id, status),
  CONSTRAINT ck_users_email CHECK (REGEXP_LIKE(email, '^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$')),
  CONSTRAINT ck_users_locked CHECK ((status = 'LOCKED') = (locked_by IS NOT NULL AND locked_at IS NOT NULL)),
  CONSTRAINT fk_users_department FOREIGN KEY (department_id) REFERENCES departments (id),
  CONSTRAINT fk_users_locked_by FOREIGN KEY (locked_by) REFERENCES users (id),
  CONSTRAINT fk_users_created_by FOREIGN KEY (created_by) REFERENCES users (id)
) ENGINE=InnoDB COMMENT='Tài khoản người dùng';

-- A3. Vai trò (5 vai trò cố định)
CREATE TABLE roles (
  id TINYINT UNSIGNED NOT NULL,
  code ENUM('EMPLOYEE','DEPARTMENT_HEAD','RECORDS_OFFICER','DIRECTOR','SYSTEM_ADMIN') NOT NULL,
  name VARCHAR(50) NOT NULL COMMENT 'Tên hiển thị tiếng Việt',
  PRIMARY KEY (id),
  UNIQUE KEY uq_roles_code (code)
) ENGINE=InnoDB COMMENT='Vai trò';

-- A4. Gán vai trò (BM21 – phần B). Người gán và người thu hồi phải là Quản trị hệ thống.
--     Thu hồi = ghi revoked_by/revoked_at, không xóa dòng, để giữ lịch sử phân quyền.
CREATE TABLE user_roles (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  role_id TINYINT UNSIGNED NOT NULL,
  granted_by BIGINT UNSIGNED NULL COMMENT 'Quản trị viên gán; NULL chỉ với quản trị viên khởi tạo đầu tiên',
  granted_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  revoked_by BIGINT UNSIGNED NULL COMMENT 'Quản trị viên thu hồi',
  revoked_at DATETIME(3) NULL,
  is_active TINYINT AS (IF(revoked_at IS NULL, 1, NULL)) STORED COMMENT '1 = đang hiệu lực; NULL = đã thu hồi',
  PRIMARY KEY (id),
  UNIQUE KEY uq_user_roles_active (user_id, role_id, is_active),
  KEY idx_user_roles_role (role_id, is_active),
  CONSTRAINT ck_user_roles_not_self_grant CHECK (granted_by IS NULL OR granted_by <> user_id),
  CONSTRAINT ck_user_roles_not_self_revoke CHECK (revoked_by IS NULL OR revoked_by <> user_id),
  CONSTRAINT ck_user_roles_revoke CHECK ((revoked_by IS NULL) = (revoked_at IS NULL)),
  CONSTRAINT fk_user_roles_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_user_roles_role FOREIGN KEY (role_id) REFERENCES roles (id),
  CONSTRAINT fk_user_roles_granted_by FOREIGN KEY (granted_by) REFERENCES users (id),
  CONSTRAINT fk_user_roles_revoked_by FOREIGN KEY (revoked_by) REFERENCES users (id)
) ENGINE=InnoDB COMMENT='Gán và thu hồi vai trò';

-- A5. Quyền: mỗi quyền ứng với một nhóm chức năng ở Chương II mục 5 (một nhóm API)
CREATE TABLE permissions (
  code VARCHAR(50) NOT NULL,
  name VARCHAR(150) NOT NULL COMMENT 'Mô tả tiếng Việt',
  module VARCHAR(30) NOT NULL,
  PRIMARY KEY (code)
) ENGINE=InnoDB COMMENT='Danh mục quyền';

-- A6. Ma trận vai trò – quyền kèm phạm vi dữ liệu. Không có dòng = bị từ chối (deny-by-default).
CREATE TABLE role_permissions (
  role_id TINYINT UNSIGNED NOT NULL,
  permission_code VARCHAR(50) NOT NULL,
  scope ENUM('OWN','DEPARTMENT','ALL') NOT NULL COMMENT 'OWN: do mình tạo; DEPARTMENT: thuộc phòng mình; ALL: toàn doanh nghiệp',
  PRIMARY KEY (role_id, permission_code),
  CONSTRAINT fk_role_permissions_role FOREIGN KEY (role_id) REFERENCES roles (id),
  CONSTRAINT fk_role_permissions_permission FOREIGN KEY (permission_code) REFERENCES permissions (code)
) ENGINE=InnoDB COMMENT='Ma trận phân quyền';

-- A7. Phiên đăng nhập. JWT mang mã phiên (claim jti); mỗi yêu cầu kiểm tra phiên còn hiệu lực.
CREATE TABLE login_sessions (
  id CHAR(36) NOT NULL COMMENT 'UUID = jti của JWT',
  user_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NOT NULL COMMENT '= created_at + SESSION_HOURS',
  last_seen_at DATETIME(3) NULL,
  ip_address VARCHAR(45) NULL,
  user_agent VARCHAR(255) NULL,
  revoked_at DATETIME(3) NULL,
  revoke_reason ENUM('LOGOUT','PASSWORD_CHANGED','PASSWORD_RESET','ACCOUNT_LOCKED','ROLES_CHANGED') NULL,
  PRIMARY KEY (id),
  KEY idx_login_sessions_user (user_id, revoked_at, expires_at),
  CONSTRAINT ck_login_sessions_expiry CHECK (expires_at > created_at),
  CONSTRAINT ck_login_sessions_revoke CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL)),
  CONSTRAINT fk_login_sessions_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB COMMENT='Phiên đăng nhập';


-- CỤM B. DANH MỤC VÀ CHÍNH SÁCH LƯU TRỮ (Nhóm -> Nhãn -> Loại tài liệu)


-- B1. Nhóm hồ sơ (BM14) – tầng 1, theo lĩnh vực pháp lý (kế toán, nhân sự, khách hàng, hợp đồng, hành chính)
CREATE TABLE record_groups (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code VARCHAR(20) NOT NULL,
  name VARCHAR(150) NOT NULL,
  description VARCHAR(500) NULL,
  status ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  created_by BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_record_groups_code (code),
  CONSTRAINT fk_record_groups_created_by FOREIGN KEY (created_by) REFERENCES users (id)
) ENGINE=InnoDB COMMENT='Nhóm hồ sơ';

-- B2. Nhãn lưu trữ – chỉ là định danh; luật nằm ở phiên bản nhãn
CREATE TABLE retention_labels (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code VARCHAR(20) NOT NULL COMMENT 'Ví dụ KT-10N; không sửa',
  name VARCHAR(150) NOT NULL,
  group_id BIGINT UNSIGNED NOT NULL COMMENT 'Nhãn chỉ áp dụng cho loại tài liệu cùng nhóm',
  created_by BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_retention_labels_code (code),
  CONSTRAINT ck_retention_labels_code CHECK (REGEXP_LIKE(code, '^[A-Z0-9-]{1,20}$', 'c')),
  CONSTRAINT fk_retention_labels_group FOREIGN KEY (group_id) REFERENCES record_groups (id),
  CONSTRAINT fk_retention_labels_created_by FOREIGN KEY (created_by) REFERENCES users (id)
) ENGINE=InnoDB COMMENT='Nhãn lưu trữ';

-- B3. Phiên bản nhãn – NƠI LƯU LUẬT LƯU TRỮ (BM02)
CREATE TABLE label_versions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  label_id BIGINT UNSIGNED NOT NULL,
  version_no INT UNSIGNED NOT NULL,
  proposal_type ENUM('CREATE','UPDATE','DEACTIVATE') NOT NULL,
  label_name VARCHAR(150) NOT NULL COMMENT 'Tên nhãn tại phiên bản này',
  retention_type ENUM('FIXED','PERMANENT') NOT NULL COMMENT 'Có thời hạn / Vĩnh viễn',
  retention_years SMALLINT UNSIGNED NULL COMMENT 'T (1..100)',
  start_trigger ENUM('ARCHIVED_DATE','FISCAL_YEAR_END','EVENT_END') NULL COMMENT 'Mốc tính',
  event_name VARCHAR(100) NULL COMMENT 'Bắt buộc khi mốc tính là kết thúc sự kiện',
  warning_days SMALLINT UNSIGNED NULL COMMENT 'N (1..365)',
  contains_personal_data BOOLEAN NOT NULL,
  legal_basis VARCHAR(1000) NOT NULL,
  proposal_reason VARCHAR(1000) NOT NULL,
  status ENUM('DRAFT','PENDING','ACTIVE','RETIRED','REJECTED') NOT NULL DEFAULT 'DRAFT',
  created_by BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  submitted_at DATETIME(3) NULL,
  reviewed_by BIGINT UNSIGNED NULL,
  reviewed_at DATETIME(3) NULL,
  review_comment VARCHAR(500) NULL COMMENT 'Bắt buộc khi từ chối',
  effective_at DATETIME(3) NULL,
  retired_at DATETIME(3) NULL,
  active_flag TINYINT AS (IF(status = 'ACTIVE', 1, NULL)) STORED,
  open_flag TINYINT AS (IF(status IN ('DRAFT','PENDING'), 1, NULL)) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY uq_label_versions_no (label_id, version_no),
  UNIQUE KEY uq_label_versions_one_active (label_id, active_flag) COMMENT 'Mỗi nhãn tối đa 1 phiên bản đang hiệu lực',
  UNIQUE KEY uq_label_versions_one_open (label_id, open_flag) COMMENT 'Mỗi nhãn tối đa 1 đề xuất đang Nháp/Chờ duyệt',
  KEY idx_label_versions_status (status),
  CONSTRAINT ck_label_versions_retention CHECK (
    (retention_type = 'PERMANENT' AND retention_years IS NULL AND start_trigger IS NULL AND warning_days IS NULL)
    OR (retention_type = 'FIXED' AND retention_years BETWEEN 1 AND 100 AND start_trigger IS NOT NULL AND warning_days BETWEEN 1 AND 365)),
  CONSTRAINT ck_label_versions_event CHECK ((start_trigger = 'EVENT_END') = (event_name IS NOT NULL)
    OR (start_trigger IS NULL AND event_name IS NULL)),
  CONSTRAINT ck_label_versions_reason CHECK (CHAR_LENGTH(proposal_reason) >= 10),
  CONSTRAINT ck_label_versions_sod CHECK (reviewed_by IS NULL OR reviewed_by <> created_by),
  CONSTRAINT ck_label_versions_reviewed CHECK (status NOT IN ('ACTIVE','REJECTED') OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)),
  CONSTRAINT ck_label_versions_rejected CHECK (status <> 'REJECTED' OR CHAR_LENGTH(review_comment) >= 10),
  CONSTRAINT fk_label_versions_label FOREIGN KEY (label_id) REFERENCES retention_labels (id),
  CONSTRAINT fk_label_versions_created_by FOREIGN KEY (created_by) REFERENCES users (id),
  CONSTRAINT fk_label_versions_reviewed_by FOREIGN KEY (reviewed_by) REFERENCES users (id)
) ENGINE=InnoDB COMMENT='Phiên bản nhãn = luật lưu trữ';

-- B4. Loại tài liệu (BM15) – tầng 3: "kiểu" tài liệu, ví dụ Hóa đơn GTGT, Hợp đồng lao động
CREATE TABLE document_types (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code VARCHAR(20) NOT NULL,
  name VARCHAR(150) NOT NULL,
  group_id BIGINT UNSIGNED NOT NULL,
  description VARCHAR(500) NULL,
  current_label_version_id BIGINT UNSIGNED NULL COMMENT 'Lối tắt: phiên bản nhãn đang áp dụng; chỉ đổi khi Giám đốc duyệt nhãn',
  status ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  created_by BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_document_types_code (code),
  KEY idx_document_types_group (group_id),
  KEY idx_document_types_label_version (current_label_version_id),
  CONSTRAINT fk_document_types_group FOREIGN KEY (group_id) REFERENCES record_groups (id),
  CONSTRAINT fk_document_types_label_version FOREIGN KEY (current_label_version_id) REFERENCES label_versions (id),
  CONSTRAINT fk_document_types_created_by FOREIGN KEY (created_by) REFERENCES users (id)
) ENGINE=InnoDB COMMENT='Loại tài liệu';

-- B5. Danh sách loại tài liệu mà mỗi phiên bản nhãn áp dụng (BM02 – phần C)
CREATE TABLE label_version_document_types (
  label_version_id BIGINT UNSIGNED NOT NULL,
  document_type_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (label_version_id, document_type_id),
  KEY idx_lvdt_document_type (document_type_id),
  CONSTRAINT fk_lvdt_label_version FOREIGN KEY (label_version_id) REFERENCES label_versions (id),
  CONSTRAINT fk_lvdt_document_type FOREIGN KEY (document_type_id) REFERENCES document_types (id)
) ENGINE=InnoDB COMMENT='Loại tài liệu áp dụng của phiên bản nhãn';


-- CỤM C. HỒ SƠ VÀ FILE


-- C1. Hồ sơ (BM01, BM06, BM11) – một đơn vị tài liệu cụ thể, ví dụ "Hóa đơn GTGT số 0012345"
CREATE TABLE records (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code VARCHAR(30) NOT NULL COMMENT 'HS-<PB>-<Năm>-<6 số>',
  title VARCHAR(255) NOT NULL COMMENT 'Thay bằng mã hồ sơ khi hủy nếu nhãn có dữ liệu cá nhân',
  description VARCHAR(2000) NULL,
  document_type_id BIGINT UNSIGNED NOT NULL,
  department_id BIGINT UNSIGNED NOT NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  -- Trạng thái và hai thuộc tính độc lập
  status ENUM('IN_USE','PENDING_ARCHIVE','ARCHIVED','EXPIRED','PENDING_DISPOSAL','DISPOSED','CANCELLED') NOT NULL DEFAULT 'IN_USE'
    COMMENT 'Đang sử dụng / Chờ duyệt lưu trữ / Lưu trữ / Hết hạn / Chờ duyệt hủy / Đã hủy / Đã hủy bỏ',
  validity ENUM('VALID','ENDED') NOT NULL DEFAULT 'VALID' COMMENT 'Hiệu lực nghiệp vụ: Còn / Hết hiệu lực',
  is_on_hold BOOLEAN NOT NULL DEFAULT FALSE COMMENT 'Đang phong tỏa; do trigger của legal_hold_records cập nhật',
  is_disposal_eligible BOOLEAN NOT NULL DEFAULT FALSE COMMENT 'Dấu đủ điều kiện hủy do Cán bộ lưu trữ đặt',
  eligible_marked_by BIGINT UNSIGNED NULL,
  eligible_marked_at DATETIME(3) NULL,
  -- Khai báo
  document_date DATE NOT NULL,
  event_end_date DATE NULL COMMENT 'Ngày kết thúc sự kiện',
  event_note VARCHAR(255) NULL COMMENT 'Nội dung sự kiện',
  -- Duyệt lưu trữ
  submitted_at DATETIME(3) NULL,
  archive_approved_by BIGINT UNSIGNED NULL,
  archive_approved_at DATETIME(3) NULL,
  last_rejection_reason VARCHAR(500) NULL,
  -- Thời hạn (lưu cố định, không tính lại khi nhãn đổi)
  label_version_id BIGINT UNSIGNED NULL COMMENT 'Phiên bản nhãn gắn lúc duyệt; không đổi',
  retention_start_date DATE NULL COMMENT 'Mốc tính',
  expiry_date DATE NULL COMMENT 'NULL: vĩnh viễn hoặc chưa xác định',
  is_warned BOOLEAN NOT NULL DEFAULT FALSE COMMENT 'Đã gửi cảnh báo sắp hết hạn',
  ended_marked_by BIGINT UNSIGNED NULL COMMENT 'Trưởng phòng đánh dấu hết hiệu lực',
  ended_marked_at DATETIME(3) NULL,
  -- Kết thúc
  disposed_at DATETIME(3) NULL,
  cancel_reason VARCHAR(500) NULL,
  cancelled_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_records_code (code),
  KEY idx_records_expiry_scan (status, expiry_date),
  KEY idx_records_department (department_id, status, created_at),
  KEY idx_records_document_type (document_type_id, status),
  KEY idx_records_created_by (created_by, status),
  KEY idx_records_label_version (label_version_id),
  FULLTEXT KEY ft_records (code, title),
  CONSTRAINT ck_records_title CHECK (CHAR_LENGTH(TRIM(title)) > 0),
  CONSTRAINT ck_records_event_date CHECK (event_end_date IS NULL OR event_end_date >= document_date),
  CONSTRAINT ck_records_sod CHECK (archive_approved_by IS NULL OR archive_approved_by <> created_by),
  CONSTRAINT ck_records_approved CHECK (status IN ('IN_USE','PENDING_ARCHIVE','CANCELLED')
    OR (label_version_id IS NOT NULL AND archive_approved_by IS NOT NULL AND archive_approved_at IS NOT NULL)),
  CONSTRAINT ck_records_has_expiry CHECK (status NOT IN ('EXPIRED','PENDING_DISPOSAL','DISPOSED') OR expiry_date IS NOT NULL),
  CONSTRAINT ck_records_hold CHECK (NOT is_on_hold OR status IN ('ARCHIVED','EXPIRED','PENDING_DISPOSAL')),
  CONSTRAINT ck_records_eligible CHECK (NOT is_disposal_eligible
    OR (status IN ('EXPIRED','PENDING_DISPOSAL','DISPOSED') AND NOT is_on_hold AND eligible_marked_by IS NOT NULL)),
  CONSTRAINT ck_records_disposed CHECK (status <> 'DISPOSED' OR disposed_at IS NOT NULL),
  CONSTRAINT ck_records_cancelled CHECK (status <> 'CANCELLED' OR (CHAR_LENGTH(cancel_reason) >= 10 AND cancelled_at IS NOT NULL)),
  CONSTRAINT ck_records_validity CHECK (validity = 'ENDED' OR event_end_date IS NULL),
  CONSTRAINT fk_records_document_type FOREIGN KEY (document_type_id) REFERENCES document_types (id),
  CONSTRAINT fk_records_department FOREIGN KEY (department_id) REFERENCES departments (id),
  CONSTRAINT fk_records_created_by FOREIGN KEY (created_by) REFERENCES users (id),
  CONSTRAINT fk_records_approved_by FOREIGN KEY (archive_approved_by) REFERENCES users (id),
  CONSTRAINT fk_records_label_version FOREIGN KEY (label_version_id) REFERENCES label_versions (id),
  CONSTRAINT fk_records_eligible_by FOREIGN KEY (eligible_marked_by) REFERENCES users (id),
  CONSTRAINT fk_records_ended_by FOREIGN KEY (ended_marked_by) REFERENCES users (id)
) ENGINE=InnoDB COMMENT='Hồ sơ';

-- C2. File logic trong hồ sơ
CREATE TABLE files (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  record_id BIGINT UNSIGNED NOT NULL,
  original_name VARCHAR(255) NOT NULL COMMENT 'Bị thay bằng tên trung tính khi hủy hồ sơ có dữ liệu cá nhân',
  is_active BOOLEAN NOT NULL DEFAULT TRUE COMMENT 'FALSE: đã gỡ khỏi hồ sơ, vẫn giữ lịch sử',
  created_by BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_files_record (record_id, is_active),
  CONSTRAINT fk_files_record FOREIGN KEY (record_id) REFERENCES records (id),
  CONSTRAINT fk_files_created_by FOREIGN KEY (created_by) REFERENCES users (id)
) ENGINE=InnoDB COMMENT='File thuộc hồ sơ';

-- C3. Phiên bản file – bản mã AES-256-GCM, khóa dữ liệu đã bọc bằng khóa chủ (mã hóa phong bì)
CREATE TABLE file_versions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  file_id BIGINT UNSIGNED NOT NULL,
  version_no INT UNSIGNED NOT NULL,
  storage_name CHAR(36) NOT NULL COMMENT 'UUID, tên file trên đĩa',
  format ENUM('PDF','DOCX','XLSX','JPG','PNG') NOT NULL COMMENT 'Xác định theo magic bytes',
  size_bytes BIGINT UNSIGNED NOT NULL COMMENT 'Kích thước nội dung gốc',
  sha256 CHAR(64) NOT NULL COMMENT 'Băm nội dung gốc (hex)',
  wrapped_key VARBINARY(128) NULL COMMENT 'Khóa dữ liệu đã bọc bằng khóa chủ; NULL = đã hủy bằng mật mã',
  iv BINARY(12) NOT NULL,
  auth_tag BINARY(16) NOT NULL COMMENT 'Thẻ xác thực AES-GCM',
  is_purged BOOLEAN NOT NULL DEFAULT FALSE COMMENT 'Đã xóa bản mã trên đĩa',
  uploaded_by BIGINT UNSIGNED NOT NULL,
  uploaded_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_file_versions_no (file_id, version_no),
  UNIQUE KEY uq_file_versions_storage (storage_name),
  KEY idx_file_versions_purge (is_purged, wrapped_key(1)),
  CONSTRAINT ck_file_versions_size CHECK (size_bytes > 0),
  CONSTRAINT ck_file_versions_sha256 CHECK (REGEXP_LIKE(sha256, '^[0-9a-f]{64}$', 'c')),
  CONSTRAINT ck_file_versions_purge CHECK (NOT is_purged OR wrapped_key IS NULL),
  CONSTRAINT fk_file_versions_file FOREIGN KEY (file_id) REFERENCES files (id),
  CONSTRAINT fk_file_versions_uploaded_by FOREIGN KEY (uploaded_by) REFERENCES users (id)
) ENGINE=InnoDB COMMENT='Phiên bản file đã mã hóa';


-- CỤM D. VÒNG ĐỜI: GIA HẠN, PHONG TỎA, ĐỢT HỦY, BIÊN BẢN


-- D1. Đề xuất gia hạn (BM03). Người đề xuất: Nhân viên phòng sở hữu; người duyệt: Trưởng phòng.
CREATE TABLE extension_requests (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code VARCHAR(20) NOT NULL COMMENT 'GH-<Năm>-<4 số>',
  record_id BIGINT UNSIGNED NOT NULL,
  old_expiry_date DATE NOT NULL,
  new_expiry_date DATE NOT NULL,
  reason VARCHAR(500) NOT NULL,
  status ENUM('PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'PENDING',
  requested_by BIGINT UNSIGNED NOT NULL,
  requested_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  reviewed_by BIGINT UNSIGNED NULL,
  reviewed_at DATETIME(3) NULL,
  review_comment VARCHAR(500) NULL,
  pending_flag TINYINT AS (IF(status = 'PENDING', 1, NULL)) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY uq_extension_requests_code (code),
  UNIQUE KEY uq_extension_requests_one_pending (record_id, pending_flag) COMMENT 'Mỗi hồ sơ tối đa 1 đề xuất đang chờ',
  KEY idx_extension_requests_status (status, requested_at),
  CONSTRAINT ck_extension_requests_dates CHECK (new_expiry_date > old_expiry_date),
  CONSTRAINT ck_extension_requests_reason CHECK (CHAR_LENGTH(reason) >= 10),
  CONSTRAINT ck_extension_requests_sod CHECK (reviewed_by IS NULL OR reviewed_by <> requested_by),
  CONSTRAINT ck_extension_requests_reviewed CHECK (status = 'PENDING' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)),
  CONSTRAINT ck_extension_requests_rejected CHECK (status <> 'REJECTED' OR CHAR_LENGTH(review_comment) >= 10),
  CONSTRAINT fk_extension_requests_record FOREIGN KEY (record_id) REFERENCES records (id),
  CONSTRAINT fk_extension_requests_requested_by FOREIGN KEY (requested_by) REFERENCES users (id),
  CONSTRAINT fk_extension_requests_reviewed_by FOREIGN KEY (reviewed_by) REFERENCES users (id)
) ENGINE=InnoDB COMMENT='Đề xuất gia hạn';

-- D2. Lệnh phong tỏa (BM04)
CREATE TABLE legal_holds (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code VARCHAR(20) NOT NULL COMMENT 'PT-<Năm>-<4 số>',
  reason VARCHAR(1000) NOT NULL,
  legal_basis VARCHAR(255) NOT NULL COMMENT 'Căn cứ, ví dụ số quyết định thanh tra',
  expected_release_date DATE NULL COMMENT 'Chỉ để nhắc; hệ thống không tự gỡ',
  -- Tệp căn cứ (tùy chọn), mã hóa như file hồ sơ
  evidence_original_name VARCHAR(255) NULL,
  evidence_storage_name CHAR(36) NULL,
  evidence_sha256 CHAR(64) NULL,
  evidence_wrapped_key VARBINARY(128) NULL,
  evidence_iv BINARY(12) NULL,
  evidence_auth_tag BINARY(16) NULL,
  placed_by BIGINT UNSIGNED NOT NULL,
  placed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_legal_holds_code (code),
  CONSTRAINT ck_legal_holds_reason CHECK (CHAR_LENGTH(reason) >= 10),
  CONSTRAINT ck_legal_holds_evidence CHECK ((evidence_storage_name IS NULL) =
    (evidence_sha256 IS NULL AND evidence_wrapped_key IS NULL AND evidence_iv IS NULL AND evidence_auth_tag IS NULL)),
  CONSTRAINT fk_legal_holds_placed_by FOREIGN KEY (placed_by) REFERENCES users (id)
) ENGINE=InnoDB COMMENT='Lệnh phong tỏa';

-- D3. Hồ sơ trong lệnh phong tỏa – gỡ được theo từng hồ sơ
CREATE TABLE legal_hold_records (
  legal_hold_id BIGINT UNSIGNED NOT NULL,
  record_id BIGINT UNSIGNED NOT NULL,
  status ENUM('ACTIVE','RELEASED') NOT NULL DEFAULT 'ACTIVE',
  released_by BIGINT UNSIGNED NULL,
  released_at DATETIME(3) NULL,
  release_reason VARCHAR(500) NULL,
  active_flag TINYINT AS (IF(status = 'ACTIVE', 1, NULL)) STORED,
  PRIMARY KEY (legal_hold_id, record_id),
  UNIQUE KEY uq_legal_hold_records_one_active (record_id, active_flag) COMMENT 'Mỗi hồ sơ tối đa 1 lệnh hiệu lực',
  CONSTRAINT ck_legal_hold_records_release CHECK (status = 'ACTIVE'
    OR (released_by IS NOT NULL AND released_at IS NOT NULL AND CHAR_LENGTH(release_reason) >= 10)),
  CONSTRAINT fk_legal_hold_records_hold FOREIGN KEY (legal_hold_id) REFERENCES legal_holds (id),
  CONSTRAINT fk_legal_hold_records_record FOREIGN KEY (record_id) REFERENCES records (id),
  CONSTRAINT fk_legal_hold_records_released_by FOREIGN KEY (released_by) REFERENCES users (id)
) ENGINE=InnoDB COMMENT='Hồ sơ thuộc lệnh phong tỏa';

-- D4. Đợt hủy (BM05, BM12, BM17)
CREATE TABLE disposal_batches (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code VARCHAR(30) NOT NULL COMMENT 'DH-<PB>-<Năm>-<3 số>',
  department_id BIGINT UNSIGNED NOT NULL,
  reason VARCHAR(1000) NOT NULL,
  status ENUM('DRAFT','PENDING_LEVEL_1','PENDING_LEVEL_2','APPROVED','COMPLETED','CANCELLED') NOT NULL DEFAULT 'DRAFT'
    COMMENT 'Nháp / Chờ duyệt cấp 1 / Chờ duyệt cấp 2 / Đã phê duyệt / Hoàn tất / Đã hủy bỏ',
  created_by BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  submitted_at DATETIME(3) NULL,
  level1_approver_id BIGINT UNSIGNED NULL,
  level1_approved_at DATETIME(3) NULL,
  level1_comment VARCHAR(500) NULL,
  level2_approver_id BIGINT UNSIGNED NULL,
  level2_approved_at DATETIME(3) NULL,
  level2_comment VARCHAR(500) NULL,
  scheduled_at DATETIME(3) NULL COMMENT '= level2_approved_at + DISPOSAL_WAIT_DAYS',
  started_at DATETIME(3) NULL,
  completed_at DATETIME(3) NULL,
  last_return_reason VARCHAR(500) NULL COMMENT 'Lý do trả lại / thu hồi gần nhất',
  cancel_reason VARCHAR(500) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_disposal_batches_code (code),
  KEY idx_disposal_batches_schedule (status, scheduled_at),
  KEY idx_disposal_batches_department (department_id, status),
  CONSTRAINT ck_disposal_batches_reason CHECK (CHAR_LENGTH(reason) >= 10),
  CONSTRAINT ck_disposal_batches_level1_sod CHECK (level1_approver_id IS NULL OR level1_approver_id <> created_by),
  CONSTRAINT ck_disposal_batches_level2_sod CHECK (level2_approver_id IS NULL
    OR (level2_approver_id <> created_by AND level2_approver_id <> level1_approver_id)),
  CONSTRAINT ck_disposal_batches_level1_done CHECK (status NOT IN ('PENDING_LEVEL_2','APPROVED','COMPLETED')
    OR (level1_approver_id IS NOT NULL AND level1_approved_at IS NOT NULL)),
  CONSTRAINT ck_disposal_batches_level2_done CHECK (status NOT IN ('APPROVED','COMPLETED')
    OR (level2_approver_id IS NOT NULL AND level2_approved_at IS NOT NULL AND scheduled_at > level2_approved_at)),
  CONSTRAINT ck_disposal_batches_completed CHECK (status <> 'COMPLETED' OR completed_at IS NOT NULL),
  CONSTRAINT ck_disposal_batches_cancelled CHECK (status <> 'CANCELLED' OR CHAR_LENGTH(cancel_reason) >= 10),
  CONSTRAINT fk_disposal_batches_department FOREIGN KEY (department_id) REFERENCES departments (id),
  CONSTRAINT fk_disposal_batches_created_by FOREIGN KEY (created_by) REFERENCES users (id),
  CONSTRAINT fk_disposal_batches_level1 FOREIGN KEY (level1_approver_id) REFERENCES users (id),
  CONSTRAINT fk_disposal_batches_level2 FOREIGN KEY (level2_approver_id) REFERENCES users (id)
) ENGINE=InnoDB COMMENT='Đợt hủy';

-- D5. Danh mục hồ sơ của đợt hủy và kết quả từng hồ sơ
CREATE TABLE disposal_batch_records (
  batch_id BIGINT UNSIGNED NOT NULL,
  record_id BIGINT UNSIGNED NOT NULL,
  item_status ENUM('INCLUDED','EXCLUDED','WITHDRAWN','DISPOSED') NOT NULL DEFAULT 'INCLUDED'
    COMMENT 'Trong đợt / Bị Trưởng phòng loại / Bị rút (phong tỏa, kiểm tra lần cuối, bỏ khỏi nháp, hủy bỏ đợt) / Đã hủy',
  exclusion_requested BOOLEAN NOT NULL DEFAULT FALSE COMMENT 'Trưởng phòng chọn loại; có hiệu lực khi đồng ý cấp 1',
  exclusion_reason VARCHAR(500) NULL COMMENT 'Lý do loại hoặc rút',
  attempt_count TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Số lần tác vụ hủy đã thử',
  last_error VARCHAR(500) NULL,
  disposed_at DATETIME(3) NULL,
  added_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  included_flag TINYINT AS (IF(item_status = 'INCLUDED', 1, NULL)) STORED,
  PRIMARY KEY (batch_id, record_id),
  UNIQUE KEY uq_dbr_one_open_batch (record_id, included_flag) COMMENT 'Hồ sơ chỉ nằm trong 1 đợt chưa kết thúc',
  KEY idx_dbr_errors (item_status, attempt_count),
  CONSTRAINT ck_dbr_reason CHECK (item_status NOT IN ('EXCLUDED','WITHDRAWN') OR CHAR_LENGTH(exclusion_reason) >= 10),
  CONSTRAINT ck_dbr_exclusion CHECK (NOT exclusion_requested OR (item_status = 'INCLUDED' AND CHAR_LENGTH(exclusion_reason) >= 10)),
  CONSTRAINT ck_dbr_disposed CHECK (item_status <> 'DISPOSED' OR disposed_at IS NOT NULL),
  CONSTRAINT fk_dbr_batch FOREIGN KEY (batch_id) REFERENCES disposal_batches (id),
  CONSTRAINT fk_dbr_record FOREIGN KEY (record_id) REFERENCES records (id)
) ENGINE=InnoDB COMMENT='Danh mục hồ sơ của đợt hủy';

-- D6. Biên bản hủy (BM16) – bản chụp, lưu vĩnh viễn, không sửa, không xóa
CREATE TABLE disposal_certificates (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  certificate_no VARCHAR(20) NOT NULL COMMENT 'BB-<Năm>-<4 số>',
  batch_id BIGINT UNSIGNED NOT NULL,
  issued_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  snapshot JSON NOT NULL COMMENT 'Toàn bộ nội dung BM16 tại thời điểm lập',
  pdf_storage_name CHAR(36) NOT NULL COMMENT 'UUID file PDF trong kho biên bản',
  pdf_sha256 CHAR(64) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_disposal_certificates_no (certificate_no),
  UNIQUE KEY uq_disposal_certificates_batch (batch_id),
  CONSTRAINT ck_disposal_certificates_sha256 CHECK (REGEXP_LIKE(pdf_sha256, '^[0-9a-f]{64}$', 'c')),
  CONSTRAINT fk_disposal_certificates_batch FOREIGN KEY (batch_id) REFERENCES disposal_batches (id)
) ENGINE=InnoDB COMMENT='Biên bản hủy';


-- CỤM E. NHẬT KÝ, GIÁM SÁT VÀ HỆ THỐNG


-- E1. Đầu chuỗi nhật ký – đúng 1 dòng
CREATE TABLE audit_chain_head (
  id TINYINT UNSIGNED NOT NULL,
  genesis_hash CHAR(64) NOT NULL COMMENT 'H(0)',
  last_seq BIGINT UNSIGNED NOT NULL,
  last_hash CHAR(64) NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT ck_audit_chain_head_single CHECK (id = 1)
) ENGINE=InnoDB COMMENT='Đầu chuỗi băm nhật ký';

-- E2. Nhật ký (BM18) – chỉ ghi qua thủ tục sp_write_audit_log
CREATE TABLE audit_logs (
  seq BIGINT UNSIGNED NOT NULL COMMENT 'Số thứ tự liên tục, không dùng AUTO_INCREMENT',
  occurred_at DATETIME(3) NOT NULL,
  user_id BIGINT UNSIGNED NULL COMMENT 'NULL: tác vụ hệ thống hoặc đăng nhập bằng tài khoản không tồn tại',
  roles VARCHAR(100) NULL,
  ip_address VARCHAR(45) NULL,
  action VARCHAR(50) NOT NULL,
  object_type VARCHAR(30) NULL COMMENT 'RECORD, DISPOSAL_BATCH, LABEL, EXTENSION, LEGAL_HOLD, USER, SETTING...',
  object_code VARCHAR(50) NULL,
  result ENUM('SUCCESS','FAILURE') NOT NULL,
  details JSON NULL COMMENT 'Giá trị trước/sau; không chứa mật khẩu',
  prev_hash CHAR(64) NOT NULL COMMENT 'H(i-1)',
  hash CHAR(64) NOT NULL COMMENT 'H(i)',
  PRIMARY KEY (seq),
  KEY idx_audit_logs_time (occurred_at),
  KEY idx_audit_logs_user (user_id, occurred_at),
  KEY idx_audit_logs_object (object_type, object_code, seq),
  KEY idx_audit_logs_action (action, occurred_at),
  CONSTRAINT fk_audit_logs_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB COMMENT='Nhật ký không thể sửa (chuỗi băm)';

-- E3. Kết quả kiểm tra toàn vẹn (BM19)
CREATE TABLE integrity_checks (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  checked_by BIGINT UNSIGNED NOT NULL,
  checked_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  from_seq BIGINT UNSIGNED NOT NULL,
  to_seq BIGINT UNSIGNED NOT NULL,
  checked_count BIGINT UNSIGNED NOT NULL,
  result ENUM('INTACT','TAMPERED') NOT NULL,
  first_bad_seq BIGINT UNSIGNED NULL,
  issue_type ENUM('HASH_MISMATCH','MISSING_RECORD') NULL,
  last_hash CHAR(64) NULL COMMENT 'Điểm neo để đối chiếu ở lần kiểm tra sau',
  PRIMARY KEY (id),
  CONSTRAINT ck_integrity_checks_range CHECK (from_seq >= 1 AND from_seq <= to_seq),
  CONSTRAINT ck_integrity_checks_issue CHECK ((result = 'TAMPERED') = (first_bad_seq IS NOT NULL AND issue_type IS NOT NULL)),
  CONSTRAINT fk_integrity_checks_checked_by FOREIGN KEY (checked_by) REFERENCES users (id)
) ENGINE=InnoDB COMMENT='Kết quả kiểm tra toàn vẹn nhật ký';

-- E4. Thông báo
CREATE TABLE notifications (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  recipient_id BIGINT UNSIGNED NOT NULL,
  type ENUM('ACTION_REQUIRED','REVIEW_RESULT','EXPIRY_WARNING','WITHDRAWN','SYSTEM_CHANGE','SECURITY_ALERT') NOT NULL,
  message VARCHAR(500) NOT NULL COMMENT 'Chỉ ghi mã đối tượng, không ghi tiêu đề hồ sơ',
  object_type VARCHAR(30) NULL,
  object_code VARCHAR(50) NULL,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  read_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  KEY idx_notifications_recipient (recipient_id, is_read, created_at),
  CONSTRAINT fk_notifications_recipient FOREIGN KEY (recipient_id) REFERENCES users (id)
) ENGINE=InnoDB COMMENT='Thông báo';

-- E5. Lịch sử chạy tác vụ định kỳ (khóa chạy đơn dùng GET_LOCK, không cần bảng)
CREATE TABLE job_runs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  job_name ENUM('EXPIRY_SCAN','DISPOSAL_EXECUTION','BACKUP') NOT NULL,
  run_type ENUM('SCHEDULED','MANUAL') NOT NULL DEFAULT 'SCHEDULED',
  triggered_by BIGINT UNSIGNED NULL,
  started_at DATETIME(3) NOT NULL,
  finished_at DATETIME(3) NULL,
  result ENUM('RUNNING','SUCCESS','PARTIAL','SKIPPED','FAILED') NOT NULL DEFAULT 'RUNNING',
  processed_count INT UNSIGNED NOT NULL DEFAULT 0,
  error_count INT UNSIGNED NOT NULL DEFAULT 0,
  note VARCHAR(1000) NULL,
  PRIMARY KEY (id),
  KEY idx_job_runs (job_name, started_at),
  CONSTRAINT ck_job_runs_manual CHECK ((run_type = 'MANUAL') = (triggered_by IS NOT NULL)),
  CONSTRAINT fk_job_runs_triggered_by FOREIGN KEY (triggered_by) REFERENCES users (id)
) ENGINE=InnoDB COMMENT='Lịch sử chạy tác vụ';

-- E6. Tham số hệ thống (BM22)
CREATE TABLE system_settings (
  setting_key VARCHAR(50) NOT NULL,
  value VARCHAR(255) NOT NULL,
  value_type ENUM('INTEGER','STRING','DAY_MONTH','TIME') NOT NULL,
  min_value INT NULL,
  max_value INT NULL,
  description VARCHAR(255) NOT NULL,
  updated_by BIGINT UNSIGNED NULL COMMENT 'Quản trị viên cập nhật gần nhất',
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (setting_key),
  CONSTRAINT ck_system_settings_format CHECK (
    (value_type = 'INTEGER' AND REGEXP_LIKE(value, '^[0-9]{1,9}$'))
    OR (value_type = 'DAY_MONTH' AND REGEXP_LIKE(value, '^(0[1-9]|[12][0-9]|3[01])/(0[1-9]|1[0-2])$'))
    OR (value_type = 'TIME' AND REGEXP_LIKE(value, '^([01][0-9]|2[0-3]):[0-5][0-9]$'))
    OR (value_type = 'STRING' AND CHAR_LENGTH(TRIM(value)) > 0)),
  CONSTRAINT fk_system_settings_updated_by FOREIGN KEY (updated_by) REFERENCES users (id)
) ENGINE=InnoDB COMMENT='Tham số cấu hình';

-- E7. Bộ đếm sinh mã nghiệp vụ – chỉ dùng qua thủ tục sp_next_code_number
CREATE TABLE code_counters (
  prefix VARCHAR(30) NOT NULL COMMENT 'Ví dụ HS-KT-2026, DH-KT-2026, GH-2026, PT-2026, BB-2026',
  counter_value INT UNSIGNED NOT NULL,
  PRIMARY KEY (prefix)
) ENGINE=InnoDB COMMENT='Bộ đếm số thứ tự cho mã nghiệp vụ';


-- HÀM, THỦ TỤC VÀ KHUNG NHÌN

DELIMITER $$

-- Ngày hiện tại theo lịch Việt Nam (UTC+7), dùng để so sánh với các cột DATE
CREATE FUNCTION fn_today_vn() RETURNS DATE NOT DETERMINISTIC NO SQL
BEGIN
  RETURN DATE(UTC_TIMESTAMP() + INTERVAL 7 HOUR);
END$$

-- Người dùng có đang giữ vai trò (còn hiệu lực, tài khoản hoạt động) hay không
CREATE FUNCTION fn_has_role(p_user_id BIGINT UNSIGNED, p_role_code VARCHAR(20)) RETURNS BOOLEAN READS SQL DATA
BEGIN
  RETURN EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id JOIN users u ON u.id = ur.user_id
                 WHERE ur.user_id = p_user_id AND ur.revoked_at IS NULL AND r.code = p_role_code AND u.status = 'ACTIVE');
END$$

-- H(i) = SHA-256( H(i-1) || nội dung bản ghi i ); nội dung tuần tự hóa bằng JSON_ARRAY để ranh giới trường là duy nhất
CREATE FUNCTION fn_audit_hash(
  p_prev_hash CHAR(64), p_seq BIGINT UNSIGNED, p_occurred_at DATETIME(3), p_user_id BIGINT UNSIGNED,
  p_roles VARCHAR(100), p_ip VARCHAR(45), p_action VARCHAR(50), p_object_type VARCHAR(30),
  p_object_code VARCHAR(50), p_result VARCHAR(20), p_details JSON)
RETURNS CHAR(64) DETERMINISTIC NO SQL
BEGIN
  RETURN SHA2(CONCAT(p_prev_hash, CAST(JSON_ARRAY(
    p_seq, DATE_FORMAT(p_occurred_at, '%Y-%m-%d %H:%i:%s.%f'), p_user_id, p_roles, p_ip,
    p_action, p_object_type, p_object_code, p_result, p_details) AS CHAR CHARACTER SET utf8mb4)), 256);
END$$

-- Ghi một bản ghi nhật ký. Gọi TRONG giao dịch nghiệp vụ (thủ tục không COMMIT).
-- Khóa dòng đầu chuỗi -> các lần ghi đồng thời xếp hàng, chuỗi không rẽ nhánh.
CREATE PROCEDURE sp_write_audit_log(
  IN p_user_id BIGINT UNSIGNED, IN p_roles VARCHAR(100), IN p_ip VARCHAR(45), IN p_action VARCHAR(50),
  IN p_object_type VARCHAR(30), IN p_object_code VARCHAR(50), IN p_result VARCHAR(20), IN p_details JSON,
  OUT p_seq BIGINT UNSIGNED)
BEGIN
  DECLARE v_seq BIGINT UNSIGNED;
  DECLARE v_hash CHAR(64);
  DECLARE v_time DATETIME(3);
  SELECT last_seq, last_hash INTO v_seq, v_hash FROM audit_chain_head WHERE id = 1 FOR UPDATE;
  SET v_seq = v_seq + 1, v_time = UTC_TIMESTAMP(3);
  INSERT INTO audit_logs (seq, occurred_at, user_id, roles, ip_address, action, object_type, object_code, result, details, prev_hash, hash)
  VALUES (v_seq, v_time, p_user_id, p_roles, p_ip, p_action, p_object_type, p_object_code, p_result, p_details, v_hash,
    fn_audit_hash(v_hash, v_seq, v_time, p_user_id, p_roles, p_ip, p_action, p_object_type, p_object_code, p_result, p_details));
  SET p_seq = v_seq;
END$$

-- Kiểm tra toàn vẹn nhật ký từ p_from đến p_to (BM19); dừng ở sai lệch đầu tiên
CREATE PROCEDURE sp_verify_audit_chain(
  IN p_from BIGINT UNSIGNED, IN p_to BIGINT UNSIGNED,
  OUT p_checked BIGINT UNSIGNED, OUT p_result VARCHAR(10),
  OUT p_bad_seq BIGINT UNSIGNED, OUT p_issue VARCHAR(20), OUT p_last_hash CHAR(64))
BEGIN
  DECLARE v_done INT DEFAULT 0;
  DECLARE v_expected BIGINT UNSIGNED;
  DECLARE v_prev CHAR(64);
  DECLARE v_head_seq BIGINT UNSIGNED;
  DECLARE v_head_hash CHAR(64);
  DECLARE v_to BIGINT UNSIGNED;
  DECLARE c_seq BIGINT UNSIGNED;
  DECLARE c_time DATETIME(3);
  DECLARE c_user BIGINT UNSIGNED;
  DECLARE c_roles VARCHAR(100);
  DECLARE c_ip VARCHAR(45);
  DECLARE c_action VARCHAR(50);
  DECLARE c_otype VARCHAR(30);
  DECLARE c_ocode VARCHAR(50);
  DECLARE c_result VARCHAR(20);
  DECLARE c_details JSON;
  DECLARE c_prev CHAR(64);
  DECLARE c_hash CHAR(64);
  DECLARE cur CURSOR FOR
    SELECT seq, occurred_at, user_id, roles, ip_address, action, object_type, object_code, result, details, prev_hash, hash
    FROM audit_logs WHERE seq BETWEEN p_from AND v_to ORDER BY seq;
  DECLARE CONTINUE HANDLER FOR NOT FOUND SET v_done = 1;

  SELECT last_seq, last_hash INTO v_head_seq, v_head_hash FROM audit_chain_head WHERE id = 1;
  SET v_to = LEAST(p_to, v_head_seq);
  SET p_checked = 0, p_result = 'INTACT', p_bad_seq = NULL, p_issue = NULL, v_expected = p_from;
  IF p_from = 1 THEN
    SELECT genesis_hash INTO v_prev FROM audit_chain_head WHERE id = 1;
  ELSE
    SELECT hash INTO v_prev FROM audit_logs WHERE seq = p_from - 1;
    IF v_prev IS NULL THEN
      SELECT prev_hash INTO v_prev FROM audit_logs WHERE seq = p_from;
    END IF;
  END IF;
  SET p_last_hash = v_prev;

  OPEN cur;
  read_loop: LOOP
    FETCH cur INTO c_seq, c_time, c_user, c_roles, c_ip, c_action, c_otype, c_ocode, c_result, c_details, c_prev, c_hash;
    IF v_done = 1 THEN LEAVE read_loop; END IF;
    IF c_seq <> v_expected THEN
      SET p_result = 'TAMPERED', p_bad_seq = v_expected, p_issue = 'MISSING_RECORD';
      LEAVE read_loop;
    END IF;
    IF c_prev <> v_prev OR c_hash <> fn_audit_hash(v_prev, c_seq, c_time, c_user, c_roles, c_ip, c_action, c_otype, c_ocode, c_result, c_details) THEN
      SET p_result = 'TAMPERED', p_bad_seq = c_seq, p_issue = 'HASH_MISMATCH';
      LEAVE read_loop;
    END IF;
    SET p_checked = p_checked + 1, v_prev = c_hash, p_last_hash = c_hash, v_expected = v_expected + 1;
  END LOOP;
  CLOSE cur;

  -- Bản ghi cuối phạm vi bị xóa
  IF p_result = 'INTACT' AND v_expected <= v_to THEN
    SET p_result = 'TAMPERED', p_bad_seq = v_expected, p_issue = 'MISSING_RECORD';
  END IF;
  -- Phạm vi chạm cuối chuỗi: đối chiếu với đầu chuỗi
  IF p_result = 'INTACT' AND v_to = v_head_seq AND p_last_hash <> v_head_hash THEN
    SET p_result = 'TAMPERED', p_bad_seq = v_head_seq, p_issue = 'HASH_MISMATCH';
  END IF;
END$$

-- Cấp số thứ tự tiếp theo cho mã nghiệp vụ; gọi trong giao dịch tạo đối tượng (rollback thì số không bị tiêu)
CREATE PROCEDURE sp_next_code_number(IN p_prefix VARCHAR(30), OUT p_value INT UNSIGNED)
BEGIN
  INSERT INTO code_counters (prefix, counter_value) VALUES (p_prefix, 1)
    ON DUPLICATE KEY UPDATE counter_value = counter_value + 1;
  SELECT counter_value INTO p_value FROM code_counters WHERE prefix = p_prefix;
END$$

DELIMITER ;

-- Quyền hiệu lực của từng người dùng (vai trò còn hiệu lực, tài khoản hoạt động), lấy phạm vi rộng nhất
CREATE VIEW v_user_permissions AS
SELECT ur.user_id, rp.permission_code, ELT(MAX(rp.scope + 0), 'OWN', 'DEPARTMENT', 'ALL') AS scope
FROM user_roles ur
JOIN users u ON u.id = ur.user_id AND u.status = 'ACTIVE'
JOIN role_permissions rp ON rp.role_id = ur.role_id
WHERE ur.revoked_at IS NULL
GROUP BY ur.user_id, rp.permission_code;


-- TRIGGER – LỚP BẢO VỆ THỨ HAI TẠI CSDL

DELIMITER $$

-- ---------- Chặn xóa ở mọi bảng nghiệp vụ ----------
CREATE TRIGGER trg_departments_no_delete BEFORE DELETE ON departments FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Khong duoc xoa phong ban'$$
CREATE TRIGGER trg_users_no_delete BEFORE DELETE ON users FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Khong duoc xoa tai khoan'$$
CREATE TRIGGER trg_user_roles_no_delete BEFORE DELETE ON user_roles FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Thu hoi vai tro bang danh dau, khong xoa'$$
CREATE TRIGGER trg_record_groups_no_delete BEFORE DELETE ON record_groups FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Khong duoc xoa nhom ho so'$$
CREATE TRIGGER trg_retention_labels_no_delete BEFORE DELETE ON retention_labels FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Khong duoc xoa nhan'$$
CREATE TRIGGER trg_label_versions_no_delete BEFORE DELETE ON label_versions FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Khong duoc xoa phien ban nhan'$$
CREATE TRIGGER trg_document_types_no_delete BEFORE DELETE ON document_types FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Khong duoc xoa loai tai lieu'$$
-- Chỉ được bỏ loại tài liệu khỏi phiên bản đang Nháp (BM02 phần C được sửa khi Nháp); đã gửi duyệt thì khóa
CREATE TRIGGER trg_lvdt_no_delete BEFORE DELETE ON label_version_document_types FOR EACH ROW
BEGIN
  IF (SELECT status FROM label_versions WHERE id = OLD.label_version_id) <> 'DRAFT' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Khong duoc xoa lich su ap dung nhan';
  END IF;
END$$
CREATE TRIGGER trg_lvdt_no_update BEFORE UPDATE ON label_version_document_types FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Khong duoc sua lich su ap dung nhan'$$
CREATE TRIGGER trg_records_no_delete BEFORE DELETE ON records FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Ho so khong duoc phep xoa'$$
CREATE TRIGGER trg_files_no_delete BEFORE DELETE ON files FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Khong duoc xoa file'$$
CREATE TRIGGER trg_file_versions_no_delete BEFORE DELETE ON file_versions FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Khong duoc xoa phien ban file'$$
CREATE TRIGGER trg_extension_requests_no_delete BEFORE DELETE ON extension_requests FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Khong duoc xoa de xuat gia han'$$
CREATE TRIGGER trg_legal_holds_no_delete BEFORE DELETE ON legal_holds FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Khong duoc xoa lenh phong toa'$$
CREATE TRIGGER trg_legal_hold_records_no_delete BEFORE DELETE ON legal_hold_records FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Khong duoc xoa lenh phong toa'$$
CREATE TRIGGER trg_disposal_batches_no_delete BEFORE DELETE ON disposal_batches FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Khong duoc xoa dot huy'$$
CREATE TRIGGER trg_dbr_no_delete BEFORE DELETE ON disposal_batch_records FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Khong duoc xoa danh muc dot huy'$$
CREATE TRIGGER trg_certificates_no_delete BEFORE DELETE ON disposal_certificates FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Bien ban khong duoc phep xoa'$$
CREATE TRIGGER trg_certificates_no_update BEFORE UPDATE ON disposal_certificates FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Bien ban khong duoc phep sua'$$
CREATE TRIGGER trg_audit_logs_no_delete BEFORE DELETE ON audit_logs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Nhat ky khong duoc phep xoa'$$
CREATE TRIGGER trg_audit_logs_no_update BEFORE UPDATE ON audit_logs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Nhat ky khong duoc phep sua'$$
CREATE TRIGGER trg_audit_chain_head_no_delete BEFORE DELETE ON audit_chain_head FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Khong duoc xoa dau chuoi'$$
CREATE TRIGGER trg_integrity_checks_no_delete BEFORE DELETE ON integrity_checks FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Khong duoc xoa ket qua kiem tra'$$
CREATE TRIGGER trg_integrity_checks_no_update BEFORE UPDATE ON integrity_checks FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Khong duoc sua ket qua kiem tra'$$
CREATE TRIGGER trg_system_settings_no_delete BEFORE DELETE ON system_settings FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Khong duoc xoa tham so'$$

-- ---------- A. Tổ chức và tài khoản ----------
CREATE TRIGGER trg_departments_update BEFORE UPDATE ON departments FOR EACH ROW
BEGIN
  IF NEW.code <> OLD.code THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Khong duoc sua ma phong ban';
  END IF;
  -- Không tạo vòng lặp trong cây phòng ban
  IF NEW.parent_id IS NOT NULL AND NOT (NEW.parent_id <=> OLD.parent_id) THEN
    IF NEW.parent_id = NEW.id OR EXISTS (
      WITH RECURSIVE subtree (id) AS (
        SELECT id FROM departments WHERE parent_id = NEW.id
        UNION ALL SELECT d.id FROM departments d JOIN subtree s ON d.parent_id = s.id)
      SELECT 1 FROM subtree WHERE subtree.id = NEW.parent_id) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Cay phong ban bi vong lap';
    END IF;
  END IF;
END$$

-- Tài khoản do Quản trị viên tạo; NULL chỉ khi hệ thống chưa có quản trị viên nào (khởi tạo lần đầu)
CREATE TRIGGER trg_users_insert BEFORE INSERT ON users FOR EACH ROW
BEGIN
  IF NEW.created_by IS NULL THEN
    IF EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
               WHERE r.code = 'SYSTEM_ADMIN' AND ur.revoked_at IS NULL) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Tai khoan phai do Quan tri vien tao';
    END IF;
  ELSEIF NOT fn_has_role(NEW.created_by, 'SYSTEM_ADMIN') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Tai khoan phai do Quan tri vien tao';
  END IF;
  IF NEW.status <> 'ACTIVE' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Tai khoan moi phai o trang thai hoat dong';
  END IF;
END$$

CREATE TRIGGER trg_users_update BEFORE UPDATE ON users FOR EACH ROW
BEGIN
  IF NEW.email <> OLD.email OR NOT (NEW.created_by <=> OLD.created_by) OR NEW.created_at <> OLD.created_at THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Khong duoc sua email hoac nguoi tao';
  END IF;
  -- Khóa tài khoản: chỉ Quản trị viên, không khóa chính mình
  IF NEW.status = 'LOCKED' AND OLD.status = 'ACTIVE'
     AND (NEW.locked_by = NEW.id OR NOT fn_has_role(NEW.locked_by, 'SYSTEM_ADMIN')) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Chi Quan tri vien duoc khoa tai khoan nguoi khac';
  END IF;
END$$

-- Quy tắc gán vai trò: QT không kiêm TP/CBLT/GĐ; mỗi phòng 1 TP; toàn doanh nghiệp 1 GĐ (đang hiệu lực)
CREATE PROCEDURE sp_check_role_rules(IN p_row_id BIGINT UNSIGNED, IN p_user_id BIGINT UNSIGNED, IN p_role_id TINYINT UNSIGNED)
BEGIN
  DECLARE v_code VARCHAR(20);
  DECLARE v_department BIGINT UNSIGNED;
  SELECT code INTO v_code FROM roles WHERE id = p_role_id;
  SELECT department_id INTO v_department FROM users WHERE id = p_user_id;
  IF v_code = 'SYSTEM_ADMIN' AND EXISTS (
    SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
    WHERE ur.user_id = p_user_id AND ur.revoked_at IS NULL AND ur.id <> p_row_id
      AND r.code IN ('DEPARTMENT_HEAD','RECORDS_OFFICER','DIRECTOR')) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Quan tri khong duoc kiem TP, CBLT hoac GD';
  END IF;
  IF v_code IN ('DEPARTMENT_HEAD','RECORDS_OFFICER','DIRECTOR') AND EXISTS (
    SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
    WHERE ur.user_id = p_user_id AND ur.revoked_at IS NULL AND ur.id <> p_row_id AND r.code = 'SYSTEM_ADMIN') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Quan tri khong duoc kiem TP, CBLT hoac GD';
  END IF;
  IF v_code = 'DEPARTMENT_HEAD' AND EXISTS (
    SELECT 1 FROM user_roles ur JOIN users u ON u.id = ur.user_id
    WHERE ur.role_id = p_role_id AND ur.revoked_at IS NULL AND ur.id <> p_row_id AND ur.user_id <> p_user_id
      AND u.department_id = v_department AND u.status = 'ACTIVE') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Phong ban da co Truong phong';
  END IF;
  IF v_code = 'DIRECTOR' AND EXISTS (
    SELECT 1 FROM user_roles ur JOIN users u ON u.id = ur.user_id
    WHERE ur.role_id = p_role_id AND ur.revoked_at IS NULL AND ur.id <> p_row_id AND ur.user_id <> p_user_id
      AND u.status = 'ACTIVE') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Doanh nghiep da co Giam doc';
  END IF;
END$$

-- Người gán phải là Quản trị viên. Ngoại lệ duy nhất: gán vai trò Quản trị cho tài khoản đầu tiên khi chưa có quản trị viên nào.
CREATE TRIGGER trg_user_roles_insert BEFORE INSERT ON user_roles FOR EACH ROW
BEGIN
  DECLARE v_code VARCHAR(20);
  SELECT code INTO v_code FROM roles WHERE id = NEW.role_id;
  IF NEW.revoked_at IS NOT NULL OR NEW.revoked_by IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Vai tro moi gan phai dang hieu luc';
  END IF;
  IF NEW.granted_by IS NULL THEN
    IF v_code <> 'SYSTEM_ADMIN' OR EXISTS (
      SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
      WHERE r.code = 'SYSTEM_ADMIN' AND ur.revoked_at IS NULL) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Vai tro phai do Quan tri vien gan';
    END IF;
  ELSEIF NOT fn_has_role(NEW.granted_by, 'SYSTEM_ADMIN') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Vai tro phai do Quan tri vien gan';
  END IF;
  CALL sp_check_role_rules(0, NEW.user_id, NEW.role_id);
END$$

-- Chỉ được thu hồi (một lần), người thu hồi phải là Quản trị viên
CREATE TRIGGER trg_user_roles_update BEFORE UPDATE ON user_roles FOR EACH ROW
BEGIN
  IF NEW.user_id <> OLD.user_id OR NEW.role_id <> OLD.role_id OR NOT (NEW.granted_by <=> OLD.granted_by)
     OR NEW.granted_at <> OLD.granted_at OR OLD.revoked_at IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Gan vai tro chi duoc thu hoi mot lan';
  END IF;
  IF NOT fn_has_role(NEW.revoked_by, 'SYSTEM_ADMIN') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Chi Quan tri vien duoc thu hoi vai tro';
  END IF;
END$$

-- Phiên đăng nhập: chỉ được thu hồi và cập nhật lần hoạt động cuối
CREATE TRIGGER trg_login_sessions_update BEFORE UPDATE ON login_sessions FOR EACH ROW
BEGIN
  IF NEW.user_id <> OLD.user_id OR NEW.created_at <> OLD.created_at OR NEW.expires_at <> OLD.expires_at
     OR (OLD.revoked_at IS NOT NULL AND NOT (NEW.revoked_at <=> OLD.revoked_at)) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Phien chi duoc thu hoi';
  END IF;
END$$

-- ---------- B. Chính sách lưu trữ ----------
CREATE TRIGGER trg_record_groups_update BEFORE UPDATE ON record_groups FOR EACH ROW
BEGIN
  IF NEW.code <> OLD.code THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Khong duoc sua ma nhom';
  END IF;
END$$

CREATE TRIGGER trg_retention_labels_update BEFORE UPDATE ON retention_labels FOR EACH ROW
BEGIN
  IF NEW.code <> OLD.code OR NEW.group_id <> OLD.group_id THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Khong duoc sua ma nhan hoac nhom cua nhan';
  END IF;
END$$

CREATE TRIGGER trg_label_versions_update BEFORE UPDATE ON label_versions FOR EACH ROW
BEGIN
  -- Chuyển trạng thái theo sơ đồ trạng thái phiên bản nhãn
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'DRAFT' AND NEW.status = 'PENDING')
    OR (OLD.status = 'PENDING' AND NEW.status IN ('DRAFT','REJECTED'))
    OR (OLD.status = 'PENDING' AND NEW.status = 'ACTIVE' AND OLD.proposal_type <> 'DEACTIVATE')
    OR (OLD.status = 'PENDING' AND NEW.status = 'RETIRED' AND OLD.proposal_type = 'DEACTIVATE')
    OR (OLD.status = 'REJECTED' AND NEW.status = 'DRAFT')
    OR (OLD.status = 'ACTIVE' AND NEW.status = 'RETIRED')) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Chuyen trang thai phien ban nhan khong hop le';
  END IF;
  -- Nội dung bị khóa từ khi gửi duyệt (chỉ sửa ở Nháp)
  IF OLD.status <> 'DRAFT' AND (
    NEW.label_id <> OLD.label_id OR NEW.version_no <> OLD.version_no OR NEW.proposal_type <> OLD.proposal_type
    OR NEW.label_name <> OLD.label_name OR NEW.retention_type <> OLD.retention_type
    OR NOT (NEW.retention_years <=> OLD.retention_years) OR NOT (NEW.start_trigger <=> OLD.start_trigger)
    OR NOT (NEW.event_name <=> OLD.event_name) OR NOT (NEW.warning_days <=> OLD.warning_days)
    OR NEW.contains_personal_data <> OLD.contains_personal_data OR NEW.legal_basis <> OLD.legal_basis
    OR NEW.proposal_reason <> OLD.proposal_reason OR NEW.created_by <> OLD.created_by) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Noi dung phien ban nhan da khoa';
  END IF;
END$$

CREATE TRIGGER trg_lvdt_insert BEFORE INSERT ON label_version_document_types FOR EACH ROW
BEGIN
  IF (SELECT status FROM label_versions WHERE id = NEW.label_version_id) <> 'DRAFT' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Chi them loai tai lieu khi phien ban o Nhap';
  END IF;
  IF (SELECT group_id FROM document_types WHERE id = NEW.document_type_id) <>
     (SELECT l.group_id FROM label_versions v JOIN retention_labels l ON l.id = v.label_id WHERE v.id = NEW.label_version_id) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Loai tai lieu phai cung nhom voi nhan';
  END IF;
END$$

CREATE TRIGGER trg_document_types_insert BEFORE INSERT ON document_types FOR EACH ROW
BEGIN
  IF NEW.current_label_version_id IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Loai moi chua gan nhan; gan qua de xuat nhan';
  END IF;
END$$

CREATE TRIGGER trg_document_types_update BEFORE UPDATE ON document_types FOR EACH ROW
BEGIN
  IF NEW.code <> OLD.code THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Khong duoc sua ma loai';
  END IF;
  IF NEW.group_id <> OLD.group_id AND EXISTS (SELECT 1 FROM label_version_document_types WHERE document_type_id = OLD.id) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Loai da gan nhan khong duoc doi nhom';
  END IF;
  -- Lối tắt chỉ trỏ tới phiên bản đang hiệu lực có chứa loại này
  IF NEW.current_label_version_id IS NOT NULL AND NOT (NEW.current_label_version_id <=> OLD.current_label_version_id)
     AND NOT EXISTS (SELECT 1 FROM label_versions v JOIN label_version_document_types x ON x.label_version_id = v.id
                     WHERE v.id = NEW.current_label_version_id AND v.status = 'ACTIVE' AND x.document_type_id = NEW.id) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Chi gan loai vao phien ban nhan dang hieu luc co chua loai nay';
  END IF;
END$$

-- ---------- C. Hồ sơ và file ----------
CREATE TRIGGER trg_records_insert BEFORE INSERT ON records FOR EACH ROW
BEGIN
  IF NEW.status <> 'IN_USE' OR NEW.label_version_id IS NOT NULL OR NEW.expiry_date IS NOT NULL
     OR NEW.is_on_hold OR NEW.is_disposal_eligible THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Ho so moi phai o trang thai Dang su dung';
  END IF;
  IF NEW.document_date > fn_today_vn() OR NEW.event_end_date > fn_today_vn() THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Ngay khong duoc lon hon ngay hien tai';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM document_types WHERE id = NEW.document_type_id
                 AND status = 'ACTIVE' AND current_label_version_id IS NOT NULL) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Loai tai lieu chua gan nhan dang hieu luc';
  END IF;
END$$

CREATE TRIGGER trg_records_update BEFORE UPDATE ON records FOR EACH ROW
BEGIN
  DECLARE v_personal BOOLEAN DEFAULT FALSE;

  -- 1. Trạng thái cuối: không thay đổi được nữa
  IF OLD.status IN ('DISPOSED','CANCELLED') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Ho so da o trang thai cuoi';
  END IF;

  -- 2. Chỉ các cặp chuyển trạng thái trong sơ đồ trạng thái hồ sơ
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'IN_USE' AND NEW.status IN ('PENDING_ARCHIVE','CANCELLED'))
    OR (OLD.status = 'PENDING_ARCHIVE' AND NEW.status IN ('IN_USE','ARCHIVED'))
    OR (OLD.status = 'ARCHIVED' AND NEW.status = 'EXPIRED')
    OR (OLD.status = 'EXPIRED' AND NEW.status IN ('ARCHIVED','PENDING_DISPOSAL'))
    OR (OLD.status = 'PENDING_DISPOSAL' AND NEW.status IN ('EXPIRED','DISPOSED'))) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Chuyen trang thai ho so khong hop le';
  END IF;

  -- 3. Trường không bao giờ đổi
  IF NEW.code <> OLD.code OR NEW.department_id <> OLD.department_id
     OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Khong duoc sua ma, phong ban, nguoi tao, ngay tao';
  END IF;

  -- 4. Từ khi gửi lưu trữ: nội dung khai báo bị khóa.
  --    Ngoại lệ: khi hủy hồ sơ có dữ liệu cá nhân, được che tiêu đề, xóa mô tả và nội dung sự kiện.
  IF OLD.status <> 'IN_USE' THEN
    IF NEW.document_type_id <> OLD.document_type_id OR NEW.document_date <> OLD.document_date THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Noi dung ho so da khoa';
    END IF;
    IF NEW.title <> OLD.title OR NOT (NEW.description <=> OLD.description)
       OR (NOT (NEW.event_note <=> OLD.event_note) AND OLD.event_note IS NOT NULL) THEN
      SELECT v.contains_personal_data INTO v_personal FROM label_versions v WHERE v.id = OLD.label_version_id;
      IF NOT (OLD.status = 'PENDING_DISPOSAL' AND NEW.status = 'DISPOSED' AND v_personal
              AND (NEW.title = OLD.title OR NEW.title = OLD.code)
              AND (NEW.description <=> OLD.description OR NEW.description IS NULL)
              AND (NEW.event_note <=> OLD.event_note OR NEW.event_note IS NULL)) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Noi dung ho so da khoa';
      END IF;
    END IF;
  END IF;

  -- 5. Chính sách: chỉ gắn khi duyệt lưu trữ, sau đó không đổi
  IF NOT (NEW.label_version_id <=> OLD.label_version_id) THEN
    IF NOT (OLD.status = 'PENDING_ARCHIVE' AND NEW.status = 'ARCHIVED' AND OLD.label_version_id IS NULL) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Chinh sach chi gan khi duyet luu tru va khong doi';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM document_types WHERE id = NEW.document_type_id AND current_label_version_id = NEW.label_version_id) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Phai gan phien ban nhan dang hieu luc cua loai tai lieu';
    END IF;
  END IF;

  -- 6. Sau khi gửi lưu trữ, hiệu lực nghiệp vụ chỉ đổi Còn -> Hết một lần, khi hồ sơ đang Lưu trữ
  IF OLD.status <> 'IN_USE'
     AND (NEW.validity <> OLD.validity OR NOT (NEW.event_end_date <=> OLD.event_end_date)
          OR (NEW.event_note IS NOT NULL AND OLD.event_note IS NULL)) THEN
    IF NOT (OLD.status = 'ARCHIVED' AND NEW.status = 'ARCHIVED'
            AND OLD.validity = 'VALID' AND NEW.validity = 'ENDED'
            AND NEW.event_note IS NOT NULL AND NEW.ended_marked_by IS NOT NULL
            AND (NEW.event_end_date <=> OLD.event_end_date
                 OR (OLD.event_end_date IS NULL AND NEW.event_end_date <= fn_today_vn()))) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Danh dau het hieu luc khong hop le';
    END IF;
  END IF;

  -- 7. Mốc tính: đã có thì không đổi
  IF OLD.retention_start_date IS NOT NULL AND NOT (NEW.retention_start_date <=> OLD.retention_start_date) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Khong duoc doi moc tinh';
  END IF;

  -- 8. Ngày hết hạn
  IF NOT (NEW.expiry_date <=> OLD.expiry_date) THEN
    IF NEW.expiry_date IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Khong duoc xoa ngay het han';
    ELSEIF OLD.expiry_date IS NULL THEN
      -- Xác định lần đầu: khi duyệt lưu trữ, hoặc khi đánh dấu hết hiệu lực (nhãn theo sự kiện)
      IF NOT ((OLD.status = 'PENDING_ARCHIVE' AND NEW.status = 'ARCHIVED')
              OR (OLD.status = 'ARCHIVED' AND OLD.validity = 'VALID' AND NEW.validity = 'ENDED'))
         OR NEW.retention_start_date IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Ngay het han chi xac dinh khi duyet hoac danh dau het hieu luc';
      END IF;
    ELSE
      -- Gia hạn: Hết hạn -> Lưu trữ, chỉ tăng, khớp đề xuất đã duyệt
      IF NOT (OLD.status = 'EXPIRED' AND NEW.status = 'ARCHIVED' AND NEW.expiry_date > OLD.expiry_date
              AND EXISTS (SELECT 1 FROM extension_requests e WHERE e.record_id = OLD.id AND e.status = 'APPROVED'
                          AND e.old_expiry_date = OLD.expiry_date AND e.new_expiry_date = NEW.expiry_date)) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Ngay het han chi doi qua gia han da duoc duyet';
      END IF;
    END IF;
  END IF;
  IF OLD.status = 'EXPIRED' AND NEW.status = 'ARCHIVED' AND NEW.expiry_date <=> OLD.expiry_date THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Ho so ve Luu tru chi qua gia han';
  END IF;

  -- 9. Lưu trữ -> Hết hạn: chỉ khi đã đến hạn
  IF OLD.status = 'ARCHIVED' AND NEW.status = 'EXPIRED' AND (NEW.expiry_date IS NULL OR NEW.expiry_date > fn_today_vn()) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Ho so chua den han';
  END IF;

  -- 10. Dấu đủ điều kiện hủy: chỉ đặt khi Hết hạn, không phong tỏa (CHECK), không chờ gia hạn
  IF NEW.is_disposal_eligible AND NOT OLD.is_disposal_eligible
     AND (NEW.status <> 'EXPIRED' OR EXISTS (SELECT 1 FROM extension_requests WHERE record_id = OLD.id AND status = 'PENDING')) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Khong du dieu kien danh dau huy';
  END IF;

  -- 11. Hết hạn -> Chờ duyệt hủy: có dấu, không phong tỏa, nằm trong đợt đang được gửi
  IF OLD.status = 'EXPIRED' AND NEW.status = 'PENDING_DISPOSAL'
     AND (NOT NEW.is_disposal_eligible OR NEW.is_on_hold
          OR NOT EXISTS (SELECT 1 FROM disposal_batch_records x JOIN disposal_batches b ON b.id = x.batch_id
                         WHERE x.record_id = OLD.id AND x.item_status = 'INCLUDED' AND b.status IN ('DRAFT','PENDING_LEVEL_1'))) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Ho so khong du dieu kien vao dot huy';
  END IF;

  -- 12. -> Đã hủy: CHỈ khi đợt đã duyệt 2 cấp, hết thời gian chờ, không phong tỏa, mọi khóa đã bị xóa
  IF NEW.status = 'DISPOSED' AND (NEW.is_on_hold OR NOT EXISTS (
       SELECT 1 FROM disposal_batch_records x JOIN disposal_batches b ON b.id = x.batch_id
       WHERE x.record_id = OLD.id AND x.item_status = 'INCLUDED' AND b.status = 'APPROVED'
         AND b.scheduled_at <= UTC_TIMESTAMP(3))) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Chi huy qua dot da phe duyet va het thoi gian cho';
  END IF;
  IF NEW.status IN ('DISPOSED','CANCELLED') AND EXISTS (
       SELECT 1 FROM files f JOIN file_versions fv ON fv.file_id = f.id
       WHERE f.record_id = OLD.id AND fv.wrapped_key IS NOT NULL) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Phai xoa khoa du lieu cua moi phien ban truoc';
  END IF;
END$$

CREATE TRIGGER trg_files_insert BEFORE INSERT ON files FOR EACH ROW
BEGIN
  IF (SELECT status FROM records WHERE id = NEW.record_id) <> 'IN_USE' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Chi them file khi ho so Dang su dung';
  END IF;
END$$

CREATE TRIGGER trg_files_update BEFORE UPDATE ON files FOR EACH ROW
BEGIN
  DECLARE v_status VARCHAR(20);
  SELECT status INTO v_status FROM records WHERE id = OLD.record_id;
  IF NEW.record_id <> OLD.record_id OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at
     OR (NEW.is_active <> OLD.is_active AND v_status <> 'IN_USE')
     OR (NEW.original_name <> OLD.original_name AND v_status <> 'DISPOSED') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'File cua ho so da khoa';
  END IF;
END$$

CREATE TRIGGER trg_file_versions_insert BEFORE INSERT ON file_versions FOR EACH ROW
BEGIN
  IF (SELECT r.status FROM files f JOIN records r ON r.id = f.record_id WHERE f.id = NEW.file_id) <> 'IN_USE' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Chi tai file khi ho so Dang su dung';
  END IF;
  IF NEW.wrapped_key IS NULL OR NEW.is_purged THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Phien ban file moi phai co khoa du lieu';
  END IF;
END$$

CREATE TRIGGER trg_file_versions_update BEFORE UPDATE ON file_versions FOR EACH ROW
BEGIN
  DECLARE v_record BIGINT UNSIGNED;
  DECLARE v_status VARCHAR(20);
  -- Chỉ được: xóa khóa (hủy bằng mật mã) và đánh dấu đã xóa bản mã
  IF NEW.file_id <> OLD.file_id OR NEW.version_no <> OLD.version_no OR NEW.storage_name <> OLD.storage_name
     OR NEW.format <> OLD.format OR NEW.size_bytes <> OLD.size_bytes OR NEW.sha256 <> OLD.sha256
     OR NEW.iv <> OLD.iv OR NEW.auth_tag <> OLD.auth_tag OR NEW.uploaded_by <> OLD.uploaded_by
     OR NEW.uploaded_at <> OLD.uploaded_at
     OR (NEW.wrapped_key IS NOT NULL AND NOT (NEW.wrapped_key <=> OLD.wrapped_key))
     OR (OLD.is_purged AND NOT NEW.is_purged) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Phien ban file chi duoc xoa khoa hoac danh dau da xoa';
  END IF;
  -- Xóa khóa chỉ khi: hủy bỏ hồ sơ tạo nhầm (Đang sử dụng), hoặc hồ sơ thuộc đợt đã duyệt và hết thời gian chờ
  IF OLD.wrapped_key IS NOT NULL AND NEW.wrapped_key IS NULL THEN
    SELECT r.id, r.status INTO v_record, v_status FROM files f JOIN records r ON r.id = f.record_id WHERE f.id = OLD.file_id;
    IF NOT (v_status = 'IN_USE'
            OR (v_status = 'PENDING_DISPOSAL' AND EXISTS (
                  SELECT 1 FROM disposal_batch_records x JOIN disposal_batches b ON b.id = x.batch_id JOIN records r ON r.id = x.record_id
                  WHERE x.record_id = v_record AND x.item_status = 'INCLUDED' AND b.status = 'APPROVED'
                    AND b.scheduled_at <= UTC_TIMESTAMP(3) AND NOT r.is_on_hold))) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Khong duoc xoa khoa ngoai dot huy da phe duyet';
    END IF;
  END IF;
END$$

-- ---------- D. Gia hạn ----------
CREATE TRIGGER trg_extension_requests_insert BEFORE INSERT ON extension_requests FOR EACH ROW
BEGIN
  DECLARE v_status VARCHAR(20);
  DECLARE v_expiry DATE;
  DECLARE v_max_years INT;
  SELECT status, expiry_date INTO v_status, v_expiry FROM records WHERE id = NEW.record_id;
  SELECT CAST(value AS UNSIGNED) INTO v_max_years FROM system_settings WHERE setting_key = 'MAX_EXTENSION_YEARS';
  IF NEW.status <> 'PENDING' OR v_status <> 'EXPIRED' OR NOT (NEW.old_expiry_date <=> v_expiry) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Chi de xuat gia han cho ho so Het han';
  END IF;
  IF EXISTS (SELECT 1 FROM disposal_batch_records WHERE record_id = NEW.record_id AND item_status = 'INCLUDED') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Ho so dang nam trong dot huy';
  END IF;
  IF NEW.new_expiry_date <= fn_today_vn() OR NEW.new_expiry_date > fn_today_vn() + INTERVAL v_max_years YEAR THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Ngay het han moi ngoai gioi han cho phep';
  END IF;
END$$

-- Lập đề xuất thì bỏ dấu đủ điều kiện hủy
CREATE TRIGGER trg_extension_requests_after_insert AFTER INSERT ON extension_requests FOR EACH ROW
BEGIN
  UPDATE records SET is_disposal_eligible = FALSE, eligible_marked_by = NULL, eligible_marked_at = NULL
  WHERE id = NEW.record_id AND is_disposal_eligible;
END$$

CREATE TRIGGER trg_extension_requests_update BEFORE UPDATE ON extension_requests FOR EACH ROW
BEGIN
  IF NOT (OLD.status = 'PENDING' AND NEW.status IN ('APPROVED','REJECTED'))
     OR NEW.record_id <> OLD.record_id OR NEW.old_expiry_date <> OLD.old_expiry_date
     OR NEW.new_expiry_date <> OLD.new_expiry_date OR NEW.reason <> OLD.reason
     OR NEW.requested_by <> OLD.requested_by OR NEW.code <> OLD.code THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'De xuat gia han chi duoc duyet hoac tu choi mot lan';
  END IF;
END$$

-- ---------- D. Phong tỏa: cờ trên hồ sơ do trigger đồng bộ ----------
CREATE TRIGGER trg_legal_holds_update BEFORE UPDATE ON legal_holds FOR EACH ROW
BEGIN
  IF NEW.code <> OLD.code OR NEW.reason <> OLD.reason OR NEW.legal_basis <> OLD.legal_basis
     OR NEW.placed_by <> OLD.placed_by OR NEW.placed_at <> OLD.placed_at
     OR NOT (NEW.evidence_storage_name <=> OLD.evidence_storage_name) OR NOT (NEW.evidence_wrapped_key <=> OLD.evidence_wrapped_key) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Lenh phong toa khong duoc sua';
  END IF;
END$$

CREATE TRIGGER trg_legal_hold_records_insert BEFORE INSERT ON legal_hold_records FOR EACH ROW
BEGIN
  IF NEW.status <> 'ACTIVE'
     OR (SELECT status FROM records WHERE id = NEW.record_id) NOT IN ('ARCHIVED','EXPIRED','PENDING_DISPOSAL') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Chi phong toa ho so Luu tru, Het han hoac Cho duyet huy';
  END IF;
END$$

CREATE TRIGGER trg_legal_hold_records_after_insert AFTER INSERT ON legal_hold_records FOR EACH ROW
BEGIN
  UPDATE records SET is_on_hold = TRUE, is_disposal_eligible = FALSE, eligible_marked_by = NULL, eligible_marked_at = NULL
  WHERE id = NEW.record_id;
END$$

CREATE TRIGGER trg_legal_hold_records_update BEFORE UPDATE ON legal_hold_records FOR EACH ROW
BEGIN
  IF NOT (OLD.status = 'ACTIVE' AND NEW.status = 'RELEASED')
     OR NEW.legal_hold_id <> OLD.legal_hold_id OR NEW.record_id <> OLD.record_id THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Chi duoc go phong toa mot lan';
  END IF;
END$$

CREATE TRIGGER trg_legal_hold_records_after_update AFTER UPDATE ON legal_hold_records FOR EACH ROW
BEGIN
  UPDATE records SET is_on_hold = FALSE WHERE id = NEW.record_id;
END$$

-- ---------- D. Đợt hủy ----------
CREATE TRIGGER trg_disposal_batches_insert BEFORE INSERT ON disposal_batches FOR EACH ROW
BEGIN
  IF NEW.status <> 'DRAFT' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Dot moi phai o Nhap';
  END IF;
END$$

CREATE TRIGGER trg_disposal_batches_update BEFORE UPDATE ON disposal_batches FOR EACH ROW
BEGIN
  DECLARE v_included INT;
  IF OLD.status IN ('COMPLETED','CANCELLED') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Dot huy da o trang thai cuoi';
  END IF;
  IF NEW.code <> OLD.code OR NEW.department_id <> OLD.department_id OR NEW.created_by <> OLD.created_by THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Khong duoc sua ma, phong ban, nguoi lap cua dot';
  END IF;
  IF NEW.reason <> OLD.reason AND OLD.status <> 'DRAFT' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Chi sua dot o trang thai Nhap';
  END IF;
  IF NEW.status <> OLD.status THEN
    IF NOT (
      (OLD.status = 'DRAFT' AND NEW.status IN ('PENDING_LEVEL_1','CANCELLED'))
      OR (OLD.status = 'PENDING_LEVEL_1' AND NEW.status IN ('PENDING_LEVEL_2','DRAFT'))
      OR (OLD.status = 'PENDING_LEVEL_2' AND NEW.status IN ('APPROVED','DRAFT'))
      OR (OLD.status = 'APPROVED' AND NEW.status IN ('COMPLETED','DRAFT'))) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Chuyen trang thai dot huy khong hop le';
    END IF;
    SELECT COUNT(*) INTO v_included FROM disposal_batch_records WHERE batch_id = OLD.id AND item_status = 'INCLUDED';
    IF NEW.status IN ('PENDING_LEVEL_1','PENDING_LEVEL_2') AND v_included = 0 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Dot phai con it nhat 1 ho so';
    END IF;
    IF NEW.status = 'PENDING_LEVEL_1' AND NEW.submitted_at IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Thieu thoi diem gui';
    END IF;
    IF OLD.status = 'APPROVED' AND NEW.status = 'DRAFT' AND OLD.started_at IS NOT NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Da bat dau thuc hien huy, khong thu hoi duoc';
    END IF;
    IF NEW.status = 'COMPLETED' AND (v_included > 0
       OR NOT EXISTS (SELECT 1 FROM disposal_certificates WHERE batch_id = OLD.id)
       OR NOT EXISTS (SELECT 1 FROM disposal_batch_records WHERE batch_id = OLD.id AND item_status = 'DISPOSED')) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Dot chua huy xong hoac chua co bien ban';
    END IF;
    IF NEW.status = 'DRAFT' AND OLD.status <> 'DRAFT' AND NEW.last_return_reason IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Tra lai hoac thu hoi phai co ly do';
    END IF;
  END IF;
END$$

CREATE PROCEDURE sp_check_batch_entry(IN p_batch_id BIGINT UNSIGNED, IN p_record_id BIGINT UNSIGNED)
BEGIN
  IF NOT EXISTS (SELECT 1 FROM disposal_batches b JOIN records r ON r.department_id = b.department_id
                 WHERE b.id = p_batch_id AND r.id = p_record_id AND b.status = 'DRAFT'
                   AND r.status = 'EXPIRED' AND r.is_disposal_eligible AND NOT r.is_on_hold) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Chi them ho so Het han, co dau du dieu kien huy, cung phong, vao dot Nhap';
  END IF;
END$$

CREATE TRIGGER trg_dbr_insert BEFORE INSERT ON disposal_batch_records FOR EACH ROW
BEGIN
  IF NEW.item_status <> 'INCLUDED' OR NEW.exclusion_requested THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Dong moi phai o trang thai Trong dot';
  END IF;
  CALL sp_check_batch_entry(NEW.batch_id, NEW.record_id);
END$$

CREATE TRIGGER trg_dbr_update BEFORE UPDATE ON disposal_batch_records FOR EACH ROW
BEGIN
  DECLARE v_batch_status VARCHAR(20);
  SELECT status INTO v_batch_status FROM disposal_batches WHERE id = OLD.batch_id;
  IF NEW.batch_id <> OLD.batch_id OR NEW.record_id <> OLD.record_id OR OLD.item_status = 'DISPOSED' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Dong da huy hoac khoa khong duoc sua';
  END IF;
  IF NEW.exclusion_requested AND NOT OLD.exclusion_requested AND v_batch_status <> 'PENDING_LEVEL_1' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Chi de nghi loai khi dot cho duyet cap 1';
  END IF;
  IF NEW.item_status <> OLD.item_status THEN
    IF NEW.item_status = 'EXCLUDED'
       AND NOT (OLD.item_status = 'INCLUDED' AND OLD.exclusion_requested AND v_batch_status = 'PENDING_LEVEL_1') THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Chi loai ho so da duoc de nghi khi duyet cap 1';
    END IF;
    IF NEW.item_status = 'WITHDRAWN' AND (OLD.item_status <> 'INCLUDED' OR v_batch_status IN ('COMPLETED','CANCELLED')) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Rut ho so khong hop le';
    END IF;
    IF NEW.item_status = 'DISPOSED'
       AND NOT (OLD.item_status = 'INCLUDED' AND (SELECT status FROM records WHERE id = OLD.record_id) = 'DISPOSED') THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Ho so chua duoc huy';
    END IF;
    IF NEW.item_status = 'INCLUDED' THEN
      CALL sp_check_batch_entry(OLD.batch_id, OLD.record_id);
      SET NEW.exclusion_requested = FALSE, NEW.exclusion_reason = NULL;
    END IF;
  END IF;
END$$

CREATE TRIGGER trg_certificates_insert BEFORE INSERT ON disposal_certificates FOR EACH ROW
BEGIN
  IF (SELECT status FROM disposal_batches WHERE id = NEW.batch_id) <> 'APPROVED'
     OR EXISTS (SELECT 1 FROM disposal_batch_records WHERE batch_id = NEW.batch_id AND item_status = 'INCLUDED') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Chi lap bien ban khi moi ho so trong dot da huy';
  END IF;
END$$

-- ---------- E. Nhật ký và tham số ----------
CREATE TRIGGER trg_audit_logs_insert BEFORE INSERT ON audit_logs FOR EACH ROW
BEGIN
  DECLARE v_seq BIGINT UNSIGNED;
  DECLARE v_hash CHAR(64);
  SELECT last_seq, last_hash INTO v_seq, v_hash FROM audit_chain_head WHERE id = 1 FOR UPDATE;
  IF NEW.seq <> v_seq + 1 OR NEW.prev_hash <> v_hash
     OR NEW.hash <> fn_audit_hash(NEW.prev_hash, NEW.seq, NEW.occurred_at, NEW.user_id, NEW.roles, NEW.ip_address,
                                  NEW.action, NEW.object_type, NEW.object_code, NEW.result, NEW.details) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Ban ghi nhat ky khong noi dung chuoi';
  END IF;
END$$

CREATE TRIGGER trg_audit_logs_after_insert AFTER INSERT ON audit_logs FOR EACH ROW
BEGIN
  UPDATE audit_chain_head SET last_seq = NEW.seq, last_hash = NEW.hash WHERE id = 1;
END$$

CREATE TRIGGER trg_system_settings_update BEFORE UPDATE ON system_settings FOR EACH ROW
BEGIN
  IF NEW.setting_key <> OLD.setting_key OR NEW.value_type <> OLD.value_type
     OR NOT (NEW.min_value <=> OLD.min_value) OR NOT (NEW.max_value <=> OLD.max_value) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Chi duoc sua gia tri tham so';
  END IF;
  IF NEW.value_type = 'INTEGER' AND (CAST(NEW.value AS UNSIGNED) < NEW.min_value OR CAST(NEW.value AS UNSIGNED) > NEW.max_value) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Gia tri tham so ngoai khoang cho phep';
  END IF;
  IF NOT fn_has_role(NEW.updated_by, 'SYSTEM_ADMIN') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Chi Quan tri vien duoc sua tham so';
  END IF;
END$$

DELIMITER ;


-- DỮ LIỆU KHỞI TẠO

INSERT INTO roles (id, code, name) VALUES
  (1, 'EMPLOYEE', 'Nhân viên'),
  (2, 'DEPARTMENT_HEAD', 'Trưởng phòng'),
  (3, 'RECORDS_OFFICER', 'Cán bộ lưu trữ'),
  (4, 'DIRECTOR', 'Giám đốc'),
  (5, 'SYSTEM_ADMIN', 'Quản trị hệ thống');

INSERT INTO permissions (code, name, module) VALUES
  ('ACCOUNT.CHANGE_PASSWORD', 'Đổi mật khẩu của mình', 'COMMON'),
  ('NOTIFICATION.VIEW', 'Xem thông báo của mình', 'COMMON'),
  ('RECORD.CREATE', 'Tạo hồ sơ', 'RECORD'),
  ('RECORD.UPDATE', 'Cập nhật hồ sơ, tải/gỡ file', 'RECORD'),
  ('RECORD.SUBMIT', 'Gửi / rút yêu cầu lưu trữ', 'RECORD'),
  ('RECORD.CANCEL', 'Hủy bỏ hồ sơ tạo nhầm', 'RECORD'),
  ('RECORD.VIEW', 'Tra cứu và xem chi tiết hồ sơ', 'RECORD'),
  ('RECORD.DOWNLOAD', 'Xem và tải file hồ sơ', 'RECORD'),
  ('RECORD.EXPORT', 'Xuất danh sách hồ sơ', 'RECORD'),
  ('RECORD.APPROVE_ARCHIVE', 'Duyệt / từ chối yêu cầu lưu trữ', 'RECORD'),
  ('RECORD.MARK_ENDED', 'Đánh dấu hết hiệu lực', 'RETENTION'),
  ('RECORD.VIEW_EXPIRY_ALERTS', 'Xem cảnh báo hạn lưu trữ', 'RETENTION'),
  ('RECORD.REVIEW_EXPIRED', 'Rà soát hồ sơ hết hạn', 'RETENTION'),
  ('RECORD.MARK_ELIGIBLE', 'Đánh dấu / bỏ dấu đủ điều kiện hủy', 'RETENTION'),
  ('EXTENSION.REQUEST', 'Lập đề xuất gia hạn', 'RETENTION'),
  ('EXTENSION.APPROVE', 'Duyệt / từ chối đề xuất gia hạn', 'RETENTION'),
  ('EXTENSION.VIEW', 'Theo dõi đề xuất gia hạn', 'RETENTION'),
  ('CATALOG.MANAGE', 'Quản lý nhóm hồ sơ và loại tài liệu', 'POLICY'),
  ('LABEL.PROPOSE', 'Lập / gửi / rút đề xuất nhãn', 'POLICY'),
  ('LABEL.VIEW', 'Tra cứu nhãn và lịch sử phiên bản', 'POLICY'),
  ('LABEL.APPROVE', 'Phê duyệt / từ chối đề xuất nhãn', 'POLICY'),
  ('DISPOSAL.MANAGE', 'Lập, sửa, hủy bỏ, gửi đợt hủy', 'DISPOSAL'),
  ('DISPOSAL.VIEW', 'Theo dõi đợt hủy', 'DISPOSAL'),
  ('DISPOSAL.EXPORT', 'Xuất danh mục hồ sơ đề nghị hủy', 'DISPOSAL'),
  ('DISPOSAL.APPROVE_LEVEL_1', 'Duyệt cấp 1, loại hồ sơ, trả lại đợt hủy', 'DISPOSAL'),
  ('DISPOSAL.APPROVE_LEVEL_2', 'Phê duyệt cấp 2, trả lại đợt hủy', 'DISPOSAL'),
  ('DISPOSAL.REVOKE', 'Thu hồi quyết định hủy', 'DISPOSAL'),
  ('CERTIFICATE.DOWNLOAD', 'Tải biên bản hủy', 'DISPOSAL'),
  ('HOLD.MANAGE', 'Đặt, gỡ, tra cứu phong tỏa', 'LEGAL_HOLD'),
  ('REPORT.VIEW', 'Xem thống kê', 'REPORT'),
  ('AUDIT.VIEW', 'Xem nhật ký hệ thống', 'AUDIT'),
  ('AUDIT.VERIFY', 'Kiểm tra toàn vẹn nhật ký', 'AUDIT'),
  ('ADMIN.DEPARTMENTS', 'Quản lý phòng ban', 'ADMIN'),
  ('ADMIN.USERS', 'Quản lý tài khoản, khóa, đặt lại mật khẩu', 'ADMIN'),
  ('ADMIN.ROLES', 'Gán và thu hồi vai trò', 'ADMIN'),
  ('ADMIN.SETTINGS', 'Cấu hình tham số hệ thống', 'ADMIN'),
  ('ADMIN.BACKUP', 'Sao lưu dữ liệu', 'ADMIN'),
  ('ADMIN.JOBS', 'Theo dõi tác vụ định kỳ', 'ADMIN');

-- Ma trận phân quyền: 1 Nhân viên, 2 Trưởng phòng, 3 Cán bộ lưu trữ, 4 Giám đốc, 5 Quản trị hệ thống
INSERT INTO role_permissions (role_id, permission_code, scope) VALUES
  (1, 'ACCOUNT.CHANGE_PASSWORD', 'OWN'), (2, 'ACCOUNT.CHANGE_PASSWORD', 'OWN'), (3, 'ACCOUNT.CHANGE_PASSWORD', 'OWN'),
  (4, 'ACCOUNT.CHANGE_PASSWORD', 'OWN'), (5, 'ACCOUNT.CHANGE_PASSWORD', 'OWN'),
  (1, 'NOTIFICATION.VIEW', 'OWN'), (2, 'NOTIFICATION.VIEW', 'OWN'), (3, 'NOTIFICATION.VIEW', 'OWN'),
  (4, 'NOTIFICATION.VIEW', 'OWN'), (5, 'NOTIFICATION.VIEW', 'OWN'),
  (1, 'RECORD.CREATE', 'DEPARTMENT'), (2, 'RECORD.CREATE', 'DEPARTMENT'),
  (1, 'RECORD.UPDATE', 'OWN'), (2, 'RECORD.UPDATE', 'OWN'),
  (1, 'RECORD.SUBMIT', 'OWN'), (2, 'RECORD.SUBMIT', 'OWN'),
  (1, 'RECORD.CANCEL', 'OWN'), (2, 'RECORD.CANCEL', 'OWN'),
  (1, 'RECORD.VIEW', 'DEPARTMENT'), (2, 'RECORD.VIEW', 'DEPARTMENT'), (3, 'RECORD.VIEW', 'ALL'), (4, 'RECORD.VIEW', 'ALL'),
  (1, 'RECORD.DOWNLOAD', 'DEPARTMENT'), (2, 'RECORD.DOWNLOAD', 'DEPARTMENT'), (3, 'RECORD.DOWNLOAD', 'ALL'), (4, 'RECORD.DOWNLOAD', 'ALL'),
  (2, 'RECORD.EXPORT', 'DEPARTMENT'), (3, 'RECORD.EXPORT', 'ALL'), (4, 'RECORD.EXPORT', 'ALL'),
  (2, 'RECORD.APPROVE_ARCHIVE', 'DEPARTMENT'), (3, 'RECORD.APPROVE_ARCHIVE', 'ALL'),
  (2, 'RECORD.MARK_ENDED', 'DEPARTMENT'),
  (2, 'RECORD.VIEW_EXPIRY_ALERTS', 'DEPARTMENT'),
  (3, 'RECORD.REVIEW_EXPIRED', 'ALL'),
  (3, 'RECORD.MARK_ELIGIBLE', 'ALL'),
  (1, 'EXTENSION.REQUEST', 'DEPARTMENT'),
  (2, 'EXTENSION.APPROVE', 'DEPARTMENT'),
  (1, 'EXTENSION.VIEW', 'DEPARTMENT'), (2, 'EXTENSION.VIEW', 'DEPARTMENT'), (3, 'EXTENSION.VIEW', 'ALL'),
  (3, 'CATALOG.MANAGE', 'ALL'),
  (3, 'LABEL.PROPOSE', 'ALL'),
  (3, 'LABEL.VIEW', 'ALL'), (4, 'LABEL.VIEW', 'ALL'),
  (4, 'LABEL.APPROVE', 'ALL'),
  (3, 'DISPOSAL.MANAGE', 'ALL'),
  (2, 'DISPOSAL.VIEW', 'DEPARTMENT'), (3, 'DISPOSAL.VIEW', 'ALL'), (4, 'DISPOSAL.VIEW', 'ALL'),
  (3, 'DISPOSAL.EXPORT', 'ALL'),
  (2, 'DISPOSAL.APPROVE_LEVEL_1', 'DEPARTMENT'),
  (4, 'DISPOSAL.APPROVE_LEVEL_2', 'ALL'),
  (4, 'DISPOSAL.REVOKE', 'ALL'),
  (3, 'CERTIFICATE.DOWNLOAD', 'ALL'),
  (4, 'HOLD.MANAGE', 'ALL'),
  (2, 'REPORT.VIEW', 'DEPARTMENT'), (3, 'REPORT.VIEW', 'ALL'), (4, 'REPORT.VIEW', 'ALL'),
  (4, 'AUDIT.VIEW', 'ALL'), (5, 'AUDIT.VIEW', 'ALL'),
  (4, 'AUDIT.VERIFY', 'ALL'), (5, 'AUDIT.VERIFY', 'ALL'),
  (5, 'ADMIN.DEPARTMENTS', 'ALL'), (5, 'ADMIN.USERS', 'ALL'), (5, 'ADMIN.ROLES', 'ALL'),
  (5, 'ADMIN.SETTINGS', 'ALL'), (5, 'ADMIN.BACKUP', 'ALL'), (5, 'ADMIN.JOBS', 'ALL');

-- H(0) của chuỗi băm: giá trị ngẫu nhiên sinh một lần khi khởi tạo
SET @genesis = SHA2(CONCAT('RECORDS_RETENTION|H0|', UUID(), '|', HEX(RANDOM_BYTES(32))), 256);
INSERT INTO audit_chain_head (id, genesis_hash, last_seq, last_hash) VALUES (1, @genesis, 0, @genesis);

INSERT INTO system_settings (setting_key, value, value_type, min_value, max_value, description) VALUES
  ('COMPANY_NAME', 'Công ty TNHH Mẫu', 'STRING', NULL, NULL, 'Tên doanh nghiệp in trên biên bản hủy'),
  ('FISCAL_YEAR_END', '31/12', 'DAY_MONTH', NULL, NULL, 'Ngày kết thúc năm tài chính (dd/mm)'),
  ('DISPOSAL_WAIT_DAYS', '3', 'INTEGER', 1, 30, 'Số ngày chờ từ khi duyệt cấp 2 đến khi hủy'),
  ('MAX_EXTENSION_YEARS', '5', 'INTEGER', 1, 10, 'Ngày hết hạn mới tối đa = hôm nay + N năm'),
  ('JOB_RUN_TIME', '00:00', 'TIME', NULL, NULL, 'Giờ chạy tác vụ định kỳ (giờ Việt Nam)'),
  ('MAX_FAILED_LOGINS', '5', 'INTEGER', 3, 10, 'Số lần đăng nhập sai liên tiếp trước khi tạm khóa'),
  ('LOGIN_LOCK_MINUTES', '15', 'INTEGER', 5, 60, 'Thời gian tạm khóa đăng nhập (phút)'),
  ('SESSION_HOURS', '8', 'INTEGER', 1, 12, 'Thời hạn phiên đăng nhập (giờ)'),
  ('MAX_FILE_SIZE_MB', '20', 'INTEGER', 1, 100, 'Dung lượng tối đa mỗi file (MB)'),
  ('MAX_FILES_PER_RECORD', '20', 'INTEGER', 1, 50, 'Số file đang dùng tối đa mỗi hồ sơ'),
  ('BACKUP_RETENTION_DAYS', '30', 'INTEGER', 7, 30, 'Số ngày giữ bản sao lưu');


-- TÀI KHOẢN ỨNG DỤNG – ĐẶC QUYỀN TỐI THIỂU
-- - Không có DELETE (trừ label_version_document_types, trigger chỉ cho xóa khi phiên bản Nháp), không có quyền thay đổi cấu trúc.
-- - Nhật ký chỉ ghi qua sp_write_audit_log; mã nghiệp vụ cấp qua sp_next_code_number.
-- - Đổi mật khẩu bên dưới trước khi triển khai.

CREATE USER 'app_retention'@'%' IDENTIFIED BY 'ChangeMe_2026!';

GRANT SELECT, INSERT, UPDATE ON records_retention.departments TO 'app_retention'@'%';
GRANT SELECT, INSERT, UPDATE ON records_retention.users TO 'app_retention'@'%';
GRANT SELECT, INSERT, UPDATE ON records_retention.user_roles TO 'app_retention'@'%';
GRANT SELECT, INSERT, UPDATE ON records_retention.login_sessions TO 'app_retention'@'%';
GRANT SELECT, INSERT, UPDATE ON records_retention.record_groups TO 'app_retention'@'%';
GRANT SELECT, INSERT, UPDATE ON records_retention.retention_labels TO 'app_retention'@'%';
GRANT SELECT, INSERT, UPDATE ON records_retention.label_versions TO 'app_retention'@'%';
GRANT SELECT, INSERT, UPDATE ON records_retention.document_types TO 'app_retention'@'%';
GRANT SELECT, INSERT, DELETE ON records_retention.label_version_document_types TO 'app_retention'@'%';
GRANT SELECT, INSERT, UPDATE ON records_retention.records TO 'app_retention'@'%';
GRANT SELECT, INSERT, UPDATE ON records_retention.files TO 'app_retention'@'%';
GRANT SELECT, INSERT, UPDATE ON records_retention.file_versions TO 'app_retention'@'%';
GRANT SELECT, INSERT, UPDATE ON records_retention.extension_requests TO 'app_retention'@'%';
GRANT SELECT, INSERT ON records_retention.legal_holds TO 'app_retention'@'%';
GRANT SELECT, INSERT, UPDATE ON records_retention.legal_hold_records TO 'app_retention'@'%';
GRANT SELECT, INSERT, UPDATE ON records_retention.disposal_batches TO 'app_retention'@'%';
GRANT SELECT, INSERT, UPDATE ON records_retention.disposal_batch_records TO 'app_retention'@'%';
GRANT SELECT, INSERT ON records_retention.disposal_certificates TO 'app_retention'@'%';
GRANT SELECT, INSERT, UPDATE ON records_retention.notifications TO 'app_retention'@'%';
GRANT SELECT, INSERT, UPDATE ON records_retention.job_runs TO 'app_retention'@'%';
GRANT SELECT, UPDATE ON records_retention.system_settings TO 'app_retention'@'%';
GRANT SELECT, INSERT ON records_retention.integrity_checks TO 'app_retention'@'%';
GRANT SELECT ON records_retention.audit_logs TO 'app_retention'@'%';
GRANT SELECT ON records_retention.audit_chain_head TO 'app_retention'@'%';
GRANT SELECT ON records_retention.code_counters TO 'app_retention'@'%';
GRANT SELECT ON records_retention.roles TO 'app_retention'@'%';
GRANT SELECT ON records_retention.permissions TO 'app_retention'@'%';
GRANT SELECT ON records_retention.role_permissions TO 'app_retention'@'%';
GRANT SELECT ON records_retention.v_user_permissions TO 'app_retention'@'%';
GRANT EXECUTE ON PROCEDURE records_retention.sp_write_audit_log TO 'app_retention'@'%';
GRANT EXECUTE ON PROCEDURE records_retention.sp_verify_audit_chain TO 'app_retention'@'%';
GRANT EXECUTE ON PROCEDURE records_retention.sp_next_code_number TO 'app_retention'@'%';
GRANT EXECUTE ON FUNCTION records_retention.fn_today_vn TO 'app_retention'@'%';

FLUSH PRIVILEGES;
