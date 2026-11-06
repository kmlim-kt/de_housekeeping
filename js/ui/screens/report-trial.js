// =====================================================================
// 시산표: 모든 계정의 차변·대변 합계와 잔액, 일치 여부
//   기준일까지 누계. 상위 계정은 하위 합산(▶ 눌러 펼치기).
//   넓은 화면은 표, 휴대폰은 카드형 목록으로 보여 줍니다.
// 계산은 core/reports.js(trialBalance), 원자료는 DB 함수 account_balances.
// =====================================================================

import { h, append, replace, loading, errorBox } from '../dom.js';
import { state, prefs } from '../state.js';
import { TYPE_LABELS } from '../../core/balance.js';
import { formatAmount } from '../../core/money.js';
import { trialBalance } from '../../core/reports.js';
import { todayLocal, isValidDate } from '../../core/journal.js';
import { accountBalances } from '../../data/api.js';

export function render(view) {
  let asOf = todayLocal();
  let hideZero = prefs.get('tbHideZero', true);
  let raw = null;

  const dateInput = h('input', { type: 'date', value: asOf, 'aria-label': '기준일' });
  dateInput.addEventListener('change', () => { if (isValidDate(dateInput.value)) { asOf = dateInput.value; load(); } });
  const zeroToggle = h('label', { class: 'row small', style: 'min-height:44px' },
    h('input', { type: 'checkbox', checked: hideZero, onChange: (e) => {
      hideZero = e.target.checked; prefs.set('tbHideZero', hideZero); draw();
    } }), '거래 없는 계정 숨기기');
  const body = h('div', { class: 'stack' });

  append(view,
    h('div', { class: 'row' }, h('a', { href: '#/reports', class: 'btn small ghost' }, '‹ 보고서'),
      h('h1', { class: 'view-title' }, '시산표')),
    h('div', { class: 'stack' },
      h('div', { class: 'card stack' },
        h('label', { class: 'field' }, h('span', {}, '기준일 (이 날까지 누계)'), dateInput), zeroToggle),
      body));

  load();

  async function load() {
    replace(body, loading());
    try {
      raw = await accountBalances(state.ledgerId, null, asOf);
      draw();
    } catch (err) {
      replace(body, errorBox(state.online ? err.message : '오프라인이라 시산표를 불러올 수 없습니다.', load));
    }
  }

  function draw() {
    if (!raw) return;
    const tb = trialBalance(raw, { hideZero });
    const t = tb.totals;
    replace(body,
      h('section', { class: 'card stack ' + (tb.ok ? '' : 'deleted-banner') },
        h('div', { class: 'row between' },
          h('h2', {}, tb.ok ? '차변·대변 일치' : '차변·대변 불일치'),
          h('span', { class: 'badge ' + (tb.ok ? 'ok' : 'bad') }, tb.ok ? '✔ 정상' : '✘ 확인 필요')),
        h('div', { class: 'kv' }, h('span', { class: 'muted' }, '합계 (차변 / 대변)'),
          h('span', { class: 'num' }, `${formatAmount(t.debit)} / ${formatAmount(t.credit)}`)),
        h('div', { class: 'kv' }, h('span', { class: 'muted' }, '잔액 (차변 / 대변)'),
          h('span', { class: 'num' }, `${formatAmount(t.debitBalance)} / ${formatAmount(t.creditBalance)}`))),
      h('section', { class: 'card only-wide' }, table(tb)),
      h('section', { class: 'card only-narrow tb-cards' }, cards(tb)),
      h('p', { class: 'small muted' },
        '차변 잔액은 자산·비용, 대변 잔액은 부채·순자산·수익 계정에 주로 나옵니다. 휴지통 전표는 포함하지 않습니다.'));
  }
}

/** 넓은 화면: 표 */
function table(tb) {
  const num = (v) => h('td', {}, v ? formatAmount(v) : '');
  const rows = [];
  for (const g of tb.groups) {
    if (!g.rows.length) continue;
    rows.push(h('tr', { class: 'group' }, h('td', { colspan: '5' }, TYPE_LABELS[g.type])));
    for (const r of g.rows) {
      rows.push(h('tr', {}, h('td', {}, r.name + (r.hidden ? ' (숨김)' : '')),
        num(r.debit), num(r.credit), num(r.debitBalance), num(r.creditBalance)));
      if (r.own) rows.push(h('tr', { class: 'child' }, h('td', {}, '(상위 계정에 직접 기록)'),
        num(r.own.debit), num(r.own.credit), num(r.own.debitBalance), num(r.own.creditBalance)));
      for (const c of r.children) {
        rows.push(h('tr', { class: 'child' }, h('td', {}, c.name + (c.hidden ? ' (숨김)' : '')),
          num(c.debit), num(c.credit), num(c.debitBalance), num(c.creditBalance)));
      }
    }
  }
  const t = tb.totals;
  return h('table', { class: 'tb-table' },
    h('thead', {}, h('tr', {}, ...['계정', '차변 합계', '대변 합계', '차변 잔액', '대변 잔액'].map((x) => h('th', {}, x)))),
    h('tbody', {}, rows),
    h('tfoot', {}, h('tr', {}, h('td', {}, '합계'), num(t.debit), num(t.credit), num(t.debitBalance), num(t.creditBalance))));
}

/** 휴대폰: 카드형 목록 (상위 계정은 눌러서 하위 펼치기) */
function cards(tb) {
  const out = [];
  for (const g of tb.groups) {
    if (!g.rows.length) continue;
    out.push(h('div', { class: 'row between', style: 'padding:12px 0 4px' },
      h('h3', {}, TYPE_LABELS[g.type]), h('span', { class: 'num small muted' }, formatAmount(g.subtotal.balance))));
    for (const r of g.rows) {
      const kids = h('div', { class: 'hidden' },
        r.own ? card({ ...r.own, name: '(상위 계정에 직접 기록)' }, true) : null,
        r.children.map((c) => card(c, true)));
      const head = card(r, false, r.children.length ? () => {
        const open = kids.classList.toggle('hidden') === false;
        head.querySelector('.caret').textContent = open ? '▼' : '▶';
        head.setAttribute('aria-expanded', String(open));
      } : null);
      out.push(head, kids);
    }
  }
  return out;
}

function card(r, child, onToggle) {
  const side = r.debitBalance ? `차변 잔액 ${formatAmount(r.debitBalance)}` : r.creditBalance ? `대변 잔액 ${formatAmount(r.creditBalance)}` : '잔액 0';
  return h(onToggle ? 'button' : 'div', {
    class: 'tb-card' + (child ? ' child' : ''),
    type: onToggle ? 'button' : null,
    style: onToggle ? 'width:100%;border:0;background:none;text-align:left;cursor:pointer;color:inherit' : null,
    'aria-expanded': onToggle ? 'false' : null,
    onClick: onToggle ?? null,
  },
    h('div', { class: 'row between' },
      h('span', {}, onToggle ? h('span', { class: 'caret small muted' }, '▶') : null, ' ', r.name, r.hidden ? ' (숨김)' : ''),
      h('strong', { class: 'num' }, formatAmount(r.balance))),
    h('div', { class: 'row between small muted num' },
      h('span', {}, `차 ${formatAmount(r.debit)} · 대 ${formatAmount(r.credit)}`), h('span', {}, side)));
}
