// =====================================================================
// 간편 입력 → 분개 자동 변환, 개시 잔액 → 분개 변환
// 회계 용어 없이 고른 항목을 차변·대변 라인으로 바꿉니다.
// 화면(DOM) 코드는 넣지 않습니다.
// =====================================================================

import { parseAmount, sumAmounts } from './money.js';

// ---------------------------------------------------------------------
// 계정 고르기 기준 (계정 행 → 이 칸에 보여 줄지)
// ---------------------------------------------------------------------

/** 돈이 나가거나 들어오는 계좌: 현금·은행·세부 분류 없는 자산 */
const isCashLike = (a) => a.type === 'asset' && (!a.subtype || a.subtype === 'cash' || a.subtype === 'bank');
/** 입금받을 수 있는 자산: 현금·은행·적금·투자·세부 분류 없음 */
const isDepositable = (a) => a.type === 'asset' && a.subtype !== 'receivable';
const isCard = (a) => a.type === 'liability' && a.subtype === 'card';
const isLoan = (a) => a.type === 'liability' && (a.subtype === 'loan' || a.subtype === 'payable');

/**
 * 간편 입력 종류별 화면 정의
 *   amounts: 금액 칸 [{key, label}]
 *   pickers: 계정 고르기 칸 [{key, label, filter, auto}]  (위에서부터 화면에 표시)
 *     auto: true면 최근에 쓴 계정을 미리 골라 둠 (결제수단처럼 매번 같은 경우가 많은 칸)
 *     prefer: 사용 기록이 없을 때 미리 고를 계정 이름
 */
export const SIMPLE_FORMS = {
  expense: {
    label: '지출',
    amounts: [{ key: 'amount', label: '금액' }],
    pickers: [
      { key: 'expenseId', label: '무엇에 썼나요?', filter: (a) => a.type === 'expense' },
      { key: 'sourceId', label: '어디서 나갔나요?', filter: (a) => isCashLike(a) || isCard(a), auto: true },
    ],
  },
  income: {
    label: '수입',
    amounts: [{ key: 'amount', label: '금액' }],
    pickers: [
      { key: 'incomeId', label: '무슨 수입인가요?', filter: (a) => a.type === 'income' },
      { key: 'depositId', label: '어디로 들어왔나요?', filter: isDepositable, auto: true },
    ],
  },
  transfer: {
    label: '이체',
    amounts: [{ key: 'amount', label: '금액' }],
    pickers: [
      { key: 'fromId', label: '어디에서 (보내는 계좌)', filter: (a) => a.type === 'asset', auto: true },
      { key: 'toId', label: '어디로 (받는 계좌)', filter: (a) => a.type === 'asset' },
    ],
  },
  card_payment: {
    label: '카드대금',
    amounts: [{ key: 'amount', label: '결제 금액' }],
    pickers: [
      { key: 'cardId', label: '어느 카드?', filter: isCard, auto: true },
      { key: 'fromId', label: '어느 계좌에서 빠져나갔나요?', filter: isCashLike, auto: true },
    ],
  },
  loan_repayment: {
    label: '대출 상환',
    amounts: [{ key: 'principal', label: '원금' }, { key: 'interest', label: '이자' }],
    pickers: [
      { key: 'loanId', label: '어느 대출?', filter: isLoan, auto: true },
      { key: 'fromId', label: '어느 계좌에서 빠져나갔나요?', filter: isCashLike, auto: true },
      { key: 'interestId', label: '이자는 어느 비용으로?', filter: (a) => a.type === 'expense', auto: true, prefer: '대출이자' },
    ],
  },
};

export const SIMPLE_KINDS = Object.keys(SIMPLE_FORMS);

/**
 * 간편 입력 값 → 분개 라인
 * @param {string} kind SIMPLE_KINDS 중 하나
 * @param {Record<string, string|number>} f 입력값 (금액은 문자열·숫자, 계정은 id)
 * @returns {{ ok: boolean, errors: string[], lines: Array<{account_id, debit, credit}>, total: number }}
 */
