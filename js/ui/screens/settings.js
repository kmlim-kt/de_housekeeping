// =====================================================================
// 설정 화면 — 1단계: 내 계정·로그아웃, 장부 정보, 테마, 계정과목 보기
// =====================================================================

import { h, append, replace, toast, withBusy } from '../dom.js';
import { state, currentLedger } from '../state.js';
import { applyTheme, currentTheme, THEME_LABELS } from '../theme.js';
import { signOut } from '../../data/api.js';

export function render(view) {
  const ledger = currentLedger();

  // 테마 선택
  const themeBox = h('div', { class: 'segmented', role: 'group', 'aria-label': '화면 테마' });
  function drawTheme() {
    replace(themeBox, Object.entries(THEME_LABELS).map(([key, label]) =>
      h('button', {
        type: 'button', 'aria-pressed': String(currentTheme() === key),
        onClick: () => { applyTheme(key); drawTheme(); },
      }, label)));
  }
  drawTheme();

  const logoutBtn = h('button', { class: 'btn block danger', type: 'button' }, '로그아웃');
  logoutBtn.addEventListener('click', () => withBusy(logoutBtn, '로그아웃 중…', async () => {
    try {
      await signOut();
    } catch (err) {
      toast(err.message, { type: 'error' });
    }
  }));

  const copyBtn = h('button', { class: 'btn small', type: 'button' }, '복사');
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(state.ledgerId);
      toast('장부 ID를 복사했습니다.');
    } catch {
      toast('복사하지 못했습니다. 길게 눌러 직접 복사하세요.', { type: 'error' });
    }
  });

  append(view,
    h('h1', { class: 'view-title' }, '설정'),
    h('div', { class: 'stack' },
      h('section', { class: 'card stack' },
        h('h2', {}, '내 계정'),
        h('p', { class: 'num' }, state.user?.email ?? ''),
        logoutBtn),

      h('section', { class: 'card stack' },
        h('h2', {}, '장부'),
        h('div', { class: 'row between' }, h('span', {}, ledger?.name ?? ''),
          h('span', { class: 'badge' }, ledger?.role === 'owner' ? '소유자' : '구성원')),
        h('div', { class: 'stack', style: 'gap:4px' },
          h('span', { class: 'small muted' }, '장부 ID (보안 점검할 때 사용)'),
          h('div', { class: 'row between' }, h('code', { class: 'small', style: 'word-break:break-all' }, state.ledgerId), copyBtn)),
        h('p', { class: 'small muted' }, '가족 초대·구성원 관리는 다음 단계에서 추가합니다.')),

      h('a', { class: 'card row between', href: '#/settings/accounts', style: 'text-decoration:none;color:inherit;min-height:56px' },
        h('span', {}, '계정과목'), h('span', { class: 'muted' }, `${state.accounts.length}개 ›`)),

      h('section', { class: 'card stack' },
        h('h2', {}, '화면'),
        themeBox),

      h('section', { class: 'card stack' },
        h('h2', {}, '점검 도구'),
        h('a', { href: 'check.html' }, 'Supabase 연결 확인'),
        h('a', { href: 'tests.html' }, '회계 로직 자동 테스트'))));
}
