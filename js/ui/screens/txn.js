// =====================================================================
// 전표 상세 (#/txn/<id>) · 수정 (#/txn/<id>/edit)
//   상세: 분개 라인, 작성·수정 정보, 변경 이력, [수정] [삭제(휴지통)]
//   수정: 간편 입력으로 만든 전표는 간편 입력 화면으로, 그 밖에는 고급 입력으로
//         (다른 기기에서 먼저 고쳤으면 DB가 거부 → 새로 불러와 다시 수정)
// 수정·삭제는 인터넷 연결이 필요합니다(충돌 방지).
// =====================================================================

import { h, append, replace, loading, errorBox, toast, withBusy, kv } from '../dom.js';
import { state } from '../state.js';
import { authorLabel } from '../widgets.js';
import { simpleForm } from './entry-simple.js';
import { advancedForm } from './entry-advanced.js';
import { KIND_LABELS, formatTime } from '../../core/journal.js';
import { indexAccounts, accountLabel, describeLines } from '../../core/balance.js';
import { parseSimple, SIMPLE_FORMS } from '../../core/simple.js';
import { formatAmount } from '../../core/money.js';
import { getTransaction, transactionHistory, updateTransaction, setTransactionDeleted, purgeTransaction } from '../../data/api.js';

const ACTION_LABELS = { create: '작성', update: '수정', delete: '휴지통으로 이동', restore: '복원', purge: '영구 삭제' };

const when = (ts) => ts ? new Date(ts).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' }) : '';

function backLink() {
  return h('a', { href: '#/list', class: 'btn small ghost' }, '‹ 거래 목록');
}

// ---------------------------------------------------------------------
// 상세
// ---------------------------------------------------------------------
export function renderDetail(view, ctx, id) {
  const byId = indexAccounts(state.accounts);
  const body = h('div', { class: 'stack-lg' }, loading());
  append(view, h('div', { class: 'row' }, backLink(), h('h1', { class: 'view-title' }, '전표')), body);
  load();

  async function load() {
    replace(body, loading());
    try {
      const [t, history] = await Promise.all([getTransaction(id), transactionHistory(id)]);
      if (!t) {
        replace(body, h('p', { class: 'notice' }, '전표를 찾을 수 없습니다. 영구 삭제되었거나 다른 장부의 전표입니다.'),
          history.length ? historySection(history, byId) : null);
        return;
      }
      draw(t, history);
    } catch (err) {
      replace(body, errorBox(state.online ? err.message : '오프라인이라 전표를 불러올 수 없습니다.', load));
    }
  }

  function draw(t, history) {
    const total = t.lines.reduce((s, l) => s + l.debit, 0);
    const lines = [...t.lines].sort((a, b) => a.line_no - b.line_no);

    const editBtn = h('a', { class: 'btn primary', href: `#/txn/${t.id}/edit` }, '수정');
    const delBtn = h('button', { class: 'btn danger', type: 'button' }, '삭제');
    delBtn.addEventListener('click', () => withBusy(delBtn, '삭제 중…', async () => {
      try {
        await setTransactionDeleted(t.id, true);
        toast('휴지통으로 옮겼습니다. 잔액·보고서에서 빠집니다.', {
          action: { label: '되돌리기', onClick: () => restore(t.id) },
        });
        ctx.navigate('list');
      } catch (err) { toast(err.message, { type: 'error' }); }
    }));

    replace(body,
      t.is_deleted ? deletedBanner(t) : null,
      h('section', { class: 'card stack' },
        h('div', { class: 'row between' },
          h('h2', {}, t.memo || KIND_LABELS[t.kind] || '전표'),
          h('span', { class: 'amount-strong' }, formatAmount(total) + '원')),
        kv('날짜', t.txn_date),
        kv('시각', formatTime(t.txn_time) || '시각 없음'),
        kv('종류', KIND_LABELS[t.kind] ?? t.kind),
        h('h3', { style: 'margin-top:8px' }, '분개'),
        h('div', { class: 'stack', style: 'gap:6px' }, lines.map((l) =>
          h('div', { class: 'kv' },
            h('span', { class: l.debit > 0 ? 'debit' : 'credit' },
              (l.debit > 0 ? '차변 ' : '대변 ') + accountLabel(byId.get(l.account_id), byId)
              + (l.memo ? ` · ${l.memo}` : '')),
            h('span', { class: 'num' }, formatAmount(l.debit || l.credit))))),
        h('div', { class: 'small muted' },
          `작성 ${authorLabel(t.created_by)} · ${when(t.created_at)}`,
          t.updated_at && t.updated_at !== t.created_at ? ` / 마지막 변경 ${authorLabel(t.updated_by)} · ${when(t.updated_at)}` : '')),
      !t.is_deleted ? h('div', { class: 'actions' }, editBtn, delBtn) : null,
      historySection(history, byId));
  }

  function deletedBanner(t) {
    const restoreBtn = h('button', { class: 'btn small', type: 'button', onClick: () => restore(t.id) }, '복원');
    const purgeBtn = h('button', { class: 'btn small danger', type: 'button' }, '영구 삭제');
    purgeBtn.addEventListener('click', () => {
      if (!confirm('영구 삭제하면 되돌릴 수 없습니다. 삭제할까요?')) return;
      withBusy(purgeBtn, '삭제 중…', async () => {
        try {
          await purgeTransaction(t.id);
          toast('영구 삭제했습니다.');
          ctx.navigate('list');
        } catch (err) { toast(err.message, { type: 'error' }); }
      });
    });
    return h('section', { class: 'card stack deleted-banner' },
      h('p', { class: 'text-bad' }, `휴지통에 있는 전표입니다 (${when(t.deleted_at)}). 잔액·보고서에는 포함되지 않습니다.`),
      h('div', { class: 'row' }, restoreBtn, purgeBtn));
  }

  async function restore(txnId) {
    try {
      await setTransactionDeleted(txnId, false);
      toast('복원했습니다.');
      ctx.refresh();
    } catch (err) { toast(err.message, { type: 'error' }); }
  }
}

