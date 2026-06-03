-- =====================================================================
-- sstatus-mate · 009 · RPC get_users_companies (bypass RLS company_members)
--
-- User: cross-ws sharing org_group → follower ws thấy members của origin
-- ws (qua mig 008 RLS group-scoped). NHƯNG company logo + job_title của
-- members ở org ws fetch qua public.company_members, RLS chỉ cho user
-- thấy member cùng company → follower (khác company) trả empty → không
-- có logo.
--
-- Fix: RPC SECURITY DEFINER lookup batch (user_ids[] → companies). Trade-off
-- security: expose company info (id, name, logo_url) của user bất kỳ cho
-- mọi authenticated. Acceptable — thông tin này cross-ws sharing đã hiển thị
-- công khai. Job_title cũng expose qua đây.
-- =====================================================================

create or replace function app_status_mate.get_users_companies(p_user_ids uuid[])
returns table (
  user_id      uuid,
  company_id   uuid,
  company_name text,
  logo_url     text,
  job_title    text
)
language sql stable security definer set search_path = app_status_mate as $$
  select cm.user_id, c.id, c.name, c.logo_url, cm.job_title
  from public.company_members cm
  join public.companies c on c.id = cm.company_id
  where cm.user_id = any(p_user_ids)
    and c.deleted_at is null;
$$;
grant execute on function app_status_mate.get_users_companies(uuid[]) to authenticated;