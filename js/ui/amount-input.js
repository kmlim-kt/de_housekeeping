// =====================================================================
// 금액 입력란: 숫자 키패드(inputmode="numeric") + 입력 중 천 단위 쉼표 자동 표시
// =====================================================================

import { h, toast } from './dom.js';
import { parseAmount, formatAmount, reformatTyping } from '../core/money.js';

/**
 * @param {{ value?: number, label?: string, placeholder?: string, id?: string,
 *           onChange?: (amount: number|null, text: string) => void,
 *           onReject?: (message: string) => void }} opts
 *   onReject: 숫자가 아닌 내용을 붙여넣으려 할 때 (기본: 화면 아래 알림)
 * @returns {HTMLInputElement & { amount: number|null, setAmount: (n: number) => void }}
 */
export function amountInput({ value = 0, label = '금액', placeholder = '0', onChange, id, onReject = (m) => toast(m, { type: 'error' }) } = {}) {
  const input = h('input', {
    type: 'text',
    inputmode: 'numeric',
    autocomplete: 'off',
    enterkeyhint: 'done',
    class: 'amount',
    placeholder,
    'aria-label': label,
    id,
    value: value ? formatAmount(value) : '',
  });

  // 숫자·쉼표 외의 글자(소수점, 문자, 음수 기호)는 아예 입력되지 않게 막음
  // (점만 빠지면 1000.5가 10,005로 바뀌는 사고가 나므로 지우지 않고 거부)
  input.addEventListener('beforeinput', (e) => {
    if (e.data && /[^\d,\s]/.test(e.data)) {
      e.preventDefault();
      // 막힌 것을 바로 알아차리도록 안내 (점을 무시한 채 계속 치면 금액이 달라지므로)
      onReject?.('금액은 원 단위 정수만 입력할 수 있습니다. (소수점·문자 불가)');
    }
  });
  input.addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text') ?? '';
    if (/[^\d,\s원]/.test(text.trim())) {
      e.preventDefault();
      onReject?.('금액은 원 단위 숫자만 붙여넣을 수 있습니다.');
    }
  });

  input.addEventListener('input', () => {
    const { text, caret } = reformatTyping(input.value, input.selectionStart ?? input.value.length);
    input.value = text;
    try {
      input.setSelectionRange(caret, caret);
    } catch {
      /* 일부 브라우저는 포커스가 없으면 오류 — 무시 */
    }
    onChange?.(parseAmount(text), text);
  });

  Object.defineProperty(input, 'amount', { get: () => parseAmount(input.value) });
  input.setAmount = (n) => {
    input.value = n ? formatAmount(n) : '';
  };
  return input;
}
