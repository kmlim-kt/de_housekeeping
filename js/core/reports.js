// =====================================================================
// 보고서 계산: 시산표 (상위 계정은 하위 계정 합산)
// 입력은 DB 함수 account_balances 의 결과 행입니다.
// 화면(DOM) 코드는 넣지 않습니다.
// =====================================================================

import { ACCOUNT_TYPES, signedBalance } from './balance.js';
import { sumAmounts } from './money.js';

/**
 * @typedef {{ account_id: string, name: string, type: string, parent_id: string|null,
 *             is_hidden?: boolean, sort_order: number, debit_total: number, credit_total: number }} BalanceRow
 */

/** 한 계정(또는 합산)의 시산표 숫자 */
function figures(type, debit, credit) {
  const net = debit - credit;
  return {
    debit,                           // 차변 합계
    credit,                          // 대변 합계
    debitBalance: net > 0 ? net : 0, // 차변 잔액
    creditBalance: net < 0 ? -net : 0, // 대변 잔액
    balance: signedBalance(type, debit, credit), // 부호 규칙 적용 잔액
  };
}

/**
 * 시산표
 * @param {BalanceRow[]} rows
 * @param {{ hideZero?: boolean }} [opts] hideZero: 거래가 한 번도 없는 계정 숨김
 * @returns {{
 *   groups: Array<{ type: string, rows: Array<object>, subtotal: object }>,
 *   totals: { debit, credit, debitBalance, creditBalance },
 *   ok: boolean   // 차변 합계 = 대변 합계, 차변 잔액 합계 = 대변 잔액 합계
 * }}
 *   rows의 각 항목: { id, name, type, isParent, children: [...], ...figures }
 *   합계는 최상위 행(상위 계정은 하위 합산)만 더해 이중 계산을 막습니다.
 */
export function trialBalance(rows, { hideZero = false } = {}) {
  const sorted = [...rows].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, 'ko'));
  const byParent = new Map();
  for (const r of sorted) {
    if (r.parent_id) {
      if (!byParent.has(r.parent_id)) byParent.set(r.parent_id, []);
      byParent.get(r.parent_id).push(r);
    }
  }
  const active = (r) => r.debit_total !== 0 || r.credit_total !== 0;

  const groups = ACCOUNT_TYPES.map((type) => {
    const tops = sorted.filter((r) => r.type === type && !r.parent_id);
    const out = [];
    for (const top of tops) {
      const kids = (byParent.get(top.account_id) ?? []).filter((c) => !hideZero || active(c));
      const debit = sumAmounts([top.debit_total, ...kids.map((c) => c.debit_total)]);
      const credit = sumAmounts([top.credit_total, ...kids.map((c) => c.credit_total)]);
      if (hideZero && debit === 0 && credit === 0) continue;
      out.push({
        id: top.account_id, name: top.name, type, isParent: kids.length > 0 || byParent.has(top.account_id),
        hidden: !!top.is_hidden,
        ...figures(type, debit, credit),
        // 상위 계정에 하위가 생기기 전 직접 기록된 금액이 있으면 "(미분류)"로 따로 보여 줌
        own: kids.length && active(top) ? figures(type, top.debit_total, top.credit_total) : null,
        children: kids.map((c) => ({ id: c.account_id, name: c.name, type, hidden: !!c.is_hidden,
          ...figures(type, c.debit_total, c.credit_total) })),
      });
    }
    const subtotal = {
      debit: sumAmounts(out.map((r) => r.debit)),
      credit: sumAmounts(out.map((r) => r.credit)),
      balance: sumAmounts(out.map((r) => r.balance)),
    };
    return { type, rows: out, subtotal };
  });

  const all = groups.flatMap((g) => g.rows);
  const totals = {
    debit: sumAmounts(all.map((r) => r.debit)),
    credit: sumAmounts(all.map((r) => r.credit)),
    debitBalance: sumAmounts(all.map((r) => r.debitBalance)),
    creditBalance: sumAmounts(all.map((r) => r.creditBalance)),
  };
  return {
    groups,
    totals,
    ok: totals.debit === totals.credit && totals.debitBalance === totals.creditBalance,
  };
}

