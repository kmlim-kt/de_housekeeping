// =====================================================================
// 금액 처리 — 원 단위 정수만 사용 (부동소수점 계산 금지)
//
// JavaScript Number는 2^53(약 9,007조)까지 정수를 정확히 표현합니다.
// DB 제약(한 줄 최대 1,000조 원)과 같게 제한하고, 합계가 안전 범위를 넘으면 오류를 냅니다.
// 화면(DOM) 코드는 넣지 않습니다.
// =====================================================================

/** 한 줄에 넣을 수 있는 최대 금액 (DB의 CHECK 제약과 같음) */
export const MAX_AMOUNT = 1_000_000_000_000_000;

/**
 * 입력값을 원 단위 정수로 바꿉니다.
 * - 쉼표·공백·'원'은 무시합니다. 빈 값은 0입니다.
 * - 소수, 음수, 문자, 최대 금액 초과는 null(잘못된 입력)입니다.
 * @param {string|number|null|undefined} input
 * @returns {number|null}
 */
export function parseAmount(input) {
  if (typeof input === 'number') {
    return Number.isSafeInteger(input) && input >= 0 && input <= MAX_AMOUNT ? input : null;
  }
  const s = String(input ?? '').replace(/[,\s원]/g, '');
  if (s === '') return 0;
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n <= MAX_AMOUNT ? n : null;
}

/**
 * 천 단위 쉼표 표시. 예: 1234567 → "1,234,567", -30000 → "-30,000"
 * @param {number} n 정수
 */
export function formatAmount(n) {
  if (!Number.isFinite(n)) return '';
  const sign = n < 0 ? '-' : '';
  return sign + String(Math.abs(Math.trunc(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * 그래프 축용 짧은 표시: 9,000 / 35만 / 1,250만 / 1.2억 / -350만
 * @param {number} n 정수
 */
export function formatCompact(n) {
  const sign = n < 0 ? '-' : '';
  const a = Math.abs(n);
  if (a >= 100_000_000) {
    const v = Math.round(a / 10_000_000) / 10;   // 억 단위 소수 첫째 자리
    return sign + String(v).replace(/\.0$/, '') + '억';
  }
  if (a >= 10_000) return sign + formatAmount(Math.round(a / 10_000)) + '만';
  return sign + formatAmount(a);
}

/** "30,000원" 형식 */
export function formatWon(n) {
  return formatAmount(n) + '원';
}

/**
 * 정수 배열 합계. 안전 범위를 넘으면 오류.
 * @param {number[]} values
 */
export function sumAmounts(values) {
  let total = 0;
  for (const v of values) {
    total += v;
    if (!Number.isSafeInteger(total)) throw new RangeError('합계 금액이 너무 큽니다.');
  }
  return total;
}

/**
 * 입력 중인 문자열을 쉼표 형식으로 다시 쓰고, 커서 위치를 숫자 기준으로 보정합니다.
 * (입력란 UI가 사용하지만 계산만 하므로 core에 둡니다)
 * @param {string} raw 현재 입력란 값
 * @param {number} caret 현재 커서 위치
 * @returns {{ text: string, caret: number }}
 */
export function reformatTyping(raw, caret) {
  const digitsBeforeCaret = raw.slice(0, caret).replace(/\D/g, '').replace(/^0+(?=\d)/, '').length;
  const digits = raw.replace(/\D/g, '').replace(/^0+(?=\d)/, '').slice(0, 16);
  // Number로 바꾸지 않고 문자열 그대로 쉼표를 넣음 (아주 큰 수의 정밀도 손실 방지)
  const text = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  // 포맷된 문자열에서 같은 개수의 숫자 뒤로 커서 이동
  let seen = 0;
  let pos = 0;
  while (pos < text.length && seen < digitsBeforeCaret) {
    if (/\d/.test(text[pos])) seen++;
    pos++;
  }
  return { text, caret: pos };
}
