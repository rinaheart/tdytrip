# TdyTrip PWA 2026

Ứng dụng web tiến bộ (Progressive Web App) chia tiền chi phí nhóm và tối ưu hóa công nợ tức thì cho các chuyến đi du lịch, dã ngoại, sinh hoạt nhóm.

## Tính năng nổi bật

- **Giao diện phẳng tối giản (Flat Minimalist UI)**:
  - Thiết kế 1px border sắc sảo, không bóng đổ rườm rà.
  - Tự động chuyển đổi giao diện Sáng / Tối (Auto Dark / Light theme) theo cài đặt hệ điều hành.
  - Bảng màu xanh lam kỹ thuật tinh tế, chuẩn công thái học di động.
  - Áp dụng `tabular-nums` cho toàn bộ số tiền VND, giúp các chữ số thẳng hàng tuyệt đối.
- **Lõi toán học xác định & chính xác tuyệt đối (Deterministic Math Engine)**:
  - **Chia đều (Equal Split)**: Dư tiền lẻ ($R < n$) được phân bổ xác định theo thứ tự mã ký tự UTF-16 của mã thành viên.
  - **Chia theo phần (Shares Split)**: Áp dụng thuật toán Số dư Lớn nhất (Largest Remainder Method), phân bổ chính xác từng đồng VND, không làm mất xu lẻ.
  - **Tối ưu hóa công nợ (Greedy Min-Cash-Flow)**: Rút gọn vòng tròn nợ, đảm bảo số lượng giao dịch tối đa $T \le n - 1$.
  - Bảo toàn 5 bất biến toán học qua 1.000 property-based tests ngẫu nhiên.
- **Tiện ích chuyển khoản nhanh**:
  - Tách biệt 2 nút sao chép độc lập:
    - **Copy STK**: Chỉ sao chép duy nhất chuỗi số tài khoản ngân hàng (giữ nguyên số 0 ở đầu).
    - **Copy nội dung CK**: Sao chép cú pháp chuyển khoản đầy đủ `[TdyTrip] {người gửi} chuyen {người nhận} {số tiền}d`.
  - Nút **"Đã trả"**: Ghi nhận thanh toán quyết toán nợ tức thì mà không làm thay đổi tổng chi phí chuyến đi.
  - Lựa chọn **"Tôi là ai"**: Tự động làm nổi bật các khoản nợ cần trả hoặc cần thu của chính người dùng.

## Cấu trúc thư mục cốt lõi

```
TdyTripPWA2026/
├── index.html            # Khung ứng dụng chính (App Shell)
├── package.json          # Cấu hình dự án & scripts kiểm thử
├── .gitignore            # Quy chuẩn loại trừ các tệp nội bộ
├── .vercelignore         # Quy chuẩn loại trừ khi triển khai Vercel
├── README.md             # Tài liệu giới thiệu dự án
├── CHANGELOG.md          # Lịch sử cập nhật phiên bản
└── src/
    ├── app.js            # Khởi tạo & điều phối sự kiện DOM
    ├── styles.css        # Hệ thống giao diện phẳng & CSS tokens
    ├── core/
    │   └── math.js       # Lõi toán học thuần (Pure Functional Engine)
    └── ui/
        ├── state.js      # Trạng thái phản ứng trong bộ nhớ (In-Memory Reactive Store)
        └── components.js # Render HTML templates & tiện ích clipboard, toast
```

## Khởi chạy cục bộ

Ứng dụng được xây dựng hoàn toàn bằng chuẩn **Vanilla ES2020 Modules**, không phụ thuộc build tooling phức tạp:

```bash
# Chạy với bất kỳ static server nào (ví dụ: Live Server hoặc npx serve)
npx serve .
```

Mở trình duyệt tại địa chỉ hiển thị trên terminal (ví dụ: `http://localhost:3000`).

## Giấy phép

Dự án phát triển nội bộ bởi TdyCompany (2026).
