-- =====================================================================
-- DB 업데이트 3 (4단계): 월별 요약 (대시보드 그래프용)
--
-- 실행: Supabase SQL Editor에 이 파일 전체를 붙여넣고 Run (한 번만, 다시 실행해도 안전)
-- 002를 아직 실행하지 않았다면 002를 먼저 실행하세요.
-- 처음 설치하는 경우에는 schema.sql에 이미 들어 있으므로 실행하지 않아도 됩니다.
-- =====================================================================

-- 월별 요약: 최근 p_months개월(p_end가 속한 달까지) 각각의
--   수입·지출(그 달 합계), 월말 자산·부채·순자산(그 달 말일까지 누계)
-- p_end: 기준일 (기기의 오늘 날짜를 넘김 — 서버 시간대와 무관하게)
create or replace function public.monthly_summary(
  p_ledger_id  uuid,
  p_months     integer default 12,
  p_end        date    default null
)
returns table (
  month        text,      -- 'YYYY-MM'
  month_end    date,
  income       bigint,
  expense      bigint,
  assets       bigint,
  liabilities  bigint,
  net_worth    bigint
)
language sql stable security invoker
set search_path = ''
as $$
  with params as (
    select date_trunc('month', coalesce(p_end, current_date))::date as last_month,
           least(greatest(coalesce(p_months, 12), 1), 120) as n
  ),
  months as (
    select (p.last_month - make_interval(months => g))::date as m
      from params p, generate_series(0, p.n - 1) as g
  ),
  ln as (
    select t.txn_date, a.type, l.debit, l.credit
      from public.lines l
      join public.transactions t on t.id = l.transaction_id
      join public.accounts a     on a.id = l.account_id
     where l.ledger_id = p_ledger_id
       and not t.is_deleted
  ),
  agg as (
    select mo.m,
           coalesce(sum(ln.credit - ln.debit) filter (
             where ln.type = 'income' and ln.txn_date >= mo.m and ln.txn_date < mo.m + interval '1 month'), 0) as income,
           coalesce(sum(ln.debit - ln.credit) filter (
             where ln.type = 'expense' and ln.txn_date >= mo.m and ln.txn_date < mo.m + interval '1 month'), 0) as expense,
           coalesce(sum(ln.debit - ln.credit) filter (
             where ln.type = 'asset' and ln.txn_date < mo.m + interval '1 month'), 0) as assets,
           coalesce(sum(ln.credit - ln.debit) filter (
             where ln.type = 'liability' and ln.txn_date < mo.m + interval '1 month'), 0) as liabilities
      from months mo
      left join ln on ln.txn_date < mo.m + interval '1 month'
     group by mo.m
  )
  select to_char(m, 'YYYY-MM'),
         (m + interval '1 month' - interval '1 day')::date,
         income::bigint, expense::bigint, assets::bigint, liabilities::bigint,
         (assets - liabilities)::bigint
    from agg
   order by m;
$$;

-- 스키마 버전 3
create or replace function public.schema_version()
returns integer
language sql immutable
set search_path = ''
as $$ select 3; $$;

revoke all on function public.monthly_summary(uuid, integer, date) from public, anon;
grant execute on function public.monthly_summary(uuid, integer, date) to authenticated;
grant execute on function public.schema_version() to anon, authenticated;
