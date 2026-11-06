// =====================================================================
// 회계 로직(core) 단위 테스트
// 브라우저: tests.html 열기 / PC: node tools/coretest.mjs
// =====================================================================

import { parseAmount, formatAmount, sumAmounts, reformatTyping, MAX_AMOUNT } from './money.js';
import { signedBalance, buildAccountTree, postableAccounts, describeLines, indexAccounts } from './balance.js';
import { validateJournal, toRpcLines, isValidDate, todayLocal } from './journal.js';
import { buildSimple, buildOpening, sortByRecent, mostRecentId, defaultChoice, SIMPLE_FORMS } from './simple.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function eq(actual, expected, label = '') {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label} 기대 ${e}, 실제 ${a}`);
}

// ---------------------------------------------------------------------
// 금액
// ---------------------------------------------------------------------
test('금액: 쉼표·원·공백 무시, 빈 값은 0', () => {
  eq(parseAmount('30,000'), 30000);
  eq(parseAmount(' 1,234원 '), 1234);
  eq(parseAmount(''), 0);
  eq(parseAmount(null), 0);
});
test('금액: 소수·음수·문자·초과는 거부(null)', () => {
  eq(parseAmount('1000.5'), null);
  eq(parseAmount('-500'), null);
  eq(parseAmount('12a'), null);
  eq(parseAmount(1.5), null);
  eq(parseAmount(String(MAX_AMOUNT + 1)), null);
  eq(parseAmount(String(MAX_AMOUNT)), MAX_AMOUNT);
});
test('금액: 천 단위 쉼표 표시', () => {
  eq(formatAmount(0), '0');
  eq(formatAmount(1234567), '1,234,567');
  eq(formatAmount(-30000), '-30,000');
});
test('금액: 합계가 안전 범위를 넘으면 오류', () => {
  eq(sumAmounts([1, 2, 3]), 6);
  let threw = false;
  try { sumAmounts([Number.MAX_SAFE_INTEGER, 1]); } catch { threw = true; }
  eq(threw, true);
});
test('금액 입력: 타이핑 중 쉼표와 커서 위치', () => {
  eq(reformatTyping('1234', 4), { text: '1,234', caret: 5 });
  eq(reformatTyping('1,2345', 6), { text: '12,345', caret: 6 });
  eq(reformatTyping('12,345', 1), { text: '12,345', caret: 1 });   // 맨 앞 숫자 뒤
  eq(reformatTyping('0012', 4), { text: '12', caret: 2 });          // 앞의 0 제거
  eq(reformatTyping('abc', 3), { text: '', caret: 0 });
});

// ---------------------------------------------------------------------
// 잔액 부호 규칙
// ---------------------------------------------------------------------
test('잔액: 자산·비용은 차변(+), 부채·순자산·수익은 대변(+)', () => {
  eq(signedBalance('asset', 100, 30), 70);
  eq(signedBalance('expense', 30000, 0), 30000);
  eq(signedBalance('liability', 330000, 300000), -30000);
  eq(signedBalance('liability', 0, 300000), 300000);
  eq(signedBalance('equity', 0, 1800000), 1800000);
  eq(signedBalance('income', 0, 3300000), 3300000);
});

// ---------------------------------------------------------------------
// 계정 트리
// ---------------------------------------------------------------------
const ACCS = [
  { id: 'cash', name: '현금', type: 'asset', parent_id: null, sort_order: 10, is_hidden: false },
  { id: 'bank', name: '보통예금', type: 'asset', parent_id: null, sort_order: 20, is_hidden: false },
  { id: 'bank1', name: '주거래 통장', type: 'asset', parent_id: 'bank', sort_order: 21, is_hidden: false },
  { id: 'old', name: '안 쓰는 통장', type: 'asset', parent_id: 'bank', sort_order: 22, is_hidden: true },
  { id: 'card', name: '신용카드', type: 'liability', parent_id: null, sort_order: 110, is_hidden: false },
  { id: 'card1', name: '주 사용 카드', type: 'liability', parent_id: 'card', sort_order: 111, is_hidden: false },
  { id: 'food', name: '식비', type: 'expense', parent_id: null, sort_order: 410, is_hidden: false },
];

