-- =====================================================================
-- status-mate · 012 · Status Reason + Source
--
-- Mở rộng member_statuses:
--   • status CHECK mở rộng → Phase 2 sẵn sàng (in_meeting, do_not_disturb)
--   • 5 cột mới: reason, source, set_by_user_id, custom_reason_text, previous_status
--   • idx_ms_source index cho Phase 2 host-set queries
--
-- set_my_status RPC được viết lại (signature mở rộng):
--   • drop old 4-param → tránh PostgREST overload ambiguity
--   • create new 6-param (p_reason, p_custom_reason_text DEFAULT NULL)
--   • auto-derive reason nếu không truyền vào
--   • source luôn = 'self', set_by_user_id = auth.uid() cho self-set
--
-- Phase 2 sẽ thêm set_status_for_member (host-controlled) riêng.
-- =====================================================================

-- ─────────────────────────────────────────────────────────────────────
-- 1. Mở rộng CHECK constraint 'status'
--    Tên auto-generated của PostgreSQL: member_statuses_status_check
-- ─────────────────────────────────────────────────────────────────────
alter table app_status_mate.member_statuses
  drop constraint if exists member_statuses_status_check;

alter table app_status_mate.member_statuses
  add constraint member_statuses_status_check
  check (status in ('available','busy','focus','in_meeting','do_not_disturb'));

-- ─────────────────────────────────────────────────────────────────────
-- 2. Thêm cột reason
--    NULL = chưa set / available. CHECK explicit để migration idempotent.
-- ─────────────────────────────────────────────────────────────────────
alter table app_status_mate.member_statuses
  add column if not exists reason text
    constraint member_statuses_reason_check
    check (
      reason is null
      or reason in ('manual_focus','manual_busy','meeting_room','deadline','break','custom')
    );

-- ─────────────────────────────────────────────────────────────────────
-- 3. Thêm cột source
--    DEFAULT 'self' — hàng cũ chưa có source sẽ thấy 'self' tự động.
-- ─────────────────────────────────────────────────────────────────────
alter table app_status_mate.member_statuses
  add column if not exists source text not null default 'self'
    constraint member_statuses_source_check
    check (source in ('self','host','system_timer','meeting_sync'));

-- ─────────────────────────────────────────────────────────────────────
-- 4. Thêm cột set_by_user_id
--    Ai đã set trạng thái này (auth.uid() hoặc host). Phase 2 dùng.
-- ─────────────────────────────────────────────────────────────────────
alter table app_status_mate.member_statuses
  add column if not exists set_by_user_id uuid references auth.users(id);

-- ─────────────────────────────────────────────────────────────────────
-- 5. Thêm cột custom_reason_text
--    Chỉ có nghĩa khi reason = 'custom'. Giới hạn 60 ký tự.
-- ─────────────────────────────────────────────────────────────────────
alter table app_status_mate.member_statuses
  add column if not exists custom_reason_text text
    constraint member_statuses_custom_reason_text_check
    check (custom_reason_text is null or char_length(custom_reason_text) <= 60);

-- ─────────────────────────────────────────────────────────────────────
-- 6. Thêm cột previous_status
--    Snapshot status cũ dạng JSON — Phase 3 dùng để auto-restore
--    sau khi meeting kết thúc. Không expose ra UI ở Phase 1.
-- ─────────────────────────────────────────────────────────────────────
alter table app_status_mate.member_statuses
  add column if not exists previous_status jsonb;

-- ─────────────────────────────────────────────────────────────────────
-- 7. Index cho Phase 2 host-set queries
-- ─────────────────────────────────────────────────────────────────────
create index if not exists idx_ms_source
  on app_status_mate.member_statuses (org_group_id, source);

-- ─────────────────────────────────────────────────────────────────────
-- 8. Drop old set_my_status (4-param signature)
--    Bắt buộc drop trước khi tạo lại — PostgreSQL không cho create or
--    replace function khi số param thay đổi (khác signature = overload
--    mới). PostgREST sẽ báo lỗi "Could not find the function" khi có
--    2 overload cùng tên. Drop + create sạch hơn.
-- ─────────────────────────────────────────────────────────────────────
drop function if exists app_status_mate.set_my_status(uuid, text, text, timestamptz);

-- ─────────────────────────────────────────────────────────────────────
-- 9. Tạo lại set_my_status với 6 param (2 param cuối DEFAULT NULL)
-- ─────────────────────────────────────────────────────────────────────
create function app_status_mate.set_my_status(
  p_group_id            uuid,
  p_status              text,
  p_message             text         default null,
  p_until               timestamptz  default null,
  p_reason              text         default null,
  p_custom_reason_text  text         default null
)
returns void
language plpgsql
security definer
set search_path = app_status_mate
as $$
declare
  v_ws     uuid;
  v_until  timestamptz;
  v_reason text;
  v_custom text;
begin
  -- Auth check
  if not app_status_mate.is_org_group_member(p_group_id) then
    raise exception 'Bạn không thuộc org group này';
  end if;

  -- Validate status (bao gồm cả giá trị Phase 2 để DB nhất quán)
  if p_status not in ('available','busy','focus','in_meeting','do_not_disturb') then
    raise exception 'Status không hợp lệ: %', p_status;
  end if;

  -- Validate message length
  if p_message is not null and char_length(p_message) > 200 then
    raise exception 'Message quá dài (tối đa 200 ký tự)';
  end if;

  -- Resolve workspace (origin ws của group)
  v_ws := app_status_mate._group_origin_ws(p_group_id);

  -- Normalize expires_at: bỏ qua nếu đã quá hạn
  v_until := p_until;
  if v_until is not null and v_until <= now() then
    v_until := null;
  end if;

  -- Auto-derive reason nếu caller không truyền vào
  v_reason := p_reason;
  if v_reason is null then
    case p_status
      when 'available'  then v_reason := null;
      when 'focus'      then v_reason := 'manual_focus';
      when 'busy'       then v_reason := 'manual_busy';
      when 'in_meeting' then v_reason := 'meeting_room';
      else                   v_reason := null;
    end case;
  end if;

  -- Validate reason enum
  if v_reason is not null
    and v_reason not in ('manual_focus','manual_busy','meeting_room','deadline','break','custom')
  then
    raise exception 'Reason không hợp lệ: %', v_reason;
  end if;

  -- custom_reason_text chỉ lưu khi reason = 'custom'; strip và limit 60 chars
  v_custom := null;
  if v_reason = 'custom' then
    v_custom := nullif(btrim(coalesce(p_custom_reason_text, '')), '');
    if v_custom is not null and char_length(v_custom) > 60 then
      raise exception 'Custom reason quá dài (tối đa 60 ký tự)';
    end if;
  end if;

  -- Upsert (unique: org_group_id, user_id)
  insert into app_status_mate.member_statuses
    (workspace_id, org_group_id, user_id,
     status, message, status_until,
     reason, source, set_by_user_id, custom_reason_text,
     created_by)
  values
    (v_ws, p_group_id, auth.uid(),
     p_status,
     nullif(btrim(coalesce(p_message, '')), ''),
     v_until,
     v_reason, 'self', auth.uid(), v_custom,
     auth.uid())
  on conflict (org_group_id, user_id)
  do update set
    status             = excluded.status,
    message            = excluded.message,
    status_until       = excluded.status_until,
    reason             = excluded.reason,
    source             = 'self',
    set_by_user_id     = auth.uid(),
    custom_reason_text = excluded.custom_reason_text,
    updated_at         = now();
end $$;

grant execute on function app_status_mate.set_my_status(uuid, text, text, timestamptz, text, text) to authenticated;
