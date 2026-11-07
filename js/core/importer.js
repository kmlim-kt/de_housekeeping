// =====================================================================
// 은행·카드 내역 가져오기: 머리글·열 추측, 날짜·금액 읽기, 거래 목록 만들기,
// 항목 자동 추천(예전에 고른 항목), 중복 찾기, 분개 만들기
// 화면(DOM) 코드는 넣지 않습니다.
// =====================================================================

import { parseAmount } from './money.js';
import { isValidDate } from './journal.js';

/** 금액 열을 읽는 방식 */
export const AMOUNT_MODES = {
  split: '출금·입금 열이 따로 있음 (통장)',
  card: '금액 열 하나 — 양수가 쓴 돈 (카드 명세서)',
  signed: '금액 열 하나 — 음수가 나간 돈 (통장)',
};

const KEYWORDS = {
  date: /(거래|이용|승인|결제|사용)?\s*(일자|일시|날짜|날자|년월일)|^date$|거래일|이용일|승인일/i,
  memo: /(가맹점|이용처|적요|내용|기재|거래처|상호|메모|받는\s*분|보낸\s*분|사용처|description|merchant)/i,
  out: /(출금|찾으신|지급|인출|withdraw)/i,
  in: /(입금|맡기신|deposit)/i,
  amount: /(금액|이용\s*금액|승인\s*금액|결제\s*금액|amount)/i,
};

/**
 * 머리글 줄 찾기: 위에서부터 20줄 중 날짜·금액 계열 낱말이 가장 많이 들어 있는 줄
 * @param {string[][]} rows
 * @returns {number} 줄 번호 (못 찾으면 0)
 */
export function guessHeaderRow(rows) {
  let best = 0;
  let bestScore = -1;
  rows.slice(0, 20).forEach((r, i) => {
    const score = r.reduce((s, c) => s + Object.values(KEYWORDS).filter((re) => re.test(c)).length, 0);
    if (score > bestScore) { best = i; bestScore = score; }
  });
  return best;
}

/**
 * 열 추측
 * @param {string[]} header
 * @returns {{ date: number, memo: number, out: number, in: number, amount: number, mode: string }} 없으면 -1
 */
export function guessMapping(header) {
  const find = (re, skip = []) => header.findIndex((c, i) => !skip.includes(i) && re.test(c));
  const date = find(KEYWORDS.date);
  const memo = find(KEYWORDS.memo, [date]);
  const out = find(KEYWORDS.out, [date, memo]);
  const inn = find(KEYWORDS.in, [date, memo, out]);
  const amount = find(KEYWORDS.amount, [date, memo, out, inn]);
  const mode = out >= 0 || inn >= 0 ? 'split' : 'card';
  return { date, memo, out, in: inn, amount, mode };
}

/**
 * 날짜 읽기: 2026-11-07, 2026.11.07, 2026/11/07, 20261107, 26.11.07, 2026년 11월 7일,
 * "2026-11-07 13:45"(시각 무시), 엑셀 날짜 숫자(45963 등)
 * @returns {string|null} "YYYY-MM-DD"
 */
