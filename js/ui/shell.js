// =====================================================================
// 앱 뼈대: 상단 바(장부 이름·연결 상태) + 화면 영역 + 하단 탭 바 + 떠 있는 [+ 입력] 버튼
// 주소 #/화면이름 으로 화면을 바꿉니다.
// =====================================================================

import { h, replace, icon } from './dom.js';
import { state, subscribe, currentLedger } from './state.js';
import * as dashboard from './screens/dashboard.js';
import * as entry from './screens/entry.js';
import * as settings from './screens/settings.js';
import * as accounts from './screens/accounts.js';
import { placeholder } from './screens/placeholder.js';

// 탭 아이콘 (24x24 선 아이콘 경로)
const ICONS = {
  dashboard: ['M3 12l9-8 9 8', 'M5 10v10h14V10'],
  entry: ['M12 5v14', 'M5 12h14'],
  list: ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3 6h.01', 'M3 12h.01', 'M3 18h.01'],
  reports: ['M4 20V10', 'M10 20V4', 'M16 20v-7', 'M22 20H2'],
  settings: ['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z'],
};

const TABS = [
  ['dashboard', '대시보드'],
  ['entry', '입력'],
  ['list', '거래목록'],
  ['reports', '보고서'],
  ['settings', '설정'],
];

/** 주소 → 화면 */
const ROUTES = {
  dashboard: dashboard.render,
  entry: entry.render,
  list: placeholder('거래 목록', '분개장·검색·필터·휴지통은 3단계에서 만듭니다. 지금은 [입력] 화면 아래에서 최근 전표를 볼 수 있습니다.'),
  reports: placeholder('보고서', '계정별 원장·시산표는 3단계, 재무상태표·손익계산서는 4단계에서 만듭니다.'),
  settings: settings.render,
  'settings/accounts': accounts.render,
};

export const DEFAULT_ROUTE = 'dashboard';

export function currentRoute() {
  const r = location.hash.replace(/^#\/?/, '');
  return ROUTES[r] ? r : DEFAULT_ROUTE;
}

export function navigate(route) {
  if (location.hash !== '#/' + route) location.hash = '#/' + route;
  else renderView();
}

let view;
let cleanup = null;
let ctx = {};
let unsubscribeTopbar = null;

/**
 * 뼈대 그리기
 * @param {HTMLElement} root
 * @param {{ switchLedger: (id: string) => Promise<void>, reloadAccounts: () => Promise<void> }} context
 */
export function renderShell(root, context) {
  ctx = { ...context, navigate };

  const ledgerArea = h('div', { class: 'row' });
  const netStatus = h('span', { class: 'net-status badge' });
  const topbar = h('header', { class: 'topbar' }, ledgerArea, netStatus);

  view = h('main', { class: 'view', id: 'view', tabindex: '-1' });

  const tabLinks = TABS.map(([route, label]) =>
    h('a', { href: '#/' + route, dataset: { route } }, icon(ICONS[route]), h('span', {}, label)));
  const tabbar = h('nav', { class: 'tabbar', 'aria-label': '주요 화면' }, tabLinks);

  const fab = h('button', { class: 'fab', type: 'button', onClick: () => navigate('entry') }, '+ 입력');

  replace(root, topbar, view, fab, tabbar);

  function drawTopbar() {
    const ledger = currentLedger();
    if (state.ledgers.length > 1) {
      const sel = h('select', {
        'aria-label': '장부 선택',
        onChange: (e) => ctx.switchLedger(e.target.value),
        value: state.ledgerId,
      }, state.ledgers.map((l) => h('option', { value: l.id }, l.name)));
      replace(ledgerArea, sel);
    } else {
      replace(ledgerArea, h('span', { class: 'ledger-name' }, ledger?.name ?? '가계부'));
    }
    netStatus.textContent = state.online ? '온라인' : '오프라인';
    netStatus.className = 'net-status badge ' + (state.online ? 'ok' : 'bad');
  }

  function markTab() {
    const top = currentRoute().split('/')[0];
    for (const a of tabLinks) {
      if (a.dataset.route === top) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
    fab.classList.toggle('hidden', top === 'entry');
  }

  drawTopbar();
  unsubscribeTopbar?.();   // 다시 로그인해 뼈대를 새로 그릴 때 이전 구독 해제
  unsubscribeTopbar = subscribe(drawTopbar);
  window.onhashchange = () => { markTab(); renderView(); };
  markTab();
  renderView();
}

/** 현재 주소의 화면 그리기 (장부를 바꿨을 때도 호출) */
export function renderView() {
  if (!view) return;
  cleanup?.();
  cleanup = null;
  view.replaceChildren();
  const result = ROUTES[currentRoute()](view, ctx);
  if (typeof result === 'function') cleanup = result;
  window.scrollTo(0, 0);
}
