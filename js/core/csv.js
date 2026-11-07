// =====================================================================
// CSV 만들기·읽기, 한글 인코딩(UTF-8 / EUC-KR) 판별
// 화면(DOM) 코드는 넣지 않습니다.
// =====================================================================

/** 엑셀에서 한글이 깨지지 않도록 UTF-8 BOM을 붙임 */
export const BOM = '﻿';

/** 칸 하나를 CSV 규칙에 맞게 (쉼표·따옴표·줄바꿈이 있으면 따옴표로 감쌈) */
function cell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  // 엑셀이 수식으로 해석하지 않도록 =,+,-,@ 로 시작하는 글자는 앞에 '를 붙임 (숫자는 제외)
  const safe = typeof v === 'string' && /^[=+\-@]/.test(s) && !/^-?\d[\d,]*$/.test(s) ? "'" + s : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * 2차원 배열 → CSV 글자 (BOM 포함, 줄바꿈 CRLF — 엑셀 호환)
 * @param {Array<Array<string|number|null>>} rows 첫 줄은 머리글
 */
export function toCsv(rows) {
  return BOM + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

/**
 * CSV 글자 → 2차원 배열 (따옴표 안의 쉼표·줄바꿈 처리, 빈 줄 제외)
 * @param {string} text
 * @param {string} [delimiter] 생략하면 쉼표/탭/세미콜론 중 첫 줄에 가장 많은 것
 */
export function parseCsv(text, delimiter) {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const d = delimiter ?? [',', '\t', ';'].reduce((best, c) =>
    (firstLine.split(c).length > firstLine.split(best).length ? c : best), ',');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"' && field === '') {
      inQuotes = true;
    } else if (ch === d) {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c !== ''));
}

/**
 * 파일 내용(바이트) → 글자. UTF-8이 아니면 EUC-KR(CP949, 한국 은행 CSV에 흔함)로 읽음
 * @param {ArrayBuffer} buffer
 * @returns {{ text: string, encoding: 'utf-8'|'euc-kr' }}
 */
export function decodeText(buffer) {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buffer), encoding: 'utf-8' };
  } catch {
    return { text: new TextDecoder('euc-kr').decode(buffer), encoding: 'euc-kr' };
  }
}
