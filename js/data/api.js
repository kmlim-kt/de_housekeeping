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

// ---------------------------------------------------------------------
// 전표
// ---------------------------------------------------------------------

/**
 * 전표 저장 (RPC create_transaction)
 * id는 기기에서 미리 만든 UUID — 같은 id로 다시 보내도 중복 저장되지 않습니다.
 */
export async function createTransaction({ id, ledgerId, date, memo, kind, source, lines }) {
  return call(
    supabase.rpc('create_transaction', {
      p_id: id,
      p_ledger_id: ledgerId,
      p_date: date,
      p_memo: memo,
      p_kind: kind,
      p_source: source,
      p_lines: lines,
    }),
  );
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

/** 장부 검증 (차대 합계, 불균형 전표, 회계 등식) */
export async function ledgerCheck(ledgerId, asOf = null) {
  return call(supabase.rpc('ledger_check', { p_ledger_id: ledgerId, p_as_of: asOf }));
}
