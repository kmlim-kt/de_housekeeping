// =====================================================================
// 개발용 모의 백엔드 — 로그인 없이 화면을 점검할 때만 사용 (앱에는 포함되지 않음)
//   브라우저 콘솔에서: (await import('/tools/ui-mock.js')).startMock()
//   supabase.rpc / supabase.from 을 메모리 데이터로 바꿔치기하고 앱 뼈대를 그립니다.
//   데이터: 1단계 시나리오 (개시 잔액 → 카드 식비 3만 → 카드대금 → 급여 → 대출 상환)
// =====================================================================

const LEDGER = '00000000-0000-4000-8000-0000000000aa';
const USER = '00000000-0000-4000-8000-0000000000bb';
let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

const acc = {};
const accounts = [];
function A(key, name, type, extra = {}) {
  acc[key] = uuid();
  accounts.push({ id: acc[key], name, type, subtype: null, parent_id: null, is_hidden: false, is_system: false, sort_order: 0, ...extra });
}
A('cash', '현금', 'asset', { subtype: 'cash', sort_order: 10 });
A('bank', '보통예금', 'asset', { subtype: 'bank', sort_order: 20 });
A('bank1', '주거래 통장', 'asset', { subtype: 'bank', parent_id: acc.bank, sort_order: 21 });
A('sav', '적금', 'asset', { subtype: 'savings', sort_order: 30 });
A('card', '신용카드', 'liability', { subtype: 'card', sort_order: 110 });
A('card1', '주 사용 카드', 'liability', { subtype: 'card', parent_id: acc.card, sort_order: 111 });
A('loan', '대출', 'liability', { subtype: 'loan', sort_order: 120 });
A('open', '기초 순자산', 'equity', { subtype: 'opening', is_system: true, sort_order: 210 });
A('salary', '급여', 'income', { sort_order: 310 });
A('food', '식비', 'expense', { sort_order: 410 });
A('interest', '대출이자', 'expense', { sort_order: 500 });
A('tax', '세금·사회보험', 'expense', { sort_order: 510 });

