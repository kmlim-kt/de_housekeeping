// =====================================================================
// 대시보드
//   오늘 지출 (합계·어제 대비·항목별·거래 목록)
//   이번 달 수입·지출·저축·저축률 (전월 대비)
//   순자산과 12개월 추이 그래프, 6개월 수입·지출 그래프 (표로 보기 제공)
//   이번 달 지출 상위 항목, 예산(5단계 자리), 장부 검증
// 계산은 core/reports.js, 원자료는 DB 함수 monthly_summary·account_balances·ledger_check.
// =====================================================================

import { h, append, replace, loading, errorBox } from '../dom.js';
import { state } from '../state.js';
import { lineChart, groupedBarChart } from '../charts.js';
import { formatAmount } from '../../core/money.js';
import { rollupType, savingsRate, pctChange, monthRange, currentMonth, dailyExpense, dayBefore } from '../../core/reports.js';
import { todayLocal } from '../../core/journal.js';
import { ledgerCheck, monthlySummary, accountBalances, listBudgets, searchTransactions } from '../../data/api.js';
import { budgetReport } from '../../core/budget.js';
import { statusBadge, meter, remainingText } from '../budget-view.js';
import { recurringDue } from '../recurring-due.js';

export function render(view, ctx) {
  const charts = [];
  const body = h('div', { class: 'stack-lg' }, loading());
  const refresh = h('button', { class: 'btn small', type: 'button', onClick: load }, '새로고침');
  append(view, h('div', { class: 'row between' }, h('h1', { class: 'view-title' }, '대시보드'), refresh),
    h('div', { style: 'margin-bottom:20px' }, recurringDue({ navigate: ctx.navigate, onChange: load })), body);
  load();
  return () => charts.forEach((c) => c?.destroy());   // 화면을 떠날 때 그래프 정리

  async function load() {
    charts.splice(0).forEach((c) => c?.destroy());
    replace(body, loading());
    const today = todayLocal();
    const ym = currentMonth();
    try {
      const [check, months, monthRows, budgets, recent] = await Promise.all([
        ledgerCheck(state.ledgerId),
        monthlySummary(state.ledgerId, 12, today),
        accountBalances(state.ledgerId, monthRange(ym).from, today),
        listBudgets(state.ledgerId, ym),
        // 오늘·어제 전표 (오늘 지출 카드, 어제와 비교)
        searchTransactions({ ledgerId: state.ledgerId, from: dayBefore(today), to: today, limit: 500 }),
      ]);
      draw(check, months, monthRows, ym, budgets, recent.rows, today);
    } catch (err) {
      replace(body, errorBox(state.online ? err.message
        : '오프라인이라 장부 현황을 불러올 수 없습니다. 입력은 계속할 수 있고, 연결되면 자동으로 저장됩니다.', load));
    }
  }

  function draw(r, months, monthRows, ym, budgets, recentTxns, today) {
    const cur = months.at(-1) ?? { income: 0, expense: 0, net_worth: 0 };
    const prev = months.at(-2) ?? { income: 0, expense: 0, net_worth: 0 };
    const saving = cur.income - cur.expense;
    const rate = savingsRate(cur.income, cur.expense);
    const monthLabel = `${Number(ym.slice(5))}월`;
    const label = (m) => `${Number(m.month.slice(5))}월`;

    const netCanvas = h('canvas', { role: 'img', 'aria-label': '최근 12개월 월말 순자산 추이 그래프' });
    const flowCanvas = h('canvas', { role: 'img', 'aria-label': '최근 6개월 월별 수입과 지출 막대 그래프' });
    const recent6 = months.slice(-6);

    replace(body,
      r.total_debit === 0
        ? h('section', { class: 'card stack' },
            h('h2', {}, '처음이신가요?'),
            h('p', { class: 'muted' }, '지금 가진 돈과 갚을 돈을 먼저 적어 두면 순자산이 바로 정확해집니다.'),
            h('a', { class: 'btn primary block', href: '#/opening' }, '개시 잔액 설정하기'))
        : null,

      todayCard(recentTxns, today),

      // ---------- 이번 달 ----------
      h('section', { class: 'stack' },
        h('div', { class: 'row between' }, h('h2', {}, `${monthLabel} 현황`),
          h('a', { href: '#/reports/is', class: 'small' }, '손익계산서 ›')),
        h('div', { class: 'kpis' },
          tile('수입', cur.income, prev.income),
          tile('지출', cur.expense, prev.expense, true),
          tile('저축 (수입 − 지출)', saving, prev.income - prev.expense),
          h('div', { class: 'card kpi' }, h('span', {}, '저축률'),
            h('strong', {}, rate === null ? '—' : `${rate}%`),
            h('small', { class: 'muted' }, rate === null ? '이번 달 수입 없음' : '저축 ÷ 수입')))),

      // ---------- 순자산 ----------
      h('section', { class: 'card stack' },
        h('div', { class: 'row between' }, h('h2', {}, '순자산'),
          h('a', { href: '#/reports/bs', class: 'small' }, '재무상태표 ›')),
        h('div', { class: 'hero num' }, formatAmount(r.net_worth) + '원'),
        h('p', { class: 'small muted' }, deltaText('전월 말 대비', cur.net_worth, prev.net_worth)),
        h('div', { class: 'chart-box' }, netCanvas),
        tableView(['월', '월말 순자산'], months.map((m) => [label(m), formatAmount(m.net_worth)]))),

      // ---------- 월별 수입·지출 ----------
      h('section', { class: 'card stack' },
        h('h2', {}, '월별 수입·지출 (최근 6개월)'),
        h('div', { class: 'chart-box' }, flowCanvas),
        tableView(['월', '수입', '지출', '저축'],
          recent6.map((m) => [label(m), formatAmount(m.income), formatAmount(m.expense), formatAmount(m.income - m.expense)]))),

      topExpenses(monthRows, monthLabel),

      budgetCard(budgets, monthRows, monthLabel),

      // ---------- 장부 검증 ----------
      h('section', { class: 'card stack' },
        h('h2', {}, '장부 검증'),
        check('차변 합계 = 대변 합계', r.debit_credit_ok, `${formatAmount(r.total_debit)} / ${formatAmount(r.total_credit)}`),
        check('차대가 맞지 않는 전표', r.unbalanced_count === 0, `${r.unbalanced_count}건`),
        check('자산 = 부채 + 순자산 + 손익', r.equation_ok,
          `${formatAmount(r.assets)} = ${formatAmount(r.liabilities)} + ${formatAmount(r.equity)} + ${formatAmount(r.net_income)}`)));

    // 그래프 그리기 (Chart.js를 못 불러오면 표가 대신함)
    lineChart(netCanvas, months.map(label), months.map((m) => m.net_worth), '월말 순자산').then((c) => charts.push(c));
    groupedBarChart(flowCanvas, recent6.map(label), [
      { label: '수입', values: recent6.map((m) => m.income) },
      { label: '지출', values: recent6.map((m) => m.expense) },
    ]).then((c) => charts.push(c));
  }
}

