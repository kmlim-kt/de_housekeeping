// =====================================================================
// 파일 내려받기 (CSV·JSON). 휴대폰에서는 "다운로드" 또는 공유 화면으로 저장됩니다.
// =====================================================================

import { toCsv } from '../core/csv.js';

/** 글자를 파일로 내려받기 */
export function downloadText(fileName, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** 표(2차원 배열)를 CSV 파일로 (엑셀에서 한글이 깨지지 않도록 BOM 포함) */
export function downloadCsv(fileName, rows) {
  downloadText(fileName.endsWith('.csv') ? fileName : fileName + '.csv', toCsv(rows), 'text/csv');
}

/** 파일 이름에 붙일 오늘 날짜 20261107 */
export function stamp(now = new Date()) {
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
}
