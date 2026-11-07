// =====================================================================
// CSV로 내보낼 표 만들기 (분개장·원장·시산표·재무제표·예산)
//   결과는 2차원 배열(첫 줄 머리글) — core/csv.js의 toCsv로 글자로 바꿉니다.
// 화면(DOM) 코드는 넣지 않습니다.
// =====================================================================

import { accountLabel, TYPE_LABELS } from './balance.js';
import { KIND_LABELS } from './journal.js';

/**
 * 분개장: 분개 라인 한 줄이 CSV 한 줄 (같은 전표는 같은 전표 번호)
 * @param {Array<{id, txn_date, memo, kind, lines}>} transactions
 * @param {Map} byId 계정 맵
 */
export function journalRows(transactions, byId) {
  const rows = [['날짜', '전표 메모', '종류', '계정', '분류', '차변', '대변', '줄 메모', '전표 번호']];
  const sorted = [...transactions].sort((a, b) => a.txn_date.localeCompare(b.txn_date) || String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')));
  for (const t of sorted) {
    for (const l of [...t.lines].sort((a, b) => (a.line_no ?? 0) - (b.line_no ?? 0))) {
      const acc = byId.get(l.account_id);
      rows.push([t.txn_date, t.memo ?? '', KIND_LABELS[t.kind] ?? t.kind, accountLabel(acc, byId),
        TYPE_LABELS[acc?.type] ?? '', l.debit || '', l.credit || '', l.memo ?? '', String(t.id).slice(0, 8)]);
    }
  }
  return rows;
}

/** 계정별 원장 (이월 → 거래 → 기말) */
export function ledgerRows(accountName, rows, opening, closing) {
  const out = [['날짜', '메모', '종류', '차변', '대변', '잔액', '상대 계정']];
  if (opening !== null && opening !== undefined) out.push(['', `${accountName} 이월`, '', '', '', opening, '']);
  for (const r of rows) {
    out.push([r.txn_date, r.memo ?? '', KIND_LABELS[r.kind] ?? r.kind, r.debit || '', r.credit || '', r.running_balance, r.counter_accounts ?? '']);
  }
  out.push(['', '기말 잔액', '', '', '', closing, '']);
  return out;
}

/** 시산표 (core/reports.js trialBalance 결과) */
export function trialRows(tb) {
  const out = [['분류', '계정', '상위 계정', '차변 합계', '대변 합계', '차변 잔액', '대변 잔액']];
  for (const g of tb.groups) {
    for (const r of g.rows) {
      out.push([TYPE_LABELS[g.type], r.name, '', r.debit, r.credit, r.debitBalance, r.creditBalance]);
      for (const c of r.children) out.push([TYPE_LABELS[g.type], c.name, r.name, c.debit, c.credit, c.debitBalance, c.creditBalance]);
    }
  }
  const t = tb.totals;
  out.push(['합계', '', '', t.debit, t.credit, t.debitBalance, t.creditBalance]);
  return out;
}

/**
 * 재무상태표·손익계산서 한 구역들 → 표
 * @param {Array<{ title, rows, total }>} sections
 * @param {string|null} compareLabel 비교 열 이름 (없으면 비교 열 없음)
 */
export function statementRows(sections, compareLabel = null) {
  const head = ['구분', '계정', '상위 계정', '금액'];
  if (compareLabel) head.push(compareLabel, '증감');
  const out = [head];
  const line = (sec, name, parent, amount, prev) =>
    out.push(compareLabel ? [sec, name, parent, amount, prev ?? 0, amount - (prev ?? 0)] : [sec, name, parent, amount]);
  for (const s of sections) {
    for (const r of s.rows) {
      line(s.title, r.name, '', r.amount, r.previous);
      for (const c of r.children) line(s.title, c.name, r.name, c.amount, c.previous);
    }
    line(s.title, `${s.title} 합계`, '', s.total.amount, s.total.previous);
  }
  return out;
}

/** 예산 (core/budget.js budgetReport 결과) */
export function budgetRows(report) {
  const out = [['계정', '예산', '사용', '남은 금액', '사용률(%)', '상태']];
  const label = { ok: '여유', warn: '주의', over: '초과' };
  for (const i of report.items) out.push([i.name, i.budget, i.spent, i.remaining, i.percent ?? '', label[i.status]]);
  const t = report.total;
  out.push(['합계', t.budget, t.spent, t.remaining, t.percent ?? '', label[t.status]]);
  return out;
}