/** 숫자 칸: 값 + 전월 대비 */
function tile(label, value, previous, lowerIsBetter = false) {
  const p = pctChange(value, previous);
  const up = value > previous;
  return h('div', { class: 'card kpi' },
    h('span', {}, label),
    h('strong', { class: value < 0 ? 'text-bad' : '' }, formatAmount(value)),
    h('small', { class: 'muted' },
      p === null ? (previous === 0 && value === 0 ? '전월과 같음' : '전월 0원')
        : `전월 대비 ${up ? '▲' : value < previous ? '▼' : ''} ${Math.abs(p)}%${lowerIsBetter && up ? ' 증가' : ''}`));
}

function deltaText(label, cur, prev) {
  const d = cur - prev;
  return `${label} ${d > 0 ? '▲ +' : d < 0 ? '▼ ' : ''}${formatAmount(d)}원`;
}

/**
 * 오늘 지출: 합계(어제 대비), 비용 항목별 합계, 지출 거래 목록(최근 시각 순, 5건 넘으면 접어 둠)
 *   아직 서버에 올라가지 않은(대기 중) 전표는 포함되지 않음
 */
function todayCard(txns, today) {
  const d = dailyExpense(txns, state.accounts, today);
  const y = dailyExpense(txns, state.accounts, dayBefore(today));
  const diff = d.total - y.total;
  const head = h('div', { class: 'row between' }, h('h2', {}, '오늘 지출'),
    h('a', { href: '#/list', class: 'small' }, '거래목록 ›'));

  if (!d.count) {
    return h('section', { class: 'card stack today-card' }, head,
      h('div', { class: 'hero num' }, '0원'),
      h('p', { class: 'small muted' }, `오늘은 아직 지출이 없습니다.${y.total ? ` 어제는 ${formatAmount(y.total)}원 썼습니다.` : ''}`),
      h('a', { class: 'btn primary block', href: '#/entry' }, '지출 입력하기'));
  }

  const max = Math.max(1, ...d.categories.map((c) => c.amount));
  const row = (i) => h('li', {}, h('a', { href: `#/txn/${i.id}`, class: 'today-txn' },
    h('span', { class: 'today-time num' }, i.time || '—'),
    h('span', { class: 'today-main' },
      h('span', { class: 'today-memo' }, i.memo || i.names.join(', ')),
      h('span', { class: 'small muted' }, [i.memo ? i.names.join(', ') : '', i.paidWith.join(', ')].filter(Boolean).join(' · '))),
    h('span', { class: 'num today-amt' + (i.amount < 0 ? ' text-ok' : '') }, formatAmount(i.amount))));
  const first = d.items.slice(0, 5);
  const rest = d.items.slice(5);

  return h('section', { class: 'card stack today-card' }, head,
    h('div', { class: 'hero num' }, formatAmount(d.total) + '원'),
    h('p', { class: 'small muted' },
      `${d.count}건 · 어제 ${formatAmount(y.total)}원`,
      diff ? ` (${diff > 0 ? '▲ ' : '▼ '}${formatAmount(Math.abs(diff))}원 ${diff > 0 ? '더' : '덜'} 씀)` : ' (어제와 같음)'),
    d.categories.length > 1   // 항목이 하나뿐이면 합계와 같아서 생략
      ? h('ul', { class: 'list rank', 'aria-label': '오늘 항목별 지출' }, d.categories.map((c) =>
          h('li', {}, h('div', { class: 'rank-row' },
            h('div', { class: 'row between' }, h('span', {}, c.name), h('span', { class: 'num' }, formatAmount(c.amount))),
            h('div', { class: 'rank-track', 'aria-hidden': 'true' },
              h('div', { class: 'rank-bar', style: `width:${Math.max(2, (Math.max(0, c.amount) / max) * 100)}%` }))))))
      : null,
    h('ul', { class: 'list today-list', 'aria-label': '오늘 지출 거래' }, first.map(row)),
    rest.length
      ? h('details', { class: 'table-view' }, h('summary', {}, `나머지 ${rest.length}건 더 보기`),
          h('ul', { class: 'list today-list' }, rest.map(row)))
      : null);
}

