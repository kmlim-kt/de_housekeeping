// =====================================================================
// 분개(전표) 검증 — 화면에서 먼저 검사하는 1차 장치
// (DB의 RPC와 커밋 시점 트리거가 같은 규칙을 다시 검사합니다)
// 화면(DOM) 코드는 넣지 않습니다.
// =====================================================================

import { parseAmount, sumAmounts, formatAmount } from './money.js';

/** 전표 종류 한국어 이름 */
export const KIND_LABELS = {
  expense: '지출',
  income: '수입',
  transfer: '이체',
  card_payment: '카드대금',
  loan_repayment: '대출 상환',
  opening: '개시 잔액',
  manual: '직접 분개',
};

/** 빈 줄인지 (계정·금액 모두 비어 있음) — 검증·저장에서 무시 */
function isBlank(line) {
  return !line.accountId && !parseAmount(line.debit) && !parseAmount(line.credit);
}

/**
 * 분개 라인 검증
 * @param {Array<{accountId?: string, debit?: string|number, credit?: string|number, memo?: string}>} lines
 * @param {{ isPostable?: (accountId: string) => boolean }} [options]
 *   isPostable: 기록 가능한 계정인지 (하위 계정이 있는 상위 계정·없는 계정이면 false)
 * @returns {{
 *   ok: boolean,
 *   debitTotal: number, creditTotal: number,
 *   diff: number,               // 차변 합계 - 대변 합계
 *   count: number,              // 빈 줄을 뺀 줄 수
 *   errors: Array<{ line: number|null, message: string }>   // line: 0부터 시작하는 줄 번호
 * }}
 */
export function validateJournal(lines, { isPostable } = {}) {
  const errors = [];
  const debits = [];
  const credits = [];
  let count = 0;

  lines.forEach((line, i) => {
    if (isBlank(line)) return;
    count++;
    const n = i + 1;
    const debit = parseAmount(line.debit);
    const credit = parseAmount(line.credit);

    if (debit === null || credit === null) {
      errors.push({ line: i, message: `${n}번째 줄: 금액은 원 단위 숫자만 넣을 수 있습니다.` });
      return;
    }
    if (!line.accountId) {
      errors.push({ line: i, message: `${n}번째 줄: 계정을 고르세요.` });
    } else if (isPostable && !isPostable(line.accountId)) {
      errors.push({ line: i, message: `${n}번째 줄: 이 계정에는 기록할 수 없습니다. 하위 계정을 고르세요.` });
    }
    if (debit > 0 && credit > 0) {
      errors.push({ line: i, message: `${n}번째 줄: 차변과 대변 중 한쪽에만 금액을 넣으세요.` });
    } else if (debit === 0 && credit === 0) {
      errors.push({ line: i, message: `${n}번째 줄: 금액을 넣으세요.` });
    }
    debits.push(debit);
    credits.push(credit);
  });

  let debitTotal = 0;
  let creditTotal = 0;
  try {
    debitTotal = sumAmounts(debits);
    creditTotal = sumAmounts(credits);
  } catch (e) {
    errors.push({ line: null, message: e.message });
  }
  const diff = debitTotal - creditTotal;

  if (count < 2) {
    errors.push({ line: null, message: '분개는 2줄 이상이어야 합니다.' });
  }
  if (diff !== 0) {
    errors.push({
      line: null,
      message: `차변 합계와 대변 합계가 다릅니다. 차액 ${formatAmount(Math.abs(diff))}원 (${diff > 0 ? '대변' : '차변'}이 부족)`,
    });
  } else if (count >= 2 && debitTotal === 0) {
    errors.push({ line: null, message: '금액을 넣으세요.' });
  }

  return { ok: errors.length === 0, debitTotal, creditTotal, diff, count, errors };
}

/**
 * 저장용 라인 변환 (빈 줄 제외, 금액은 정수로)
 * 검증을 통과한 라인에만 사용하세요.
 * @returns {Array<{account_id: string, debit: number, credit: number, memo: string}>}
 */
export function toRpcLines(lines) {
  return lines
    .filter((l) => !isBlank(l))
    .map((l) => ({
      account_id: l.accountId,
      debit: parseAmount(l.debit) ?? 0,
      credit: parseAmount(l.credit) ?? 0,
      memo: (l.memo ?? '').trim().slice(0, 100),
    }));
}

/** 오늘 날짜 (기기 현지 시간 기준) "YYYY-MM-DD" */
export function todayLocal(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** "YYYY-MM-DD" 형식이고 실제로 있는 날짜인지 */
export function isValidDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d && y >= 1900 && y <= 2999;
}
