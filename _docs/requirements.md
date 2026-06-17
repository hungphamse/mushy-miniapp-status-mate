# Org Chart — Requirements (CHỐT)

> Chốt từ trao đổi với sếp Huy / anhdqvn 2026-05-17. Đây là spec đã xác nhận, đọc trước khi code.
> Mini-app slug `status-mate` → schema `app_status_mate`. Repo: `mushy-miniapp-orgchart`.

---

## 0. Bối cảnh & quyết định nền

- Không dùng roster phức tạp. Định danh dựa trên **họ tên thật + chức danh + SĐT** user tự khai khi join company, **squad lead/company admin** đối chiếu khi duyệt vào squad.
- **Scope theo workspace, độc lập hoàn toàn.** Mỗi workspace = 1 cây org chart riêng, dữ liệu cách ly bằng `workspace_id` (RLS `workspace_isolation` chuẩn mini-app). Workspace "Bách Khoa" (toàn team khối) có cây riêng; workspace khối khác bật cùng mini-app sẽ có cây + positions hoàn toàn khác, không thấy nhau. Cùng 1 codebase, mỗi workspace 1 bản đồ.
- "Company admin" ↔ **workspace owner/admin** (role trong `public.workspace_members`). Promote admin đã có sẵn ở superapp (`setCompanyMemberRole` + workspace `wsm_update_admin`).
- Việc chia 2 khối:
  - **KHỐI A — Core/Shell (superapp)**: thu thập tên/chức danh/SĐT + gate. Ship qua OTA `eas update --channel preview` → `production`. KHÔNG nằm trong repo này.
  - **KHỐI B — mini-app `status-mate`** (repo này): squads, positions, membership, allocation, org chart viz.

---

## 1. KHỐI A — Core/Shell (superapp, repo khác — ghi ở đây để tham chiếu)

| # | Yêu cầu |
|---|---|
| A1 | Core migration `020`: `public.user_profiles` thêm `full_name text`, `job_title text`, `work_phone text`. Giữ `display_name` cũ (không repurpose). |
| A2 | Cả 3 đường join company (request to join / Code / QR) thêm form bắt buộc 3 trường trên. |
| A3 | Validate SĐT regex VN `^0\d{9}$` (10 số, bắt đầu `0`). **Không** OTP/verify. |
| A4 | Catch-up gate: user đã ở company nhưng **bất kỳ 1 trong 3** trường (`full_name`/`job_title`/`work_phone`) null → lần mở app kế tiếp **chặn vào app**, ép màn nhập đủ 3. Tái dùng cơ chế onboarding step 'profile' (`superapp/app/onboarding.js`) — hiện gate theo `display_name`, mở rộng. |
| A5 | Ship: `eas update --channel preview` (test build preview nội bộ) → `--channel production`. `runtimeVersion=appVersion` → sửa JS OK qua OTA, không cần rebuild native. |
| A6 | Visibility cross-user trong workspace: helper workspace-mate (superapp mig 004) phải expose thêm `full_name`/`job_title`/`work_phone` để status-mate đọc người khác. |

---

## 2. KHỐI B — Mini-app `status-mate` (repo này)

### 2.1 Squads

| # | Yêu cầu |
|---|---|
| S1 | **Workspace owner/admin** CRUD squads (tạo/sửa/archive). Trước mắt là anhdqvn; sẽ thêm admin khác. |
| S2 | Squad có cây phân cấp (`parent_id` self-ref) → visualize org chart. |
| S3 | Mỗi squad có **introduction (goals)** dạng text. Sửa được bởi: squad lead của squad đó **HOẶC** workspace admin. |
| S4 | **Squad lead bắt buộc do workspace admin gán** (không tự ứng cử, không qua request). 1 squad 1 lead (nullable đến khi gán). |

### 2.2 Positions (vai trò chức năng — cấp workspace)

| # | Yêu cầu |
|---|---|
| P1 | Workspace admin **CRUD positions** ở cấp workspace, áp dụng chung mọi squad trong workspace. |
| P2 | Seed mặc định: **Product, Tech, Design, QC, Ops**. |
| P3 | **"Other" = nhập text tự do** (không phải row trong bảng positions). |

### 2.3 Squad members & ra/vào

| # | Yêu cầu |
|---|---|
| M1 | Member của company (= member workspace) **thấy danh sách tất cả squads** kèm lead, members, position, %allocation. Mọi người xem được hết (read trong workspace). |
| M2 | Member **request to join** / **request to leave** squad. |
| M3 | **Squad lead** (hoặc workspace admin) là người **approve/reject** join/leave request. |
| M4 | Khi request join, **member tự set %allocation** của mình trong squad **và** chọn **position** (từ list positions hoặc "Other" free text). |
| M5 | Tổng allocation các squad của 1 người **có thể ≠ 100%**. Khi ≠ 100% → **noti cảnh báo** cho chính user (không chặn, chỉ nhắc). |
| M6 | Squad lead cũng là 1 dòng member của squad (kind='lead'), có position + allocation của riêng họ. |

### 2.4 Visualize org chart

| # | Yêu cầu |
|---|---|
| V1 | Cây các squads (theo `parent_id`). Mobile WebView → cây dọc collapse/expand (không sơ đồ ngang rộng). |
| V2 | Mỗi squad node: lead + members, kèm **position** + **%allocation** từng người. |
| V3 | **Highlight over/under allocation**: người có Σallocation > 100% (over, đỏ) hoặc < 100% (under, amber). Tô ở mọi vị trí người đó xuất hiện. |

---

## 3. Ngoài phạm vi (chốt KHÔNG làm giai đoạn này)

- Không verify SĐT (không OTP/SMS).
- Không roster import.
- Không scope theo `company_id` (scope theo `workspace_id`).
- Không repurpose `display_name`.
- Không squad cross-workspace (1 squad ⊂ 1 workspace).

---

## 4. Sub-phase (mỗi cái ship/demo độc lập — an toàn)

| Sub | Scope | Phụ thuộc |
|---|---|---|
| **0** | KHỐI A (core mig 020 + onboarding form + catch-up gate) → OTA preview | superapp repo, trước Sub-2 |
| **1** | squads + positions + squad_members; admin CRUD squads/positions, gán lead; **xem cây org chart** + allocation highlight | — (demo 19/05) |
| **2** | join/leave requests; lead approve; member set allocation+position; cảnh báo Σ≠100% | cần A1–A4 (tên thật để lead đối chiếu) |
| **3** | intro/goals editor; squad_events log; viz polish; deeplink SĐT (gọi/Zalo) | Sub-2 |

> Nếu Sub sau chậm → launch vẫn an toàn vì Sub-1 read-only sống độc lập.