/**
 * 계정 하나의 잔액 (상위 계정이면 하위 계정 합산, 부호 규칙 적용)
 * @param {BalanceRow[]} rows account_balances 결과
 * @param {string} accountId
 */
export function accountTotal(rows, accountId) {
  const own = rows.find((r) => r.account_id === accountId);
  if (!own) return 0;
  const group = rows.filter((r) => r.account_id === accountId || r.parent_id === accountId);
  const debit = sumAmounts(group.map((r) => r.debit_total));
  const credit = sumAmounts(group.map((r) => r.credit_total));
  return signedBalance(own.type, debit, credit);
}

// ---------------------------------------------------------------------
// 재무상태표·손익계산서
// ---------------------------------------------------------------------

/**
 * 한 분류의 계정을 상위/하위로 묶어 부호 규칙 잔액으로 (상위 = 자신 + 하위 합)
 * @param {BalanceRow[]} rows
 * @param {string} type
 * @returns {Array<{ id, name, amount, hidden, children: Array<{id, name, amount, hidden}> }>}
 */
export function rollupType(rows, type) {
  const sorted = rows.filter((r) => r.type === type)
    .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, 'ko'));
  const amt = (r) => signedBalance(type, r.debit_total, r.credit_total);
  return sorted.filter((r) => !r.parent_id).map((top) => {
    const kids = sorted.filter((c) => c.parent_id === top.account_id);
    return {
      id: top.account_id, name: top.name, hidden: !!top.is_hidden,
      amount: sumAmounts([amt(top), ...kids.map(amt)]),
      own: kids.length ? amt(top) : 0,   // 하위가 생기기 전 상위에 직접 기록된 금액
      children: kids.map((c) => ({ id: c.account_id, name: c.name, hidden: !!c.is_hidden, amount: amt(c) })),
    };
  });
}

/** 두 시점(또는 기간)의 rollup을 계정별로 나란히 (비교 열) */
function pairRollup(cur, prev) {
  const prevMap = new Map();
  for (const r of prev ?? []) {
    prevMap.set(r.id, r.amount);
    for (const c of r.children) prevMap.set(c.id, c.amount);
  }
  const withPrev = (x) => ({ ...x, previous: prev ? (prevMap.get(x.id) ?? 0) : null });
  return cur.map((r) => ({ ...withPrev(r), children: r.children.map(withPrev) }));
}

/** 0이 아닌 행만 (비교 기간에 값이 있으면 남김) */
function nonZero(list) {
  return list
    .map((r) => ({ ...r, children: r.children.filter((c) => c.amount || c.previous) }))
    .filter((r) => r.amount || r.previous);
}

const totalOf = (list, key = 'amount') => sumAmounts(list.map((r) => r[key] ?? 0));

/**
 * 재무상태표 (기준일 누계)
 *   순자산 = 순자산 계정(기초 순자산 등) + 누적 손익(수익 − 비용, 마감하지 않은 이익잉여금)
 * @param {BalanceRow[]} rows   account_balances(장부, null, 기준일)
 * @param {BalanceRow[]} [prevRows] 비교 시점(예: 전월 말) — 없으면 비교 열 없음
 */
