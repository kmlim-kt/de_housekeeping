// =====================================================================
// 은행·카드 내역 가져오기 (#/settings/import)
//   1) 파일 고르기: CSV(UTF-8·EUC-KR 자동), 엑셀(xlsx·xls — SheetJS를 이때만 불러옴)
//   2) 열 지정: 머리글 줄, 날짜·내용·금액 열(자동 추측), 이 파일의 계좌·카드
//   3) 미리보기: 줄마다 상대 계정(식비 등) 고르기 — 예전에 고른 항목 자동 추천,
//      이미 장부에 있는 것 같은 줄(같은 날·같은 금액)은 기본으로 빼 둠
//   4) 가져오기: 한 줄 = 전표 하나 (나간 돈: 차변 상대 계정 / 대변 이 계좌, 들어온 돈: 반대)
// 읽기·추측·분개는 core/importer.js 가 합니다.
// =====================================================================

import { h, append, replace, toast, withBusy, loading } from '../dom.js';
import { state, prefs, markUsed } from '../state.js';
import { decodeText, parseCsv } from '../../core/csv.js';
import { AMOUNT_MODES, guessHeaderRow, guessMapping, buildEntries, suggestAccount, learnRules,
  findDuplicates, entryLines, kindFor } from '../../core/importer.js';
import { postableAccounts, indexAccounts, ACCOUNT_TYPES, TYPE_LABELS } from '../../core/balance.js';
import { formatAmount } from '../../core/money.js';
import { searchTransactions, createTransaction } from '../../data/api.js';

const SHEETJS = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';

function loadSheetJs() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SHEETJS;
    s.onload = () => resolve(window.XLSX);
    s.onerror = () => reject(new Error('엑셀을 읽는 프로그램을 불러오지 못했습니다. 인터넷 연결을 확인하거나 CSV로 저장해 가져오세요.'));
    document.head.append(s);
  });
}

