// =====================================================================
// 백업 파일(JSON) 만들기·확인
//   형식: { format, version, exported_at, schema_version, ledger: {name},
//           accounts, transactions(lines 포함, 휴지통 포함), budgets, recurring, favorites }
// 화면(DOM) 코드는 넣지 않습니다. 복원은 DB 함수 restore_ledger 가 합니다.
// =====================================================================

export const BACKUP_FORMAT = 'de-housekeeping-backup';
export const BACKUP_VERSION = 1;

/** 백업 객체 만들기 (서버에서 읽어 온 행들을 정리) */
export function buildBackup({ ledgerName, schemaVersion, accounts, transactions, budgets, recurring, favorites, now = new Date() }) {
  const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k] ?? null]));
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exported_at: now.toISOString(),
    schema_version: schemaVersion ?? null,
    ledger: { name: ledgerName },
    accounts: accounts.map((a) => pick(a, ['id', 'name', 'type', 'subtype', 'parent_id', 'is_hidden', 'is_system', 'sort_order'])),
    transactions: transactions.map((t) => ({
      ...pick(t, ['id', 'txn_date', 'txn_time', 'memo', 'kind', 'source', 'recurring_id', 'is_deleted', 'deleted_at', 'created_at']),
      lines: [...t.lines].sort((a, b) => a.line_no - b.line_no)
        .map((l) => pick(l, ['account_id', 'debit', 'credit', 'memo', 'line_no'])),
    })),
    budgets: budgets.map((b) => pick(b, ['account_id', 'month', 'amount'])),
    recurring: recurring.map((r) => pick(r, ['id', 'name', 'freq', 'interval_n', 'day_of_month', 'start_date', 'end_date', 'next_date', 'template', 'is_active'])),
    favorites: favorites.map((f) => pick(f, ['name', 'template', 'sort_order'])),
  };
}

/**
 * 백업 파일 확인 (복원 전에 화면에서 먼저)
 * @param {unknown} data JSON.parse 결과
 * @returns {{ ok: boolean, errors: string[], summary: { ledgerName, exportedAt, accounts, transactions, deleted, budgets, recurring, favorites } | null }}
 */
export function checkBackup(data) {
  const errors = [];
  if (!data || typeof data !== 'object') return { ok: false, errors: ['JSON 파일이 아닙니다.'], summary: null };
  if (data.format !== BACKUP_FORMAT) errors.push('이 앱에서 만든 가계부 백업 파일이 아닙니다.');
  else if (data.version !== BACKUP_VERSION) errors.push(`지원하지 않는 백업 버전입니다 (${data.version}).`);
  if (!Array.isArray(data.accounts) || !data.accounts.length) errors.push('계정과목이 없습니다.');
  if (!Array.isArray(data.transactions)) errors.push('전표 목록이 없습니다.');
  if (errors.length) return { ok: false, errors, summary: null };

  // 계정 참조·차대 일치 미리 확인 (DB도 다시 확인함)
  const ids = new Set(data.accounts.map((a) => a.id));
  let bad = 0;
  let missing = 0;
  for (const t of data.transactions) {
    const lines = t.lines ?? [];
    const d = lines.reduce((s, l) => s + Number(l.debit || 0), 0);
    const c = lines.reduce((s, l) => s + Number(l.credit || 0), 0);
    if (lines.length < 2 || d !== c) bad++;
    if (lines.some((l) => !ids.has(l.account_id))) missing++;
  }
  if (bad) errors.push(`차변·대변이 맞지 않는 전표가 ${bad}건 있습니다.`);
  if (missing) errors.push(`없는 계정을 가리키는 전표가 ${missing}건 있습니다.`);

  return {
    ok: errors.length === 0,
    errors,
    summary: {
      ledgerName: data.ledger?.name ?? '',
      exportedAt: data.exported_at ?? '',
      accounts: data.accounts.length,
      transactions: data.transactions.filter((t) => !t.is_deleted).length,
      deleted: data.transactions.filter((t) => t.is_deleted).length,
      budgets: (data.budgets ?? []).length,
      recurring: (data.recurring ?? []).length,
      favorites: (data.favorites ?? []).length,
    },
  };
}

/** 파일 이름: 가계부-백업-우리집 가계부-20261107.json (파일 이름에 못 쓰는 글자 제거) */
export function backupFileName(ledgerName, now = new Date()) {
  const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const safe = String(ledgerName || '가계부').replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 40);
  return `가계부-백업-${safe}-${ymd}.json`;
}
