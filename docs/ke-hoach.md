# KẾ HOẠCH BACKEND – HỆ THỐNG QUẢN LÝ LƯU TRỮ VÀ HỦY DỮ LIỆU

> Tài liệu gốc để bám sát khi code. Đổi gì thì sửa ở đây trước, rồi mới code.
> Nguồn chuẩn: báo cáo "hoàn thiện tạm thời 2" (chương 1–3) + script `records_retention.sql`.

- Thời gian: 10 ngày (bắt đầu 25/11/2026)
- Repo: `https://github.com/TuanThanh05/management-file.git` (gợi ý đổi thành `records-retention-backend` cho khớp tên CSDL – nhóm quyết)

---

## 1. Quyết định kỹ thuật

**Node.js + Express, SQL thuần qua `mysql2`, KHÔNG dùng ORM.**

Lý do (căn cứ từ `records_retention.sql`):
- Phần lớn quy tắc nghiệp vụ nằm trong trigger, thủ tục (`sp_write_audit_log`, `sp_next_code_number`, `sp_verify_audit_chain`) và lỗi `SIGNAL 45000`. ORM gọi thủ tục và bắt lỗi trigger rất vướng.
- Tài khoản `app_retention` không có quyền DELETE và DDL, nên migration của ORM không chạy được. Cấu trúc CSDL lấy thẳng từ file SQL.
- `sp_write_audit_log` phải gọi TRONG giao dịch nghiệp vụ, nên phải tự kiểm soát transaction.

### Nền tảng kỹ thuật (bảng 2 cột cho báo cáo)

| Thành phần | Công nghệ sử dụng |
|---|---|
| Môi trường chạy | Node.js (bản LTS) |
| Framework API | Express 5 |
| Truy cập CSDL | mysql2/promise (pool, transaction, CALL procedure) |
| CSDL | MySQL 8.4 LTS |
| Kiểm tra đầu vào | zod |
| Xác thực | jsonwebtoken (JWT có `jti` = `login_sessions.id`) + bcrypt (cost 12) |
| Tải file | multer (lưu tạm trong RAM) + file-type (nhận định dạng theo magic bytes) |
| Mã hóa file | `node:crypto` AES-256-GCM, mã hóa phong bì (khóa chủ đặt trong `.env`) |
| Tác vụ định kỳ | node-cron + `GET_LOCK` của MySQL |
| Biên bản PDF | pdfkit (nhúng font TTF tiếng Việt) |
| Xuất Excel | exceljs |
| Bảo mật HTTP | helmet, cors, express-rate-limit |
| Ghi log ứng dụng | pino |
| Kiểm thử | vitest + supertest |

---

## 2. Cấu trúc thư mục

```
src/
  config/        env.js, database.js (pool)
  core/          tx.js (transaction + ghi audit), errors.js (map SQLSTATE 45000 → 409/422), codes.js
  middlewares/   auth.js (JWT + kiểm tra phiên), authorize.js (permission + scope), validate.js
  modules/
    auth/ admin/ catalog/ labels/ records/ files/ extensions/
    holds/ disposals/ certificates/ audit/ notifications/ reports/
      (mỗi module: routes.js, controller.js, service.js, repo.js, schema.js)
  jobs/          expiryScan.js, disposalExecution.js, backup.js
  crypto/        envelope.js (encrypt, decrypt, shred)
scripts/         init-admin.js (tạo quản trị viên đầu tiên)
database/        records_retention.sql (nguồn chuẩn của CSDL)
compose.yaml     MySQL bằng Docker (tùy chọn)
storage/         files/, certificates/  (không commit)
```

---

## 3. Phần dùng chung (làm đầu tiên)

1. **`withTx(fn)`**: mở transaction → chạy nghiệp vụ → `CALL sp_write_audit_log(...)` → commit trong cùng một giao dịch. Lỗi ở đâu thì rollback hết, kể cả dòng nhật ký.
2. **`authorize('RECORD.VIEW')`**: đọc `v_user_permissions` để lấy `scope` (OWN / DEPARTMENT / ALL), thêm điều kiện `WHERE` tương ứng. Không có quyền thì từ chối (deny-by-default).
3. **Kiểm tra phiên mỗi request**: JWT (đặt trong cookie `httpOnly; Secure; SameSite=Strict` theo mục 7.1 báo cáo) hợp lệ, phiên trong `login_sessions` chưa bị thu hồi, chưa hết hạn.
4. **Map lỗi**: `SIGNAL 45000` → 409 kèm thông báo; lỗi zod → 422; vi phạm UNIQUE/CHECK → 409.
5. **Sinh mã nghiệp vụ** HS-, DH-, GH-, PT-, BB- qua `sp_next_code_number`, gọi trong cùng transaction.

