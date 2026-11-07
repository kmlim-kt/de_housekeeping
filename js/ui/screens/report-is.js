// =====================================================================
// 손익계산서: 월 또는 연 단위 수익·비용 항목별, 전월(전년) 대비 증감
//   당기순이익 = 수익 − 비용, 저축률 = 순이익 ÷ 수익
// 계산은 core/reports.js(incomeStatement), 원자료는 DB 함수 account_balances.
// =====================================================================

import { h, append, replace, loading, errorBox, kv } from '../dom.js';
import { state, prefs } from '../state.js';
import { statementBlock } from '../statement.js';
import { formatAmount } from '../../core/money.js';
import { incomeStatement, monthRange, shiftMonth, currentMonth, pctChange } from '../../core/reports.js';
import { accountBalances } from '../../data/api.js';

export function render(view) {
  let unit = prefs.get('isUnit', 'month');     // 'month' | 'year'
  let month = currentMonth();
  let year = Number(month.slice(0, 4));

  const unitTabs = h('div', { class: 'segmented', role: 'group', 'aria-label': '기간 단위' });
  const nav = h('div', { class: 'row between' });
  const body = h('div', { class: 'stack' });

  append(view,
    h('div', { class: 'row' }, h('a', { href: '#/reports', class: 'btn small ghost' }, '‹ 보고서'),
      h('h1', { class: 'view-title' }, '손익계산서')),
    h('div', { class: 'stack' }, h('div', { class: 'card stack' }, unitTabs, nav), body));

  drawControls();
  load();

  function drawControls() {
    replace(unitTabs, [['month', '월별'], ['year', '연간']].map(([u, label]) =>
      h('button', { type: 'button', 'aria-pressed': String(unit === u),
        onClick: () => { if (unit !== u) { unit = u; prefs.set('isUnit', u); drawControls(); load(); } } }, label)));
    const title = unit === 'month' ? `${month.slice(0, 4)}년 ${Number(month.slice(5))}월` : `${year}년`;
    const step = (d) => { if (unit === 'month') month = shiftMonth(month, d); else year += d; drawControls(); load(); };
    replace(nav,
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': '이전 기간', onClick: () => step(-1) }, '‹'),
      h('strong', {}, title),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': '다음 기간', onClick: () => step(1) }, '›'));
  }

  function ranges() {
    if (unit === 'month') {
      return { cur: monthRange(month), prev: monthRange(shiftMonth(month, -1)), label: '전월' };
    }
    return { cur: { from: `${year}-01-01`, to: `${year}-12-31` },
      prev: { from: `${year - 1}-01-01`, to: `${year - 1}-12-31` }, label: '전년' };
  }

  async function load() {
    replace(body, loading());
    const { cur, prev, label } = ranges();
    try {
      const [rows, prevRows] = await Promise.all([
        accountBalances(state.ledgerId, cur.from, cur.to),
        accountBalances(state.ledgerId, prev.from, prev.to),
      ]);
      const is = incomeStatement(rows, prevRows);
      const t = is.totals;
      const netPct = pctChange(t.net.amount, t.net.previous);
      replace(body,
        h('section', { class: 'card stack' },
          h('h2', {}, t.net.amount >= 0 ? '당기순이익' : '당기순손실'),
          h('div', { class: 'hero num ' + (t.net.amount < 0 ? 'text-bad' : '') }, formatAmount(t.net.amount) + '원'),
          h('p', { class: 'small muted' },
            `${label} ${formatAmount(t.net.previous)}원`
            + (netPct === null ? '' : ` · ${netPct > 0 ? '+' : ''}${netPct}%`)),
          kv('수익 합계', formatAmount(t.income.amount)),
          kv('비용 합계', formatAmount(t.expense.amount)),
          kv('저축률', is.savingsRate === null ? '— (수입 없음)' : `${is.savingsRate}%`)),
        statementBlock({ title: '수익', rows: is.income, total: t.income, compareLabel: label, emptyText: '이 기간 수익 없음' }),
        statementBlock({ title: '비용', rows: is.expense, total: t.expense, compareLabel: label, emptyText: '이 기간 비용 없음' }),
        h('p', { class: 'small muted' }, '휴지통 전표는 포함하지 않습니다. 항목을 누르면 계정별 원장으로 이동합니다.'));
    } catch (err) {
      replace(body, errorBox(state.online ? err.message : '오프라인이라 손익계산서를 불러올 수 없습니다.', load));
    }
  }
}
