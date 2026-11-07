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
        h('a', { class: 'btn block', href: '#/settings/ledger' }, '장부·가족 (초대·구성원·새 장부)')),
      h('a', { class: 'card row between', href: '#/settings/data', style: 'text-decoration:none;color:inherit;min-height:56px' },
        h('span', {}, '데이터 관리 (백업·복원·CSV·내역 가져오기)'), h('span', { class: 'muted' }, '›')),

      h('a', { class: 'card row between', href: '#/settings/accounts', style: 'text-decoration:none;color:inherit;min-height:56px' },
        h('span', {}, '계정과목 (추가·수정·숨김)'), h('span', { class: 'muted' }, `${state.accounts.length}개 ›`)),
      h('a', { class: 'card row between', href: '#/settings/recurring', style: 'text-decoration:none;color:inherit;min-height:56px' },
        h('span', {}, '반복 거래 (월세·통신비·급여)'), h('span', { class: 'muted' }, '›')),
      h('a', { class: 'card row between', href: '#/settings/favorites', style: 'text-decoration:none;color:inherit;min-height:56px' },
        h('span', {}, '즐겨찾기'), h('span', { class: 'muted' }, `${state.favorites.length}개 ›`)),
      h('a', { class: 'card row between', href: '#/reports/budget', style: 'text-decoration:none;color:inherit;min-height:56px' },
        h('span', {}, '예산'), h('span', { class: 'muted' }, '›')),
      h('a', { class: 'card row between', href: '#/opening', style: 'text-decoration:none;color:inherit;min-height:56px' },
        h('span', {}, '개시 잔액 설정'), h('span', { class: 'muted' }, '›')),

      h('section', { class: 'card stack' },
        h('h2', {}, '휴대폰 홈 화면에 추가'),
        h('p', { class: 'small muted' },
          '앱처럼 전체 화면으로 쓰려면 — 아이폰: Safari 공유 버튼 → "홈 화면에 추가" / 안드로이드: Chrome 메뉴(⋮) → "홈 화면에 추가" 또는 "앱 설치". 인터넷이 끊겨도 앱이 열리고, 그동안 입력한 전표는 기기에 보관했다가 연결되면 저장됩니다.')),

      h('section', { class: 'card stack' },
        h('h2', {}, '화면'),
        themeBox),

      h('section', { class: 'card stack' },
        h('h2', {}, '점검 도구'),
        h('a', { href: 'check.html' }, 'Supabase 연결 확인'),
        h('a', { href: 'tests.html' }, '회계 로직 자동 테스트'))));
}
