(function (window) {
  'use strict';
  var FW = window.FW || (window.FW = {});

  function num(v) {
    var n = parseFloat(v);
    return isNaN(n) ? 0 : n;
  }

  // ===== 数据说明 =====
  // salary_employees: { id, name, dept, remark }
  // salary_records:   { id, empId, year, month, base(底薪), bonus(奖金), commission(提成), remark }
  // 每笔金额 = 底薪 + 奖金 + 提成；每人累计 = 各月(底薪+奖金+提成)之和

  function getEmps() { return FW.db.getList('salary_employees'); }
  function getRecs() { return FW.db.getList('salary_records'); }

  function recId(empId, year, month) { return empId + '-' + year + '-' + month; }

  // 兼容旧数据：旧记录只含 salary 字段 → 记作底薪；旧 bonus(奖金/提成合并) → 记为奖金，提成置 0
  function normalizeRec(r) {
    var base = num(r.base);
    var bonus = num(r.bonus);
    var commission = num(r.commission);
    if (r.base == null && r.bonus == null && r.commission == null && r.salary != null) {
      base = num(r.salary); bonus = 0; commission = 0;
    }
    return { empId: r.empId, year: r.year, month: r.month, base: base, bonus: bonus, commission: commission, remark: r.remark || '' };
  }

  function computeEmpYear(emp, recs, year) {
    var months = (recs || []).map(normalizeRec).sort(function (a, b) { return a.month - b.month; });
    var cumBase = 0, cumBonus = 0, cumCommission = 0, cumAmount = 0;
    var list = months.map(function (r) {
      var amount = r.base + r.bonus + r.commission;
      cumBase += r.base; cumBonus += r.bonus; cumCommission += r.commission; cumAmount += amount;
      return { month: r.month, base: r.base, bonus: r.bonus, commission: r.commission, amount: amount, remark: r.remark };
    });
    return { months: list, cumBase: cumBase, cumBonus: cumBonus, cumCommission: cumCommission, cumAmount: cumAmount };
  }

  function computeYear(emps, recs, year) {
    return emps.map(function (emp) {
      var er = recs.filter(function (r) { return r.empId === emp.id; });
      return { emp: emp, calc: computeEmpYear(emp, er, year) };
    });
  }

  FW.salaryCalc = { computeEmpYear: computeEmpYear, computeYear: computeYear, num: num };
  FW.salaryImport = { guessSalaryMap: guessSalaryMap, parseSalaryRows: parseSalaryRows, parseYM: parseYM, parseYear: parseYear };

  // ===== 渲染 =====
  var state = { year: new Date().getFullYear() };
  var MONTHS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];

  function render() {
    var emps = getEmps();
    var recs = getRecs();
    var rows = computeYear(emps, recs, state.year);

    var totalBase = 0, totalBonus = 0, totalCommission = 0, totalAmount = 0;
    rows.forEach(function (rw) {
      totalBase += rw.calc.cumBase;
      totalBonus += rw.calc.cumBonus;
      totalCommission += rw.calc.cumCommission;
      totalAmount += rw.calc.cumAmount;
    });

    // 顶部操作
    var top = document.getElementById('topActions');
    if (top) {
      top.innerHTML =
        '<button class="btn" id="salPrevYear">‹ ' + (state.year - 1) + '</button>' +
        '<span class="yr-label">' + state.year + ' 年</span>' +
        '<button class="btn" id="salNextYear">' + (state.year + 1) + ' ›</button>' +
        '<button class="btn primary" id="salImportBtn">📥 导入工资</button>' +
        '<button class="btn" id="salEmpBtn">👥 员工管理</button>' +
        '<button class="btn" id="salPrint">🖨 打印</button>' +
        '<button class="btn" id="salExport">⬇ 导出CSV</button>';
      document.getElementById('salPrevYear').onclick = function () { state.year--; render(); };
      document.getElementById('salNextYear').onclick = function () { state.year++; render(); };
      document.getElementById('salImportBtn').onclick = openImport;
      document.getElementById('salEmpBtn').onclick = openEmpManager;
      document.getElementById('salPrint').onclick = function () { window.print(); };
      document.getElementById('salExport').onclick = function () { exportCSV(rows); };
    }

    var html = '';
    html += '<div class="salary-wrap">';

    // 汇总卡
    html += '<div class="sal-stats">' +
      statCard('员工人数', emps.length + ' 人') +
      statCard('累计底薪', FW.fmtMoney(totalBase)) +
      statCard('累计奖金', FW.fmtMoney(totalBonus)) +
      statCard('累计提成', FW.fmtMoney(totalCommission)) +
      statCard('累计金额', FW.fmtMoney(totalAmount)) +
      '</div>';

    html += '<p class="sal-tip">💡 工资登记：逐月登记每个人的<strong>底薪</strong>、<strong>奖金</strong>与<strong>提成</strong>，三者分开记录，每笔金额 = 底薪 + 奖金 + 提成，右侧自动累计每个人的底薪、奖金、提成与总金额。点格子可录入 / 修改；也可点「📥 导入工资」直接导入 Excel/CSV，系统会自动识别员工并新建。</p>';

    if (emps.length === 0) {
      html += '<div class="empty-state">' +
        '<div class="empty-ico">💰</div>' +
        '<div class="empty-title">还没有员工</div>' +
        '<div class="empty-sub">点「📥 导入工资」选一份含 姓名/底薪/奖金/提成 的 Excel 或 CSV，系统会自动识别并新建员工；也可点「👥 员工管理」手动添加。</div>' +
        '<button class="btn primary" id="salImportBtn2">📥 导入工资</button>' +
        '</div>';
      html += '</div>';
      var c0 = document.getElementById('content'); if (c0) c0.innerHTML = html;
      var b0 = document.getElementById('salImportBtn2'); if (b0) b0.onclick = openImport;
      return;
    }

    // 工资表
    html += '<div class="salary-table-wrap print-area"><table class="salary-table"><thead><tr>' +
      '<th class="col-emp">员工 / 部门</th>';
    MONTHS.forEach(function (m) { html += '<th>' + m + '</th>'; });
    html += '<th>累计底薪</th><th>累计奖金</th><th>累计提成</th><th>累计金额</th></tr></thead><tbody>';

    rows.forEach(function (rw) {
      var emp = rw.emp;
      var byMonth = {};
      rw.calc.months.forEach(function (m) { byMonth[m.month] = m; });
      html += '<tr><td class="col-emp"><div class="emp-name">' + FW.esc(emp.name) + '</div>' +
        '<div class="emp-dept">' + FW.esc(emp.dept || '—') + '</div></td>';
      for (var mo = 1; mo <= 12; mo++) {
        var m = byMonth[mo];
        if (m) {
          html += '<td class="cell-has" data-emp="' + emp.id + '" data-month="' + mo + '" title="点击编辑">' +
            '<div class="cell-base">底 ' + FW.fmtMoney(m.base) + '</div>' +
            '<div class="cell-bonus">奖 ' + FW.fmtMoney(m.bonus) + '</div>' +
            '<div class="cell-comm">提 ' + FW.fmtMoney(m.commission) + '</div>' +
            '<div class="cell-amt">= ' + FW.fmtMoney(m.amount) + '</div></td>';
        } else {
          html += '<td class="cell-empty" data-emp="' + emp.id + '" data-month="' + mo + '" title="点击录入">' +
            '<span class="plus">＋</span></td>';
        }
      }
      html += '<td class="col-sum base">' + FW.fmtMoney(rw.calc.cumBase) + '</td>' +
        '<td class="col-sum bonus">' + FW.fmtMoney(rw.calc.cumBonus) + '</td>' +
        '<td class="col-sum comm">' + FW.fmtMoney(rw.calc.cumCommission) + '</td>' +
        '<td class="col-sum amount">' + FW.fmtMoney(rw.calc.cumAmount) + '</td></tr>';
    });

    html += '</tbody></table></div>';
    html += '</div>';

    var c2 = document.getElementById('content'); if (c2) c2.innerHTML = html;

    // 单元格点击录入
    var cells = document.querySelectorAll('.salary-table td[data-emp]');
    Array.prototype.forEach.call(cells, function (td) {
      td.onclick = function () {
        openMonthEdit(td.getAttribute('data-emp'), parseInt(td.getAttribute('data-month'), 10));
      };
    });
  }

  function statCard(label, val) {
    return '<div class="sal-stat"><div class="sal-stat-val">' + val + '</div><div class="sal-stat-label">' + label + '</div></div>';
  }

  // 录入/编辑某月
  function openMonthEdit(empId, month) {
    var emps = getEmps();
    var emp = emps.filter(function (e) { return e.id === empId; })[0];
    if (!emp) return;
    var recs = getRecs();
    var rec = recs.filter(function (r) { return r.empId === empId && r.year === state.year && r.month === month; })[0];
    var base = rec ? num(rec.base) : '';
    var bonus = rec ? num(rec.bonus) : '';
    var commission = rec ? num(rec.commission) : '';
    var remark = rec ? (rec.remark || '') : '';

    var body = '<div class="form">' +
      '<div class="form-row"><label>员工</label><div class="form-static">' + FW.esc(emp.name) + ' · ' + state.year + '年' + month + '月</div></div>' +
      '<div class="form-row"><label>底薪</label><input id="mBase" type="number" step="0.01" value="' + (base === '' ? '' : base) + '" placeholder="如 8000"></div>' +
      '<div class="form-row"><label>奖金</label><input id="mBonus" type="number" step="0.01" value="' + (bonus === '' ? '' : bonus) + '" placeholder="无则留空"></div>' +
      '<div class="form-row"><label>提成</label><input id="mCommission" type="number" step="0.01" value="' + (commission === '' ? '' : commission) + '" placeholder="无则留空"></div>' +
      '<div class="form-row"><label>备注</label><input id="mRemark" type="text" value="' + FW.esc(remark) + '" placeholder="如 项目提成 / 年终奖"></div>' +
      '</div>' +
      '<div class="modal-foot"><button class="btn" id="mDel">删除</button><button class="btn primary" id="mSave">保存</button></div>';

    FW.openModal(state.year + '年' + month + '月 · ' + emp.name, body, function () {
      document.getElementById('mSave').onclick = function () {
        var bs = document.getElementById('mBase').value;
        var bo = document.getElementById('mBonus').value;
        var co = document.getElementById('mCommission').value;
        if ((bs === '' || isNaN(parseFloat(bs))) && (bo === '' || isNaN(parseFloat(bo))) && (co === '' || isNaN(parseFloat(co)))) {
          FW.toast('请至少填写底薪 / 奖金 / 提成 中的一项'); return;
        }
        var recs2 = getRecs();
        var exist = recs2.filter(function (r) { return r.empId === empId && r.year === state.year && r.month === month; })[0];
        var obj = {
          empId: empId, year: state.year, month: month,
          base: bs === '' ? 0 : parseFloat(bs),
          bonus: bo === '' ? 0 : parseFloat(bo),
          commission: co === '' ? 0 : parseFloat(co),
          remark: document.getElementById('mRemark').value
        };
        if (exist) obj.id = exist.id; else obj.id = recId(empId, state.year, month);
        FW.db.upsert('salary_records', obj);
        FW.closeModal();
        FW.toast('已保存');
        render();
      };
      document.getElementById('mDel').onclick = function () {
        var recs2 = getRecs();
        var exist = recs2.filter(function (r) { return r.empId === empId && r.year === state.year && r.month === month; })[0];
        if (exist) { FW.db.remove('salary_records', exist.id); FW.toast('已删除该月'); }
        FW.closeModal();
        render();
      };
      document.getElementById('mBase').focus();
    });
  }

  // 员工管理
  function openEmpManager() {
    function draw() {
      var emps = getEmps();
      var body = '<div class="emp-list">';
      if (emps.length === 0) body += '<p class="sal-tip">还没有员工，导入工资时会自动新建，也可点下面「＋ 新增员工」手动添加。</p>';
      emps.forEach(function (e) {
        body += '<div class="emp-row">' +
          '<div class="emp-info"><span class="emp-name">' + FW.esc(e.name) + '</span>' +
          '<span class="emp-meta">部门：' + FW.esc(e.dept || '—') + (e.remark ? ' · ' + FW.esc(e.remark) : '') + '</span></div>' +
          '<div class="emp-ops"><button class="btn sm" data-edit="' + e.id + '">编辑</button> ' +
          '<button class="btn sm danger" data-del="' + e.id + '">删除</button></div>' +
          '</div>';
      });
      body += '</div>' +
        '<div class="modal-foot"><button class="btn" id="empAdd">＋ 新增员工</button></div>';

      FW.openModal('员工管理', body, function (b) {
        Array.prototype.forEach.call(b.querySelectorAll('[data-edit]'), function (btn) {
          btn.onclick = function () { openEmpForm(btn.getAttribute('data-edit')); };
        });
        Array.prototype.forEach.call(b.querySelectorAll('[data-del]'), function (btn) {
          btn.onclick = function () {
            if (!confirm('删除该员工？其所有月份工资记录也会一并删除。')) return;
            var id = btn.getAttribute('data-del');
            FW.db.remove('salary_employees', id);
            var recs = getRecs().filter(function (r) { return r.empId !== id; });
            FW.db.saveList('salary_records', recs);
            FW.toast('已删除');
            draw();
            render();
          };
        });
        document.getElementById('empAdd').onclick = function () { openEmpForm(null); };
      });
    }
    draw();
  }

  function openEmpForm(id) {
    var emps = getEmps();
    var e = id ? emps.filter(function (x) { return x.id === id; })[0] : null;
    var body = '<div class="form">' +
      '<div class="form-row"><label>姓名 *</label><input id="eName" type="text" value="' + (e ? FW.esc(e.name) : '') + '"></div>' +
      '<div class="form-row"><label>部门</label><input id="eDept" type="text" value="' + (e ? FW.esc(e.dept || '') : '') + '" placeholder="如 研发部"></div>' +
      '<div class="form-row"><label>备注</label><input id="eRemark" type="text" value="' + (e ? FW.esc(e.remark || '') : '') + '" placeholder="如 工号"></div>' +
      '</div>' +
      '<div class="modal-foot"><button class="btn primary" id="eSave">保存</button></div>';
    FW.openModal(id ? '编辑员工' : '新增员工', body, function () {
      document.getElementById('eSave').onclick = function () {
        var name = document.getElementById('eName').value.trim();
        if (!name) { FW.toast('请填写姓名'); return; }
        var obj = {
          name: name,
          dept: document.getElementById('eDept').value.trim(),
          remark: document.getElementById('eRemark').value.trim()
        };
        if (id) obj.id = id; else obj.id = 'emp_' + Date.now();
        FW.db.upsert('salary_employees', obj);
        FW.closeModal();
        FW.toast('已保存');
        openEmpManager();
        render();
      };
      document.getElementById('eName').focus();
    });
  }

  // ===== 导入：自动识别员工 + 底薪 + 奖金(提成) =====
  function csvSplit(line) {
    var out = [], cur = '', q = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (q) {
        if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += ch;
      } else {
        if (ch === '"') q = true;
        else if (ch === ',') { out.push(cur); cur = ''; }
        else cur += ch;
      }
    }
    out.push(cur);
    return out;
  }

  function decodeFile(file, enc, cb) {
    var r = new FileReader();
    r.onload = function () {
      var buf = new Uint8Array(r.result);
      var text = '';
      try {
        if (enc === 'utf8') text = (window.iconv ? window.iconv.decode(buf, 'utf-8') : new TextDecoder('utf-8').decode(buf));
        else if (enc === 'gbk') text = (window.iconv ? window.iconv.decode(buf, 'gbk') : new TextDecoder('gbk').decode(buf));
        else {
          var u = (window.iconv ? window.iconv.decode(buf, 'utf-8') : new TextDecoder('utf-8').decode(buf));
          text = ((u.match(/�/g) || []).length === 0) ? u : (window.iconv ? window.iconv.decode(buf, 'gbk') : new TextDecoder('gbk').decode(buf));
        }
      } catch (e) { text = ''; }
      cb((text || '').replace(/^﻿/, ''));
    };
    r.onerror = function () { cb(''); };
    r.readAsArrayBuffer(file);
  }

  // 读取文件 → 行数组（array of arrays）
  function readFileRows(file, enc, cb) {
    var fname = (file.name || '').toLowerCase();
    if (/\.(xlsx|xls)$/.test(fname)) {
      if (typeof XLSX === 'undefined') { FW.toast('Excel 解析库未加载，请刷新页面后重试'); cb(null); return; }
      var fr = new FileReader();
      fr.onload = function () {
        try {
          var wb = XLSX.read(new Uint8Array(fr.result), { type: 'array' });
          if (!wb.SheetNames.length) { FW.toast('Excel 中没有工作表'); cb(null); return; }
          var ws = wb.Sheets[wb.SheetNames[0]];
          var rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
          while (rows.length && rows[rows.length - 1].every(function (c) { return c === '' || c == null; })) rows.pop();
          cb(rows);
        } catch (e) { FW.toast('Excel 解析失败：' + (e && e.message ? e.message : e)); cb(null); }
      };
      fr.onerror = function () { FW.toast('文件读取失败'); cb(null); };
      fr.readAsArrayBuffer(file);
      return;
    }
    decodeFile(file, enc, function (text) {
      if (!text) { FW.toast('文件读取失败'); cb(null); return; }
      var lines = text.split(/\r?\n/).filter(function (l) { return l.trim(); });
      if (!lines.length) { cb([]); return; }
      cb(lines.map(function (l) { return csvSplit(l); }));
    });
  }

  function guessSalaryMap(headers) {
    function find(words, used) {
      for (var i = 0; i < headers.length; i++) {
        if (used[i]) continue;
        var h = (headers[i] || '').toLowerCase().replace(/\s+/g, '');
        for (var w = 0; w < words.length; w++) if (h.indexOf(words[w]) > -1) { used[i] = true; return i; }
      }
      return -1;
    }
    var used = {};
    var g = {};
    g.name = find(['姓名', '名字', '员工', '员工姓名', '职员', '名称', 'name'], used);
    g.dept = find(['部门', 'department', 'dept'], used);
    g.month = find(['月份', '月', '期间', 'month'], used);
    g.year = find(['年份', '年', 'year'], used);
    g.base = find(['底薪', '基础工资', '基本工资', '固定工资', '基本', '工资', '应发', '金额', '实发', 'base'], used);
    g.commission = find(['提成', '佣金', '返佣', '销售提成', '提', 'commission'], used);
    g.bonus = find(['奖金', '绩效', '绩效工资', '津贴', '补贴', '奖金提成', 'bonus'], used);
    return g;
  }

  function parseYM(s, defYear) {
    s = (s == null ? '' : String(s)).trim();
    if (!s) return { year: defYear, month: 0 };
    var m = s.match(/(\d{4})[.\-\/年](\d{1,2})(?:[.\-\/月](\d{1,2}))?/);
    if (m) { var y = +m[1], mo = +m[2]; return { year: y, month: (mo >= 1 && mo <= 12) ? mo : 0 }; }
    var m2 = s.match(/^(\d{1,2})\s*月?$/);
    if (m2) { var mo2 = +m2[1]; return { year: defYear, month: (mo2 >= 1 && mo2 <= 12) ? mo2 : 0 }; }
    var m3 = s.match(/^(\d{4})$/);
    if (m3) return { year: +m3[1], month: 0 };
    return { year: defYear, month: 0 };
  }

  function parseYear(s) {
    s = (s == null ? '' : String(s)).trim();
    var m = s.match(/(\d{4})/);
    return m ? +m[1] : 0;
  }

  // 把数据行按列映射解析为记录；自动识别新建员工
  function parseSalaryRows(rows, m, defYear, defMonth) {
    var nameCol = m.name !== 'ignore' ? +m.name : -1;
    var deptCol = m.dept !== 'ignore' ? +m.dept : -1;
    var monthCol = m.month !== 'ignore' ? +m.month : -1;
    var yearCol = m.year !== 'ignore' ? +m.year : -1;
    var baseCol = m.base !== 'ignore' ? +m.base : -1;
    var bonusCol = m.bonus !== 'ignore' ? +m.bonus : -1;
    var commissionCol = m.commission !== 'ignore' ? +m.commission : -1;
    if (nameCol < 0) return { rows: [], skipped: rows.length, newEmps: [], deptByEmp: {} };

    var out = [], skipped = 0;
    var newEmpSet = {}; // lower -> original name
    var deptByEmp = {};
    var existing = getEmps().map(function (e) { return (e.name || '').trim().toLowerCase(); });

    rows.forEach(function (r) {
      var name = (r[nameCol] != null ? String(r[nameCol]) : '').trim();
      if (!name) { skipped++; return; }
      var dept = deptCol >= 0 ? (r[deptCol] != null ? String(r[deptCol]) : '').trim() : '';
      var year = defYear, month = defMonth;
      if (monthCol >= 0) { var ym = parseYM(r[monthCol], defYear); year = ym.year; month = ym.month; }
      if (yearCol >= 0) { var y2 = parseYear(r[yearCol]); if (y2) year = y2; }
      if (!month || month < 1 || month > 12) { skipped++; return; }

      var base = 0, bonus = 0, commission = 0;
      if (baseCol >= 0) base = num(r[baseCol]);
      if (bonusCol >= 0) bonus = num(r[bonusCol]);
      if (commissionCol >= 0) commission = num(r[commissionCol]);
      if (baseCol < 0 && bonusCol < 0 && commissionCol < 0) { skipped++; return; }
      var amount = base + bonus + commission;
      if (amount === 0) { skipped++; return; }

      var key = name.toLowerCase();
      if (existing.indexOf(key) < 0 && !newEmpSet[key]) {
        newEmpSet[key] = name;
        if (dept) deptByEmp[name] = dept;
      }
      out.push({ name: name, dept: dept, year: year, month: month, base: base, bonus: bonus, commission: commission, amount: amount });
    });

    var newEmps = Object.keys(newEmpSet).map(function (k) { return newEmpSet[k]; });
    return { rows: out, skipped: skipped, newEmps: newEmps, deptByEmp: deptByEmp };
  }

  function openImport() {
    var body = '<div class="form">' +
      '<div class="form-row"><label>选择文件（Excel .xlsx/.xls 或 CSV）</label><input type="file" id="salFile" accept=".csv,.xlsx,.xls,text/csv"></div>' +
      '<div class="form-row"><label>CSV 编码</label><select id="salEnc"><option value="auto">自动</option><option value="gbk">GBK（老 Excel 导出）</option><option value="utf8">UTF-8</option></select></div>' +
      '<div class="muted" style="font-size:12px;margin-top:4px">每行 = 某员工某月。系统自动识别 姓名 / 部门 / 月份 / 年份 / 底薪 / 奖金 / 提成 列，并<strong>自动新建未存在的员工</strong>，无需手动添加。</div>' +
      '</div>' +
      '<div class="modal-foot"><button class="btn" id="salImpCancel">取消</button><button class="btn primary" id="salImpParse">解析</button></div>';
    FW.openModal('导入工资（自动识别员工）', body, function () {
      document.getElementById('salImpCancel').onclick = FW.closeModal;
      document.getElementById('salImpParse').onclick = function () {
        var file = document.getElementById('salFile').files[0];
        if (!file) { FW.toast('请先选择文件'); return; }
        var enc = document.getElementById('salEnc').value;
        readFileRows(file, enc, function (rows) {
          if (!rows || rows.length < 2) { FW.toast('文件中没有足够的数据行'); return; }
          var headers = rows[0].map(function (c) { return c == null ? '' : String(c); });
          var dataRows = rows.slice(1);
          FW.closeModal();
          openImportMap(headers, dataRows);
        });
      };
    });
  }

  function openImportMap(headers, dataRows) {
    var guess = guessSalaryMap(headers);
    var roles = [['ignore', '忽略'], ['name', '姓名'], ['dept', '部门'], ['month', '月份'], ['year', '年份'], ['base', '底薪'], ['bonus', '奖金'], ['commission', '提成']];
    var map = {};
    var selHtml = headers.map(function (h, i) {
      var def = guess.name === i ? 'name' : (guess.dept === i ? 'dept' : (guess.month === i ? 'month' : (guess.year === i ? 'year' : (guess.base === i ? 'base' : (guess.bonus === i ? 'bonus' : (guess.commission === i ? 'commission' : 'ignore'))))));
      map[i] = def;
      var opts = roles.map(function (r) { return '<option value="' + r[0] + '"' + (def === r[0] ? ' selected' : '') + '>' + r[1] + '</option>'; }).join('');
      return '<div class="form-row"><label>' + FW.esc(h || ('列' + (i + 1))) + '</label><select data-col="' + i + '">' + opts + '</select></div>';
    }).join('');

    var body = '<div class="form" style="max-height:46vh;overflow:auto">' + selHtml + '</div>' +
      '<div class="form-row"><label>默认年份（无年份列时）</label><input id="salDefYear" type="number" value="' + state.year + '"></div>' +
      '<div class="form-row"><label>默认月份（无月份列时，留空则须文件内含月份）</label><input id="salDefMonth" type="number" min="1" max="12" placeholder="如 3"></div>' +
      '<div id="salPrev" class="muted" style="font-size:12px;margin:8px 0"></div>' +
      '<div class="modal-foot"><button class="btn" id="salMapCancel">取消</button><button class="btn" id="salMapPrev">预览</button><button class="btn primary" id="salMapOk">确认导入</button></div>';

    FW.openModal('导入工资 · 列映射', body, function () {
      function build() {
        var m = {};
        Array.prototype.forEach.call(document.querySelectorAll('select[data-col]'), function (s) { m[s.getAttribute('data-col')] = s.value; });
        var defYear = parseInt(document.getElementById('salDefYear').value, 10) || state.year;
        var defMonth = parseInt(document.getElementById('salDefMonth').value, 10) || 0;
        return parseSalaryRows(dataRows, m, defYear, defMonth);
      }
      document.getElementById('salMapCancel').onclick = FW.closeModal;
      document.getElementById('salMapPrev').onclick = function () {
        var r = build();
        document.getElementById('salPrev').innerHTML = '可导入 <b>' + r.rows.length + '</b> 条，新建员工 <b>' + r.newEmps.length + '</b> 人，跳过 ' + r.skipped + ' 行。' +
          (r.newEmps.length ? '<br>新建：' + FW.esc(r.newEmps.join('、')) : '');
      };
      document.getElementById('salMapOk').onclick = function () {
        var r = build();
        if (!r.rows.length) { FW.toast('没有可导入的数据'); return; }
        var emps = getEmps();
        var byName = {};
        emps.forEach(function (e) { byName[(e.name || '').trim().toLowerCase()] = e; });
        r.newEmps.forEach(function (nm) {
          var e = { id: 'emp_' + Date.now() + '_' + Math.floor(Math.random() * 1000), name: nm, dept: r.deptByEmp[nm] || '', remark: '' };
          FW.db.upsert('salary_employees', e);
          byName[nm.toLowerCase()] = e;
        });
        r.rows.forEach(function (rec) {
          var emp = byName[(rec.name || '').trim().toLowerCase()];
          if (!emp) return;
          var id = recId(emp.id, rec.year, rec.month);
          FW.db.upsert('salary_records', { id: id, empId: emp.id, year: rec.year, month: rec.month, base: rec.base, bonus: rec.bonus, commission: rec.commission, remark: (rec.dept ? '' : '') });
        });
        FW.closeModal();
        FW.toast('已导入 ' + r.rows.length + ' 条，新建 ' + r.newEmps.length + ' 名员工');
        render();
      };
    });
  }

  function exportCSV(rows) {
    var header = ['员工', '部门'];
    MONTHS.forEach(function (m) { header.push(m + '底薪', m + '奖金', m + '提成', m + '金额'); });
    header.push('累计底薪', '累计奖金', '累计提成', '累计金额');
    var lines = [header.join(',')];
    rows.forEach(function (rw) {
      var byMonth = {};
      rw.calc.months.forEach(function (m) { byMonth[m.month] = m; });
      var line = [rw.emp.name, rw.emp.dept || ''];
      for (var mo = 1; mo <= 12; mo++) {
        var m = byMonth[mo];
        line.push(m ? m.base : '', m ? m.bonus : '', m ? m.commission : '', m ? m.amount : '');
      }
      line.push(rw.calc.cumBase, rw.calc.cumBonus, rw.calc.cumCommission, rw.calc.cumAmount);
      lines.push(line.join(','));
    });
    var csv = lines.join('\r\n');
    var blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = '工资登记_' + state.year + '.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    FW.toast('已导出 CSV');
  }

  FW.modules = FW.modules || {};
  FW.modules.salary = {
    title: '工资登记',
    render: render
  };
})(window);