export function render(view) {
  const byId = indexAccounts(state.accounts);
  const postable = postableAccounts(state.accounts);
  const fileAccounts = postable.filter((o) => o.type === 'asset' || o.type === 'liability');
  const rulesKey = 'importRules.' + state.ledgerId;

  let rows = [];          // 파일의 모든 줄
  let headerRow = 0;
  let map = null;
  let fileAccountId = prefs.get('importAccount.' + state.ledgerId, '');
  let entries = [];       // { ...entry, include, accountId, duplicate }

  const fileInput = h('input', { type: 'file', accept: '.csv,.txt,.xlsx,.xls', 'aria-label': '내역 파일 고르기' });
  const fileInfo = h('p', { class: 'small muted' });
  const mappingBox = h('div');
  const previewBox = h('div');
  const resultBox = h('div');
  fileInput.addEventListener('change', () => readFile(fileInput.files?.[0]));

  append(view,
    h('div', { class: 'row' }, h('a', { href: '#/settings/data', class: 'btn small ghost' }, '‹ 데이터 관리'),
      h('h1', { class: 'view-title' }, '은행·카드 내역 가져오기')),
    h('div', { class: 'stack' },
      h('section', { class: 'card stack' },
        h('h2', {}, '1. 파일 고르기'),
        h('p', { class: 'small muted' }, '인터넷뱅킹·카드사 홈페이지에서 내려받은 거래내역 파일(CSV 또는 엑셀)을 고르세요. 한 번에 한 계좌(또는 한 카드)의 내역만 가져옵니다.'),
        fileInput, fileInfo),
      mappingBox, previewBox, resultBox));

  // =================================================================

  async function readFile(file) {
    replace(mappingBox); replace(previewBox); replace(resultBox);
    if (!file) return;
    fileInfo.textContent = '읽는 중…';
    try {
      if (/\.(xlsx|xls)$/i.test(file.name)) {
        const XLSX = await loadSheetJs();
        const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: false });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        // 화면 표시 형식(예: 미국식 11/3/26)이 아니라 원래 값으로 읽음:
        // 날짜 칸은 엑셀 날짜 숫자, 금액 칸은 숫자 → core/importer가 해석
        rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' })
          .map((r) => r.map((c) => (typeof c === 'string' ? c.trim() : c)))
          .filter((r) => r.some((c) => c !== '' && c !== null));
        fileInfo.textContent = `${file.name} · 엑셀 · 첫 번째 시트 "${wb.SheetNames[0]}" · ${rows.length}줄`;
      } else {
        const { text, encoding } = decodeText(await file.arrayBuffer());
        rows = parseCsv(text);
        fileInfo.textContent = `${file.name} · CSV(${encoding === 'euc-kr' ? 'EUC-KR' : 'UTF-8'}) · ${rows.length}줄`;
      }
      if (rows.length < 2) throw new Error('파일에 내역이 없습니다.');
      headerRow = guessHeaderRow(rows);
      map = guessMapping(rows[headerRow]);
      drawMapping();
    } catch (err) {
      fileInfo.textContent = '';
      replace(mappingBox, h('p', { class: 'notice bad' }, err.message || '파일을 읽을 수 없습니다.'));
    }
  }

  function columnSelect(label, key, allowNone = false) {
    const header = rows[headerRow] ?? [];
    const width = Math.max(...rows.slice(headerRow, headerRow + 10).map((r) => r.length));
    const sel = h('select', { 'aria-label': label,
      onChange: (e) => { map[key] = Number(e.target.value); drawPreview(); } },
      allowNone ? h('option', { value: '-1' }, '(없음)') : null,
      [...Array(width)].map((_, i) => h('option', { value: String(i) },
        `${i + 1}열: ${header[i] || '(제목 없음)'}${rows[headerRow + 1]?.[i] ? ` — 예: ${String(rows[headerRow + 1][i]).slice(0, 16)}` : ''}`)));
    sel.value = String(map[key] ?? -1);
    return h('label', { class: 'field' }, h('span', {}, label), sel);
  }

  function drawMapping() {
    const headerSel = h('select', { 'aria-label': '머리글 줄', onChange: (e) => {
      headerRow = Number(e.target.value); map = guessMapping(rows[headerRow]); drawMapping();
    } }, rows.slice(0, 20).map((r, i) =>
      h('option', { value: String(i) }, `${i + 1}번째 줄: ${r.filter(Boolean).slice(0, 4).join(' | ').slice(0, 50)}`)));
    headerSel.value = String(headerRow);

    const modeSel = h('select', { 'aria-label': '금액 방식', onChange: (e) => { map.mode = e.target.value; drawMapping(); } },
      Object.entries(AMOUNT_MODES).map(([k, label]) => h('option', { value: k }, label)));
    modeSel.value = map.mode;

    const accSel = h('select', { 'aria-label': '이 파일의 계좌·카드', onChange: (e) => {
      fileAccountId = e.target.value; prefs.set('importAccount.' + state.ledgerId, fileAccountId); drawPreview();
    } }, h('option', { value: '' }, '계좌·카드 고르기'),
      ['asset', 'liability'].map((type) => h('optgroup', { label: TYPE_LABELS[type] },
        fileAccounts.filter((o) => o.type === type).map((o) => h('option', { value: o.id }, o.label)))));
    accSel.value = fileAccounts.some((o) => o.id === fileAccountId) ? fileAccountId : '';
    if (!accSel.value) fileAccountId = '';

    replace(mappingBox, h('section', { class: 'card stack' },
      h('h2', {}, '2. 열 지정'),
      h('p', { class: 'small muted' }, '자동으로 추측했습니다. 틀린 곳만 바꾸세요.'),
      h('label', { class: 'field' }, h('span', {}, '머리글(제목) 줄'), headerSel),
      h('label', { class: 'field' }, h('span', {}, '이 파일은 어느 계좌·카드의 내역인가요?'), accSel),
      columnSelect('날짜 열', 'date'),
      columnSelect('시각 열 (없으면 날짜 칸에 붙은 시각을 씀)', 'time', true),
      columnSelect('내용(가맹점·적요) 열', 'memo', true),
      h('label', { class: 'field' }, h('span', {}, '금액 방식'), modeSel),
      map.mode === 'split'
        ? h('div', { class: 'row-2' }, columnSelect('출금(나간 돈) 열', 'out', true), columnSelect('입금(들어온 돈) 열', 'in', true))
        : columnSelect('금액 열', 'amount')));
    drawPreview();
  }

  async function drawPreview() {
    replace(resultBox);
    if (!fileAccountId) return replace(previewBox, h('p', { class: 'notice' }, '위에서 이 파일의 계좌·카드를 고르면 미리보기가 나옵니다.'));
    const { entries: list, skipped } = buildEntries(rows, headerRow, map);
    if (!list.length) {
      return replace(previewBox, h('p', { class: 'notice bad' },
        '가져올 거래를 찾지 못했습니다. 머리글 줄과 날짜·금액 열을 확인하세요.'
        + (skipped.length ? ` (건너뛴 줄 ${skipped.length}개: ${skipped[0].reason} 등)` : '')));
    }
    replace(previewBox, loading('장부의 기존 거래와 비교하는 중…'));

    // 중복 비교: 같은 기간, 이 계좌가 들어간 기존 전표
    let existing = [];
    try {
      const dates = list.map((e) => e.date).sort();
      for (let offset = 0; ; offset += 500) {
        const r = await searchTransactions({ ledgerId: state.ledgerId, from: dates[0], to: dates.at(-1),
          accountId: fileAccountId, limit: 500, offset });
        existing.push(...r.rows);
        if (r.rows.length < 500) break;
      }
    } catch (err) {
      existing = [];
      toast('기존 거래와 비교하지 못했습니다(중복 확인 없이 진행): ' + err.message, { type: 'error' });
    }
    const dup = findDuplicates(list, existing, fileAccountId);
    const rules = prefs.get(rulesKey, {});
    const named = (n) => state.accounts.find((a) => a.name === n && !state.accounts.some((c) => c.parent_id === a.id))?.id ?? '';
    const defaults = { out: named('기타 지출'), in: named('기타 수입') };
    entries = list.map((e, i) => ({ ...e, duplicate: dup.has(i), include: !dup.has(i), accountId: suggestAccount(e, rules, defaults) }));
    drawRows(skipped);
  }

  function counterSelect(e) {
    const groups = ACCOUNT_TYPES.map((type) => {
      const items = postable.filter((o) => o.type === type && o.id !== fileAccountId);
      if (!items.length) return null;
      const hint = { expense: ' (쓴 곳)', income: ' (들어온 이유)', asset: ' (다른 계좌로 이체)', liability: ' (카드대금·대출)', equity: '' }[type];
      return h('optgroup', { label: TYPE_LABELS[type] + hint }, items.map((o) => h('option', { value: o.id }, o.label)));
    });
    const sel = h('select', { 'aria-label': `${e.date} ${e.memo} 항목`, onChange: (ev) => { e.accountId = ev.target.value; summary(); } },
      h('option', { value: '' }, '항목 고르기'), groups);
    sel.value = e.accountId;
    return sel;
  }

  let summaryEl;
  let importBtn;

  function summary() {
    const picked = entries.filter((e) => e.include);
    const missing = picked.filter((e) => !e.accountId).length;
    const outSum = picked.filter((e) => e.direction === 'out').reduce((s, e) => s + e.amount, 0);
    const inSum = picked.filter((e) => e.direction === 'in').reduce((s, e) => s + e.amount, 0);
    summaryEl.textContent = `${picked.length}건 가져오기 · 나간 돈 ${formatAmount(outSum)}원 · 들어온 돈 ${formatAmount(inSum)}원`
      + (missing ? ` · 항목을 안 고른 줄 ${missing}건` : '');
    importBtn.disabled = !picked.length || missing > 0;
  }

  function drawRows(skipped) {
    summaryEl = h('p', { class: 'small', 'aria-live': 'polite' });
    importBtn = h('button', { class: 'btn primary block', type: 'button', onClick: doImport }, '가져오기');
    const dupCount = entries.filter((e) => e.duplicate).length;
    replace(previewBox, h('section', { class: 'card stack' },
      h('h2', {}, '3. 미리보기 · 항목 고르기'),
      h('p', { class: 'small muted' },
        `나간 돈은 "어디에 썼는지"(식비 등), 들어온 돈은 "왜 들어왔는지"(급여 등)를 고르세요. 다른 내 계좌로 옮긴 돈은 그 계좌를, 카드대금은 그 카드를 고르면 됩니다.`
        + (dupCount ? ` 이미 장부에 있는 것 같은 ${dupCount}건은 빼 두었습니다.` : '')
        + (skipped.length ? ` 날짜·금액을 읽을 수 없는 ${skipped.length}줄(합계 줄 등)은 건너뜁니다.` : '')),
      h('ul', { class: 'list' }, entries.map((e) => {
        const check = h('input', { type: 'checkbox', checked: e.include, 'aria-label': '가져오기에 포함',
          onChange: (ev) => { e.include = ev.target.checked; summary(); } });
        return h('li', { class: 'stack', style: 'gap:6px' },
          h('div', { class: 'row between' },
            h('label', { class: 'row', style: 'gap:8px;min-height:44px' }, check,
              h('span', {}, h('span', { class: 'small muted num' }, `${e.date}${e.time ? ' ' + e.time : ''} `), e.memo || '(내용 없음)')),
            h('strong', { class: 'num ' + (e.direction === 'out' ? 'credit' : 'debit') },
              (e.direction === 'out' ? '−' : '+') + formatAmount(e.amount))),
          e.duplicate ? h('span', { class: 'badge' }, '이미 있는 거래일 수 있음') : null,
          counterSelect(e));
      })),
      summaryEl, importBtn));
    summary();
  }

  async function doImport() {
    const picked = entries.filter((e) => e.include && e.accountId);
    const fileAcc = byId.get(fileAccountId);
    let done = 0;
    const failed = [];
    await withBusy(importBtn, '가져오는 중…', async () => {
      for (const e of picked) {
        const counter = byId.get(e.accountId);
        try {
          await createTransaction({
            id: crypto.randomUUID(), ledgerId: state.ledgerId, date: e.date, time: e.time, memo: e.memo,
            kind: kindFor(e.direction, counter?.type, fileAcc?.type), source: 'import',
            lines: entryLines(e, fileAccountId, e.accountId),
          });
          done++;
          importBtn.lastChild.textContent = `가져오는 중… ${done}/${picked.length}`;
        } catch (err) {
          failed.push({ e, message: err.message });
          if (!state.online) break;
        }
      }
    });
    // 다음 가져오기 때 같은 가맹점은 같은 항목으로 추천
    prefs.set(rulesKey, learnRules(prefs.get(rulesKey, {}), picked));
    markUsed([fileAccountId]);
    replace(previewBox);
    replace(resultBox, h('section', { class: 'card stack' },
      h('h2', {}, '4. 결과'),
      h('p', { class: failed.length ? 'notice bad' : 'notice ok' },
        `${done}건을 장부에 넣었습니다.` + (failed.length ? ` ${failed.length}건은 실패했습니다.` : '')),
      failed.length ? h('ul', { class: 'list small' }, failed.map(({ e, message }) =>
        h('li', {}, `${e.date} ${e.memo} ${formatAmount(e.amount)}원 — ${message}`))) : null,
      h('div', { class: 'row' },
        h('a', { class: 'btn', href: '#/list' }, '거래 목록에서 보기'),
        h('button', { class: 'btn ghost', type: 'button', onClick: () => { fileInput.value = ''; replace(resultBox); fileInfo.textContent = ''; replace(mappingBox); } }, '다른 파일 가져오기'))));
    toast(`${done}건을 가져왔습니다.`);
  }
}
