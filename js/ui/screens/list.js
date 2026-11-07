// =====================================================================
// 거래 목록 (분개장) + 휴지통
//   필터: 기간(이번 달·지난 달·올해·전체·직접), 계정(상위면 하위 포함), 검색어(메모·계정 이름), 금액 범위
//   휴지통: 복원, 영구 삭제, 휴지통 비우기
// 검색은 DB 함수 search_transactions 가 합니다.
// =====================================================================

import { h, append, replace, loading, errorBox, toast, withBusy } from '../dom.js';
import { amountInput } from '../amount-input.js';
import { state } from '../state.js';
import { accountFilterSelect, transactionCard } from '../widgets.js';
import { indexAccounts } from '../../core/balance.js';
import { formatAmount, parseAmount } from '../../core/money.js';
import { periodRange, PERIOD_LABELS } from '../../core/reports.js';
import { isValidDate } from '../../core/journal.js';
import { searchTransactions, setTransactionDeleted, purgeTransaction } from '../../data/api.js';
import { downloadCsv, stamp } from '../download.js';
import { journalRows } from '../../core/exports.js';

const PAGE = 50;
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

// 상세 화면에 다녀와도 필터가 유지되도록 화면 밖에 보관
const filters = {
  ledgerId: null, period: 'thisMonth', from: '', to: '', accountId: '', query: '', min: '', max: '',
  trash: false, showAmount: false,
};

