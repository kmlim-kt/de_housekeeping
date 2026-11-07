-- =====================================================================
-- DB 업데이트 5: 거래 시각(시:분)과 시간순 정렬
--
-- 실행: Supabase SQL Editor에 이 파일 전체를 붙여넣고 Run (한 번만, 다시 실행해도 안전)
-- 002~004를 아직 실행하지 않았다면 먼저 실행하세요.
-- 처음 설치하는 경우에는 schema.sql에 이미 들어 있으므로 실행하지 않아도 됩니다.
-- (이 파일은 tools/make-migration-005.mjs 가 schema.sql에서 만들었습니다)
-- =====================================================================

-- 전표에 시각 열 추가 (기존 전표는 비어 있음 = 그날 맨 앞으로 정렬)
alter table public.transactions add column if not exists txn_time time(0);

-- 매개변수·결과 모양이 바뀌는 함수는 예전 것을 지우고 다시 만듦
drop function if exists public.create_transaction(uuid, uuid, date, text, text, text, jsonb, uuid, date);
drop function if exists public.update_transaction(uuid, date, text, text, jsonb, timestamptz);
drop function if exists public.search_transactions(uuid, date, date, uuid, text, bigint, bigint, boolean, integer, integer);
drop function if exists public.account_ledger(uuid, date, date);

