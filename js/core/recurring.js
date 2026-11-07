// =====================================================================
// 반복 거래 규칙: 다음 예정일 계산, 규칙 문장, 등록 대기 목록, 틀(template) → 분개
//   다음 예정일 계산은 DB 함수 private.next_occurrence 와 같은 규칙입니다.
//   (31일 지정 → 2월은 28/29일, 4월은 30일 / 매년 2월 29일 → 평년은 2월 28일)
// 화면(DOM) 코드는 넣지 않습니다.
// =====================================================================

import { buildSimple, SIMPLE_FORMS } from './simple.js';
import { validateJournal } from './journal.js';
import { parseAmount } from './money.js';

export const FREQ_LABELS = { monthly: '매월', weekly: '매주', yearly: '매년' };
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

const pad = (n) => String(n).padStart(2, '0');
const toStr = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const parse = (s) => s.split('-').map(Number);
const lastDay = (y, m) => new Date(y, m, 0).getDate();   // m: 1~12

/**
 * 다음 예정일
 * @param {string} date 이번 예정일 "YYYY-MM-DD"
 * @param {'weekly'|'monthly'|'yearly'} freq
 * @param {number} interval 몇 주/달/년마다
 * @param {number|null} day 매월·매년: 며칠(31 = 말일). 없으면 date의 일
 */
export function nextOccurrence(date, freq, interval = 1, day = null) {
  const [y, m, d] = parse(date);
  if (freq === 'weekly') {
    const t = new Date(y, m - 1, d + 7 * interval);
    return toStr(t.getFullYear(), t.getMonth() + 1, t.getDate());
  }
  const months = freq === 'monthly' ? interval : interval * 12;
  const base = new Date(y, m - 1 + months, 1);
  const ny = base.getFullYear();
  const nm = base.getMonth() + 1;
  return toStr(ny, nm, Math.min(day ?? d, lastDay(ny, nm)));
}

/** 처음 예정일: 시작일 이후 처음으로 규칙에 맞는 날 (매월 25일인데 시작일이 10일이면 그달 25일) */
export function firstOccurrence(startDate, freq, day = null) {
  if (freq === 'weekly' || !day) return startDate;
  const [y, m, d] = parse(startDate);
  const target = Math.min(day, lastDay(y, m));
  if (freq === 'monthly') {
    if (target >= d) return toStr(y, m, target);
    return nextOccurrence(toStr(y, m, target), 'monthly', 1, day);
  }
  // 매년: 시작일의 달 기준
  return target >= d ? toStr(y, m, target) : nextOccurrence(toStr(y, m, target), 'yearly', 1, day);
}

/**
 * 규칙을 사람이 읽는 문장으로: "매월 25일", "2개월마다 말일", "매주 금요일", "매년 3월 15일"
 * @param {{freq, interval_n, day_of_month, next_date}} r
 */
export function describeRule(r) {
  const n = r.interval_n ?? 1;
  const every = n === 1 ? FREQ_LABELS[r.freq] : `${n}${{ weekly: '주', monthly: '개월', yearly: '년' }[r.freq]}마다`;
  const [y, m, d] = parse(r.next_date);
  if (r.freq === 'weekly') return `${every} ${WEEKDAYS[new Date(y, m - 1, d).getDay()]}요일`;
  const dayText = r.day_of_month === 31 ? '말일' : `${r.day_of_month ?? d}일`;
  if (r.freq === 'yearly') return `${every} ${m}월 ${dayText}`;
  return `${every} ${dayText}`;
}

/**
 * 등록할 차례가 된 반복 거래 (예정일이 오늘 이전·당일, 활성, 종료일 전)
 * @param {Array} list recurring 행
 * @param {string} today "YYYY-MM-DD"
 */
export function dueList(list, today) {
  return list
    .filter((r) => r.is_active && r.next_date <= today && (!r.end_date || r.next_date <= r.end_date))
    .sort((a, b) => a.next_date.localeCompare(b.next_date) || a.name.localeCompare(b.name, 'ko'));
}

/**
 * 반복 거래·즐겨찾기 틀 → 분개 라인
 *   간편 틀: { mode: 'simple', kind, values, memo }
 *   분개 틀: { mode: 'advanced', kind, lines: [{account_id, debit, credit}], memo }
 * @param {object} template
 * @param {object} [override] 간편 틀의 금액 등을 이번만 바꿀 때 (예: { amount: 52000 })
 * @returns {{ ok: boolean, errors: string[], lines: Array, total: number, kind: string }}
 */
export function templateLines(template, override = {}) {
  if (template?.mode === 'simple' && SIMPLE_FORMS[template.kind]) {
    const r = buildSimple(template.kind, { ...template.values, ...override });
    return { ...r, kind: template.kind };
  }
  if (template?.mode === 'advanced' && Array.isArray(template.lines)) {
    const lines = template.lines.map((l) => ({
      account_id: l.account_id, debit: parseAmount(l.debit) ?? 0, credit: parseAmount(l.credit) ?? 0, memo: l.memo ?? '' }));
    const v = validateJournal(lines.map((l) => ({ accountId: l.account_id, debit: l.debit, credit: l.credit })));
    return { ok: v.ok, errors: v.errors.map((e) => e.message), lines: v.ok ? lines : [], total: v.debitTotal,
      kind: template.kind ?? 'manual' };
  }
  return { ok: false, errors: ['반복 거래 내용이 올바르지 않습니다. 다시 저장해 주세요.'], lines: [], total: 0, kind: 'manual' };
}

/** 간편 틀의 금액(들) — 표시·수정용 */
export function templateAmount(template) {
  if (template?.mode === 'simple') {
    const spec = SIMPLE_FORMS[template.kind];
    return spec ? spec.amounts.reduce((s, { key }) => s + (parseAmount(template.values?.[key]) ?? 0), 0) : 0;
  }
  return (template?.lines ?? []).reduce((s, l) => s + (parseAmount(l.debit) ?? 0), 0);
}
