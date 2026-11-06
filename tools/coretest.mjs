// 회계 로직(core) 단위 테스트 + 서비스 워커 파일 목록 점검: node tools/coretest.mjs
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { runTests } from '../js/core/tests.js';

const results = runTests();
for (const r of results) console.log(`${r.ok ? '✔' : '✘'} ${r.name}${r.ok ? '' : '\n    ' + r.error}`);
let failed = results.filter((r) => !r.ok).length;

// sw.js의 PRECACHE에 앱 파일이 모두 들어 있는지 (빠지면 오프라인에서 화면이 안 열림)
const root = new URL('../', import.meta.url);
const walk = (dir) => readdirSync(new URL(dir, root)).flatMap((name) => {
  const rel = `${dir}/${name}`;
  return statSync(new URL(rel, root)).isDirectory() ? walk(rel) : [rel];
});
const sw = readFileSync(new URL('sw.js', root), 'utf8');
const appFiles = [...walk('js'), ...walk('css'), ...walk('icons')].filter((f) => !f.endsWith('core/tests.js'));
const missing = appFiles.filter((f) => !sw.includes(`'${f}'`));
if (missing.length) {
  failed++;
  console.log(`✘ sw.js PRECACHE에 빠진 파일: ${missing.join(', ')}`);
} else {
  console.log(`✔ sw.js PRECACHE에 앱 파일 ${appFiles.length}개 모두 포함`);
}
// 반대로 PRECACHE에 있는데 실제로 없는 파일 (하나라도 없으면 서비스 워커 설치가 실패함)
const listed = [...sw.matchAll(/^\s+'([^']+)',$/gm)].map((m) => m[1]).filter((p) => p !== './');
const ghost = listed.filter((p) => { try { statSync(new URL(p, root)); return false; } catch { return true; } });
if (ghost.length) {
  failed++;
  console.log(`✘ sw.js PRECACHE에 있지만 없는 파일: ${ghost.join(', ')}`);
} else {
  console.log(`✔ sw.js PRECACHE 목록 ${listed.length}개 모두 실제로 있음`);
}

console.log(failed ? `\n${failed}건 실패` : `\n✅ 모두 통과 (테스트 ${results.length}건 + 파일 목록 점검)`);
process.exitCode = failed ? 1 : 0;
