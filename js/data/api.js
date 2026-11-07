// =====================================================================
// 서버 데이터 접근 — 화면 코드는 이 파일의 함수만 사용합니다.
// 모든 함수는 실패 시 한국어 메시지를 가진 Error를 던집니다.
// =====================================================================

import { supabase, appUrl } from './supabase.js';
import { toKoreanMessage } from './errors.js';

/** supabase-js 결과에서 오류면 한국어 Error를 던지고, 아니면 data 반환 */
function unwrap({ data, error }) {
  if (error) {
    const e = new Error(toKoreanMessage(error));
    e.cause = error;
    throw e;
  }
  return data;
}

/** 네트워크 오류(fetch 실패)도 한국어로 */
async function call(promise) {
  try {
    return unwrap(await promise);
  } catch (e) {
    if (e.cause) throw e;
    const wrapped = new Error(toKoreanMessage(e));
    wrapped.cause = e;
    throw wrapped;
  }
}

// ---------------------------------------------------------------------
// 로그인
// ---------------------------------------------------------------------

export async function getSession() {
  return (await call(supabase.auth.getSession())).session;
}

/** 로그인 상태 변화 구독. 콜백: (event, session) */
export function onAuthChange(callback) {
  const { data } = supabase.auth.onAuthStateChange((event, session) => {
    // supabase-js 권장: 콜백 안에서 바로 다른 supabase 호출을 하지 않도록 한 박자 미룸
    setTimeout(() => callback(event, session), 0);
  });
  return () => data.subscription.unsubscribe();
}

export async function signIn(email, password) {
  return call(supabase.auth.signInWithPassword({ email, password }));
}

/** 가입. 이메일 확인이 켜져 있으면 session이 null로 옵니다. */
export async function signUp(email, password) {
  return call(supabase.auth.signUp({ email, password, options: { emailRedirectTo: appUrl() } }));
}

export async function sendPasswordReset(email) {
  return call(supabase.auth.resetPasswordForEmail(email, { redirectTo: appUrl() }));
}

export async function updatePassword(password) {
  return call(supabase.auth.updateUser({ password }));
}

export async function signOut() {
  return call(supabase.auth.signOut());
}

// ---------------------------------------------------------------------
// 장부·계정과목
// ---------------------------------------------------------------------

/** 내가 속한 장부 목록 (내 역할 포함) */
export async function listLedgers(userId) {
  const rows = await call(
    supabase
      .from('ledgers')
      .select('id, name, created_at, ledger_members!inner(user_id, role)')
      .eq('ledger_members.user_id', userId)
      .order('created_at'),
  );
  return rows.map((r) => ({ id: r.id, name: r.name, role: r.ledger_members[0]?.role ?? 'member' }));
}

/** 장부의 계정과목 전체 (숨김 포함) */
export async function listAccounts(ledgerId) {
  return call(
    supabase
      .from('accounts')
      .select('id, name, type, subtype, parent_id, is_hidden, is_system, sort_order')
      .eq('ledger_id', ledgerId)
      .order('sort_order')
      .order('name'),
  );
}

/**
 * 계정 추가
 * @param {{ ledgerId, name, type, subtype?, parentId?, sortOrder? }} a
 */
export async function createAccount({ ledgerId, name, type, subtype = null, parentId = null, sortOrder = 0 }) {
  return call(
    supabase
      .from('accounts')
      .insert({ ledger_id: ledgerId, name: name.trim(), type, subtype, parent_id: parentId, sort_order: sortOrder })
      .select('id, name, type, subtype, parent_id, is_hidden, is_system, sort_order')
      .single(),
  );
}

/** 계정 수정 (이름·숨김·순서) */
export async function updateAccount(id, patch) {
  const allowed = {};
  if ('name' in patch) allowed.name = patch.name.trim();
  if ('isHidden' in patch) allowed.is_hidden = patch.isHidden;
  if ('sortOrder' in patch) allowed.sort_order = patch.sortOrder;
  return call(supabase.from('accounts').update(allowed).eq('id', id).select('id').single());
}

/** 계정 삭제 (거래가 있거나 시스템 계정이면 DB가 거부하고 이유를 알려 줌) */
export async function deleteAccount(id) {
  return call(supabase.from('accounts').delete().eq('id', id));
}

// ---------------------------------------------------------------------
// 전표
// ---------------------------------------------------------------------

