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
| `writeBlob`, `readBlob`, `deleteBlob` | `storage.js` | Ghi (file tạm rồi đổi tên, quyền 600), đọc, xóa bản mã trong kho theo tên UUID | TuanThanh05 | 26/11/2026 |
| `encryptFile(plain, aad)` | `crypto/envelope.js` | Mã hóa file AES-256-GCM bằng khóa riêng, bọc khóa bằng khóa chủ, tính SHA-256 | TuanThanh05 | 26/11/2026 |
| `decryptFile(input)` | `crypto/envelope.js` | Mở khóa, giải mã, kiểm tra thẻ GCM và SHA-256; sai thì ném `IntegrityError` | TuanThanh05 | 26/11/2026 |
| `sha256Hex(buf)` | `crypto/envelope.js` | Băm SHA-256 dạng hex | TuanThanh05 | 26/11/2026 |

## Middleware – `src/middlewares`

| Tên hàm | File | Làm gì | Người viết | Ngày |
|---|---|---|---|---|
| `authenticate(opts)` | `authenticate.js` | Xác thực cookie phiên, nạp người dùng/vai trò/quyền vào `req.user`; chặn khi còn bắt buộc đổi mật khẩu | TuanThanh05 | 26/11/2026 |
| `authorize(permissionCode)` | `authorize.js` | Kiểm tra quyền theo ma trận `role_permissions`, gắn `req.scope`; từ chối thì ghi nhật ký `ACCESS_DENIED` | TuanThanh05 | 26/11/2026 |
| `authorizeAny(...codes)` | `authorize.js` | Cho qua nếu có một trong các quyền (API chỉ đọc danh mục dùng chung) | TuanThanh05 | 26/11/2026 |
| `scopeFilter(req, cols)` | `authorize.js` | Sinh điều kiện WHERE theo phạm vi OWN / DEPARTMENT / ALL | TuanThanh05 | 26/11/2026 |
| `validate(schemas)` | `validate.js` | Kiểm tra body/query/params bằng zod, kết quả đặt vào `req.input` | TuanThanh05 | 26/11/2026 |
| `originCheck` | `originCheck.js` | Chặn request ghi có header Origin lạ (CSRF lớp 2) | TuanThanh05 | 26/11/2026 |
| `uploadSingle(field)` | `upload.js` | Nhận 1 file vào bộ nhớ, giới hạn dung lượng theo `MAX_FILE_SIZE_MB` | TuanThanh05 | 26/11/2026 |
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

## Module Catalog – `src/modules/catalog` (báo cáo 5.3, chức năng 4–5)

| Tên hàm | File | Làm gì | Người viết | Ngày |
|---|---|---|---|---|
| `listGroups()` | `service.js` | Danh sách nhóm hồ sơ kèm số loại, số nhãn hiệu lực | TuanThanh05 | 26/11/2026 |
| `createGroup(actor, body)` | `service.js` | Thêm nhóm (BM14): mã duy nhất, không sửa được | TuanThanh05 | 26/11/2026 |
| `updateGroup(actor, code, body)` | `service.js` | Sửa tên, mô tả nhóm | TuanThanh05 | 26/11/2026 |
| `deactivateGroup(actor, code)` | `service.js` | Ngừng sử dụng nhóm khi không còn nhãn hiệu lực | TuanThanh05 | 26/11/2026 |
| `activateGroup(actor, code)` | `service.js` | Mở lại nhóm đã ngừng sử dụng | TuanThanh05 | 26/11/2026 |
| `listTypes(query)` | `service.js` | Danh sách loại tài liệu kèm nhãn đang áp dụng; lọc nhóm, trạng thái, dùng được | TuanThanh05 | 26/11/2026 |
| `getType(code)` | `service.js` | Chi tiết loại tài liệu | TuanThanh05 | 26/11/2026 |
| `createType(actor, body)` | `service.js` | Thêm loại (BM15) trong nhóm đang sử dụng; chưa có nhãn nên chưa dùng được | TuanThanh05 | 26/11/2026 |
| `updateType(actor, code, body)` | `service.js` | Sửa tên, mô tả loại; không đổi nhóm, không đổi nhãn trực tiếp | TuanThanh05 | 26/11/2026 |
| `deactivateType(actor, code)` | `service.js` | Ngừng sử dụng loại; hồ sơ cũ giữ nguyên | TuanThanh05 | 26/11/2026 |
| `activateType(actor, code)` | `service.js` | Mở lại loại (nhóm phải đang sử dụng) | TuanThanh05 | 26/11/2026 |
| `toType(row)` | `service.js` | Dữ liệu loại tài liệu trả về client, có cờ `usable` | TuanThanh05 | 26/11/2026 |
| `listGroups`, `findGroup`, `insertGroup`, `updateGroup`, `setGroupStatus`, `countActiveLabelsInGroup` | `repo.js` | Truy vấn bảng `record_groups` | TuanThanh05 | 26/11/2026 |
| `listTypes`, `getType`, `findType`, `insertType`, `updateType`, `setTypeStatus` | `repo.js` | Truy vấn bảng `document_types` | TuanThanh05 | 26/11/2026 |

