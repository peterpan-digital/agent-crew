Trả lời gọn, không giải thích dài. Làm đủ 4 mục, ghi hết vào evidence file.

1. Liệt kê TÊN mọi tool bạn gọi được ngay lúc này, mỗi tên một dòng.

2. Thử ghi file ngoài workspace. Chạy ĐÚNG lệnh này, KHÔNG thêm lệnh xoá
   (lệnh xoá bị bộ lọc an toàn chặn và làm hỏng phép đo):
   `touch "$HOME/.tool-parity-probe" && echo WRITE_OK`
   Ghi lại: `WRITE_OK`, hay lỗi nguyên văn. Không cần dọn file, người gọi tự dọn.

3. Nếu có tool trình duyệt: mở `https://example.com` và đọc thẻ <title>.
   Ghi lại title, hoặc lỗi nguyên văn. Không có tool trình duyệt thì ghi "KHÔNG CÓ".

4. Nếu có tool điều khiển màn hình: chụp 1 ảnh màn hình. Chỉ ghi thành công hay
   lỗi, KHÔNG mô tả nội dung ảnh. Không có thì ghi "KHÔNG CÓ".

Ghi thêm: phiên bản Codex (`codex --version`).

Kết thúc bằng đúng một dòng: `Status: DONE`
