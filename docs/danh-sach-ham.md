# Danh sách hàm

Cập nhật mỗi khi thêm hoặc sửa hàm. Quy ước chú thích trong code: mỗi hàm/khối chỉ một dòng tóm tắt.

## Cấu hình – `src/config`

| Tên hàm | File | Làm gì | Người viết | Ngày |
|---|---|---|---|---|
| `env` | `env.js` | Đọc và kiểm tra biến môi trường bằng zod, sai thì dừng ứng dụng | TuanThanh05 | 26/11/2026 |
| `pool` | `database.js` | Pool kết nối MySQL: DATETIME theo UTC, cột DATE giữ chuỗi `YYYY-MM-DD` | TuanThanh05 | 26/11/2026 |
| `pingDb()` | `database.js` | Kiểm tra kết nối CSDL, đọc số thứ tự nhật ký cuối | TuanThanh05 | 26/11/2026 |
| `closeDb()` | `database.js` | Đóng pool khi dừng ứng dụng | TuanThanh05 | 26/11/2026 |

## Lõi – `src/core`

| Tên hàm | File | Làm gì | Người viết | Ngày |
|---|---|---|---|---|
| `withTx(actor, fn)` | `tx.js` | Chạy nghiệp vụ trong transaction; lỗi thì rollback cả dữ liệu lẫn nhật ký; deadlock thì thử lại | TuanThanh05 | 26/11/2026 |
| `writeAudit(conn, actor, entry)` | `tx.js` | Ghi một dòng nhật ký qua `sp_write_audit_log` trong transaction đang mở | TuanThanh05 | 26/11/2026 |
| `auditFailure(actor, entry)` | `tx.js` | Ghi nhật ký FAILURE trong transaction riêng khi thao tác chính đã rollback | TuanThanh05 | 26/11/2026 |
| `actorFromReq(req)` | `tx.js` | Lấy người thực hiện `{ userId, roles, ip }` từ request | TuanThanh05 | 26/11/2026 |
| `SYSTEM_ACTOR` | `tx.js` | Người thực hiện cho tác vụ hệ thống | TuanThanh05 | 26/11/2026 |
| `AppError` | `errors.js` | Lỗi nghiệp vụ có HTTP status và mã lỗi | TuanThanh05 | 26/11/2026 |
| `toAppError(err)` | `errors.js` | Chuyển lỗi zod/MySQL/trigger 45000 về AppError | TuanThanh05 | 26/11/2026 |
| `isRetryableDbError(err)` | `errors.js` | Nhận biết deadlock/chờ khóa để thử lại transaction | TuanThanh05 | 26/11/2026 |
| `errorHandler` | `errors.js` | Middleware trả lỗi dạng `{ error: { code, message, details, requestId } }` | TuanThanh05 | 26/11/2026 |
| `notFoundHandler` | `errors.js` | Trả 404 cho API không tồn tại | TuanThanh05 | 26/11/2026 |
| `nextCode(conn, type, opts)` | `codes.js` | Sinh mã HS-, DH-, GH-, PT-, BB- qua `sp_next_code_number` | TuanThanh05 | 26/11/2026 |
| `todayVN()` | `time.js` | Ngày hôm nay theo lịch Việt Nam | TuanThanh05 | 26/11/2026 |
| `yearVN()` | `time.js` | Năm hiện tại theo lịch Việt Nam | TuanThanh05 | 26/11/2026 |
| `logger` | `logger.js` | Log ứng dụng, che cookie/token/mật khẩu | TuanThanh05 | 26/11/2026 |
| `getSettings(conn, keys)` | `settings.js` | Đọc tham số hệ thống (BM22) | TuanThanh05 | 26/11/2026 |
| `hashPassword(plain)` | `password.js` | Băm mật khẩu bcrypt cost 12 | TuanThanh05 | 26/11/2026 |
| `verifyPassword(plain, hash)` | `password.js` | So khớp mật khẩu với giá trị băm | TuanThanh05 | 26/11/2026 |
| `dummyVerify(plain)` | `password.js` | So khớp giả khi không có tài khoản để thời gian phản hồi như nhau | TuanThanh05 | 26/11/2026 |
| `generateTempPassword()` | `password.js` | Sinh mật khẩu tạm 24 ký tự ngẫu nhiên (BM21) | TuanThanh05 | 26/11/2026 |
| `checkNewPassword(input)` | `password.js` | Kiểm tra mật khẩu mới theo BM09: 12–64 ký tự, khác mật khẩu cũ, không chứa tên đăng nhập, xác nhận khớp | TuanThanh05 | 26/11/2026 |
| `signSessionToken(opts)` | `session.js` | Ký JWT chứa id người dùng và id phiên (`jti`) | TuanThanh05 | 26/11/2026 |
| `verifySessionToken(token)` | `session.js` | Kiểm tra chữ ký và hạn JWT | TuanThanh05 | 26/11/2026 |
| `setSessionCookie(res, token, maxAgeMs)` | `session.js` | Đặt cookie phiên httpOnly, Secure, SameSite=Strict (mục 7.1) | TuanThanh05 | 26/11/2026 |
| `clearSessionCookie(res)` | `session.js` | Xóa cookie phiên | TuanThanh05 | 26/11/2026 |
| `notifyUsers(conn, ids, payload)` | `notify.js` | Gửi thông báo cho danh sách người nhận | TuanThanh05 | 26/11/2026 |
| `notifyRole(conn, roleCode, payload)` | `notify.js` | Gửi thông báo cho mọi tài khoản đang giữ một vai trò | TuanThanh05 | 26/11/2026 |
| `translateDbMessage(msg)` | `dbMessages.js` | Dịch thông báo lỗi trigger sang tiếng Việt có dấu | TuanThanh05 | 26/11/2026 |

