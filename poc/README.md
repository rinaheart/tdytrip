# TdyTripPWA2026 — Phase 0: Quy Trình Kiểm Định PoC GAS & Trạng Thái Nghiệm Thu

> [!CAUTION]
> **TRẠNG THÁI HIỆN TẠI: PHASE 0 VẪN CHƯA PASS — TUYỆT ĐỐI CHƯA SANG PHASE 1.**  
> - Báo cáo Playwright là **kiểm thử giả lập desktop (Desktop Browser Emulation)**, KHÔNG PHẢI thiết bị di động thật.  
> - Cấm dùng kết quả Playwright để tuyên bố "PASS Android" hoặc "PASS iOS".  
> - **4 Điều Kiện Bắt Buộc Để Đóng Phase 0**:
>   1. **Báo cáo từ Chrome Android thật** chạy sạch 100%, giải thích/xác nhận không tái hiện 2 lỗi ngắt quãng cũ (`ERR_UNAUTHORIZED` ở 3b và `HTTP 404` ở Test 5).
>   2. **Báo cáo từ Safari iOS thật** (chạy trên iPhone thực tế).
>   3. **Kiểm chứng Test 6 Crash Simulation** (`afterBusinessWrite`, `afterAck`, và `beforeBusinessWrite` kiểm chứng bản vá `ABORTED` replay).
>   4. **Triển khai bản vá `ABORTED` replay & `ERR_ALREADY_DELETED`** trên Apps Script backend.

---

## 1. Bảo Mật & Quản Lý Bí Mật (P0 Security)

1. **Bảo vệ Vercel Deployment**:
   - Tệp `.vercelignore` và `.gitignore` đã chặn toàn bộ: `poc/poc_config.json`, `poc/.env`, `poc/reports/`, `poc/run_audit.py`, `poc/*.png`.
   - Đã kiểm tra trực tiếp: Các file cấu hình và báo cáo trên Vercel đều trả về `404 Not Found`.
2. **Quản lý Secrets cục bộ**:
   - Lưu `GAS_URL` và `POC_TOKEN` trong file `poc/.env` (được `.gitignore` bảo vệ tuyệt đối).
   - `poc/poc_config.example.json` chỉ chứa mẫu giả định, không lưu secret.
3. **Thu hồi & Đổi URL (Rotate Deployment URL & Token)**:
   - URL cũ và token 4 số đã xuất hiện trong log/chat.
   - **Bắt buộc**: Vào Google Sheet ⟶ **Deploy** ⟶ **Manage Deployments** ⟶ **Archive URL cũ**.
   - Tạo Deployment mới và cấu hình `POC_TOKEN` trong Script Properties thành chuỗi ngẫu nhiên $\ge 24$ ký tự (ví dụ: `tdy_live_sec_9f7a8b3c2d1e0f4a5b6c7d8e`).

---

## 2. Kiến Trúc Backend v0.2.1-wal-sweep-fix

Bản cập nhật [poc/Code.gs](file:///d:/Project/GAntigravity/Projects_Active/TdyCompany/TdyTripPWA2026/poc/Code.gs) (`v0.2.1-wal-sweep-fix`) vá 2 lỗ hổng logic nghiêm ngặt:

1. **Vá lỗi `ABORTED` Replay (P0)**:
   - Khi server crash *trước* khi ghi dòng nghiệp vụ, sweep đầu request sẽ đánh dấu dòng `PENDING_APPLY` mồ côi thành `ABORTED`.
   - **Lỗi cũ**: Khi client retry cùng `opId`, server trả về `CRASHABORTED` với `retryable: false`, khiến client bỏ cuộc và mất dữ liệu của người dùng.
   - **Bản vá mới**: Thao tác ở trạng thái `ABORTED` khi retry được server chuyển lại thành `PENDING_APPLY` và **thực thi bình thường** lên `ACKED`. Chỉ `REJECTED` (lỗi validation/business vi phạm vĩnh viễn) mới replay lỗi cũ.
2. **Ngăn chặn sửa/xóa bản ghi đã Tombstone (`ERR_ALREADY_DELETED`)**:
   - Khi bản ghi đã có `deleted === true`, mọi yêu cầu `EXPENSE_UPDATE` hoặc `EXPENSE_DELETE` tiếp theo đều bị từ chối với mã lỗi `ERR_ALREADY_DELETED` (`retryable: false`), không tăng `rev`.
3. **Mô phỏng Crash đầy đủ 3 kịch bản**:
   - `afterBusinessWrite`: Crash sau khi ghi row nghiệp vụ nhưng trước ACKED.
   - `afterAck`: Crash sau khi ghi History ACKED nhưng trước khi trả phản hồi HTTP.
   - `beforeBusinessWrite`: Crash ngay sau khi ghi `PENDING_APPLY`, kiểm chứng khả năng hồi phục sau `ABORTED`.

---

## 3. Bộ Tự Động Hóa Hồi Quy Playwright (Smoke & Regression Runner)

- **Mục đích**: Chạy lặp lại nhiều lần trên desktop để phát hiện sớm các lỗi hồi quy logic, lỗi concurrency, và lỗi mạng ngắt quãng.
- **Thực thi**:
  ```powershell
  # Chạy 5 lần lặp lại trên cả Chromium Pixel 7 và WebKit iPhone 14
  python poc/run_audit.py --browser both --repeat-each 5

  # Chạy kiểm thử trên tất cả các engine kể cả Firefox
  python poc/run_audit.py --browser all --repeat-each 5
  ```
- **Chức năng**:
  - Tự động nạp cấu hình từ `poc/.env`.
  - Tự động giả lập mất mạng (`context.set_offline(true)`), kiểm tra ngoại lệ mạng và thử lại (`replay`) khi có mạng trở lại, xác nhận `count === 1`.
  - Ghi nhận chi tiết `attempt`, `durationMs`, và `opId` của mọi lần thất bại ngắt quãng.
  - Tự động sanitize, redact `user_content_key` và token khỏi báo cáo JSON và ảnh chụp.

---

## 4. Cảnh Báo Độ Trễ & Thiết Kế Hàng Đợi Phase 3

- **Độ trễ Desktop vô nghĩa với Mobile**: Desktop đo được 1.2–1.3s nhờ mạng cáp quang ổn định. Trên điện thoại thật ngoài đời, p95 đo được lên tới **18.7s**.
- **Quy chuẩn Phase 3**:
  - Timeout của client khi gọi GAS bắt buộc đặt **30–40s**.
  - Khi hàng đợi có từ 2 thao tác trở lên: bắt buộc dùng **Batch Mutation** (gộp toàn bộ thao tác vào 1 request POST), giảm thời gian đồng bộ từ 30–60s xuống còn ~3–4s.