/**
 * 전표 저장 (RPC create_transaction)
 * id는 기기에서 미리 만든 UUID — 같은 id로 다시 보내도 중복 저장되지 않습니다.
 */
export async function createTransaction({ id, ledgerId, date, memo, kind, source, lines, recurringId = null, recurringDate = null }) {
  return call(
    supabase.rpc('create_transaction', {
      p_id: id,
      p_ledger_id: ledgerId,
      p_date: date,
      p_memo: memo,
      p_kind: kind,
      p_source: source,
      p_lines: lines,
      // 반복 거래에서 등록: 예정일이 맞는지 DB가 확인하고 다음 예정일로 넘김 (두 기기 중복 등록 방지)
      p_recurring_id: recurringId,
      p_recurring_date: recurringDate,
    }),
  );
}

// ---------------------------------------------------------------------
// 예산
// ---------------------------------------------------------------------

/** 그 달("YYYY-MM")의 예산 */
export async function listBudgets(ledgerId, month) {
  return call(supabase.from('budgets').select('id, account_id, month, amount').eq('ledger_id', ledgerId).eq('month', month));
}

/** 예산 저장 (금액 0이면 삭제) */
export async function saveBudget(ledgerId, accountId, month, amount) {
  if (!amount) {
    return call(supabase.from('budgets').delete().eq('ledger_id', ledgerId).eq('account_id', accountId).eq('month', month));
  }
  return call(supabase.from('budgets')
    .upsert({ ledger_id: ledgerId, account_id: accountId, month, amount }, { onConflict: 'ledger_id,account_id,month' }));
}

/** 다른 달의 예산을 이 달로 복사 (이미 있는 계정은 덮어씀) */
export async function copyBudgets(ledgerId, fromMonth, toMonth) {
  const src = await listBudgets(ledgerId, fromMonth);
  if (!src.length) return 0;
  await call(supabase.from('budgets').upsert(
    src.map((b) => ({ ledger_id: ledgerId, account_id: b.account_id, month: toMonth, amount: b.amount })),
    { onConflict: 'ledger_id,account_id,month' }));
  return src.length;
}

// ---------------------------------------------------------------------
// 반복 거래
// ---------------------------------------------------------------------

const RECURRING_COLS = 'id, name, freq, interval_n, day_of_month, start_date, end_date, next_date, template, is_active, created_at';

export async function listRecurring(ledgerId) {
  return call(supabase.from('recurring').select(RECURRING_COLS).eq('ledger_id', ledgerId).order('next_date'));
}

export async function getRecurring(id) {
  return call(supabase.from('recurring').select(RECURRING_COLS).eq('id', id).maybeSingle());
}

/** 반복 거래 추가·수정 (id가 있으면 수정) */
export async function saveRecurring(ledgerId, r) {
  const row = {
    ledger_id: ledgerId, name: r.name.trim(), freq: r.freq, interval_n: r.interval_n,
    day_of_month: r.freq === 'weekly' ? null : r.day_of_month,
    start_date: r.start_date, end_date: r.end_date || null, next_date: r.next_date,
    template: r.template, is_active: r.is_active ?? true,
  };
  if (r.id) return call(supabase.from('recurring').update(row).eq('id', r.id).select('id').single());
  return call(supabase.from('recurring').insert(row).select('id').single());
}

export async function setRecurringActive(id, active) {
  return call(supabase.from('recurring').update({ is_active: active }).eq('id', id));
}

export async function deleteRecurring(id) {
  return call(supabase.from('recurring').delete().eq('id', id));
}

/** 이번 회차 건너뛰기 → 다음 예정일 */
export async function skipRecurring(id, date) {
  return call(supabase.rpc('skip_recurring', { p_id: id, p_date: date }));
}

// ---------------------------------------------------------------------
// 즐겨찾기
// ---------------------------------------------------------------------

export async function listFavorites(ledgerId) {
  return call(supabase.from('favorites').select('id, name, template, sort_order')
    .eq('ledger_id', ledgerId).order('sort_order').order('created_at'));
}

export async function createFavorite(ledgerId, name, template, sortOrder = 0) {
  return call(supabase.from('favorites').insert({ ledger_id: ledgerId, name: name.trim(), template, sort_order: sortOrder })
    .select('id, name, template, sort_order').single());
}

export async function updateFavorite(id, patch) {
  return call(supabase.from('favorites').update(patch).eq('id', id));
}

