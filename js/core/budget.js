// =====================================================================
// 예산 계산: 비용 계정별 월 예산 대비 지출
//   상위 계정에 예산을 두면 하위 계정 지출을 합산해 비교합니다.
//   상위·하위 모두 예산이 있으면 합계에서는 상위만 셉니다(이중 계산 방지).
// 화면(DOM) 코드는 넣지 않습니다.
// =====================================================================

import { sumAmounts } from './money.js';
import { accountRank } from './balance.js';

/** 사용률이 이 비율(%) 이상이면 "주의" */
export const WARN_PERCENT = 80;

/** 상태 이름 */
export const BUDGET_STATUS = {
  ok: '여유',
  warn: '주의',
  over: '초과',
};

/**
 * 예산 대비 지출
 * @param {Array<{account_id: string, amount: number}>} budgets 그 달의 예산
 * @param {Array<{account_id, type, parent_id, debit_total, credit_total}>} rows account_balances(그 달 1일, 말일)
 * @param {Array<{id, name, parent_id, sort_order}>} accounts 계정과목
 * @returns {{
 *   items: Array<{ accountId, name, parentId, budget, spent, remaining, percent, status }>,
 *   total: { budget, spent, remaining, percent, status },
 *   unbudgeted: number,   // 예산을 정하지 않은 비용 계정의 지출
 *   totalExpense: number  // 그 달 전체 비용
 * }}
 */
export function budgetReport(budgets, rows, accounts) {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const rank = accountRank(accounts);
  const spentOwn = new Map();
  for (const r of rows) {
    if (r.type === 'expense') spentOwn.set(r.account_id, r.debit_total - r.credit_total);
  }
  // 상위 계정이면 하위 지출 합산
  const spentOf = (id) => sumAmounts([
    spentOwn.get(id) ?? 0,
    ...accounts.filter((a) => a.parent_id === id).map((a) => spentOwn.get(a.id) ?? 0),
  ]);

  const budgeted = new Map(budgets.filter((b) => b.amount > 0).map((b) => [b.account_id, b.amount]));
  const items = [...budgeted.entries()]
    .filter(([id]) => byId.has(id))
    .map(([id, budget]) => {
      const acc = byId.get(id);
      const spent = spentOf(id);
      return { accountId: id, name: acc.name, parentId: acc.parent_id, ...figures(budget, spent) };
    })
    // 계정과목 화면과 같은 순서 (상위 → 그 하위 → 다음 상위)
    .sort((a, b) => (rank.get(a.accountId) ?? 1e9) - (rank.get(b.accountId) ?? 1e9));

  // 합계: 상위 계정에도 예산이 있는 하위 계정은 제외
  const counted = items.filter((i) => !(i.parentId && budgeted.has(i.parentId)));
  const totalBudget = sumAmounts(counted.map((i) => i.budget));
  const totalSpent = sumAmounts(counted.map((i) => i.spent));

  // 예산 범위에 들어가는 계정(예산 계정 + 예산 있는 상위의 하위)
  const covered = new Set();
  for (const i of counted) {
    covered.add(i.accountId);
    for (const a of accounts) if (a.parent_id === i.accountId) covered.add(a.id);
  }
  const totalExpense = sumAmounts([...spentOwn.values()]);
  const unbudgeted = sumAmounts([...spentOwn.entries()].filter(([id]) => !covered.has(id)).map(([, v]) => v));

  return { items, total: figures(totalBudget, totalSpent), unbudgeted, totalExpense };
}

/** 예산·지출 → 남은 금액, 사용률(%), 상태 */
export function figures(budget, spent) {
  const percent = budget > 0 ? Math.round((spent / budget) * 1000) / 10 : null;
  let status = 'ok';
  if (budget > 0 && spent > budget) status = 'over';
  else if (percent !== null && percent >= WARN_PERCENT) status = 'warn';
  return { budget, spent, remaining: budget - spent, percent, status };
}