export function parseDate(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' && v > 20000 && v < 80000) return excelSerial(v);
  const s = String(v).trim();
  if (/^\d{5}(\.\d+)?$/.test(s) && Number(s) > 20000 && Number(s) < 80000) return excelSerial(Number(s));
  let m = s.match(/^(\d{4})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})/);
  if (!m) m = s.match(/^(\d{4})(\d{2})(\d{2})(?!\d)/);
  if (!m) {
    const y2 = s.match(/^(\d{2})[-./](\d{1,2})[-./](\d{1,2})(?!\d)/);
    if (y2) m = [y2[0], String(2000 + Number(y2[1])), y2[2], y2[3]];
  }
  if (!m) return null;
  const out = `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  return isValidDate(out) ? out : null;
}

function excelSerial(n) {
  // 엑셀 1900 날짜 체계 (1899-12-30 기준)
  const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/**
 * 금액 읽기: "1,234", "-1,234", "(1,234)", "1,234원", "₩1,234", "1234.00"
 * @returns {number|null} 부호 있는 정수 (빈칸·0이면 0, 읽을 수 없으면 null)
 */
export function parseMoney(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v) : null;
  let s = String(v).trim().replace(/[₩원\s]/g, '').replace(/,/g, '');
  if (s === '' || s === '-') return 0;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (s.startsWith('-')) { neg = true; s = s.slice(1); }
  if (s.startsWith('+')) s = s.slice(1);
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Math.round(Number(s));
  return neg ? -n : n;
}

/**
 * 표 → 가져올 거래 목록
 * @param {string[][]} rows 전체 줄
 * @param {number} headerRow 머리글 줄 번호
 * @param {{ date, memo, out, in, amount, mode }} map 열 번호와 금액 방식
 * @returns {{ entries: Array<{ row: number, date: string, memo: string, amount: number, direction: 'out'|'in' }>,
 *             skipped: Array<{ row: number, reason: string }> }}
 *   amount는 항상 양수, direction: out = 나간 돈(지출·카드 사용), in = 들어온 돈(입금·환불)
 */
export function buildEntries(rows, headerRow, map) {
  const entries = [];
  const skipped = [];
  rows.slice(headerRow + 1).forEach((r, idx) => {
    const row = headerRow + 2 + idx;   // 사람이 보는 줄 번호(1부터)
    const date = parseDate(r[map.date]);
    if (!date) { skipped.push({ row, reason: '날짜를 읽을 수 없음' }); return; }
    let signed;
    if (map.mode === 'split') {
      const out = parseMoney(r[map.out] ?? '');
      const inn = parseMoney(r[map.in] ?? '');
      if (out === null || inn === null) { skipped.push({ row, reason: '금액을 읽을 수 없음' }); return; }
      signed = (inn || 0) - Math.abs(out || 0);
    } else {
      const a = parseMoney(r[map.amount] ?? '');
      if (a === null) { skipped.push({ row, reason: '금액을 읽을 수 없음' }); return; }
      signed = map.mode === 'card' ? -a : a;   // 카드: 양수 = 쓴 돈
    }
    if (!signed) { skipped.push({ row, reason: '금액 0' }); return; }
    entries.push({
      row, date,
      memo: String(r[map.memo] ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
      amount: Math.abs(signed),
      direction: signed < 0 ? 'out' : 'in',
    });
  });
  return { entries, skipped };
}

/** 자동 추천용 내용 정리: 공백·숫자·괄호 내용 제거, 소문자 */
export function normalizeMemo(memo) {
  return String(memo ?? '').toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, '')
    .replace(/[0-9*#\-_./:,]/g, '')   // 승인번호·날짜(12/03)·시각 등은 빼고 가맹점 이름만
    .replace(/\s+/g, '')
    .slice(0, 30);
}

/**
 * 항목 추천: 예전에 같은 내용(가맹점)에 고른 계정 → 없으면 기본 계정
 * @param {{memo, direction}} entry
 * @param {Record<string, string>} rules 정리한 내용 → 계정 id (방향별 키: "out:스타벅스")
 * @param {{ out: string, in: string }} defaults
 */
export function suggestAccount(entry, rules, defaults) {
  const key = `${entry.direction}:${normalizeMemo(entry.memo)}`;
  return (normalizeMemo(entry.memo) && rules[key]) || defaults[entry.direction] || '';
}

/** 가져오기에서 고른 항목을 다음 추천에 쓰도록 기록 */
export function learnRules(rules, entries) {
  const next = { ...rules };
  for (const e of entries) {
    const n = normalizeMemo(e.memo);
    if (n && e.accountId) next[`${e.direction}:${n}`] = e.accountId;
  }
  return next;
}

/**
 * 중복 찾기: 이미 장부에 같은 날짜·같은 금액·같은 계정 거래가 있으면 중복으로 봄
 *   (같은 날 같은 금액이 여러 번이면 그 개수만큼만 중복 처리)
 * @param {Array<{date, amount}>} entries
 * @param {Array<{txn_date, lines}>} existing 같은 기간, 그 계정이 들어간 기존 전표
 * @param {string} fileAccountId 파일의 계좌·카드 계정
 * @returns {Set<number>} 중복인 entries의 순서 번호
 */
export function findDuplicates(entries, existing, fileAccountId) {
  const pool = new Map();
  for (const t of existing) {
    for (const l of t.lines) {
      if (l.account_id !== fileAccountId) continue;
      const key = `${t.txn_date}|${l.debit || l.credit}`;
      pool.set(key, (pool.get(key) ?? 0) + 1);
    }
  }
  const dup = new Set();
  entries.forEach((e, i) => {
    const key = `${e.date}|${e.amount}`;
    if (pool.get(key) > 0) { dup.add(i); pool.set(key, pool.get(key) - 1); }
  });
  return dup;
}

/**
 * 거래 한 줄 → 분개
 *   나간 돈: 차변 상대 계정(비용·카드·다른 계좌) / 대변 파일 계정
 *   들어온 돈: 차변 파일 계정 / 대변 상대 계정(수익·다른 계좌)
 * @param {{amount, direction}} entry
 * @param {string} fileAccountId
 * @param {string} counterId 상대 계정
 */
export function entryLines(entry, fileAccountId, counterId) {
  const a = entry.amount;
  return entry.direction === 'out'
    ? [{ account_id: counterId, debit: a, credit: 0 }, { account_id: fileAccountId, debit: 0, credit: a }]
    : [{ account_id: fileAccountId, debit: a, credit: 0 }, { account_id: counterId, debit: 0, credit: a }];
}

/**
 * 전표 종류 정하기 (상대 계정 분류로)
 * @param {'out'|'in'} direction
 * @param {string} counterType 상대 계정 분류
 * @param {string} fileType 파일 계정 분류 (asset | liability)
 */
export function kindFor(direction, counterType, fileType) {
  if (direction === 'out' && counterType === 'expense') return 'expense';
  if (direction === 'in' && counterType === 'income') return 'income';
  if (fileType === 'asset' && direction === 'out' && counterType === 'liability') return 'card_payment';
  if (counterType === 'asset' && fileType === 'asset') return 'transfer';
  return 'manual';
}

/** 숫자만 있는 문자열을 정수로 (가져오기 미리보기에서 금액을 고칠 때) */
export const toAmount = (v) => parseAmount(v);
