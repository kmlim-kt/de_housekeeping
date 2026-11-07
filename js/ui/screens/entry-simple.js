// =====================================================================
// 간편 입력 — 회계 용어 없이 고르고 금액만 넣으면 자동 분개
//   지출 / 수입 / 이체 / 카드대금 / 대출 상환
//   휴대폰에서 지출 3터치: [+ 입력] → (금액 입력) → 항목 칩 → [저장]
//   결제수단 등은 최근에 쓴 계정을 미리 골라 둡니다.
// 분개 변환은 core/simple.js가 하고, 이 파일은 화면만 다룹니다.
// =====================================================================

import { h, replace, withBusy, toast } from '../dom.js';
import { amountInput } from '../amount-input.js';
import { chipGroup } from '../chips.js';
import { state, recentUse, prefs } from '../state.js';
import { SIMPLE_FORMS, SIMPLE_KINDS, buildSimple, sortByRecent, defaultChoice } from '../../core/simple.js';
import { validateJournal, todayLocal, isValidDate } from '../../core/journal.js';
import { postableAccounts, indexAccounts, describeLines } from '../../core/balance.js';
import { parseAmount } from '../../core/money.js';

/**
 * @param {{ save: (payload) => Promise<boolean>,
 *           initial?: { id?: string, kind: string, values: object, date?: string, memo: string },
 *           submitLabel?: string, lockKind?: boolean, hideDate?: boolean,
 *           favorites?: Array<{id, name, template}>, onSaveFavorite?: (name: string, template: object) => Promise<boolean> }} ctx
 *   initial: 기존 값으로 채워 열기 (전표 수정·반복 거래 수정·반복 등록). 저장 후 입력란을 비우지 않음
 *   lockKind: 종류 바꾸기 막기 (전표 수정)
 *   hideDate: 날짜 칸 숨김 (반복 거래 틀 — 날짜는 반복 규칙이 정함)
 *   favorites: 맨 위에 보여 줄 즐겨찾기 (누르면 채워짐)
 *   onSaveFavorite: 있으면 [☆ 즐겨찾기로 저장] 버튼 표시
 *   save에 넘기는 payload에는 lines와 함께 values(간편 입력 값)도 들어 있습니다.
 * @returns {HTMLElement & { focusAmount: () => void }}
 */
