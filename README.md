# Org Chart — Mushy mini-app

Mini-app tổ chức nhân sự theo squad/dự án trong hệ Mushy. Slug `status-mate` → schema `app_status_mate`.

> 📐 **Spec đã chốt** — đọc trước khi code:
> - [`_docs/requirements.md`](./_docs/requirements.md) — yêu cầu đã xác nhận (chốt 2026-05-17, sếp Huy / anhdqvn)
> - [`_docs/architecture.md`](./_docs/architecture.md) — data model, RPC, RLS, sub-phase
> - [`CLAUDE.md`](./CLAUDE.md) — quy tắc kỹ thuật template (DB/RLS/security/dev-prod), KHÔNG vi phạm

## Tóm tắt

- **Workspace-scoped, độc lập**: mỗi workspace 1 cây org chart riêng (RLS `workspace_id`). Cùng codebase, mỗi workspace 1 bản đồ.
- **Squads**: workspace admin CRUD + gán squad lead; squad có introduction/goals.
- **Positions** (Product/Tech/Design/QC/Ops/Other): admin CRUD cấp workspace.
- **Members**: xem mọi squad; request join/leave; lead approve; member tự set %allocation + position; cảnh báo khi Σallocation ≠ 100%.
- **Org chart viz**: cây dọc collapse, highlight over/under allocation.
- Phần thu thập **họ tên thật / chức danh / SĐT** + gate nằm ở **superapp shell** (KHỐI A, OTA), KHÔNG trong repo này.

## Build theo sub-phase (ship độc lập)

| Sub | Scope |
|---|---|
| 0 | (superapp) core mig 020 + onboarding form + catch-up gate → OTA preview |
| 1 | squads + positions + members + admin CRUD + gán lead + cây viz (demo 19/05) |
| 2 | join/leave request + lead approve + self allocation/position + cảnh báo Σ≠100% |
| 3 | intro editor + event log + viz polish + deeplink SĐT |

## Quick start (local dev)

```bash
cp .env.example .env
npm install
npm run dev:setup   # Login Mushy + chọn workspace → ghi VITE_DEV_*
npm run dev         # localhost:5173
```

## Git flow

`main` = prod, `dev` = preview. Feature: branch `feat/<name>` → PR vào `dev` → merge `dev` → `main`. KHÔNG push thẳng `dev`/`main`.
