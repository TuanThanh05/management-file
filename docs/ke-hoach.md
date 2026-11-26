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
- Tài khoản `app_retention` không có quyền DDL và không có DELETE (trừ bỏ loại tài liệu khỏi phiên bản nhãn Nháp), nên migration của ORM không chạy được. Cấu trúc CSDL lấy thẳng từ file SQL.
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
| Tác vụ định kỳ | Bộ hẹn giờ của Node.js (kiểm tra mỗi phút theo `JOB_RUN_TIME`) + `GET_LOCK` của MySQL, ghi `job_runs` |
| Biên bản PDF | pdfmake (hỗ trợ phông tiếng Việt) – theo bảng nền tảng kỹ thuật của báo cáo |
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
| 5 | Records | Tạo, sửa khi Đang sử dụng, hủy bỏ hồ sơ tạo nhầm; gửi/rút yêu cầu lưu trữ; duyệt/từ chối (gắn phiên bản nhãn, tính mốc và ngày hết hạn); Trưởng phòng đánh dấu hết hiệu lực; tra cứu có lọc, phân trang, tìm "chứa chuỗi" (LIKE) | P0 |
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
| 3 | Admin (phòng ban, người dùng, vai trò, tham số) | Tạo đủ 5 vai trò để test các ngày sau | [x] 26/11 |
| 4 | Catalog + Labels (đề xuất → duyệt) | Loại tài liệu có nhãn đang hiệu lực | [x] 26/11 |
| 5 | Records + Files (mã hóa, giải mã) | Tạo hồ sơ, tải file lên rồi tải về đúng sha256 | [x] 26/11 |
| 6 | Gửi/duyệt lưu trữ, tính hạn, tra cứu, đánh dấu hết hiệu lực | Hồ sơ ARCHIVED có `expiry_date` | [x] 26/11 |
| 7 | Job quét hạn, notifications, extensions, holds | Hồ sơ test (hạn lùi về quá khứ) chuyển sang EXPIRED | [x] 26/11 |
| 8 | Đợt hủy và duyệt 2 cấp | Đợt đi hết Nháp → Cấp 1 → Cấp 2 → APPROVED | [x] 26/11 |
| 9 | Job thực hiện hủy, biên bản PDF, audit verify | Chạy trọn luồng hủy, kiểm tra nhật ký ra INTACT | [x] 26/11 |
| 10 | Reports, export, backup, test end-to-end, tài liệu API | Postman collection hoặc Swagger cho frontend | [x] 26/11 |

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

## 7. Việc cần cập nhật lại trong báo cáo

Những chỗ code đã khác hoặc chi tiết hơn báo cáo; nhóm sửa báo cáo cho khớp trước khi nộp. Làm xong thì đánh [x].