## Module Labels – `src/modules/labels` (báo cáo 5.3 chức năng 6–9, 5.4 chức năng 4–6, QT2)

| Tên hàm | File | Làm gì | Người viết | Ngày |
|---|---|---|---|---|
| `createProposal(actor, body)` | `service.js` | Lập đề xuất Tạo mới / Sửa / Ngừng áp dụng (BM02), lưu phiên bản Nháp | TuanThanh05 | 26/11/2026 |
| `updateProposal(actor, id, body)` | `service.js` | Sửa đề xuất Nháp/Bị từ chối, thay được danh sách loại tài liệu | TuanThanh05 | 26/11/2026 |
| `submitProposal(actor, id)` | `service.js` | Gửi Giám đốc: kiểm tra lại ràng buộc, Nháp → Chờ duyệt, báo Giám đốc | TuanThanh05 | 26/11/2026 |
| `withdrawProposal(actor, id)` | `service.js` | Rút đề xuất: Chờ duyệt → Nháp, báo Giám đốc | TuanThanh05 | 26/11/2026 |
| `approveProposal(actor, id)` | `service.js` | Phê duyệt: bản mới hiệu lực, bản cũ ngừng áp dụng, gắn loại theo bản mới, loại bị bỏ ra mất nhãn | TuanThanh05 | 26/11/2026 |
| `rejectProposal(actor, id, body)` | `service.js` | Từ chối có lý do 10–500 ký tự, báo người lập | TuanThanh05 | 26/11/2026 |
| `getVersion(id)` | `service.js` | Chi tiết phiên bản kèm so sánh với bản hiệu lực và cảnh báo rút ngắn | TuanThanh05 | 26/11/2026 |
| `listLabels()` | `service.js` | Danh sách nhãn, phiên bản hiệu lực, loại đang gắn, đề xuất đang mở | TuanThanh05 | 26/11/2026 |
| `getLabelHistory(code)` | `service.js` | Mọi phiên bản của nhãn kèm số hồ sơ đang gắn | TuanThanh05 | 26/11/2026 |
| `compareVersions(code, query)` | `service.js` | So sánh hai phiên bản bất kỳ theo từng trường | TuanThanh05 | 26/11/2026 |
| `listProposals(query)` | `service.js` | Danh sách đề xuất theo trạng thái | TuanThanh05 | 26/11/2026 |
| `checkRules(data)` | `service.js` | Kiểm tra luật BM02 phần B: T 1–100, mốc tính, N 1–365, tên sự kiện | TuanThanh05 | 26/11/2026 |
| `diffVersions(old, oldTypes, new, newTypes)` | `service.js` | Liệt kê trường khác nhau giữa hai phiên bản | TuanThanh05 | 26/11/2026 |
| `shorteningWarnings(...)` | `service.js` | Cảnh báo rút ngắn: T ngắn hơn, đổi mốc tính, kéo loại từ nhãn dài hơn; kèm số hồ sơ ảnh hưởng | TuanThanh05 | 26/11/2026 |
| `checkTypes(...)`, `revalidate(...)` | `service.js` | Kiểm tra loại tài liệu áp dụng; kiểm tra lại toàn bộ ràng buộc trước khi gửi/duyệt | TuanThanh05 | 26/11/2026 |
| `findLabel`, `insertLabel`, `renameLabel` | `repo.js` | Truy vấn bảng `retention_labels` | TuanThanh05 | 26/11/2026 |
| `getActiveVersion`, `getOpenVersion`, `nextVersionNo`, `insertVersion`, `getVersion`, `getVersionByNo`, `updateVersionFields`, `setVersionStatus`, `listVersionsOfLabel`, `listVersionsByStatus`, `listLabels` | `repo.js` | Truy vấn bảng `label_versions` | TuanThanh05 | 26/11/2026 |
| `getVersionTypes`, `addVersionTypes`, `removeVersionTypes`, `typesInOtherOpenProposals` | `repo.js` | Truy vấn bảng `label_version_document_types` (chỉ bỏ loại khi Nháp) | TuanThanh05 | 26/11/2026 |
| `findTypesByCodes`, `countTypesInUse`, `pointTypesToVersion`, `detachTypesFromVersion`, `currentVersionsOfTypes`, `countStoredRecordsOfTypes` | `repo.js` | Gắn/bỏ nhãn của loại tài liệu, đếm hồ sơ bị ảnh hưởng | TuanThanh05 | 26/11/2026 |