## Middleware – `src/middlewares`

| Tên hàm | File | Làm gì | Người viết | Ngày |
|---|---|---|---|---|
| `authenticate(opts)` | `authenticate.js` | Xác thực cookie phiên, nạp người dùng/vai trò/quyền vào `req.user`; chặn khi còn bắt buộc đổi mật khẩu | TuanThanh05 | 26/11/2026 |
| `authorize(permissionCode)` | `authorize.js` | Kiểm tra quyền theo ma trận `role_permissions`, gắn `req.scope`; từ chối thì ghi nhật ký `ACCESS_DENIED` | TuanThanh05 | 26/11/2026 |
| `scopeFilter(req, cols)` | `authorize.js` | Sinh điều kiện WHERE theo phạm vi OWN / DEPARTMENT / ALL | TuanThanh05 | 26/11/2026 |
| `validate(schemas)` | `validate.js` | Kiểm tra body/query/params bằng zod, kết quả đặt vào `req.input` | TuanThanh05 | 26/11/2026 |
| `originCheck` | `originCheck.js` | Chặn request ghi có header Origin lạ (CSRF lớp 2) | TuanThanh05 | 26/11/2026 |
| `loginRateLimit` | `rateLimit.js` | Giới hạn số lần gọi đăng nhập mỗi IP trong 1 phút | TuanThanh05 | 26/11/2026 |

## Module Auth – `src/modules/auth`

| Tên hàm | File | Làm gì | Người viết | Ngày |
|---|---|---|---|---|
| `login(input)` | `service.js` | Đăng nhập (5.1 mục 1): đếm sai, tạm khóa, thông báo lỗi chung, cấp phiên, ghi nhật ký | TuanThanh05 | 26/11/2026 |
| `logout(user, actor)` | `service.js` | Thu hồi phiên hiện tại | TuanThanh05 | 26/11/2026 |
| `changePassword(user, actor, body)` | `service.js` | Đổi mật khẩu (5.1 mục 2): hủy mọi phiên cũ, cấp phiên mới | TuanThanh05 | 26/11/2026 |
| `toMe(user)` | `service.js` | Dữ liệu trả về cho `GET /me` | TuanThanh05 | 26/11/2026 |
| `findUserForLogin(conn, email)` | `repo.js` | Lấy tài khoản theo email và khóa dòng | TuanThanh05 | 26/11/2026 |
| `findPasswordHashForUpdate(conn, userId)` | `repo.js` | Lấy mật khẩu băm và khóa dòng | TuanThanh05 | 26/11/2026 |
| `getRoleCodes(conn, userId)` | `repo.js` | Mã vai trò đang hiệu lực | TuanThanh05 | 26/11/2026 |
| `recordFailedLogin(conn, userId, opts)` | `repo.js` | Tăng số lần sai, đạt ngưỡng thì tạm khóa | TuanThanh05 | 26/11/2026 |
| `recordSuccessfulLogin(conn, userId)` | `repo.js` | Đặt lại bộ đếm sai, ghi thời điểm đăng nhập | TuanThanh05 | 26/11/2026 |
| `createSession(conn, opts)` | `repo.js` | Tạo phiên trong `login_sessions` | TuanThanh05 | 26/11/2026 |
| `revokeSession(conn, id, reason)` | `repo.js` | Thu hồi một phiên | TuanThanh05 | 26/11/2026 |
| `revokeAllSessions(conn, userId, reason)` | `repo.js` | Thu hồi mọi phiên của người dùng | TuanThanh05 | 26/11/2026 |
| `updatePassword(conn, userId, hash)` | `repo.js` | Lưu mật khẩu mới, bỏ cờ bắt buộc đổi | TuanThanh05 | 26/11/2026 |
| `loadAuthContext(userId, sessionId)` | `repo.js` | Nạp phiên + tài khoản + vai trò + quyền | TuanThanh05 | 26/11/2026 |
| `touchSession(sessionId)` | `repo.js` | Cập nhật thời điểm hoạt động cuối của phiên | TuanThanh05 | 26/11/2026 |
| `loginSchema`, `changePasswordSchema` | `schema.js` | Kiểm tra dữ liệu BM08, BM09 | TuanThanh05 | 26/11/2026 |