/** 변경 이력: 언제 누가 무엇을 (수정이면 바뀐 내용) */
function historySection(history, byId) {
  if (!history.length) return null;
  return h('section', { class: 'card stack' },
    h('h2', {}, '변경 이력'),
    h('ul', { class: 'list history' }, history.map((e) => {
      const changes = [];
      if (e.action === 'update' && e.before && e.after) {
        const b = e.before.transaction ?? {};
        const a = e.after.transaction ?? {};
        if (b.txn_date !== a.txn_date) changes.push(`날짜 ${b.txn_date} → ${a.txn_date}`);
        if ((b.txn_time ?? null) !== (a.txn_time ?? null)) {
          changes.push(`시각 ${formatTime(b.txn_time) || '없음'} → ${formatTime(a.txn_time) || '없음'}`);
        }
        if (b.memo !== a.memo) changes.push(`메모 "${b.memo || ''}" → "${a.memo || ''}"`);
        const before = describeLines(e.before.lines ?? [], byId);
        const after = describeLines(e.after.lines ?? [], byId);
        if (before !== after) changes.push(`분개: ${before}`, `→ ${after}`);
      }
      return h('li', { class: 'stack', style: 'gap:2px' },
        h('div', { class: 'row between' },
          h('strong', {}, ACTION_LABELS[e.action] ?? e.action),
          h('span', { class: 'small muted' }, `${authorLabel(e.changed_by)} · ${when(e.changed_at)}`)),
        changes.map((c) => h('div', { class: 'small muted' }, c)));
    })));
}

// ---------------------------------------------------------------------
// 수정
// ---------------------------------------------------------------------
export function renderEdit(view, ctx, id) {
  const byId = indexAccounts(state.accounts);
  const body = h('div', { class: 'stack-lg' }, loading());
  append(view,
    h('div', { class: 'row' },
      h('a', { href: `#/txn/${id}`, class: 'btn small ghost' }, '‹ 취소'),
      h('h1', { class: 'view-title' }, '전표 수정')),
    body);
  load();

  async function load() {
    replace(body, loading());
    try {
      const t = await getTransaction(id);
      if (!t) return replace(body, h('p', { class: 'notice' }, '전표를 찾을 수 없습니다.'));
      if (t.is_deleted) return replace(body, h('p', { class: 'notice' }, '휴지통에 있는 전표는 수정할 수 없습니다. 먼저 복원하세요.'));
      draw(t);
    } catch (err) {
      replace(body, errorBox(state.online ? err.message : '수정하려면 인터넷 연결이 필요합니다.', load));
    }
  }

  function draw(t) {
    const simpleValues = SIMPLE_FORMS[t.kind] ? parseSimple(t.kind, t.lines, byId) : null;
    let mode = simpleValues ? 'simple' : 'advanced';
    const switcher = h('div', { class: 'segmented', role: 'group', 'aria-label': '수정 방식' });
    const formBox = h('div');

    async function save(payload) {
      try {
        await updateTransaction({
          id: t.id, date: payload.date, time: payload.time ?? '', memo: payload.memo, kind: payload.kind,
          lines: payload.lines, expectedUpdatedAt: t.updated_at,
        });
        toast('수정했습니다. ' + describeLines(payload.lines, byId));
        ctx.navigate('txn/' + t.id);
        return true;
      } catch (err) {
        toast(err.message, { type: 'error', duration: 7000 });
        return false;
      }
    }

    function drawForm() {
      replace(switcher, simpleValues
        ? [['simple', '간편 입력'], ['advanced', '고급 입력 (분개)']].map(([m, label]) =>
            h('button', { type: 'button', 'aria-pressed': String(mode === m),
              onClick: () => { if (mode !== m) { mode = m; drawForm(); } } }, label))
        : []);
      const initial = { id: t.id, kind: t.kind, date: t.txn_date, time: t.txn_time, memo: t.memo, lines: t.lines, values: simpleValues };
      replace(formBox, mode === 'simple'
        ? simpleForm({ save, initial, submitLabel: '수정 저장' })
        : advancedForm({ save, initial, submitLabel: '수정 저장' }));
    }

    replace(body,
      simpleValues ? switcher : h('p', { class: 'small muted' },
        SIMPLE_FORMS[t.kind]
          ? '분개 모양이 간편 입력과 달라 고급 입력으로 수정합니다.'
          : '직접 분개한 전표는 고급 입력으로 수정합니다.'),
      formBox,
      h('p', { class: 'small muted' }, '수정 내용은 변경 이력에 남습니다. 수정은 인터넷 연결이 필요합니다.'));
    drawForm();
  }
}
