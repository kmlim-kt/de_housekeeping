// =====================================================================
// 반복 거래
//   목록 (#/settings/recurring): 이름·규칙·다음 예정일·금액, 켜기/끄기
//   추가·수정 (#/settings/recurring/new, #/settings/recurring/<id>): 규칙 + 거래 내용(간편 입력 또는 분개)
//   금액 고쳐 등록 (#/recurring-post/<id>): 틀을 채운 입력 화면 → 이번 회차만 바꿔 등록
// 날짜 계산은 core/recurring.js (DB와 같은 규칙).
// =====================================================================

import { h, append, replace, loading, errorBox, toast, withBusy } from '../dom.js';
import { state, markUsed } from '../state.js';
import { simpleForm } from './entry-simple.js';
import { advancedForm } from './entry-advanced.js';
import { formatAmount } from '../../core/money.js';
import { FREQ_LABELS, describeRule, firstOccurrence, templateAmount, templateLines } from '../../core/recurring.js';
import { todayLocal, isValidDate } from '../../core/journal.js';
import { indexAccounts, describeLines } from '../../core/balance.js';
import { listRecurring, getRecurring, saveRecurring, setRecurringActive, deleteRecurring, createTransaction } from '../../data/api.js';

// ---------------------------------------------------------------------
// 목록
// ---------------------------------------------------------------------
export function renderList(view) {
  const body = h('div', { class: 'stack' }, loading());
  append(view,
    h('div', { class: 'row' }, h('a', { href: '#/settings', class: 'btn small ghost' }, '‹ 설정'),
      h('h1', { class: 'view-title' }, '반복 거래')),
    h('p', { class: 'small muted', style: 'margin-bottom:12px' },
      '월세·통신비·급여처럼 정해진 날 반복되는 거래를 등록해 두면, 예정일에 대시보드와 입력 화면에 "등록 대기"로 나타납니다. 확인 후 한 번에 등록하세요.'),
    h('a', { class: 'btn primary block', href: '#/settings/recurring/new', style: 'margin-bottom:12px' }, '+ 반복 거래 추가'),
    body);
  load();

  async function load() {
    replace(body, loading());
    try {
      const list = await listRecurring(state.ledgerId);
      if (!list.length) return replace(body, h('p', { class: 'card muted' }, '등록한 반복 거래가 없습니다.'));
      replace(body, h('section', { class: 'card' }, h('ul', { class: 'list' }, list.map(item))));
    } catch (err) {
      replace(body, errorBox(state.online ? err.message : '오프라인이라 반복 거래를 불러올 수 없습니다.', load));
    }
  }

  function item(r) {
    const toggle = h('button', { class: 'btn small', type: 'button' }, r.is_active ? '끄기' : '켜기');
    toggle.addEventListener('click', (e) => {
      e.preventDefault();
      withBusy(toggle, '…', async () => {
        try {
          await setRecurringActive(r.id, !r.is_active);
          toast(r.is_active ? `"${r.name}"을(를) 껐습니다. 등록 대기에 나오지 않습니다.` : `"${r.name}"을(를) 켰습니다.`);
          load();
        } catch (err) { toast(err.message, { type: 'error' }); }
      });
    });
    const ended = r.end_date && r.next_date > r.end_date;
    return h('li', { class: 'row between', style: 'gap:8px' },
      h('a', { class: 'rec-item' + (r.is_active ? '' : ' inactive'), href: '#/settings/recurring/' + r.id, style: 'flex:1' },
        h('strong', {}, r.name),
        h('span', { class: 'num' }, formatAmount(templateAmount(r.template)) + '원'),
        h('span', { class: 'small muted', style: 'grid-column:1/-1' },
          `${describeRule(r)} · ${r.is_active ? (ended ? '종료됨' : `다음 ${r.next_date}`) : '꺼짐'}`
          + (r.end_date ? ` · ${r.end_date}까지` : ''))),
      toggle);
  }
}