create or replace function public.create_transaction(
  p_id              uuid,
  p_ledger_id       uuid,
  p_date            date,
  p_memo            text,
  p_kind            text,
  p_source          text,
  p_lines           jsonb,
  p_recurring_id    uuid default null,
  p_recurring_date  date default null,  -- 반복 거래 등록 시: 등록하려는 예정일
  p_time            time default null   -- 거래 시각 (없으면 null)
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid  uuid := private.require_member(p_ledger_id);
  v_rec  public.recurring%rowtype;
begin
  if p_id is null then
    raise exception '전표 id가 필요합니다.' using errcode = '22023';
  end if;

  -- 중복 전송 처리
  if exists (select 1 from public.transactions where id = p_id) then
    if exists (select 1 from public.transactions where id = p_id and ledger_id = p_ledger_id) then
      return p_id;
    end if;
    raise exception '이미 사용 중인 전표 id입니다.' using errcode = '23505';
  end if;

  -- 반복 거래에서 등록하는 경우: 예정일이 맞는지 확인하고 다음 예정일로 넘김
  -- (두 기기에서 같은 건을 동시에 등록하는 것을 막음)
  if p_recurring_id is not null then
    select * into v_rec from public.recurring
      where id = p_recurring_id and ledger_id = p_ledger_id for update;
    if not found then
      raise exception '반복 거래를 찾을 수 없습니다.' using errcode = '22023';
    end if;
    if v_rec.next_date is distinct from p_recurring_date then
      raise exception '이미 등록했거나 건너뛴 반복 거래입니다.' using errcode = '40001';
    end if;
    update public.recurring
       set next_date = private.next_occurrence(next_date, freq, interval_n, day_of_month),
           is_active = case
             when end_date is not null
              and private.next_occurrence(next_date, freq, interval_n, day_of_month) > end_date
             then false else is_active end
     where id = p_recurring_id;
  end if;

  insert into public.transactions
    (id, ledger_id, txn_date, txn_time, memo, kind, source, recurring_id, created_by, updated_by)
  values
    (p_id, p_ledger_id, p_date, date_trunc('minute', p_time::interval)::time, coalesce(p_memo, ''),
     coalesce(p_kind, 'manual'), coalesce(p_source, 'advanced'), p_recurring_id, v_uid, v_uid);

  perform private.insert_lines(p_id, p_ledger_id, p_lines);

  insert into public.audit_log (ledger_id, transaction_id, action, after, changed_by)
  values (p_ledger_id, p_id, 'create', private.transaction_snapshot(p_id), v_uid);

  return p_id;
end;
$$;

create or replace function public.update_transaction(
  p_id                   uuid,
  p_date                 date,
  p_memo                 text,
  p_kind                 text,
  p_lines                jsonb,
  p_expected_updated_at  timestamptz default null,
  p_time                 text default null
)
returns timestamptz
language plpgsql security definer
set search_path = ''
as $$
declare
  v_txn     public.transactions%rowtype;
  v_uid     uuid;
  v_before  jsonb;
begin
  select * into v_txn from public.transactions where id = p_id for update;
  if not found then
    raise exception '전표를 찾을 수 없습니다.' using errcode = '22023';
  end if;
  v_uid := private.require_member(v_txn.ledger_id);

  if v_txn.is_deleted then
    raise exception '휴지통에 있는 전표는 수정할 수 없습니다. 먼저 복원하세요.' using errcode = '22023';
  end if;
  if p_expected_updated_at is not null and v_txn.updated_at <> p_expected_updated_at then
    raise exception '다른 기기에서 먼저 수정한 전표입니다. 새로 불러온 뒤 다시 수정하세요.'
      using errcode = '40001';
  end if;

  v_before := private.transaction_snapshot(p_id);

  update public.transactions
     set txn_date = p_date, memo = coalesce(p_memo, ''), kind = coalesce(p_kind, kind),
         txn_time = case when p_time is null then txn_time
                         when p_time = '' then null
                         else date_trunc('minute', p_time::time::interval)::time end,
         updated_by = v_uid, updated_at = clock_timestamp()
   where id = p_id;

  delete from public.lines where transaction_id = p_id;
  perform private.insert_lines(p_id, v_txn.ledger_id, p_lines);

  insert into public.audit_log (ledger_id, transaction_id, action, before, after, changed_by)
  values (v_txn.ledger_id, p_id, 'update', v_before, private.transaction_snapshot(p_id), v_uid);

  return (select updated_at from public.transactions where id = p_id);
end;
$$;

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
  p_offset      integer default 0,
  p_order       text    default 'desc'
)
returns table (
  id           uuid,
  txn_date     date,
  txn_time     time,
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
  select f.id, f.txn_date, f.txn_time, f.memo, f.kind, f.source, f.created_by, f.updated_by,
         f.created_at, f.updated_at, f.deleted_at, f.total,
         coalesce((select jsonb_agg(jsonb_build_object(
                     'account_id', l.account_id, 'debit', l.debit, 'credit', l.credit,
                     'memo', l.memo, 'line_no', l.line_no) order by l.line_no)
                     from public.lines l where l.transaction_id = f.id), '[]'::jsonb),
         count(*) over ()
    from filtered f
   order by
     -- 오름차순일 때만 앞의 세 기준이 쓰이고, 내림차순이면 이 세 값이 모두 null이라 뒤의 기준이 쓰임
     case when p_order = 'asc' then f.txn_date end asc,
     case when p_order = 'asc' then coalesce(f.txn_time, '00:00'::time) end asc,
     case when p_order = 'asc' then f.created_at end asc,
     f.txn_date desc, coalesce(f.txn_time, '00:00'::time) desc, f.created_at desc, f.id
   limit least(greatest(coalesce(p_limit, 50), 1), 500)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

create or replace function public.account_ledger(
  p_account_id uuid, p_from date default null, p_to date default null)
returns table (
  transaction_id   uuid,
  txn_date         date,
  txn_time         time,
  memo             text,
  kind             text,
  debit            bigint,
  credit           bigint,
  running_balance  bigint,
  counter_accounts text,      -- 상대 계정 이름들
  opening_balance  bigint     -- 기간 시작 전 잔액 (모든 행에 같은 값)
)
language sql stable security invoker
set search_path = ''
as $$
  with acc as (
    select id from public.accounts where id = p_account_id or parent_id = p_account_id
  ),
  sgn as (
    select case when type in ('asset', 'expense') then 1 else -1 end as s
      from public.accounts where id = p_account_id
  ),
  opening as (
    select coalesce(sum(l.debit - l.credit), 0)::bigint as v
      from public.lines l
      join public.transactions t on t.id = l.transaction_id
     where l.account_id in (select id from acc)
       and not t.is_deleted
       and p_from is not null and t.txn_date < p_from
  ),
  txns as (
    select t.id, t.txn_date, t.txn_time, t.created_at, t.memo, t.kind,
           sum(l.debit)::bigint as d, sum(l.credit)::bigint as c
      from public.lines l
      join public.transactions t on t.id = l.transaction_id
     where l.account_id in (select id from acc)
       and not t.is_deleted
       and (p_from is null or t.txn_date >= p_from)
       and (p_to   is null or t.txn_date <= p_to)
     group by t.id, t.txn_date, t.txn_time, t.created_at, t.memo, t.kind
  )
  -- 같은 날은 시각 순(시각 없는 전표는 그날 맨 앞), 같은 시각은 입력 순
  select r.id, r.txn_date, r.txn_time, r.memo, r.kind, r.d, r.c,
         ((o.v + sum(r.d - r.c) over (order by r.txn_date, coalesce(r.txn_time, '00:00'::time), r.created_at, r.id)) * g.s)::bigint,
         (select string_agg(distinct a2.name, ', ')
            from public.lines l2 join public.accounts a2 on a2.id = l2.account_id
           where l2.transaction_id = r.id and l2.account_id not in (select id from acc)),
         (o.v * g.s)::bigint
    from txns r cross join opening o cross join sgn g
   order by r.txn_date, coalesce(r.txn_time, '00:00'::time), r.created_at, r.id;
$$;

create or replace function public.restore_ledger(p_name text, p_data jsonb)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid      uuid := private.require_user();
  v_ledger   uuid;
  v_acc      jsonb;
  v_map      jsonb := '{}'::jsonb;    -- 옛 계정 id → 새 id
  v_rmap     jsonb := '{}'::jsonb;    -- 옛 반복 거래 id → 새 id
  v_new      uuid;
  v_t        jsonb;
  v_l        jsonb;
  v_tid      uuid;
  v_no       integer;
  v_tmpl     text;
  v_key      text;
  v_counts   jsonb;
  n_acc      integer := 0;
  n_txn      integer := 0;
  n_budget   integer := 0;
  n_rec      integer := 0;
  n_fav      integer := 0;
begin
  if p_data->>'format' is distinct from 'de-housekeeping-backup' then
    raise exception '가계부 백업 파일이 아닙니다.' using errcode = '22023';
  end if;
  if coalesce((p_data->>'version')::int, 0) <> 1 then
    raise exception '지원하지 않는 백업 파일 버전입니다.' using errcode = '22023';
  end if;
  if jsonb_typeof(p_data->'accounts') <> 'array' or jsonb_array_length(p_data->'accounts') = 0 then
    raise exception '백업 파일에 계정과목이 없습니다.' using errcode = '22023';
  end if;

  -- 장부 + 소유자 (기본 계정은 만들지 않음 — 백업의 계정을 그대로 씀)
  insert into public.ledgers (name, created_by)
  values (left(coalesce(nullif(trim(p_name), ''), '복원한 가계부'), 50), v_uid)
  returning id into v_ledger;
  insert into public.ledger_members (ledger_id, user_id, role) values (v_ledger, v_uid, 'owner');

  -- 계정: 상위 먼저, 하위 나중 (parent_id 연결)
  for v_acc in
    select a from jsonb_array_elements(p_data->'accounts') a
     order by (a->>'parent_id') is not null, coalesce((a->>'sort_order')::int, 0)
  loop
    insert into public.accounts (ledger_id, name, type, subtype, parent_id, is_hidden, is_system, sort_order, created_by)
    values (v_ledger, v_acc->>'name', v_acc->>'type', nullif(v_acc->>'subtype', ''),
            case when v_acc->>'parent_id' is null then null else (v_map->>(v_acc->>'parent_id'))::uuid end,
            coalesce((v_acc->>'is_hidden')::boolean, false), coalesce((v_acc->>'is_system')::boolean, false),
            coalesce((v_acc->>'sort_order')::int, 0), v_uid)
    returning id into v_new;
    v_map := v_map || jsonb_build_object(v_acc->>'id', v_new);
    n_acc := n_acc + 1;
  end loop;

  -- 반복 거래 (전표가 참조하므로 먼저). 틀 안의 계정 id를 새 id로 바꿈
  for v_t in select * from jsonb_array_elements(coalesce(p_data->'recurring', '[]'::jsonb)) loop
    v_tmpl := coalesce(v_t->'template', '{}'::jsonb)::text;
    for v_key in select jsonb_object_keys(v_map) loop
      v_tmpl := replace(v_tmpl, v_key, v_map->>v_key);
    end loop;
    insert into public.recurring (ledger_id, name, freq, interval_n, day_of_month, start_date, end_date,
                                  next_date, template, is_active, created_by)
    values (v_ledger, v_t->>'name', v_t->>'freq', coalesce((v_t->>'interval_n')::int, 1),
            (v_t->>'day_of_month')::int, (v_t->>'start_date')::date, (v_t->>'end_date')::date,
            (v_t->>'next_date')::date, v_tmpl::jsonb, coalesce((v_t->>'is_active')::boolean, true), v_uid)
    returning id into v_new;
    v_rmap := v_rmap || jsonb_build_object(v_t->>'id', v_new);
    n_rec := n_rec + 1;
  end loop;

  -- 전표 + 분개 라인 (차대 일치는 커밋 시점 트리거가 다시 검사)
  for v_t in select * from jsonb_array_elements(coalesce(p_data->'transactions', '[]'::jsonb)) loop
    v_tid := gen_random_uuid();
    insert into public.transactions (id, ledger_id, txn_date, txn_time, memo, kind, source, recurring_id,
                                     is_deleted, deleted_at, created_by, updated_by, created_at, updated_at)
    values (v_tid, v_ledger, (v_t->>'txn_date')::date, (nullif(v_t->>'txn_time', ''))::time, coalesce(v_t->>'memo', ''),
            coalesce(v_t->>'kind', 'manual'), coalesce(v_t->>'source', 'advanced'),
            (v_rmap->>(v_t->>'recurring_id'))::uuid,
            coalesce((v_t->>'is_deleted')::boolean, false), (v_t->>'deleted_at')::timestamptz,
            v_uid, v_uid, coalesce((v_t->>'created_at')::timestamptz, now()), now());
    v_no := 0;
    for v_l in select * from jsonb_array_elements(coalesce(v_t->'lines', '[]'::jsonb)) loop
      v_no := v_no + 1;
      if v_map->>(v_l->>'account_id') is null then
        raise exception '백업 파일의 전표(%)가 없는 계정을 가리킵니다.', v_t->>'txn_date' using errcode = '22023';
      end if;
      insert into public.lines (transaction_id, ledger_id, account_id, line_no, debit, credit, memo)
      values (v_tid, v_ledger, (v_map->>(v_l->>'account_id'))::uuid, v_no,
              coalesce((v_l->>'debit')::bigint, 0), coalesce((v_l->>'credit')::bigint, 0), coalesce(v_l->>'memo', ''));
    end loop;
    insert into public.audit_log (ledger_id, transaction_id, action, after, changed_by)
    values (v_ledger, v_tid, 'create', jsonb_build_object('restored_from_backup', p_data->>'exported_at'), v_uid);
    n_txn := n_txn + 1;
  end loop;

  -- 예산
  insert into public.budgets (ledger_id, account_id, month, amount)
  select v_ledger, (v_map->>(b->>'account_id'))::uuid, b->>'month', (b->>'amount')::bigint
    from jsonb_array_elements(coalesce(p_data->'budgets', '[]'::jsonb)) b
   where v_map ? (b->>'account_id');
  get diagnostics n_budget = row_count;

  -- 즐겨찾기 (틀 안의 계정 id 교체)
  for v_t in select * from jsonb_array_elements(coalesce(p_data->'favorites', '[]'::jsonb)) loop
    v_tmpl := coalesce(v_t->'template', '{}'::jsonb)::text;
    for v_key in select jsonb_object_keys(v_map) loop
      v_tmpl := replace(v_tmpl, v_key, v_map->>v_key);
    end loop;
    insert into public.favorites (ledger_id, name, template, sort_order, created_by)
    values (v_ledger, v_t->>'name', v_tmpl::jsonb, coalesce((v_t->>'sort_order')::int, 0), v_uid);
    n_fav := n_fav + 1;
  end loop;

  v_counts := jsonb_build_object('ledger_id', v_ledger, 'accounts', n_acc, 'transactions', n_txn,
                                 'budgets', n_budget, 'recurring', n_rec, 'favorites', n_fav);
  return v_counts;
end;
$$;

create or replace function public.schema_version()
returns integer
language sql immutable
set search_path = ''
as $$ select 5; $$;


-- 백업 파일(JSON)을 새 장부로 복원
--   계정·전표·반복 거래·즐겨찾기의 id는 모두 새로 만들고(원래 장부와 충돌 없음),
--   반복 거래·즐겨찾기 틀 안의 계정 id도 새 id로 바꿉니다.
--   전부 한 트랜잭션: 하나라도 잘못되면(차대 불일치 등) 아무것도 만들어지지 않습니다.
-- p_data 형식: { format: 'de-housekeeping-backup', version: 1, accounts: [...], transactions: [...],
--               budgets: [...], recurring: [...], favorites: [...] }
create or replace function public.restore_ledger(p_name text, p_data jsonb)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid      uuid := private.require_user();
  v_ledger   uuid;
  v_acc      jsonb;
  v_map      jsonb := '{}'::jsonb;    -- 옛 계정 id → 새 id
  v_rmap     jsonb := '{}'::jsonb;    -- 옛 반복 거래 id → 새 id
  v_new      uuid;
  v_t        jsonb;
  v_l        jsonb;
  v_tid      uuid;
  v_no       integer;
  v_tmpl     text;
  v_key      text;
  v_counts   jsonb;
  n_acc      integer := 0;
  n_txn      integer := 0;
  n_budget   integer := 0;
  n_rec      integer := 0;
  n_fav      integer := 0;
begin
  if p_data->>'format' is distinct from 'de-housekeeping-backup' then
    raise exception '가계부 백업 파일이 아닙니다.' using errcode = '22023';
  end if;
  if coalesce((p_data->>'version')::int, 0) <> 1 then
    raise exception '지원하지 않는 백업 파일 버전입니다.' using errcode = '22023';
  end if;
  if jsonb_typeof(p_data->'accounts') <> 'array' or jsonb_array_length(p_data->'accounts') = 0 then
    raise exception '백업 파일에 계정과목이 없습니다.' using errcode = '22023';
  end if;

  -- 장부 + 소유자 (기본 계정은 만들지 않음 — 백업의 계정을 그대로 씀)
  insert into public.ledgers (name, created_by)
  values (left(coalesce(nullif(trim(p_name), ''), '복원한 가계부'), 50), v_uid)
  returning id into v_ledger;
  insert into public.ledger_members (ledger_id, user_id, role) values (v_ledger, v_uid, 'owner');

  -- 계정: 상위 먼저, 하위 나중 (parent_id 연결)
  for v_acc in
    select a from jsonb_array_elements(p_data->'accounts') a
     order by (a->>'parent_id') is not null, coalesce((a->>'sort_order')::int, 0)
  loop
    insert into public.accounts (ledger_id, name, type, subtype, parent_id, is_hidden, is_system, sort_order, created_by)
    values (v_ledger, v_acc->>'name', v_acc->>'type', nullif(v_acc->>'subtype', ''),
            case when v_acc->>'parent_id' is null then null else (v_map->>(v_acc->>'parent_id'))::uuid end,
            coalesce((v_acc->>'is_hidden')::boolean, false), coalesce((v_acc->>'is_system')::boolean, false),
            coalesce((v_acc->>'sort_order')::int, 0), v_uid)
    returning id into v_new;
    v_map := v_map || jsonb_build_object(v_acc->>'id', v_new);
    n_acc := n_acc + 1;
  end loop;

  -- 반복 거래 (전표가 참조하므로 먼저). 틀 안의 계정 id를 새 id로 바꿈
  for v_t in select * from jsonb_array_elements(coalesce(p_data->'recurring', '[]'::jsonb)) loop
    v_tmpl := coalesce(v_t->'template', '{}'::jsonb)::text;
    for v_key in select jsonb_object_keys(v_map) loop
      v_tmpl := replace(v_tmpl, v_key, v_map->>v_key);
    end loop;
    insert into public.recurring (ledger_id, name, freq, interval_n, day_of_month, start_date, end_date,
                                  next_date, template, is_active, created_by)
    values (v_ledger, v_t->>'name', v_t->>'freq', coalesce((v_t->>'interval_n')::int, 1),
            (v_t->>'day_of_month')::int, (v_t->>'start_date')::date, (v_t->>'end_date')::date,
            (v_t->>'next_date')::date, v_tmpl::jsonb, coalesce((v_t->>'is_active')::boolean, true), v_uid)
    returning id into v_new;
    v_rmap := v_rmap || jsonb_build_object(v_t->>'id', v_new);
    n_rec := n_rec + 1;
  end loop;

  -- 전표 + 분개 라인 (차대 일치는 커밋 시점 트리거가 다시 검사)
  for v_t in select * from jsonb_array_elements(coalesce(p_data->'transactions', '[]'::jsonb)) loop
    v_tid := gen_random_uuid();
    insert into public.transactions (id, ledger_id, txn_date, txn_time, memo, kind, source, recurring_id,
                                     is_deleted, deleted_at, created_by, updated_by, created_at, updated_at)
    values (v_tid, v_ledger, (v_t->>'txn_date')::date, (nullif(v_t->>'txn_time', ''))::time, coalesce(v_t->>'memo', ''),
            coalesce(v_t->>'kind', 'manual'), coalesce(v_t->>'source', 'advanced'),
            (v_rmap->>(v_t->>'recurring_id'))::uuid,
            coalesce((v_t->>'is_deleted')::boolean, false), (v_t->>'deleted_at')::timestamptz,
            v_uid, v_uid, coalesce((v_t->>'created_at')::timestamptz, now()), now());
    v_no := 0;
    for v_l in select * from jsonb_array_elements(coalesce(v_t->'lines', '[]'::jsonb)) loop
      v_no := v_no + 1;
      if v_map->>(v_l->>'account_id') is null then
        raise exception '백업 파일의 전표(%)가 없는 계정을 가리킵니다.', v_t->>'txn_date' using errcode = '22023';
      end if;
      insert into public.lines (transaction_id, ledger_id, account_id, line_no, debit, credit, memo)
      values (v_tid, v_ledger, (v_map->>(v_l->>'account_id'))::uuid, v_no,
              coalesce((v_l->>'debit')::bigint, 0), coalesce((v_l->>'credit')::bigint, 0), coalesce(v_l->>'memo', ''));
    end loop;
    insert into public.audit_log (ledger_id, transaction_id, action, after, changed_by)
    values (v_ledger, v_tid, 'create', jsonb_build_object('restored_from_backup', p_data->>'exported_at'), v_uid);
    n_txn := n_txn + 1;
  end loop;

  -- 예산
  insert into public.budgets (ledger_id, account_id, month, amount)
  select v_ledger, (v_map->>(b->>'account_id'))::uuid, b->>'month', (b->>'amount')::bigint
    from jsonb_array_elements(coalesce(p_data->'budgets', '[]'::jsonb)) b
   where v_map ? (b->>'account_id');
  get diagnostics n_budget = row_count;

  -- 즐겨찾기 (틀 안의 계정 id 교체)
  for v_t in select * from jsonb_array_elements(coalesce(p_data->'favorites', '[]'::jsonb)) loop
    v_tmpl := coalesce(v_t->'template', '{}'::jsonb)::text;
    for v_key in select jsonb_object_keys(v_map) loop
      v_tmpl := replace(v_tmpl, v_key, v_map->>v_key);
    end loop;
    insert into public.favorites (ledger_id, name, template, sort_order, created_by)
    values (v_ledger, v_t->>'name', v_tmpl::jsonb, coalesce((v_t->>'sort_order')::int, 0), v_uid);
    n_fav := n_fav + 1;
  end loop;

  v_counts := jsonb_build_object('ledger_id', v_ledger, 'accounts', n_acc, 'transactions', n_txn,
                                 'budgets', n_budget, 'recurring', n_rec, 'favorites', n_fav);
  return v_counts;
end;
$$;

-- 권한: 로그인한 사용자만
revoke all on function public.create_transaction(uuid, uuid, date, text, text, text, jsonb, uuid, date, time) from public, anon;
grant execute on function public.create_transaction(uuid, uuid, date, text, text, text, jsonb, uuid, date, time) to authenticated;
revoke all on function public.update_transaction(uuid, date, text, text, jsonb, timestamptz, text) from public, anon;
grant execute on function public.update_transaction(uuid, date, text, text, jsonb, timestamptz, text) to authenticated;
revoke all on function public.search_transactions(uuid, date, date, uuid, text, bigint, bigint, boolean, integer, integer, text) from public, anon;
grant execute on function public.search_transactions(uuid, date, date, uuid, text, bigint, bigint, boolean, integer, integer, text) to authenticated;
revoke all on function public.account_ledger(uuid, date, date) from public, anon;
grant execute on function public.account_ledger(uuid, date, date) to authenticated;
revoke all on function public.restore_ledger(text, jsonb) from public, anon;
grant execute on function public.restore_ledger(text, jsonb) to authenticated;
grant execute on function public.schema_version() to anon, authenticated;
