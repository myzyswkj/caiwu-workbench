(function (window) {
  'use strict';
  var FW = window.FW || (window.FW = {});

  function num(v) {
    var n = parseFloat(v);
    return isNaN(n) ? 0 : n;
  }

  // ===== 数据说明 =====
  // salary_employees: { id, name, dept, remark }
  // salary_records:   { id, empId, year, month, base(底薪), bonus(奖金), remark }
  // 每笔金额 = 底薪 + 奖金；每人累计 = 各月(底薪+奖金)之和

  function getEmps() { return FW.db.getList('salary_employees'); }
  function getRecs() { return FW.db.getList('salary_records'); }

  function recId(empId, year, month) { return empId + '-' + year + '-' + month; }

  // 兼容旧数据：旧记录只含 salary 字段 → 记作底薪
  function normalizeRec(r) {
    var base = num(r.base);
    var bonus = num(r.bonus);
    if (r.base == null && r.bonus == null && r.salary != null) {
      base = num(r.salary); bonus = 0;
    }
    return { empId: r.empId, year: r.year, month: r.month, base: base, bonus: bonus, remark: r.remark || '' };
  }

  function computeEmpYear(emp, recs, year) {
    var months = (recs || []).map(normalizeRec).sort(function (a, b) { return a.month - b.month; });
    var cumBase = 0, cumBonus = 0, cumAmount = 0;
    var list = months.map(function (r) {
      var amount = r.base + r.bonus;
      cumBase += r.base; cumBonus += r.bonus; cumAmount += amount;
      return { month: r.month, base: r.base, bonus: r.bonus, amount: amount, remark: r.remark };
    });
    return { months: list, cumBase: cumBase, cumBonus: cumBonus, cumAmount: cumAmount };
  }

  function computeYear(emps, recs, year) {
    return emps.map(function (emp) {
      var er = recs.filter(function (r) { return r.empId === emp.id; });
      return { emp: emp, calc: computeEmpYear(emp, er, year) };
    });
  }

  FW.salaryCalc = { computeEmpYear: computeEmpYear, computeYear: computeYear, num: num };

  // ===== 渲染 =====
  var state = { year: new Date().getFullYear() };
  var MONTHS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];

  function render() {
    var emps = getEmps();
    var recs = getRecs();
    var rows = computeYear(emps, recs, state.year);

    var totalBase = 0, totalBonus = 0, totalAmount = 0;
    rows.forEach(function (rw) {
      totalBase += rw.calc.cumBase;
      totalBonus += rw.calc.cumBonus;
      totalAmount += rw.calc.cumAmount;
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
      statCard('累计底薪', FW.fmtMoney(totalBase)) +
      statCard('累计奖金', FW.fmtMoney(totalBonus)) +
      statCard('累计金额', FW.fmtMoney(totalAmount)) +
      '</div>';

    html += '<p class="sal-tip">💡 工资登记：逐月登记每个人的<strong>底薪</strong>与<strong>奖金</strong>，每笔金额 = 底薪 + 奖金，右侧自动累计每个人的底薪、奖金与总金额。点击某月格子可录入 / 修改。</p>';

    if (emps.length === 0) {
      html += '<div class="empty-state">' +
        '<div class="empty-ico">💰</div>' +
        '<div class="empty-title">还没有员工</div>' +
        '<div class="empty-sub">先到「👥 员工管理」添加员工，再逐月登记工资底薪与奖金。</div>' +
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
    html += '<th>累计底薪</th><th>累计奖金</th><th>累计金额</th></tr></thead><tbody>';

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
            '<div class="cell-amt">= ' + FW.fmtMoney(m.amount) + '</div></td>';
        } else {
          html += '<td class="cell-empty" data-emp="' + emp.id + '" data-month="' + mo + '" title="点击录入">' +
            '<span class="plus">＋</span></td>';
        }
      }
      html += '<td class="col-sum base">' + FW.fmtMoney(rw.calc.cumBase) + '</td>' +
        '<td class="col-sum bonus">' + FW.fmtMoney(rw.calc.cumBonus) + '</td>' +
        '<td class="col-sum amount">' + FW.fmtMoney(rw.calc.cumAmount) + '</td></tr>';
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
    var base = rec ? num(rec.base) : '';
    var bonus = rec ? num(rec.bonus) : '';
    var remark = rec ? (rec.remark || '') : '';

    var body = '<div class="form">' +
      '<div class="form-row"><label>员工</label><div class="form-static">' + FW.esc(emp.name) + ' · ' + state.year + '年' + month + '月</div></div>' +
      '<div class="form-row"><label>底薪 *</label><input id="mBase" type="number" step="0.01" value="' + (base === '' ? '' : base) + '" placeholder="如 8000"></div>' +
      '<div class="form-row"><label>奖金</label><input id="mBonus" type="number" step="0.01" value="' + (bonus === '' ? '' : bonus) + '" placeholder="绩效/提成等，无则留空"></div>' +
      '<div class="form-row"><label>备注</label><input id="mRemark" type="text" value="' + FW.esc(remark) + '" placeholder="如 项目奖金"></div>' +
      '</div>';

    FW.openModal(state.year + '年' + month + '月 · ' + emp.name, body, {
      onShow: function (b) {
        var save = function () {
          var bs = FW.qa('#mBase').value;
          if (bs === '' || isNaN(parseFloat(bs))) { FW.toast('请填写底薪'); return; }
          var recs2 = getRecs();
          var exist = recs2.filter(function (r) { return r.empId === empId && r.year === state.year && r.month === month; })[0];
          var obj = {
            empId: empId, year: state.year, month: month,
            base: parseFloat(bs),
            bonus: FW.qa('#mBonus').value === '' ? 0 : parseFloat(FW.qa('#mBonus').value),
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
        FW.qa('#mBase').focus();
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
          '<span class="emp-meta">部门：' + FW.esc(e.dept || '—') + (e.remark ? ' · ' + FW.esc(e.remark) : '') + '</span></div>' +
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
      '<div class="form-row"><label>部门</label><input id="eDept" type="text" value="' + (e ? FW.esc(e.dept || '') : '') + '" placeholder="如 研发部"></div>' +
      '<div class="form-row"><label>备注</label><input id="eRemark" type="text" value="' + (e ? FW.esc(e.remark || '') : '') + '" placeholder="如 工号"></div>' +
      '</div>';
    FW.openModal(id ? '编辑员工' : '新增员工', body, {
      onShow: function (b) {
        var save = function () {
          var name = FW.qa('#eName').value.trim();
          if (!name) { FW.toast('请填写姓名'); return; }
          var obj = {
            name: name,
            dept: FW.qa('#eDept').value.trim(),
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
    MONTHS.forEach(function (m) { header.push(m + '底薪', m + '奖金', m + '金额'); });
    header.push('累计底薪', '累计奖金', '累计金额');
    var lines = [header.join(',')];
    rows.forEach(function (rw) {
      var byMonth = {};
      rw.calc.months.forEach(function (m) { byMonth[m.month] = m; });
      var line = [rw.emp.name, rw.emp.dept || ''];
      for (var mo = 1; mo <= 12; mo++) {
        var m = byMonth[mo];
        line.push(m ? m.base : '', m ? m.bonus : '', m ? m.amount : '');
      }
      line.push(rw.calc.cumBase, rw.calc.cumBonus, rw.calc.cumAmount);
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
