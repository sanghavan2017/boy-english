# Boy English — Backend, Auth & Billing (Giai đoạn A)

Ngày: 2026-09-13
Trạng thái: chờ duyệt

## 1. Bối cảnh & mục tiêu

App hiện tại (`index.html`, live tại `sanghavan2017.github.io/boy-english/`) là 1 file HTML tĩnh, gọi thẳng Claude API từ trình duyệt bằng key người dùng tự nhập. Mục tiêu của giai đoạn này:

1. Bỏ yêu cầu tự nhập Claude API key — vào app dễ nhất có thể
2. Kiểm soát chi phí API dù nhỏ — giới hạn lượt dùng/ngày cho user miễn phí
3. Tạo nền tảng kỹ thuật để thu phí (bản thân việc "tìm người trả tiền" là marketing, không thuộc phạm vi spec này)

**Ngoài phạm vi (giữ nguyên, không đổi):**
- Toàn bộ gamification (stars, streak, badges, lịch sử) — vẫn lưu localStorage theo thiết bị như hiện tại, **không** đồng bộ qua tài khoản. Đây là chọn có chủ đích để giữ scope nhỏ; đồng bộ đa thiết bị có thể làm sau nếu cần.
- ElevenLabs TTS và Whisper STT — vẫn là 2 ô key tuỳ chọn tự nhập như hiện tại (không bắt buộc, có Web Speech fallback). Không proxy qua backend ở giai đoạn này vì chúng không chặn onboarding (đã optional sẵn). Cân nhắc làm sau như một quyền lợi của gói premium (xem mục 8).
- Nội dung chương trình học (CURRICULUM_SGK/FUN/VUS/TOEIC), giao diện, chấm điểm — không đổi gì.

## 2. Kiến trúc

```
Trình duyệt (index.html tĩnh, GitHub Pages)
   │
   ├─ Supabase Auth (JS SDK qua CDN) ── đăng nhập bằng email magic link
   │
   └─ fetch → Supabase Edge Function "ai-proxy" (kèm access token)
                  │
                  ├─ xác thực token → lấy user
                  ├─ đọc/ghi bảng profiles + usage_daily (Postgres)
                  ├─ nếu free & đã hết lượt hôm nay → trả lỗi 429 thân thiện
                  └─ nếu còn lượt/premium → gọi Anthropic bằng key giữ
                     bí mật trong Supabase secrets → trả kết quả về app
```

Dùng lại project Supabase có sẵn `boyengish` (đang INACTIVE, cần reactivate) thay vì dựng hệ thống mới — vì nó gộp sẵn Auth + Postgres + Edge Functions, tránh phải ráp thêm 1 hệ đăng nhập riêng.

## 3. Auth — chỉ Email Magic Link cho MVP (không làm Google Sign-In ngay)

Bạn chọn "đăng nhập thật (email hoặc Google)" — đề xuất **bắt đầu bằng email magic link only**, thêm Google sau như bản nâng cấp. Lý do:

- Magic link không cần cấu hình gì bên ngoài Supabase, làm xong là chạy được ngay
- Google Sign-In cần tạo OAuth credentials trên Google Cloud Console, và **quan trọng hơn**: khi số người đăng nhập vượt quá ~100 tài khoản test, Google bắt buộc "publish" OAuth consent screen ra production — điều này yêu cầu có sẵn 1 trang Privacy Policy công khai. Đây là rào cản thật sự nếu muốn mở rộng ra ngoài nhóm nhỏ, không phải việc code thuần tuý.
- Email đã đủ để phụ huynh dùng — không mất tính năng cốt lõi ở bước MVP

→ Khi nào muốn mở rộng ra công khai + thêm Google, làm 1 việc riêng: viết trang Privacy Policy + đăng ký verify Google OAuth.

**Lưu ý vận hành:** Supabase free tier có email server dùng chung, giới hạn gửi rất thấp (vài email/giờ). Nếu vài phụ huynh đăng nhập cùng lúc, có thể có người không nhận được email link. Đề xuất cấu hình SMTP riêng miễn phí (Resend free tier — 3,000 email/tháng miễn phí) ngay từ đầu để tránh lỗi khó debug sau này.