/** 이번 달 지출 상위 5개 — 순위 막대(한 가지 색), 누르면 원장 */
function topExpenses(rows, monthLabel) {
  const list = rollupType(rows, 'expense').filter((r) => r.amount > 0).sort((a, b) => b.amount - a.amount);
  const total = list.reduce((s, r) => s + r.amount, 0);
  const top = list.slice(0, 5);
  const max = top[0]?.amount ?? 1;
  return h('section', { class: 'card stack' },
    h('div', { class: 'row between' }, h('h2', {}, `${monthLabel} 지출 상위`),
      h('span', { class: 'small muted num' }, `합계 ${formatAmount(total)}원`)),
    top.length
      ? h('ul', { class: 'list rank' }, top.map((r) =>
          h('li', {}, h('a', { href: `#/reports/ledger?account=${r.id}`, class: 'rank-row' },
            h('div', { class: 'row between' },
              h('span', {}, r.name),
              h('span', { class: 'num' }, `${formatAmount(r.amount)} · ${Math.round((r.amount / total) * 100)}%`)),
            h('div', { class: 'rank-track', 'aria-hidden': 'true' },
              h('div', { class: 'rank-bar', style: `width:${Math.max(2, (r.amount / max) * 100)}%` }))))))
      : h('p', { class: 'muted' }, '이번 달 지출이 아직 없습니다.'));
}

/** 예산 대비 지출: 전체 사용률 + 주의·초과 항목 (최대 4개) */
function budgetCard(budgets, rows, monthLabel) {
  const r = budgetReport(budgets, rows, state.accounts);
  const head = h('div', { class: 'row between' }, h('h2', {}, `${monthLabel} 예산`),
    h('a', { href: '#/reports/budget', class: 'small' }, r.items.length ? '예산 ›' : '예산 정하기 ›'));
  if (!r.items.length) {
    return h('section', { class: 'card stack' }, head,
      h('p', { class: 'small muted' }, '식비·교통 등 항목별로 한 달 예산을 정하면 여기에서 얼마나 썼는지, 넘쳤는지 보여 드립니다.'));
  }
  const alerts = r.items.filter((i) => i.status !== 'ok').sort((a, b) => b.percent - a.percent).slice(0, 4);
  return h('section', { class: 'card stack' }, head,
    h('div', { class: 'row between num' },
      h('span', {}, `${formatAmount(r.total.spent)} / ${formatAmount(r.total.budget)}원`),
      statusBadge(r.total.status)),
    meter(r.total),
    h('p', { class: 'small muted' }, remainingText(r.total)),
    alerts.length
      ? h('ul', { class: 'list' }, alerts.map((i) => h('li', { class: 'stack', style: 'gap:4px' },
          h('div', { class: 'row between' }, h('span', {}, i.name),
            h('span', { class: 'row', style: 'gap:6px' }, h('span', { class: 'small num' }, `${i.percent}%`), statusBadge(i.status))),
          meter(i))))
      : h('p', { class: 'small' }, '✔ 모든 항목이 예산 안에 있습니다.'));
}

/** 그래프 아래 "표로 보기" (그래프를 못 보는 경우·정확한 숫자 확인용) */
function tableView(headers, rows) {
  return h('details', { class: 'table-view' },
    h('summary', {}, '표로 보기'),
    h('table', { class: 'tb-table' },
      h('thead', {}, h('tr', {}, headers.map((x) => h('th', {}, x)))),
      h('tbody', {}, rows.map((r) => h('tr', {}, r.map((x) => h('td', {}, x)))))));
}

function check(label, ok, detail) {
  return h('div', { class: 'check-row' },
    h('div', {}, h('div', {}, label), h('div', { class: 'small muted num' }, detail)),
    h('span', { class: 'badge ' + (ok ? 'ok' : 'bad') }, ok ? '✔ 정상' : '✘ 확인 필요'));
}
