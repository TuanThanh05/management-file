# records-retention-backend

Backend hệ thống quản lý lưu trữ và hủy dữ liệu: Node.js + Express 5, MySQL, SQL thuần qua `mysql2` (không ORM).
Kế hoạch chi tiết: `docs/ke-hoach.md`.

## Cài đặt lần đầu

Yêu cầu: Node.js ≥ 22, MySQL 8.0.22+ (khuyến nghị 8.4 LTS).

**Cách A – dùng Docker** (thay cho bước 1–2 bên dưới): đặt `MYSQL_ROOT_PASSWORD` trong `.env`, chạy `docker compose up -d`. Lần đầu container tự nạp `database/records_retention.sql` và đã chạy giờ UTC. Tạo lại CSDL từ đầu: `docker compose down -v && docker compose up -d`.

**Cách B – MySQL cài trên máy:**

1. MySQL phải chạy theo giờ UTC. Thêm vào file cấu hình MySQL (`my.cnf` / `my.ini`), mục `[mysqld]`:
   ```ini
   default-time-zone=+00:00
   ```
   Nếu nạp script báo lỗi 1419 (binary logging), thêm `log_bin_trust_function_creators=1`.
2. Tạo CSDL (XÓA CSDL cũ nếu có, chỉ dùng cho máy dev):
   ```bash
   mysql -uroot -p < database/records_retention.sql
   ```
3. Cài thư viện, tạo `.env`:
   ```bash
   npm install
   cp .env.example .env      # sửa DB_PASSWORD nếu đã đổi mật khẩu app_retention
   node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"   # dán kết quả vào JWT_SECRET
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # dán kết quả vào MASTER_KEY_BASE64
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # chạy lại lần nữa, dán vào BACKUP_KEY_BASE64 (khác khóa chủ)
   ```
4. Tạo quản trị viên đầu tiên (mật khẩu tạm in ra một lần):
   ```bash
   npm run init-admin -- --email admin@congty.vn --name "Quản trị hệ thống" --dept-code CNTT --dept-name "Phòng Công nghệ thông tin"
   ```
5. Chạy:
   ```bash
   npm run dev     # tự khởi động lại khi sửa code
   npm test        # cần CSDL đã tạo ở bước 2 và 4
   ```
   Kiểm tra: `GET http://localhost:3000/api/health` → `{"status":"ok","db":"ok"}`
   Tài liệu API (Swagger, chỉ khi không chạy production): `http://localhost:3000/api/docs`. Xuất file cho frontend: `npm run docs:openapi` → `docs/openapi.json`.

**Cách C – chạy cả MySQL và backend bằng Docker:** điền `.env` như bước 3 rồi `docker compose --profile app up -d --build`. API ở cổng 3000 (chế độ production, không có `/api/docs`). Tạo quản trị viên: `docker compose exec api node scripts/init-admin.js --email ... --name ... --dept-code ... --dept-name ...`. Kho file và bản sao lưu nằm trong volume `api_storage`, `api_backups` (nên đổi `api_backups` sang ổ đĩa khác).

**Đã có CSDL từ trước ngày 10?** Script SQL có thêm tài khoản sao lưu `backup_retention`. Tạo lại CSDL (`docker compose down -v && docker compose up -d`, hoặc nạp lại script), hoặc chạy riêng 3 lệnh `CREATE USER 'backup_retention'... / GRANT ...` ở cuối script bằng root.

## Khóa chủ MASTER_KEY_BASE64 – đọc kỹ

- Mỗi file tải lên được mã hóa AES-256-GCM bằng một khóa riêng; khóa riêng đó được bọc bằng **khóa chủ** trong `.env` (mã hóa phong bì).
- **Mất khóa chủ = mất toàn bộ file trong kho, không có cách khôi phục.** Sao lưu khóa chủ riêng (ví dụ trình quản lý mật khẩu), tách khỏi máy chủ và tách khỏi bản sao lưu CSDL.
- Không commit, không gửi khóa qua chat. Mỗi máy dev dùng khóa riêng; file mã hóa ở máy này không mở được ở máy khác.
- Đổi khóa định kỳ (key rotation) nằm ngoài phạm vi đồ án.

## Tác vụ định kỳ

- `npm start` bật bộ hẹn giờ: mỗi phút kiểm tra, đã qua giờ `JOB_RUN_TIME` (giờ VN, sửa trong tham số hệ thống) mà hôm nay chưa chạy thì chạy quét hạn. Máy chủ tắt qua giờ chạy thì bật lên sẽ chạy bù.
- Chạy nhiều tiến trình cũng không bị chạy trùng (khóa `GET_LOCK` của MySQL). Mỗi lần chạy ghi vào `job_runs`.
- Thực hiện hủy: mỗi phút kiểm tra, có đợt Đã phê duyệt đến giờ hẹn thì hủy (xóa khóa → xóa bản mã → lập biên bản PDF). Lần chạy có lỗi thì 15 phút sau mới thử lại.
- Test nhanh: Quản trị viên gọi `POST /api/admin/jobs/expiry-scan/run` hoặc `POST /api/admin/jobs/disposal-execution/run`, xem kết quả ở `GET /api/admin/jobs/runs`.
- Biên bản lưu ở `STORAGE_DIR/certificates` (vĩnh viễn, không xóa); sao lưu cùng kho file.

## Sao lưu và khôi phục

