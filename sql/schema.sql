-- =====================================================================
-- 복식부기 가계부 — Supabase(PostgreSQL) 스키마
-- 버전: 1
--
-- 실행 방법: Supabase 대시보드 → SQL Editor → 이 파일 전체를 붙여넣고 Run
-- 새 프로젝트에서 한 번만 실행합니다. (다시 실행하면 "already exists" 오류가 납니다)
--
-- 구성
--   1. 내부 스키마
--   2. 테이블 (장부·구성원·초대·계정·전표·분개·예산·반복·즐겨찾기·이력)
--   3. 구성원 판별 함수, 무결성 트리거 (계정 계층, 차대 일치 지연 검증, 예산 계정)
--   4. 내부 함수 (기본 계정 생성, 장부 생성, 신규 가입 트리거)
--   5. RPC (전표 생성·수정·삭제·복원·영구삭제, 반복 거래, 장부·초대)
--   6. 조회 함수·뷰 (잔액·시산표, 월별 손익, 원장, 장부 검증)
--   7. 인덱스
--   8. RLS 정책
--   9. 권한
--
-- 금액 규칙: 모든 금액은 원 단위 정수(bigint). 소수 금액은 거부됩니다.
-- 잔액 부호: 자산·비용 = 차변(+), 부채·순자산·수익 = 대변(+)
-- =====================================================================


-- =====================================================================
-- 1. 내부 스키마
-- =====================================================================

-- API로 노출되지 않는 내부 함수용 스키마
create schema if not exists private;


-- =====================================================================
-- 2. 테이블
-- =====================================================================

-- 장부: 가족이 함께 쓰는 하나의 가계부
create table public.ledgers (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 1 and 50),
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now()
);

