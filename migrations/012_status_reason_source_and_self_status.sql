-- =====================================================================
-- status-mate · 012 · Status reason, source, and self-status RPC
--
-- This migration extends app_status_mate.member_statuses with metadata that
-- explains why a user is in a given status and who set it.
--
-- Adds:
--   • a wider status CHECK constraint
--   • reason / source / set_by_user_id / custom_reason_text / previous_status
--   • an index on (org_group_id, source) for host-set lookups
--
-- The self-status RPC is rewritten so callers can optionally pass a reason and
-- custom reason text, while the database keeps source and audit metadata in sync.
-- =====================================================================

-- ─────────────────────────────────────────────────────────────────────
-- 1. Expand the status CHECK constraint
--    PostgreSQL's auto-generated name is member_statuses_status_check.
-- ─────────────────────────────────────────────────────────────────────
alter table app_status_mate.member_statuses
  drop constraint if exists member_statuses_status_check;

alter table app_status_mate.member_statuses
  add constraint member_statuses_status_check
  check (status in ('available','busy','focus','in_meeting','do_not_disturb'));

-- ─────────────────────────────────────────────────────────────────────
-- 2. Add the reason column
--    NULL means "not set" or a plain available state.
-- ─────────────────────────────────────────────────────────────────────
alter table app_status_mate.member_statuses
  add column if not exists reason text
    constraint member_statuses_reason_check
    check (
      reason is null
      or reason in ('manual_focus','manual_busy','meeting_room','deadline','break','custom')
    );

-- ─────────────────────────────────────────────────────────────────────
-- 3. Add the source column
--    Default to 'self' so existing rows keep a sensible value.
-- ─────────────────────────────────────────────────────────────────────
alter table app_status_mate.member_statuses
  add column if not exists source text not null default 'self'
    constraint member_statuses_source_check
    check (source in ('self','host','system_timer','meeting_sync'));

-- ─────────────────────────────────────────────────────────────────────
-- 4. Add the set_by_user_id column
--    Records who last wrote the status row.
-- ─────────────────────────────────────────────────────────────────────
alter table app_status_mate.member_statuses
  add column if not exists set_by_user_id uuid references auth.users(id);

-- ─────────────────────────────────────────────────────────────────────
-- 5. Add the custom_reason_text column
--    Used only when reason = 'custom' and capped at 60 characters.
-- ─────────────────────────────────────────────────────────────────────
alter table app_status_mate.member_statuses
  add column if not exists custom_reason_text text
    constraint member_statuses_custom_reason_text_check
    check (custom_reason_text is null or char_length(custom_reason_text) <= 60);

-- ─────────────────────────────────────────────────────────────────────
-- 6. Add the previous_status column
--    Stores a JSON snapshot of the prior row so later restore flows can put
--    the user back where they were before an override.
-- ─────────────────────────────────────────────────────────────────────
alter table app_status_mate.member_statuses
  add column if not exists previous_status jsonb;

-- ─────────────────────────────────────────────────────────────────────
-- 7. Add an index for source-aware status queries
-- ─────────────────────────────────────────────────────────────────────
create index if not exists idx_ms_source
  on app_status_mate.member_statuses (org_group_id, source);

-- ─────────────────────────────────────────────────────────────────────
-- 8. Replace the old 4-parameter set_my_status function
--    PostgreSQL treats a changed parameter list as a new overload, so the old
--    signature must be removed before creating the new one.
-- ─────────────────────────────────────────────────────────────────────
drop function if exists app_status_mate.set_my_status(uuid, text, text, timestamptz);

-- ─────────────────────────────────────────────────────────────────────
-- 9. Recreate set_my_status with 6 parameters
--    The last two parameters are optional and default to NULL.
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
  -- Only org-group members can update their own status.
  if not app_status_mate.is_org_group_member(p_group_id) then
    raise exception 'Bạn không thuộc org group này';
  end if;

  -- Allow the full set of statuses supported by the app.
  if p_status not in ('available','busy','focus','in_meeting','do_not_disturb') then
    raise exception 'Status không hợp lệ: %', p_status;
  end if;

  -- Keep free-text status messages short.
  if p_message is not null and char_length(p_message) > 200 then
    raise exception 'Message quá dài (tối đa 200 ký tự)';
  end if;

  -- Resolve the group's source workspace.
  v_ws := app_status_mate._group_origin_ws(p_group_id);

  -- Ignore deadlines that are already in the past.
  v_until := p_until;
  if v_until is not null and v_until <= now() then
    v_until := null;
  end if;

  -- Infer a reason when the caller does not provide one.
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

  -- Enforce the supported reason values.
  if v_reason is not null
    and v_reason not in ('manual_focus','manual_busy','meeting_room','deadline','break','custom')
  then
    raise exception 'Reason không hợp lệ: %', v_reason;
  end if;

  -- Only persist custom_reason_text when reason = 'custom'.
  v_custom := null;
  if v_reason = 'custom' then
    v_custom := nullif(btrim(coalesce(p_custom_reason_text, '')), '');
    if v_custom is not null and char_length(v_custom) > 60 then
      raise exception 'Custom reason quá dài (tối đa 60 ký tự)';
    end if;
  end if;

  -- Upsert the current user's row.
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
