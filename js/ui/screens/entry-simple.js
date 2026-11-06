// =====================================================================
// 간편 입력 — 회계 용어 없이 고르고 금액만 넣으면 자동 분개
//   지출 / 수입 / 이체 / 카드대금 / 대출 상환
//   휴대폰에서 지출 3터치: [+ 입력] → (금액 입력) → 항목 칩 → [저장]
//   결제수단 등은 최근에 쓴 계정을 미리 골라 둡니다.
// 분개 변환은 core/simple.js가 하고, 이 파일은 화면만 다룹니다.
// =====================================================================

import { h, replace, withBusy } from '../dom.js';
import { amountInput } from '../amount-input.js';
import { chipGroup } from '../chips.js';
import { state, recentUse, prefs } from '../state.js';
import { SIMPLE_FORMS, SIMPLE_KINDS, buildSimple, sortByRecent, defaultChoice } from '../../core/simple.js';
import { validateJournal, todayLocal, isValidDate } from '../../core/journal.js';
import { postableAccounts, indexAccounts, describeLines } from '../../core/balance.js';

/**
 * @param {{ save: (payload) => Promise<boolean> }} ctx
 * @returns {HTMLElement & { focusAmount: () => void }}
 */
export function simpleForm({ save }) {
  const all = postableAccounts(state.accounts);
  const byId = indexAccounts(state.accounts);
  let kind = prefs.get('simpleKind', 'expense');
  if (!SIMPLE_FORMS[kind]) kind = 'expense';

  const values = {};             // 입력값: 금액 칸 key → 문자열, 계정 칸 key → id
  let pendingId = crypto.randomUUID();
  let amountInputs = [];

  const kindTabs = h('div', { class: 'segmented kinds', role: 'group', 'aria-label': '입력 종류' });
  const body = h('div', { class: 'stack-lg' });
  const dateInput = h('input', { type: 'date', value: todayLocal(), 'aria-label': '날짜' });
  const memoInput = h('input', { type: 'text', maxlength: '200', placeholder: '메모 (선택)', 'aria-label': '메모', enterkeyhint: 'done' });
  const preview = h('p', { class: 'small muted', 'aria-live': 'polite' });
  const saveBtn = h('button', { class: 'btn primary block', type: 'submit' }, '저장');
  dateInput.addEventListener('input', update);

  const form = h('form', { class: 'stack-lg', novalidate: true },
    kindTabs, body,
    h('div', { class: 'card row-2' },
      h('label', { class: 'field' }, h('span', {}, '날짜'), dateInput),
      h('label', { class: 'field' }, h('span', {}, '메모'), memoInput)),
    h('div', { class: 'je-summary' }, preview, saveBtn));
  form.addEventListener('submit', (e) => { e.preventDefault(); onSave(); });
  form.focusAmount = () => amountInputs[0]?.focus();

  drawKinds();
  drawBody();
  return form;

  // =================================================================

  function drawKinds() {
    replace(kindTabs, SIMPLE_KINDS.map((k) => h('button', {
      type: 'button',
      'aria-pressed': String(k === kind),
      onClick: () => {
        if (k === kind) return;
        kind = k;
        prefs.set('simpleKind', k);
        drawKinds();
        drawBody();
        form.focusAmount();
      },
    }, SIMPLE_FORMS[k].label)));
  }

  function optionsFor(picker) {
    const opts = all.filter((o) => picker.filter(o.account))
      .map((o) => ({ id: o.id, label: o.account.name, title: o.label, account: o.account }));
    return sortByRecent(opts, recentUse());
  }

  /** 종류에 맞는 금액 칸·계정 칩 그리기 */
  function drawBody() {
    const spec = SIMPLE_FORMS[kind];
    for (const key of Object.keys(values)) delete values[key];

    amountInputs = spec.amounts.map(({ key, label }) => {
      const input = amountInput({ label, onChange: (_, text) => { values[key] = text; update(); } });
      input.classList.add('big');
      return input;
    });
    const amountBox = h('div', { class: spec.amounts.length > 1 ? 'row-2' : 'stack' },
      amountInputs.map((input, i) => h('label', { class: 'field' }, h('span', {}, spec.amounts[i].label), input)));

    const pickers = spec.pickers.map((p) => {
      const opts = optionsFor(p);
      values[p.key] = defaultChoice(p, opts, recentUse());
      return chipGroup({
        label: p.label,
        options: opts,
        selected: values[p.key],
        limit: p.auto ? 4 : 8,
        onSelect: (id) => { values[p.key] = id; update(); },
      });
    });

    replace(body, h('div', { class: 'card stack' }, amountBox), ...pickers);
    update();
  }

  /** 미리보기·저장 버튼 갱신 */
  function update() {
    const r = buildSimple(kind, values);
    const dateOk = isValidDate(dateInput.value);
    // 변환 결과를 분개 검증(core/journal)으로 한 번 더 확인
    const check = r.ok
      ? validateJournal(r.lines.map((l) => ({ accountId: l.account_id, debit: l.debit, credit: l.credit })))
      : null;
    const ok = r.ok && check.ok && dateOk;
    saveBtn.disabled = !ok;

    if (ok) {
      preview.textContent = '이렇게 기록됩니다: ' + describeLines(r.lines, byId);
      preview.className = 'small muted preview';
    } else {
      const first = !dateOk ? '날짜를 확인하세요.' : (r.errors[0] ?? check?.errors[0]?.message ?? '');
      // 아직 아무것도 안 넣었으면 부드러운 안내
      const untouched = SIMPLE_FORMS[kind].amounts.every(({ key }) => !values[key]);
      preview.textContent = untouched ? '금액을 넣고 항목을 고르면 장부에 어떻게 기록되는지 보여 드립니다.' : first;
      preview.className = 'small ' + (untouched ? 'muted' : 'text-bad');
    }
    return ok ? r : null;
  }

  async function onSave() {
    const r = update();
    if (!r) return;
    const payload = {
      id: pendingId,
      ledgerId: state.ledgerId,
      date: dateInput.value,
      memo: memoInput.value.trim(),
      kind,
      source: 'simple',
      lines: r.lines.map((l) => ({ ...l, memo: '' })),
    };
    const done = await withBusy(saveBtn, '저장 중…', () => save(payload));
    if (done) {
      // 다음 입력 준비: 금액·항목은 비우고 결제수단 등(최근 사용)은 다시 미리 고름. 날짜는 유지
      pendingId = crypto.randomUUID();
      memoInput.value = '';
      drawBody();
      form.focusAmount();
    } else {
      update();
    }
  }
}
