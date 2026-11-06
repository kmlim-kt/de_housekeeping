// =====================================================================
// 입력 화면: [간편 입력 | 고급 입력] + 저장 대기 목록 + 최근 전표
// 두 입력 방식 모두 같은 저장 흐름(data/sync.js: 대기열 → 서버)을 씁니다.
// =====================================================================

import { h, append, replace, toast, loading, errorBox, withBusy } from '../dom.js';
import { state, prefs, markUsed, subscribe } from '../state.js';
import { simpleForm } from './entry-simple.js';
import { advancedForm } from './entry-advanced.js';
import { KIND_LABELS } from '../../core/journal.js';
import { indexAccounts, describeLines } from '../../core/balance.js';
import { transactionCard } from '../widgets.js';
import { formatAmount } from '../../core/money.js';
import { listRecentTransactions } from '../../data/api.js';
import { submitTransaction, flush, retry, discard } from '../../data/sync.js';

export function render(view) {
  const byId = indexAccounts(state.accounts);
  let mode = prefs.get('entryMode', 'simple');

  const modeSwitch = h('div', { class: 'segmented', role: 'group', 'aria-label': '입력 방식' });
  const formBox = h('div');
  const queueBox = h('div');
  const recentBox = h('div', { class: 'card' }, loading());

  append(view,
    h('h1', { class: 'sr-only' }, '입력'),
    h('div', { class: 'stack-lg' }, modeSwitch, queueBox, formBox,
      h('section', { class: 'stack' }, h('h2', {}, '최근 전표'), recentBox)));

  drawMode();
  drawQueue();
  loadRecent();
  const unsubscribe = subscribe(drawQueue);
  return unsubscribe;   // 화면을 떠날 때 구독 해제

  // =================================================================

  function drawMode() {
    replace(modeSwitch,
      ...[['simple', '간편 입력'], ['advanced', '고급 입력 (분개)']].map(([m, label]) =>
        h('button', {
          type: 'button', 'aria-pressed': String(mode === m),
          onClick: () => { if (mode !== m) { mode = m; prefs.set('entryMode', m); drawMode(); } },
        }, label)));
    const form = mode === 'simple' ? simpleForm({ save }) : advancedForm({ save });
    replace(formBox, form);
    // 금액 칸에 바로 커서 (휴대폰은 숫자 키패드가 뜸)
    if (mode === 'simple') requestAnimationFrame(() => form.focusAmount());
  }

  /**
   * 저장 (대기열 경유). 성공 또는 오프라인 보관이면 true, 서버가 거부하면 false
   */
  async function save(payload) {
    try {
      const { status } = await submitTransaction(payload);
      markUsed(payload.lines.map((l) => l.account_id));
      if (status === 'saved') {
        toast('저장했습니다. ' + describeLines(payload.lines, byId));
        loadRecent();
      } else {
        toast('인터넷 연결이 없어 이 기기에 임시 저장했습니다. 연결되면 자동으로 저장됩니다.', { duration: 5000 });
      }
      return true;
    } catch (err) {
      toast(err.message, { type: 'error', duration: 6000 });
      return false;
    }
  }

  /** 저장 대기 중인 전표 (오프라인 입력·실패 건) */
  function drawQueue() {
    const { items, pending, failed } = state.queue;
    if (!items.length) {
      replace(queueBox);
      return;
    }
    const sendBtn = h('button', { class: 'btn small', type: 'button' }, '지금 보내기');
    sendBtn.addEventListener('click', () => withBusy(sendBtn, '보내는 중…', async () => {
      const r = await flush();
      if (r.sent) { toast(`${r.sent}건을 저장했습니다.`); loadRecent(); }
      else if (r.remaining) toast('아직 서버에 연결할 수 없습니다.', { type: 'error' });
    }));
    replace(queueBox, h('section', { class: 'card stack queue' },
      h('div', { class: 'row between' },
        h('h2', {}, `저장 대기 ${pending + failed}건`),
        pending ? sendBtn : null),
      pending ? h('p', { class: 'small muted' }, '이 기기에 임시 저장되어 있습니다. 인터넷에 연결되면 자동으로 저장됩니다.') : null,
      h('ul', { class: 'list' }, items.map((item) => queueItem(item)))));
  }

  function queueItem(item) {
    const p = item.payload;
    const total = p.lines.reduce((s, l) => s + l.debit, 0);
    return h('li', { class: 'stack', style: 'gap:6px' },
      h('div', { class: 'row between' },
        h('span', {}, `${p.memo || KIND_LABELS[p.kind] || '전표'} · ${formatAmount(total)}원`),
        h('span', { class: 'small muted num' }, p.date)),
      h('div', { class: 'small muted' }, describeLines(p.lines, byId)),
      item.status === 'failed'
        ? h('div', { class: 'stack', style: 'gap:6px' },
            h('p', { class: 'small text-bad' }, '저장 실패: ' + item.error),
            h('div', { class: 'row' },
              h('button', { class: 'btn small', type: 'button', onClick: () => retry(item.id) }, '다시 시도'),
              h('button', { class: 'btn small danger', type: 'button',
                onClick: () => { if (confirm('이 전표를 저장하지 않고 지울까요?')) discard(item.id); } }, '지우기')))
        : h('span', { class: 'badge' }, '대기 중'));
  }

  async function loadRecent() {
    replace(recentBox, loading());
    try {
      const rows = await listRecentTransactions(state.ledgerId, 10);
      if (!rows.length) {
        replace(recentBox, h('p', { class: 'muted' }, '아직 저장한 전표가 없습니다.'));
        return;
      }
      replace(recentBox, h('ul', { class: 'list' }, rows.map((t) => h('li', { class: 'txn-li' }, transactionCard(t, byId)))));
    } catch (err) {
      replace(recentBox, errorBox(err.message, loadRecent));
    }
  }
}