// ---------------------------------------------------------------------
// 추가·수정
// ---------------------------------------------------------------------
export function renderEditor(view, ctx, id = null) {
  const body = h('div', { class: 'stack-lg' }, loading());
  append(view,
    h('div', { class: 'row' }, h('a', { href: '#/settings/recurring', class: 'btn small ghost' }, '‹ 목록'),
      h('h1', { class: 'view-title' }, id ? '반복 거래 수정' : '반복 거래 추가')),
    body);

  (async () => {
    try {
      const r = id ? await getRecurring(id) : null;
      if (id && !r) return replace(body, h('p', { class: 'notice' }, '반복 거래를 찾을 수 없습니다.'));
      draw(r);
    } catch (err) {
      replace(body, errorBox(state.online ? err.message : '반복 거래를 저장하려면 인터넷 연결이 필요합니다.'));
    }
  })();

  function draw(r) {
    const today = todayLocal();
    const rule = {
      name: r?.name ?? '',
      freq: r?.freq ?? 'monthly',
      interval_n: r?.interval_n ?? 1,
      day_of_month: r?.day_of_month ?? Number(today.slice(8)),
      start_date: r?.start_date ?? today,
      end_date: r?.end_date ?? '',
      next_date: r?.next_date ?? null,
    };
    let mode = r?.template?.mode === 'advanced' ? 'advanced' : 'simple';

    const name = h('input', { type: 'text', maxlength: '50', placeholder: '예: 월세, 통신비, 급여', value: rule.name, 'aria-label': '이름' });
    const freqTabs = h('div', { class: 'segmented', role: 'group', 'aria-label': '주기' });
    const interval = h('select', { 'aria-label': '간격' });
    const day = h('select', { 'aria-label': '날짜' },
      [...Array(30)].map((_, i) => h('option', { value: String(i + 1) }, `${i + 1}일`)),
      h('option', { value: '31' }, '말일'));
    day.value = String(rule.day_of_month);
    const dayField = h('label', { class: 'field' }, h('span', {}, '날짜'), day);
    const start = h('input', { type: 'date', value: rule.start_date, 'aria-label': '시작일' });
    const end = h('input', { type: 'date', value: rule.end_date, 'aria-label': '종료일' });
    const nextInfo = h('p', { class: 'small muted' });
    const modeTabs = h('div', { class: 'segmented', role: 'group', 'aria-label': '거래 내용 입력 방식' });
    const formBox = h('div');
    const danger = h('div');

    function drawRule() {
      replace(freqTabs, Object.entries(FREQ_LABELS).map(([f, label]) =>
        h('button', { type: 'button', 'aria-pressed': String(rule.freq === f),
          onClick: () => { rule.freq = f; drawRule(); } }, label)));
      const unit = { weekly: '주', monthly: '개월', yearly: '년' }[rule.freq];
      replace(interval, [...Array(12)].map((_, i) =>
        h('option', { value: String(i + 1) }, i === 0 ? FREQ_LABELS[rule.freq] : `${i + 1}${unit}마다`)));
      interval.value = String(rule.interval_n);
      dayField.classList.toggle('hidden', rule.freq === 'weekly');
      updateNext();
    }

    /** 처음(다음) 예정일 계산해 보여 주기 */
    function updateNext() {
      rule.interval_n = Number(interval.value) || 1;
      rule.day_of_month = Number(day.value);
      rule.start_date = start.value;
      rule.end_date = end.value;
      if (!isValidDate(rule.start_date)) { nextInfo.textContent = '시작일을 확인하세요.'; return; }
      // 수정 중이고 규칙이 그대로면 기존 다음 예정일 유지, 바뀌면 시작일 기준으로 다시 계산
      const unchanged = r && r.freq === rule.freq && r.day_of_month === (rule.freq === 'weekly' ? null : rule.day_of_month)
        && r.start_date === rule.start_date && r.interval_n === rule.interval_n;
      rule.next_date = unchanged ? r.next_date
        : firstOccurrence(rule.start_date, rule.freq, rule.freq === 'weekly' ? null : rule.day_of_month);
      const text = describeRule({ ...rule, day_of_month: rule.freq === 'weekly' ? null : rule.day_of_month });
      nextInfo.textContent = `${text} · 다음 예정일 ${rule.next_date}`
        + (rule.next_date <= todayLocal() ? ' (오늘이거나 지난 날이라 저장하면 바로 등록 대기에 나타납니다)' : '');
    }
    for (const el of [interval, day, start, end]) el.addEventListener('change', updateNext);

    function drawForm() {
      replace(modeTabs, [['simple', '간편 입력'], ['advanced', '분개 직접 입력']].map(([m, label]) =>
        h('button', { type: 'button', 'aria-pressed': String(mode === m),
          onClick: () => { if (mode !== m) { mode = m; drawForm(); } } }, label)));
      const t = r?.template;
      if (mode === 'simple') {
        replace(formBox, simpleForm({
          save, submitLabel: '반복 거래 저장', hideDate: true, lockKind: false,
          initial: t?.mode === 'simple' ? { kind: t.kind, values: t.values, memo: t.memo ?? '' } : null,
        }));
      } else {
        replace(formBox, advancedForm({
          save, submitLabel: '반복 거래 저장', hideDate: true,
          initial: t?.mode === 'advanced' ? { kind: 'manual', memo: t.memo ?? '', lines: t.lines.map((l, i) => ({ ...l, line_no: i + 1 })) } : null,
        }));
      }
    }

    async function save(payload) {
      if (!name.value.trim()) { toast('이름을 넣으세요.', { type: 'error' }); name.focus(); return false; }
      updateNext();
      if (!isValidDate(rule.start_date)) { toast('시작일을 확인하세요.', { type: 'error' }); return false; }
      if (rule.end_date && rule.end_date < rule.start_date) { toast('종료일이 시작일보다 빠릅니다.', { type: 'error' }); return false; }
      const template = mode === 'simple'
        ? { mode: 'simple', kind: payload.kind, values: payload.values, memo: payload.memo }
        : { mode: 'advanced', kind: 'manual', lines: payload.lines.map(({ account_id, debit, credit, memo }) => ({ account_id, debit, credit, memo })), memo: payload.memo };
      try {
        await saveRecurring(state.ledgerId, { id: r?.id, ...rule, name: name.value, template,
          is_active: r ? (r.is_active || rule.next_date !== r.next_date) : true });
        toast(`"${name.value.trim()}" 반복 거래를 저장했습니다. 다음 예정일 ${rule.next_date}`);
        ctx.navigate('settings/recurring');
        return true;
      } catch (err) {
        toast(err.message, { type: 'error' });
        return false;
      }
    }

    if (r) {
      const del = h('button', { class: 'btn block danger', type: 'button' }, '이 반복 거래 삭제');
      del.addEventListener('click', () => {
        if (!confirm(`"${r.name}" 반복 거래를 삭제할까요? 이미 등록된 전표는 그대로 남습니다.`)) return;
        withBusy(del, '삭제 중…', async () => {
          try {
            await deleteRecurring(r.id);
            toast('삭제했습니다.');
            ctx.navigate('settings/recurring');
          } catch (err) { toast(err.message, { type: 'error' }); }
        });
      });
      replace(danger, del);
    }

    replace(body,
      h('section', { class: 'card stack' },
        h('label', { class: 'field' }, h('span', {}, '이름'), name),
        h('div', { class: 'field' }, h('span', {}, '주기'), freqTabs),
        h('div', { class: 'row-2' }, h('label', { class: 'field' }, h('span', {}, '간격'), interval), dayField),
        h('div', { class: 'row-2' },
          h('label', { class: 'field' }, h('span', {}, '시작일'), start),
          h('label', { class: 'field' }, h('span', {}, '종료일 (선택)'), end)),
        nextInfo),
      h('div', { class: 'stack' }, h('h2', {}, '거래 내용'), modeTabs,
        h('p', { class: 'small muted' }, '금액이 달마다 다르면 평소 금액을 넣어 두고, 등록할 때 [금액 고쳐 등록]으로 바꾸면 됩니다.')),
      formBox, danger);
    drawRule();
    drawForm();
  }
}

