// =====================================================================
// 고급 입력(분개 직접 입력)
//   여러 줄 분개, 실시간 차변·대변 합계와 차액 표시, 차대가 맞을 때만 저장
// 계산·검증은 core/journal.js가 하고, 이 파일은 화면만 다룹니다.
// =====================================================================

import { h, replace, withBusy } from '../dom.js';
import { amountInput } from '../amount-input.js';
import { state } from '../state.js';
import { validateJournal, toRpcLines, todayLocal, isValidDate, nowTimeLocal, isValidTime, formatTime } from '../../core/journal.js';
import { postableAccounts, indexAccounts, describeLines, accountLabel, TYPE_LABELS, ACCOUNT_TYPES } from '../../core/balance.js';
import { formatAmount } from '../../core/money.js';

const emptyLine = () => ({ accountId: '', debit: '', credit: '' });

/**
 * @param {{ save: (payload) => Promise<boolean>,
 *           initial?: { id: string, kind: string, date: string, memo: string, lines: Array<{account_id, debit, credit, memo}> },
 *           submitLabel?: string }} ctx
 *   save: 저장 성공(또는 대기열 보관)이면 true
 *   initial: 수정할 때 기존 전표 (저장 후 입력란을 비우지 않음)
 * @returns {HTMLElement}
 */
export function advancedForm({ save, initial = null, submitLabel = '저장', hideDate = false }) {
  const options = postableAccounts(state.accounts);
  const postable = new Set(postableAccounts(state.accounts, { includeHidden: true }).map((a) => a.id));
  const byId = indexAccounts(state.accounts);

  let lines = initial
    ? [...initial.lines].sort((a, b) => a.line_no - b.line_no).map((l) => ({
        accountId: l.account_id, debit: l.debit ? String(l.debit) : '', credit: l.credit ? String(l.credit) : '', memo: l.memo ?? '' }))
    : [emptyLine(), emptyLine()];
  // 저장할 전표 id: 저장에 실패해 다시 누르면 같은 id로 보내 중복 저장을 막음
  let pendingId = initial?.id ?? crypto.randomUUID();

  // ---------- 날짜·메모 ----------
  const dateInput = h('input', { type: 'date', value: initial?.date ?? todayLocal(), required: true, 'aria-label': '날짜' });
  // 시각: 새 입력은 지금 시각, 수정·반복 등록은 저장된 시각(없으면 빈칸). 비워 두면 "시각 없음"
  const timeInput = h('input', { type: 'time', step: '60', 'aria-label': '시각',
    value: initial ? formatTime(initial.time) : nowTimeLocal() });
  timeInput.addEventListener('input', () => update());
  const memoInput = h('input', { type: 'text', maxlength: '200', placeholder: '예: 1월 급여', 'aria-label': '메모',
    enterkeyhint: 'done', value: initial?.memo ?? '' });
  dateInput.addEventListener('input', update);

  // ---------- 분개 라인 ----------
  const linesBox = h('div', { class: 'stack' });
  const addBtn = h('button', { class: 'btn block', type: 'button', onClick: () => { lines.push(emptyLine()); drawLines(true); } }, '+ 줄 추가');

  // ---------- 합계·저장 ----------
  const debitTotal = h('strong', { class: 'debit' }, '0');
  const creditTotal = h('strong', { class: 'credit' }, '0');
  const diffBox = h('div', { class: 'diff' }, h('span', {}, '차액'), h('strong', {}, '0'));
  const hint = h('p', { class: 'small muted', 'aria-live': 'polite' });
  const saveBtn = h('button', { class: 'btn primary block', type: 'submit' }, submitLabel);
  const summary = h('div', { class: 'je-summary' },
    h('div', { class: 'je-totals' },
      h('div', {}, h('span', {}, '차변 합계'), debitTotal),
      h('div', {}, h('span', {}, '대변 합계'), creditTotal),
      diffBox),
    hint, saveBtn);

  const form = h('form', { class: 'stack', novalidate: true },
    h('div', { class: 'card stack' },
      hideDate ? null : h('div', { class: 'row-2' },
        h('label', { class: 'field' }, h('span', {}, '날짜'), dateInput),
        h('label', { class: 'field' }, h('span', {}, '시각'), timeInput)),
      h('label', { class: 'field' }, h('span', {}, '메모'), memoInput)),
    h('div', { class: 'row between' },
      h('h2', {}, '분개'),
      h('span', { class: 'small muted' }, '차변 = 대변일 때 저장됩니다')),
    linesBox, addBtn, summary);
  form.addEventListener('submit', (e) => { e.preventDefault(); onSave(); });

  if (!options.length) {
    replace(linesBox, h('p', { class: 'notice bad' }, '기록할 수 있는 계정이 없습니다. 설정 → 계정과목을 확인하세요.'));
  }
  drawLines(false);
  return form;

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
    diffBox.querySelector('strong').textContent = formatAmount(Math.abs(result.diff));
    diffBox.className = 'diff ' + (result.diff === 0 ? (result.debitTotal > 0 ? 'ok' : '') : 'bad');

    // 줄별 오류 표시
    const badLines = new Set(result.errors.filter((e) => e.line !== null).map((e) => e.line));
    linesBox.querySelectorAll('.je-line').forEach((el) => el.classList.toggle('invalid', badLines.has(Number(el.dataset.idx))));

    const dateOk = isValidDate(dateInput.value) && isValidTime(timeInput.value);
    const ok = result.ok && dateOk;
    saveBtn.disabled = !ok;
    if (!dateOk) hint.textContent = '날짜와 시각을 확인하세요.';
    else if (result.count === 0) hint.textContent = '계정과 금액을 넣으면 차변·대변 합계가 바로 계산됩니다.';
    else if (result.ok) hint.textContent = '이렇게 기록됩니다: ' + describeLines(toRpcLines(lines), byId);
    else hint.textContent = result.errors[0]?.message ?? '';
    hint.className = 'small ' + (ok || result.count === 0 ? 'muted' : 'text-bad');
    return ok;
  }

  async function onSave() {
    if (!update()) return;
    const payload = {
      id: pendingId,
      ledgerId: state.ledgerId,
      date: dateInput.value,
      time: timeInput.value || null,
      memo: memoInput.value.trim(),
      // 고급 입력으로 고치면 간편 입력 모양이 아닐 수 있어 '직접 분개'로 (개시 잔액은 유지)
      kind: initial?.kind === 'opening' ? 'opening' : 'manual',
      source: 'advanced',
      lines: toRpcLines(lines),
    };
    const done = await withBusy(saveBtn, '저장 중…', () => save(payload));
    if (done && initial) return;   // 수정: 화면 이동은 호출한 쪽이 처리
    if (done) {
      // 다음 입력 준비 (날짜는 유지 — 같은 날 여러 건 입력이 많음)
      pendingId = crypto.randomUUID();
      lines = [emptyLine(), emptyLine()];
      memoInput.value = '';
      timeInput.value = nowTimeLocal();   // 다음 입력은 다시 지금 시각
      drawLines(false);
    }
    update();
  }
}
