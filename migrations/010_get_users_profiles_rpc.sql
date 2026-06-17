-- =====================================================================
-- status-mate · 010 · RPC get_users_basic_profiles (bypass RLS user_profiles)
--
-- Cùng pattern mig 009: cross-ws sharing → follower ws thấy user_ids của
-- origin ws members (qua mig 008 RLS group-scoped). NHƯNG public.user_profiles
-- RLS chỉ cho user thấy profile của user cùng workspace (superapp mig 004)
-- → follower fetch profile của origin members trả empty → personLabel
-- return "Ẩn danh".
--
-- Fix: SECURITY DEFINER RPC trả basic profile (full_name, avatar_url,
-- work_phone, work_email, personal_email) cho danh sách user_ids. Bypass
-- RLS. Trade-off: expose basic info cross-ws — acceptable vì cross-ws
-- sharing đã expose org chart công khai.
-- =====================================================================

create or replace function app_status_mate.get_users_basic_profiles(p_user_ids uuid[])
returns table (
  user_id        uuid,
  full_name      text,
  avatar_url     text,
  work_phone     text,
  work_email     text,
  personal_email text
)
language sql stable security definer set search_path = app_status_mate as $$
  select
    up.user_id,
    up.full_name,
    up.avatar_url,
    up.work_phone,
    up.work_email,
    up.personal_email
  from public.user_profiles up
  where up.user_id = any(p_user_ids);
$$;
grant execute on function app_status_mate.get_users_basic_profiles(uuid[]) to authenticated;