export function balanceSheet(rows, prevRows = null) {
  const side = (type) => nonZero(pairRollup(rollupType(rows, type), prevRows && rollupType(prevRows, type)));
  const profit = (rs) => {
    const inc = rollupType(rs, 'income').reduce((s, r) => s + r.amount, 0);
    const exp = rollupType(rs, 'expense').reduce((s, r) => s + r.amount, 0);
    return inc - exp;
  };
  const assets = side('asset');
  const liabilities = side('liability');
  const equityAccounts = side('equity');
  const retained = { id: 'retained', name: '누적 손익 (수익 − 비용)', amount: profit(rows),
    previous: prevRows ? profit(prevRows) : null, children: [], computed: true };
  const equity = [...equityAccounts, ...(retained.amount || retained.previous ? [retained] : [])];

  const t = (list) => ({ amount: totalOf(list), previous: prevRows ? totalOf(list, 'previous') : null });
  const totals = { assets: t(assets), liabilities: t(liabilities), equity: t(equity) };
  return {
    assets, liabilities, equity, totals,
    netWorth: totals.assets.amount - totals.liabilities.amount,
    // 회계 등식: 자산 = 부채 + 순자산
    ok: totals.assets.amount === totals.liabilities.amount + totals.equity.amount,
  };
}

/**
 * 손익계산서 (기간)
 * @param {BalanceRow[]} rows      account_balances(장부, 시작일, 종료일)
 * @param {BalanceRow[]} [prevRows] 비교 기간(전월·전년)
 */
export function incomeStatement(rows, prevRows = null) {
  const side = (type) => nonZero(pairRollup(rollupType(rows, type), prevRows && rollupType(prevRows, type)));
  const income = side('income');
  const expense = side('expense');
  const t = (list) => ({ amount: totalOf(list), previous: prevRows ? totalOf(list, 'previous') : null });
  const ti = t(income);
  const te = t(expense);
  return {
    income, expense,
    totals: {
      income: ti,
      expense: te,
      net: { amount: ti.amount - te.amount, previous: prevRows ? ti.previous - te.previous : null },
    },
    savingsRate: savingsRate(ti.amount, te.amount),
  };
}

/**
 * 저축률(%) = (수입 − 지출) ÷ 수입 × 100, 소수 첫째 자리. 수입이 0 이하면 null(계산 불가)
 */
export function savingsRate(income, expense) {
  if (!(income > 0)) return null;
  return Math.round(((income - expense) / income) * 1000) / 10;
}

/** 증감률(%) — 비교값이 0이면 null. 소수 첫째 자리 */
export function pctChange(current, previous) {
  if (!previous) return null;
  return Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
}

/** "YYYY-MM" → 그 달의 { from, to } */
export function monthRange(ym) {
  const [y, m] = ym.split('-').map(Number);
  return { from: ymd(new Date(y, m - 1, 1)), to: ymd(new Date(y, m, 0)) };
}

/** "YYYY-MM"에서 delta개월 이동 */
export function shiftMonth(ym, delta) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

/** 오늘이 속한 달 "YYYY-MM" */
export function currentMonth(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
}

/** 어떤 날짜의 전월 말일 */
export function previousMonthEnd(s) {
  const [y, m] = s.split('-').map(Number);
  return ymd(new Date(y, m - 1, 0));
}

/** 하루 전 날짜 "YYYY-MM-DD" */
export function dayBefore(s) {
  const [y, m, d] = s.split('-').map(Number);
  return ymd(new Date(y, m - 1, d - 1));
}

// ---------------------------------------------------------------------
// 기간 바로 고르기
// ---------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** 기간 이름 → { from, to } ("YYYY-MM-DD" 또는 null) */
export const PERIOD_LABELS = {
  thisMonth: '이번 달',
  lastMonth: '지난 달',
  thisYear: '올해',
  all: '전체',
};

export function periodRange(key, now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth();
  switch (key) {
    case 'thisMonth': return { from: ymd(new Date(y, m, 1)), to: ymd(new Date(y, m + 1, 0)) };
    case 'lastMonth': return { from: ymd(new Date(y, m - 1, 1)), to: ymd(new Date(y, m, 0)) };
    case 'thisYear': return { from: `${y}-01-01`, to: `${y}-12-31` };
    default: return { from: null, to: null };
  }
}
