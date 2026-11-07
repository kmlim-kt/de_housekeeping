// =====================================================================
// 대시보드
//   이번 달 수입·지출·저축·저축률 (전월 대비)
//   순자산과 12개월 추이 그래프, 6개월 수입·지출 그래프 (표로 보기 제공)
//   이번 달 지출 상위 항목, 예산(5단계 자리), 장부 검증
// 계산은 core/reports.js, 원자료는 DB 함수 monthly_summary·account_balances·ledger_check.
// =====================================================================

import { h, append, replace, loading, errorBox } from '../dom.js';
import { state } from '../state.js';
import { lineChart, groupedBarChart } from '../charts.js';
import { formatAmount } from '../../core/money.js';
import { rollupType, savingsRate, pctChange, monthRange, currentMonth } from '../../core/reports.js';
import { todayLocal } from '../../core/journal.js';
import { ledgerCheck, monthlySummary, accountBalances } from '../../data/api.js';

export function render(view) {
  const charts = [];
  const body = h('div', { class: 'stack-lg' }, loading());
  const refresh = h('button', { class: 'btn small', type: 'button', onClick: load }, '새로고침');
  append(view, h('div', { class: 'row between' }, h('h1', { class: 'view-title' }, '대시보드'), refresh), body);
  load();
  return () => charts.forEach((c) => c?.destroy());   // 화면을 떠날 때 그래프 정리

  async function load() {
    charts.splice(0).forEach((c) => c?.destroy());
    replace(body, loading());
    const today = todayLocal();
    const ym = currentMonth();
    try {
      const [check, months, monthRows] = await Promise.all([
        ledgerCheck(state.ledgerId),
        monthlySummary(state.ledgerId, 12, today),
        accountBalances(state.ledgerId, monthRange(ym).from, today),
      ]);
      draw(check, months, monthRows, ym);
    } catch (err) {
      replace(body, errorBox(state.online ? err.message
        : '오프라인이라 장부 현황을 불러올 수 없습니다. 입력은 계속할 수 있고, 연결되면 자동으로 저장됩니다.', load));
    }
  }

  function draw(r, months, monthRows, ym) {
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

      h('section', { class: 'card stack' },
        h('h2', {}, '예산 대비 지출'),
        h('p', { class: 'small muted' }, '비용 계정별 월 예산과 초과 경고는 5단계에서 이곳에 추가됩니다.')),

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
