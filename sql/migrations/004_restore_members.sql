-- =====================================================================
-- DB 업데이트 4 (6단계): 백업 복원(새 장부로), 구성원 정보
--
-- 실행: Supabase SQL Editor에 이 파일 전체를 붙여넣고 Run (한 번만, 다시 실행해도 안전)
-- 002·003을 아직 실행하지 않았다면 먼저 실행하세요.
-- 처음 설치하는 경우에는 schema.sql에 이미 들어 있으므로 실행하지 않아도 됩니다.
-- =====================================================================

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
    insert into public.transactions (id, ledger_id, txn_date, memo, kind, source, recurring_id,
                                     is_deleted, deleted_at, created_by, updated_by, created_at, updated_at)
    values (v_tid, v_ledger, (v_t->>'txn_date')::date, coalesce(v_t->>'memo', ''),
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

-- 장부 구성원 목록 (이메일 포함) — 같은 장부 구성원만 볼 수 있음
create or replace function public.ledger_members_info(p_ledger_id uuid)
returns table (user_id uuid, email text, role text, joined_at timestamptz, is_me boolean)
language plpgsql stable security definer
set search_path = ''
as $$
begin
  perform private.require_member(p_ledger_id);
  return query
    select m.user_id, u.email::text, m.role, m.joined_at, m.user_id = auth.uid()
      from public.ledger_members m
      join auth.users u on u.id = m.user_id
     where m.ledger_id = p_ledger_id
     order by m.role = 'owner' desc, m.joined_at;
end;
$$;

-- 스키마 버전 4
create or replace function public.schema_version()
returns integer
language sql immutable
set search_path = ''
as $$ select 4; $$;

revoke all on function public.restore_ledger(text, jsonb) from public, anon;
grant execute on function public.restore_ledger(text, jsonb) to authenticated;
revoke all on function public.ledger_members_info(uuid) from public, anon;
grant execute on function public.ledger_members_info(uuid) to authenticated;
grant execute on function public.schema_version() to anon, authenticated;