-- 장부 구성원
create table public.ledger_members (
  ledger_id   uuid not null references public.ledgers(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        text not null default 'member' check (role in ('owner', 'member')),
  joined_at   timestamptz not null default now(),
  primary key (ledger_id, user_id)
);

-- 초대 코드: owner가 만들고, 받은 사람이 로그인 후 코드를 입력해 합류
create table public.ledger_invites (
  id          uuid primary key default gen_random_uuid(),
  ledger_id   uuid not null references public.ledgers(id) on delete cascade,
  code        text not null unique,
  email       text,                       -- 지정하면 그 이메일로 로그인한 사람만 사용 가능
  role        text not null default 'member' check (role in ('owner', 'member')),
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '7 days',
  used_by     uuid references auth.users(id) on delete set null,
  used_at     timestamptz
);

-- 계정과목 (2단계 계층: 상위 > 하위)
create table public.accounts (
  id          uuid primary key default gen_random_uuid(),
  ledger_id   uuid not null references public.ledgers(id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 30),
  type        text not null check (type in ('asset', 'liability', 'equity', 'income', 'expense')),
  -- 세부 분류: 간편 입력에서 선택지를 거르는 데 사용
  subtype     text check (subtype in ('cash', 'bank', 'savings', 'investment', 'receivable',
                                      'card', 'loan', 'payable', 'opening')),
  parent_id   uuid,
  is_hidden   boolean not null default false,
  is_system   boolean not null default false,   -- 기초 순자산 등 삭제 불가 계정
  sort_order  integer not null default 0,
  created_by  uuid references auth.users(id) on delete set null default auth.uid(),
  created_at  timestamptz not null default now(),
  unique (id, ledger_id),                       -- 복합 FK 대상 (같은 장부 강제)
  unique nulls not distinct (ledger_id, parent_id, name),
  -- 상위 계정도 같은 장부여야 함
  foreign key (parent_id, ledger_id) references public.accounts(id, ledger_id),
  check (parent_id is distinct from id)
);

-- 반복 거래 (전표 테이블이 참조하므로 먼저 생성)
create table public.recurring (
  id            uuid primary key default gen_random_uuid(),
  ledger_id     uuid not null references public.ledgers(id) on delete cascade,
  name          text not null check (char_length(name) between 1 and 50),
  freq          text not null check (freq in ('weekly', 'monthly', 'yearly')),
  interval_n    integer not null default 1 check (interval_n between 1 and 12),
  day_of_month  integer check (day_of_month between 1 and 31),  -- 매월·매년: 31 = 말일
  start_date    date not null,
  end_date      date,
  next_date     date not null,                 -- 다음 등록 예정일
  template      jsonb not null,                -- {kind, memo, lines:[{account_id, debit, credit}]}
  is_active     boolean not null default true,
  created_by    uuid references auth.users(id) on delete set null default auth.uid(),
  created_at    timestamptz not null default now(),
  check (end_date is null or end_date >= start_date)
);

-- 전표 (거래 1건)
create table public.transactions (
  id            uuid primary key,              -- 기기에서 생성한 UUID (중복 저장 방지)
  ledger_id     uuid not null references public.ledgers(id) on delete cascade,
  txn_date      date not null check (txn_date between '1900-01-01' and '2999-12-31'),
  memo          text not null default '' check (char_length(memo) <= 200),
  kind          text not null default 'manual'
                check (kind in ('expense', 'income', 'transfer', 'card_payment',
                                'loan_repayment', 'opening', 'manual')),
  source        text not null default 'advanced'
                check (source in ('simple', 'advanced', 'recurring', 'import', 'opening')),
  recurring_id  uuid references public.recurring(id) on delete set null,
  is_deleted    boolean not null default false, -- 휴지통
  deleted_at    timestamptz,
  created_by    uuid references auth.users(id) on delete set null,
  updated_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (id, ledger_id)
);

-- 분개 라인 (전표당 2줄 이상)
create table public.lines (
  id              uuid primary key default gen_random_uuid(),
  transaction_id  uuid not null,
  ledger_id       uuid not null references public.ledgers(id) on delete cascade,
  account_id      uuid not null,
  line_no         smallint not null default 0,
  debit           bigint not null default 0 check (debit  between 0 and 1000000000000000),
  credit          bigint not null default 0 check (credit between 0 and 1000000000000000),
  memo            text not null default '' check (char_length(memo) <= 100),
  -- 한 줄에 차변·대변 중 하나만 0보다 큼
  check ((debit > 0 and credit = 0) or (credit > 0 and debit = 0)),
  -- 전표·계정 모두 같은 장부여야 함 (복합 FK)
  foreign key (transaction_id, ledger_id)
    references public.transactions(id, ledger_id) on delete cascade,
  foreign key (account_id, ledger_id)
    references public.accounts(id, ledger_id)
);

-- 월 예산 (비용 계정별)
create table public.budgets (
  id          uuid primary key default gen_random_uuid(),
  ledger_id   uuid not null references public.ledgers(id) on delete cascade,
  account_id  uuid not null,
  month       text not null check (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),  -- YYYY-MM
  amount      bigint not null check (amount between 0 and 1000000000000000),
  unique (ledger_id, account_id, month),
  foreign key (account_id, ledger_id)
    references public.accounts(id, ledger_id) on delete cascade
);

-- 즐겨찾기 (자주 쓰는 거래 틀)
create table public.favorites (
  id          uuid primary key default gen_random_uuid(),
  ledger_id   uuid not null references public.ledgers(id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 30),
  template    jsonb not null,
  sort_order  integer not null default 0,
  created_by  uuid references auth.users(id) on delete set null default auth.uid(),
  created_at  timestamptz not null default now()
);

-- 전표 변경 이력 (RPC 안에서만 기록, 사용자는 조회만)
create table public.audit_log (
  id              bigint generated always as identity primary key,
  ledger_id       uuid not null references public.ledgers(id) on delete cascade,
  transaction_id  uuid not null,               -- 영구삭제 후에도 이력이 남도록 FK 없음
  action          text not null check (action in ('create', 'update', 'delete', 'restore', 'purge')),
  before          jsonb,
  after           jsonb,
  changed_by      uuid references auth.users(id) on delete set null,
  changed_at      timestamptz not null default now()
);



-- =====================================================================
-- 3. 구성원 판별 함수, 무결성 트리거
-- =====================================================================

-- 현재 사용자가 해당 장부의 구성원인지 (RLS 정책에서 사용)
-- security definer: ledger_members 자체의 RLS를 거치지 않아 재귀를 막음
create or replace function private.is_ledger_member(p_ledger_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.ledger_members m
    where m.ledger_id = p_ledger_id
      and m.user_id = (select auth.uid())
  );
$$;

-- 현재 사용자가 해당 장부의 소유자(owner)인지
create or replace function private.is_ledger_owner(p_ledger_id uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.ledger_members m
    where m.ledger_id = p_ledger_id
      and m.user_id = (select auth.uid())
      and m.role = 'owner'
  );
$$;



-- 계정 저장 전 검사: 2단계 계층, 상·하위 분류 일치, 변경 제한
create or replace function private.accounts_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_parent public.accounts%rowtype;
begin
  if tg_op = 'UPDATE' then
    if new.ledger_id <> old.ledger_id then
      raise exception '계정의 장부는 바꿀 수 없습니다.';
    end if;
    if new.type <> old.type and exists (select 1 from public.lines where account_id = old.id) then
      raise exception '거래가 있는 계정은 분류(자산·부채 등)를 바꿀 수 없습니다.';
    end if;
    if old.is_system and (new.type <> old.type or new.subtype is distinct from old.subtype
                          or new.parent_id is distinct from old.parent_id) then
      raise exception '기본 시스템 계정은 이름·순서·숨김만 바꿀 수 있습니다.';
    end if;
    -- 하위 계정이 있으면 분류를 바꿀 수 없음
    if new.type <> old.type and exists (select 1 from public.accounts where parent_id = old.id) then
      raise exception '하위 계정이 있는 계정은 분류를 바꿀 수 없습니다.';
    end if;
  end if;

  if new.parent_id is not null then
    select * into v_parent from public.accounts where id = new.parent_id;
    if v_parent.parent_id is not null then
      raise exception '계정은 상위 > 하위 2단계까지만 만들 수 있습니다.';
    end if;
    if v_parent.type <> new.type then
      raise exception '하위 계정은 상위 계정과 같은 분류여야 합니다.';
    end if;
    if tg_op = 'UPDATE' and exists (select 1 from public.accounts where parent_id = new.id) then
      raise exception '하위 계정이 있는 계정은 다른 계정 아래로 옮길 수 없습니다.';
    end if;
    -- 세부 분류는 상위 계정에서 물려받음
    new.subtype := coalesce(new.subtype, v_parent.subtype);
  end if;

  return new;
end;
$$;

create trigger accounts_before_write
  before insert or update on public.accounts
  for each row execute function private.accounts_before_write();

-- 계정 삭제 전 검사: 시스템 계정·거래 있는 계정·하위 있는 계정은 삭제 불가
create or replace function private.accounts_before_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- 장부 전체를 삭제하는 중이면 통과
  if not exists (select 1 from public.ledgers where id = old.ledger_id) then
    return old;
  end if;
  if old.is_system then
    raise exception '기본 시스템 계정은 삭제할 수 없습니다. 숨김을 사용하세요.';
  end if;
  if exists (select 1 from public.lines where account_id = old.id) then
    raise exception '거래가 있는 계정은 삭제할 수 없습니다. 숨김을 사용하세요.';
  end if;
  if exists (select 1 from public.accounts where parent_id = old.id) then
    raise exception '하위 계정이 있는 계정은 삭제할 수 없습니다.';
  end if;
  return old;
end;
$$;

create trigger accounts_before_delete
  before delete on public.accounts
  for each row execute function private.accounts_before_delete();

-- 차대 일치 지연 검증: 커밋 시점에 전표별로 차변 합계 = 대변 합계, 2줄 이상인지 확인
-- (RPC 검증과 별도의 최종 안전장치)
create or replace function private.check_transaction_balance()
returns trigger
language plpgsql security definer   -- 커밋 시점 실행 사용자와 무관하게 전체 라인을 봐야 함
set search_path = ''
as $$
declare
  v_tid     uuid := coalesce(new.transaction_id, old.transaction_id);
  v_debit   numeric;
  v_credit  numeric;
  v_count   integer;
begin
  -- 전표 자체가 삭제된 경우(영구삭제·장부 삭제)는 검사하지 않음
  if not exists (select 1 from public.transactions where id = v_tid) then
    return null;
  end if;

  select coalesce(sum(debit), 0), coalesce(sum(credit), 0), count(*)
    into v_debit, v_credit, v_count
    from public.lines where transaction_id = v_tid;

  if v_count < 2 then
    raise exception '전표 %: 분개 라인이 2줄 이상이어야 합니다.', v_tid;
  end if;
  if v_debit <> v_credit then
    raise exception '전표 %: 차변 합계(%)와 대변 합계(%)가 일치하지 않습니다.', v_tid, v_debit, v_credit;
  end if;
  return null;
end;
$$;

create constraint trigger lines_balance_check
  after insert or update or delete on public.lines
  deferrable initially deferred
  for each row execute function private.check_transaction_balance();

-- 예산은 비용 계정에만
create or replace function private.budgets_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (select 1 from public.accounts where id = new.account_id and type = 'expense') then
    raise exception '예산은 비용 계정에만 설정할 수 있습니다.';
  end if;
  return new;
end;
$$;

create trigger budgets_before_write
  before insert or update on public.budgets
  for each row execute function private.budgets_before_write();


-- =====================================================================
-- 4. 내부 함수
-- =====================================================================

-- 기본 계정과목 생성
create or replace function private.seed_default_accounts(p_ledger_id uuid, p_user_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_bank uuid;
  v_card uuid;
begin
  -- 자산
  insert into public.accounts (ledger_id, name, type, subtype, sort_order, created_by) values
    (p_ledger_id, '현금',       'asset', 'cash',       10, p_user_id);
  insert into public.accounts (ledger_id, name, type, subtype, sort_order, created_by)
    values (p_ledger_id, '보통예금', 'asset', 'bank', 20, p_user_id) returning id into v_bank;
  insert into public.accounts (ledger_id, name, type, subtype, parent_id, sort_order, created_by)
    values (p_ledger_id, '주거래 통장', 'asset', 'bank', v_bank, 21, p_user_id);
  insert into public.accounts (ledger_id, name, type, subtype, sort_order, created_by) values
    (p_ledger_id, '적금',       'asset', 'savings',    30, p_user_id),
    (p_ledger_id, '증권계좌',   'asset', 'investment', 40, p_user_id),
    (p_ledger_id, '빌려준 돈',  'asset', 'receivable', 50, p_user_id);

  -- 부채
  insert into public.accounts (ledger_id, name, type, subtype, sort_order, created_by)
    values (p_ledger_id, '신용카드', 'liability', 'card', 110, p_user_id) returning id into v_card;
  insert into public.accounts (ledger_id, name, type, subtype, parent_id, sort_order, created_by)
    values (p_ledger_id, '주 사용 카드', 'liability', 'card', v_card, 111, p_user_id);
  insert into public.accounts (ledger_id, name, type, subtype, sort_order, created_by) values
    (p_ledger_id, '대출',      'liability', 'loan',    120, p_user_id),
    (p_ledger_id, '빌린 돈',   'liability', 'payable', 130, p_user_id);

  -- 순자산
  insert into public.accounts (ledger_id, name, type, subtype, is_system, sort_order, created_by) values
    (p_ledger_id, '기초 순자산', 'equity', 'opening', true, 210, p_user_id);

  -- 수익
  insert into public.accounts (ledger_id, name, type, sort_order, created_by) values
    (p_ledger_id, '급여',      'income', 310, p_user_id),
    (p_ledger_id, '상여',      'income', 320, p_user_id),
    (p_ledger_id, '이자·배당', 'income', 330, p_user_id),
    (p_ledger_id, '기타 수입', 'income', 340, p_user_id);

  -- 비용
  insert into public.accounts (ledger_id, name, type, sort_order, created_by) values
    (p_ledger_id, '식비',          'expense', 410, p_user_id),
    (p_ledger_id, '주거·관리비',   'expense', 420, p_user_id),
    (p_ledger_id, '교통',          'expense', 430, p_user_id),
    (p_ledger_id, '통신',          'expense', 440, p_user_id),
    (p_ledger_id, '의료',          'expense', 450, p_user_id),
    (p_ledger_id, '교육',          'expense', 460, p_user_id),
    (p_ledger_id, '경조사',        'expense', 470, p_user_id),
    (p_ledger_id, '보험',          'expense', 480, p_user_id),
    (p_ledger_id, '여가',          'expense', 490, p_user_id),
    (p_ledger_id, '대출이자',      'expense', 500, p_user_id),
    (p_ledger_id, '세금·사회보험', 'expense', 510, p_user_id),
    (p_ledger_id, '기타 지출',     'expense', 520, p_user_id);
end;
$$;

-- 장부 생성 (소유자 멤버십 + 기본 계정 포함)
create or replace function private.create_ledger_for(p_user_id uuid, p_name text)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.ledgers (name, created_by) values (p_name, p_user_id) returning id into v_id;
  insert into public.ledger_members (ledger_id, user_id, role) values (v_id, p_user_id, 'owner');
  perform private.seed_default_accounts(v_id, p_user_id);
  return v_id;
end;
$$;

-- 신규 가입 시 개인 장부 자동 생성
create or replace function private.handle_new_user()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  perform private.create_ledger_for(new.id, '우리집 가계부');
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- 현재 사용자 확인 (로그인하지 않았으면 오류)
create or replace function private.require_user()
returns uuid
language plpgsql stable
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception '로그인이 필요합니다.' using errcode = '28000';
  end if;
  return v_uid;
end;
$$;

-- 장부 구성원 확인 (아니면 오류)
create or replace function private.require_member(p_ledger_id uuid)
returns uuid
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
begin
  if not exists (select 1 from public.ledger_members
                 where ledger_id = p_ledger_id and user_id = v_uid) then
    raise exception '이 장부에 접근할 권한이 없습니다.' using errcode = '42501';
  end if;
  return v_uid;
end;
$$;

-- 전표 스냅샷 (이력 기록용)
create or replace function private.transaction_snapshot(p_id uuid)
returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object(
    'transaction', to_jsonb(t),
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
               'account_id', l.account_id, 'debit', l.debit, 'credit', l.credit,
               'memo', l.memo, 'line_no', l.line_no) order by l.line_no)
      from public.lines l where l.transaction_id = t.id), '[]'::jsonb))
  from public.transactions t where t.id = p_id;
