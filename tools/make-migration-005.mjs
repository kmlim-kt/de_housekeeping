// DB 업데이트 005(거래 시각) 만들기: schema.sql에서 바뀐 함수 정의를 그대로 가져와 조립
// (새 설치용 schema.sql과 업데이트 SQL의 내용이 어긋나지 않게 하려는 것)
// 사용법: node tools/make-migration-005.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const schema = readFileSync(new URL('sql/schema.sql', root), 'utf8');

function fn(name) {
  const start = schema.indexOf(`create or replace function public.${name}(`);
  if (start < 0) throw new Error(`${name} 정의를 찾을 수 없음`);
  const end = schema.indexOf('\n$$;', start);
  return schema.slice(start, end + 4);
}

const sql = `-- =====================================================================
-- DB 업데이트 5: 거래 시각(시:분)과 시간순 정렬
--
-- 실행: Supabase SQL Editor에 이 파일 전체를 붙여넣고 Run (한 번만, 다시 실행해도 안전)
-- 002~004를 아직 실행하지 않았다면 먼저 실행하세요.
-- 처음 설치하는 경우에는 schema.sql에 이미 들어 있으므로 실행하지 않아도 됩니다.
-- (이 파일은 tools/make-migration-005.mjs 가 schema.sql에서 만들었습니다)
-- =====================================================================

-- 전표에 시각 열 추가 (기존 전표는 비어 있음 = 그날 맨 앞으로 정렬)
alter table public.transactions add column if not exists txn_time time(0);

-- 매개변수·결과 모양이 바뀌는 함수는 예전 것을 지우고 다시 만듦
drop function if exists public.create_transaction(uuid, uuid, date, text, text, text, jsonb, uuid, date);
drop function if exists public.update_transaction(uuid, date, text, text, jsonb, timestamptz);
drop function if exists public.search_transactions(uuid, date, date, uuid, text, bigint, bigint, boolean, integer, integer);
drop function if exists public.account_ledger(uuid, date, date);

${fn('create_transaction')}

${fn('update_transaction')}

${fn('search_transactions')}

${fn('account_ledger')}

${fn('restore_ledger')}

${fn('schema_version')}

-- 권한: 로그인한 사용자만
revoke all on function public.create_transaction(uuid, uuid, date, text, text, text, jsonb, uuid, date, time) from public, anon;
grant execute on function public.create_transaction(uuid, uuid, date, text, text, text, jsonb, uuid, date, time) to authenticated;
revoke all on function public.update_transaction(uuid, date, text, text, jsonb, timestamptz, text) from public, anon;
grant execute on function public.update_transaction(uuid, date, text, text, jsonb, timestamptz, text) to authenticated;
revoke all on function public.search_transactions(uuid, date, date, uuid, text, bigint, bigint, boolean, integer, integer, text) from public, anon;
grant execute on function public.search_transactions(uuid, date, date, uuid, text, bigint, bigint, boolean, integer, integer, text) to authenticated;
revoke all on function public.account_ledger(uuid, date, date) from public, anon;
grant execute on function public.account_ledger(uuid, date, date) to authenticated;
revoke all on function public.restore_ledger(text, jsonb) from public, anon;
grant execute on function public.restore_ledger(text, jsonb) to authenticated;
grant execute on function public.schema_version() to anon, authenticated;
`;

writeFileSync(new URL('sql/migrations/005_txn_time.sql', root), sql);
console.log('✔ sql/migrations/005_txn_time.sql');
