# Org Chart — Architecture

> Đọc cùng `_docs/requirements.md` + `CLAUDE.md` (template rules). Schema `app_org_chart` (slug `org-chart`, dash→underscore).
> Mọi bảng: `workspace_id uuid not null` + RLS `workspace_isolation` + index `workspace_id`. Mọi query client `.eq('workspace_id', ctx.workspaceId)`.

---

## 1. Phân tầng trách nhiệm

| Tầng | Sở hữu | Repo |
|---|---|---|
| Identity (full_name/job_title/work_phone), gate app-open, RLS boundary `workspace_id`, workspace-mate visibility | **Core/Shell** | superapp (KHỐI A) |
| Squads (cây), positions, membership, allocation, requests, org chart viz | **mini-app `org-chart`** | repo này (KHỐI B) |

`org-chart` **đọc** `full_name`/`job_title`/`work_phone` của member cùng workspace qua `src/lib/members.js` (workspace-mate visibility, superapp mig 004 — cần mig 020 mở thêm 3 field). KHÔNG tự lưu identity.

---

## 2. Data model — schema `app_org_chart`

> Quy ước đặt tên tránh nhầm: **`kind`** = loại thành viên trong squad (`lead`|`member`); **`position`** = vai trò chức năng (Product/Tech/…); **`allocation`** = % phân bổ năng lực.

### 2.1 `squads` — cây org chart

```sql
create table if not exists app_org_chart.squads (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  parent_id     uuid references app_org_chart.squads(id) on delete set null,
  slug          text not null,
  name          text not null,
  intro         text,                          -- introduction / goals (S3)
  lead_user_id  uuid references auth.users(id),-- admin gán (S4), nullable
  status        text not null default 'active' check (status in ('active','archived')),
  created_by    uuid not null references auth.users(id),
  created_at    timestamptz not null default now(),
  archived_at   timestamptz,
  unique (workspace_id, slug)
);
create index if not exists idx_squads_ws on app_org_chart.squads (workspace_id);
create index if not exists idx_squads_ws_parent on app_org_chart.squads (workspace_id, parent_id);
```

### 2.2 `positions` — vai trò chức năng cấp workspace (admin CRUD)

```sql
create table if not exists app_org_chart.positions (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  name          text not null,
  is_system     boolean not null default false,-- seed Product/Tech/Design/QC/Ops
  sort_order    int not null default 0,
  created_by    uuid not null references auth.users(id),
  created_at    timestamptz not null default now(),
  unique (workspace_id, name)
);
create index if not exists idx_positions_ws on app_org_chart.positions (workspace_id);
```

"Other" KHÔNG là row — UI cho nhập tự do, lưu thẳng vào `squad_members.position` (text).

### 2.3 `squad_members` — thành viên + allocation + position

```sql
create table if not exists app_org_chart.squad_members (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  squad_id      uuid not null references app_org_chart.squads(id) on delete cascade,
  user_id       uuid not null references auth.users(id),
  kind          text not null default 'member' check (kind in ('lead','member')),
  position      text not null,                 -- tên position hoặc free text "Other"
  allocation    int  not null default 0 check (allocation between 0 and 100),
  joined_at     timestamptz not null default now(),
  left_at       timestamptz,                   -- null = đang trong squad
  created_by    uuid not null references auth.users(id)
);
create index if not exists idx_sm_ws on app_org_chart.squad_members (workspace_id);
create index if not exists idx_sm_ws_squad on app_org_chart.squad_members (workspace_id, squad_id);
create unique index if not exists uq_sm_active
  on app_org_chart.squad_members (squad_id, user_id) where left_at is null;
```

- Lead: 1 row `kind='lead'` tạo khi admin gán `squads.lead_user_id` (đồng bộ — xem RPC).
- Member: row `kind='member'` tạo khi join request được approve.
- Rời squad: set `left_at` (KHÔNG xoá row → giữ lịch sử / movement = logs).

### 2.4 `membership_requests` — request join/leave

```sql
create table if not exists app_org_chart.membership_requests (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references public.workspaces(id) on delete cascade,
  squad_id        uuid not null references app_org_chart.squads(id) on delete cascade,
  user_id         uuid not null references auth.users(id),
  type            text not null check (type in ('join','leave')),
  req_position    text,                         -- khi join (M4)
  req_allocation  int check (req_allocation between 0 and 100),
  message         text,
  status          text not null default 'pending'
                    check (status in ('pending','approved','rejected','cancelled')),
  decided_by      uuid references auth.users(id),
  decided_at      timestamptz,
  created_by      uuid not null references auth.users(id),
  created_at      timestamptz not null default now()
);
create index if not exists idx_mr_ws on app_org_chart.membership_requests (workspace_id);
create unique index if not exists uq_mr_pending
  on app_org_chart.membership_requests (squad_id, user_id) where status = 'pending';
```

### 2.5 `squad_events` — append-only log (movement = logs)

```sql
-- @realtime  (Sub-3: cây cập nhật live khi có người vào/ra)
create table if not exists app_org_chart.squad_events (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  squad_id      uuid references app_org_chart.squads(id) on delete cascade,
  actor_id      uuid references auth.users(id),
  subject_id    uuid references auth.users(id),
  type          text not null,                  -- joined|left|role_changed|lead_assigned|
                                                 -- squad_created|squad_archived|intro_updated|
                                                 -- request_created|request_decided
  payload       jsonb not null default '{}',
  created_by    uuid not null references auth.users(id),
  created_at    timestamptz not null default now()
);
create index if not exists idx_se_ws_created on app_org_chart.squad_events (workspace_id, created_at desc);
```

