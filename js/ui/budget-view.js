// =====================================================================
// 예산 표시 부품: 사용률 막대(meter) + 상태(아이콘·글자·색 함께)
// =====================================================================

import { h } from './dom.js';
import { formatAmount } from '../core/money.js';
import { BUDGET_STATUS } from '../core/budget.js';

const ICON = { ok: '✔', warn: '⚠', over: '⛔' };

/** 상태 표시 (색만으로 구분하지 않도록 아이콘·글자 함께) */
export function statusBadge(status) {
  return h('span', { class: `badge status-${status}` }, `${ICON[status]} ${BUDGET_STATUS[status]}`);
}

/**
 * 예산 사용률 막대
 * @param {{ budget, spent, percent, status }} f
 */
export function meter(f) {
  const width = f.budget > 0 ? Math.min(100, (f.spent / f.budget) * 100) : 0;
  return h('div', {
    class: 'meter', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': String(f.budget),
    'aria-valuenow': String(Math.max(0, f.spent)), 'aria-label': `예산 ${formatAmount(f.budget)}원 중 ${formatAmount(f.spent)}원 사용`,
  }, h('div', { class: `meter-fill status-${f.status}`, style: `width:${Math.max(0, width)}%` }));
}

/** "35만 원 남음" / "4만 원 초과" */
export function remainingText(f) {
  return f.remaining >= 0 ? `${formatAmount(f.remaining)}원 남음` : `${formatAmount(-f.remaining)}원 초과`;
}
