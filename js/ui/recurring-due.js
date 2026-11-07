// =====================================================================
// 반복 거래 "등록 대기" 카드 (대시보드·입력 화면 맨 위)
//   예정일이 된 반복 거래를 보여 주고 [등록] [금액 고쳐 등록] [건너뛰기] [모두 등록]
//   등록하면 DB가 예정일을 확인하고 다음 예정일로 넘깁니다 (두 기기 중복 등록 방지).
//   인터넷 연결이 필요하며, 오프라인이면 카드를 숨깁니다.
// =====================================================================

import { h, replace, toast, withBusy } from './dom.js';
import { state, markUsed } from './state.js';
import { formatAmount } from '../core/money.js';
import { dueList, describeRule, templateLines, templateAmount } from '../core/recurring.js';
import { todayLocal } from '../core/journal.js';
import { listRecurring, skipRecurring, createTransaction } from '../data/api.js';

/**
 * @param {{ navigate: (route: string) => void, onChange?: () => void }} ctx
 * @returns {HTMLElement} 스스로 불러와 채우는 상자
 */
export function recurringDue(ctx) {
  const box = h('div');
  load();
  return box;

  async function load() {
    try {
      const due = dueList(await listRecurring(state.ledgerId), todayLocal());
      draw(due);
    } catch {
      replace(box);   // 오프라인·DB 오류: 조용히 숨김 (반복 거래 화면에서 오류 확인 가능)
    }
  }

  function draw(due) {
    if (!due.length) return replace(box);
    const allBtn = h('button', { class: 'btn small primary', type: 'button' }, '모두 등록');
    allBtn.addEventListener('click', () => withBusy(allBtn, '등록 중…', async () => {
      let ok = 0;
      for (const r of due) if (await post(r, false)) ok++;
      if (ok) toast(`반복 거래 ${ok}건을 등록했습니다.`);
      after();
    }));
    replace(box, h('section', { class: 'card stack due' },
      h('div', { class: 'row between' },
        h('h2', {}, `반복 거래 등록 대기 ${due.length}건`), due.length > 1 ? allBtn : null),
      h('p', { class: 'small muted' }, '예정일이 된 거래입니다. 금액이 맞으면 [등록], 다르면 [금액 고쳐 등록]을 누르세요.'),
      h('ul', { class: 'list' }, due.map(item))));
  }

  function item(r) {
    const amount = templateAmount(r.template);
    const reg = h('button', { class: 'btn small primary', type: 'button' }, '등록');
    const skip = h('button', { class: 'btn small ghost', type: 'button' }, '건너뛰기');
    reg.addEventListener('click', () => withBusy(reg, '등록 중…', async () => { if (await post(r, true)) after(); }));
    skip.addEventListener('click', () => withBusy(skip, '처리 중…', async () => {
      try {
        const next = await skipRecurring(r.id, r.next_date);
        toast(`이번 회차를 건너뛰었습니다. 다음 예정일 ${next}`);
        after();
      } catch (err) { toast(err.message, { type: 'error' }); }
    }));
    return h('li', { class: 'due-item' },
      h('div', { class: 'row between' },
        h('strong', {}, r.name),
        h('span', { class: 'amount-strong' }, formatAmount(amount) + '원')),
      h('div', { class: 'small muted' }, `${r.next_date} · ${describeRule(r)}`),
      h('div', { class: 'due-actions' }, reg,
        h('button', { class: 'btn small', type: 'button', onClick: () => ctx.navigate('recurring-post/' + r.id) }, '금액 고쳐 등록'),
        skip));
  }

  /** 틀 그대로 등록 */
  async function post(r, announce) {
    const t = templateLines(r.template);
    if (!t.ok) {
      toast(`${r.name}: ${t.errors[0]} (반복 거래 화면에서 고치세요)`, { type: 'error', duration: 6000 });
      return false;
    }
    try {
      await createTransaction({
        id: crypto.randomUUID(), ledgerId: state.ledgerId, date: r.next_date,
        memo: r.template.memo || r.name, kind: t.kind, source: 'recurring', lines: t.lines,
        recurringId: r.id, recurringDate: r.next_date,
      });
      markUsed(t.lines.map((l) => l.account_id));
      if (announce) toast(`"${r.name}" ${formatAmount(t.total)}원을 등록했습니다.`);
      return true;
    } catch (err) {
      toast(`${r.name}: ${err.message}`, { type: 'error', duration: 6000 });
      return false;
    }
  }

  function after() {
    load();
    ctx.onChange?.();
  }
}