const txns = [];
const audit = [];
function T(date, memo, kind, source, lines) {
  const id = uuid();
  const ts = new Date(`${date}T09:00:00Z`).toISOString();
  txns.push({ id, ledger_id: LEDGER, txn_date: date, memo, kind, source, is_deleted: false, deleted_at: null,
    created_at: ts, updated_at: ts, created_by: USER, updated_by: USER,
    lines: lines.map(([k, d, c], i) => ({ account_id: acc[k], debit: d, credit: c, memo: '', line_no: i + 1 })) });
  audit.push({ id: audit.length + 1, transaction_id: id, action: 'create', before: null, after: null, changed_by: USER, changed_at: ts });
  return id;
}
const pad2 = (x) => String(x).padStart(2, '0');
const monthStr = (back) => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - back); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-`; };
const thisMonth = monthStr(0);
// 6개월 전 개시 → 지난 5개월 동안 급여·식비·카드대금 (그래프용)
T(monthStr(6) + '01', '개시 잔액', 'opening', 'opening',
  [['cash', 100000, 0], ['bank1', 2000000, 0], ['loan', 0, 1000000], ['card1', 0, 300000], ['open', 0, 800000]]);
for (let back = 5; back >= 1; back--) {
  const food = 400000 + back * 37000;
  T(monthStr(back) + '10', '월급', 'income', 'simple', [['bank1', 3000000, 0], ['salary', 0, 3000000]]);
  T(monthStr(back) + '15', '장보기', 'expense', 'simple', [['food', food, 0], ['card1', 0, food]]);
  T(monthStr(back) + '25', '카드대금', 'card_payment', 'simple', [['card1', food, 0], ['bank1', 0, food]]);
}
T(thisMonth + '05', '점심', 'expense', 'simple', [['food', 30000, 0], ['card1', 0, 30000]]);
T(thisMonth + '06', '카드대금', 'card_payment', 'simple', [['card1', 330000, 0], ['bank1', 0, 330000]]);
T(thisMonth + '06', '1월 급여', 'manual', 'advanced', [['bank1', 3000000, 0], ['tax', 300000, 0], ['salary', 0, 3300000]]);
T(thisMonth + '07', '대출 상환', 'loan_repayment', 'simple', [['loan', 500000, 0], ['interest', 50000, 0], ['bank1', 0, 550000]]);

const byId = () => new Map(accounts.map((a) => [a.id, a]));
const sign = (type, d, c) => (type === 'asset' || type === 'expense' ? d - c : c - d);
const live = () => txns.filter((t) => !t.is_deleted);
const inRange = (t, from, to) => (!from || t.txn_date >= from) && (!to || t.txn_date <= to);
const total = (t) => t.lines.reduce((s, l) => s + l.debit, 0);
const snapshot = (t) => ({ transaction: { ...t, lines: undefined }, lines: t.lines.map((l) => ({ ...l })) });

function balances(from, to) {
  return accounts.map((a) => {
    let d = 0; let c = 0;
    for (const t of live()) if (inRange(t, from, to)) for (const l of t.lines) if (l.account_id === a.id) { d += l.debit; c += l.credit; }
    return { account_id: a.id, name: a.name, type: a.type, subtype: a.subtype, parent_id: a.parent_id,
      is_hidden: a.is_hidden, sort_order: a.sort_order, debit_total: d, credit_total: c, balance: sign(a.type, d, c) };
  });
}

const RPC = {
  schema_version: () => 3,
  monthly_summary: ({ p_months, p_end }) => {
    const end = new Date((p_end ?? new Date().toISOString().slice(0, 10)) + 'T00:00:00');
    const out = [];
    for (let i = p_months - 1; i >= 0; i--) {
      const m0 = new Date(end.getFullYear(), end.getMonth() - i, 1);
      const m1 = new Date(end.getFullYear(), end.getMonth() - i + 1, 1);
      const key = `${m0.getFullYear()}-${pad2(m0.getMonth() + 1)}`;
      const lastDay = new Date(m1 - 86400000);
      const endStr = `${lastDay.getFullYear()}-${pad2(lastDay.getMonth() + 1)}-${pad2(lastDay.getDate())}`;
      let income = 0; let expense = 0; let assets = 0; let liabilities = 0;
      for (const t of live()) {
        for (const l of t.lines) {
          const type = byId().get(l.account_id).type;
          const inMonth = t.txn_date >= `${key}-01` && t.txn_date <= endStr;
          if (type === 'income' && inMonth) income += l.credit - l.debit;
          if (type === 'expense' && inMonth) expense += l.debit - l.credit;
          if (type === 'asset' && t.txn_date <= endStr) assets += l.debit - l.credit;
          if (type === 'liability' && t.txn_date <= endStr) liabilities += l.credit - l.debit;
        }
      }
      out.push({ month: key, month_end: endStr, income, expense, assets, liabilities, net_worth: assets - liabilities });
    }
    return out;
  },
  ledger_check: ({ p_as_of }) => {
    const b = balances(null, p_as_of);
    const s = (type) => b.filter((r) => r.type === type).reduce((x, r) => x + r.balance, 0);
    const td = b.reduce((x, r) => x + r.debit_total, 0);
    const tc = b.reduce((x, r) => x + r.credit_total, 0);
    const net = s('income') - s('expense');
    return { total_debit: td, total_credit: tc, debit_credit_ok: td === tc, unbalanced_count: 0,
      assets: s('asset'), liabilities: s('liability'), equity: s('equity'), net_income: net,
      net_worth: s('asset') - s('liability'), equation_ok: s('asset') === s('liability') + s('equity') + net };
  },
  account_balances: ({ p_from, p_to }) => balances(p_from, p_to),
  account_ledger: ({ p_account_id, p_from, p_to }) => {
    const ids = new Set(accounts.filter((a) => a.id === p_account_id || a.parent_id === p_account_id).map((a) => a.id));
    const a = byId().get(p_account_id);
    const s = a.type === 'asset' || a.type === 'expense' ? 1 : -1;
    let opening = 0;
    for (const t of live()) if (p_from && t.txn_date < p_from) for (const l of t.lines) if (ids.has(l.account_id)) opening += l.debit - l.credit;
    let run = opening;
    return live().filter((t) => inRange(t, p_from, p_to) && t.lines.some((l) => ids.has(l.account_id)))
      .sort((x, y) => x.txn_date.localeCompare(y.txn_date)
        || (x.txn_time ?? '00:00').localeCompare(y.txn_time ?? '00:00') || x.created_at.localeCompare(y.created_at))
      .map((t) => {
        const mine = t.lines.filter((l) => ids.has(l.account_id));
        const d = mine.reduce((x, l) => x + l.debit, 0);
        const c = mine.reduce((x, l) => x + l.credit, 0);
        run += d - c;
        return { transaction_id: t.id, txn_date: t.txn_date, txn_time: t.txn_time ?? null, memo: t.memo, kind: t.kind, debit: d, credit: c,
          running_balance: run * s, opening_balance: opening * s,
          counter_accounts: [...new Set(t.lines.filter((l) => !ids.has(l.account_id)).map((l) => byId().get(l.account_id).name))].join(', ') };
      });
  },
  search_transactions: (p) => {
    const q = (p.p_query || '').trim();
    const sub = p.p_account_id ? new Set(accounts.filter((a) => a.id === p.p_account_id || a.parent_id === p.p_account_id).map((a) => a.id)) : null;
    const key = (t) => `${t.txn_date} ${(t.txn_time ?? '00:00').slice(0, 5)} ${t.created_at}`;
    const rows = txns.filter((t) => t.is_deleted === !!p.p_deleted && inRange(t, p.p_from, p.p_to)
      && (!sub || t.lines.some((l) => sub.has(l.account_id)))
      && (!q || t.memo.includes(q) || t.lines.some((l) => byId().get(l.account_id).name.includes(q)))
      && (p.p_min == null || total(t) >= p.p_min) && (p.p_max == null || total(t) <= p.p_max))
      .sort((x, y) => (p.p_order === 'asc' ? 1 : -1) * key(x).localeCompare(key(y)));
    return rows.slice(p.p_offset, p.p_offset + p.p_limit)
      .map((t) => ({ ...t, total: total(t), lines: t.lines, total_count: rows.length }));
  },
  skip_recurring: ({ p_id, p_date }) => advanceRecurring(p_id, p_date),
  ledger_members_info: () => [
    { user_id: USER, email: 'mock@example.com', role: 'owner', joined_at: '2026-11-01T00:00:00Z', is_me: true },
    { user_id: '00000000-0000-4000-8000-0000000000cc', email: 'spouse@example.com', role: 'member', joined_at: '2026-11-03T00:00:00Z', is_me: false },
  ],
  create_invite: ({ p_email }) => {
    const code = 'AB3CD5EF7G';
    tables.ledger_invites.push({ id: uuid(), ledger_id: LEDGER, code, email: p_email, created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 7 * 86400000).toISOString(), used_at: null });
    return code;
  },
  accept_invite: () => { throw { message: '초대 코드가 없거나 만료되었습니다.', code: '22023' }; },
  set_member_role: () => null,
  remove_member: () => null,
  create_ledger: () => uuid(),
  restore_ledger: ({ p_name, p_data }) => {
    restored.push({ name: p_name, data: p_data });
    return { ledger_id: LEDGER, accounts: p_data.accounts.length, transactions: p_data.transactions.length,
      budgets: (p_data.budgets ?? []).length, recurring: (p_data.recurring ?? []).length, favorites: (p_data.favorites ?? []).length };
  },
  create_transaction: (p) => {
    if (txns.some((t) => t.id === p.p_id)) return p.p_id;
    if (p.p_recurring_id) advanceRecurring(p.p_recurring_id, p.p_recurring_date);
    const ts = new Date().toISOString();
    txns.push({ id: p.p_id, ledger_id: LEDGER, txn_date: p.p_date, txn_time: p.p_time ? p.p_time.slice(0, 5) + ':00' : null, memo: p.p_memo, kind: p.p_kind, source: p.p_source,
      is_deleted: false, deleted_at: null, created_at: ts, updated_at: ts, created_by: USER, updated_by: USER,
      lines: p.p_lines.map((l, i) => ({ account_id: l.account_id, debit: l.debit || 0, credit: l.credit || 0, memo: l.memo || '', line_no: i + 1 })) });
    audit.push({ id: audit.length + 1, transaction_id: p.p_id, action: 'create', changed_by: USER, changed_at: ts });
    return p.p_id;
  },
  update_transaction: (p) => {
    const t = txns.find((x) => x.id === p.p_id);
    if (p.p_expected_updated_at && p.p_expected_updated_at !== t.updated_at) {
      throw { message: '다른 기기에서 먼저 수정한 전표입니다. 새로 불러온 뒤 다시 수정하세요.', code: '40001' };
    }
    const before = snapshot(t);
    Object.assign(t, { txn_date: p.p_date, memo: p.p_memo, kind: p.p_kind, updated_at: new Date().toISOString(),
      txn_time: p.p_time === undefined || p.p_time === null ? t.txn_time : (p.p_time === '' ? null : p.p_time.slice(0, 5) + ':00'),
      lines: p.p_lines.map((l, i) => ({ account_id: l.account_id, debit: l.debit || 0, credit: l.credit || 0, memo: l.memo || '', line_no: i + 1 })) });
    audit.push({ id: audit.length + 1, transaction_id: t.id, action: 'update', before, after: snapshot(t), changed_by: USER, changed_at: t.updated_at });
    return t.updated_at;
  },
  set_transaction_deleted: ({ p_id, p_deleted }) => {
    const t = txns.find((x) => x.id === p_id);
    t.is_deleted = p_deleted;
    t.deleted_at = p_deleted ? new Date().toISOString() : null;
    audit.push({ id: audit.length + 1, transaction_id: p_id, action: p_deleted ? 'delete' : 'restore', changed_by: USER, changed_at: new Date().toISOString() });
  },
  purge_transaction: ({ p_id }) => {
    audit.push({ id: audit.length + 1, transaction_id: p_id, action: 'purge', changed_by: USER, changed_at: new Date().toISOString() });
    txns.splice(txns.findIndex((x) => x.id === p_id), 1);
  },
};

// 단순 테이블 (예산·반복 거래·즐겨찾기·초대)
const tables = { budgets: [], recurring: [], favorites: [], ledger_invites: [] };
let ledgerName = '모의 장부';
const restored = [];   // 모의 복원 기록

/** supabase.from(...) 흉내: eq 필터 + select/insert/update/upsert/delete, await 하면 결과 */
function fromMock(table) {
  const f = {};
  let single = false;
  let limit = Infinity;
  let op = 'select';
  let payload = null;
  let conflict = null;
  let rangeFrom = 0;
  const match = (row) => Object.entries(f).every(([k, v]) => row[k] === v);
  const chain = {
    select: () => chain,
    order: () => chain,
    insert: (p) => { op = 'insert'; payload = p; return chain; },
    update: (p) => { op = 'update'; payload = p; return chain; },
    upsert: (p, o) => { op = 'upsert'; payload = p; conflict = o?.onConflict?.split(','); return chain; },
    delete: () => { op = 'delete'; return chain; },
    eq: (col, val) => { f[col] = val; return chain; },
    is: (col, val) => { f[col] = val; return chain; },
    range: (a, b) => { rangeFrom = a; limit = b - a + 1; return chain; },
    limit: (k) => { limit = k; return chain; },
    maybeSingle: () => { single = true; return chain; },
    single: () => { single = true; return chain; },
    then: (resolve) => {
      let data = [];
      const store = tables[table];
      if (store && op !== 'select') {
        const rows = Array.isArray(payload) ? payload : [payload];
        if (op === 'insert') {
          data = rows.map((r) => ({ id: uuid(), created_at: new Date().toISOString(), sort_order: 0, is_active: true, ...r }));
          store.push(...data);
        } else if (op === 'update') {
          data = store.filter(match);
          data.forEach((r) => Object.assign(r, payload));
        } else if (op === 'upsert') {
          for (const r of rows) {
            const hit = store.find((x) => conflict.every((k) => x[k] === r[k]));
            if (hit) Object.assign(hit, r); else store.push({ id: uuid(), ...r });
          }
        } else if (op === 'delete') {
          for (const r of store.filter(match)) store.splice(store.indexOf(r), 1);
        }
      } else if (store) {
        data = store.filter(match).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)
          || String(a.next_date ?? '').localeCompare(String(b.next_date ?? '')));
      } else if (table === 'transactions') {
        data = txns.filter((t) => (!f.id || t.id === f.id) && (f.is_deleted === undefined || t.is_deleted === f.is_deleted))
          .sort((x, y) => y.txn_date.localeCompare(x.txn_date) || y.created_at.localeCompare(x.created_at))
          .slice(rangeFrom, rangeFrom + limit);
      } else if (table === 'ledgers') {
        if (op === 'update') { ledgerName = payload.name; data = [{ id: LEDGER }]; }
      } else if (table === 'audit_log') {
        data = audit.filter((e) => e.transaction_id === f.transaction_id).slice().reverse();
      } else if (table === 'accounts') {
        if (op === 'update') {
          data = accounts.filter(match);
          data.forEach((r) => Object.assign(r, payload));
        } else {
          data = accounts;
        }
      }
      // 실제 서버처럼 복사본을 돌려줌 (화면이 들고 있는 값과 서버 값이 따로 놀아야 충돌 시험이 됨)
      resolve({ data: structuredClone(single ? (data[0] ?? null) : data), error: null });
    },
  };
  return chain;
}

/** DB의 private.next_occurrence 와 같은 계산 (모의용) */
function nextOcc(date, freq, n, day) {
  const [y, m, d] = date.split('-').map(Number);
  if (freq === 'weekly') { const t = new Date(y, m - 1, d + 7 * n); return `${t.getFullYear()}-${pad2(t.getMonth() + 1)}-${pad2(t.getDate())}`; }
  const b = new Date(y, m - 1 + (freq === 'monthly' ? n : 12 * n), 1);
  const last = new Date(b.getFullYear(), b.getMonth() + 1, 0).getDate();
  return `${b.getFullYear()}-${pad2(b.getMonth() + 1)}-${pad2(Math.min(day ?? d, last))}`;
}
function advanceRecurring(id, date) {
  const r = tables.recurring.find((x) => x.id === id);
  if (!r || r.next_date !== date) throw { message: '이미 등록했거나 건너뛴 반복 거래입니다.', code: '40001' };
  r.next_date = nextOcc(r.next_date, r.freq, r.interval_n, r.day_of_month);
  if (r.end_date && r.next_date > r.end_date) r.is_active = false;
  return r.next_date;
}

export async function startMock(route = 'list') {
  const { supabase } = await import('/js/data/supabase.js');
  const { setState } = await import('/js/ui/state.js');
  const { renderShell } = await import('/js/ui/shell.js');
  supabase.rpc = async (fn, args) => {
    try {
      return { data: structuredClone(RPC[fn](args)), error: null };
    } catch (e) {
      return { data: null, error: e };
    }
  };
  supabase.from = fromMock;
  // 예산·반복 거래 예시: 식비 50만(초과 직전 상황), 통신비 매월 5일(이번 달 예정일 지남)
  const ym = new Date().toISOString().slice(0, 7);
  tables.budgets.push({ id: uuid(), ledger_id: LEDGER, account_id: acc.food, month: ym, amount: 35000 },
    { id: uuid(), ledger_id: LEDGER, account_id: acc.tax, month: ym, amount: 500000 });
  tables.recurring.push({ id: uuid(), ledger_id: LEDGER, name: '통신비', freq: 'monthly', interval_n: 1, day_of_month: 5,
    start_date: thisMonth + '05', end_date: null, next_date: thisMonth + '05', is_active: true, created_at: new Date().toISOString(),
    template: { mode: 'simple', kind: 'expense', values: { amount: '55000', expenseId: acc.food, sourceId: acc.bank1 }, memo: '통신비' } });
  setState({ user: { id: USER, email: 'mock@example.com' }, ledgers: [{ id: LEDGER, name: '모의 장부', role: 'owner' }],
    ledgerId: LEDGER, accounts, favorites: [], offlineMode: false });
  history.replaceState(null, '', '#/' + route);
  renderShell(document.getElementById('app'), {
    switchLedger: async () => {},
    reloadAccounts: async () => setState({ accounts: [...accounts] }),
    reloadFavorites: async () => setState({ favorites: structuredClone(tables.favorites.slice().sort((a, b) => a.sort_order - b.sort_order)) }),
    reloadLedgers: async () => setState({ ledgers: [{ id: LEDGER, name: ledgerName, role: 'owner' }] }),
  });
  return { acc, txns, accounts, audit, tables, restored };
}
