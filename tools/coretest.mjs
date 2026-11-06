// 회계 로직(core) 단위 테스트를 PC에서 실행: node tools/coretest.mjs
import { runTests } from '../js/core/tests.js';

const results = runTests();
for (const r of results) console.log(`${r.ok ? '✔' : '✘'} ${r.name}${r.ok ? '' : '\n    ' + r.error}`);
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed}건 실패` : `\n✅ ${results.length}건 모두 통과`);
process.exitCode = failed ? 1 : 0;
