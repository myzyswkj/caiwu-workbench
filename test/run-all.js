/* ============================================================
 * 一键跑全部测试（跨平台，npm test 即调用本文件）
 *
 * 逐个 spawn test/*_test.js 与 test/*.test.js，按退出码判定通过/失败，
 * 汇总打印。任一失败则以非零码退出（便于 CI/钩子判断）。
 * ============================================================ */
var execFileSync = require('child_process').execFileSync;
var fs = require('fs');
var path = require('path');

var dir = __dirname;
var files = fs.readdirSync(dir).filter(function (f) {
  return /(_test|\.test)\.js$/.test(f) && f !== 'run-all.js' && f !== 'setup.js';
});

var pass = 0, fail = 0;
files.forEach(function (f) {
  process.stdout.write('\n========== ' + f + ' ==========\n');
  try {
    execFileSync(process.execPath, [path.join(dir, f)], { stdio: 'inherit' });
    pass++;
    process.stdout.write('✅ ' + f + '\n');
  } catch (e) {
    fail++;
    process.stdout.write('❌ ' + f + '\n');
  }
});

process.stdout.write('\n==== 汇总：' + pass + ' 个测试文件通过，' + fail + ' 个失败 ====\n');
process.exit(fail ? 1 : 0);