## Module Admin – `src/modules/admin` (báo cáo 5.5, chức năng 2–6)

| Tên hàm | File | Làm gì | Người viết | Ngày |
|---|---|---|---|---|
| `listDepartments()` | `service.js` | Danh sách phòng ban kèm phòng cha, Trưởng phòng, số tài khoản hoạt động | TuanThanh05 | 26/11/2026 |
| `createDepartment(actor, body)` | `service.js` | Thêm phòng ban (BM20): mã duy nhất viết hoa, phòng cha đang hoạt động | TuanThanh05 | 26/11/2026 |
| `updateDepartment(actor, code, body)` | `service.js` | Sửa tên, phòng ban cha; chặn vòng lặp | TuanThanh05 | 26/11/2026 |
| `deactivateDepartment(actor, code)` | `service.js` | Ngừng hoạt động khi không còn tài khoản hoạt động | TuanThanh05 | 26/11/2026 |
| `activateDepartment(actor, code)` | `service.js` | Mở lại phòng ban đã ngừng hoạt động | TuanThanh05 | 26/11/2026 |
| `listUsers(query)` | `service.js` | Danh sách tài khoản có lọc, phân trang | TuanThanh05 | 26/11/2026 |
| `getUser(id)` | `service.js` | Chi tiết tài khoản | TuanThanh05 | 26/11/2026 |
| `createUser(actor, body)` | `service.js` | Tạo tài khoản kèm vai trò (BM21), trả mật khẩu tạm một lần, báo Giám đốc | TuanThanh05 | 26/11/2026 |
| `updateUser(actor, id, body)` | `service.js` | Sửa họ tên, phòng ban; Trưởng phòng phải thu hồi vai trò trước khi chuyển phòng | TuanThanh05 | 26/11/2026 |
| `lockUser(actor, id)` | `service.js` | Khóa tài khoản, hủy mọi phiên; không khóa chính mình | TuanThanh05 | 26/11/2026 |
| `unlockUser(actor, id)` | `service.js` | Mở khóa; chặn nếu làm phòng có 2 Trưởng phòng hoặc có 2 Giám đốc | TuanThanh05 | 26/11/2026 |
| `resetUserPassword(actor, id)` | `service.js` | Đặt lại mật khẩu tạm, hủy phiên, thông báo cho người dùng | TuanThanh05 | 26/11/2026 |
| `setUserRoles(actor, id, body)` | `service.js` | Đặt lại vai trò (thu hồi rồi gán), hủy phiên, nhật ký trước/sau, báo Giám đốc | TuanThanh05 | 26/11/2026 |
| `listSettings()` | `service.js` | Danh sách 11 tham số BM22 | TuanThanh05 | 26/11/2026 |
| `checkSettingValue(setting, value)` | `service.js` | Kiểm tra giá trị theo kiểu và khoảng cho phép (ngày tháng thật, hh:mm) | TuanThanh05 | 26/11/2026 |
| `updateSetting(actor, key, body)` | `service.js` | Sửa tham số, nhật ký giá trị cũ/mới, báo Giám đốc | TuanThanh05 | 26/11/2026 |
| `listDepartments`, `findDepartment`, `insertDepartment`, `updateDepartment`, `setDepartmentStatus`, `countActiveUsersInDepartment` | `repo.js` | Truy vấn bảng `departments` | TuanThanh05 | 26/11/2026 |
| `listUsers`, `getUser`, `lockUserRow`, `insertUser`, `updateUser`, `lockUser`, `unlockUser`, `resetPassword` | `repo.js` | Truy vấn bảng `users` | TuanThanh05 | 26/11/2026 |
| `getActiveRoleCodes`, `grantRole`, `revokeRole`, `otherActiveHolderExists` | `repo.js` | Truy vấn bảng `user_roles` (thu hồi bằng ghi dấu, không xóa) | TuanThanh05 | 26/11/2026 |
| `listSettings`, `findSettingForUpdate`, `updateSetting` | `repo.js` | Truy vấn bảng `system_settings` | TuanThanh05 | 26/11/2026 |
| Các schema | `schema.js` | Kiểm tra dữ liệu BM20, BM21, BM22 | TuanThanh05 | 26/11/2026 |

## Script – `scripts`

| Tên hàm | File | Làm gì | Người viết | Ngày |
|---|---|---|---|---|
| `main()` | `init-admin.js` | Tạo phòng ban, Quản trị viên đầu tiên, ghi nhật ký; in mật khẩu tạm một lần | TuanThanh05 | 26/11/2026 |