export function simpleForm({ save, initial = null, submitLabel = '저장', lockKind = !!initial, hideDate = false,
  favorites = [], onSaveFavorite = null }) {
  const byId = indexAccounts(state.accounts);
  // 수정 중인 전표에 숨긴 계정이 쓰였으면 그 계정도 칩으로 보여 줌
  const keep = new Set(initial ? Object.values(initial.values) : []);
  const all = postableAccounts(state.accounts, { includeHidden: true })
    .filter((o) => !o.account.is_hidden && !byId.get(o.account.parent_id)?.is_hidden || keep.has(o.id));
  let kind = initial?.kind ?? prefs.get('simpleKind', 'expense');
  if (!SIMPLE_FORMS[kind]) kind = 'expense';

  const values = {};             // 입력값: 금액 칸 key → 문자열, 계정 칸 key → id
  let pendingId = initial?.id ?? crypto.randomUUID();
  let amountInputs = [];

  const kindTabs = h('div', { class: 'segmented kinds', role: 'group', 'aria-label': '입력 종류' });
  const body = h('div', { class: 'stack-lg' });
  const dateInput = h('input', { type: 'date', value: initial?.date ?? todayLocal(), 'aria-label': '날짜' });
  const memoInput = h('input', { type: 'text', maxlength: '200', placeholder: '메모 (선택)', 'aria-label': '메모',
    enterkeyhint: 'done', value: initial?.memo ?? '' });
  const preview = h('p', { class: 'small muted', 'aria-live': 'polite' });
  const saveBtn = h('button', { class: 'btn primary block', type: 'submit' }, submitLabel);
  dateInput.addEventListener('input', update);

  const favBox = h('div');
  const favSave = h('div');

  const form = h('form', { class: 'stack-lg', novalidate: true },
    favBox, kindTabs, body,
    h('div', { class: hideDate ? 'card' : 'card row-2' },
      hideDate ? null : h('label', { class: 'field' }, h('span', {}, '날짜'), dateInput),
      h('label', { class: 'field' }, h('span', {}, '메모'), memoInput)),
    favSave,
    h('div', { class: 'je-summary' }, preview, saveBtn));
  form.addEventListener('submit', (e) => { e.preventDefault(); onSave(); });
  form.focusAmount = () => amountInputs[0]?.focus();

  drawFavorites();
  drawFavoriteSave();
  drawKinds();
  drawBody(initial?.values);
  return form;

  // =================================================================

  /** 저장용 입력값: 이 종류에 쓰는 칸만, 금액은 숫자(빈칸이면 '') */
  function cleanValues() {
    const spec = SIMPLE_FORMS[kind];
    const out = {};
    for (const { key } of spec.amounts) out[key] = parseAmount(values[key]) || '';
    for (const { key } of spec.pickers) out[key] = values[key] || '';
    return out;
  }

  /** 즐겨찾기 칩: 누르면 종류·계정·금액·메모가 채워짐 */
  function drawFavorites() {
    const usable = favorites.filter((f) => f.template?.mode === 'simple' && SIMPLE_FORMS[f.template.kind]);
    if (!usable.length) return replace(favBox);
    replace(favBox, h('div', { class: 'stack', style: 'gap:6px' },
      h('span', { class: 'chip-label small' }, '★ 즐겨찾기'),
      h('div', { class: 'fav-row', role: 'group', 'aria-label': '즐겨찾기' }, usable.map((f) =>
        h('button', { type: 'button', class: 'chip', onClick: () => applyFavorite(f) }, f.name)))));
  }

  function applyFavorite(f) {
    kind = f.template.kind;
    drawKinds();
    drawBody(f.template.values);
    memoInput.value = f.template.memo ?? '';
    update();
    // 금액이 비어 있는 즐겨찾기면 금액 칸으로
    if (!SIMPLE_FORMS[kind].amounts.some(({ key }) => values[key])) form.focusAmount();
  }

  /** [☆ 즐겨찾기로 저장] → 이름 입력 → 저장 */
  function drawFavoriteSave() {
    if (!onSaveFavorite) return;
    const open = h('button', { class: 'btn small ghost', type: 'button' }, '☆ 이 입력을 즐겨찾기로 저장');
    open.addEventListener('click', () => {
      const name = h('input', { type: 'text', maxlength: '30', placeholder: '예: 점심 카드, 월세',
        'aria-label': '즐겨찾기 이름', value: memoInput.value.trim().slice(0, 30) });
      const ok = h('button', { class: 'btn small primary', type: 'button' }, '저장');
      const cancel = h('button', { class: 'btn small ghost', type: 'button', onClick: () => drawFavoriteSave() }, '취소');
      ok.addEventListener('click', () => {
        if (!name.value.trim()) return name.focus();
        const missing = SIMPLE_FORMS[kind].pickers.some((p) => !values[p.key]);
        if (missing) { toast('계정을 모두 고른 뒤 저장하세요. (금액은 비워 둬도 됩니다)', { type: 'error' }); return; }
        withBusy(ok, '저장 중…', async () => {
          const template = { mode: 'simple', kind, values: cleanValues(), memo: memoInput.value.trim() };
          if (await onSaveFavorite(name.value, template)) drawFavoriteSave();
        });
      });
      replace(favSave, h('div', { class: 'card stack' },
        h('p', { class: 'small muted' }, '지금 고른 종류·계정·금액·메모를 저장합니다. 금액을 비우고 저장하면 매번 금액만 넣으면 됩니다.'),
        h('div', { class: 'inline-add' }, name, ok), cancel));
      name.focus();
    });
    replace(favSave, open);
  }

  function drawKinds() {
    replace(kindTabs, SIMPLE_KINDS.map((k) => h('button', {
      type: 'button',
      'aria-pressed': String(k === kind),
      disabled: lockKind && k !== kind,   // 전표 수정할 때는 종류 고정
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

  /**
   * 종류에 맞는 금액 칸·계정 칩 그리기
   * @param {object} [init] 미리 채울 값 (수정할 때)
   */
  function drawBody(init) {
    const spec = SIMPLE_FORMS[kind];
    for (const key of Object.keys(values)) delete values[key];

    amountInputs = spec.amounts.map(({ key, label }) => {
      const start = Number(init?.[key]) || 0;
      if (start) values[key] = String(start);
      const input = amountInput({ label, value: start, onChange: (_, text) => { values[key] = text; update(); } });
      input.classList.add('big');
      return input;
    });
    const amountBox = h('div', { class: spec.amounts.length > 1 ? 'row-2' : 'stack' },
      amountInputs.map((input, i) => h('label', { class: 'field' }, h('span', {}, spec.amounts[i].label), input)));

    const pickers = spec.pickers.map((p) => {
      const opts = optionsFor(p);
      values[p.key] = init ? (init[p.key] || '') : defaultChoice(p, opts, recentUse());
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
      values: cleanValues(),   // 반복 거래·즐겨찾기 틀로 저장할 때 사용
    };
    const done = await withBusy(saveBtn, '저장 중…', () => save(payload));
    if (done && initial) return;   // 수정: 화면 이동은 호출한 쪽이 처리
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
