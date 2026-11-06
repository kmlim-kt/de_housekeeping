// 로컬 DB 테스트 실행기
// PGlite(브라우저·Node용 PostgreSQL)에 Supabase 흉내 → schema.sql → tests.sql 순서로 실행합니다.
// 사용법: cd tools/sqltest && npm install && npm test
//   업데이트 경로 검증: node run.mjs --upgrade <git 커밋>
//     → 그 커밋의 schema.sql 위에 sql/migrations/*.sql 을 차례로 실행한 뒤 tests.sql

import { PGlite } from '@electric-sql/pglite';
import { readFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const root = new URL('../../', import.meta.url);
const read = (p) => readFile(new URL(p, root), 'utf8');

const db = new PGlite();
const upgradeFrom = process.argv.includes('--upgrade') ? process.argv[process.argv.indexOf('--upgrade') + 1] : null;

const steps = [['Supabase 흉내 (auth·역할)', 'tools/sqltest/supabase-stub.sql']];
if (upgradeFrom) {
  const old = execFileSync('git', ['show', `${upgradeFrom}:sql/schema.sql`], { cwd: new URL(root), encoding: 'utf8' });
  steps.push([`예전 schema.sql (${upgradeFrom})`, { sql: old }]);
  const migrations = (await readdir(new URL('sql/migrations/', root))).filter((f) => f.endsWith('.sql')).sort();
  for (const m of migrations) steps.push([`업데이트 ${m}`, `sql/migrations/${m}`]);
} else {
  steps.push(['schema.sql', 'sql/schema.sql']);
}
steps.push(['tests.sql', 'sql/tests.sql']);

try {
  for (const [label, file] of steps) {
    const sql = typeof file === 'string' ? await read(file) : file.sql;
    // tests.sql은 Supabase SQL Editor처럼 하나의 트랜잭션으로 실행
    const wrapped = file === 'sql/tests.sql' ? `begin;\n${sql}\ncommit;` : sql;
    const results = await db.exec(wrapped);
    console.log(`✔ ${label}`);
    // 마지막 결과 행(테스트 결과 메시지) 출력
    const last = results.filter((r) => r.rows?.length).at(-1);
    if (last) console.log('  ', Object.values(last.rows[0]).join(' '));
  }
} catch (err) {
  console.error('✘ 실패:', err.message);
  if (err.where) console.error('  위치:', err.where);
  process.exitCode = 1;
}