export function render(view, ctx) {
  if (filters.ledgerId !== state.ledgerId) {   // 장부를 바꾸면 필터 초기화
    Object.assign(filters, { ledgerId: state.ledgerId, accountId: '', query: '', min: '', max: '', trash: false });
  }
  if (ctx.params.get('account')) {             // 다른 화면에서 계정을 지정해 들어온 경우
    filters.accountId = ctx.params.get('account');
    filters.trash = false;
  }
  const byId = indexAccounts(state.accounts);
  let rows = [];
  let total = 0;
  let timer = null;

  const modeTabs = h('div', { class: 'segmented', role: 'group', 'aria-label': '보기' });
  const filterBox = h('section', { class: 'card filters' });
  const summary = h('div', { class: 'row between' });
  const results = h('div', { class: 'card' });
  const more = h('div');

  // 현재 필터의 결과 전체를 분개장 CSV로
  const csvBtn = h('button', { class: 'btn small', type: 'button' }, 'CSV');
  csvBtn.addEventListener('click', () => withBusy(csvBtn, '…', async () => {
    try {
      const all = [];
      for (let offset = 0; ; offset += 500) {
        const r = await searchTransactions({ ...currentQuery(offset), limit: 500 });
        all.push(...r.rows);
        if (r.rows.length < 500 || all.length >= 20000) break;
      }
      if (!all.length) return toast('내보낼 거래가 없습니다.');
      downloadCsv(`거래목록-${filters.trash ? '휴지통-' : ''}${stamp()}`, journalRows(all, byId));
      toast(`${all.length}건을 CSV로 내려받았습니다.`);
    } catch (err) { toast(err.message, { type: 'error' }); }
  }));

  append(view,
    h('div', { class: 'row between' }, h('h1', { class: 'view-title' }, '거래 목록'), csvBtn),
    h('div', { class: 'stack' }, modeTabs, filterBox, summary, results, more));

  drawModeTabs();
  drawFilters();
  search();

  // =================================================================

  function drawModeTabs() {
    replace(modeTabs, [[false, '거래'], [true, '휴지통']].map(([trash, label]) =>
      h('button', {
        type: 'button', 'aria-pressed': String(filters.trash === trash),
        onClick: () => { if (filters.trash !== trash) { filters.trash = trash; drawModeTabs(); search(); } },
      }, label)));
  }

  function drawFilters() {
    const periodTabs = h('div', { class: 'segmented kinds', role: 'group', 'aria-label': '기간' },
      [...Object.entries(PERIOD_LABELS), ['custom', '직접']].map(([key, label]) =>
        h('button', {
          type: 'button', 'aria-pressed': String(filters.period === key),
          onClick: () => { filters.period = key; drawFilters(); search(); },
        }, label)));

    const custom = filters.period === 'custom'
      ? h('div', { class: 'row-2' },
          dateField('시작일', 'from'), dateField('종료일', 'to'))
      : null;

    const account = accountFilterSelect({
      value: filters.accountId,
      onChange: (id) => { filters.accountId = id; search(); },
    });

    const query = h('input', {
      type: 'search', placeholder: '메모·계정 이름 검색', 'aria-label': '검색어', value: filters.query, enterkeyhint: 'search',
    });
    query.addEventListener('input', () => {
      filters.query = query.value;
      clearTimeout(timer);
      timer = setTimeout(search, 350);   // 입력이 멈추면 검색
    });

    const amountToggle = h('button', { class: 'btn small ghost filter-toggle', type: 'button',
      'aria-expanded': String(filters.showAmount),
      onClick: () => { filters.showAmount = !filters.showAmount; drawFilters(); } },
      filters.showAmount ? '금액 범위 접기' : '+ 금액 범위');
    const amountRange = filters.showAmount
      ? h('div', { class: 'row-2' },
          h('label', { class: 'field' }, h('span', {}, '최소 금액'),
            amountInput({ label: '최소 금액', value: parseAmount(filters.min) || 0,
              onChange: (_, t) => { filters.min = t; clearTimeout(timer); timer = setTimeout(search, 400); } })),
          h('label', { class: 'field' }, h('span', {}, '최대 금액'),
            amountInput({ label: '최대 금액', value: parseAmount(filters.max) || 0,
              onChange: (_, t) => { filters.max = t; clearTimeout(timer); timer = setTimeout(search, 400); } })))
      : null;

    const reset = h('button', { class: 'btn small ghost', type: 'button', onClick: () => {
      Object.assign(filters, { period: 'thisMonth', from: '', to: '', accountId: '', query: '', min: '', max: '', showAmount: false });
      drawFilters(); search();
    } }, '필터 초기화');

    replace(filterBox, periodTabs, custom, account, query,
      h('div', { class: 'row between' }, amountToggle, reset), amountRange);
  }

  function dateField(label, key) {
    const input = h('input', { type: 'date', value: filters[key], 'aria-label': label });
    input.addEventListener('change', () => { filters[key] = input.value; search(); });
    return h('label', { class: 'field' }, h('span', {}, label), input);
  }

  function currentQuery(offset = 0) {
    const range = filters.period === 'custom'
      ? { from: isValidDate(filters.from) ? filters.from : null, to: isValidDate(filters.to) ? filters.to : null }
      : periodRange(filters.period);
    const min = parseAmount(filters.min);
    const max = parseAmount(filters.max);
    return {
      ledgerId: state.ledgerId, ...range, accountId: filters.accountId, query: filters.query.trim(),
      min: min || null, max: max || null, deleted: filters.trash, limit: PAGE, offset,
    };
  }

  async function search() {
    replace(results, loading());
    replace(more);
    replace(summary);
    try {
      const r = await searchTransactions(currentQuery());
      rows = r.rows;
      total = r.total;
      draw();
    } catch (err) {
      replace(results, errorBox(state.online ? err.message : '오프라인이라 거래 목록을 불러올 수 없습니다.', search));
    }
  }

  async function loadMore(button) {
    await withBusy(button, '불러오는 중…', async () => {
      try {
        const r = await searchTransactions(currentQuery(rows.length));
        rows = rows.concat(r.rows);
        total = r.total || total;
        draw();
      } catch (err) {
        toast(err.message, { type: 'error' });
      }
    });
  }

  function draw() {
    const sum = rows.reduce((s, t) => s + Number(t.total), 0);
    replace(summary,
      h('span', { class: 'muted small' }, `${total}건${rows.length < total ? ` 중 ${rows.length}건 표시` : ''}`),
      filters.trash && rows.length
        ? emptyTrashButton()
        : h('span', { class: 'small muted num' }, `금액 합계 ${formatAmount(sum)}`));

    if (!rows.length) {
      replace(results, h('p', { class: 'muted' },
        filters.trash ? '휴지통이 비어 있습니다.' : '조건에 맞는 거래가 없습니다. 기간이나 필터를 바꿔 보세요.'));
      return;
    }

    // 날짜별로 묶어 보여 줌
    const items = [];
    let lastDate = null;
    for (const t of rows) {
      if (t.txn_date !== lastDate) {
        lastDate = t.txn_date;
        const d = new Date(t.txn_date + 'T00:00:00');
        const daySum = rows.filter((x) => x.txn_date === t.txn_date).reduce((s, x) => s + Number(x.total), 0);
        items.push(h('li', { class: 'day-head' },
          h('span', {}, `${t.txn_date} (${WEEKDAYS[d.getDay()]})`), h('span', { class: 'num' }, formatAmount(daySum))));
      }
      items.push(h('li', { class: 'txn-li' },
        transactionCard(t, byId, { showDate: false }),
        filters.trash ? trashActions(t) : null));
    }
    replace(results, h('ul', { class: 'list' }, items));

    replace(more, rows.length < total
      ? h('button', { class: 'btn block', type: 'button', onClick: (e) => loadMore(e.currentTarget) },
          `더 보기 (${total - rows.length}건 남음)`)
      : null);
  }

  function trashActions(t) {
    const restore = h('button', { class: 'btn small', type: 'button' }, '복원');
    const purge = h('button', { class: 'btn small danger', type: 'button' }, '영구 삭제');
    restore.addEventListener('click', () => withBusy(restore, '복원 중…', async () => {
      try {
        await setTransactionDeleted(t.id, false);
        toast('복원했습니다. 잔액·보고서에 다시 반영됩니다.');
        search();
      } catch (err) { toast(err.message, { type: 'error' }); }
    }));
    purge.addEventListener('click', () => {
      if (!confirm('영구 삭제하면 되돌릴 수 없습니다. (변경 이력에는 기록이 남습니다) 삭제할까요?')) return;
      withBusy(purge, '삭제 중…', async () => {
        try {
          await purgeTransaction(t.id);
          toast('영구 삭제했습니다.');
          search();
        } catch (err) { toast(err.message, { type: 'error' }); }
      });
    });
    const deletedAt = t.deleted_at ? new Date(t.deleted_at).toLocaleDateString('ko-KR') : '';
    return h('div', { class: 'row between', style: 'padding-bottom:12px' },
      h('span', { class: 'small muted' }, deletedAt ? `${deletedAt} 삭제` : ''),
      h('div', { class: 'row' }, restore, purge));
  }

  function emptyTrashButton() {
    const btn = h('button', { class: 'btn small danger', type: 'button' }, '휴지통 비우기');
    btn.addEventListener('click', () => {
      if (!confirm(`휴지통의 전표 ${total}건을 모두 영구 삭제할까요? 되돌릴 수 없습니다.`)) return;
      withBusy(btn, '삭제 중…', async () => {
        let done = 0;
        try {
          // 현재 필터와 관계없이 휴지통 전체
          const all = await searchTransactions({ ledgerId: state.ledgerId, deleted: true, limit: 500 });
          for (const t of all.rows) { await purgeTransaction(t.id); done++; }
          toast(`${done}건을 영구 삭제했습니다.`);
        } catch (err) {
          toast(`${done}건 삭제 후 오류: ${err.message}`, { type: 'error' });
        }
        search();
      });
    });
    return btn;
  }
}
