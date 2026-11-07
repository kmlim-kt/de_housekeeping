// =====================================================================
// 재무제표 표 부품: 항목(상위/하위) + 금액 + 비교 금액·증감
//   넓은 화면: 표 / 휴대폰: 카드형 (비교·증감은 금액 아래 작은 글씨)
//   상위 계정을 누르면 원장으로 이동합니다.
// =====================================================================

import { h } from './dom.js';
import { formatAmount } from '../core/money.js';
import { pctChange } from '../core/reports.js';

/** 증감 표시: +12,000 (+3.5%) */
function diffText(cur, prev) {
  const d = cur - prev;
  if (!d) return '변동 없음';
  const p = pctChange(cur, prev);
  return `${d > 0 ? '+' : ''}${formatAmount(d)}${p === null ? '' : ` (${p > 0 ? '+' : ''}${p}%)`}`;
}

const ledgerHref = (id) => (id && id !== 'retained' ? `#/reports/ledger?account=${id}` : null);

/**
 * @param {{ title: string, rows: Array, total: {amount, previous}, compareLabel?: string|null,
 *           emptyText?: string, totalLabel?: string }} o
 */
export function statementBlock({ title, rows, total, compareLabel = null, emptyText = '항목 없음', totalLabel }) {
  const compare = compareLabel !== null && total.previous !== null;
  const label = totalLabel ?? `${title} 합계`;

  // ---------- 넓은 화면: 표 ----------
  const head = h('tr', {}, h('th', {}, title), h('th', {}, '금액'),
    compare ? h('th', {}, compareLabel) : null, compare ? h('th', {}, '증감') : null);
  const tr = (r, child) => h('tr', { class: child ? 'child' : '' },
    h('td', {}, ledgerHref(r.id) ? h('a', { href: ledgerHref(r.id) }, r.name) : r.name, r.hidden ? ' (숨김)' : ''),
    h('td', {}, formatAmount(r.amount)),
    compare ? h('td', {}, formatAmount(r.previous ?? 0)) : null,
    compare ? h('td', { class: 'small' }, diffText(r.amount, r.previous ?? 0)) : null);
  const body = rows.flatMap((r) => [
    tr(r, false),
    ...(r.own ? [tr({ name: '(상위 계정에 직접 기록)', amount: r.own, previous: null }, true)] : []),
    ...r.children.map((c) => tr(c, true)),
  ]);
  const table = h('table', { class: 'tb-table st-table' },
    h('thead', {}, head),
    h('tbody', {}, body.length ? body : h('tr', {}, h('td', { colspan: compare ? '4' : '2', class: 'muted' }, emptyText))),
    h('tfoot', {}, h('tr', {}, h('td', {}, label), h('td', {}, formatAmount(total.amount)),
      compare ? h('td', {}, formatAmount(total.previous)) : null,
      compare ? h('td', { class: 'small' }, diffText(total.amount, total.previous)) : null)));

  // ---------- 휴대폰: 카드형 ----------
  const card = (r, child) => h('div', { class: 'tb-card' + (child ? ' child' : '') },
    h('div', { class: 'row between' },
      ledgerHref(r.id) ? h('a', { href: ledgerHref(r.id), style: 'color:inherit' }, r.name) : h('span', {}, r.name),
      h('strong', { class: 'num' }, formatAmount(r.amount))),
    compare && r.previous !== null
      ? h('div', { class: 'row between small muted num' },
          h('span', {}, `${compareLabel} ${formatAmount(r.previous ?? 0)}`), h('span', {}, diffText(r.amount, r.previous ?? 0)))
      : null);
  const cards = h('div', { class: 'tb-cards' },
    rows.length ? rows.flatMap((r) => [card(r, false), ...r.children.map((c) => card(c, true))]) : h('p', { class: 'muted' }, emptyText),
    h('div', { class: 'row between st-total' },
      h('strong', {}, label), h('strong', { class: 'num' }, formatAmount(total.amount))),
    compare ? h('div', { class: 'row between small muted num' },
      h('span', {}, `${compareLabel} ${formatAmount(total.previous)}`), h('span', {}, diffText(total.amount, total.previous))) : null);

  return h('section', { class: 'card stack' },
    h('div', { class: 'only-wide' }, table),
    h('div', { class: 'only-narrow' }, h('h2', {}, title), cards));
}