export async function deleteFavorite(id) {
  return call(supabase.from('favorites').delete().eq('id', id));
}

/** 최근 전표 (휴지통 제외, 분개 라인 포함) */
export async function listRecentTransactions(ledgerId, limit = 10) {
  return call(
    supabase
      .from('transactions')
      .select('id, txn_date, memo, kind, source, created_at, created_by, lines(account_id, debit, credit, line_no)')
      .eq('ledger_id', ledgerId)
      .eq('is_deleted', false)
      .order('txn_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(limit),
  );
}

/**
 * 전표 검색 (분개장·휴지통)
 * @param {{ ledgerId, from?, to?, accountId?, query?, min?, max?, deleted?, limit?, offset? }} f
 * @returns {Promise<{ rows: Array, total: number }>}
 */
export async function searchTransactions(f) {
  const rows = await call(supabase.rpc('search_transactions', {
    p_ledger_id: f.ledgerId,
    p_from: f.from || null,
    p_to: f.to || null,
    p_account_id: f.accountId || null,
    p_query: f.query || null,
    p_min: f.min ?? null,
    p_max: f.max ?? null,
    p_deleted: !!f.deleted,
    p_limit: f.limit ?? 50,
    p_offset: f.offset ?? 0,
  }));
  return { rows, total: rows[0]?.total_count ?? 0 };
}

/** 전표 한 건 (분개 라인 포함, 휴지통 포함) */
export async function getTransaction(id) {
  return call(
    supabase
      .from('transactions')
      .select('id, ledger_id, txn_date, memo, kind, source, is_deleted, deleted_at, created_at, updated_at, created_by, updated_by, lines(account_id, debit, credit, memo, line_no)')
      .eq('id', id)
      .maybeSingle(),
  );
}

/**
 * 전표 수정 (RPC update_transaction) — 분개 라인 전체 교체
 * expectedUpdatedAt: 불러온 시점의 updated_at. 그 사이 다른 기기에서 고쳤으면 DB가 거부
 * @returns {Promise<string>} 새 updated_at
 */
export async function updateTransaction({ id, date, memo, kind, lines, expectedUpdatedAt }) {
  return call(supabase.rpc('update_transaction', {
    p_id: id, p_date: date, p_memo: memo, p_kind: kind, p_lines: lines,
    p_expected_updated_at: expectedUpdatedAt ?? null,
  }));
}

/** 휴지통으로 옮기기(true) / 복원(false) */
export async function setTransactionDeleted(id, deleted) {
  return call(supabase.rpc('set_transaction_deleted', { p_id: id, p_deleted: deleted }));
}

/** 휴지통의 전표 영구 삭제 */
export async function purgeTransaction(id) {
  return call(supabase.rpc('purge_transaction', { p_id: id }));
}

/** 전표 변경 이력 (최신 순) */
export async function transactionHistory(id) {
  return call(
    supabase
      .from('audit_log')
      .select('id, action, before, after, changed_by, changed_at')
      .eq('transaction_id', id)
      .order('changed_at', { ascending: false }),
  );
}

/** 계정별 합계·잔액 (시산표·재무상태표) */
export async function accountBalances(ledgerId, from = null, to = null) {
  return call(supabase.rpc('account_balances', { p_ledger_id: ledgerId, p_from: from, p_to: to }));
}

/** 계정별 원장 (기간 내 거래와 누적 잔액, 상위 계정이면 하위 합산) */
export async function accountLedger(accountId, from = null, to = null) {
  return call(supabase.rpc('account_ledger', { p_account_id: accountId, p_from: from, p_to: to }));
}

/**
 * 월별 요약: 최근 months개월 각각의 수입·지출, 월말 자산·부채·순자산
 * @param {string} end 기준일 (기기의 오늘) "YYYY-MM-DD"
 */
export async function monthlySummary(ledgerId, months, end) {
  return call(supabase.rpc('monthly_summary', { p_ledger_id: ledgerId, p_months: months, p_end: end }));
}

/** DB 스키마 버전 (업데이트 SQL을 실행했는지 확인) */
export async function schemaVersion() {
  return call(supabase.rpc('schema_version'));
}

/** 장부 검증 (차대 합계, 불균형 전표, 회계 등식) */
export async function ledgerCheck(ledgerId, asOf = null) {
  return call(supabase.rpc('ledger_check', { p_ledger_id: ledgerId, p_as_of: asOf }));
}