test('계정: 분류별 2단계 트리', () => {
  const tree = buildAccountTree(ACCS);
  eq(tree.asset.map((a) => a.name), ['현금', '보통예금']);
  eq(tree.asset[1].children.map((a) => a.name), ['주거래 통장', '안 쓰는 통장']);
  eq(tree.equity, []);
});
test('계정: 기록 가능한 계정 = 하위 없는 계정, 숨김 제외, "상위 > 하위" 표시', () => {
  const list = postableAccounts(ACCS);
  eq(list.map((a) => a.label), ['현금', '보통예금 > 주거래 통장', '신용카드 > 주 사용 카드', '식비']);
  eq(postableAccounts(ACCS, { includeHidden: true }).length, 5);
});
test('계정: 분개 미리보기 문장', () => {
  const byId = indexAccounts(ACCS);
  eq(describeLines([{ account_id: 'food', debit: 30000, credit: 0 }, { account_id: 'card1', debit: 0, credit: 30000 }], byId),
     '차변 식비 30,000 / 대변 신용카드 > 주 사용 카드 30,000');
});

// ---------------------------------------------------------------------
// 분개 검증
// ---------------------------------------------------------------------
const postable = new Set(postableAccounts(ACCS, { includeHidden: true }).map((a) => a.id));
const isPostable = (id) => postable.has(id);