$$;

-- 분개 라인 검증 후 저장
-- p_lines 형식: [{"account_id": "...", "debit": 30000, "credit": 0, "memo": ""}, ...]
create or replace function private.insert_lines(p_txn_id uuid, p_ledger_id uuid, p_lines jsonb)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_line    jsonb;
  v_no      integer := 0;
  v_debit   bigint;
  v_credit  bigint;
  v_acc     uuid;
  v_sum_d   numeric := 0;
  v_sum_c   numeric := 0;
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) < 2 then
    raise exception '분개 라인이 2줄 이상이어야 합니다.' using errcode = '22023';
  end if;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_no := v_no + 1;

    -- 금액: 정수만 허용 (소수·문자 입력 시 오류)
    begin
      v_debit  := coalesce(nullif(v_line->>'debit',  ''), '0')::bigint;
      v_credit := coalesce(nullif(v_line->>'credit', ''), '0')::bigint;
    exception when others then
      raise exception '%번째 줄: 금액은 원 단위 정수여야 합니다.', v_no using errcode = '22023';
    end;
    if v_debit < 0 or v_credit < 0 then
      raise exception '%번째 줄: 금액은 0 이상이어야 합니다.', v_no using errcode = '22023';
    end if;
    if (v_debit > 0) = (v_credit > 0) then
      raise exception '%번째 줄: 차변과 대변 중 하나에만 금액을 넣어야 합니다.', v_no using errcode = '22023';
    end if;

    -- 계정: 같은 장부의 계정이어야 하고, 하위 계정이 있는 상위 계정에는 직접 기록할 수 없음
    begin
      v_acc := (v_line->>'account_id')::uuid;
    exception when others then
      raise exception '%번째 줄: 계정이 올바르지 않습니다.', v_no using errcode = '22023';
    end;
    if v_acc is null or not exists (select 1 from public.accounts
                                    where id = v_acc and ledger_id = p_ledger_id) then
      raise exception '%번째 줄: 이 장부에 없는 계정입니다.', v_no using errcode = '22023';
    end if;
    if exists (select 1 from public.accounts where parent_id = v_acc) then
      raise exception '%번째 줄: 하위 계정이 있는 상위 계정에는 기록할 수 없습니다. 하위 계정을 고르세요.', v_no
        using errcode = '22023';
    end if;

    v_sum_d := v_sum_d + v_debit;
    v_sum_c := v_sum_c + v_credit;

    insert into public.lines (transaction_id, ledger_id, account_id, line_no, debit, credit, memo)
    values (p_txn_id, p_ledger_id, v_acc, v_no, v_debit, v_credit,
            left(coalesce(v_line->>'memo', ''), 100));
  end loop;

  if v_sum_d <> v_sum_c then
    raise exception '차변 합계(%)와 대변 합계(%)가 일치하지 않습니다. 차액 %원',
      v_sum_d, v_sum_c, abs(v_sum_d - v_sum_c) using errcode = '22023';
  end if;
