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
docs/          ke-hoach.md, danh-sach-ham.md, api.http
scripts/       init-admin.js
src/
  config/      env.js (kiểm tra .env bằng zod), database.js (pool)
  core/        tx.js, errors.js, codes.js, time.js, logger.js, settings.js, password.js, session.js, notify.js, dbMessages.js
  middlewares/ authenticate, authorize, validate, originCheck, rateLimit
  modules/     mỗi module: routes, controller, service, repo, schema
  jobs/        tác vụ định kỳ
  crypto/      mã hóa phong bì file
tests/         vitest + supertest, chạy trên CSDL thật (setup/ kiểm tra kết nối, helpers/ tạo dữ liệu test)
```
