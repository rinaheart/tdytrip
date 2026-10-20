# TdyTripPWA2026 — Phase 0: Quy Trình Kiểm Định PoC GAS Thực Tế

> **Quy định nghiêm ngặt**: Chỉ khi toàn bộ 5 bài test trong công cụ PoC này đạt **PASS trên môi trường Vercel thực tế (cả Safari iOS và Chrome Android)**, dự án mới được phép bắt đầu Giai đoạn 1. Tuyệt đối không kiểm thử bằng giao thức `file://`.

---

## 1. Thiết Lập Google Apps Script (Backend)

1. Mở Google Sheet dự án trên Google Drive.
2. Mở **Tiện ích mở rộng** ⟶ **Apps Script**.
3. Dán toàn bộ mã nguồn từ tệp [poc/Code.gs](file:///d:/Project/GAntigravity/Projects_Active/TdyCompany/TdyTripPWA2026/poc/Code.gs).
4. Cấu hình **Cài đặt dự án (Project Settings)** ⟶ **Các thuộc tính tập lệnh (Script Properties)**:
   - `POC_TOKEN` (Khuyên dùng): Đặt một chuỗi bí mật (ví dụ: `tdy_secret_2026_xyz`). Nếu để trống, backend sẽ không kiểm tra token.
   - `DEBUG_CRASH_ENABLED`: Đặt `false` (mặc định tắt; chỉ bật `true` khi muốn thử nghiệm mô phỏng crash server).
5. Nhấn **Triển khai (Deploy)** ⟶ **Triển khai mới (New deployment)**:
   - Loại: **Ứng dụng web (Web app)**.
   - Thực thi dưới dạng: **Tôi (Me)**.
   - Ai có quyền truy cập: **Bất kỳ ai (Anyone)**.
6. Sao chép Deployment URL (`https://script.google.com/macros/s/.../exec`).

> [!WARNING]
> Nếu bạn đã từng public hoặc commit URL Web App cũ lên git/chat, hãy thu hồi (Archive) bản triển khai đó và tạo bản mới (Rotate URL) để bảo đảm an toàn.

---

## 2. Triển Khai Kiểm Thử Trực Tiếp (Không Dùng `file://`)

Trình duyệt đối xử với nguồn `file://` là `Origin: null`, có hành vi CORS khác hoàn toàn so với web app chạy trên domain HTTPS thực tế.

### Cách triển khai để kiểm thử trên Mobile:
1. Đưa thư mục `TdyTripPWA2026` lên GitHub và liên kết Vercel, hoặc dùng local HTTP server có HTTPS qua Cloudflare Tunnel / ngrok.
2. Truy cập đường dẫn: `https://<ten-mien-vercel>/poc/gas_test.html`.
3. Nhập URL GAS và Token bảo mật (được lưu an toàn vào `localStorage`, không hardcode vào mã nguồn).
4. Bấm **"Chạy Toàn Bộ Kiểm Thử (1 ⟶ 5)"**.

---

## 3. Nội Dung 5 Bài Test & Tiêu Chí Nghiệm Thu

| Bài Test | Kịch bản Kiểm Thử | Điều kiện ĐẠT (PASS) |
| :--- | :--- | :--- |
| **Test 1: GET Ping & CORS** | Gửi `GET ?action=ping` | Trình duyệt đọc được JSON, `res.ok === true`, `data.ok === true`, ghi nhận đúng thời gian phản hồi. |
| **Test 2: POST CREATE** | Gửi mutation tạo khoản chi mới với `opId_1` | Trả về `ok: true`, nhận đủ thực thể `record` (`rev = 1`, `created_op_id = opId_1`, `amount = 50000`). |
| **Test 3: Lost-Response & Idempotency Count** | Gửi `opId_2` bị ngắt client giữa chừng (mô phỏng timeout mất mạng) ⟶ Gửi lại CÙNG `opId_2` | Server trả về `{ ok: true, duplicate: true }` kèm đủ `record`. Gọi `GET ?action=count&opId=opId_2` **bắt buộc trả về đúng count = 1**, không được có 2 dòng trong Sheet. |
| **Test 4: Concurrency & Stale Revision** | Client B sửa bản ghi lên `rev = 2`. Client A (chưa cập nhật) cố tình sửa với `expectedRev = 1` | Server **bắt buộc từ chối** với lỗi `ERR_STALE_REV` và gửi kèm `currentRecord (rev = 2)` để Client A thấy. Replay op của B nhận `duplicate: true`. |
| **Test 5: DELETE Tombstone** | Gửi xóa bản ghi với `expectedRev = 2` | Server trả về `deleted = true, rev = 3`. Không xóa vật lý dòng trong Sheet để tránh làm mất vết đồng bộ. |

---

## 4. Giới Hạn Kiến Trúc Cần Biết

1. **Hiệu năng quét $O(N)$ trên Google Sheets**:
   - Backend sử dụng `getDataRange().getValues()` nạp mảng vào bộ nhớ RAM của Apps Script để quét tra cứu `opId` và `expectedRev`.
   - Đối với chuyến đi du lịch nhóm thông thường (< 1.000 khoản chi), thời gian quét mảng trong RAM mất < 50ms, hoàn toàn đáp ứng tốt.
   - Nếu dữ liệu vượt quá 5.000 dòng, thời gian đọc dữ liệu từ Sheets sẽ tiến gần đến giới hạn timeout 30 giây của Web App. Khi đó cần phương án lưu trữ cơ sở dữ liệu chuyên dụng hoặc lưu trữ phân trang.
2. **Bảo mật phân quyền mềm (Soft Permission)**:
   - Trong khuôn khổ MVP cho nhóm bạn tin cậy, định danh `actorId` được gửi từ client, không qua xác thực mật mã RSA/JWT.
   - `POC_TOKEN` đóng vai trò khóa bảo vệ cấp ứng dụng (Application Secret), ngăn chặn các truy cập ngoài nhóm.

---

## 5. Xuất Báo Cáo Nghiệm Thu

Sau khi chạy xong trên điện thoại, bấm nút **"Xuất Báo Cáo JSON"**:
- Tự động sao chép JSON kết quả chi tiết (gồm User-Agent, Origin, thời gian từng request, chi tiết response) vào Clipboard.
- Dán nội dung báo cáo này vào khung chat để làm căn cứ chính thức nghiệm thu Giai đoạn 0.
