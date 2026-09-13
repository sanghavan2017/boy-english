create or replace function public.bump_usage(p_user uuid, p_date date, p_limit int)
returns table(allowed boolean, new_count int)
language plpgsql
security definer set search_path = public
as $$
declare
  v_count int;
begin
  insert into public.usage_daily (user_id, usage_date, count)
  values (p_user, p_date, 1)
  on conflict (user_id, usage_date)
  do update set count = usage_daily.count + 1
  returning usage_daily.count into v_count;

  return query select (v_count <= p_limit), v_count;
end;
$$;

revoke execute on function public.bump_usage(uuid, date, int) from public, anon;
grant execute on function public.bump_usage(uuid, date, int) to service_role;