## 4. Data model (Postgres, trong Supabase)

```sql
-- Tự tạo hồ sơ khi có user mới đăng ký (trigger, không cần code app)
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  plan text not null default 'free' check (plan in ('free','premium')),
  premium_until timestamptz,
  created_at timestamptz not null default now()
);

create table usage_daily (
  user_id uuid not null references auth.users(id) on delete cascade,
  usage_date date not null,  -- tính theo giờ Việt Nam (Asia/Ho_Chi_Minh), không phải UTC
  count int not null default 0,
  primary key (user_id, usage_date)
);
```

- **RLS bật trên cả 2 bảng.** Client chỉ được `SELECT` đúng hàng của chính mình (để hiển thị "còn X lượt hôm nay" trên UI nếu muốn). Không cho client `INSERT`/`UPDATE`/`DELETE` — mọi ghi nhận lượt dùng đều đi qua Edge Function (dùng service role, bỏ qua RLS). Tránh trường hợp user tự sửa `usage_daily` từ console trình duyệt để lách giới hạn.
- Trigger `on auth.users insert` tự tạo dòng `profiles` mặc định `plan='free'` — app không cần biết tới việc này.
- Reset lượt dùng: không cần cron job riêng — `usage_date` đổi ngày tự nhiên (giờ VN) là coi như lượt mới, không cần dọn dữ liệu cũ.

## 5. Edge Function `ai-proxy`

Input từ client: `{ system, messages, max_tokens }` — **giữ nguyên format hiện tại của app**, chỉ đổi nơi gửi tới. Giảm tối đa việc phải viết lại logic chọn chủ đề/curriculum ở client.

Luồng xử lý:
1. Lấy JWT từ header `Authorization`, xác thực qua Supabase → lấy `user_id`. Không hợp lệ → 401.
2. Đọc `profiles` của user. Nếu `plan='premium'` và `premium_until > now()` → bỏ qua bước đếm lượt (nhưng vẫn có 1 trần an toàn ẩn, ví dụ 500 lượt/ngày, chỉ để chặn lỗi phần mềm/lạm dụng bất thường — không phải giới hạn sản phẩm, không hiển thị cho user). Hai cột `plan` và `premium_until` luôn set cùng nhau khi nâng cấp (mục 6) — nếu `premium_until` trống hoặc đã qua hạn, user tự động rơi về giới hạn free mà không cần thao tác gì thêm (không cần cron dọn dẹp).
3. Nếu free: đọc/ghi `usage_daily` (ngày theo giờ VN). Nếu `count >= 18` → trả 429 kèm message rõ ràng để app hiển thị lời mời nâng cấp. Nếu chưa → tăng `count`, tiếp tục.
4. Gọi `https://api.anthropic.com/v1/messages` bằng `ANTHROPIC_API_KEY` lưu trong Supabase Edge Function secrets (server-to-server, **bỏ** header `anthropic-dangerous-direct-browser-access` vì không còn gọi từ browser nữa).
5. Trả JSON kết quả về client.

CORS: chỉ cho phép origin `https://sanghavan2017.github.io` gọi vào — chặn domain lạ gọi ké endpoint.

## 6. Nâng cấp Premium (thủ công)

Phụ huynh chuyển khoản/Momo → nhắn bạn → bạn vào **Supabase Table Editor** (giao diện có sẵn, miễn phí, không cần code) sửa trực tiếp dòng `profiles` của user đó: `plan='premium'`, `premium_until` = hôm nay + 30 ngày. Không cần xây trang admin riêng ở bước này — Table Editor đã đủ dùng cho vài chục khách đầu tiên.

## 7. Frontend — thay đổi trong `index.html`

