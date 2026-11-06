-- =====================================================================
-- DB 업데이트 2 (3단계): 거래 목록 검색 함수
--
-- 실행: Supabase SQL Editor에 이 파일 전체를 붙여넣고 Run (한 번만, 다시 실행해도 안전)
-- 처음 설치하는 경우에는 schema.sql에 이미 들어 있으므로 실행하지 않아도 됩니다.
-- =====================================================================

-- 전표 검색 (분개장 화면)
--   기간, 계정(상위 계정이면 하위 포함), 검색어(메모·계정 이름), 금액 범위(전표 합계), 휴지통 여부
--   결과마다 분개 라인(jsonb)과 전체 건수(total_count)를 함께 돌려줌
create or replace function public.search_transactions(
  p_ledger_id   uuid,
  p_from        date    default null,
  p_to          date    default null,
  p_account_id  uuid    default null,
  p_query       text    default null,
  p_min         bigint  default null,
  p_max         bigint  default null,
  p_deleted     boolean default false,
  p_limit       integer default 50,
  p_offset      integer default 0
)
returns table (
  id           uuid,
  txn_date     date,
  memo         text,
  kind         text,
  source       text,
  created_by   uuid,
  updated_by   uuid,
  created_at   timestamptz,
  updated_at   timestamptz,
  deleted_at   timestamptz,
  total        bigint,
  lines        jsonb,
  total_count  bigint
)
language sql stable security invoker
set search_path = ''
as $$
  with q as (
    -- 검색어의 % _ \ 는 글자 그대로 찾도록 처리
    select nullif(trim(coalesce(p_query, '')), '') as text,
           '%' || replace(replace(replace(trim(coalesce(p_query, '')), '\', '\\'), '%', '\%'), '_', '\_') || '%' as pattern
  ),
  base as (
    select t.*,
           (select coalesce(sum(l.debit), 0) from public.lines l where l.transaction_id = t.id)::bigint as total
      from public.transactions t, q
     where t.ledger_id = p_ledger_id
       and t.is_deleted = coalesce(p_deleted, false)
       and (p_from is null or t.txn_date >= p_from)
       and (p_to   is null or t.txn_date <= p_to)
       and (p_account_id is null or exists (
             select 1 from public.lines l join public.accounts a on a.id = l.account_id
              where l.transaction_id = t.id and (a.id = p_account_id or a.parent_id = p_account_id)))
       and (q.text is null
            or t.memo ilike q.pattern
            or exists (select 1 from public.lines l join public.accounts a on a.id = l.account_id
                        where l.transaction_id = t.id and a.name ilike q.pattern))
  ),
  filtered as (
    select * from base
     where (p_min is null or total >= p_min)
       and (p_max is null or total <= p_max)
  )
  select f.id, f.txn_date, f.memo, f.kind, f.source, f.created_by, f.updated_by,
         f.created_at, f.updated_at, f.deleted_at, f.total,
         coalesce((select jsonb_agg(jsonb_build_object(
                     'account_id', l.account_id, 'debit', l.debit, 'credit', l.credit,
                     'memo', l.memo, 'line_no', l.line_no) order by l.line_no)
                     from public.lines l where l.transaction_id = f.id), '[]'::jsonb),
         count(*) over ()
    from filtered f
   order by f.txn_date desc, f.created_at desc, f.id
   limit least(greatest(coalesce(p_limit, 50), 1), 500)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

-- 스키마 버전 2
create or replace function public.schema_version()
returns integer
language sql immutable
set search_path = ''
as $$ select 2; $$;

revoke all on function public.search_transactions(uuid, date, date, uuid, text, bigint, bigint, boolean, integer, integer) from public, anon;
grant execute on function public.search_transactions(uuid, date, date, uuid, text, bigint, bigint, boolean, integer, integer) to authenticated;
grant execute on function public.schema_version() to anon, authenticated;
