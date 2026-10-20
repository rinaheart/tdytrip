# TdyTripPWA2026 — Phase 0: Quy Trình Kiểm Định PoC GAS & Trạng Thái Nghiệm Thu

> [!CAUTION]
> **TRẠNG THÁI HIỆN TẠI: PHASE 0 CHƯA ĐÓNG — TUYỆT ĐỐI CHƯA SANG PHASE 1.**  
> - **Chrome Android**: Đã ĐẠT 5/5 trong phiên bản v0.1.0 (`type=cors`, `redirected=true`, `count=1`, `stale rev OK`, `tombstone OK`).  
> - **Safari iOS**: **CHƯA KIỂM THỬ**. Do cơ chế WebKit/Safari có thể có hành vi chuyển hướng 302 và CORS cookie khác biệt, dự án bắt buộc phải có kết quả nghiệm thu trên Safari iOS thực tế mới đủ điều kiện đóng Phase 0.

---

## 1. Nhật Ký & Danh Mục Cần Kiểm Thử Trên Safari iOS (Sẽ Thực Hiện)

Khi có thiết bị iOS, mở link triển khai trên Safari và chạy tuần tự các bài kiểm tra sau trong [poc/gas_test.html](file:///d:/Project/GAntigravity/Projects_Active/TdyCompany/TdyTripPWA2026/poc/gas_test.html):

| STT | Bài Kiểm Thử Trên Safari iOS | Điều Kiện ĐẠT (PASS) |
| :---: | :--- | :--- |
| **1** | **GET Ping, Token & CORS** | `res.ok === true`, đọc được JSON qua CORS, không bị chặn bởi WebKit ITP. |
| **2** | **Validation & Error Replay** | Gửi amount âm ⟶ Server trả `ERR_VALIDATION`. Gửi lại cùng `opId` ⟶ Replay đúng lỗi cũ, không mồ côi `PENDING_APPLY`. |
| **3** | **POST CREATE & ID Conflict** | Tạo bản ghi mới thành công (`rev = 1`). Cố tình gửi bản ghi trùng ID khác `opId` ⟶ Nhận đúng `ERR_ID_CONFLICT`. |
| **4** | **Concurrency & Stale Revision** | Client B sửa lên `rev = 2`. Client A sửa với `expectedRev = 1` ⟶ Bị từ chối `ERR_STALE_REV` kèm `currentRecord`. Replay thao tác cũ vẫn trả về lỗi cũ. |
| **5** | **DELETE Tombstone** | Xóa bản ghi với `expectedRev = 2` ⟶ Server đánh dấu `deleted = true, rev = 3`. |
| **6** | **Đo Đạc Latency (10 Lần)** | Ghi nhận thời gian `p50` và `p95` trên mạng di động iOS. |
| **7** | **Test Offline Thật (Airplane Mode)** | Bật chế độ máy bay ⟶ Bấm gửi ⟶ Bắt được lỗi mạng ⟶ Tắt chế độ máy bay ⟶ Gửi lại cùng `opId` ⟶ `count === 1`. |

Sau khi chạy xong, bấm **"Xuất Báo Cáo JSON"** trên Safari và lưu lại file báo cáo.

---

## 2. Thiết Lập Google Apps Script (Mã Mới v0.2.0-wal-sweep)

1. Mở Google Sheet dự án trên Google Drive.
2. Mở **Tiện ích mở rộng** ⟶ **Apps Script**.
3. Dán toàn bộ mã nguồn từ tệp [poc/Code.gs](file:///d:/Project/GAntigravity/Projects_Active/TdyCompany/TdyTripPWA2026/poc/Code.gs).
4. Cấu hình **Cài đặt dự án (Project Settings)** ⟶ **Các thuộc tính tập lệnh (Script Properties)**:
   - `POC_TOKEN`: Đặt một chuỗi bí mật (ví dụ: `tdy_secret_2026_xyz`). *Bắt buộc cấu hình để bảo vệ cả GET và POST.*
   - `DEBUG_CRASH_ENABLED`: Đặt `false` (mặc định tắt; chỉ bật `true` khi muốn thử nghiệm bài Test 6 mô phỏng crash server).
5. Nhấn **Triển khai (Deploy)** ⟶ **Triển khai mới (New deployment)**:
   - Loại: **Ứng dụng web (Web app)**.
   - Thực thi dưới dạng: **Tôi (Me)**.
   - Ai có quyền truy cập: **Bất kỳ ai (Anyone)**.
6. Sao chép Deployment URL (`https://script.google.com/macros/s/.../exec`).

> [!WARNING]
> **THU HỒI & ĐỔI URL (ROTATE DEPLOYMENT URL)**:  
> URL Web App cũ đã xuất hiện trong log/chat trước đây. Bạn **bắt buộc phải vào Deploy ⟶ Manage Deployments ⟶ Archive URL cũ** và tạo một Deployment URL mới tinh để ngăn chặn rò rỉ dữ liệu.

---

## 3. Kiến Trúc WAL Sweep & Idempotency v0.2.0

Phiên bản `v0.2.0-wal-sweep` giải quyết triệt để bài toán: **Client A gửi ghi nghiệp vụ xong nhưng server crash trước khi kịp ghi History ACKED ⟶ Client B vào cập nhật đè (`last_op_id` bị thay đổi) ⟶ Client A retry**.

- **Quy trình Sweep đầu request**:
  - Mỗi khi có bất kỳ request nào đến, sau khi có Lock, server quét toàn bộ dòng `PENDING_APPLY` trong History.
  - Nếu row nghiệp vụ tương ứng đã có dữ liệu khớp `opId` ⟶ Server chốt dòng đó thành `ACKED` kèm kết quả JSON.
  - Nếu row nghiệp vụ chưa có ⟶ Server đánh dấu `ABORTED`.
  - Nhờ vậy, dòng của A đã được chốt `ACKED` ngay trước khi B kịp ghi đè, loại bỏ 100% hiện tượng mất vết hoặc báo lỗi `ERR_STALE_REV` giả cho A.
- **Không để PENDING_APPLY mồ côi khi lỗi**:
  - Mọi nhánh từ chối nghiệp vụ (`ERR_STALE_REV`, `ERR_VALIDATION`, `ERR_ID_CONFLICT`, `ERR_NOT_FOUND`) đều lập tức cập nhật History dòng đó sang `REJECTED` kèm thông tin lỗi.
  - Khi retry cùng `opId`, server trả về đúng lỗi cũ đã lưu, bảo đảm tính Idempotent Replay.

---

## 4. Ghi Nhận Latency & Tác Động Lên Kiến Trúc Phase 3

- **Đo đạc thực tế trên Android**: Thời gian phản hồi trung bình dao động từ **2,0s đến 3,7s** cho mỗi lời gọi API qua GAS.
- **Tác động lên Hàng Đợi (FIFO Push)**:
  - Nếu người dùng offline và tạo 5–10 khoản chi liên tiếp, khi có mạng, việc đẩy tuần tự 10 request riêng lẻ sẽ mất **20–35 giây**.
  - Đây là thời gian chờ quá lâu trên thiết bị di động.
- **Quyết định kiến trúc cho Phase 3**:
  - Không đẩy đơn lẻ từng thao tác khi hàng đợi có nhiều hơn 1 phần tử.
  - Thiết kế endpoint **Batch Mutation**: Gộp toàn bộ mảng `pending_ops` vào 1 request POST duy nhất. Server lấy lock 1 lần, duyệt qua mảng trong 1 execution duy nhất, giảm tổng thời gian đồng bộ xuống còn ~3–4 giây.

---

## 5. Giới Hạn Kiến Trúc & Ranh Giới Bảo Mật

1. **Hiệu năng quét $O(N)$ trong RAM Apps Script**:
   - Quét mảng trong RAM (`getValues()`) đối với < 1.000 khoản chi mất < 50ms, hoàn toàn đáp ứng tốt nhu cầu du lịch nhóm.
   - Nếu dữ liệu > 5.000 dòng, thời gian đọc dữ liệu Sheets sẽ tiến gần đến giới hạn timeout 30s của GAS. Khi đó cần cơ chế lưu trữ phân trang hoặc database độc lập.
2. **Ranh giới bảo mật MVP**:
   - `actorId` được gửi từ client, mang tính định danh phân quyền mềm trong nhóm bạn tin cậy, không phải chứng thực mật mã RSA/JWT.
   - Khóa bảo vệ thực sự nằm ở `POC_TOKEN` ngăn truy cập từ bên ngoài.
