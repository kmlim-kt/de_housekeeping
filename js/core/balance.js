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

/**
 * 트리 순서(분류 → 상위 → 그 상위의 하위)로 펼친 계정 배열
 *   예산·목록처럼 한 줄로 늘어놓는 곳에서 계정과목 화면과 같은 순서를 쓰기 위함
 */
export function flattenAccountTree(accounts) {
  const tree = buildAccountTree(accounts);
  return ACCOUNT_TYPES.flatMap((t) => tree[t].flatMap((top) => [top, ...top.children]));
}

/** 계정 id → 트리 순서 번호 맵 */
export function accountRank(accounts) {
  return new Map(flattenAccountTree(accounts).map((a, i) => [a.id, i]));
}

/**
 * 계정을 같은 묶음 안에서 한 칸 위(-1)·아래(+1)로 옮길 때 바뀌는 정렬 번호
 *   묶음: 최상위 계정은 같은 분류의 최상위끼리, 하위 계정은 같은 상위의 하위끼리
 *   그 분류 전체를 트리 순서대로 10 간격으로 다시 매기고, 값이 바뀐 계정만 돌려줌
 *   (처음 한 번은 여러 개가 바뀔 수 있고, 그다음부터는 보통 몇 개만 바뀜)
 * @param {Array} accounts 계정 목록
 * @param {string} id 옮길 계정
 * @param {-1|1} dir 위(-1) / 아래(+1)
 * @returns {Array<{id: string, sort_order: number}>} 끝에 있어 못 옮기면 빈 배열
 */
export function moveAccount(accounts, id, dir) {
  const acc = accounts.find((a) => a.id === id);
  if (!acc) return [];
  const i = siblingsOf(accounts, acc).findIndex((s) => s.id === id);
  return moveAccountTo(accounts, id, i + dir);
}

/** 같은 묶음(같은 분류의 최상위 / 같은 상위의 하위) 계정들, 현재 순서대로 */
function siblingsOf(accounts, acc, tops = buildAccountTree(accounts)[acc.type] ?? []) {
  return acc.parent_id ? (tops.find((t) => t.id === acc.parent_id)?.children ?? []) : tops;
}

/**
 * 계정을 같은 묶음 안의 원하는 자리(0부터)로 옮길 때 바뀌는 정렬 번호 (끌어서 옮기기)
 * @param {Array} accounts
 * @param {string} id
 * @param {number} toIndex 옮긴 뒤 묶음 안에서의 자리
 * @returns {Array<{id: string, sort_order: number}>} 자리가 그대로이거나 범위 밖이면 빈 배열
 */
export function moveAccountTo(accounts, id, toIndex) {
  const acc = accounts.find((a) => a.id === id);
  if (!acc) return [];
  const tops = buildAccountTree(accounts)[acc.type] ?? [];
  const siblings = siblingsOf(accounts, acc, tops);
  const i = siblings.findIndex((s) => s.id === id);
  if (i < 0 || toIndex === i || toIndex < 0 || toIndex >= siblings.length) return [];
  siblings.splice(toIndex, 0, ...siblings.splice(i, 1));

  const ordered = tops.flatMap((t) => [t, ...t.children]);
  const base = Math.max(0, Math.min(...ordered.map((a) => a.sort_order)));
  const changes = [];
  ordered.forEach((a, k) => {
    const next = base + k * 10;
    if (a.sort_order !== next) changes.push({ id: a.id, sort_order: next });
  });
  return changes;
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
