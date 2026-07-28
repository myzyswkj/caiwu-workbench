const fs = require('fs'), vm = require('vm');
const xlsxCode = fs.readFileSync('js/xlsx.full.min.js', 'utf8');
const intCode = fs.readFileSync('js/internal.js', 'utf8');

// 浏览器风格沙箱
const sandbox = { console, setTimeout, Date, Math, JSON, Uint8Array, ArrayBuffer, FileReader: function(){}, RegExp };
sandbox.window = sandbox; sandbox.self = sandbox; sandbox.global = sandbox;
const FW = {
  modules: {}, db: { uid: () => 'id', getById: () => null, upsert: () => {}, getList: () => [], saveList: () => {}, remove: () => {} },
  openModal: () => {}, closeModal: () => {}, toast: () => {}, qa: () => [], today: () => '2026-07-28',
  fmtMoney: (n) => String(n), esc: (s) => s
};
sandbox.FW = FW; sandbox.window.FW = FW;
vm.createContext(sandbox);
vm.runInContext(xlsxCode, sandbox);   // 设置 sandbox.XLSX
vm.runInContext(intCode, sandbox);    // 定义 FW.modules.internal / FW.internalImport
const XLSX = sandbox.XLSX;

let pass = 0, fail = 0;
function ok(name, cond, got) { if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, '=>', JSON.stringify(got)); } }

// ---- 构造一个 Excel 工作簿（模拟会计软件导出的 .xlsx）----
const aoa = [
  ['日期', '收/支', '金额', '对方', '备注'],
  ['2026-07-01', '支出', 120.5, '超市', '买菜'],
  ['2026-07-02', '收入', 2000, '工资', '发薪'],
  ['2026-07-03', '支出', -50, '话费', '']   // 负金额 + 列标明支出
];
const ws = XLSX.utils.aoa_to_sheet(aoa);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
ok('XLSX 写出 xlsx 字节', buf && buf.byteLength > 0, buf && buf.byteLength);

// ---- 模拟 openImport 的 xlsx 分支 ----
const wb2 = XLSX.read(new Uint8Array(buf), { type: 'array' });
const ws2 = wb2.Sheets[wb2.SheetNames[0]];
let rowsArr = XLSX.utils.sheet_to_json(ws2, { header: 1, defval: '', raw: false });
while (rowsArr.length && rowsArr[rowsArr.length - 1].every(c => c === '' || c == null)) rowsArr.pop();
ok('sheet_to_json 得到 4 行(含表头)', rowsArr.length === 4, rowsArr.length);

const headers = rowsArr[0].map(c => c == null ? '' : String(c));
const map = FW.internalImport.guessMap(headers);
ok('guessMap 识别日期列=0', map.dateCol === 0, map.dateCol);
ok('guessMap 识别金额列=2', map.amountCol === 2, map.amountCol);
ok('guessMap 识别收支列=1', map.typeCol === 1, map.typeCol);

const res = FW.internalImport.parseRowsCore(rowsArr, map);
ok('解析出 3 笔记录', res.rows.length === 3, res.rows.length);
ok('第1笔 支出 120.5', res.rows[0].type === 'expense' && Math.abs(res.rows[0].amount - 120.5) < 1e-9, res.rows[0]);
ok('第2笔 收入 2000', res.rows[1].type === 'income' && res.rows[1].amount === 2000, res.rows[1]);
ok('第3笔 支出 50(负金额转正)', res.rows[2].type === 'expense' && res.rows[2].amount === 50, res.rows[2]);

// ---- 直接测 parseRowsCore：无表头 + 负金额判定(excel 也可能没表头) ----
const noHeader = [
  ['2026-07-10', -300, '支出'],
  ['2026-07-11', 880, '收入']
];
const m2 = { hasHeader: false, dateCol: 0, amountCol: 1, typeCol: 2, partyCol: -1, remarkCol: -1, signMode: 'col' };
const r2 = FW.internalImport.parseRowsCore(noHeader, m2);
ok('无表头解析 2 笔', r2.rows.length === 2, r2.rows.length);
ok('无表头 负300=支出', r2.rows[0].type === 'expense' && r2.rows[0].amount === 300, r2.rows[0]);
ok('无表头 880=收入', r2.rows[1].type === 'income' && r2.rows[1].amount === 880, r2.rows[1]);

console.log('\n== 结果: ' + pass + ' 通过, ' + fail + ' 失败 ==');
process.exit(fail ? 1 : 0);
