// =====================================================================
// 데이터 관리 (#/settings/data)
//   백업: 장부 전체를 JSON 파일로 내려받기 (휴지통·예산·반복 거래·즐겨찾기 포함)
//   복원: 백업 파일을 "새 장부"로 만들기 (지금 장부는 그대로)
//   CSV: 전체 분개장 내려받기 / 은행·카드 내역 가져오기로 이동
// =====================================================================

import { h, append, replace, toast, withBusy, loading } from '../dom.js';
import { state, currentLedger } from '../state.js';
import { downloadText, downloadCsv, stamp } from '../download.js';
import { buildBackup, checkBackup, backupFileName } from '../../core/backup.js';
import { journalRows } from '../../core/exports.js';
import { indexAccounts } from '../../core/balance.js';
import { todayLocal } from '../../core/journal.js';
import { fetchAllTransactions, listAllBudgets, listRecurring, listFavorites, listAccounts, schemaVersion,
  restoreLedger } from '../../data/api.js';

export function render(view, ctx) {
  const ledger = currentLedger();
  const restoreBox = h('div', { class: 'stack' });

  const backupBtn = h('button', { class: 'btn primary block', type: 'button' }, 'JSON 백업 내려받기');
  backupBtn.addEventListener('click', () => withBusy(backupBtn, '모으는 중…', async () => {
    try {
      const [accounts, transactions, budgets, recurring, favorites, version] = await Promise.all([
        listAccounts(state.ledgerId),
        fetchAllTransactions(state.ledgerId, (n) => { backupBtn.lastChild.textContent = `전표 ${n}건 받는 중…`; }),
        listAllBudgets(state.ledgerId), listRecurring(state.ledgerId), listFavorites(state.ledgerId),
        schemaVersion().catch(() => null),
      ]);
      const data = buildBackup({ ledgerName: ledger?.name, schemaVersion: version, accounts, transactions, budgets, recurring, favorites });
      downloadText(backupFileName(ledger?.name), JSON.stringify(data, null, 1), 'application/json');
      toast(`백업했습니다: 계정 ${accounts.length}개, 전표 ${transactions.length}건. 파일을 안전한 곳(클라우드 드라이브 등)에 보관하세요.`, { duration: 6000 });
    } catch (err) {
      toast(state.online ? err.message : '백업은 인터넷 연결이 필요합니다.', { type: 'error' });
    }
  }));

  const journalBtn = h('button', { class: 'btn block', type: 'button' }, '전체 분개장 CSV 내려받기');
  journalBtn.addEventListener('click', () => withBusy(journalBtn, '모으는 중…', async () => {
    try {
      const txns = (await fetchAllTransactions(state.ledgerId)).filter((t) => !t.is_deleted);
      downloadCsv(`분개장-${ledger?.name ?? ''}-${stamp()}`, journalRows(txns, indexAccounts(state.accounts)));
      toast(`전표 ${txns.length}건을 CSV로 내려받았습니다. (휴지통 제외)`);
    } catch (err) {
      toast(state.online ? err.message : '인터넷 연결이 필요합니다.', { type: 'error' });
    }
  }));

  const fileInput = h('input', { type: 'file', accept: '.json,application/json', 'aria-label': '백업 파일 고르기' });
  fileInput.addEventListener('change', () => readBackup(fileInput.files?.[0]));

  append(view,
    h('div', { class: 'row' }, h('a', { href: '#/settings', class: 'btn small ghost' }, '‹ 설정'),
      h('h1', { class: 'view-title' }, '데이터 관리')),
    h('div', { class: 'stack' },
      h('section', { class: 'card stack' },
        h('h2', {}, '백업'),
        h('p', { class: 'small muted' }, `"${ledger?.name ?? ''}" 장부의 모든 데이터(계정과목, 전표와 휴지통, 예산, 반복 거래, 즐겨찾기)를 JSON 파일 하나로 내려받습니다. 한 달에 한 번쯤 받아 두세요.`),
        backupBtn),
      h('section', { class: 'card stack' },
        h('h2', {}, '복원'),
        h('p', { class: 'small muted' }, '백업 파일을 고르면 내용을 확인한 뒤 새 장부로 복원합니다. 지금 장부는 바뀌지 않습니다. 복원한 장부는 화면 위쪽에서 바꿔 볼 수 있고, 필요 없는 장부는 설정 → 장부·가족에서 삭제할 수 있습니다.'),
        fileInput, restoreBox),
      h('section', { class: 'card stack' },
        h('h2', {}, 'CSV'),
        h('p', { class: 'small muted' }, '엑셀에서 바로 열 수 있습니다. 거래 목록·각 보고서 화면에도 [CSV] 버튼이 있습니다.'),
        journalBtn,
        h('a', { class: 'btn block', href: '#/settings/import' }, '은행·카드 내역 가져오기 (CSV·엑셀)'))));

  async function readBackup(file) {
    if (!file) return;
    replace(restoreBox, loading('파일 확인 중…'));
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      return replace(restoreBox, h('p', { class: 'notice bad' }, 'JSON 파일을 읽을 수 없습니다. 이 앱에서 내려받은 백업 파일인지 확인하세요.'));
    }
    const c = checkBackup(data);
    if (!c.summary) return replace(restoreBox, h('p', { class: 'notice bad' }, c.errors.join(' ')));
    const s = c.summary;
    const name = h('input', { type: 'text', maxlength: '50', 'aria-label': '새 장부 이름',
      value: `${s.ledgerName || '가계부'} (복원 ${todayLocal()})` });
    const go = h('button', { class: 'btn primary block', type: 'button', disabled: !c.ok }, '새 장부로 복원');
    go.addEventListener('click', () => withBusy(go, '복원 중…', async () => {
      try {
        const r = await restoreLedger(name.value, data);
        toast(`복원했습니다: 계정 ${r.accounts}개, 전표 ${r.transactions}건. 새 장부로 바꿨습니다.`, { duration: 6000 });
        await ctx.reloadLedgers(r.ledger_id);
        ctx.navigate('dashboard');
      } catch (err) {
        toast(err.message, { type: 'error', duration: 7000 });
      }
    }));
    replace(restoreBox,
      h('div', { class: 'stack', style: 'gap:4px' },
        h('strong', {}, `"${s.ledgerName}" 백업`),
        h('span', { class: 'small muted' }, `만든 때: ${s.exportedAt ? new Date(s.exportedAt).toLocaleString('ko-KR') : '알 수 없음'}`),
        h('span', { class: 'small' }, `계정 ${s.accounts}개 · 전표 ${s.transactions}건 (휴지통 ${s.deleted}건) · 예산 ${s.budgets}건 · 반복 거래 ${s.recurring}건 · 즐겨찾기 ${s.favorites}개`)),
      c.ok ? null : h('p', { class: 'notice bad' }, c.errors.join(' ')),
      h('label', { class: 'field' }, h('span', {}, '새 장부 이름'), name),
      go);
  }
}