- Thêm `<script src="supabase-js CDN">`.
- Màn hình setup: bỏ 2 ô key Claude, giữ 2 ô ElevenLabs/OpenAI tuỳ chọn như cũ. Thay bằng: ô nhập email + nút "Gửi link đăng nhập" → màn hình "Kiểm tra email của bạn".
- Lúc load app: kiểm tra session Supabase có sẵn (đã đăng nhập trước đó) → vào thẳng app, không hỏi lại.
- `askPika()`: đổi endpoint từ `api.anthropic.com` sang URL Edge Function, thêm header `Authorization: Bearer <access_token>`.
- Bắt riêng lỗi 429 (hết lượt) → hiển thị bubble thân thiện kiểu "Hết lượt miễn phí hôm nay rồi! Nâng cấp để học không giới hạn 🎉" thay vì bubble lỗi đỏ thông thường.
- Thêm nút "Đăng xuất" trong màn hình cài đặt.
- Gamification (`sess`, `global`, localStorage `be_*`) — **không đổi gì**.

## 8. Việc cân nhắc nhưng KHÔNG làm ở giai đoạn này (ghi lại để khỏi quên)

- **Proxy luôn ElevenLabs/Whisper qua backend** — có thể biến "giọng đọc tự nhiên + mic ổn định trên iPhone" thành quyền lợi riêng của gói premium (thay vì chỉ "không giới hạn lượt"), giúp gói trả phí hấp dẫn hơn. Đáng làm ở fast-follow sau khi Giai đoạn A chạy ổn, vì cần thêm 2 edge function xử lý audio (phức tạp hơn text).
- **Đồng bộ tiến độ học (stars/badges/streak) qua tài khoản** thay vì theo thiết bị — hữu ích nếu phụ huynh cho con học trên nhiều thiết bị, nhưng không cấp thiết.
- **Google Sign-In** — thêm khi cần mở rộng ra ngoài nhóm nhỏ (xem mục 3).
- **Trang admin riêng để duyệt nâng cấp** — chỉ cần khi số lượng khách nâng cấp nhiều đến mức Table Editor thủ công không xuể.

## 9. Việc cần làm thủ công (ngoài code, bạn hoặc tôi cần bạn xác nhận/thao tác)

- Reactivate project Supabase `boyengish` (project đang pause do free tier tự tạm dừng sau 1 tuần không hoạt động)
- Set secret `ANTHROPIC_API_KEY` trong Supabase — **nên xoay vòng (tạo key Anthropic mới) thay vì dùng lại key đang nằm plaintext trong `API console.txt`**, vì đây là dịp hợp lý để dọn key cũ
- Cấu hình SMTP riêng (Resend) cho Supabase Auth để magic link gửi ổn định
- Cấu hình Site URL / Redirect URL trong Supabase Auth trỏ về `sanghavan2017.github.io/boy-english/...`

## 10. Rollout & testing

- Build & test toàn bộ luồng tại 1 path riêng (tái sử dụng `/free/`, dọn code Gemini cũ đi) trước khi thay `index.html` gốc — không đụng bản đang live cho tới khi test xong.
- Test case tối thiểu trước khi cutover:
  1. Đăng ký mới → nhận magic link → đăng nhập → vào app không cần key nào
  2. Dùng hết 18 lượt/ngày → nhận đúng thông báo nâng cấp, không phải lỗi kỹ thuật
  3. Set `plan='premium'` thủ công cho tài khoản test → xác nhận không còn bị chặn lượt
  4. Gọi trực tiếp Edge Function từ domain khác (hoặc không kèm token) → bị từ chối đúng như thiết kế CORS/auth
  5. Test trên điện thoại thật (Android + iPhone nếu có) — luồng magic link qua email trên mobile browser hoạt động bình thường

## 11. Chi phí phát sinh

$0 thêm — toàn bộ nằm trong free tier Supabase (Auth, Postgres, Edge Functions đều dư dả ở quy mô vài chục–vài trăm user). Chi phí duy nhất vẫn là Claude API như hiện tại (~$3-8/tháng ở quy mô hiện tại), không đổi.