---

## 4. Danh sách chức năng theo module

P0 = bắt buộc để demo luồng chính. P1 = làm nếu còn thời gian.

| # | Module | Chức năng / API chính | Ưu tiên |
|---|---|---|---|
| 1 | Auth | Đăng nhập (đếm sai, tạm khóa theo `MAX_FAILED_LOGINS`), đăng xuất, đổi mật khẩu (bắt buộc lần đầu), `GET /me` (vai trò + quyền) | P0 |
| 2 | Admin | CRUD phòng ban; tạo, khóa tài khoản, đặt lại mật khẩu; gán/thu hồi vai trò (thu hồi phiên `ROLES_CHANGED`); sửa tham số hệ thống | P0 |
| 3 | Catalog | CRUD nhóm hồ sơ, loại tài liệu | P0 |
| 4 | Labels | Lập đề xuất nhãn (CREATE/UPDATE/DEACTIVATE), sửa ở Nháp, gửi, rút. Giám đốc duyệt/từ chối; khi duyệt cập nhật `current_label_version_id` của loại tài liệu, phiên bản cũ → RETIRED. Xem lịch sử phiên bản | P0 |
| 5 | Records | Tạo, sửa khi Đang sử dụng, hủy bỏ hồ sơ tạo nhầm; gửi/rút yêu cầu lưu trữ; duyệt/từ chối (gắn phiên bản nhãn, tính mốc và ngày hết hạn); Trưởng phòng đánh dấu hết hiệu lực; tra cứu có lọc, phân trang, FULLTEXT | P0 |
| 6 | Files | Tải lên (magic bytes, dung lượng, số file, sha256, mã hóa AES-GCM); tải về (giải mã, kiểm tra auth_tag); gỡ file; phiên bản mới | P0 |
| 7 | Job quét hạn | Hằng ngày: ARCHIVED → EXPIRED khi đến hạn; cảnh báo trước N ngày (`is_warned`); ghi `job_runs` | P0 |
| 8 | Rà soát hết hạn | Cán bộ lưu trữ xem hồ sơ hết hạn, đặt/bỏ dấu đủ điều kiện hủy | P0 |
| 9 | Disposals | Lập đợt (Nháp), thêm/bỏ hồ sơ, gửi. Cấp 1 (Trưởng phòng): duyệt, đề nghị loại, trả lại. Cấp 2 (Giám đốc): duyệt (`scheduled_at = duyệt + DISPOSAL_WAIT_DAYS`), trả lại, thu hồi. Hủy bỏ đợt | P0 |
| 10 | Job thực hiện hủy | Đợt APPROVED đã đến `scheduled_at`: kiểm tra phong tỏa lần cuối → xóa `wrapped_key` (hủy bằng mật mã) → xóa bản mã trên đĩa, `is_purged` → che tiêu đề nếu nhãn có dữ liệu cá nhân → `DISPOSED`. Có thử lại (`attempt_count`) | P0 |
| 11 | Certificates | Lập biên bản BM16: snapshot JSON, sinh PDF, lưu sha256, đợt → COMPLETED; tải biên bản | P0 |
| 12 | Audit | Xem nhật ký có lọc; kiểm tra toàn vẹn (`CALL sp_verify_audit_chain`, lưu `integrity_checks`) | P0 |
| 13 | Extensions | Nhân viên lập đề xuất gia hạn, Trưởng phòng duyệt (cập nhật `expiry_date`, EXPIRED → ARCHIVED) hoặc từ chối; theo dõi | P1 |
| 14 | Holds | Giám đốc đặt phong tỏa nhiều hồ sơ (tệp căn cứ mã hóa), gỡ từng hồ sơ; hồ sơ đang trong đợt hủy → WITHDRAWN | P1 |
| 15 | Notifications | Danh sách, đánh dấu đã đọc; service tự tạo khi cần duyệt, có kết quả duyệt, sắp hết hạn | P1 |
| 16 | Reports / Export | Thống kê theo trạng thái, phòng ban; xuất Excel danh sách hồ sơ và danh mục đề nghị hủy | P1 |
| 17 | Backup / Jobs | `mysqldump` + nén kho file, xóa bản cũ quá `BACKUP_RETENTION_DAYS`; xem `job_runs`, chạy tay | P1 |

---

## 5. Kế hoạch 10 ngày