test('분개: 차대 일치하면 통과', () => {
  const r = validateJournal([
    { accountId: 'food', debit: '30,000' },
    { accountId: 'card1', credit: '30000' },
  ], { isPostable });
  eq([r.ok, r.debitTotal, r.creditTotal, r.diff, r.count], [true, 30000, 30000, 0, 2]);
});
test('분개: 개시 잔액 4줄 (자산 = 부채 + 기초 순자산)', () => {
  const r = validateJournal([
    { accountId: 'cash', debit: 100000 },
    { accountId: 'bank1', debit: 2000000 },
    { accountId: 'card1', credit: 300000 },
    { accountId: 'food', credit: 1800000 },  // (테스트용: 계정 종류는 검사 대상 아님)
  ], { isPostable });
  eq(r.ok, true);
});
test('분개: 차액이 있으면 실패하고 차액 표시', () => {
  const r = validateJournal([
    { accountId: 'food', debit: 30000 },
    { accountId: 'cash', credit: 29000 },
  ], { isPostable });
  eq([r.ok, r.diff], [false, 1000]);
  eq(r.errors.some((e) => e.message.includes('차액 1,000원')), true);
});
test('분개: 빈 줄은 무시, 1줄이면 실패', () => {
  const r = validateJournal([{ accountId: 'food', debit: 1000 }, {}, { accountId: '', debit: '', credit: '' }]);
  eq([r.ok, r.count], [false, 1]);
  eq(r.errors.some((e) => e.message.includes('2줄 이상')), true);
});
test('분개: 한 줄에 차변·대변 동시 입력 / 금액 없음 / 계정 없음 / 소수 금액은 실패', () => {
  const both = validateJournal([{ accountId: 'food', debit: 1000, credit: 1000 }, { accountId: 'cash', credit: 0 }]);
  eq(both.errors.some((e) => e.line === 0 && e.message.includes('한쪽에만')), true);
  eq(both.errors.some((e) => e.line === 1 && e.message.includes('금액을 넣으세요')), true);
  const noAcc = validateJournal([{ debit: 1000 }, { accountId: 'cash', credit: 1000 }]);
  eq(noAcc.errors.some((e) => e.line === 0 && e.message.includes('계정을 고르세요')), true);
  const decimal = validateJournal([{ accountId: 'food', debit: '1000.5' }, { accountId: 'cash', credit: '1000.5' }]);
  eq(decimal.ok, false);
});
test('분개: 하위 계정이 있는 상위 계정(보통예금)에는 기록 불가', () => {
  const r = validateJournal([{ accountId: 'food', debit: 1000 }, { accountId: 'bank', credit: 1000 }], { isPostable });
  eq(r.errors.some((e) => e.line === 1 && e.message.includes('하위 계정')), true);
});
test('분개: 저장용 변환은 빈 줄 제외·정수화', () => {
  eq(toRpcLines([{ accountId: 'food', debit: '30,000', memo: ' 점심 ' }, {}, { accountId: 'cash', credit: '30000' }]), [
    { account_id: 'food', debit: 30000, credit: 0, memo: '점심' },
    { account_id: 'cash', debit: 0, credit: 30000, memo: '' },
  ]);
});
test('날짜: 형식·실제 날짜 검사, 오늘 날짜는 현지 기준', () => {
  eq(isValidDate('2026-02-28'), true);
  eq(isValidDate('2026-02-30'), false);
  eq(isValidDate('2026-1-5'), false);
  eq(todayLocal(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
});

// ---------------------------------------------------------------------
// 간편 입력 → 분개
// ---------------------------------------------------------------------
const ACCS2 = [
  ...ACCS,
  { id: 'open', name: '기초 순자산', type: 'equity', subtype: 'opening', parent_id: null, sort_order: 210 },
  { id: 'salary', name: '급여', type: 'income', parent_id: null, sort_order: 310 },
  { id: 'loan', name: '대출', type: 'liability', subtype: 'loan', parent_id: null, sort_order: 120 },
  { id: 'interest', name: '대출이자', type: 'expense', parent_id: null, sort_order: 500 },
  { id: 'savings', name: '적금', type: 'asset', subtype: 'savings', parent_id: null, sort_order: 30 },
].map((a) => ({ subtype: null, is_hidden: false, ...a }));
ACCS2.find((a) => a.id === 'cash').subtype = 'cash';
for (const id of ['bank', 'bank1', 'old']) ACCS2.find((a) => a.id === id).subtype = 'bank';
for (const id of ['card', 'card1']) ACCS2.find((a) => a.id === id).subtype = 'card';

const balanced = (lines) => validateJournal(lines.map((l) => ({ accountId: l.account_id, debit: l.debit, credit: l.credit }))).ok;

test('간편 지출: 카드로 식비 3만 원 → 차변 식비 / 대변 카드', () => {
  const r = buildSimple('expense', { amount: '30,000', expenseId: 'food', sourceId: 'card1' });
  eq(r.lines, [{ account_id: 'food', debit: 30000, credit: 0 }, { account_id: 'card1', debit: 0, credit: 30000 }]);
  eq(balanced(r.lines), true);
});
test('간편 수입: 급여 → 차변 통장 / 대변 급여', () => {
  const r = buildSimple('income', { amount: 3000000, incomeId: 'salary', depositId: 'bank1' });
  eq(r.lines, [{ account_id: 'bank1', debit: 3000000, credit: 0 }, { account_id: 'salary', debit: 0, credit: 3000000 }]);
});
test('간편 이체: 통장 → 적금 (차변 적금 / 대변 통장), 같은 계좌는 거부', () => {
  const r = buildSimple('transfer', { amount: 500000, fromId: 'bank1', toId: 'savings' });
  eq(r.lines, [{ account_id: 'savings', debit: 500000, credit: 0 }, { account_id: 'bank1', debit: 0, credit: 500000 }]);
  eq(buildSimple('transfer', { amount: 1, fromId: 'bank1', toId: 'bank1' }).ok, false);
});
test('간편 카드대금: 차변 카드(부채 감소) / 대변 통장', () => {
  const r = buildSimple('card_payment', { amount: 330000, cardId: 'card1', fromId: 'bank1' });
  eq(r.lines, [{ account_id: 'card1', debit: 330000, credit: 0 }, { account_id: 'bank1', debit: 0, credit: 330000 }]);
});
test('간편 대출 상환: 원금 50만 + 이자 5만 → 차변 대출·이자 / 대변 통장 55만', () => {
  const r = buildSimple('loan_repayment', { principal: '500,000', interest: '50,000', loanId: 'loan', interestId: 'interest', fromId: 'bank1' });
  eq(r.lines, [
    { account_id: 'loan', debit: 500000, credit: 0 },
    { account_id: 'interest', debit: 50000, credit: 0 },
    { account_id: 'bank1', debit: 0, credit: 550000 },
  ]);
  eq(balanced(r.lines), true);
  // 이자만 낸 달: 원금 줄 없음
  const onlyInterest = buildSimple('loan_repayment', { principal: '', interest: 50000, loanId: 'loan', interestId: 'interest', fromId: 'bank1' });
  eq(onlyInterest.lines.length, 2);
});
test('간편 입력: 금액·계정 누락, 소수 금액은 실패', () => {
  eq(buildSimple('expense', { amount: '', expenseId: 'food', sourceId: 'cash' }).ok, false);
  eq(buildSimple('expense', { amount: 1000, expenseId: 'food' }).ok, false);
  eq(buildSimple('expense', { amount: '1000.5', expenseId: 'food', sourceId: 'cash' }).ok, false);
});
test('간편 입력 선택지: 지출 결제수단 = 현금·통장·카드 (적금·대출 제외)', () => {
  const opts = postableAccounts(ACCS2).filter((o) => SIMPLE_FORMS.expense.pickers[1].filter(o.account)).map((o) => o.id);
  eq(opts, ['cash', 'bank1', 'card1']);
  const loans = postableAccounts(ACCS2).filter((o) => SIMPLE_FORMS.loan_repayment.pickers[0].filter(o.account)).map((o) => o.id);
  eq(loans, ['loan']);
});

// ---------------------------------------------------------------------
// 개시 잔액
// ---------------------------------------------------------------------
test('개시 잔액: 현금 10만 + 통장 200만 − 카드 30만 → 기초 순자산 180만 (대변)', () => {
  const byId = indexAccounts(ACCS2);
  const r = buildOpening([
    { accountId: 'cash', amount: '100,000' }, { accountId: 'bank1', amount: 2000000 },
    { accountId: 'card1', amount: 300000 }, { accountId: 'savings', amount: '' },
  ], 'open', byId);
  eq([r.ok, r.assets, r.liabilities, r.netWorth], [true, 2100000, 300000, 1800000]);
  eq(r.lines.at(-1), { account_id: 'open', debit: 0, credit: 1800000 });
  eq(r.lines.length, 4);   // 0원 계정은 제외
  eq(balanced(r.lines), true);
});
test('개시 잔액: 부채가 더 많으면 기초 순자산이 차변', () => {
  const r = buildOpening([{ accountId: 'cash', amount: 100 }, { accountId: 'loan', amount: 1000 }], 'open', indexAccounts(ACCS2));
  eq([r.netWorth, r.lines.at(-1)], [-900, { account_id: 'open', debit: 900, credit: 0 }]);
  eq(balanced(r.lines), true);
});
test('개시 잔액: 모두 0이면 실패', () => {
  eq(buildOpening([{ accountId: 'cash', amount: '' }], 'open', indexAccounts(ACCS2)).ok, false);
});

// ---------------------------------------------------------------------
// 최근 사용 순서
// ---------------------------------------------------------------------
test('최근 사용: 최근에 쓴 계정이 앞으로, 나머지는 원래 순서', () => {
  const opts = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  eq(sortByRecent(opts, { c: 200, a: 100 }).map((o) => o.id), ['c', 'a', 'b', 'd']);
  eq(mostRecentId(opts, {}), 'a');
  eq(mostRecentId(opts, { d: 5 }), 'd');
});
test('기본 선택: 결제수단은 최근 사용, 이자는 "대출이자" 우선, 비용 항목은 선택 안 함', () => {
  const all = postableAccounts(ACCS2);
  const pick = (kind, key) => SIMPLE_FORMS[kind].pickers.find((p) => p.key === key);
  const optsFor = (p) => all.filter((o) => p.filter(o.account));
  const recent = { food: 300, card1: 200 };
  eq(defaultChoice(pick('expense', 'sourceId'), optsFor(pick('expense', 'sourceId')), recent), 'card1');
  eq(defaultChoice(pick('expense', 'expenseId'), optsFor(pick('expense', 'expenseId')), recent), '');
  eq(defaultChoice(pick('loan_repayment', 'interestId'), optsFor(pick('loan_repayment', 'interestId')), recent), 'interest');
});

/** 모든 테스트 실행 → [{name, ok, error}] */
export function runTests() {
  return tests.map(({ name, fn }) => {
    try {
      fn();
      return { name, ok: true };
    } catch (e) {
      return { name, ok: false, error: e.message };
    }
  });
}