| # | Chỗ cần sửa | Nội dung sửa | Phát sinh | Trạng thái |
|---|---|---|---|---|
| 1 | Chương 3 – thiết kế CSDL / phân quyền tài khoản ứng dụng (nếu có câu "không có quyền DELETE trên bất kỳ bảng nào") | Sửa thành "… trừ việc bỏ loại tài liệu khỏi phiên bản nhãn đang Nháp (trigger `trg_lvdt_no_delete` chỉ cho xóa khi phiên bản ở Nháp)" | Ngày 4 | [ ] |
| 2 | Chương 2 – 5.5 chức năng 2 (Quản lý phòng ban) | Thêm thao tác "Mở lại phòng ban đã ngừng hoạt động" | Ngày 3 | [ ] |
| 3 | Chương 2 – 5.5 chức năng 3 (Quản lý tài khoản) | Thêm: Trưởng phòng phải thu hồi vai trò trước khi chuyển phòng; mở khóa bị chặn nếu làm phòng có 2 Trưởng phòng hoặc doanh nghiệp có 2 Giám đốc | Ngày 3 | [ ] |
| 4 | Chương 2 – 5.3 chức năng 4, 5 (Nhóm hồ sơ, loại tài liệu) | Thêm thao tác "Mở lại" cho nhóm hồ sơ và loại tài liệu | Ngày 4 | [ ] |
| 5 | Chương 2 – 5.4 chức năng 5 (Phê duyệt đề xuất nhãn) | Thêm: loại tài liệu bị bỏ khỏi phiên bản nhãn mới thì mất nhãn, không tạo hồ sơ mới được cho đến khi được gắn nhãn khác | Ngày 4 | [ ] |
| 6 | Chương 1 – bảng nền tảng kỹ thuật | Kiểm tra khớp với mục 1 của kế hoạch này (Express 5, mysql2, zod, pdfmake, multer, file-type…) | Ngày 1 | [ ] |
| 7 | Chương 2 – 5.1 chức năng 5 (Tải file lên) | Thêm: đuôi tên file phải khớp định dạng thật theo nội dung, không khớp thì từ chối (ví dụ PNG đặt tên .pdf) | Ngày 5 | [ ] |
| 8 | Chương 6 – Ưu khuyết điểm / hạn chế | Thêm hạn chế: mất khóa chủ `MASTER_KEY_BASE64` thì không mở được file trong kho; chưa hỗ trợ đổi khóa định kỳ (key rotation) | Ngày 5 | [ ] |
| 9 | Chương 2 – 5.1 chức năng 12 (Xem chi tiết hồ sơ) | Thêm: mỗi lượt xem chi tiết hồ sơ đều ghi nhật ký (như 5.3 chức năng 2 đã ghi cho Cán bộ lưu trữ) | Ngày 5 | [ ] |
| 10 | Chương 2 – 5.1 chức năng 8 (Gửi yêu cầu lưu trữ) | Thêm: phòng chưa có Trưởng phòng thì vẫn gửi được, hệ thống báo Quản trị hệ thống; loại tài liệu không còn nhãn hiệu lực thì chặn gửi và báo Cán bộ lưu trữ | Ngày 6 | [ ] |
| 11 | Chương 2 – 5.2 chức năng 5, 5.3 chức năng 3 (Duyệt lưu trữ) | Ghi rõ: ai duyệt được xét **tại thời điểm duyệt** – người tạo đang là Trưởng phòng thì Cán bộ lưu trữ duyệt, còn lại Trưởng phòng của phòng duyệt; người duyệt khác người tạo | Ngày 6 | [ ] |
| 12 | Chương 2 – 5.1 chức năng 11 (Tra cứu, BM07) | Ghi rõ: từ khóa tìm kiểu "chứa chuỗi" trên mã và tiêu đề; 20 dòng/trang; sắp xếp theo ngày tạo, ngày hết hạn, mã | Ngày 6 | [ ] |
| 13 | Chương 2 – 5.2 chức năng 8 (Đánh dấu hết hiệu lực, BM11) | Thêm: nhãn không tính theo sự kiện thì ngày kết thúc sự kiện là tùy chọn, ngày hết hạn giữ nguyên; nội dung sự kiện đã khai báo thì giữ nguyên | Ngày 6 | [ ] |
| 14 | Chương 3 – bảng use case 1.4, UC23 (Lập đề xuất gia hạn) | Sửa tác nhân "Cán bộ lưu trữ" thành **Nhân viên** cho khớp 5.1 CN14, 5.3 CN12 ("Cán bộ lưu trữ không lập hay sửa đề xuất gia hạn") và QT3.2; UC23 không còn là «extend» của UC21 | Ngày 7 | [ ] |
| 15 | Chương 2 – 5.2 chức năng 11 (Từ chối gia hạn) và QT3.2 bước 8 | Thống nhất: từ chối gia hạn thì báo lý do cho **cả Nhân viên đề xuất và Cán bộ lưu trữ** (hai chỗ đang ghi mỗi chỗ một người) | Ngày 7 | [ ] |
| 16 | Chương 1 – bảng nền tảng kỹ thuật (nếu có ghi node-cron) | Sửa "Tác vụ định kỳ": bộ hẹn giờ của Node.js kiểm tra mỗi phút theo tham số `JOB_RUN_TIME` + khóa `GET_LOCK` của MySQL | Ngày 7 | [ ] |
| 17 | Chương 2 – QT3.1 nhánh B | Thêm: máy chủ tắt qua giờ quét thì khi bật lại hệ thống tự chạy bù trong ngày; Quản trị hệ thống chạy tay được tác vụ; mỗi lần chạy ghi lịch sử (`job_runs`) | Ngày 7 | [ ] |
| 18 | Chương 2 – 5.1 chức năng 14 (Lập đề xuất gia hạn) | Thêm: phòng chưa có Trưởng phòng thì thông báo chờ duyệt gửi Quản trị hệ thống (giống ngày 6) | Ngày 7 | [ ] |
| 19 | Chương 2 – 5.4 chức năng 11 (Đặt phong tỏa) | Ghi rõ: đợt hủy không còn hồ sơ sau khi rút thì về Nháp ở **mọi trạng thái chưa hoàn tất**, kể cả Đã phê duyệt mà chưa bắt đầu hủy; lý do ghi tự động "Mọi hồ sơ trong đợt bị rút do phong tỏa"; báo Cán bộ lập đợt và Trưởng phòng | Ngày 8 | [ ] |
| 20 | Chương 2 – 5.2 chức năng 13 (Loại hồ sơ khỏi đợt) | Thêm: Trưởng phòng được bỏ đề nghị loại trước khi đồng ý đợt | Ngày 8 | [ ] |
| 21 | Chương 2 – 5.3 chức năng 15 (Gửi đợt hủy) | Thêm: phòng chưa có Trưởng phòng thì vẫn gửi được, thông báo chờ duyệt gửi Quản trị hệ thống | Ngày 8 | [ ] |
| 22 | Chương 2 – 5.3 chức năng 14 (Sửa / hủy bỏ đợt) | Ghi rõ: bớt hồ sơ khỏi đợt Nháp được lưu là "rút khỏi đợt" kèm lý do (không xóa dòng, để giữ dấu vết); hủy bỏ đợt thì mọi hồ sơ được ghi rút, vẫn giữ dấu Đủ điều kiện hủy và đưa được vào đợt khác | Ngày 8 | [ ] |
| 23 | Chương 2 – 5.4 chức năng 9, 10 (Trả lại cấp 2, Thu hồi) | Ghi rõ: đợt về Nháp thì kết quả duyệt cấp 1, cấp 2 và thời điểm hủy dự kiến bị xóa; gửi lại phải duyệt lại từ cấp 1 (lịch sử vẫn còn trong nhật ký) | Ngày 8 | [ ] |
| 24 | Chương 2 – 7.1 yêu cầu số 14; 7.2 yêu cầu số 17 | Sửa "truy vấn tham số hóa (**Prisma**)" thành "truy vấn tham số hóa qua **mysql2** (không dùng ORM)"; sửa "cấu trúc CSDL quản lý bằng **migration**" thành "cấu trúc CSDL quản lý bằng script SQL `records_retention.sql` (nguồn chuẩn, có trigger và thủ tục)" | Ngày 9 | [ ] |
| 25 | Chương 2 – 7.2 yêu cầu số 3 (Kiểm soát truy cập) | Sửa: truy cập hồ sơ / đối tượng **ngoài phạm vi** trả **404** (không lộ đối tượng có tồn tại); trong phạm vi nhưng không đủ quyền (ví dụ không phải người tạo, không phải người duyệt) trả **403** | Ngày 9 | [ ] |
| 26 | Chương 2 – BM16 trường 11 | Ghi rõ: chân trang in **SHA-256 của nội dung biên bản** (bản chụp JSON); SHA-256 của **file PDF** lưu trong CSDL, kiểm lại mỗi lần tải và trả kèm khi tải (một file không thể chứa mã băm của chính nó) | Ngày 9 | [ ] |
| 27 | Chương 2 – BM16 trường 9 | Ghi rõ: danh mục in mã băm từng phiên bản file, **không in tên file** (tên file có thể chứa dữ liệu cá nhân) | Ngày 9 | [ ] |
| 28 | Chương 2 – QT4.2 | Thêm: tác vụ kiểm tra mỗi phút, đợt đến giờ hẹn thì hủy ngay; lần chạy có lỗi thì 15 phút sau mới thử lại; một hồ sơ lỗi từ 3 lần trở lên thì báo Quản trị hệ thống và Cán bộ lưu trữ; kiểm tra lần cuối không còn hồ sơ đạt thì đợt về Nháp, không lập biên bản | Ngày 9 | [ ] |
| 29 | Chương 3 – thiết kế CSDL / tài khoản CSDL | Thêm tài khoản **`backup_retention` chỉ đọc** (SELECT, SHOW VIEW, TRIGGER, LOCK TABLES, EVENT, SHOW_ROUTINE) dùng riêng cho sao lưu; tài khoản ứng dụng không có quyền này | Ngày 10 | [ ] |
| 30 | Chương 2 – 5.5 chức năng 7, 7.1 yêu cầu số 15 (Sao lưu) | Ghi rõ: bản sao lưu mã hóa AES-256-GCM bằng **khóa sao lưu riêng** (khác khóa chủ, không nằm trong bản sao lưu); lưu ở thư mục cấu hình được (ổ / máy khác); khôi phục bằng script `restore-backup.js` (kiểm tra toàn vẹn trước khi bung) – ngoài giao diện hệ thống | Ngày 10 | [ ] |
| 31 | Chương 2 – 7.2 yêu cầu số 20 (Triển khai) | Ghi rõ: `docker compose --profile app up -d --build` chạy MySQL + backend; frontend và Nginx ghép thêm service khi nhóm hoàn thiện | Ngày 10 | [ ] |
| 32 | Chương 6 – Ưu khuyết điểm / hạn chế | Thêm: hồ sơ đã hủy vẫn khôi phục được từ bản sao lưu tạo trước thời điểm hủy cho đến khi bản đó bị xóa (tối đa `BACKUP_RETENTION_DAYS`, 30 ngày) – đúng như 5.5 CN7 đã nêu | Ngày 10 | [ ] |
| 33 | Chương 1 / Chương 4 – công cụ | Thêm: tài liệu API OpenAPI 3.1 sinh tự động từ route và schema zod, xem bằng Swagger UI tại `/api/docs` (chỉ khi chạy dev); xuất XLSX bằng exceljs | Ngày 10 | [ ] |

