// 로컬 DB 테스트 실행기
// PGlite(브라우저·Node용 PostgreSQL)에 Supabase 흉내 → schema.sql → tests.sql 순서로 실행합니다.
// 사용법: cd tools/sqltest && npm install && npm test

import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';

const root = new URL('../../', import.meta.url);
const read = (p) => readFile(new URL(p, root), 'utf8');

const db = new PGlite();
const steps = [
  ['Supabase 흉내 (auth·역할)', 'tools/sqltest/supabase-stub.sql'],
  ['schema.sql',               'sql/schema.sql'],
  ['tests.sql',                'sql/tests.sql'],
];

try {
  for (const [label, file] of steps) {
    const sql = await read(file);
    // tests.sql은 Supabase SQL Editor처럼 하나의 트랜잭션으로 실행
    const wrapped = file.endsWith('tests.sql') ? `begin;\n${sql}\ncommit;` : sql;
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