end;
$$;

-- 다음 반복 예정일 계산 (말일 보정 포함: 31일 지정 → 2월은 28/29일)
create or replace function private.next_occurrence(
  p_date date, p_freq text, p_interval integer, p_day integer)
returns date
language plpgsql immutable
set search_path = ''
as $$
declare
  v_base  date;
  v_last  integer;
begin
  if p_freq = 'weekly' then
    return p_date + 7 * p_interval;
  end if;

  if p_freq = 'monthly' then
    v_base := (date_trunc('month', p_date) + make_interval(months => p_interval))::date;
  else
    v_base := (date_trunc('month', p_date) + make_interval(years => p_interval))::date;
  end if;
  v_last := extract(day from (v_base + interval '1 month' - interval '1 day'))::integer;
  return v_base + (least(coalesce(p_day, extract(day from p_date)::integer), v_last) - 1);
end;
$$;


-- =====================================================================
-- 5. RPC (프론트엔드에서 supabase.rpc('함수명', {...})로 호출)
-- =====================================================================

-- 전표 생성
-- 같은 p_id로 다시 호출하면(오프라인 재전송) 아무것도 하지 않고 기존 id를 돌려줌
create or replace function public.create_transaction(
  p_id              uuid,
  p_ledger_id       uuid,
  p_date            date,
  p_memo            text,
  p_kind            text,
  p_source          text,
  p_lines           jsonb,
  p_recurring_id    uuid default null,
  p_recurring_date  date default null   -- 반복 거래 등록 시: 등록하려는 예정일
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
    (id, ledger_id, txn_date, memo, kind, source, recurring_id, created_by, updated_by)
  values
    (p_id, p_ledger_id, p_date, coalesce(p_memo, ''), coalesce(p_kind, 'manual'),
     coalesce(p_source, 'advanced'), p_recurring_id, v_uid, v_uid);

  perform private.insert_lines(p_id, p_ledger_id, p_lines);

  insert into public.audit_log (ledger_id, transaction_id, action, after, changed_by)
  values (p_ledger_id, p_id, 'create', private.transaction_snapshot(p_id), v_uid);

  return p_id;
end;
$$;

-- 전표 수정 (분개 라인 전체 교체)
-- p_expected_updated_at: 화면이 불러온 시점의 updated_at. 그 사이 다른 기기에서 고쳤으면 거부
create or replace function public.update_transaction(
  p_id                   uuid,
  p_date                 date,
  p_memo                 text,
  p_kind                 text,
  p_lines                jsonb,
  p_expected_updated_at  timestamptz default null
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
         updated_by = v_uid, updated_at = clock_timestamp()
   where id = p_id;

  delete from public.lines where transaction_id = p_id;
  perform private.insert_lines(p_id, v_txn.ledger_id, p_lines);

  insert into public.audit_log (ledger_id, transaction_id, action, before, after, changed_by)
  values (v_txn.ledger_id, p_id, 'update', v_before, private.transaction_snapshot(p_id), v_uid);

  return (select updated_at from public.transactions where id = p_id);
end;
$$;

-- 전표 삭제 (휴지통으로 이동) / 복원
create or replace function public.set_transaction_deleted(p_id uuid, p_deleted boolean)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_txn  public.transactions%rowtype;
  v_uid  uuid;
begin
  select * into v_txn from public.transactions where id = p_id for update;
  if not found then
    raise exception '전표를 찾을 수 없습니다.' using errcode = '22023';
  end if;
  v_uid := private.require_member(v_txn.ledger_id);
  if v_txn.is_deleted = p_deleted then
    return;   -- 이미 그 상태
  end if;

  update public.transactions
     set is_deleted = p_deleted,
         deleted_at = case when p_deleted then now() else null end,
         updated_by = v_uid, updated_at = clock_timestamp()
   where id = p_id;

  insert into public.audit_log (ledger_id, transaction_id, action, before, after, changed_by)
  values (v_txn.ledger_id, p_id, case when p_deleted then 'delete' else 'restore' end,
          jsonb_build_object('is_deleted', v_txn.is_deleted),
          jsonb_build_object('is_deleted', p_deleted), v_uid);
end;
$$;

-- 휴지통의 전표 영구 삭제 (이력에는 마지막 내용이 남음)
create or replace function public.purge_transaction(p_id uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_txn  public.transactions%rowtype;
  v_uid  uuid;
begin
  select * into v_txn from public.transactions where id = p_id for update;
  if not found then
    return;
  end if;
  v_uid := private.require_member(v_txn.ledger_id);
  if not v_txn.is_deleted then
    raise exception '휴지통에 있는 전표만 영구 삭제할 수 있습니다.' using errcode = '22023';
  end if;

  insert into public.audit_log (ledger_id, transaction_id, action, before, changed_by)
  values (v_txn.ledger_id, p_id, 'purge', private.transaction_snapshot(p_id), v_uid);

  delete from public.transactions where id = p_id;   -- 분개 라인은 CASCADE로 함께 삭제
end;
$$;

-- 반복 거래 이번 회차 건너뛰기
create or replace function public.skip_recurring(p_id uuid, p_date date)
returns date
language plpgsql security definer
set search_path = ''
as $$
declare
  v_rec  public.recurring%rowtype;
  v_next date;
begin
  select * into v_rec from public.recurring where id = p_id for update;
  if not found then
    raise exception '반복 거래를 찾을 수 없습니다.' using errcode = '22023';
  end if;
  perform private.require_member(v_rec.ledger_id);
  if v_rec.next_date is distinct from p_date then
    raise exception '이미 등록했거나 건너뛴 반복 거래입니다.' using errcode = '40001';
  end if;
  v_next := private.next_occurrence(v_rec.next_date, v_rec.freq, v_rec.interval_n, v_rec.day_of_month);
  update public.recurring
     set next_date = v_next,
         is_active = case when end_date is not null and v_next > end_date then false else is_active end
   where id = p_id;
  return v_next;
end;
$$;

-- 새 장부 만들기
create or replace function public.create_ledger(p_name text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
begin
  return private.create_ledger_for(private.require_user(), p_name);
end;
$$;

-- 초대 코드 만들기 (owner만)
create or replace function public.create_invite(p_ledger_id uuid, p_email text default null)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid  uuid := private.require_member(p_ledger_id);
  v_code text;
begin
  if not private.is_ledger_owner(p_ledger_id) then
    raise exception '장부 소유자만 초대할 수 있습니다.' using errcode = '42501';
  end if;
  -- 헷갈리는 글자(0/O, 1/I)가 없는 10자리 코드
  v_code := translate(upper(left(replace(gen_random_uuid()::text, '-', ''), 10)), '01', '89');
  insert into public.ledger_invites (ledger_id, code, email, created_by)
  values (p_ledger_id, v_code, nullif(lower(trim(p_email)), ''), v_uid);
  return v_code;
end;
$$;

-- 초대 코드로 장부 합류
create or replace function public.accept_invite(p_code text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid  uuid := private.require_user();
  v_inv  public.ledger_invites%rowtype;
begin
  select * into v_inv from public.ledger_invites
   where code = upper(trim(p_code)) for update;
  if not found or v_inv.used_at is not null or v_inv.expires_at < now() then
    raise exception '초대 코드가 없거나 만료되었습니다.' using errcode = '22023';
  end if;
  if v_inv.email is not null and v_inv.email <> lower(coalesce(auth.jwt()->>'email', '')) then
    raise exception '다른 이메일로 발급된 초대 코드입니다.' using errcode = '42501';
  end if;

  insert into public.ledger_members (ledger_id, user_id, role)
  values (v_inv.ledger_id, v_uid, v_inv.role)
  on conflict (ledger_id, user_id) do nothing;

  update public.ledger_invites set used_by = v_uid, used_at = now() where id = v_inv.id;
  return v_inv.ledger_id;
end;
$$;

-- 구성원 내보내기(owner) 또는 스스로 나가기
create or replace function public.remove_member(p_ledger_id uuid, p_user_id uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_member(p_ledger_id);
begin
  if p_user_id <> v_uid and not private.is_ledger_owner(p_ledger_id) then
    raise exception '장부 소유자만 다른 구성원을 내보낼 수 있습니다.' using errcode = '42501';
  end if;
  -- 마지막 owner는 나갈 수 없음
  if exists (select 1 from public.ledger_members
             where ledger_id = p_ledger_id and user_id = p_user_id and role = 'owner')
     and (select count(*) from public.ledger_members
          where ledger_id = p_ledger_id and role = 'owner') = 1 then
    raise exception '마지막 소유자는 나갈 수 없습니다. 다른 구성원을 소유자로 지정하거나 장부를 삭제하세요.'
      using errcode = '22023';
  end if;
  delete from public.ledger_members where ledger_id = p_ledger_id and user_id = p_user_id;
end;
$$;

-- 구성원 역할 변경 (owner만)
create or replace function public.set_member_role(p_ledger_id uuid, p_user_id uuid, p_role text)
returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  perform private.require_member(p_ledger_id);
  if not private.is_ledger_owner(p_ledger_id) then
    raise exception '장부 소유자만 역할을 바꿀 수 있습니다.' using errcode = '42501';
  end if;
  if p_role not in ('owner', 'member') then
    raise exception '역할은 owner 또는 member입니다.' using errcode = '22023';
  end if;
  if p_role = 'member'
     and exists (select 1 from public.ledger_members
                 where ledger_id = p_ledger_id and user_id = p_user_id and role = 'owner')
     and (select count(*) from public.ledger_members
          where ledger_id = p_ledger_id and role = 'owner') = 1 then
    raise exception '장부에는 소유자가 한 명 이상 있어야 합니다.' using errcode = '22023';
  end if;
  update public.ledger_members set role = p_role
   where ledger_id = p_ledger_id and user_id = p_user_id;
end;
$$;

-- 스키마 버전 (연결 확인 페이지에서 사용)
create or replace function public.schema_version()
returns integer
language sql immutable
set search_path = ''
as $$ select 1; $$;


-- =====================================================================
-- 6. 조회 함수·뷰 (security invoker → RLS가 그대로 적용됨)
-- =====================================================================

-- 계정별 합계·잔액 (시산표·재무상태표·손익계산서 공용)
--   p_from, p_to: 기간 (null이면 제한 없음)
--   재무상태표: p_from = null, p_to = 기준일
--   손익계산서: p_from = 시작일, p_to = 종료일 (수익·비용 계정만 사용)
create or replace function public.account_balances(
  p_ledger_id uuid, p_from date default null, p_to date default null)
returns table (
  account_id    uuid,
  name          text,
  type          text,
  subtype       text,
  parent_id     uuid,
  is_hidden     boolean,
  sort_order    integer,
  debit_total   bigint,
  credit_total  bigint,
  balance       bigint     -- 부호 규칙 적용된 잔액
)
language sql stable security invoker
set search_path = ''
as $$
  with sums as (
    select l.account_id,
           sum(l.debit)::bigint  as d,
           sum(l.credit)::bigint as c
      from public.lines l
      join public.transactions t on t.id = l.transaction_id
     where l.ledger_id = p_ledger_id
       and not t.is_deleted
       and (p_from is null or t.txn_date >= p_from)
       and (p_to   is null or t.txn_date <= p_to)
     group by l.account_id
  )
  select a.id, a.name, a.type, a.subtype, a.parent_id, a.is_hidden, a.sort_order,
         coalesce(s.d, 0), coalesce(s.c, 0),
         case when a.type in ('asset', 'expense')
              then coalesce(s.d, 0) - coalesce(s.c, 0)
              else coalesce(s.c, 0) - coalesce(s.d, 0) end
    from public.accounts a
    left join sums s on s.account_id = a.id
   where a.ledger_id = p_ledger_id
   order by a.sort_order, a.name;
$$;

-- 월별 손익 (수익·비용 계정별 월 합계, 부호 규칙 적용)
create view public.v_monthly_pnl
with (security_invoker = true) as
select l.ledger_id,
       to_char(t.txn_date, 'YYYY-MM') as month,
       a.id   as account_id,
       a.name as account_name,
       a.type,
       a.parent_id,
       (case when a.type = 'expense'
             then sum(l.debit) - sum(l.credit)
             else sum(l.credit) - sum(l.debit) end)::bigint as amount
  from public.lines l
  join public.transactions t on t.id = l.transaction_id
  join public.accounts a     on a.id = l.account_id
 where not t.is_deleted
   and a.type in ('income', 'expense')
 group by l.ledger_id, to_char(t.txn_date, 'YYYY-MM'), a.id, a.name, a.type, a.parent_id;

-- 계정별 원장: 기간 내 거래와 누적 잔액 (상위 계정이면 하위 계정 합산)
create or replace function public.account_ledger(
  p_account_id uuid, p_from date default null, p_to date default null)
returns table (
  transaction_id   uuid,
  txn_date         date,
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
    select t.id, t.txn_date, t.created_at, t.memo, t.kind,
           sum(l.debit)::bigint as d, sum(l.credit)::bigint as c
      from public.lines l
      join public.transactions t on t.id = l.transaction_id
     where l.account_id in (select id from acc)
       and not t.is_deleted
       and (p_from is null or t.txn_date >= p_from)
       and (p_to   is null or t.txn_date <= p_to)
     group by t.id, t.txn_date, t.created_at, t.memo, t.kind
  )
  select r.id, r.txn_date, r.memo, r.kind, r.d, r.c,
         ((o.v + sum(r.d - r.c) over (order by r.txn_date, r.created_at, r.id)) * g.s)::bigint,
         (select string_agg(distinct a2.name, ', ')
            from public.lines l2 join public.accounts a2 on a2.id = l2.account_id
           where l2.transaction_id = r.id and l2.account_id not in (select id from acc)),
         (o.v * g.s)::bigint
    from txns r cross join opening o cross join sgn g
   order by r.txn_date, r.created_at, r.id;
$$;

-- 장부 검증: 차대 합계 일치, 불균형 전표, 회계 등식(자산 = 부채 + 순자산 + 당기 손익)
create or replace function public.ledger_check(p_ledger_id uuid, p_as_of date default null)
returns jsonb
language sql stable security invoker
set search_path = ''
as $$
  with b as (
    select * from public.account_balances(p_ledger_id, null, p_as_of)
  ),
  tot as (
    select coalesce(sum(debit_total), 0)::bigint  as total_debit,
           coalesce(sum(credit_total), 0)::bigint as total_credit,
           coalesce(sum(balance) filter (where type = 'asset'), 0)::bigint     as assets,
           coalesce(sum(balance) filter (where type = 'liability'), 0)::bigint as liabilities,
           coalesce(sum(balance) filter (where type = 'equity'), 0)::bigint    as equity,
           coalesce(sum(balance) filter (where type = 'income'), 0)::bigint    as income,
           coalesce(sum(balance) filter (where type = 'expense'), 0)::bigint   as expense
      from b
  ),
  unbalanced as (
    select count(*)::integer as n from (
      select t.id
        from public.transactions t
        left join public.lines l on l.transaction_id = t.id
       where t.ledger_id = p_ledger_id and not t.is_deleted
         and (p_as_of is null or t.txn_date <= p_as_of)
       group by t.id
      having count(l.id) < 2 or coalesce(sum(l.debit), 0) <> coalesce(sum(l.credit), 0)
    ) x
  )
  select jsonb_build_object(
    'as_of',                p_as_of,
    'total_debit',          total_debit,
    'total_credit',         total_credit,
    'debit_credit_ok',      total_debit = total_credit,
    'unbalanced_count',     u.n,
    'assets',               assets,
    'liabilities',          liabilities,
    'equity',               equity,
    'net_income',           income - expense,
    'net_worth',            assets - liabilities,
    'equation_ok',          assets = liabilities + equity + (income - expense)
  )
  from tot cross join unbalanced u;
$$;


-- =====================================================================
-- 7. 인덱스
-- =====================================================================

create index ledger_members_user_idx   on public.ledger_members (user_id);
create index ledger_invites_ledger_idx on public.ledger_invites (ledger_id);
create index accounts_ledger_idx       on public.accounts (ledger_id, sort_order);
create index accounts_parent_idx       on public.accounts (parent_id);
create index transactions_ledger_date_idx on public.transactions (ledger_id, txn_date desc);
create index transactions_recurring_idx   on public.transactions (recurring_id);
create index lines_transaction_idx     on public.lines (transaction_id);
create index lines_account_idx         on public.lines (account_id);
create index lines_ledger_idx          on public.lines (ledger_id);
create index budgets_account_idx       on public.budgets (account_id);
create index recurring_ledger_next_idx on public.recurring (ledger_id, next_date) where is_active;
create index favorites_ledger_idx      on public.favorites (ledger_id, sort_order);
create index audit_ledger_idx          on public.audit_log (ledger_id, changed_at desc);
create index audit_transaction_idx     on public.audit_log (transaction_id);


-- =====================================================================
-- 8. RLS 정책 — 모든 테이블: 내가 구성원인 장부의 데이터만
-- =====================================================================

alter table public.ledgers        enable row level security;
alter table public.ledger_members enable row level security;
alter table public.ledger_invites enable row level security;
alter table public.accounts       enable row level security;
alter table public.transactions   enable row level security;
alter table public.lines          enable row level security;
alter table public.budgets        enable row level security;
alter table public.recurring      enable row level security;
alter table public.favorites      enable row level security;
alter table public.audit_log      enable row level security;

-- 장부: 구성원은 조회, 소유자는 이름 변경·삭제. 생성은 RPC(create_ledger)로만
create policy ledgers_select on public.ledgers for select to authenticated
  using (private.is_ledger_member(id));
create policy ledgers_update on public.ledgers for update to authenticated
  using (private.is_ledger_owner(id)) with check (private.is_ledger_owner(id));
create policy ledgers_delete on public.ledgers for delete to authenticated
  using (private.is_ledger_owner(id));

-- 구성원: 같은 장부 구성원끼리 조회만. 변경은 RPC로만
create policy members_select on public.ledger_members for select to authenticated
  using (private.is_ledger_member(ledger_id));

-- 초대: 소유자만 조회·취소. 생성·사용은 RPC로만
create policy invites_select on public.ledger_invites for select to authenticated
  using (private.is_ledger_owner(ledger_id));
create policy invites_delete on public.ledger_invites for delete to authenticated
  using (private.is_ledger_owner(ledger_id));

-- 계정과목: 구성원은 조회·추가·수정·삭제 (제한은 트리거가 검사)
create policy accounts_select on public.accounts for select to authenticated
  using (private.is_ledger_member(ledger_id));
create policy accounts_insert on public.accounts for insert to authenticated
  with check (private.is_ledger_member(ledger_id));
create policy accounts_update on public.accounts for update to authenticated
  using (private.is_ledger_member(ledger_id)) with check (private.is_ledger_member(ledger_id));
create policy accounts_delete on public.accounts for delete to authenticated
  using (private.is_ledger_member(ledger_id));

-- 전표·분개: 조회만 허용. 쓰기는 RPC로만 (차대 검증을 우회할 수 없게)
create policy transactions_select on public.transactions for select to authenticated
  using (private.is_ledger_member(ledger_id));
create policy lines_select on public.lines for select to authenticated
  using (private.is_ledger_member(ledger_id));

-- 예산·반복 거래·즐겨찾기: 구성원은 모든 작업 가능
create policy budgets_all on public.budgets for all to authenticated
  using (private.is_ledger_member(ledger_id)) with check (private.is_ledger_member(ledger_id));
create policy recurring_all on public.recurring for all to authenticated
  using (private.is_ledger_member(ledger_id)) with check (private.is_ledger_member(ledger_id));
create policy favorites_all on public.favorites for all to authenticated
  using (private.is_ledger_member(ledger_id)) with check (private.is_ledger_member(ledger_id));

-- 이력: 조회만
create policy audit_select on public.audit_log for select to authenticated
  using (private.is_ledger_member(ledger_id));


-- =====================================================================
-- 9. 권한
-- =====================================================================

-- 로그인하지 않은 사용자(anon)는 테이블에 접근할 수 없음
revoke all on all tables in schema public from anon;

-- 전표·분개·이력·구성원·초대는 직접 쓰기 금지 (RLS에 더한 이중 차단)
revoke insert, update, delete on public.transactions, public.lines, public.audit_log,
                                 public.ledger_members from authenticated;
revoke insert, update on public.ledger_invites, public.ledgers from authenticated;

-- 내부 스키마: RLS 정책이 판별 함수를 부를 수 있도록 사용 권한만 부여
revoke all on schema private from public;
grant usage on schema private to authenticated;
revoke all on all functions in schema private from public, anon, authenticated;
grant execute on function private.is_ledger_member(uuid) to authenticated;
grant execute on function private.is_ledger_owner(uuid)  to authenticated;

-- 공개 함수: 로그인한 사용자만 호출 (schema_version은 연결 확인용으로 anon도 허용)
revoke all on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
grant execute on function public.schema_version() to anon;
