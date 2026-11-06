// =====================================================================
// 계정과목·잔액 규칙
//   자산·비용        : 차변이 늘어나는 쪽(+)
//   부채·순자산·수익 : 대변이 늘어나는 쪽(+)
// 화면(DOM) 코드는 넣지 않습니다.
// =====================================================================

import { formatAmount } from './money.js';

/** 계정 분류 (표시 순서) */
export const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'income', 'expense'];

/** 계정 분류 한국어 이름 */
export const TYPE_LABELS = {
  asset: '자산',
  liability: '부채',
  equity: '순자산',
  income: '수익',
  expense: '비용',
};

/** 세부 분류 한국어 이름 */
export const SUBTYPE_LABELS = {
  cash: '현금',
  bank: '은행 계좌',
  savings: '적금',
  investment: '투자',
  receivable: '받을 돈',
  card: '신용카드',
  loan: '대출',
  payable: '갚을 돈',
  opening: '개시 잔액',
};

/** 차변이 늘어나는(+) 분류인가? */
export function isDebitNormal(type) {
  return type === 'asset' || type === 'expense';
}

/**
 * 부호 규칙을 적용한 잔액
 * @param {string} type 계정 분류
 * @param {number} debit 차변 합계
 * @param {number} credit 대변 합계
 */
export function signedBalance(type, debit, credit) {
  return isDebitNormal(type) ? debit - credit : credit - debit;
}

/**
 * 계정 목록을 분류별 2단계 트리로 정리
 * @param {Array} accounts DB의 accounts 행 배열
 * @returns {Record<string, Array<object & {children: Array}>>}
 */
export function buildAccountTree(accounts) {
  const bySort = [...accounts].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, 'ko'));
  const tree = Object.fromEntries(ACCOUNT_TYPES.map((t) => [t, []]));
  const nodes = new Map(bySort.map((a) => [a.id, { ...a, children: [] }]));
  for (const node of nodes.values()) {
    const parent = node.parent_id ? nodes.get(node.parent_id) : null;
    if (parent) parent.children.push(node);
    else tree[node.type]?.push(node);
  }
  return tree;
}

/** 계정 id → 계정 객체 맵 */
export function indexAccounts(accounts) {
  return new Map(accounts.map((a) => [a.id, a]));
}

/** 하위 계정이 있는지 (있으면 직접 기록할 수 없는 상위 계정) */
export function hasChildren(accountId, accounts) {
  return accounts.some((a) => a.parent_id === accountId);
}

/**
 * 표시용 계정 이름: 하위 계정이면 "상위 > 하위"
 * @param {object} account
 * @param {Map} byId indexAccounts 결과
 */
export function accountLabel(account, byId) {
  if (!account) return '(알 수 없는 계정)';
  const parent = account.parent_id ? byId.get(account.parent_id) : null;
  return parent ? `${parent.name} > ${account.name}` : account.name;
}

/**
 * 분개에 쓸 수 있는 계정 목록 (하위 계정이 없는 계정, 기본은 숨김 제외)
 * 분류 순서 → 정렬 순서대로, 표시 이름 포함
 * @returns {Array<{id, type, label, account}>}
 */
export function postableAccounts(accounts, { includeHidden = false } = {}) {
  const byId = indexAccounts(accounts);
  const parents = new Set(accounts.filter((a) => a.parent_id).map((a) => a.parent_id));
  const tree = buildAccountTree(accounts);
  const result = [];
  for (const type of ACCOUNT_TYPES) {
    for (const top of tree[type]) {
      const group = top.children.length ? top.children : [top];
      for (const acc of group) {
        if (parents.has(acc.id)) continue;
        // 상위가 숨김이면 하위도 숨김으로 취급
        const hidden = acc.is_hidden || (acc.parent_id && byId.get(acc.parent_id)?.is_hidden);
        if (hidden && !includeHidden) continue;
        result.push({ id: acc.id, type: acc.type, label: accountLabel(acc, byId), account: acc });
      }
    }
  }
  return result;
}

/**
 * 분개 라인을 사람이 읽을 수 있는 문장으로: "차변 식비 30,000 / 대변 현금 30,000"
 * @param {Array<{account_id, debit, credit}>} lines
 * @param {Map} byId
 */
export function describeLines(lines, byId) {
  const part = (side) =>
    lines
      .filter((l) => (side === 'debit' ? l.debit : l.credit) > 0)
      .map((l) => `${accountLabel(byId.get(l.account_id), byId)} ${formatAmount(side === 'debit' ? l.debit : l.credit)}`)
      .join(', ');
  return `차변 ${part('debit') || '-'} / 대변 ${part('credit') || '-'}`;
}
