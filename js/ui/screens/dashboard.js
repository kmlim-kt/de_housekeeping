// =====================================================================
// 대시보드 — 1단계: 장부 상태(순자산·자산·부채·누적 손익) + 장부 검증 결과
//   이번 달 수입·지출·저축률, 그래프, 예산은 4~5단계에서 추가합니다.
// =====================================================================

import { h, append, replace, loading, errorBox } from '../dom.js';
import { state } from '../state.js';
import { formatAmount } from '../../core/money.js';
import { ledgerCheck } from '../../data/api.js';

export function render(view) {
  const body = h('div', { class: 'stack-lg' }, loading());
  const refresh = h('button', { class: 'btn small', type: 'button', onClick: load }, '새로고침');
  append(view, h('div', { class: 'row between' }, h('h1', { class: 'view-title' }, '대시보드'), refresh), body);
  load();

  async function load() {
    replace(body, loading());
    try {
      const r = await ledgerCheck(state.ledgerId);
      replace(body,
        h('section', { class: 'kpis' },
          kpi('순자산', r.net_worth),
          kpi('자산', r.assets),
          kpi('부채', r.liabilities),
          kpi('누적 손익', r.net_income)),
        h('section', { class: 'card stack' },
          h('h2', {}, '장부 검증'),
          check('차변 합계 = 대변 합계', r.debit_credit_ok,
            `${formatAmount(r.total_debit)} / ${formatAmount(r.total_credit)}`),
          check('차대가 맞지 않는 전표', r.unbalanced_count === 0, `${r.unbalanced_count}건`),
          check('자산 = 부채 + 순자산 + 손익', r.equation_ok,
            `${formatAmount(r.assets)} = ${formatAmount(r.liabilities)} + ${formatAmount(r.equity)} + ${formatAmount(r.net_income)}`)),
        h('p', { class: 'notice small' }, '이번 달 수입·지출·저축률, 순자산 추이 그래프, 예산 현황은 다음 단계에서 이곳에 추가됩니다.'));
    } catch (err) {
      replace(body, errorBox(err.message, load));
    }
  }
}

function kpi(label, value) {
  return h('div', { class: 'card kpi' }, h('span', {}, label), h('strong', { class: value < 0 ? 'credit' : '' }, formatAmount(value) + '원'));
}

function check(label, ok, detail) {
  return h('div', { class: 'check-row' },
    h('div', {}, h('div', {}, label), h('div', { class: 'small muted num' }, detail)),
    h('span', { class: 'badge ' + (ok ? 'ok' : 'bad') }, ok ? '✔ 정상' : '✘ 확인 필요'));
}
