(function (window) {
  'use strict';
  var FW = window.FW || (window.FW = {});

  // ===== 工资薪金累计预扣率表（同个人所得税年度税率表）=====
  var BRACKETS = [
    { up: 36000,    rate: 0.03, deduct: 0 },
    { up: 144000,   rate: 0.10, deduct: 2520 },
    { up: 300000,   rate: 0.20, deduct: 16920 },
    { up: 420000,   rate: 0.25, deduct: 31920 },
    { up: 660000,   rate: 0.30, deduct: 52920 },
    { up: 960000,   rate: 0.35, deduct: 85920 },
    { up: Infinity, rate: 0.45, deduct: 181920 }
  ];

  function num(v) {
    var n = parseFloat(v);
    return isNaN(n) ? 0 : n;
  }

  // 累计应纳税所得额 -> 累计应纳税额
  function calcAnnualTax(taxable) {
    if (taxable <= 0) return 0;
    for (var i = 0; i < BRACKETS.length; i++) {
      if (taxable <= BRACKETS[i].up) {
        return taxable * BRACKETS[i].rate - BRACKETS[i].deduct;
      }
    }
    return 0;
  }

  // 计算某员工某年工资（累计预扣法）
  // emp: { startMonth, socialDefault, specialAddDefault }
  // recs: [{ empId, year, month, salary, social, specialAdd, exemption }]
  function computeEmpYear(emp, recs, year) {
    var filled = (recs || []).map(function (r) {
      return {
        month: r.month,
        salary: num(r.salary),
        social: (r.social != null && r.social !== '') ? num(r.social) : num(emp.socialDefault),
        specialAdd: (r.specialAdd != null && r.specialAdd !== '') ? num(r.specialAdd) : num(emp.specialAddDefault),
        exemption: (r.exemption != null && r.exemption !== '') ? num(r.exemption) : 0
      };
    }).sort(function (a, b) { return a.month - b.month; });

    var cumSalary = 0, cumExem = 0, cumSocial = 0, cumSpecial = 0, cumTax = 0, payCount = 0;
    var months = [];
    filled.forEach(function (r) {
      payCount++;
      cumSalary += r.salary;
      cumExem += r.exemption;
      cumSocial += r.social;
      cumSpecial += r.specialAdd;
      var deduct = 5000 * payCount; // 累计减除费用：每月5000，按当年已发薪月累计
      var taxable = cumSalary - cumExem - deduct - cumSocial - cumSpecial;
      var annualTax = calcAnnualTax(taxable);
      var tax = Math.max(0, annualTax - cumTax);
      cumTax = annualTax;
      var net = r.salary - r.social - tax;
      months.push({
        month: r.month, salary: r.salary, social: r.social, specialAdd: r.specialAdd,
        exemption: r.exemption, taxable: taxable, cumTax: annualTax,
        tax: tax, net: net, payCount: payCount
      });
    });

    var totals = months.reduce(function (a, m) {
      a.salary += m.salary; a.social += m.social; a.specialAdd += m.specialAdd;
      a.exemption += m.exemption; a.tax += m.tax; a.net += m.net;
      return a;
    }, { salary: 0, social: 0, specialAdd: 0, exemption: 0, tax: 0, net: 0 });

    return { months: months, totals: totals };
  }

  // 计算某年全体员工
  function computeYear(emps, recs, year) {
    return emps.map(function (emp) {
      var er = recs.filter(function (r) { return r.empId === emp.id; });
      return { emp: emp, calc: computeEmpYear(emp, er, year) };
    });
  }

  FW.salaryCalc = {
    BRACKETS: BRACKETS, calcAnnualTax: calcAnnualTax,
    computeEmpYear: computeEmpYear, computeYear: computeYear, num: num
  };

  // ===== 渲染 =====
  var state = { year: new Date().getFullYear() };
  var MONTHS = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];

  function getEmps() { return FW.db.getList('salary_employees'); }
  function getRecs() { return FW.db.getList('salary_records'); }

  function recId(empId, year, month) { return empId + '-' + year + '-' + month; }

  function render() {
    var emps = getEmps();
    var recs = getRecs();
    var rows = computeYear(emps, recs, state.year);

    var totalSalary = 0, totalSocial = 0, totalTax = 0, totalNet = 0;
    rows.forEach(function (rw) {
      totalSalary += rw.calc.totals.salary;
      totalSocial += rw.calc.totals.social;
      totalTax += rw.calc.totals.tax;
      totalNet += rw.calc.totals.net;
    });

    // 顶部操作
    var top = FW.qa('#topActions');
    if (top) {
      top.innerHTML =
        '<button class="btn" id="salPrevYear">‹ ' + (state.year - 1) + '</button>' +
        '<span class="yr-label">' + state.year + ' 年</span>' +
        '<button class="btn" id="salNextYear">' + (state.year + 1) + ' ›</button>' +
        '<button class="btn primary" id="salEmpBtn">👥 员工管理</button>' +
        '<button class="btn" id="salPrint">🖨 打印</button>' +
        '<button class="btn" id="salExport">⬇ 导出CSV</button>';
      FW.qa('#salPrevYear').onclick = function () { state.year--; render(); };
      FW.qa('#salNextYear').onclick = function () { state.year++; render(); };
      FW.qa('#salEmpBtn').onclick = openEmpManager;
      FW.qa('#salPrint').onclick = function () { window.print(); };
      FW.qa('#salExport').onclick = function () { exportCSV(rows); };
    }

    var html = '';
    html += '<div class="salary-wrap">';

    // 汇总卡
    html += '<div class="sal-stats">' +
      statCard('员工人数', emps.length + ' 人') +
      statCard('全年应发', FW.fmtMoney(totalSalary)) +
      statCard('三险一金', FW.fmtMoney(totalSocial)) +
      statCard('全年个税', FW.fmtMoney(totalTax)) +
      statCard('全年实发', FW.fmtMoney(totalNet)) +
      '</div>';

    // 说明
    html += '<p class="sal-tip">💡 采用<strong>累计预扣法</strong>计算工资薪金个税（基本减除费用每月 5000 元，按当年已发薪月累计）。点击某月「应发」格可录入/修改。专项扣除（三险一金）、专项附加扣除取员工默认值，可在格子内覆盖。</p>';

    if (emps.length === 0) {
      html += '<div class="empty-state">' +
        '<div class="empty-ico">💰</div>' +
        '<div class="empty-title">还没有员工</div>' +
        '<div class="empty-sub">先到「👥 员工管理」添加员工，再逐月录入工资即可自动算个税。</div>' +
        '<button class="btn primary" id="salEmpBtn2">＋ 添加员工</button>' +
        '</div>';
      html += '</div>';
      var c = FW.qa('#content'); if (c) c.innerHTML = html;
      var b2 = FW.qa('#salEmpBtn2'); if (b2) b2.onclick = openEmpManager;
      return;
    }

    // 工资表
    html += '<div class="salary-table-wrap print-area"><table class="salary-table"><thead><tr>' +
      '<th class="col-emp">员工 / 部门</th>';
    MONTHS.forEach(function (m) { html += '<th>' + m + '</th>'; });
    html += '<th>全年应发</th><th>全年个税</th><th>全年实发</th></tr></thead><tbody>';

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
            '<div class="cell-sal">' + FW.fmtMoney(m.salary) + '</div>' +
            '<div class="cell-tax">税 ' + FW.fmtMoney(m.tax) + '</div></td>';
        } else {
          html += '<td class="cell-empty" data-emp="' + emp.id + '" data-month="' + mo + '" title="点击录入">' +
            '<span class="plus">＋</span></td>';
        }
      }
      html += '<td class="col-sum">' + FW.fmtMoney(rw.calc.totals.salary) + '</td>' +
        '<td class="col-sum tax">' + FW.fmtMoney(rw.calc.totals.tax) + '</td>' +
        '<td class="col-sum net">' + FW.fmtMoney(rw.calc.totals.net) + '</td></tr>';
    });

    html += '</tbody></table></div>';
    html += '</div>';

    var c2 = FW.qa('#content'); if (c2) c2.innerHTML = html;

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
    var salary = rec ? rec.salary : '';
    var social = rec ? rec.social : emp.socialDefault;
    var specialAdd = rec ? rec.specialAdd : emp.specialAddDefault;
    var exemption = rec ? rec.exemption : '';
    var remark = rec ? (rec.remark || '') : '';

    var body = '<div class="form">' +
      '<div class="form-row"><label>员工</label><div class="form-static">' + FW.esc(emp.name) + ' · ' + state.year + '年' + month + '月</div></div>' +
      '<div class="form-row"><label>应发工资 *</label><input id="mSalary" type="number" step="0.01" value="' + (salary === '' ? '' : salary) + '" placeholder="本月应发合计"></div>' +
      '<div class="form-row"><label>三险一金(个人)</label><input id="mSocial" type="number" step="0.01" value="' + (social === '' ? '' : social) + '" placeholder="默认 ' + (emp.socialDefault || 0) + '"></div>' +
      '<div class="form-row"><label>专项附加扣除</label><input id="mSpecial" type="number" step="0.01" value="' + (specialAdd === '' ? '' : specialAdd) + '" placeholder="默认 ' + (emp.specialAddDefault || 0) + '"></div>' +
      '<div class="form-row"><label>免税收入</label><input id="mExem" type="number" step="0.01" value="' + (exemption === '' ? '' : exemption) + '" placeholder="如差旅津贴等"></div>' +
      '<div class="form-row"><label>备注</label><input id="mRemark" type="text" value="' + FW.esc(remark) + '"></div>' +
      '</div>';

    FW.openModal(state.year + '年' + month + '月 · ' + emp.name, body, {
      onShow: function (b) {
        var save = function () {
          var s = FW.qa('#mSalary').value;
          if (s === '' || isNaN(parseFloat(s))) { FW.toast('请填写应发工资'); return; }
          var recs2 = getRecs();
          var exist = recs2.filter(function (r) { return r.empId === empId && r.year === state.year && r.month === month; })[0];
          var obj = {
            empId: empId, year: state.year, month: month,
            salary: parseFloat(s),
            social: FW.qa('#mSocial').value === '' ? '' : parseFloat(FW.qa('#mSocial').value),
            specialAdd: FW.qa('#mSpecial').value === '' ? '' : parseFloat(FW.qa('#mSpecial').value),
            exemption: FW.qa('#mExem').value === '' ? '' : parseFloat(FW.qa('#mExem').value),
            remark: FW.qa('#mRemark').value
          };
          if (exist) obj.id = exist.id; else obj.id = recId(empId, state.year, month);
          FW.db.upsert('salary_records', obj);
          FW.closeModal();
          FW.toast('已保存');
          render();
        };
        var del = function () {
          var recs2 = getRecs();
          var exist = recs2.filter(function (r) { return r.empId === empId && r.year === state.year && r.month === month; })[0];
          if (exist) { FW.db.remove('salary_records', exist.id); FW.toast('已删除该月'); FW.closeModal(); render(); }
          else FW.closeModal();
        };
        var foot = document.createElement('div');
        foot.className = 'modal-foot';
        foot.innerHTML = '<button class="btn" id="mDel">删除</button><button class="btn primary" id="mSave">保存</button>';
        b.appendChild(foot);
        FW.qa('#mSave').onclick = save;
        FW.qa('#mDel').onclick = del;
        FW.qa('#mSalary').focus();
      }
    });
  }

  // 员工管理
  function openEmpManager() {
    function draw() {
      var emps = getEmps();
      var body = '<div class="emp-list">';
      if (emps.length === 0) body += '<p class="sal-tip">还没有员工，点下面「＋ 新增员工」添加。</p>';
      emps.forEach(function (e) {
        body += '<div class="emp-row">' +
          '<div class="emp-info"><span class="emp-name">' + FW.esc(e.name) + '</span>' +
          '<span class="emp-meta">部门：' + FW.esc(e.dept || '—') + ' · 入职：' + (e.startMonth || 1) + '月 · 默认三险一金 ' + FW.fmtMoney(e.socialDefault || 0) + ' · 专项附加 ' + FW.fmtMoney(e.specialAddDefault || 0) + '</span></div>' +
          '<div class="emp-ops"><button class="btn sm" data-edit="' + e.id + '">编辑</button> ' +
          '<button class="btn sm danger" data-del="' + e.id + '">删除</button></div>' +
          '</div>';
      });
      body += '</div>' +
        '<div class="modal-foot"><button class="btn" id="empAdd">＋ 新增员工</button></div>';

      FW.openModal('员工管理', body, {
        onShow: function (b) {
          Array.prototype.forEach.call(b.querySelectorAll('[data-edit]'), function (btn) {
            btn.onclick = function () { openEmpForm(btn.getAttribute('data-edit')); };
          });
          Array.prototype.forEach.call(b.querySelectorAll('[data-del]'), function (btn) {
            btn.onclick = function () {
              if (!confirm('删除该员工？其所有月份工资记录也会一并删除。')) return;
              var id = btn.getAttribute('data-del');
              FW.db.remove('salary_employees', id);
              // 删除其全部工资记录
              var recs = getRecs().filter(function (r) { return r.empId !== id; });
              FW.db.saveList('salary_records', recs);
              FW.toast('已删除');
              draw();
              render();
            };
          });
          FW.qa('#empAdd').onclick = function () { openEmpForm(null); };
        }
      });
    }
    draw();
  }

  function openEmpForm(id) {
    var emps = getEmps();
    var e = id ? emps.filter(function (x) { return x.id === id; })[0] : null;
    var body = '<div class="form">' +
      '<div class="form-row"><label>姓名 *</label><input id="eName" type="text" value="' + (e ? FW.esc(e.name) : '') + '"></div>' +
      '<div class="form-row"><label>部门</label><input id="eDept" type="text" value="' + (e ? FW.esc(e.dept || '') : '') + '"></div>' +
      '<div class="form-row"><label>入职月份</label><select id="eStart">' +
      (function () { var s = ''; for (var i = 1; i <= 12; i++) s += '<option value="' + i + '"' + ((e ? (e.startMonth || 1) : 1) === i ? ' selected' : '') + '>' + i + '月</option>'; return s; })() +
      '</select></div>' +
      '<div class="form-row"><label>月三险一金默认</label><input id="eSocial" type="number" step="0.01" value="' + (e ? (e.socialDefault || '') : '') + '" placeholder="个人承担部分"></div>' +
      '<div class="form-row"><label>月专项附加默认</label><input id="eSpecial" type="number" step="0.01" value="' + (e ? (e.specialAddDefault || '') : '') + '" placeholder="子女教育/房贷/赡养等"></div>' +
      '<div class="form-row"><label>备注</label><input id="eRemark" type="text" value="' + (e ? FW.esc(e.remark || '') : '') + '"></div>' +
      '</div>';
    FW.openModal(id ? '编辑员工' : '新增员工', body, {
      onShow: function (b) {
        var save = function () {
          var name = FW.qa('#eName').value.trim();
          if (!name) { FW.toast('请填写姓名'); return; }
          var obj = {
            name: name,
            dept: FW.qa('#eDept').value.trim(),
            startMonth: parseInt(FW.qa('#eStart').value, 10) || 1,
            socialDefault: FW.qa('#eSocial').value === '' ? 0 : parseFloat(FW.qa('#eSocial').value),
            specialAddDefault: FW.qa('#eSpecial').value === '' ? 0 : parseFloat(FW.qa('#eSpecial').value),
            remark: FW.qa('#eRemark').value.trim()
          };
          if (id) obj.id = id; else obj.id = 'emp_' + Date.now();
          FW.db.upsert('salary_employees', obj);
          FW.closeModal();
          FW.toast('已保存');
          openEmpManager();
          render();
        };
        var foot = document.createElement('div');
        foot.className = 'modal-foot';
        foot.innerHTML = '<button class="btn primary" id="eSave">保存</button>';
        b.appendChild(foot);
        FW.qa('#eSave').onclick = save;
        FW.qa('#eName').focus();
      }
    });
  }

  function exportCSV(rows) {
    var header = ['员工', '部门'];
    MONTHS.forEach(function (m) { header.push(m + '应发'); });
    header.push('全年应发', '全年个税', '全年实发');
    var lines = [header.join(',')];
    rows.forEach(function (rw) {
      var byMonth = {};
      rw.calc.months.forEach(function (m) { byMonth[m.month] = m; });
      var line = [rw.emp.name, rw.emp.dept || ''];
      for (var mo = 1; mo <= 12; mo++) {
        line.push(byMonth[mo] ? byMonth[mo].salary : '');
      }
      line.push(rw.calc.totals.salary, rw.calc.totals.tax, rw.calc.totals.net);
      lines.push(line.join(','));
    });
    var csv = lines.join('\r\n');
    var blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = '工资个税_' + state.year + '.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    FW.toast('已导出 CSV');
  }

  FW.modules = FW.modules || {};
  FW.modules.salary = {
    title: '工资个税',
    render: render
  };
})(window);
