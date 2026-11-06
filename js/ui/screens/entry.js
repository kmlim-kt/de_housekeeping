// =====================================================================
// 입력 화면 — 1단계: 고급 입력(분개 직접 입력)
//   여러 줄 분개, 실시간 차변·대변 합계와 차액 표시, 차대가 맞을 때만 저장
//   간편 입력은 2단계에서 이 화면에 추가됩니다.
// 계산·검증은 core/journal.js가 하고, 이 파일은 화면만 다룹니다.
// =====================================================================

import { h, append, replace, toast, withBusy, loading, errorBox } from '../dom.js';
import { amountInput } from '../amount-input.js';
import { state } from '../state.js';
import { validateJournal, toRpcLines, todayLocal, isValidDate, KIND_LABELS } from '../../core/journal.js';
import { postableAccounts, indexAccounts, describeLines, accountLabel, TYPE_LABELS, ACCOUNT_TYPES } from '../../core/balance.js';
import { formatAmount } from '../../core/money.js';
import { createTransaction, listRecentTransactions } from '../../data/api.js';

const emptyLine = () => ({ accountId: '', debit: '', credit: '' });

export function render(view) {
  const options = postableAccounts(state.accounts);
  const postable = new Set(postableAccounts(state.accounts, { includeHidden: true }).map((a) => a.id));
  const byId = indexAccounts(state.accounts);

  // 입력 상태
  let lines = [emptyLine(), emptyLine()];
  // 저장할 전표 id: 저장에 실패해 다시 누르면 같은 id로 보내 중복 저장을 막음
  let pendingId = crypto.randomUUID();

  // ---------- 상단: 입력 방식 ----------
  const modeSwitch = h('div', { class: 'segmented', role: 'group', 'aria-label': '입력 방식' },
    h('button', { type: 'button', disabled: true, 'aria-pressed': 'false', title: '2단계에서 제공' }, '간편 입력 (준비 중)'),
    h('button', { type: 'button', 'aria-pressed': 'true' }, '고급 입력'));

  // ---------- 날짜·메모 ----------
  const dateInput = h('input', { type: 'date', value: todayLocal(), required: true, 'aria-label': '날짜' });
  const memoInput = h('input', { type: 'text', maxlength: '200', placeholder: '예: 1월 급여', 'aria-label': '메모', enterkeyhint: 'done' });
  dateInput.addEventListener('input', update);

  // ---------- 분개 라인 ----------
  const linesBox = h('div', { class: 'stack' });
  const addBtn = h('button', { class: 'btn block', type: 'button', onClick: () => { lines.push(emptyLine()); drawLines(true); } }, '+ 줄 추가');

  // ---------- 합계·저장 ----------
  const debitTotal = h('strong', { class: 'debit' }, '0');
  const creditTotal = h('strong', { class: 'credit' }, '0');
  const diffBox = h('div', { class: 'diff' }, h('span', {}, '차액'), h('strong', {}, '0'));
  const hint = h('p', { class: 'small muted', 'aria-live': 'polite' });
  const saveBtn = h('button', { class: 'btn primary block', type: 'submit' }, '저장');
  const summary = h('div', { class: 'je-summary' },
    h('div', { class: 'je-totals' },
      h('div', {}, h('span', {}, '차변 합계'), debitTotal),
      h('div', {}, h('span', {}, '대변 합계'), creditTotal),
      diffBox),
    hint, saveBtn);

  const form = h('form', { class: 'stack', novalidate: true },
    h('div', { class: 'card stack' },
      h('label', { class: 'field' }, h('span', {}, '날짜'), dateInput),
      h('label', { class: 'field' }, h('span', {}, '메모'), memoInput)),
    h('div', { class: 'row between' },
      h('h2', {}, '분개'),
      h('span', { class: 'small muted' }, '차변 = 대변일 때 저장됩니다')),
    linesBox, addBtn, summary);
  form.addEventListener('submit', (e) => { e.preventDefault(); save(); });

  // ---------- 최근 전표 ----------
  const recentBox = h('div', { class: 'card' }, loading());

  append(view,
    h('h1', { class: 'view-title' }, '입력'),
    h('div', { class: 'stack-lg' }, modeSwitch, form,
      h('section', { class: 'stack' }, h('h2', {}, '최근 전표'), recentBox)));

  if (!options.length) {
    replace(linesBox, h('p', { class: 'notice bad' }, '기록할 수 있는 계정이 없습니다. 설정 → 계정과목을 확인하세요.'));
  }

  drawLines(false);
  loadRecent();

  // =================================================================

  /** 계정 선택 상자 (분류별 묶음) */
  function accountSelect(line, idx) {
    const groups = ACCOUNT_TYPES.map((type) => {
      const items = options.filter((o) => o.type === type);
      if (!items.length) return null;
      return h('optgroup', { label: TYPE_LABELS[type] }, items.map((o) => h('option', { value: o.id }, o.label)));
    });
    // 숨긴 계정이 이미 선택된 경우(나중에 수정 화면에서)에도 보이도록
    const extra = line.accountId && !options.some((o) => o.id === line.accountId)
      ? h('option', { value: line.accountId }, accountLabel(byId.get(line.accountId), byId) + ' (숨김)')
      : null;
    return h('select', {
      'aria-label': `${idx + 1}번째 줄 계정`,
      onChange: (e) => { line.accountId = e.target.value; update(); },
      value: line.accountId,
    }, h('option', { value: '' }, '계정 선택'), extra, groups);
  }

  function drawLines(focusLast) {
    if (!options.length) return;
    const rows = lines.map((line, idx) => {
      const debit = amountInput({
        value: Number(String(line.debit).replace(/\D/g, '')) || 0,
        label: `${idx + 1}번째 줄 차변 금액`,
        onChange: (_, text) => {
          line.debit = text;
          // 한 줄에는 한쪽만: 차변을 입력하면 대변을 비움
          if (text && line.credit) { line.credit = ''; credit.value = ''; }
          update();
        },
      });
      const credit = amountInput({
        value: Number(String(line.credit).replace(/\D/g, '')) || 0,
        label: `${idx + 1}번째 줄 대변 금액`,
        onChange: (_, text) => {
          line.credit = text;
          if (text && line.debit) { line.debit = ''; debit.value = ''; }
          update();
        },
      });
      const remove = h('button', {
        class: 'icon-btn', type: 'button', 'aria-label': `${idx + 1}번째 줄 삭제`,
        disabled: lines.length <= 2,
        onClick: () => { lines.splice(idx, 1); drawLines(false); },
      }, '✕');
      return h('div', { class: 'je-line', dataset: { idx: String(idx) } },
        h('div', { class: 'line-no' }, `${idx + 1}번째 줄`),
        accountSelect(line, idx),
        h('div', { class: 'amounts' },
          h('label', { class: 'field debit' }, h('span', {}, '차변'), debit),
          h('label', { class: 'field credit' }, h('span', {}, '대변'), credit),
          remove));
    });
    replace(linesBox, rows);
    if (focusLast) linesBox.lastElementChild?.querySelector('select')?.focus();
    update();
  }

  /** 합계·차액·오류 표시 갱신 (core 검증 사용) */
  function update() {
    const result = validateJournal(lines, { isPostable: (id) => postable.has(id) });
    debitTotal.textContent = formatAmount(result.debitTotal);
    creditTotal.textContent = formatAmount(result.creditTotal);
    const diffText = diffBox.querySelector('strong');
    diffText.textContent = formatAmount(Math.abs(result.diff));
    diffBox.className = 'diff ' + (result.diff === 0 ? (result.debitTotal > 0 ? 'ok' : '') : 'bad');

    // 줄별 오류 표시
    const badLines = new Set(result.errors.filter((e) => e.line !== null).map((e) => e.line));
    linesBox.querySelectorAll('.je-line').forEach((el) => el.classList.toggle('invalid', badLines.has(Number(el.dataset.idx))));

    const dateOk = isValidDate(dateInput.value);
    const ok = result.ok && dateOk;
    saveBtn.disabled = !ok;
    if (!dateOk) hint.textContent = '날짜를 확인하세요.';
    else if (result.count === 0) hint.textContent = '계정과 금액을 넣으면 차변·대변 합계가 바로 계산됩니다.';
    else if (result.ok) hint.textContent = '이렇게 기록됩니다: ' + describeLines(toRpcLines(lines), byId);
    else hint.textContent = result.errors[0]?.message ?? '';
    hint.className = 'small ' + (ok || result.count === 0 ? 'muted' : 'text-bad');
    return ok;
  }

  async function save() {
    if (!update()) return;
    const payload = {
      id: pendingId,
      ledgerId: state.ledgerId,
      date: dateInput.value,
      memo: memoInput.value.trim(),
      kind: 'manual',
      source: 'advanced',
      lines: toRpcLines(lines),
    };
    await withBusy(saveBtn, '저장 중…', async () => {
      try {
        await createTransaction(payload);
        toast('저장했습니다. ' + describeLines(payload.lines, byId));
        // 다음 입력 준비 (날짜는 유지 — 같은 날 여러 건 입력이 많음)
        pendingId = crypto.randomUUID();
        lines = [emptyLine(), emptyLine()];
        memoInput.value = '';
        drawLines(false);
        loadRecent();
      } catch (err) {
        // 입력 내용은 그대로 두고 오류를 알림 (같은 id로 다시 시도 가능)
        toast(err.message, { type: 'error', duration: 6000 });
      }
    });
    update();
  }

  async function loadRecent() {
    replace(recentBox, loading());
    try {
      const rows = await listRecentTransactions(state.ledgerId, 10);
      if (!rows.length) {
        replace(recentBox, h('p', { class: 'muted' }, '아직 저장한 전표가 없습니다.'));
        return;
      }
      replace(recentBox, h('ul', { class: 'list' }, rows.map((t) => transactionItem(t, byId))));
    } catch (err) {
      replace(recentBox, errorBox(err.message, loadRecent));
    }
  }
}

/** 전표 한 건 표시 */
export function transactionItem(t, byId) {
  const sorted = [...t.lines].sort((a, b) => (b.debit - a.debit) || (a.line_no - b.line_no));
  return h('li', { class: 'txn' },
    h('div', { class: 'row between' },
      h('strong', {}, t.memo || KIND_LABELS[t.kind] || '전표'),
      h('span', { class: 'small muted num' }, t.txn_date)),
    h('div', { class: 'lines' }, sorted.map((l) =>
      h('div', {},
        h('span', { class: l.debit > 0 ? 'debit' : 'credit' },
          (l.debit > 0 ? '차변 ' : '대변 ') + accountLabel(byId.get(l.account_id), byId)),
        h('span', { class: 'num' }, formatAmount(l.debit || l.credit))))),
    h('span', { class: 'small muted' }, KIND_LABELS[t.kind] ?? t.kind));
}