export function buildSimple(kind, f) {
  const form = SIMPLE_FORMS[kind];
  if (!form) return { ok: false, errors: ['알 수 없는 입력 종류입니다.'], lines: [], total: 0 };
  const errors = [];

  // 금액 확인
  const amt = {};
  for (const { key, label } of form.amounts) {
    const v = parseAmount(f[key]);
    if (v === null) errors.push(`${label}은(는) 원 단위 숫자만 넣을 수 있습니다.`);
    amt[key] = v ?? 0;
  }
  // 계정 확인
  for (const { key, label } of form.pickers) {
    if (!f[key]) errors.push(`${label.replace(/\?$/, '')} — 계정을 고르세요.`);
  }

  let lines = [];
  const L = (account_id, debit, credit) => ({ account_id, debit, credit });

  switch (kind) {
    case 'expense':      // 차변 비용 / 대변 자산 또는 카드부채
      lines = [L(f.expenseId, amt.amount, 0), L(f.sourceId, 0, amt.amount)];
      break;
    case 'income':       // 차변 자산 / 대변 수익
      lines = [L(f.depositId, amt.amount, 0), L(f.incomeId, 0, amt.amount)];
      break;
    case 'transfer':     // 차변 받는 자산 / 대변 보내는 자산
      if (f.fromId && f.fromId === f.toId) errors.push('보내는 계좌와 받는 계좌가 같습니다.');
      lines = [L(f.toId, amt.amount, 0), L(f.fromId, 0, amt.amount)];
      break;
    case 'card_payment': // 차변 카드부채(감소) / 대변 통장
      lines = [L(f.cardId, amt.amount, 0), L(f.fromId, 0, amt.amount)];
      break;
    case 'loan_repayment': { // 차변 대출(원금, 부채 감소) + 차변 이자비용 / 대변 통장(합계)
      const total = sumAmounts([amt.principal, amt.interest]);
      lines = [
        ...(amt.principal > 0 ? [L(f.loanId, amt.principal, 0)] : []),
        ...(amt.interest > 0 ? [L(f.interestId, amt.interest, 0)] : []),
        L(f.fromId, 0, total),
      ];
      break;
    }
    default:
      break;
  }

  const total = lines.reduce((s, l) => s + l.debit, 0);
  if (!errors.some((e) => e.includes('숫자')) && total === 0) errors.push('금액을 넣으세요.');
  return { ok: errors.length === 0, errors, lines: errors.length ? [] : lines, total };
}

/**
 * 저장된 분개 → 간편 입력 값 (간편 입력으로 만든 전표를 같은 화면에서 수정할 때)
 * 분개 모양이 그 종류의 간편 입력과 정확히 같을 때만 값을 돌려주고, 아니면 null(고급 입력으로 수정)
 * @param {string} kind
 * @param {Array<{account_id, debit, credit}>} lines
 * @param {Map<string, {type: string}>} byId
 * @returns {Record<string, string|number> | null}
 */
export function parseSimple(kind, lines, byId) {
  if (!SIMPLE_FORMS[kind]) return null;
  const debits = lines.filter((l) => l.debit > 0);
  const credits = lines.filter((l) => l.credit > 0);
  let v = null;
  if (kind === 'loan_repayment') {
    if (credits.length !== 1 || !debits.length || debits.length > 2) return null;
    const loan = debits.find((l) => byId.get(l.account_id)?.type === 'liability');
    const interest = debits.find((l) => byId.get(l.account_id)?.type === 'expense');
    v = { fromId: credits[0].account_id,
          loanId: loan?.account_id ?? '', principal: loan?.debit ?? '',
          interestId: interest?.account_id ?? '', interest: interest?.debit ?? '' };
  } else {
    if (debits.length !== 1 || credits.length !== 1) return null;
    const d = debits[0].account_id;
    const c = credits[0].account_id;
    const amount = debits[0].debit;
    v = {
      expense: { expenseId: d, sourceId: c, amount },
      income: { depositId: d, incomeId: c, amount },
      transfer: { toId: d, fromId: c, amount },
      card_payment: { cardId: d, fromId: c, amount },
    }[kind];
  }
  // 되돌린 값으로 다시 만들어 원래 분개와 같은지 확인 (이자만 낸 대출 상환 등은 계정 칸이 비어 있을 수 있음)
  const rebuilt = buildSimple(kind, { ...v, loanId: v.loanId || 'x', interestId: v.interestId || 'x' });
  const norm = (ls) => ls.filter((l) => l.account_id !== 'x')
    .map((l) => `${l.account_id}:${l.debit}:${l.credit}`).sort().join('|');
  return rebuilt.ok && norm(rebuilt.lines) === norm(lines) ? v : null;
}

// ---------------------------------------------------------------------
// 개시 잔액
// ---------------------------------------------------------------------

/**
 * 개시 잔액 → 분개
 *   자산 잔액은 차변, 부채 잔액은 대변, 차이(순자산)는 기초 순자산 계정으로
 *   순자산이 음수(부채가 더 많음)면 기초 순자산이 차변으로 갑니다.
 * @param {Array<{ accountId: string, amount: string|number }>} entries
 * @param {string} openingEquityId 기초 순자산 계정 id
 * @param {Map<string, {type: string}>} byId 계정 맵
 * @returns {{ ok, errors: string[], lines, assets: number, liabilities: number, netWorth: number }}
 */