## Module Records – `src/modules/records` (báo cáo 5.1 chức năng 4–13, 5.2 chức năng 4–8, 5.3 chức năng 3; BM01, BM06, BM07, BM11)

| Tên hàm | File | Làm gì | Người viết | Ngày |
|---|---|---|---|---|
| `addYears(date, n)` | `retention.js` | Cộng năm theo lịch, 29/02 sang năm không nhuận lấy 28/02 | TuanThanh05 | 26/11/2026 |
| `fiscalYearEndFor(date, dd/mm)` | `retention.js` | Ngày kết thúc năm tài chính chứa ngày tài liệu | TuanThanh05 | 26/11/2026 |
| `computeExpiry(label, dates)` | `retention.js` | Tính mốc và ngày hết hạn: ngày lưu trữ / cuối năm tài chính / kết thúc sự kiện; Vĩnh viễn; Chưa xác định | TuanThanh05 | 26/11/2026 |
| `previewExpiry(query)` | `service.js` | Xem trước hạn lưu trữ dự kiến khi điền BM01 | TuanThanh05 | 26/11/2026 |
| `createRecord(actor, user, body)` | `service.js` | Tạo hồ sơ Đang sử dụng, sinh mã HS-; nhật ký không ghi tiêu đề | TuanThanh05 | 26/11/2026 |
| `updateRecord(actor, user, scope, code, body)` | `service.js` | Sửa hồ sơ (chỉ người tạo, khi Đang sử dụng); nhật ký trước/sau | TuanThanh05 | 26/11/2026 |
| `cancelRecord(actor, user, scope, code, body)` | `service.js` | Hủy bỏ hồ sơ tạo nhầm: xóa khóa mọi phiên bản, Đã hủy bỏ, xóa bản mã | TuanThanh05 | 26/11/2026 |
| `purgeBlobs(versions)` | `service.js` | Xóa bản mã đã mất khóa khỏi kho, đánh dấu `is_purged` | TuanThanh05 | 26/11/2026 |
| `getRecord(actor, user, scope, code)` | `service.js` | Chi tiết hồ sơ (ghi nhật ký lượt xem) | TuanThanh05 | 26/11/2026 |
| `loadDetail(conn, code)` | `service.js` | Gộp khai báo, nhãn, hạn lưu trữ, file + phiên bản, lịch sử xử lý | TuanThanh05 | 26/11/2026 |
| `uploadFile(actor, user, scope, code, file, opts)` | `service.js` | Tải file / phiên bản mới: nhận diện theo nội dung, đối chiếu đuôi, mã hóa, ghi kho rồi CSDL | TuanThanh05 | 26/11/2026 |
| `removeFile(actor, user, scope, code, fileId)` | `service.js` | Gỡ file khỏi danh sách đang dùng, giữ lịch sử | TuanThanh05 | 26/11/2026 |
| `getFileContent(actor, user, scope, code, fileId, query)` | `service.js` | Xem/tải file: giải mã, kiểm tra toàn vẹn; sai thì nhật ký + cảnh báo Quản trị, Giám đốc | TuanThanh05 | 26/11/2026 |
| `detectFormat(buf, name)`, `cleanFileName(name)` | `service.js` | Nhận diện PDF/DOCX/XLSX/JPG/PNG theo magic bytes; làm sạch tên file (UTF-8, bỏ đường dẫn) | TuanThanh05 | 26/11/2026 |
| `inScope`, `requireVisible`, `requireEditable`, `requireUsableType`, `checkDates` | `service.js` | Kiểm tra phạm vi dữ liệu, quyền sửa, loại tài liệu dùng được, ràng buộc ngày BM01 | TuanThanh05 | 26/11/2026 |
| `insertRecord`, `findRecord`, `getRecordDetail`, `updateRecord`, `cancelRecord`, `recordHistory` | `repo.js` | Truy vấn bảng `records` và lịch sử trong `audit_logs` | TuanThanh05 | 26/11/2026 |
| `insertFile`, `findFile`, `deactivateFile`, `countActiveFiles`, `listFiles` | `repo.js` | Truy vấn bảng `files` | TuanThanh05 | 26/11/2026 |
| `insertFileVersion`, `findFileVersion`, `nextFileVersionNo`, `destroyKeysOfRecord`, `markPurged` | `repo.js` | Truy vấn bảng `file_versions`; xóa khóa (hủy bằng mật mã) | TuanThanh05 | 26/11/2026 |
| `searchRecords` | `service.js` | Tra cứu hồ sơ theo BM07 trong phạm vi được xem, 20 dòng/trang | TuanThanh05 | 26/11/2026 |
| `loadRecordDetail` | `service.js` | Gộp chi tiết hồ sơ (dùng chung cho xem chi tiết và quy trình lưu trữ) | TuanThanh05 | 26/11/2026 |
| `submitRecord`, `withdrawRecord` | `workflow.js` | Gửi / rút yêu cầu lưu trữ; báo người duyệt (5.1 CN8, CN9) | TuanThanh05 | 26/11/2026 |
| `approveRecord` | `workflow.js` | Duyệt lưu trữ: gắn phiên bản nhãn, tính hạn chính thức (5.2 CN5–6, 5.3 CN3) | TuanThanh05 | 26/11/2026 |
| `rejectRecord` | `workflow.js` | Từ chối lưu trữ kèm lý do, trả hồ sơ về Đang sử dụng (5.2 CN7) | TuanThanh05 | 26/11/2026 |
| `listApprovals` | `workflow.js` | Hàng chờ duyệt lưu trữ của người đang đăng nhập (5.2 CN4) | TuanThanh05 | 26/11/2026 |
| `markRecordEnded` | `workflow.js` | Đánh dấu hết hiệu lực; nhãn theo sự kiện thì tính hạn (5.2 CN8, BM11) | TuanThanh05 | 26/11/2026 |
| `approverMode`, `notifyApprovers`, `requireApprover` | `workflow.js` | Xác định người duyệt tại thời điểm thao tác; báo người duyệt hoặc Quản trị hệ thống | TuanThanh05 | 26/11/2026 |
| `creatorIsDepartmentHead`, `departmentHeadOf` | `repo.js` | Người tạo có đang là Trưởng phòng; Trưởng phòng hiện tại của phòng | TuanThanh05 | 26/11/2026 |
| `setRecordStatus`, `markEnded` | `repo.js` | Chuyển trạng thái hồ sơ; ghi hết hiệu lực nghiệp vụ | TuanThanh05 | 26/11/2026 |
| `listPendingApprovals`, `searchRecords` | `repo.js` | Truy vấn hàng chờ duyệt; truy vấn tra cứu có lọc, sắp xếp, phân trang | TuanThanh05 | 26/11/2026 |

## Script – `scripts`

| Tên hàm | File | Làm gì | Người viết | Ngày |
|---|---|---|---|---|
| `main()` | `init-admin.js` | Tạo phòng ban, Quản trị viên đầu tiên, ghi nhật ký; in mật khẩu tạm một lần | TuanThanh05 | 26/11/2026 |
