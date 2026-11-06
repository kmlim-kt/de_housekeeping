// =====================================================================
// 여러 화면에서 쓰는 부품: 계정 선택 상자, 전표 한 건 표시
// =====================================================================

import { h } from './dom.js';
import { state } from './state.js';
import { KIND_LABELS } from '../core/journal.js';
import { buildAccountTree, accountLabel, ACCOUNT_TYPES, TYPE_LABELS } from '../core/balance.js';
import { formatAmount } from '../core/money.js';

/**
 * 계정 선택 상자 (분류별 묶음, 상위 계정도 고를 수 있음 — 조회·필터용)
 * @param {{ value?: string, allLabel?: string, includeHidden?: boolean, onChange: (id: string) => void, label?: string }} o
 */
export function accountFilterSelect({ value = '', allLabel = '전체 계정', includeHidden = true, onChange, label = '계정' }) {
  const tree = buildAccountTree(state.accounts);
  const groups = ACCOUNT_TYPES.map((type) => {
    const items = tree[type].flatMap((top) => [
      { a: top, depth: 0 },
      ...top.children.map((c) => ({ a: c, depth: 1 })),
    ]).filter(({ a }) => includeHidden || !a.is_hidden);
    if (!items.length) return null;
    return h('optgroup', { label: TYPE_LABELS[type] }, items.map(({ a, depth }) =>
      h('option', { value: a.id },
        (depth ? '　└ ' : '') + a.name + (a.children?.length ? ' (하위 포함)' : '') + (a.is_hidden ? ' (숨김)' : ''))));
  });
  return h('select', { 'aria-label': label, value, onChange: (e) => onChange(e.target.value) },
    allLabel ? h('option', { value: '' }, allLabel) : null, groups);
}

/** 작성자 표시 */
export function authorLabel(userId) {
  if (!userId) return '';
  return userId === state.user?.id ? '나' : '다른 구성원';
}

/**
 * 전표 한 건 (목록용). 누르면 상세 화면으로
 * @param {{ id, txn_date, memo, kind, lines: Array<{account_id, debit, credit, line_no}>, total?: number }} t
 * @param {Map} byId
 * @param {{ link?: boolean, showDate?: boolean }} [opts]
 */
export function transactionCard(t, byId, { link = true, showDate = true } = {}) {
  const sorted = [...t.lines].sort((a, b) => (b.debit - a.debit) || (a.line_no - b.line_no));
  const total = t.total ?? t.lines.reduce((s, l) => s + l.debit, 0);
  const inner = [
    h('div', { class: 'row between' },
      h('strong', {}, t.memo || KIND_LABELS[t.kind] || '전표'),
      h('span', { class: 'amount-strong' }, formatAmount(total))),
    h('div', { class: 'lines' }, sorted.map((l) =>
      h('div', {},
        h('span', { class: l.debit > 0 ? 'debit' : 'credit' },
          (l.debit > 0 ? '차변 ' : '대변 ') + accountLabel(byId.get(l.account_id), byId)),
        h('span', { class: 'num' }, formatAmount(l.debit || l.credit))))),
    h('div', { class: 'row between small muted' },
      h('span', {}, KIND_LABELS[t.kind] ?? t.kind),
      showDate ? h('span', { class: 'num' }, t.txn_date) : null),
  ];
  return link
    ? h('a', { class: 'txn txn-link', href: '#/txn/' + t.id }, inner)
    : h('div', { class: 'txn' }, inner);
}