export function buildOpening(entries, openingEquityId, byId) {
  const errors = [];
  const lines = [];
  let assets = 0;
  let liabilities = 0;

  for (const { accountId, amount } of entries) {
    const v = parseAmount(amount);
    const acc = byId.get(accountId);
    if (v === null) {
      errors.push(`${acc?.name ?? '계정'}: 금액은 원 단위 숫자만 넣을 수 있습니다.`);
      continue;
    }
    if (!v) continue;
    if (acc?.type === 'asset') {
      lines.push({ account_id: accountId, debit: v, credit: 0 });
      assets = sumAmounts([assets, v]);
    } else if (acc?.type === 'liability') {
      lines.push({ account_id: accountId, debit: 0, credit: v });
      liabilities = sumAmounts([liabilities, v]);
    } else {
      errors.push(`${acc?.name ?? '알 수 없는 계정'}: 개시 잔액은 자산·부채 계정에만 넣습니다.`);
    }
  }

  const netWorth = assets - liabilities;
  if (!openingEquityId) errors.push('기초 순자산 계정이 없습니다.');
  if (!lines.length) errors.push('잔액을 하나 이상 넣으세요.');
  if (netWorth > 0) lines.push({ account_id: openingEquityId, debit: 0, credit: netWorth });
  if (netWorth < 0) lines.push({ account_id: openingEquityId, debit: -netWorth, credit: 0 });

  return { ok: errors.length === 0, errors, lines: errors.length ? [] : lines, assets, liabilities, netWorth };
}

// ---------------------------------------------------------------------
// 최근 사용 순서
// ---------------------------------------------------------------------

/**
 * 최근에 쓴 계정이 앞으로 오도록 정렬 (나머지는 원래 순서 유지)
 * @param {Array<{id: string}>} options
 * @param {Record<string, number>} lastUsed 계정 id → 마지막 사용 시각(ms)
 */
export function sortByRecent(options, lastUsed = {}) {
  return options
    .map((o, i) => ({ o, i, t: lastUsed[o.id] ?? 0 }))
    .sort((a, b) => b.t - a.t || a.i - b.i)
    .map((x) => x.o);
}

/** 가장 최근에 쓴 계정 id (없으면 첫 번째) — 결제수단 기본값 등에 사용 */
export function mostRecentId(options, lastUsed = {}) {
  return sortByRecent(options, lastUsed)[0]?.id ?? '';
}

/**
 * 선택지(기록 가능한 계정)를 "상위 → 하위" 두 단계로 묶음
 *   하위가 있는 상위: { id: 상위id, label: 상위 이름, children: [하위 선택지…] }
 *   하위가 없는 계정: { id: 계정id, label: 이름, children: null }  (누르면 바로 선택)
 *   순서: 상위 줄은 그 묶음에서 가장 최근에 쓴 계정 기준, 하위 줄도 최근 사용 순 (나머지는 원래 순서)
 * @param {Array<{id: string, label: string, account: {parent_id: string|null}}>} options
 * @param {Map<string, {name: string}>} byId 전체 계정 맵 (상위 이름 찾기)
 * @param {Record<string, number>} lastUsed
 */
export function groupOptions(options, byId, lastUsed = {}) {
  const groups = [];
  const index = new Map();
  for (const o of options) {
    const parentId = o.account?.parent_id;
    if (!parentId) {
      groups.push({ id: o.id, label: o.label, children: null, leaf: o });
      continue;
    }
    if (!index.has(parentId)) {
      const g = { id: parentId, label: byId.get(parentId)?.name ?? o.label, children: [] };
      index.set(parentId, g);
      groups.push(g);
    }
    index.get(parentId).children.push(o);
  }
  const lastOf = (g) => (g.children ? Math.max(0, ...g.children.map((c) => lastUsed[c.id] ?? 0)) : lastUsed[g.id] ?? 0);
  for (const g of groups) if (g.children) g.children = sortByRecent(g.children, lastUsed);
  return groups
    .map((g, i) => ({ g, i, t: lastOf(g) }))
    .sort((a, b) => b.t - a.t || a.i - b.i)
    .map((x) => x.g);
}

/** 계정 id → 그 계정이 들어 있는 묶음 */
export function groupOf(groups, accountId) {
  return groups.find((g) => (g.children ? g.children.some((c) => c.id === accountId) : g.id === accountId)) ?? null;
}

/**
 * 하위가 있는 상위를 눌렀을 때 미리 고를 하위: 지금 고른 것이 그 묶음에 있으면 유지, 아니면 가장 최근에 쓴 하위
 * (하위 줄은 이미 최근 사용 순으로 정렬되어 있음)
 */
export function childToPreselect(group, currentId) {
  if (!group?.children?.length) return group?.id ?? '';
  return group.children.some((c) => c.id === currentId) ? currentId : group.children[0].id;
}

/**
 * 간편 입력 칸의 기본 선택값
 *   auto가 아니면 '' (사용자가 직접 고름)
 *   prefer(예: 대출이자)가 있으면 그 이름의 계정, 없으면 최근 사용 계정
 * @param {{auto?: boolean, prefer?: string}} picker
 * @param {Array<{id: string, account: {name: string}}>} options
 */
export function defaultChoice(picker, options, lastUsed = {}) {
  if (!picker.auto || !options.length) return '';
  if (picker.prefer) {
    const preferred = options.find((o) => o.account?.name === picker.prefer);
    if (preferred) return preferred.id;
  }
  return mostRecentId(options, lastUsed);
}