- Bật sao lưu: đặt `BACKUP_KEY_BASE64` (khác khóa chủ) và `BACKUP_DB_PASSWORD` trong `.env`; máy chạy backend cần `mysqldump` **bản MySQL 8** (Ubuntu: `apt install mysql-client-core-8.0`; Windows: có sẵn trong MySQL Server/Workbench, đặt `MYSQLDUMP_PATH`). Image Docker đã cài sẵn.
- Mỗi ngày theo `JOB_RUN_TIME`: dump CSDL bằng tài khoản chỉ đọc + kho file (đã mã hóa) → nén → mã hóa AES-256-GCM → `BACKUP_DIR/rr-backup-<thời điểm>.rrbk`. Bản cũ hơn `BACKUP_RETENTION_DAYS` tự xóa. Quản trị viên chạy tay: `POST /api/admin/backups/run`.
- Khóa chủ và khóa sao lưu **không** nằm trong bản sao lưu: cất riêng cả hai. Mất khóa sao lưu = không đọc được bản sao lưu; mất khóa chủ = có bản sao lưu cũng không mở được file.
- Khôi phục (ngoài giao diện hệ thống): kiểm tra toàn vẹn rồi bung ra thư mục trống:
  ```bash
  npm run restore-backup -- backups/rr-backup-....rrbk ./khoi-phuc
  mysql -uroot -p < database/records_retention.sql            # tạo lại user và cấu trúc (xóa CSDL cũ)
  mysql -uroot -p records_retention < ./khoi-phuc/database.sql # nạp lại dữ liệu
  # chép ./khoi-phuc/storage/* vào STORAGE_DIR
  ```

## Quy ước code

- **Mọi thao tác ghi đều đi qua `withTx(actor, fn)`** (`src/core/tx.js`) và gọi `tx.audit(...)` trong cùng transaction.
  Lỗi ở đâu thì rollback cả dữ liệu lẫn nhật ký.
- Không tự viết `INSERT INTO audit_logs`. Tài khoản ứng dụng không có quyền đó, chỉ được ghi qua `sp_write_audit_log`.
- Mã nghiệp vụ (HS-, DH-, GH-, PT-, BB-) sinh bằng `nextCode(conn, type, { departmentCode })` trong transaction tạo đối tượng.
- Không bắt lỗi trigger để tự xử lý: cứ để lỗi bay lên, `errorHandler` sẽ map:

  | Lỗi | HTTP | `error.code` |
  |---|---|---|
  | `SIGNAL 45000` (trigger chặn) | 409 | `BUSINESS_RULE_VIOLATION` |
  | Trùng UNIQUE | 409 | `DUPLICATE` |
  | Vi phạm CHECK | 422 | `CONSTRAINT_VIOLATION` |
  | Khóa ngoại không tồn tại | 422 | `INVALID_REFERENCE` |
  | Dữ liệu sai (zod) | 422 | `VALIDATION_ERROR` |
  | Deadlock / chờ khóa (đã thử lại 2 lần) | 503 | `BUSY` |
  | Bị từ chối quyền CSDL | 500 | `INTERNAL_ERROR` (có ghi cảnh báo vào log) |

- Định dạng lỗi trả về: `{ "error": { "code", "message", "details", "requestId" } }`
- Cột `DATE` là ngày theo lịch Việt Nam, đọc ra dạng chuỗi `YYYY-MM-DD`. Lấy ngày hôm nay bằng `todayVN()`, không dùng `new Date().toISOString().slice(0,10)`.
- Không ghi mật khẩu, token, khóa hay nội dung file vào log lẫn vào `details` của nhật ký.
- API cần đăng nhập: `authenticate()` rồi `authorize('MÃ_QUYỀN')`; lọc dữ liệu theo phạm vi bằng `scopeFilter(req, { departmentColumn, ownerColumn })`.
- Giá trị 0/1 lấy từ biểu thức SQL có thể về dạng chuỗi `"0"` (do `bigNumberStrings`), không dùng `Boolean(...)` để đổi kiểu.
- Khóa dòng bằng `FOR UPDATE OF <bảng>` khi câu SELECT có JOIN: tài khoản ứng dụng chỉ có quyền đọc các bảng danh mục (`roles`...), khóa cả câu sẽ bị từ chối.
- Chú thích: mỗi hàm/khối chỉ một dòng tóm tắt. Thêm hoặc sửa hàm thì cập nhật `docs/danh-sach-ham.md`.
- Thử API: `docs/api.http`. Frontend gọi API với `credentials: 'include'` (phiên nằm trong cookie httpOnly).

## Cấu trúc

```
database/      records_retention.sql (nguồn chuẩn của CSDL)
docs/          ke-hoach.md, danh-sach-ham.md, api.http, openapi.json (sinh bằng npm run docs:openapi)
scripts/       init-admin.js, restore-backup.js, export-openapi.js
src/
  config/      env.js (kiểm tra .env bằng zod), database.js (pool)
  core/        tx.js, errors.js, codes.js, time.js, logger.js, settings.js, password.js, session.js, notify.js, dbMessages.js, storage.js, pdf.js, exporter.js, labels.js
  middlewares/ authenticate, authorize, validate, originCheck, rateLimit, upload
  modules/     mỗi module: routes, controller, service, repo, schema
  jobs/        runner.js (khóa + job_runs), scheduler.js (hẹn giờ mỗi phút), expiryScan.js (quét hạn), disposalExecution.js (thực hiện hủy), backup.js (sao lưu)
  docs/        openapi.js (sinh OpenAPI từ route + schema zod), swagger.js, summaries.js
  crypto/      envelope.js: mã hóa phong bì file (AES-256-GCM, khóa riêng từng file)
tests/         vitest + supertest, chạy trên CSDL thật (setup/ kiểm tra kết nối, helpers/ tạo dữ liệu test, fixtures/ file mẫu; kho file test ở storage-test/)
```
