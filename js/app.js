// =====================================================================
// 앱 시작점: 로그인 상태에 따라 로그인 화면 또는 앱 뼈대를 보여 줍니다.
// =====================================================================

import { h, replace, loading, errorBox } from './ui/dom.js';
import { state, setState, prefs } from './ui/state.js';
import { applyTheme } from './ui/theme.js';
import { renderAuth } from './ui/auth.js';
import { renderShell, renderView } from './ui/shell.js';
import { getSession, onAuthChange, listLedgers, listAccounts } from './data/api.js';
import { supabase } from './data/supabase.js';

const root = document.getElementById('app');
let inRecovery = false;   // 비밀번호 재설정 메일 링크로 들어온 상태

applyTheme();

// 연결 상태 표시
window.addEventListener('online', () => setState({ online: true }));
window.addEventListener('offline', () => setState({ online: false }));

// 개발자 도구에서 보안(RLS) 점검할 때 쓰는 연결 객체 (공개 키만 들어 있어 노출되어도 안전)
window.ledgerDebug = { supabase, state };

boot();

async function boot() {
  replace(root, loading('가계부를 여는 중…'));

  // 메일 링크가 만료된 경우 등: 주소에 담겨 온 오류 메시지
  const urlError = new URLSearchParams(location.hash.replace(/^#/, '')).get('error_description');

  onAuthChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') {
      inRecovery = true;
      renderAuth(root, { mode: 'recovery', onRecovered: () => { inRecovery = false; enterApp(session, true); } });
    } else if (event === 'SIGNED_OUT') {
      setState({ user: null, ledgers: [], ledgerId: null, accounts: [] });
      renderAuth(root, { message: '로그아웃했습니다.' });
    } else if (event === 'SIGNED_IN' && session && !inRecovery) {
      enterApp(session);
    }
  });

  try {
    const session = await getSession();
    if (inRecovery) return;
    if (session) await enterApp(session);
    else renderAuth(root, { message: urlError ? '링크가 만료되었거나 올바르지 않습니다. 다시 시도하세요.' : null });
  } catch (err) {
    replace(root, h('main', { class: 'auth' }, errorBox(err.message, boot)));
  }
}

/**
 * 로그인 후: 장부 → 계정과목 불러오기 → 앱 뼈대
 * @param {boolean} force 같은 사용자여도 다시 불러옴
 */
async function enterApp(session, force = false) {
  if (!force && state.user?.id === session.user.id && state.ledgerId) return;   // 이미 들어와 있음
  setState({ user: session.user });
  replace(root, loading('장부를 불러오는 중…'));
  try {
    const ledgers = await listLedgers(session.user.id);
    if (!ledgers.length) {
      replace(root, h('main', { class: 'auth' },
        errorBox('이 계정에 연결된 장부가 없습니다. 가입 직후라면 잠시 뒤 다시 시도하세요.', () => enterApp(session, true))));
      return;
    }
    const saved = prefs.get('ledgerId');
    const ledgerId = ledgers.some((l) => l.id === saved) ? saved : ledgers[0].id;
    const accounts = await listAccounts(ledgerId);
    setState({ ledgers, ledgerId, accounts });
    prefs.set('ledgerId', ledgerId);
    renderShell(root, { switchLedger, reloadAccounts });
  } catch (err) {
    replace(root, h('main', { class: 'auth' }, errorBox(err.message, () => enterApp(session, true))));
  }
}

/** 장부 바꾸기 */
async function switchLedger(ledgerId) {
  try {
    const accounts = await listAccounts(ledgerId);
    setState({ ledgerId, accounts });
    prefs.set('ledgerId', ledgerId);
    renderView();
  } catch (err) {
    alert(err.message);
  }
}

/** 계정과목 다시 불러오기 (계정을 추가·수정한 뒤) */
async function reloadAccounts() {
  setState({ accounts: await listAccounts(state.ledgerId) });
}
