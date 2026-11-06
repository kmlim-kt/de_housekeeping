// =====================================================================
// 개시 잔액 설정 마법사
//   지금 가진 돈(자산)과 갚을 돈(부채)을 적으면 기초 순자산을 계산해
//   "개시 잔액" 전표 1건으로 장부를 시작합니다.
//   통장·카드가 여러 개면 이 화면에서 바로 추가할 수 있습니다.
// 분개 변환은 core/simple.js(buildOpening)가 합니다.
// =====================================================================

import { h, append, replace, toast, withBusy } from '../dom.js';
import { amountInput } from '../amount-input.js';
import { state, prefs, markUsed } from '../state.js';
import { buildOpening } from '../../core/simple.js';
import { postableAccounts, indexAccounts, describeLines } from '../../core/balance.js';
import { formatAmount } from '../../core/money.js';
import { todayLocal, isValidDate } from '../../core/journal.js';
import { createAccount, ledgerCheck } from '../../data/api.js';
import { submitTransaction } from '../../data/sync.js';

// 계정을 추가해 화면을 다시 그려도 입력한 금액이 남도록 화면 밖에 보관
const draft = { amounts: {}, date: null, id: null };

export function render(view, ctx) {
  const byId = indexAccounts(state.accounts);
  const options = postableAccounts(state.accounts);
  const assets = options.filter((o) => o.type === 'asset');
  const liabilities = options.filter((o) => o.type === 'liability');
  const openingEquity = state.accounts.find((a) => a.type === 'equity' && a.subtype === 'opening');
  draft.date ??= todayLocal();
  draft.id ??= crypto.randomUUID();

  const dateInput = h('input', { type: 'date', value: draft.date, 'aria-label': '기준일' });
  dateInput.addEventListener('input', () => { draft.date = dateInput.value; update(); });

  const totals = h('div', { class: 'ob-total num' });
  const preview = h('p', { class: 'small muted' });
  const saveBtn = h('button', { class: 'btn primary block', type: 'button', onClick: save }, '개시 잔액 저장');
  const existing = h('div');

  append(view,
    h('h1', { class: 'view-title' }, '개시 잔액 설정'),
    h('div', { class: 'stack-lg' },
      h('p', { class: 'muted' },
        '오늘 기준으로 가진 돈과 갚을 돈을 적어 주세요. 차이가 "기초 순자산"이 되어 장부가 시작됩니다. 없는 항목은 비워 두면 됩니다.'),
      existing,
      h('div', { class: 'card' }, h('label', { class: 'field' }, h('span', {}, '기준일'), dateInput)),
      section('가진 돈 (자산)', '현금, 통장 잔액, 적금, 증권계좌 평가액, 빌려준 돈', assets,
        addButtons([['bank', '+ 통장 추가', '예: 국민은행 월급통장']])),
      section('갚을 돈 (부채)', '카드 미결제 금액(다음 달 청구 포함), 대출 잔액, 빌린 돈', liabilities,
        addButtons([['card', '+ 카드 추가', '예: 신한카드'], ['loan', '+ 대출 추가', '예: 전세자금대출']])),
      h('section', { class: 'card stack' }, h('h2', {}, '결과'), totals, preview),
      h('div', { class: 'je-summary' }, saveBtn),
      h('button', { class: 'btn ghost block', type: 'button', onClick: later }, '나중에 하기')));

  update();
  checkExisting();

  // =================================================================

  function section(title, help, items, extra) {
    return h('section', { class: 'card stack' },
      h('div', {}, h('h2', {}, title), h('p', { class: 'small muted' }, help)),
      h('div', {}, items.map((o) => h('label', { class: 'ob-row' },
        h('span', { class: 'name' }, o.label),
        amountInput({
          label: o.label + ' 잔액',
          value: Number(String(draft.amounts[o.id] ?? '').replace(/\D/g, '')) || 0,
          onChange: (_, text) => { draft.amounts[o.id] = text; update(); },
        })))),
      extra);
  }

  /**
   * 계정 추가 버튼들. subtype 상위 계정(예: 보통예금, 신용카드) 아래에 하위 계정으로 만듭니다.
   * 상위 계정이 없으면(대출 등) 최상위 계정으로 만듭니다.
   */
  function addButtons(specs) {
    const box = h('div', { class: 'stack' });
    const buttons = h('div', { class: 'row', style: 'flex-wrap:wrap' });
    for (const [subtype, label, placeholder] of specs) {
      buttons.append(h('button', {
        class: 'btn small', type: 'button',
        onClick: () => replace(form, inlineAdd(subtype, placeholder)),
      }, label));
    }
    const form = h('div');
    append(box, buttons, form);
    return box;
  }

  function inlineAdd(subtype, placeholder) {
    const type = subtype === 'bank' ? 'asset' : 'liability';
    // 통장은 "보통예금" 아래, 카드는 "신용카드" 아래 하위 계정으로. 대출은 최상위 계정으로
    const parentForChild = subtype === 'loan' ? null
      : state.accounts.find((a) => a.type === type && a.subtype === subtype && !a.parent_id);
    const name = h('input', { type: 'text', maxlength: '30', placeholder, 'aria-label': '새 계정 이름' });
    const add = h('button', { class: 'btn small primary', type: 'submit' }, '추가');
    const f = h('form', { class: 'inline-add' }, name, add);
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!name.value.trim()) return name.focus();
      withBusy(add, '추가 중…', async () => {
        try {
          await createAccount({
            ledgerId: state.ledgerId, name: name.value, type, subtype,
            parentId: parentForChild?.id ?? null,
            sortOrder: (parentForChild?.sort_order ?? (type === 'asset' ? 20 : 120)) + 5,
          });
          await ctx.reloadAccounts();
          toast(`"${name.value.trim()}" 계정을 추가했습니다.`);
          ctx.refresh();
        } catch (err) {
          toast(err.message, { type: 'error' });
        }
      });
    });
    requestAnimationFrame(() => name.focus());
    return f;
  }

  function update() {
    const entries = Object.entries(draft.amounts).map(([accountId, amount]) => ({ accountId, amount }))
      .filter((e) => byId.has(e.accountId));
    const r = buildOpening(entries, openingEquity?.id, byId);
    replace(totals,
      h('div', {}, h('span', {}, '자산 합계'), h('span', {}, formatAmount(r.assets) + '원')),
      h('div', {}, h('span', {}, '부채 합계'), h('span', {}, formatAmount(r.liabilities) + '원')),
      h('div', { class: 'net' }, h('span', {}, '기초 순자산'),
        h('span', { class: r.netWorth < 0 ? 'text-bad' : '' }, formatAmount(r.netWorth) + '원')));
    const ok = r.ok && isValidDate(dateInput.value);
    saveBtn.disabled = !ok;
    preview.textContent = r.ok ? '이렇게 기록됩니다: ' + describeLines(r.lines, byId)
      : r.errors.find((e) => !e.includes('하나 이상')) ?? '잔액을 하나 이상 넣으면 기록될 내용을 보여 드립니다.';
    preview.className = 'small ' + (r.ok || r.errors.every((e) => e.includes('하나 이상')) ? 'muted' : 'text-bad');
    return ok ? r : null;
  }

  async function checkExisting() {
    try {
      const r = await ledgerCheck(state.ledgerId);
      if (r.total_debit > 0) {
        replace(existing, h('p', { class: 'notice' },
          '이 장부에는 이미 거래가 있습니다. 개시 잔액은 보통 처음 한 번만 넣습니다. 두 번 넣으면 잔액이 두 배가 되니 주의하세요.'));
      }
    } catch {
      /* 오프라인 등 — 안내만 생략 */
    }
  }

  async function save() {
    const r = update();
    if (!r) return;
    const payload = {
      id: draft.id, ledgerId: state.ledgerId, date: dateInput.value, memo: '개시 잔액',
      kind: 'opening', source: 'opening', lines: r.lines.map((l) => ({ ...l, memo: '' })),
    };
    await withBusy(saveBtn, '저장 중…', async () => {
      try {
        const { status } = await submitTransaction(payload);
        markUsed(r.lines.filter((l) => byId.get(l.account_id)?.type === 'asset').map((l) => l.account_id));
        toast(status === 'saved'
          ? `개시 잔액을 저장했습니다. 기초 순자산 ${formatAmount(r.netWorth)}원`
          : '오프라인이라 이 기기에 임시 저장했습니다. 연결되면 자동으로 저장됩니다.', { duration: 5000 });
        draft.amounts = {};
        draft.id = null;
        draft.date = null;
        prefs.set('openingPrompted.' + state.ledgerId, true);
        ctx.navigate('dashboard');
      } catch (err) {
        toast(err.message, { type: 'error', duration: 6000 });
      }
    });
  }

  function later() {
    prefs.set('openingPrompted.' + state.ledgerId, true);
    ctx.navigate('dashboard');
  }
}
