// =====================================================================
// 예산: 비용 계정별 월 예산 설정과 사용 현황
//   금액을 넣으면 잠시 뒤 자동 저장(0원이나 빈칸이면 예산 삭제)
//   상위 계정 예산은 하위 계정 지출 합산. 80% 이상 주의, 넘으면 초과 경고
//   [지난달 예산 가져오기]로 복사
// 계산은 core/budget.js(budgetReport)가 합니다.
// =====================================================================

import { h, append, replace, loading, errorBox, toast, withBusy } from '../dom.js';
import { amountInput } from '../amount-input.js';
import { state } from '../state.js';
import { statusBadge, meter, remainingText } from '../budget-view.js';
import { formatAmount } from '../../core/money.js';
import { budgetReport, figures } from '../../core/budget.js';
import { buildAccountTree } from '../../core/balance.js';
import { monthRange, shiftMonth, currentMonth } from '../../core/reports.js';
import { listBudgets, saveBudget, copyBudgets, accountBalances } from '../../data/api.js';

export function render(view) {
  let month = currentMonth();
  let budgets = [];
  let rows = [];
  const timers = new Map();

  const nav = h('div', { class: 'row between' });
  const summary = h('div');
  const list = h('div', { class: 'stack' });

  append(view,
    h('div', { class: 'row' }, h('a', { href: '#/reports', class: 'btn small ghost' }, '‹ 보고서'),
      h('h1', { class: 'view-title' }, '예산')),
    h('div', { class: 'stack' }, h('div', { class: 'card' }, nav), summary, list,
      h('p', { class: 'small muted' },
        '금액을 넣으면 자동으로 저장됩니다. 빈칸으로 두면 예산이 없는 항목입니다. 상위 계정(예: 식비)에 예산을 넣으면 하위 계정(외식·장보기) 지출을 합쳐서 비교합니다.')));

  drawNav();
  load();
  return () => timers.forEach((t) => clearTimeout(t));

  function drawNav() {
    replace(nav,
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': '이전 달', onClick: () => step(-1) }, '‹'),
      h('strong', {}, `${month.slice(0, 4)}년 ${Number(month.slice(5))}월`),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': '다음 달', onClick: () => step(1) }, '›'));
  }

  function step(d) {
    month = shiftMonth(month, d);
    drawNav();
    load();
  }

  async function load() {
    replace(summary);
    replace(list, loading());
    const { from, to } = monthRange(month);
    try {
      [budgets, rows] = await Promise.all([listBudgets(state.ledgerId, month), accountBalances(state.ledgerId, from, to)]);
      draw();
    } catch (err) {
      replace(list, errorBox(state.online ? err.message : '오프라인이라 예산을 불러올 수 없습니다.', load));
    }
  }

  function draw() {
    drawSummary();
    const tree = buildAccountTree(state.accounts).expense.filter((a) => !a.is_hidden || budgetOf(a.id));
    replace(list, h('section', { class: 'card' },
      h('ul', { class: 'list' }, tree.flatMap((top) => [
        row(top, false),
        ...top.children.filter((c) => !c.is_hidden || budgetOf(c.id)).map((c) => row(c, true)),
      ]))));
  }

  function budgetOf(id) {
    return budgets.find((b) => b.account_id === id)?.amount ?? 0;
  }

  function drawSummary() {
    const r = budgetReport(budgets, rows, state.accounts);
    const copyBtn = h('button', { class: 'btn small', type: 'button' }, '지난달 예산 가져오기');
    copyBtn.addEventListener('click', () => withBusy(copyBtn, '가져오는 중…', async () => {
      if (budgets.length && !confirm('지난달 예산으로 이번 달 예산을 덮어쓸까요?')) return;
      try {
        const n = await copyBudgets(state.ledgerId, shiftMonth(month, -1), month);
        toast(n ? `지난달 예산 ${n}건을 가져왔습니다.` : '지난달에 정한 예산이 없습니다.');
        load();
      } catch (err) { toast(err.message, { type: 'error' }); }
    }));

    replace(summary, h('section', { class: 'card stack' },
      h('div', { class: 'row between' }, h('h2', {}, '이번 달 예산'),
        r.items.length ? statusBadge(r.total.status) : null),
      r.items.length
        ? [
            h('div', { class: 'row between num' },
              h('span', {}, `${formatAmount(r.total.spent)} / ${formatAmount(r.total.budget)}원`),
              h('strong', {}, r.total.percent === null ? '' : `${r.total.percent}%`)),
            meter(r.total),
            h('p', { class: 'small muted' }, remainingText(r.total)
              + (r.unbudgeted ? ` · 예산 밖 지출 ${formatAmount(r.unbudgeted)}원` : '')),
          ]
        : h('p', { class: 'muted small' }, '아직 이 달 예산이 없습니다. 아래 항목에 금액을 넣거나 지난달 예산을 가져오세요.'),
      h('div', { class: 'row' }, copyBtn)));
  }

  /** 한 계정: 예산 입력 + 사용 현황 */
  function row(acc, child) {
    const r = budgetReport(budgets, rows, state.accounts);
    const item = r.items.find((i) => i.accountId === acc.id);
    const spent = item?.spent ?? spentOf(acc.id);
    const status = h('div', { class: 'budget-status' });
    const saved = h('span', { class: 'small muted', 'aria-live': 'polite' });

    function drawStatus(amount) {
      const f = figures(amount, spent);
      replace(status,
        h('div', { class: 'row between small' },
          h('span', { class: 'muted num' }, `사용 ${formatAmount(spent)}원`),
          amount ? h('span', { class: 'row', style: 'gap:6px' }, h('span', { class: 'num' }, remainingText(f)), statusBadge(f.status)) : null),
        amount ? meter(f) : null);
    }

    const input = amountInput({
      label: `${acc.name} 예산`, value: budgetOf(acc.id), placeholder: '예산 없음',
      onChange: (amount) => {
        if (amount === null) return;
        drawStatus(amount);
        saved.textContent = '';
        clearTimeout(timers.get(acc.id));
        timers.set(acc.id, setTimeout(() => save(acc.id, amount, saved), 700));
      },
    });
    drawStatus(budgetOf(acc.id));

    return h('li', { class: 'budget-row' + (child ? ' child' : '') },
      h('div', { class: 'budget-head' },
        h('span', { class: 'name' }, (child ? '└ ' : '') + acc.name, acc.children?.length ? h('span', { class: 'small muted' }, ' (하위 합산)') : null),
        input),
      status, saved);
  }

  function spentOf(id) {
    const own = rows.find((x) => x.account_id === id);
    const kids = rows.filter((x) => x.parent_id === id);
    return [own, ...kids].filter(Boolean).reduce((s, x) => s + x.debit_total - x.credit_total, 0);
  }

  async function save(accountId, amount, savedEl) {
    try {
      await saveBudget(state.ledgerId, accountId, month, amount);
      const i = budgets.findIndex((b) => b.account_id === accountId);
      if (amount) {
        if (i >= 0) budgets[i].amount = amount;
        else budgets.push({ account_id: accountId, month, amount });
      } else if (i >= 0) budgets.splice(i, 1);
      savedEl.textContent = '저장됨';
      drawSummary();
    } catch (err) {
      savedEl.textContent = '';
      toast(err.message, { type: 'error' });
    }
  }
}
