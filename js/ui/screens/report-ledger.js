// =====================================================================
// 계정별 원장: 계정 하나(상위 계정이면 하위 합산)의 거래 내역과 누적 잔액
//   기간 시작 전 잔액(이월) → 거래마다 증감 → 기간 말 잔액
//   잔액 부호: 자산·비용은 차변(+), 부채·순자산·수익은 대변(+)
// 계산은 DB 함수 account_ledger 가 합니다.
// =====================================================================

import { h, append, replace, loading, errorBox } from '../dom.js';
import { state, prefs } from '../state.js';
import { accountFilterSelect } from '../widgets.js';
import { indexAccounts, accountLabel, isDebitNormal, TYPE_LABELS } from '../../core/balance.js';
import { formatAmount } from '../../core/money.js';
import { periodRange, PERIOD_LABELS, accountTotal, dayBefore } from '../../core/reports.js';
import { KIND_LABELS } from '../../core/journal.js';
import { accountLedger, accountBalances } from '../../data/api.js';

export function render(view, ctx) {
  const byId = indexAccounts(state.accounts);
  let accountId = ctx.params.get('account') || prefs.get('ledgerAccount.' + state.ledgerId, '');
  if (!byId.has(accountId)) accountId = state.accounts.find((a) => a.type === 'asset' && !a.parent_id)?.id ?? '';
  let period = prefs.get('ledgerPeriod', 'thisMonth');

  const picker = accountFilterSelect({
    value: accountId, allLabel: null, label: '계정',
    onChange: (id) => { accountId = id; prefs.set('ledgerAccount.' + state.ledgerId, id); load(); },
  });
  const periodTabs = h('div', { class: 'segmented kinds', role: 'group', 'aria-label': '기간' });
  const body = h('div', { class: 'stack' });

  append(view,
    h('div', { class: 'row' }, h('a', { href: '#/reports', class: 'btn small ghost' }, '‹ 보고서'),
      h('h1', { class: 'view-title' }, '계정별 원장')),
    h('div', { class: 'stack' }, h('div', { class: 'card stack' }, picker, periodTabs), body));

  drawPeriods();
  load();

  function drawPeriods() {
    replace(periodTabs, Object.entries(PERIOD_LABELS).map(([key, label]) =>
      h('button', { type: 'button', 'aria-pressed': String(period === key),
        onClick: () => { period = key; prefs.set('ledgerPeriod', key); drawPeriods(); load(); } }, label)));
  }

  async function load() {
    if (!accountId) return replace(body, h('p', { class: 'muted' }, '계정을 고르세요.'));
    replace(body, loading());
    const acc = byId.get(accountId);
    const { from, to } = periodRange(period);
    try {
      // 거래 내역 + 기간 전 잔액(이월) + 기간 말 잔액
      const [rows, endRows, startRows] = await Promise.all([
        accountLedger(accountId, from, to),
        accountBalances(state.ledgerId, null, to),
        from ? accountBalances(state.ledgerId, null, dayBefore(from)) : Promise.resolve(null),
      ]);
      const opening = startRows ? accountTotal(startRows, accountId) : null;
      const closing = accountTotal(endRows, accountId);
      const debitSum = rows.reduce((s, r) => s + r.debit, 0);
      const creditSum = rows.reduce((s, r) => s + r.credit, 0);
      const sideNote = isDebitNormal(acc.type) ? '차변이 늘면 잔액 증가' : '대변이 늘면 잔액 증가';

      replace(body,
        h('section', { class: 'card stack' },
          h('div', { class: 'row between' },
            h('h2', {}, accountLabel(acc, byId)),
            h('span', { class: 'badge' }, `${TYPE_LABELS[acc.type]} · ${sideNote}`)),
          h('div', { class: 'stack', style: 'gap:4px' },
            from ? line('기간 전 잔액(이월)', opening) : null,
            line('차변 합계', debitSum, 'debit'),
            line('대변 합계', creditSum, 'credit'),
            line(from ? '기간 말 잔액' : '현재 잔액', closing, 'strong')),
          acc.children?.length || state.accounts.some((a) => a.parent_id === acc.id)
            ? h('p', { class: 'small muted' }, '상위 계정이라 하위 계정의 거래를 합쳐 보여 줍니다.') : null),
        h('section', { class: 'card' },
          rows.length
            ? h('div', {}, rows.map((r) => h('a', { class: 'ledger-row', href: '#/txn/' + r.transaction_id },
                h('span', {}, h('span', { class: 'small muted num' }, r.txn_date + ' '), r.memo || KIND_LABELS[r.kind] || '전표'),
                h('span', { class: 'num ' + (r.debit ? 'debit' : 'credit') },
                  (r.debit ? '차 ' : '대 ') + formatAmount(r.debit || r.credit)),
                h('span', { class: 'sub' },
                  `상대 계정: ${r.counter_accounts || '-'} · 잔액 ${formatAmount(r.running_balance)}`))))
            : h('p', { class: 'muted' }, '이 기간에 거래가 없습니다.')));
    } catch (err) {
      replace(body, errorBox(state.online ? err.message : '오프라인이라 원장을 불러올 수 없습니다.', load));
    }
  }
}

function line(label, value, cls = '') {
  return h('div', { class: 'kv' + (cls === 'strong' ? ' amount-strong' : '') },
    h('span', { class: cls === 'strong' ? '' : 'muted' }, label),
    h('span', { class: 'num ' + (cls === 'debit' || cls === 'credit' ? cls : '') },
      typeof value === 'number' ? formatAmount(value) : value));
}
