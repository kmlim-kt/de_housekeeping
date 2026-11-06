// 보고서 메뉴
import { h, append } from '../dom.js';

const ITEMS = [
  ['reports/ledger', '계정별 원장', '계정 하나의 거래 내역과 누적 잔액'],
  ['reports/trial', '시산표', '모든 계정의 차변·대변 합계와 잔액, 일치 여부'],
  [null, '재무상태표', '기준일의 자산·부채·순자산 — 4단계'],
  [null, '손익계산서', '월·연 단위 수익·비용, 전월 대비 — 4단계'],
  [null, '예산', '비용 계정별 월 예산과 초과 경고 — 5단계'],
];

export function render(view) {
  append(view,
    h('h1', { class: 'view-title' }, '보고서'),
    h('div', { class: 'report-links' }, ITEMS.map(([route, title, desc]) =>
      h(route ? 'a' : 'div', { class: 'card report-link' + (route ? '' : ' disabled'), href: route ? '#/' + route : null },
        h('div', {}, h('strong', {}, title), h('div', { class: 'small muted' }, desc)),
        h('span', { class: 'muted' }, route ? '›' : '준비 중')))));
}