---

## 8. Nhật ký thay đổi kế hoạch

| Ngày | Thay đổi | Lý do |
|---|---|---|
| 25/11/2026 | Tạo kế hoạch | Bắt đầu làm backend |
| 26/11/2026 | Xong ngày 1. Đặt tên package `records-retention-backend`; thêm `src/core/time.js` (`todayVN`) và `logger.js` | Cột DATE là ngày VN, cần hàm dùng chung; log ứng dụng tách khỏi nhật ký nghiệp vụ |
| 26/11/2026 | Thêm mục 6 "Quy trình Git": làm trên nhánh `feature/...`, merge vào `main` qua Pull Request | Theo quy ước của nhóm |
| 26/11/2026 | Repo dùng `database/records_retention.sql` và `src/config/database.js`; thêm `compose.yaml` (tùy chọn, MySQL 8.4 chạy giờ UTC, tự nạp script lần đầu) | Theo cách đặt tên của nhóm; một số máy dev dùng Docker |
| 26/11/2026 | Chốt đặc tả ngày 2 theo báo cáo (5.1 mục 1–2, 7.1 mục 1): JWT trong cookie httpOnly, mật khẩu mới 12–64 ký tự, thông báo lỗi đăng nhập dùng chung | Bám đúng báo cáo, tránh tự đặt quy tắc khác |
| 26/11/2026 | Xong ngày 2. Quy ước: chú thích mỗi hàm/khối một dòng; thêm `docs/danh-sach-ham.md` (Tên hàm, File, Làm gì, Người viết, Ngày) và `docs/api.http` | Theo yêu cầu của nhóm; frontend có sẵn API để ghép |
| 26/11/2026 | Thêm `SET NAMES utf8mb4;` vào đầu `database/records_retention.sql` | MySQL trong Docker nạp script bằng client latin1, tiếng Việt bị lỗi font ("NhÃ¢n viÃªn") |
| 26/11/2026 | Biên bản PDF dùng pdfmake thay cho pdfkit | Bảng nền tảng kỹ thuật trong báo cáo ghi pdfmake |
| 26/11/2026 | Xong ngày 3. Bổ sung ngoài báo cáo: mở lại phòng ban đã ngừng hoạt động; Trưởng phòng phải thu hồi vai trò trước khi chuyển phòng; mở khóa bị chặn nếu làm phòng có 2 Trưởng phòng hoặc có 2 Giám đốc; tạo tài khoản kèm vai trò cũng báo Giám đốc | Nhóm chốt; giữ đúng quy tắc "1 Trưởng phòng/phòng, 1 Giám đốc" của 5.5 chức năng 4 |
| 26/11/2026 | Xong ngày 4. Bổ sung ngoài báo cáo: mở lại nhóm hồ sơ và loại tài liệu; loại tài liệu bị bỏ khỏi phiên bản nhãn mới thì mất nhãn (không tạo hồ sơ mới được cho đến khi gắn nhãn khác) | Nhóm chốt |
| 26/11/2026 | Sửa CSDL: `trg_lvdt_no_delete` chỉ cho xóa dòng `label_version_document_types` khi phiên bản ở Nháp; cấp quyền DELETE riêng cho bảng này | Báo cáo cho sửa danh sách loại tài liệu khi đề xuất ở Nháp (5.3 CN6, BM02 phần C); script cũ chặn xóa tuyệt đối nên Nháp bị kẹt. Từ khi gửi duyệt vẫn khóa như cũ |
| 26/11/2026 | Thêm mục 7 "Việc cần cập nhật lại trong báo cáo" | Nhóm sẽ sửa báo cáo sau; ghi lại để không quên |
| 26/11/2026 | Xong ngày 5. Đuôi file không khớp nội dung thì từ chối; README cảnh báo sao lưu khóa chủ; `MASTER_KEY_BASE64` bắt buộc khi khởi động; bản mã gắn AAD = tên lưu trữ (chống tráo file); nhật ký hồ sơ không ghi tiêu đề/mô tả (có thể chứa dữ liệu cá nhân, mà nhật ký không sửa được); viết lại `.env.example` đủ biến | Nhóm chốt; bảo vệ dữ liệu cá nhân theo yêu cầu 21 (Luật BVDLCN 2025) |
| 26/11/2026 | Xong ngày 6. Giữ phương án B: hồ sơ do Trưởng phòng tạo do Cán bộ lưu trữ duyệt (đúng 5.3 CN3); vai trò người duyệt xét tại thời điểm duyệt; phòng chưa có Trưởng phòng vẫn gửi được và báo Quản trị hệ thống; tra cứu dùng LIKE (thoát `%`, `_`) trên mã và tiêu đề | Nhóm chốt |
| 26/11/2026 | Xong ngày 7. Tác vụ định kỳ dùng bộ hẹn giờ của Node.js (mỗi phút, chạy bù khi máy tắt qua giờ) thay cho node-cron; gia hạn do Nhân viên lập (theo 5.1 CN14 và quyền trong CSDL); từ chối gia hạn báo cả Nhân viên đề xuất và Cán bộ lưu trữ; hàng chờ duyệt của Trưởng phòng có thêm đề xuất gia hạn; phong tỏa hồ sơ đang trong đợt hủy → tự rút khỏi đợt **làm ở ngày 8** (khi có đợt hủy) | Nhóm chốt; bớt một thư viện; khớp báo cáo |
| 26/11/2026 | Xong ngày 8. Phong tỏa làm đợt hết hồ sơ thì đợt về Nháp ở mọi trạng thái chưa hoàn tất (trừ đợt đã bắt đầu hủy); Trưởng phòng bỏ được đề nghị loại; phòng chưa có Trưởng phòng vẫn gửi đợt và báo Quản trị hệ thống; thu hồi cần `confirm: true`; hàng chờ duyệt của Trưởng phòng có thêm đợt hủy chờ cấp 1 | Nhóm chốt |
| 26/11/2026 | Xong ngày 9. Thực hiện hủy kiểm tra mỗi phút (hủy đúng giờ hẹn), lỗi thì nghỉ 15 phút, từ lần lỗi thứ 3 báo Quản trị hệ thống và Cán bộ lưu trữ; kiểm tra lần cuối làm trước khi đánh dấu bắt đầu hủy, hết hồ sơ đạt thì đợt về Nháp; biên bản pdfmake 0.3 (phông Roboto, chặn tải URL ngoài); hàng chờ của Giám đốc thêm đề xuất nhãn, đợt chờ cấp 2, đợt đang chờ hủy | Nhóm chốt |
| 26/11/2026 | Xong ngày 10. Thống kê BM13; xuất danh sách hồ sơ và BM05 (XLSX exceljs, PDF pdfmake); sao lưu bằng mysqldump + tài khoản `backup_retention` chỉ đọc, mã hóa bằng `BACKUP_KEY_BASE64` riêng, script giải mã `restore-backup.js`; OpenAPI 3.1 + Swagger UI `/api/docs` (ngoài production); Dockerfile + service `api` (profile `app`) trong compose; ép `uuid` ≥ 11.1.1 (cảnh báo bảo mật của exceljs); test trọn vòng đời hồ sơ | Nhóm chốt |
