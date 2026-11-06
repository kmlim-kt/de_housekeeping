// =====================================================================
// 앱 시작점: 로그인 상태에 따라 로그인 화면 또는 앱 뼈대를 보여 줍니다.
// 오프라인이면 기기에 저장해 둔 장부·계정 목록으로 열고, 입력은 대기열에 보관합니다.
// =====================================================================

import { h, replace, loading, errorBox, toast } from './ui/dom.js';
import { state, setState, prefs } from './ui/state.js';
import { applyTheme } from './ui/theme.js';
import { renderAuth } from './ui/auth.js';
import { renderShell, renderView, navigate } from './ui/shell.js';
import { getSession, onAuthChange, listLedgers, listAccounts, ledgerCheck, schemaVersion } from './data/api.js';
import { onQueueChange, flush, queueInfo, isNetworkError } from './data/sync.js';
import { supabase } from './data/supabase.js';

const root = document.getElementById('app');
let inRecovery = false;   // 비밀번호 재설정 메일 링크로 들어온 상태

applyTheme();
registerServiceWorker();

// 연결 상태 표시 + 연결되면 대기 중인 전표 전송
window.addEventListener('online', () => { setState({ online: true }); syncNow(); });
window.addEventListener('offline', () => setState({ online: false }));
onQueueChange((info) => setState({ queue: info }));
setInterval(() => { if (state.user && state.queue.pending) syncNow(); }, 60_000);

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

  let session = null;
  try {
    session = await getSession();
  } catch (err) {
    if (!isNetworkError(err)) {
      replace(root, h('main', { class: 'auth' }, errorBox(err.message, boot)));
      return;
    }
  }
  if (inRecovery) return;
  if (session) await enterApp(session);
  else renderAuth(root, {
    message: urlError ? '링크가 만료되었거나 올바르지 않습니다. 다시 시도하세요.'
      : !navigator.onLine ? '인터넷에 연결되어 있지 않습니다. 처음 로그인할 때는 연결이 필요합니다.' : null,
  });
}

/**
 * 로그인 후: 장부 → 계정과목 불러오기 → 앱 뼈대
 * 서버에 연결할 수 없으면 마지막으로 불러온 목록(기기에 저장)으로 엽니다.
 * @param {boolean} force 같은 사용자여도 다시 불러옴
 */
async function enterApp(session, force = false) {
  if (!force && state.user?.id === session.user.id && state.ledgerId) return;   // 이미 들어와 있음
  setState({ user: session.user });
  replace(root, loading('장부를 불러오는 중…'));

  let ledgers;
  let accounts;
  let ledgerId;
  let offlineMode = false;
  try {
    ledgers = await listLedgers(session.user.id);
    if (!ledgers.length) {
      replace(root, h('main', { class: 'auth' },
        errorBox('이 계정에 연결된 장부가 없습니다. 가입 직후라면 잠시 뒤 다시 시도하세요.', () => enterApp(session, true))));
      return;
    }
    ledgerId = pickLedger(ledgers);
    accounts = await listAccounts(ledgerId);
    prefs.set('cache.ledgers.' + session.user.id, ledgers);
    prefs.set('cache.accounts.' + ledgerId, accounts);
  } catch (err) {
    // 오프라인: 기기에 저장해 둔 목록 사용
    ledgers = prefs.get('cache.ledgers.' + session.user.id);
    ledgerId = ledgers && pickLedger(ledgers);
    accounts = ledgerId && prefs.get('cache.accounts.' + ledgerId);
    if (!isNetworkError(err) || !accounts) {
      replace(root, h('main', { class: 'auth' }, errorBox(err.message, () => enterApp(session, true))));
      return;
    }
    offlineMode = true;
  }

  setState({ ledgers, ledgerId, accounts, offlineMode });
  prefs.set('ledgerId', ledgerId);
  renderShell(root, { switchLedger, reloadAccounts });
  setState({ queue: await queueInfo() });

  if (offlineMode) {
    toast('오프라인 상태입니다. 입력한 전표는 이 기기에 보관했다가 연결되면 저장합니다.', { duration: 5000 });
  } else {
    syncNow();
    maybeStartOpeningWizard();
    checkSchema();
  }
}

/** 이 앱이 필요로 하는 DB 버전 (sql/migrations 를 실행하면 올라감) */
const REQUIRED_SCHEMA = 2;

async function checkSchema() {
  try {
    const v = await schemaVersion();
    if (v < REQUIRED_SCHEMA) {
      toast(`DB 업데이트가 필요합니다 (현재 ${v} → 필요 ${REQUIRED_SCHEMA}). Supabase SQL Editor에서 sql/migrations 폴더의 업데이트 SQL을 실행하세요.`,
        { type: 'error', duration: 15000 });
    }
  } catch {
    /* 확인 실패는 무시 (각 화면에서 오류를 따로 알림) */
  }
}

function pickLedger(ledgers) {
  const saved = prefs.get('ledgerId');
  return ledgers.some((l) => l.id === saved) ? saved : ledgers[0].id;
}

/** 대기 중인 전표 전송 */
async function syncNow() {
  if (!state.user) return;
  const r = await flush();
  if (r.sent) {
    toast(`임시 저장해 둔 전표 ${r.sent}건을 서버에 저장했습니다.`);
    if (state.offlineMode) { setState({ offlineMode: false }); reloadAccounts().catch(() => {}); }
  }
  if (r.failed) toast(`저장하지 못한 전표가 ${r.failed}건 있습니다. 입력 화면에서 확인하세요.`, { type: 'error', duration: 6000 });
}

/** 처음 쓰는 장부(거래 0건)면 개시 잔액 마법사를 한 번 띄움 */
async function maybeStartOpeningWizard() {
  const key = 'openingPrompted.' + state.ledgerId;
  if (prefs.get(key)) return;
  try {
    const r = await ledgerCheck(state.ledgerId);
    prefs.set(key, true);
    if (r.total_debit === 0 && state.queue.items.length === 0) navigate('opening');
  } catch {
    /* 나중에 다시 */
  }
}

/** 장부 바꾸기 */
async function switchLedger(ledgerId) {
  try {
    const accounts = await listAccounts(ledgerId);
    prefs.set('cache.accounts.' + ledgerId, accounts);
    setState({ ledgerId, accounts });
    prefs.set('ledgerId', ledgerId);
    renderView();
    maybeStartOpeningWizard();
  } catch (err) {
    toast(err.message, { type: 'error' });
  }
}

/** 계정과목 다시 불러오기 (계정을 추가·수정한 뒤) */
async function reloadAccounts() {
  const accounts = await listAccounts(state.ledgerId);
  prefs.set('cache.accounts.' + state.ledgerId, accounts);
  setState({ accounts });
}

/** PWA: 서비스 워커 등록 (앱 화면을 오프라인에서도 열 수 있게) */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      /* 등록 실패해도 앱은 온라인으로 동작 */
    });
  });
}
