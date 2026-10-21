# Changelog

Tất cả các thay đổi đáng chú ý của dự án **TdyTrip PWA 2026** được ghi lại tại tệp này theo chuẩn [Keep a Changelog](https://keepachangelog.com/vi/1.0.0/).

## [0.2.0] - 2026-10-21

### Đã thêm
- **Giao diện phẳng tối giản (Flat UI 2 Tab)**:
  - Tab 1 "Chi tiêu": Thẻ tóm tắt tổng chi phí, danh sách khoản chi, nút xóa có xác nhận `confirm`, form modal thêm khoản chi hỗ trợ chia đều (`equal`) và chia theo phần (`shares`).
  - Tab 2 "Công nợ": Lưới số dư ròng từng thành viên (`positive`, `negative`, `zero`), danh sách đề xuất thanh toán tối ưu từ thuật toán Greedy Min-Cash-Flow.
- **Tiện ích sao chép độc lập**:
  - Tách 2 nút riêng biệt: "Copy STK" (chỉ lấy chuỗi số tài khoản) và "Copy nội dung CK" (cú pháp chuyển khoản đầy đủ).
  - Tự động fallback sao chép an toàn khi Clipboard API bị chặn trên trình duyệt.
  - Toast thông báo có cơ chế tự động xóa timeout (`clearTimeout`) chống đóng sớm.
- **Quyết toán nợ tức thì ("Đã trả")**:
  - Ghi nhận `Settlement` triệt tiêu công nợ giữa 2 người mà không làm biến động `totalTripExpense`.
- **Bộ nhận diện "Tôi là ai"**:
  - Cho phép người dùng chọn danh tính để làm nổi bật các khoản nợ của chính mình.
- **Hệ thống CSS Tokens phẳng**:
  - Border mảnh 1px, 1 màu chủ đạo xanh lam, cấm màu tím, Dark/Light tự động, `tabular-nums` định dạng số thẳng hàng.

## [0.1.0] - 2026-10-20

### Đã thêm
- **Lõi toán học thuần khiết (Pure Functional Math Engine - `src/core/math.js`)**:
  - Thuật toán chia đều với cơ chế xử lý số dư lẻ qua mã ký tự UTF-16 code unit.
  - Thuật toán chia theo trọng số (Largest Remainder Method) đảm bảo tổng phân bổ bằng chính xác 100% số tiền gốc.
  - Bộ tổng hợp số dư ròng `calculateBalances` có kiểm tra hợp lệ nghiêm ngặt (chặn âm thầm fallback khi sai `splitMethod`).
  - Thuật toán tối giản hóa dòng tiền Greedy Min-Cash-Flow bảo đảm $T \le n - 1$.
- **Bộ kiểm thử toàn diện**:
  - Đạt 27/27 bài test tự động bao gồm 1.000 test ngẫu nhiên (Property-based tests với Mulberry32 PRNG và Fisher-Yates unbiased shuffle).