> RLS: tất cả bảng dùng `workspace_isolation` (template CLAUDE.md §3.2). Read mở cho mọi member workspace (M1: ai cũng xem được cây). Mutation kiểm soát qua RPC SECURITY DEFINER (mục 3) vì cần check role/lead — RLS một mình không phân biệt được "lead của squad X".

---

## 3. RPC (SECURITY DEFINER, search_path = app_org_chart, public)

Đặt trong migration. Mỗi RPC tự check quyền bằng `auth.uid()` + helper core `public.is_workspace_admin(ws)` / `public.is_workspace_member(ws)`.

| RPC | Quyền | Việc |
|---|---|---|
| `create_squad(ws, name, slug, parent_id, intro)` | workspace admin | insert squad + event `squad_created` |
| `update_squad(squad_id, name, intro, parent_id, status)` | workspace admin **hoặc** lead (chỉ `intro`) | update + event `intro_updated`/`squad_archived` |
| `assign_squad_lead(squad_id, user_id)` | workspace admin | set `squads.lead_user_id` + upsert `squad_members(kind='lead')` + event `lead_assigned` |
| `crud_position(...)` | workspace admin | CRUD `positions` (chặn xoá nếu đang dùng → để text vẫn còn ở member) |
| `request_membership(squad_id, type, position, allocation, message)` | member workspace | insert `membership_requests` + event `request_created` |
| `decide_membership(req_id, approve)` | lead của squad đó **hoặc** workspace admin | update request; nếu approve+join → insert `squad_members(kind='member')`; nếu approve+leave → set `left_at`; event `joined`/`left`/`request_decided` |
| `set_my_allocation(squad_id, allocation, position)` | chính member (đang trong squad) | update allocation/position của row mình (M4 cho phép tự chỉnh sau) |

**Không cần** service_role / mini-proxy cho các thao tác trên (toàn bộ trong schema `app_org_chart`). Push noti (Sub-3, báo lead có request / báo member được duyệt) mới đi qua `mushyApi.push()` → superapp mini-proxy, `data.appSlug='org-chart'` BẮT BUỘC.

---

## 4. Allocation logic (M5, V3)

- `totalAllocation(user) = Σ squad_members.allocation WHERE user_id = U AND left_at IS NULL AND workspace_id = ctx`.
- Client tính sau khi load. `≠ 100` → `useDialog().info(...)` cảnh báo (chỉ chính user, không chặn).
- Org chart viz: badge người — `>100` đỏ (over), `<100` amber (under), `=100` xanh. Highlight ở **mọi** node người đó xuất hiện.

---

## 5. Visualize (V1–V3)

- Build cây từ `squads.parent_id`. Render đệ quy, mobile = vertical collapsible (memory `feedback_pull_to_refresh` → pull-to-refresh bắt buộc; multi-tab dùng refreshKey).
- Node squad: tên + intro (collapsed) + lead (badge 👑) + list members (avatar + full_name + position + allocation badge).
- Avatar/tên: `listMembers(ctx.workspaceId)` / `getProfiles([...])` từ `src/lib/members.js` → dùng **full_name** (không hash-color fallback). Cần KHỐI A6 expose full_name.
- Design System Mushy: `useDialog`, component `Select` (KHÔNG `<select>` native, KHÔNG `alert/confirm`). Font tiếng Việt (template đã set Be Vietnam Pro).

---

## 6. Phụ thuộc & thứ tự build

```
KHỐI A (superapp) ── Sub-0: mig 020 + onboarding + gate → OTA preview
        │ (full_name/job_title/work_phone + visibility mig 020)
        ▼
KHỐI B Sub-1 ── squads/positions/squad_members + admin CRUD + gán lead + cây viz
        │        (KHÔNG phụ thuộc A — chạy được ngay, demo 19/05)
        ▼
KHỐI B Sub-2 ── membership_requests + decide + self allocation/position + cảnh báo Σ≠100
        │        (cần A1–A4: tên thật để lead đối chiếu khi approve)
        ▼
KHỐI B Sub-3 ── intro editor + squad_events log + viz polish + deeplink SĐT (bridge.tel)
```

Migration trong repo: `migrations/001_init_org_chart.sql` (squads/positions/squad_members + RLS + seed positions + RPC Sub-1), các Sub sau thêm `migrations/00X_*.sql`. Submit qua Admin Portal Reviewer (KHÔNG apply tay) — template CLAUDE.md §8.4.

---

## 7. Mở / cần chốt khi triển khai

- A6 (workspace-mate visibility expose full_name) là thay đổi core mig 020 — xác nhận field name khớp KHỐI A.
- Seed positions: tạo khi workspace lần đầu mở app, hay khi admin lần đầu vào tab quản trị? → đề xuất: idempotent seed trong RPC `create_squad` đầu tiên / lazy seed lần admin mở tab Positions.
- Lead bị gỡ (đổi lead khác): lead cũ thành `kind='member'` giữ allocation, hay set `left_at`? → đề xuất giữ thành member (lịch sử liền mạch), admin/lead mới quyết sau.
