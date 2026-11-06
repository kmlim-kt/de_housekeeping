// =====================================================================
// 회계 로직(core) 단위 테스트
// 브라우저: tests.html 열기 / PC: node tools/coretest.mjs
// =====================================================================

import { parseAmount, formatAmount, sumAmounts, reformatTyping, MAX_AMOUNT } from './money.js';
import { signedBalance, buildAccountTree, postableAccounts, describeLines, indexAccounts } from './balance.js';
import { validateJournal, toRpcLines, isValidDate, todayLocal } from './journal.js';

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