// ---------------------------------------------------------------------
// 금액 고쳐 등록 (이번 회차만)
// ---------------------------------------------------------------------
export function renderPost(view, ctx, id) {
  const byId = indexAccounts(state.accounts);
  const body = h('div', { class: 'stack-lg' }, loading());
  append(view,
    h('div', { class: 'row' }, h('a', { href: '#/dashboard', class: 'btn small ghost' }, '‹ 취소'),
      h('h1', { class: 'view-title' }, '반복 거래 등록')),
    body);

  (async () => {
    try {
      const r = await getRecurring(id);
      if (!r) return replace(body, h('p', { class: 'notice' }, '반복 거래를 찾을 수 없습니다.'));
      draw(r);
    } catch (err) {
      replace(body, errorBox(state.online ? err.message : '등록하려면 인터넷 연결이 필요합니다.'));
    }
  })();

  function draw(r) {
    const t = r.template;
    async function save(payload) {
      try {
        await createTransaction({ ...payload, id: crypto.randomUUID(), source: 'recurring',
          recurringId: r.id, recurringDate: r.next_date });
        markUsed(payload.lines.map((l) => l.account_id));
        toast(`"${r.name}"을(를) 등록했습니다. ${describeLines(payload.lines, byId)}`);
        ctx.navigate('dashboard');
        return true;
      } catch (err) {
        toast(err.message, { type: 'error', duration: 6000 });
        return false;
      }
    }
    const check = templateLines(t);
    const form = t?.mode === 'simple'
      ? simpleForm({ save, submitLabel: '이번 회차 등록', lockKind: true,
          initial: { kind: t.kind, values: t.values, memo: t.memo || r.name, date: r.next_date } })
      : advancedForm({ save, submitLabel: '이번 회차 등록',
          initial: { kind: 'manual', memo: t.memo || r.name, date: r.next_date,
            lines: (t.lines ?? []).map((l, i) => ({ ...l, line_no: i + 1 })) } });
    replace(body,
      h('p', { class: 'small muted' },
        `${describeRule(r)} · 예정일 ${r.next_date}. 여기서 바꾼 금액은 이번 회차에만 적용되고, 다음 예정일로 넘어갑니다.`),
      check.ok ? null : h('p', { class: 'notice bad' }, `반복 거래 내용에 문제가 있습니다: ${check.errors[0]}`),
      form);
  }
}
