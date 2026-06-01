-- status-mate · 009 · RPC get_users_companies (compatibility shim)
--
-- Mig 008 đã mở cross-ws org-group visibility. Mig 009 từng cố đọc trực
-- tiếp dữ liệu công ty dùng chung từ schema public, nhưng Admin Reviewer
-- không cho mini-app truy cập public.* trực tiếp.
--
-- Fix: giữ RPC này làm shim tương thích, nhưng không truy cập public.*.
-- Function trả rỗng để app vẫn chạy an toàn; company badges/job_title per
-- company sẽ không hiển thị cho tới khi có nguồn dữ liệu được quản lý bởi
-- schema của mini-app.
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
  select
    null::uuid as user_id,
    null::uuid as company_id,
    null::text as company_name,
    null::text as logo_url,
    null::text as job_title
  where false;
$$;
grant execute on function app_status_mate.get_users_companies(uuid[]) to authenticated;
