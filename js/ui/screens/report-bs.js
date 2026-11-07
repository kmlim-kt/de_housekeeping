// =====================================================================
// 재무상태표: 기준일의 자산·부채·순자산 (+ 전월 말 대비)
//   순자산 = 기초 순자산 + 누적 손익(수익 − 비용). 회계 등식 일치 여부 표시
// 계산은 core/reports.js(balanceSheet), 원자료는 DB 함수 account_balances.
// =====================================================================

import { h, append, replace, loading, errorBox, kv } from '../dom.js';
import { state, prefs } from '../state.js';
import { statementBlock } from '../statement.js';
import { formatAmount } from '../../core/money.js';
import { balanceSheet, previousMonthEnd } from '../../core/reports.js';
import { todayLocal, isValidDate } from '../../core/journal.js';
import { accountBalances } from '../../data/api.js';
import { downloadCsv } from '../download.js';
import { statementRows } from '../../core/exports.js';

export function render(view) {
  let asOf = todayLocal();
  let compare = prefs.get('bsCompare', true);

  const dateInput = h('input', { type: 'date', value: asOf, 'aria-label': '기준일' });
  dateInput.addEventListener('change', () => { if (isValidDate(dateInput.value)) { asOf = dateInput.value; load(); } });
  const compareToggle = h('label', { class: 'row small', style: 'min-height:44px' },
    h('input', { type: 'checkbox', checked: compare, onChange: (e) => {
      compare = e.target.checked; prefs.set('bsCompare', compare); load();
    } }), '전월 말과 비교');
  const body = h('div', { class: 'stack' });
  let last = null;   // CSV용 마지막 계산 결과
  const csvBtn = h('button', { class: 'btn small', type: 'button', onClick: () => {
    if (!last) return;
    const { bs, label } = last;
    downloadCsv(`재무상태표-${asOf}`, statementRows([
      { title: '자산', rows: bs.assets, total: bs.totals.assets },
      { title: '부채', rows: bs.liabilities, total: bs.totals.liabilities },
      { title: '순자산', rows: bs.equity, total: bs.totals.equity }], label));
  } }, 'CSV');

  append(view,
    h('div', { class: 'row between' },
      h('div', { class: 'row' }, h('a', { href: '#/reports', class: 'btn small ghost' }, '‹ 보고서'),
        h('h1', { class: 'view-title' }, '재무상태표')), csvBtn),
    h('div', { class: 'stack' },
      h('div', { class: 'card stack' },
        h('label', { class: 'field' }, h('span', {}, '기준일'), dateInput), compareToggle),
      body));
  load();

  async function load() {
    replace(body, loading());
    const prevDate = previousMonthEnd(asOf);
    try {
      const [rows, prevRows] = await Promise.all([
        accountBalances(state.ledgerId, null, asOf),
        compare ? accountBalances(state.ledgerId, null, prevDate) : Promise.resolve(null),
      ]);
      const bs = balanceSheet(rows, prevRows);
      const label = compare ? `전월 말(${prevDate.slice(5).replace('-', '/')})` : null;
      last = { bs, label };
      const t = bs.totals;
      replace(body,
        h('section', { class: 'card stack' },
          h('div', { class: 'row between' },
            h('h2', {}, '순자산'),
            h('span', { class: 'badge ' + (bs.ok ? 'ok' : 'bad') }, bs.ok ? '✔ 자산 = 부채 + 순자산' : '✘ 등식 불일치')),
          h('div', { class: 'hero num' }, formatAmount(bs.netWorth) + '원'),
          compare ? h('p', { class: 'small muted' },
            `${label} ${formatAmount(t.assets.previous - t.liabilities.previous)}원 → `
            + `${bs.netWorth - (t.assets.previous - t.liabilities.previous) >= 0 ? '+' : ''}`
            + `${formatAmount(bs.netWorth - (t.assets.previous - t.liabilities.previous))}원`) : null,
          kv('자산 합계', formatAmount(t.assets.amount)),
          kv('부채 합계', formatAmount(t.liabilities.amount)),
          kv('순자산 합계', formatAmount(t.equity.amount))),
        statementBlock({ title: '자산', rows: bs.assets, total: t.assets, compareLabel: label }),
        statementBlock({ title: '부채', rows: bs.liabilities, total: t.liabilities, compareLabel: label, emptyText: '부채 없음' }),
        statementBlock({ title: '순자산', rows: bs.equity, total: t.equity, compareLabel: label }),
        h('p', { class: 'small muted' },
          '누적 손익은 지금까지의 수익에서 비용을 뺀 금액으로, 순자산에 포함됩니다. 항목을 누르면 계정별 원장으로 이동합니다.'));
    } catch (err) {
      replace(body, errorBox(state.online ? err.message : '오프라인이라 재무상태표를 불러올 수 없습니다.', load));
    }
  }
}
