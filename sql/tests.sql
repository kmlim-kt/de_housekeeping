-- =====================================================================
-- 복식부기 가계부 — DB 테스트 (회계 로직 + RLS 보안)
--
-- 실행: Supabase SQL Editor에 이 파일 전체를 붙여넣고 Run
--   - 테스트용 가짜 사용자 2명(test-a, test-b)을 만들고, 끝나면 모두 지웁니다.
--   - 성공하면 마지막에 "✅ 모든 테스트 통과" 한 줄이 나옵니다.
--   - 실패하면 빨간 오류 메시지에 "❌ [테스트 이름]"이 표시되고, 모든 변경이 자동 취소됩니다.
--   - 실제 사용자 데이터는 건드리지 않습니다.
-- =====================================================================

-- 이전에 중간 실패로 남은 테스트 데이터가 있으면 정리
delete from public.ledgers where id in (
  select ledger_id from public.ledger_members
   where user_id in ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000b'));
delete from auth.users
 where id in ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000b');

-- 테스트 사용자 2명 (가입 트리거가 각자의 장부와 기본 계정과목을 만듭니다)
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'test-a@example.com'),
  ('00000000-0000-0000-0000-00000000000b', 'test-b@example.com');

do $$
declare
  ua  uuid := '00000000-0000-0000-0000-00000000000a';
  ub  uuid := '00000000-0000-0000-0000-00000000000b';
  la  uuid;   -- A의 장부
  lb  uuid;   -- B의 장부
  lr  uuid;   -- 백업에서 복원한 장부
  -- A 장부의 계정
  a_cash uuid; a_bank_parent uuid; a_bank uuid; a_card uuid; a_food uuid;
  a_open uuid; a_loan uuid; a_interest uuid; a_salary uuid; a_tax uuid; a_eat_out uuid; a_house uuid;
  t_open uuid := gen_random_uuid();
  t_food uuid := gen_random_uuid();
  t_pay  uuid := gen_random_uuid();
  t_tmp  uuid;
  v_rec  uuid;
  v_ts   timestamptz;
  v_date date;
  v_code text;
  r      jsonb;
  n      bigint;
  failed boolean;

  -- 잔액 조회 보조
  bal_cash bigint; bal_bank bigint; bal_card bigint;