| Ngày | Việc | Xong khi | Trạng thái |
|---|---|---|---|
| 1 | Tạo repo, cấu hình, pool CSDL, `withTx`, map lỗi, `init-admin` | Chạy được script SQL, tạo được quản trị viên | [x] 26/11 |
| 2 | Auth + middleware phân quyền theo scope | Đăng nhập, khóa khi sai nhiều lần, đổi mật khẩu có test | [x] 26/11 |
| 3 | Admin (phòng ban, người dùng, vai trò, tham số) | Tạo đủ 5 vai trò để test các ngày sau | [ ] |
| 4 | Catalog + Labels (đề xuất → duyệt) | Loại tài liệu có nhãn đang hiệu lực | [ ] |
| 5 | Records + Files (mã hóa, giải mã) | Tạo hồ sơ, tải file lên rồi tải về đúng sha256 | [ ] |
| 6 | Gửi/duyệt lưu trữ, tính hạn, tra cứu, đánh dấu hết hiệu lực | Hồ sơ ARCHIVED có `expiry_date` | [ ] |
| 7 | Job quét hạn, notifications, extensions, holds | Hồ sơ test (hạn lùi về quá khứ) chuyển sang EXPIRED | [ ] |
| 8 | Đợt hủy và duyệt 2 cấp | Đợt đi hết Nháp → Cấp 1 → Cấp 2 → APPROVED | [ ] |
| 9 | Job thực hiện hủy, biên bản PDF, audit verify | Chạy trọn luồng hủy, kiểm tra nhật ký ra INTACT | [ ] |
| 10 | Reports, export, backup, test end-to-end, tài liệu API | Postman collection hoặc Swagger cho frontend | [ ] |

### Lưu ý để kịp tiến độ
- Ngày 1–2: xuất sớm danh sách API (OpenAPI hoặc Postman) cho bạn làm React, để frontend không phải chờ backend.
- Test job không cần chờ hết hạn thật: `DISPOSAL_WAIT_DAYS` = 1, nhãn `retention_years` = 1, `document_date` lùi về quá khứ, gọi chạy tay job qua API admin.

---

## 6. Quy trình Git

- `main` luôn chạy được; không commit thẳng lên `main`.
- Mỗi ngày (hoặc mỗi module) làm trên một nhánh riêng, đặt tên `feature/ngay-<số>-<nội-dung>`, ví dụ `feature/ngay-02-auth`.
- Các bước mỗi lần làm:
  1. `git switch main && git pull`
  2. `git switch -c feature/ngay-XX-...`
  3. Code, chạy `npm test` qua hết rồi `git add . && git commit -m "..."`
  4. `git push -u origin feature/ngay-XX-...`
  5. Lên GitHub mở Pull Request vào `main`, xem lại phần thay đổi rồi Merge
  6. `git switch main && git pull`, sau đó có thể xóa nhánh cũ: `git branch -d feature/ngay-XX-...`
- Không commit: `.env`, `node_modules/`, `storage/` (đã có trong `.gitignore`).
- Chú thích trong code: mỗi hàm/khối một dòng tóm tắt. Thêm hoặc sửa hàm thì cập nhật `docs/danh-sach-ham.md`.

---

## 7. Nhật ký thay đổi kế hoạch

| Ngày | Thay đổi | Lý do |
|---|---|---|
| 25/11/2026 | Tạo kế hoạch | Bắt đầu làm backend |
| 26/11/2026 | Xong ngày 1. Đặt tên package `records-retention-backend`; thêm `src/core/time.js` (`todayVN`) và `logger.js` | Cột DATE là ngày VN, cần hàm dùng chung; log ứng dụng tách khỏi nhật ký nghiệp vụ |
| 26/11/2026 | Thêm mục 6 "Quy trình Git": làm trên nhánh `feature/...`, merge vào `main` qua Pull Request | Theo quy ước của nhóm |
| 26/11/2026 | Repo dùng `database/records_retention.sql` và `src/config/database.js`; thêm `compose.yaml` (tùy chọn, MySQL 8.4 chạy giờ UTC, tự nạp script lần đầu) | Theo cách đặt tên của nhóm; một số máy dev dùng Docker |
| 26/11/2026 | Chốt đặc tả ngày 2 theo báo cáo (5.1 mục 1–2, 7.1 mục 1): JWT trong cookie httpOnly, mật khẩu mới 12–64 ký tự, thông báo lỗi đăng nhập dùng chung | Bám đúng báo cáo, tránh tự đặt quy tắc khác |
| 26/11/2026 | Xong ngày 2. Quy ước: chú thích mỗi hàm/khối một dòng; thêm `docs/danh-sach-ham.md` (Tên hàm, File, Làm gì, Người viết, Ngày) và `docs/api.http` | Theo yêu cầu của nhóm; frontend có sẵn API để ghép |
| 26/11/2026 | Thêm `SET NAMES utf8mb4;` vào đầu `database/records_retention.sql` | MySQL trong Docker nạp script bằng client latin1, tiếng Việt bị lỗi font ("NhÃ¢n viÃªn") |