begin
  -- 테스트 결과 판정용 (조건이 거짓이면 실패)
  -- (plpgsql에는 지역 함수가 없어 assert 사용)

  ------------------------------------------------------------------
  -- 0. 가입 트리거
  ------------------------------------------------------------------
  select ledger_id into la from public.ledger_members where user_id = ua;
  select ledger_id into lb from public.ledger_members where user_id = ub;
  assert la is not null and lb is not null and la <> lb,
    '❌ [가입 트리거] 사용자마다 장부가 하나씩 생성되어야 함';
  select count(*) into n from public.accounts where ledger_id = la;
  assert n = 27, format('❌ [가입 트리거] 기본 계정 27개가 생성되어야 함 (실제 %s개)', n);

  select id into a_cash        from public.accounts where ledger_id = la and name = '현금';
  select id into a_bank_parent from public.accounts where ledger_id = la and name = '보통예금';
  select id into a_bank        from public.accounts where ledger_id = la and name = '주거래 통장';
  select id into a_card        from public.accounts where ledger_id = la and name = '주 사용 카드';
  select id into a_food        from public.accounts where ledger_id = la and name = '식비';
  select id into a_open        from public.accounts where ledger_id = la and name = '기초 순자산';
  select id into a_loan        from public.accounts where ledger_id = la and name = '대출';
  select id into a_interest    from public.accounts where ledger_id = la and name = '대출이자';
  select id into a_salary      from public.accounts where ledger_id = la and name = '급여';
  select id into a_tax         from public.accounts where ledger_id = la and name = '세금·사회보험';
  select id into a_house       from public.accounts where ledger_id = la and name = '주거·관리비';

  ------------------------------------------------------------------
  -- 0-1. 다음 예정일 계산 (앱 화면의 js/core/recurring.js 와 같은 결과여야 함)
  ------------------------------------------------------------------
  assert private.next_occurrence('2026-01-31', 'monthly', 1, 31) = '2026-02-28', '❌ [예정일] 1/31 → 2/28';
  assert private.next_occurrence('2026-02-28', 'monthly', 1, 31) = '2026-03-31', '❌ [예정일] 2/28 → 3/31';
  assert private.next_occurrence('2026-04-30', 'monthly', 1, 31) = '2026-05-31', '❌ [예정일] 4/30 → 5/31';
  assert private.next_occurrence('2026-01-25', 'monthly', 2, 25) = '2026-03-25', '❌ [예정일] 2개월마다';
  assert private.next_occurrence('2028-02-29', 'yearly', 1, 29) = '2029-02-28', '❌ [예정일] 윤년 2/29 → 평년 2/28';
  assert private.next_occurrence('2026-12-28', 'weekly', 1, null) = '2027-01-04', '❌ [예정일] 매주 연말 넘김';
  assert private.next_occurrence('2026-01-10', 'monthly', 1, null) = '2026-02-10', '❌ [예정일] 날짜 지정 없음';

  ------------------------------------------------------------------
  -- 사용자 A로 로그인
  ------------------------------------------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', ua, 'email', 'test-a@example.com', 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  ------------------------------------------------------------------
  -- 1. 회계 시나리오: 개시 잔액 → 카드로 식비 3만 원 → 카드대금 결제
  ------------------------------------------------------------------
  -- 개시: 현금 10만, 통장 200만, 카드 미결제 30만 → 기초 순자산 180만
  perform public.create_transaction(t_open, la, '2026-01-01', '개시 잔액', 'opening', 'opening',
    jsonb_build_array(
      jsonb_build_object('account_id', a_cash, 'debit', 100000),
      jsonb_build_object('account_id', a_bank, 'debit', 2000000),
      jsonb_build_object('account_id', a_card, 'credit', 300000),
      jsonb_build_object('account_id', a_open, 'credit', 1800000)));

  r := public.ledger_check(la);
  assert (r->>'net_worth')::bigint = 1800000, '❌ [개시 잔액] 순자산 180만 원이어야 함: ' || r::text;
  assert (r->>'equation_ok')::boolean, '❌ [개시 잔액] 회계 등식 성립해야 함: ' || r::text;

  -- 카드로 식비 3만 원: 차변 식비 / 대변 카드
  perform public.create_transaction(t_food, la, '2026-01-05', '점심', 'expense', 'simple',
    jsonb_build_array(
      jsonb_build_object('account_id', a_food, 'debit', 30000),
      jsonb_build_object('account_id', a_card, 'credit', 30000)));

  r := public.ledger_check(la);
  assert (r->>'net_worth')::bigint = 1770000, '❌ [식비] 순자산이 3만 원 줄어야 함: ' || r::text;
  assert (r->>'net_income')::bigint = -30000, '❌ [식비] 당기 손익 -3만 원이어야 함: ' || r::text;
  assert (r->>'equation_ok')::boolean, '❌ [식비] 회계 등식 성립해야 함: ' || r::text;

  -- 카드대금 33만 원 결제: 차변 카드 / 대변 통장
  perform public.create_transaction(t_pay, la, '2026-01-25', '카드대금', 'card_payment', 'simple',
    jsonb_build_array(
      jsonb_build_object('account_id', a_card, 'debit', 330000),
      jsonb_build_object('account_id', a_bank, 'credit', 330000)));

  r := public.ledger_check(la);
  assert (r->>'net_worth')::bigint = 1770000, '❌ [카드대금] 결제는 순자산을 바꾸지 않아야 함: ' || r::text;
  assert (r->>'debit_credit_ok')::boolean, '❌ [시산표] 차변 합계 = 대변 합계여야 함: ' || r::text;
  assert (r->>'unbalanced_count')::int = 0, '❌ [시산표] 불균형 전표가 없어야 함: ' || r::text;
  assert (r->>'equation_ok')::boolean, '❌ [카드대금] 회계 등식 성립해야 함: ' || r::text;

  select balance into bal_card from public.account_balances(la) where account_id = a_card;
  select balance into bal_bank from public.account_balances(la) where account_id = a_bank;
  assert bal_card = 0,       format('❌ [잔액] 카드 미결제액 0원이어야 함 (실제 %s)', bal_card);
  assert bal_bank = 1670000, format('❌ [잔액] 통장 167만 원이어야 함 (실제 %s)', bal_bank);

  -- 기준일 재무상태표: 1월 10일 기준이면 카드대금 결제 전 → 카드 33만
  select balance into bal_card from public.account_balances(la, null, '2026-01-10') where account_id = a_card;
  assert bal_card = 330000, format('❌ [기준일] 1/10 기준 카드 33만 원이어야 함 (실제 %s)', bal_card);

  -- 계정별 원장: 카드의 누적 잔액 30만 → 33만 → 0
  select array_agg(running_balance order by txn_date)::text into v_code
    from public.account_ledger(a_card);
  assert v_code = '{300000,330000,0}', '❌ [원장] 카드 누적 잔액이 30만→33만→0이어야 함: ' || v_code;

  -- 월별 손익
  select amount into n from public.v_monthly_pnl where ledger_id = la and month = '2026-01' and account_id = a_food;
  assert n = 30000, format('❌ [월별 손익] 1월 식비 3만 원이어야 함 (실제 %s)', n);

  -- 급여 여러 줄 분개: 통장 300만 + 세금 30만 = 급여 330만
  perform public.create_transaction(gen_random_uuid(), la, '2026-01-25', '1월 급여', 'manual', 'advanced',
    jsonb_build_array(
      jsonb_build_object('account_id', a_bank,   'debit',  3000000),
      jsonb_build_object('account_id', a_tax,    'debit',  300000),
      jsonb_build_object('account_id', a_salary, 'credit', 3300000)));
  -- 대출 상환: 원금 50만(부채 감소) + 이자 5만(비용) / 통장 55만
  perform public.create_transaction(gen_random_uuid(), la, '2026-01-26', '대출 상환', 'loan_repayment', 'simple',
    jsonb_build_array(
      jsonb_build_object('account_id', a_loan,     'debit',  500000),
      jsonb_build_object('account_id', a_interest, 'debit',  50000),
      jsonb_build_object('account_id', a_bank,     'credit', 550000)));
  r := public.ledger_check(la);
  -- 순자산: 177만 + 급여 330만 - 세금 30만 - 이자 5만 = 472만 (대출 원금 상환은 순자산 불변)
  assert (r->>'net_worth')::bigint = 4720000, '❌ [급여·대출] 순자산 472만 원이어야 함: ' || r::text;
  assert (r->>'equation_ok')::boolean, '❌ [급여·대출] 회계 등식 성립해야 함: ' || r::text;

  ------------------------------------------------------------------
  -- 1-1. 거래 검색 (분개장) — 지금까지 전표 5건
  ------------------------------------------------------------------
  select count(*) into n from public.search_transactions(la);
  assert n = 5, format('❌ [검색] 전체 5건이어야 함 (실제 %s)', n);
  select total_count into n from public.search_transactions(la, p_limit => 1);
  assert n = 5, format('❌ [검색] 1건만 가져와도 전체 건수는 5여야 함 (실제 %s)', n);
  select count(*) into n from public.search_transactions(la, p_account_id => a_card);
  assert n = 3, format('❌ [검색] 카드 계정 거래 3건이어야 함 (실제 %s)', n);
  select count(*) into n from public.search_transactions(la, p_account_id => a_bank_parent);
  assert n = 4, format('❌ [검색] 상위 계정(보통예금)으로 찾으면 하위 계정 거래 4건 포함 (실제 %s)', n);
  select count(*) into n from public.search_transactions(la, p_query => '점심');
  assert n = 1, format('❌ [검색] 메모 "점심" 1건 (실제 %s)', n);
  select count(*) into n from public.search_transactions(la, p_query => '세금');
  assert n = 1, format('❌ [검색] 계정 이름 "세금" 1건 (실제 %s)', n);
  select count(*) into n from public.search_transactions(la, p_query => '%');
  assert n = 0, format('❌ [검색] "%%"는 글자 그대로 찾아야 함 (실제 %s)', n);
  select count(*) into n from public.search_transactions(la, p_min => 3000000);
  assert n = 1, format('❌ [검색] 300만 원 이상 1건 (급여 330만) (실제 %s)', n);
  select count(*) into n from public.search_transactions(la, p_from => '2026-01-25', p_to => '2026-01-25');
  assert n = 2, format('❌ [검색] 1월 25일 2건 (실제 %s)', n);
  select total into n from public.search_transactions(la, p_query => '점심');
  assert n = 30000, format('❌ [검색] 전표 합계 3만 원 (실제 %s)', n);
  select jsonb_array_length(lines) into n from public.search_transactions(la, p_query => '1월 급여');
  assert n = 3, format('❌ [검색] 급여 전표의 분개 라인 3줄 (실제 %s)', n);

  ------------------------------------------------------------------
  -- 1-2. 월별 요약 (대시보드) — 2025-12 ~ 2026-01
  --   1월: 수입 급여 330만, 지출 식비 3만 + 세금 30만 + 대출이자 5만 = 38만, 월말 순자산 472만
  ------------------------------------------------------------------
  select count(*) into n from public.monthly_summary(la, 2, '2026-01-15');
  assert n = 2, format('❌ [월별 요약] 2개월이어야 함 (실제 %s)', n);
  select income into n from public.monthly_summary(la, 2, '2026-01-15') where month = '2026-01';
  assert n = 3300000, format('❌ [월별 요약] 1월 수입 330만 (실제 %s)', n);
  select expense into n from public.monthly_summary(la, 2, '2026-01-15') where month = '2026-01';
  assert n = 380000, format('❌ [월별 요약] 1월 지출 38만 (실제 %s)', n);
  select net_worth into n from public.monthly_summary(la, 2, '2026-01-15') where month = '2026-01';
  assert n = 4720000, format('❌ [월별 요약] 1월 말 순자산 472만 (실제 %s)', n);
  select assets - liabilities - net_worth into n from public.monthly_summary(la, 2, '2026-01-15') where month = '2026-01';
  assert n = 0, '❌ [월별 요약] 순자산 = 자산 − 부채';
  select coalesce(sum(income + expense + assets + liabilities), 0) into n
    from public.monthly_summary(la, 2, '2026-01-15') where month = '2025-12';
  assert n = 0, '❌ [월별 요약] 거래 전 달(2025-12)은 모두 0';
  select month_end::text into v_code from public.monthly_summary(la, 2, '2026-01-15') where month = '2026-01';
  assert v_code = '2026-01-31', '❌ [월별 요약] 1월 말일 2026-01-31';
  -- 2월은 거래가 없어도 순자산이 1월 말과 같아야 함 (누계)
  select net_worth into n from public.monthly_summary(la, 1, '2026-02-10');
  assert n = 4720000, format('❌ [월별 요약] 거래 없는 2월 말 순자산도 472만 (실제 %s)', n);

  ------------------------------------------------------------------
  -- 2. 차대 검증 (RPC가 거부해야 하는 입력)
  ------------------------------------------------------------------
  failed := false;
  begin
    perform public.create_transaction(gen_random_uuid(), la, '2026-01-06', '불일치', 'manual', 'advanced',
      jsonb_build_array(
        jsonb_build_object('account_id', a_food, 'debit', 30000),
        jsonb_build_object('account_id', a_cash, 'credit', 29000)));
  exception when others then failed := true;
  end;
  assert failed, '❌ [차대 검증] 차변 3만 ≠ 대변 2.9만 전표는 거부되어야 함';

  failed := false;
  begin
    perform public.create_transaction(gen_random_uuid(), la, '2026-01-06', '소수', 'manual', 'advanced',
      '[{"account_id":"' || a_food || '","debit":1000.5},{"account_id":"' || a_cash || '","credit":1000.5}]');
  exception when others then failed := true;
  end;
  assert failed, '❌ [정수 금액] 소수 금액은 거부되어야 함';

  failed := false;
  begin
    perform public.create_transaction(gen_random_uuid(), la, '2026-01-06', '한 줄', 'manual', 'advanced',
      jsonb_build_array(jsonb_build_object('account_id', a_food, 'debit', 1000, 'credit', 1000),
                        jsonb_build_object('account_id', a_cash, 'credit', 0)));
  exception when others then failed := true;
  end;
  assert failed, '❌ [라인 규칙] 한 줄에 차변·대변이 함께 있으면 거부되어야 함';

  failed := false;
  begin
    perform public.create_transaction(gen_random_uuid(), la, '2026-01-06', '1줄', 'manual', 'advanced',
      jsonb_build_array(jsonb_build_object('account_id', a_food, 'debit', 1000)));
  exception when others then failed := true;
  end;
  assert failed, '❌ [라인 규칙] 1줄짜리 전표는 거부되어야 함';

  failed := false;
  begin
    perform public.create_transaction(gen_random_uuid(), la, '2026-01-06', '상위 계정', 'manual', 'advanced',
      jsonb_build_array(jsonb_build_object('account_id', a_food, 'debit', 1000),
                        jsonb_build_object('account_id', a_bank_parent, 'credit', 1000)));
  exception when others then failed := true;
  end;
  assert failed, '❌ [계층] 하위 계정이 있는 상위 계정(보통예금)에는 기록할 수 없어야 함';

  -- 같은 id로 다시 보내면(오프라인 재전송) 중복 저장되지 않음
  perform public.create_transaction(t_food, la, '2026-01-05', '점심', 'expense', 'simple',
    jsonb_build_array(
      jsonb_build_object('account_id', a_food, 'debit', 30000),
      jsonb_build_object('account_id', a_card, 'credit', 30000)));
  select count(*) into n from public.lines where transaction_id = t_food;
  assert n = 2, format('❌ [중복 방지] 재전송해도 라인이 2줄이어야 함 (실제 %s)', n);

  ------------------------------------------------------------------
  -- 3. 수정·삭제·복원·이력
  ------------------------------------------------------------------
  select updated_at into v_ts from public.transactions where id = t_food;
  v_ts := public.update_transaction(t_food, '2026-01-05', '점심(수정)', 'expense',
    jsonb_build_array(
      jsonb_build_object('account_id', a_food, 'debit', 35000),
      jsonb_build_object('account_id', a_card, 'credit', 35000)), v_ts);
  select balance into n from public.account_balances(la) where account_id = a_food;
  assert n = 35000, format('❌ [수정] 식비가 3.5만 원으로 바뀌어야 함 (실제 %s)', n);

  -- 오래된 updated_at으로 수정하면 거부 (다른 기기에서 먼저 수정한 경우)
  failed := false;
  begin
    perform public.update_transaction(t_food, '2026-01-05', '충돌', 'expense',
      jsonb_build_array(
        jsonb_build_object('account_id', a_food, 'debit', 1),
        jsonb_build_object('account_id', a_card, 'credit', 1)), v_ts - interval '1 second');
  exception when others then failed := true;
  end;
  assert failed, '❌ [동시 수정] 오래된 버전으로 수정하면 거부되어야 함';

  -- 휴지통으로 이동 → 잔액에서 빠짐
  perform public.set_transaction_deleted(t_food, true);
  select balance into n from public.account_balances(la) where account_id = a_food;
  assert n = 0, format('❌ [삭제] 휴지통 전표는 잔액에서 빠져야 함 (실제 %s)', n);
  select count(*) into n from public.search_transactions(la, p_query => '점심');
  assert n = 0, '❌ [휴지통] 휴지통 전표는 일반 검색에 나오지 않아야 함';
  select count(*) into n from public.search_transactions(la, p_deleted => true);
  assert n = 1, format('❌ [휴지통] 휴지통 검색에 1건 (실제 %s)', n);
  r := public.ledger_check(la);
  assert (r->>'equation_ok')::boolean, '❌ [삭제] 삭제 후에도 회계 등식 성립해야 함: ' || r::text;

  -- 복원 → 잔액에 다시 포함
  perform public.set_transaction_deleted(t_food, false);
  select balance into n from public.account_balances(la) where account_id = a_food;
  assert n = 35000, format('❌ [복원] 복원하면 잔액에 다시 포함되어야 함 (실제 %s)', n);

  -- 휴지통에 없는 전표는 영구 삭제 불가
  failed := false;
  begin
    perform public.purge_transaction(t_food);
  exception when others then failed := true;
  end;
  assert failed, '❌ [영구 삭제] 휴지통에 없는 전표는 영구 삭제할 수 없어야 함';

  -- 휴지통 → 영구 삭제 → 이력은 남음
  perform public.set_transaction_deleted(t_food, true);
  perform public.purge_transaction(t_food);
  select count(*) into n from public.transactions where id = t_food;
  assert n = 0, '❌ [영구 삭제] 전표가 지워져야 함';
  select count(*) into n from public.audit_log where transaction_id = t_food;
  -- create, update, delete, restore, delete, purge = 6건
  assert n = 6, format('❌ [이력] 이력 6건이 남아야 함 (실제 %s)', n);

  ------------------------------------------------------------------
  -- 4. 계정과목 규칙
  ------------------------------------------------------------------
  -- 식비 > 외식 하위 계정 추가 → 이후 식비에 직접 기록 불가
  insert into public.accounts (ledger_id, name, type, parent_id, sort_order)
    values (la, '외식', 'expense', a_food, 411) returning id into a_eat_out;
  failed := false;
  begin
    perform public.create_transaction(gen_random_uuid(), la, '2026-01-07', '', 'expense', 'simple',
      jsonb_build_array(jsonb_build_object('account_id', a_food, 'debit', 1000),
                        jsonb_build_object('account_id', a_cash, 'credit', 1000)));
  exception when others then failed := true;
  end;
  assert failed, '❌ [계층] 하위 계정을 만든 뒤에는 상위 계정(식비)에 기록할 수 없어야 함';

  -- 3단계 계층 불가
  failed := false;
  begin
    insert into public.accounts (ledger_id, name, type, parent_id) values (la, '한식', 'expense', a_eat_out);
  exception when others then failed := true;
  end;
  assert failed, '❌ [계층] 3단계 계정은 만들 수 없어야 함';

  -- 하위 계정은 상위와 같은 분류
  failed := false;
  begin
    insert into public.accounts (ledger_id, name, type, parent_id) values (la, '이상한', 'income', a_food);
  exception when others then failed := true;
  end;
  assert failed, '❌ [계층] 하위 계정은 상위 계정과 같은 분류여야 함';

  -- 시스템 계정·거래 있는 계정 삭제 불가
  failed := false;
  begin
    delete from public.accounts where id = a_open;
  exception when others then failed := true;
  end;
  assert failed, '❌ [계정 삭제] 기초 순자산(시스템 계정)은 삭제할 수 없어야 함';
  failed := false;
  begin
    delete from public.accounts where id = a_cash;
  exception when others then failed := true;
  end;
  assert failed, '❌ [계정 삭제] 거래가 있는 계정은 삭제할 수 없어야 함';

  -- 예산은 비용 계정에만
  insert into public.budgets (ledger_id, account_id, month, amount) values (la, a_eat_out, '2026-01', 300000);
  failed := false;
  begin
    insert into public.budgets (ledger_id, account_id, month, amount) values (la, a_salary, '2026-01', 1);
  exception when others then failed := true;
  end;
  assert failed, '❌ [예산] 수익 계정에는 예산을 설정할 수 없어야 함';

  ------------------------------------------------------------------
  -- 5. 반복 거래 (말일 보정, 중복 등록 방지, 건너뛰기)
  ------------------------------------------------------------------
  insert into public.recurring (ledger_id, name, freq, day_of_month, start_date, next_date, template)
  values (la, '월세', 'monthly', 31, '2026-01-31', '2026-01-31',
          jsonb_build_object('kind', 'expense', 'memo', '월세'))
  returning id into v_rec;

  perform public.create_transaction(gen_random_uuid(), la, '2026-01-31', '월세', 'expense', 'recurring',
    jsonb_build_array(jsonb_build_object('account_id', a_house, 'debit', 500000),
                      jsonb_build_object('account_id', a_bank,  'credit', 500000)),
    v_rec, '2026-01-31');
  select next_date into v_date from public.recurring where id = v_rec;
  assert v_date = '2026-02-28', '❌ [반복] 1/31 다음은 2/28이어야 함 (실제 ' || v_date || ')';

  failed := false;
  begin
    perform public.create_transaction(gen_random_uuid(), la, '2026-01-31', '월세', 'expense', 'recurring',
      jsonb_build_array(jsonb_build_object('account_id', a_house, 'debit', 500000),
                        jsonb_build_object('account_id', a_bank,  'credit', 500000)),
      v_rec, '2026-01-31');
  exception when others then failed := true;
  end;
  assert failed, '❌ [반복] 같은 회차를 두 번 등록할 수 없어야 함';

  v_date := public.skip_recurring(v_rec, '2026-02-28');
  assert v_date = '2026-03-31', '❌ [반복] 2/28 건너뛰면 다음은 3/31이어야 함 (실제 ' || v_date || ')';

  -- 종료일을 넘기면 자동으로 비활성
  update public.recurring set end_date = '2026-04-15' where id = v_rec;
  perform public.skip_recurring(v_rec, '2026-03-31');
  select is_active::int into n from public.recurring where id = v_rec;
  assert n = 0, '❌ [반복] 다음 예정일(4/30)이 종료일(4/15)을 넘으면 비활성이어야 함';

  -- 즐겨찾기
  insert into public.favorites (ledger_id, name, template)
  values (la, '점심 카드', jsonb_build_object('mode', 'simple', 'kind', 'expense'));

  ------------------------------------------------------------------
  -- 6. RLS 보안: A는 전표를 직접 쓸 수 없음
  ------------------------------------------------------------------
  failed := false;
  begin
    insert into public.transactions (id, ledger_id, txn_date) values (gen_random_uuid(), la, '2026-01-01');
  exception when others then failed := true;
  end;
  assert failed, '❌ [RLS] 전표 테이블에 직접 INSERT는 막혀야 함 (RPC로만 저장)';

  failed := false;
  begin
    update public.lines set debit = debit + 1 where ledger_id = la;
  exception when others then failed := true;
  end;
  assert failed, '❌ [RLS] 분개 라인 직접 UPDATE는 막혀야 함';

  ------------------------------------------------------------------
  -- 사용자 B로 로그인: A의 장부에 접근 불가
  ------------------------------------------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', ub, 'email', 'test-b@example.com', 'role', 'authenticated')::text, true);

  select count(*) into n from public.accounts where ledger_id = la;
  assert n = 0, format('❌ [RLS] B는 A의 계정과목을 볼 수 없어야 함 (보인 개수 %s)', n);
  select count(*) into n from public.transactions where ledger_id = la;
  assert n = 0, format('❌ [RLS] B는 A의 전표를 볼 수 없어야 함 (보인 개수 %s)', n);
  select count(*) into n from public.lines where ledger_id = la;
  assert n = 0, '❌ [RLS] B는 A의 분개 라인을 볼 수 없어야 함';
  select count(*) into n from public.audit_log where ledger_id = la;
  assert n = 0, '❌ [RLS] B는 A의 이력을 볼 수 없어야 함';
  select count(*) into n from public.budgets where ledger_id = la;
  assert n = 0, '❌ [RLS] B는 A의 예산을 볼 수 없어야 함';
  select count(*) into n from public.recurring where ledger_id = la;
  assert n = 0, '❌ [RLS] B는 A의 반복 거래를 볼 수 없어야 함';
  select count(*) into n from public.favorites where ledger_id = la;
  assert n = 0, '❌ [RLS] B는 A의 즐겨찾기를 볼 수 없어야 함';
  failed := false;
  begin
    insert into public.favorites (ledger_id, name, template) values (la, '침입', '{}');
  exception when others then failed := true;
  end;
  assert failed, '❌ [RLS] B는 A의 장부에 즐겨찾기를 만들 수 없어야 함';
  failed := false;
  begin
    perform public.skip_recurring(v_rec, '2026-04-30');
  exception when others then failed := true;
  end;
  assert failed, '❌ [RLS] B는 A의 반복 거래를 건너뛸 수 없어야 함';
  update public.budgets set amount = 1 where ledger_id = la;
  delete from public.recurring where ledger_id = la;
  select count(*) into n from public.account_balances(la);
  assert n = 0, '❌ [RLS] B가 A 장부의 잔액을 조회하면 빈 결과여야 함';
  select count(*) into n from public.v_monthly_pnl where ledger_id = la;
  assert n = 0, '❌ [RLS] B는 A의 월별 손익을 볼 수 없어야 함';
  select count(*) into n from public.search_transactions(la);
  assert n = 0, '❌ [RLS] B가 A 장부의 거래를 검색하면 빈 결과여야 함';
  select coalesce(sum(income + expense + assets + liabilities), 0) into n from public.monthly_summary(la, 24, '2026-06-30');
  assert n = 0, '❌ [RLS] B가 A 장부의 월별 요약을 보면 모두 0이어야 함';
  select count(*) into n from public.account_ledger(a_cash);
  assert n = 0, '❌ [RLS] B는 A 계정의 원장을 볼 수 없어야 함';

  update public.accounts set name = '해킹' where id = a_cash;
  select count(*) into n from public.accounts where name = '해킹';
  assert n = 0, '❌ [RLS] B는 A의 계정 이름을 바꿀 수 없어야 함';
  delete from public.ledgers where id = la;   -- 아래 7번에서 A 시점으로 그대로 있는지 확인

  failed := false;
  begin
    perform public.create_transaction(gen_random_uuid(), la, '2026-01-08', '침입', 'expense', 'simple',
      jsonb_build_array(jsonb_build_object('account_id', a_food, 'debit', 1),
                        jsonb_build_object('account_id', a_cash, 'credit', 1)));
  exception when others then failed := true;
  end;
  assert failed, '❌ [RLS] B는 A의 장부에 전표를 저장할 수 없어야 함';

  failed := false;
  begin
    perform public.set_transaction_deleted(t_open, true);
  exception when others then failed := true;
  end;
  assert failed, '❌ [RLS] B는 A의 전표를 삭제할 수 없어야 함';

  -- B 자기 장부에 A의 계정을 섞어 쓸 수 없음
  failed := false;
  begin
    perform public.create_transaction(gen_random_uuid(), lb, '2026-01-08', '섞기', 'expense', 'simple',
      jsonb_build_array(jsonb_build_object('account_id', a_food, 'debit', 1),
                        jsonb_build_object('account_id', a_cash, 'credit', 1)));
  exception when others then failed := true;
  end;
  assert failed, '❌ [RLS] 다른 장부의 계정으로 분개할 수 없어야 함';

  failed := false;
  begin
    perform public.create_invite(la);
  exception when others then failed := true;
  end;
  assert failed, '❌ [RLS] B는 A의 장부 초대 코드를 만들 수 없어야 함';

  ------------------------------------------------------------------
  -- 7. 공유 장부: A가 초대 → B 합류 → 함께 사용
  ------------------------------------------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', ua, 'email', 'test-a@example.com', 'role', 'authenticated')::text, true);
  -- A 장부가 B의 삭제 시도 후에도 그대로 있는지
  select count(*) into n from public.ledgers where id = la;
  assert n = 1, '❌ [RLS] B는 A의 장부를 삭제할 수 없어야 함';
  select name into v_code from public.accounts where id = a_cash;
  assert v_code = '현금', '❌ [RLS] A의 계정 이름이 바뀌지 않아야 함';
  select amount into n from public.budgets where ledger_id = la;
  assert n = 300000, '❌ [RLS] B가 A의 예산을 바꿀 수 없어야 함';
  select count(*) into n from public.recurring where ledger_id = la;
  assert n = 1, '❌ [RLS] B가 A의 반복 거래를 지울 수 없어야 함';

  v_code := public.create_invite(la, 'test-b@example.com');

  perform set_config('request.jwt.claims',
    json_build_object('sub', ub, 'email', 'test-b@example.com', 'role', 'authenticated')::text, true);
  perform public.accept_invite(lower(v_code));
  select count(*) into n from public.accounts where ledger_id = la;
  assert n > 0, '❌ [공유] 합류한 B는 A의 장부 계정을 볼 수 있어야 함';
  t_tmp := gen_random_uuid();
  perform public.create_transaction(t_tmp, la, '2026-01-09', 'B가 입력', 'expense', 'simple',
    jsonb_build_array(jsonb_build_object('account_id', a_eat_out, 'debit', 12000),
                      jsonb_build_object('account_id', a_cash,    'credit', 12000)));
  select count(*) into n from public.transactions where id = t_tmp and created_by = ub;
  assert n = 1, '❌ [공유] B가 입력한 전표의 작성자가 B로 기록되어야 함';

  -- 초대 코드는 한 번만
  failed := false;
  begin
    perform public.accept_invite(v_code);
  exception when others then failed := true;
  end;
  assert failed, '❌ [공유] 사용한 초대 코드는 다시 쓸 수 없어야 함';

  -- member인 B는 다른 사람을 초대할 수 없음
  failed := false;
  begin
    perform public.create_invite(la);
  exception when others then failed := true;
  end;
  assert failed, '❌ [공유] member는 초대 코드를 만들 수 없어야 함';

  -- 구성원 정보: 합류한 B도 이메일이 보이는 구성원 목록을 볼 수 있음
  select count(*) into n from public.ledger_members_info(la);
  assert n = 2, format('❌ [구성원] A 장부 구성원 2명 (실제 %s)', n);
  select email into v_code from public.ledger_members_info(la) where is_me;
  assert v_code = 'test-b@example.com', '❌ [구성원] 내 이메일이 보여야 함';

  -- B가 스스로 나가면 다시 볼 수 없음
  perform public.remove_member(la, ub);
  select count(*) into n from public.accounts where ledger_id = la;
  assert n = 0, '❌ [공유] 나간 뒤에는 A의 장부를 볼 수 없어야 함';
  failed := false;
  begin
    perform public.ledger_members_info(la);
  exception when others then failed := true;
  end;
  assert failed, '❌ [RLS] 나간 B는 A 장부의 구성원 목록을 볼 수 없어야 함';

  ------------------------------------------------------------------
  -- 7-1. 백업 → 새 장부로 복원 (A)
  ------------------------------------------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', ua, 'email', 'test-a@example.com', 'role', 'authenticated')::text, true);
  -- 즐겨찾기 틀에 계정 id가 들어 있는 경우 (복원 시 새 id로 바뀌어야 함)
  insert into public.favorites (ledger_id, name, template)
  values (la, '외식 현금', jsonb_build_object('mode', 'simple', 'kind', 'expense',
          'values', jsonb_build_object('expenseId', a_eat_out, 'sourceId', a_cash, 'amount', 12000)));
  -- 앱의 [백업]과 같은 모양으로 만들기
  select jsonb_build_object(
    'format', 'de-housekeeping-backup', 'version', 1, 'exported_at', now(),
    'accounts', (select jsonb_agg(to_jsonb(a)) from public.accounts a where a.ledger_id = la),
    'transactions', (select jsonb_agg(to_jsonb(t) || jsonb_build_object('lines',
        (select jsonb_agg(to_jsonb(l) order by l.line_no) from public.lines l where l.transaction_id = t.id)))
        from public.transactions t where t.ledger_id = la),
    'budgets', (select coalesce(jsonb_agg(to_jsonb(b)), '[]') from public.budgets b where b.ledger_id = la),
    'recurring', (select coalesce(jsonb_agg(to_jsonb(rr)), '[]') from public.recurring rr where rr.ledger_id = la),
    'favorites', (select coalesce(jsonb_agg(to_jsonb(f)), '[]') from public.favorites f where f.ledger_id = la))
  into r;

  lr := (public.restore_ledger('복원 테스트', r)->>'ledger_id')::uuid;
  assert lr is not null and lr <> la, '❌ [복원] 새 장부가 만들어져야 함';
  select count(*) into n from public.accounts where ledger_id = lr;
  assert n = (select count(*) from public.accounts where ledger_id = la), '❌ [복원] 계정 수가 같아야 함';
  select count(*) into n from public.transactions where ledger_id = lr;
  assert n = (select count(*) from public.transactions where ledger_id = la), '❌ [복원] 전표 수가 같아야 함';
  assert (public.ledger_check(lr)->>'net_worth') = (public.ledger_check(la)->>'net_worth'),
    '❌ [복원] 순자산이 원래 장부와 같아야 함: ' || public.ledger_check(lr)::text;
  assert (public.ledger_check(lr)->>'total_debit') = (public.ledger_check(la)->>'total_debit'),
    '❌ [복원] 차변 합계가 원래 장부와 같아야 함';
  assert (public.ledger_check(lr)->>'equation_ok')::boolean, '❌ [복원] 회계 등식 성립';
  select count(*) into n from public.accounts where ledger_id = lr and id in (select id from public.accounts where ledger_id = la);
  assert n = 0, '❌ [복원] 계정 id는 모두 새로 만들어져야 함';
  -- 즐겨찾기 틀의 계정 id가 새 장부의 "외식" 계정으로 바뀌었는지
  select (template->'values'->>'expenseId')::uuid into t_tmp from public.favorites where ledger_id = lr and name = '외식 현금';
  select count(*) into n from public.accounts where id = t_tmp and ledger_id = lr and name = '외식';
  assert n = 1, '❌ [복원] 즐겨찾기 안의 계정 id가 새 장부 계정으로 바뀌어야 함';
  select count(*) into n from public.budgets where ledger_id = lr;
  assert n = 1, format('❌ [복원] 예산 1건 (실제 %s)', n);
  select role into v_code from public.ledger_members where ledger_id = lr and user_id = ua;
  assert v_code = 'owner', '❌ [복원] 복원한 사람이 새 장부의 소유자';

  -- 잘못된 파일·차대가 맞지 않는 백업은 아무것도 만들지 않음
  select count(*) into n from public.ledgers;
  failed := false;
  begin
    perform public.restore_ledger('x', '{"format":"other"}');
  exception when others then failed := true;
  end;
  assert failed, '❌ [복원] 가계부 백업 파일이 아니면 거부';
  failed := false;
  begin
    perform public.restore_ledger('x', jsonb_set(r, '{transactions,0,lines,0,debit}', '999'));
    set constraints all immediate;
  exception when others then failed := true;
  end;
  assert failed, '❌ [복원] 차대가 맞지 않는 전표가 있으면 거부';
  assert (select count(*) from public.ledgers) = n, '❌ [복원] 실패하면 장부가 만들어지지 않아야 함';
  delete from public.ledgers where id = lr;

  ------------------------------------------------------------------
  -- 8. 로그인하지 않은 사용자(anon)
  ------------------------------------------------------------------
  perform set_config('request.jwt.claims', '', true);
  perform set_config('role', 'anon', true);
  failed := false;
  begin
    select count(*) into n from public.accounts;
  exception when others then failed := true;
  end;
  assert failed, '❌ [anon] 로그인하지 않으면 계정과목 테이블에 접근할 수 없어야 함';
  failed := false;
  begin
    perform public.create_transaction(gen_random_uuid(), la, '2026-01-08', '익명', 'expense', 'simple', '[]');
  exception when others then failed := true;
  end;
  assert failed, '❌ [anon] 로그인하지 않으면 전표를 저장할 수 없어야 함';
  assert public.schema_version() >= 4, '❌ [버전] schema_version()이 4 이상이어야 함 (DB 업데이트 002~004 실행 여부)';
  failed := false;
  begin
    perform public.search_transactions(la);
  exception when others then failed := true;
  end;
  assert failed, '❌ [anon] 로그인하지 않으면 거래 검색을 할 수 없어야 함';

  perform set_config('role', 'none', true);

  ------------------------------------------------------------------
  -- 9. 최종 안전장치: RPC를 거치지 않은 불균형 라인도 커밋 시점에 거부
  --    (관리자 권한으로 직접 넣어 보는 테스트)
  ------------------------------------------------------------------
  failed := false;
  begin
    t_tmp := gen_random_uuid();
    insert into public.transactions (id, ledger_id, txn_date) values (t_tmp, la, '2026-01-10');
    insert into public.lines (transaction_id, ledger_id, account_id, debit)  values (t_tmp, la, a_cash, 100);
    insert into public.lines (transaction_id, ledger_id, account_id, credit) values (t_tmp, la, a_open, 99);
    set constraints all immediate;   -- 커밋 시점 검사를 지금 실행
  exception when others then failed := true;
  end;
  assert failed, '❌ [지연 검증] 차대가 맞지 않는 라인은 DB가 최종적으로 거부해야 함';

  -- B의 개인 장부 삭제(장부 전체 삭제가 계정·전표와 함께 정상 동작하는지)
  delete from public.ledgers where id = lb;
  select count(*) into n from public.accounts where ledger_id = lb;
  assert n = 0, '❌ [장부 삭제] 장부를 지우면 계정과목도 함께 지워져야 함';

  raise notice '✅ 모든 테스트 통과';
end;
$$;

-- 테스트 데이터 정리
delete from public.ledgers where id in (
  select ledger_id from public.ledger_members
   where user_id in ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000b'));
delete from auth.users
 where id in ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000b');

select '✅ 모든 테스트 통과 (테스트 데이터는 삭제되었습니다)' as 결과;
