(function (window) {
  'use strict';
  var FW = window.FW || (window.FW = {});

  function num(v) {
    if (v == null) return 0;
    // Excel 常用千分位（10,000.00）或带 ¥/$ 符号，parseFloat 会在逗号处截断，先清理
    var s = String(v).replace(/[\s\u00a5\u0024\uffe5]/g, '').replace(/,/g, '');
    var n = parseFloat(s);
    return isNaN(n) ? 0 : n;
  }

  // ===== 数据说明 =====
  // salary_employees: { id, name, dept, remark }
  // salary_records:   { id, empId, year, month, base(底薪合计), bonus(奖金合计), commission(提成合计),
  //                     baseItems:[{project,amount}], bonusItems:[{project,amount}], commissionItems:[{project,amount}], remark }
  // 底薪/奖金/提成均可按 项目/客户 分类记录；base/bonus/commission 为各 items 之和（兼容旧数据）
  // 每笔金额 = 底薪 + 奖金 + 提成；每人累计 = 各月(底薪+奖金+提成)之和

  function getEmps() { return FW.db.getList('salary_employees'); }
  function getRecs() { return FW.db.getList('salary_records'); }

  // 收集所有已出现过的项目名称（项目核算 + 工资记录 + 项目产量），用于下拉选择
  function getProjectNames() {
    var set = {};
    function add(p) { p = (p || '').trim(); if (p) set[p] = true; }
    (FW.db.getList('internal') || []).forEach(function (r) { add(r.project); });
    (FW.db.getList('project_qty') || []).forEach(function (r) { add(r.project); });
    (FW.db.getList('salary_records') || []).forEach(function (r) {
      (r.baseItems || []).forEach(function (it) { add(it.project); });
      (r.bonusItems || []).forEach(function (it) { add(it.project); });
      (r.commissionItems || []).forEach(function (it) { add(it.project); });
    });
    return Object.keys(set).sort(function (a, b) { return a.localeCompare(b, 'zh-Hans-CN'); });
  }

  function recId(empId, year, month) { return empId + '-' + year + '-' + month; }

  // 兼容旧数据：旧记录只含 salary 字段 → 记作底薪；旧 bonus(奖金/提成合并) → 记为奖金，提成置 0
  function normalizeRec(r) {
    var base = num(r.base);
    var bonus = num(r.bonus);
    var commission = num(r.commission);
    var baseItems = (r.baseItems || []).map(function (it) { return { project: (it.project || '').trim(), amount: num(it.amount) }; });
    var bonusItems = (r.bonusItems || []).map(function (it) { return { project: (it.project || '').trim(), amount: num(it.amount) }; });
    var commissionItems = (r.commissionItems || []).map(function (it) { return { project: (it.project || '').trim(), amount: num(it.amount) }; });
    if (!baseItems.length && base > 0) baseItems = [{ project: '', amount: base }];
    if (!bonusItems.length && bonus > 0) bonusItems = [{ project: '', amount: bonus }];
    if (!commissionItems.length && commission > 0) commissionItems = [{ project: '', amount: commission }];
    if (r.base == null && r.bonus == null && r.commission == null && r.salary != null) {
      base = num(r.salary); bonus = 0; commission = 0; baseItems = []; bonusItems = []; commissionItems = [];
    }
    // 以明细为准回写合计，保证一致
    if (baseItems.length) base = baseItems.reduce(function (s, it) { return s + it.amount; }, 0);
    if (bonusItems.length) bonus = bonusItems.reduce(function (s, it) { return s + it.amount; }, 0);
    if (commissionItems.length) commission = commissionItems.reduce(function (s, it) { return s + it.amount; }, 0);
    return { empId: r.empId, year: r.year, month: r.month, base: base, bonus: bonus, commission: commission, baseItems: baseItems, bonusItems: bonusItems, commissionItems: commissionItems, remark: r.remark || '' };
  }

  function computeEmpYear(emp, recs, year) {
    var months = (recs || []).map(normalizeRec).sort(function (a, b) { return a.month - b.month; });
    var cumBase = 0, cumBonus = 0, cumCommission = 0, cumAmount = 0;
    var list = months.map(function (r) {
      var amount = r.base + r.bonus + r.commission;
      cumBase += r.base; cumBonus += r.bonus; cumCommission += r.commission; cumAmount += amount;
      return { month: r.month, base: r.base, baseItems: r.baseItems, bonus: r.bonus, commission: r.commission, bonusItems: r.bonusItems, commissionItems: r.commissionItems, amount: amount, remark: r.remark };
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
  FW.salaryAgg = function (year) { return buildMindData(year); };

  // ===== 渲染 =====
  var state = { year: new Date().getFullYear(), tab: 'table', recSearch: '' };
  var MONTHS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];

  function render() {
    if (state.tab === 'calc') { renderCalc(); return; }
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

    // 子标签
    html += '<div class="tabs sal-tabs">' +
      '<button class="tab ' + (state.tab === 'table' ? 'active' : '') + '" data-tab="table">工资表</button>' +
      '<button class="tab ' + (state.tab === 'records' ? 'active' : '') + '" data-tab="records">记录管理</button>' +
      '<button class="tab ' + (state.tab === 'mind' ? 'active' : '') + '" data-tab="mind">项目工资图</button>' +
      '<button class="tab ' + (state.tab === 'calc' ? 'active' : '') + '" data-tab="calc">工资核算</button>' +
      '</div>';

    if (emps.length === 0) {
      html += '<div class="empty-state">' +
        '<div class="empty-ico">💰</div>' +
        '<div class="empty-title">还没有员工</div>' +
        '<div class="empty-sub">点「📥 导入工资」选一份含 姓名/底薪/奖金/提成 的 Excel 或 CSV，系统会自动识别并新建员工；也可点「👥 员工管理」手动添加。</div>' +
        '<button class="btn primary" id="salImportBtn2">📥 导入工资</button>' +
        '<button class="btn" id="salCalcBtn2">🧮 去工资核算</button>' +
        '</div></div>';
      var c0 = document.getElementById('content'); if (c0) c0.innerHTML = html;
      var b0 = document.getElementById('salImportBtn2'); if (b0) b0.onclick = openImport;
      var b1 = document.getElementById('salCalcBtn2'); if (b1) b1.onclick = function () { state.tab = 'calc'; render(); };
      bindTabs();
      return;
    }

    html += '<p class="sal-tip">💡 工资登记：逐月登记每个人的<strong>底薪</strong>、<strong>奖金</strong>与<strong>提成</strong>，三者分开记录；底薪、奖金与提成均可按<strong>项目/客户</strong>分类（点格子编辑时分行填写）。右侧自动累计各项。切到「项目工资图」可直观看到每个项目发了多少底薪、奖金与提成。</p>';

    if (state.tab === 'mind') html += drawMindView();
    else if (state.tab === 'records') html += drawRecordsView();
    else html += drawTableView(rows);

    html += '</div>';
    var c2 = document.getElementById('content'); if (c2) c2.innerHTML = html;

    bindTabs();
    if (state.tab !== 'mind') {
      // 单元格点击录入
      var cells = document.querySelectorAll('.salary-table td[data-emp]');
      Array.prototype.forEach.call(cells, function (td) {
        td.onclick = function () {
          openMonthEdit(td.getAttribute('data-emp'), parseInt(td.getAttribute('data-month'), 10));
        };
      });
    }
    if (state.tab === 'records') {
      Array.prototype.forEach.call(document.querySelectorAll('.rec-table [data-edit]'), function (bt) {
        bt.onclick = function () {
          var rec = getRecs().filter(function (x) { return x.id === bt.getAttribute('data-edit'); })[0];
          if (rec) openMonthEdit(rec.empId, rec.month);
        };
      });
      Array.prototype.forEach.call(document.querySelectorAll('.rec-table [data-del]'), function (bt) {
        bt.onclick = function () {
          if (!window.confirm('确定删除这条工资记录？此操作不可恢复。')) return;
          FW.db.remove('salary_records', bt.getAttribute('data-del'));
          FW.toast('已删除该记录');
          render();
        };
      });
      function updateRecSel() {
        var all = document.querySelectorAll('.rec-table .rec-check');
        var checked = document.querySelectorAll('.rec-table .rec-check:checked');
        var n = checked.length;
        var cnt = document.getElementById('recSelCount'); if (cnt) cnt.textContent = n;
        var ca = document.getElementById('recCheckAll');
        if (ca) ca.checked = all.length > 0 && n === all.length;
      }
      var chkAll = document.getElementById('recCheckAll');
      if (chkAll) chkAll.onchange = function () {
        Array.prototype.forEach.call(document.querySelectorAll('.rec-table .rec-check'), function (c) {
          var tr = c.closest('tr');
          if (tr && tr.style.display === 'none') return;
          c.checked = chkAll.checked;
        });
        updateRecSel();
      };
      Array.prototype.forEach.call(document.querySelectorAll('.rec-table .rec-check'), function (c) { c.onchange = updateRecSel; });
      var batchBtn = document.getElementById('recBatchDel');
      if (batchBtn) batchBtn.onclick = function () {
        var ids = [];
        Array.prototype.forEach.call(document.querySelectorAll('.rec-table .rec-check:checked'), function (c) { ids.push(c.value); });
        if (!ids.length) { FW.toast('请先勾选要删除的记录'); return; }
        if (!window.confirm('确定删除选中的 ' + ids.length + ' 条工资记录？此操作不可恢复。')) return;
        ids.forEach(function (id) { FW.db.remove('salary_records', id); });
        FW.toast('已删除 ' + ids.length + ' 条记录');
        render();
      };
      var batchEditBtn = document.getElementById('recBatchEdit');
      if (batchEditBtn) batchEditBtn.onclick = function () {
        var ids = [];
        Array.prototype.forEach.call(document.querySelectorAll('.rec-table .rec-check:checked'), function (c) { ids.push(c.value); });
        if (!ids.length) { FW.toast('请先勾选要修改的记录'); return; }
        openBatchEdit(ids);
      };
      updateRecSel();
      var searchBox = document.getElementById('recSearch');
      if (searchBox) {
        function applyFilter() {
          var q = (searchBox.value || '').trim().toLowerCase();
          state.recSearch = searchBox.value;
          var shown = 0;
          Array.prototype.forEach.call(document.querySelectorAll('.rec-table tbody tr'), function (tr) {
            var hit = !q || (tr.getAttribute('data-kw') || '').indexOf(q) > -1;
            tr.style.display = hit ? '' : 'none';
            if (!hit) { var cb = tr.querySelector('.rec-check'); if (cb) cb.checked = false; }
            if (hit) shown++;
          });
          var cnt = document.getElementById('recCount');
          if (cnt) cnt.textContent = q ? ('筛出 ' + shown + ' / ' + recs.length + ' 条') : ('共 ' + recs.length + ' 条记录');
          updateRecSel();
        }
        searchBox.oninput = applyFilter;
        applyFilter();
      }
    }
  }

  function bindTabs() {
    var tabs = document.querySelectorAll('.sal-tabs .tab');
    Array.prototype.forEach.call(tabs, function (t) {
      t.onclick = function () {
        var v = t.getAttribute('data-tab');
        if (state.tab === v) return;
        state.tab = v; render();
      };
    });
  }

  // 记录管理：列出当前年份所有工资记录，支持编辑/删除
  function drawRecordsView() {
    var emps = getEmps();
    var empName = {}; emps.forEach(function (e) { empName[e.id] = e.name; });
    var recs = getRecs().filter(function (r) { return r.year === state.year; });
    recs.sort(function (a, b) {
      var na = (empName[a.empId] || ''), nb = (empName[b.empId] || '');
      if (na !== nb) return na.localeCompare(nb, 'zh-Hans-CN');
      return a.month - b.month;
    });
    var html = '<p class="sal-tip">💡 这里列出 <b>' + state.year + '</b> 年导入 / 登记的所有工资记录。点「编辑」可改底薪 / 奖金 / 提成 / 备注（支持按项目拆分），点「删除」可移除整条记录；勾选多行后可「批量修改选中」或「批量删除选中」。也可切回「工资表」点具体格子修改某月。</p>';
    html += '<div class="rec-toolbar"><span class="muted" id="recCount">共 ' + recs.length + ' 条记录</span>' +
      '<input id="recSearch" class="rec-search" type="text" placeholder="🔍 搜索 姓名 / 月份 / 备注" value="' + FW.esc(state.recSearch) + '">' +
      '<button class="btn sm" id="recBatchEdit">批量修改选中</button>' +
      '<button class="btn sm danger" id="recBatchDel">🗑 批量删除选中 (<span id="recSelCount">0</span>)</button></div>';
    html += '<table class="rec-table"><thead><tr>' +
      '<th class="rec-cb-col"><label class="rec-checkall"><input type="checkbox" id="recCheckAll"> 全选</label></th>' +
      '<th class="rec-emp-col">员工</th><th class="rec-month-col">月份</th>' +
      '<th class="num">底薪</th><th class="num">奖金</th><th class="num">提成</th>' +
      '<th>备注</th><th>操作</th>' +
      '</tr></thead><tbody>';
    if (!recs.length) {
      html += '<tr><td colspan="8" class="muted" style="text-align:center;padding:24px">暂无记录。可点「📥 导入工资」导入，或切到「工资表」点格子逐月登记。</td></tr>';
    } else {
      recs.forEach(function (r) {
        var nm = empName[r.empId] || r.empId || '（未知员工）';
        var kw = (nm + ' ' + r.month + '月 ' + (r.remark || '')).toLowerCase();
        html += '<tr data-kw="' + FW.esc(kw) + '">' +
          '<td class="rec-cb-col"><input type="checkbox" class="rec-check" value="' + FW.esc(r.id) + '"></td>' +
          '<td class="rec-emp-col">' + FW.esc(nm) + '</td>' +
          '<td class="rec-month-col">' + r.month + '月</td>' +
          '<td class="num">' + FW.fmtMoney(r.base || 0) + '</td>' +
          '<td class="num">' + FW.fmtMoney(r.bonus || 0) + '</td>' +
          '<td class="num">' + FW.fmtMoney(r.commission || 0) + '</td>' +
          '<td>' + FW.esc(r.remark || '') + '</td>' +
          '<td class="rec-ops">' +
            '<button class="btn sm" data-edit="' + FW.esc(r.id) + '">编辑</button> ' +
            '<button class="btn sm danger" data-del="' + FW.esc(r.id) + '">删除</button>' +
          '</td></tr>';
      });
    }
    html += '</tbody></table>';
    return html;
  }

  // 批量修改：勾选多条后统一改底薪/奖金/提成/备注
  function openBatchEdit(ids) {
    var emps = getEmps();
    var nameById = {};
    emps.forEach(function (e) { nameById[e.id] = e.name; });
    var recs = getRecs().filter(function (r) { return ids.indexOf(r.id) > -1; });
    if (!recs.length) { FW.toast('未找到选中的记录'); return; }
    var names = recs.slice(0, 3).map(function (r) { return nameById[r.empId] || r.empId || '未知'; }).join('、');
    var projOpts = getProjectNames();
    var projSelect = '<option value="">— 不分类 —</option>' +
      projOpts.map(function (p) { return '<option value="' + FW.esc(p) + '">' + FW.esc(p) + '</option>'; }).join('');
    var body = '<div class="form">' +
      '<p class="sal-tip">已选 <b>' + ids.length + '</b> 条记录：' + FW.esc(names) + (ids.length > 3 ? ' 等' : '') + '</p>' +
      '<p class="sal-tip" style="margin-top:2px">勾选要修改的项，填写金额，并在「项目」里选择归入哪个项目。</p>' +
      '<div class="form-row be-row"><label class="be-label"><input type="checkbox" id="beBaseChk"> 底薪</label><input id="beBase" type="number" step="0.01" placeholder="金额"><select id="beBaseProj" class="be-proj">' + projSelect + '</select></div>' +
      '<div class="form-row be-row"><label class="be-label"><input type="checkbox" id="beBonusChk"> 奖金</label><input id="beBonus" type="number" step="0.01" placeholder="金额"><select id="beBonusProj" class="be-proj">' + projSelect + '</select></div>' +
      '<div class="form-row be-row"><label class="be-label"><input type="checkbox" id="beCommChk"> 提成</label><input id="beComm" type="number" step="0.01" placeholder="金额"><select id="beCommProj" class="be-proj">' + projSelect + '</select></div>' +
      '<div class="form-row be-row"><label class="be-label"><input type="checkbox" id="beRemarkChk"> 备注</label><input id="beRemark" type="text" placeholder="留空则不变"></div>' +
      '</div>' +
      '<div class="modal-foot"><button class="btn" id="beCancel">取消</button><button class="btn" id="beOk">确认修改</button></div>';
    FW.openModal('批量修改工资记录', body, function () {
      document.getElementById('beCancel').onclick = FW.closeModal;
      document.getElementById('beOk').onclick = function () {
        var baseChk = document.getElementById('beBaseChk').checked;
        var bonusChk = document.getElementById('beBonusChk').checked;
        var commChk = document.getElementById('beCommChk').checked;
        var remarkChk = document.getElementById('beRemarkChk').checked;
        var base = num(document.getElementById('beBase').value);
        var bonus = num(document.getElementById('beBonus').value);
        var commission = num(document.getElementById('beComm').value);
        var baseProj = document.getElementById('beBaseProj').value.trim();
        var bonusProj = document.getElementById('beBonusProj').value.trim();
        var commProj = document.getElementById('beCommProj').value.trim();
        var remark = document.getElementById('beRemark').value;
        if (!baseChk && !bonusChk && !commChk && !remarkChk) { FW.toast('请至少勾选一项要修改的内容'); return; }
        if (baseChk && !document.getElementById('beBase').value) { FW.toast('请填写底薪金额'); return; }
        if (bonusChk && !document.getElementById('beBonus').value) { FW.toast('请填写奖金金额'); return; }
        if (commChk && !document.getElementById('beComm').value) { FW.toast('请填写提成金额'); return; }
        var updated = 0;
        recs.forEach(function (r) {
          var obj = JSON.parse(JSON.stringify(r));
          if (baseChk) { obj.base = base; obj.baseItems = [{ project: baseProj, amount: base }]; }
          if (bonusChk) { obj.bonus = bonus; obj.bonusItems = [{ project: bonusProj, amount: bonus }]; }
          if (commChk) { obj.commission = commission; obj.commissionItems = [{ project: commProj, amount: commission }]; }
          if (remarkChk) obj.remark = remark;
          FW.db.upsert('salary_records', obj);
          updated++;
        });
        FW.closeModal();
        FW.toast('已更新 ' + updated + ' 条记录');
        render();
      };
    });
  }

  function drawTableView(rows) {
    var html = '';
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
          var baseHint = (m.baseItems && m.baseItems.length > 1) ? ' (' + m.baseItems.length + '项)' : '';
          var bonusHint = (m.bonusItems && m.bonusItems.length > 1) ? ' (' + m.bonusItems.length + '项)' : '';
          var commHint = (m.commissionItems && m.commissionItems.length > 1) ? ' (' + m.commissionItems.length + '项)' : '';
          html += '<td class="cell-has" data-emp="' + emp.id + '" data-month="' + mo + '" title="点击编辑">' +
            '<div class="cell-base">底 ' + FW.fmtMoney(m.base) + baseHint + '</div>' +
            '<div class="cell-bonus">奖 ' + FW.fmtMoney(m.bonus) + bonusHint + '</div>' +
            '<div class="cell-comm">提 ' + FW.fmtMoney(m.commission) + commHint + '</div>' +
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
    return html;
  }

  function drawMindView() {
    var mind = buildMindData();
    if (!mind.projects.length) {
      return '<div class="empty-state">' +
        '<div class="empty-ico">📊</div>' +
        '<div class="empty-title">还没有按项目登记底薪/奖金/提成</div>' +
        '<div class="empty-sub">在「工资表」点任意格子编辑某月工资，底薪、奖金或提成可逐行填写项目（如 项目A、客户B）。登记后这里会以柱状图展示每个项目发了多少底薪、奖金与提成。</div>' +
        '</div>';
    }
    var labels = mind.projects;
    var baseVals = labels.map(function (p) { return mind.projMap[p].base; });
    var bonusVals = labels.map(function (p) { return mind.projMap[p].bonus; });
    var commVals = labels.map(function (p) { return mind.projMap[p].commission; });
    var series = [
      { name: '底薪', color: '#C9A227', values: baseVals },
      { name: '奖金', color: '#C8102E', values: bonusVals },
      { name: '提成', color: '#1f9d55', values: commVals }
    ];
    var chartW = Math.max(440, labels.length * 74 + 70);
    var html = '';
    html += '<p class="sal-tip">📊 ' + state.year + ' 全年各项目工资对比：<strong style="color:#C9A227">金色=底薪</strong>、<strong style="color:#C8102E">红色=奖金</strong>、<strong style="color:#1f9d55">绿色=提成</strong>。柱子越高表示该项目该项金额越大；下表列出每个项目的明细与合计。</p>';
    html += '<div class="mindmap-box"><div style="min-width:' + chartW + 'px">' +
      FW.groupedBarChart(state.year + ' 年 · 各项目工资（底薪/奖金/提成）', series, labels, { width: chartW, height: 220 }) +
      '</div></div>';
    html += '<div class="proj-sum-wrap"><table class="proj-sum-table"><thead><tr>' +
      '<th>项目</th><th class="num">底薪</th><th class="num">奖金</th><th class="num">提成</th><th class="num">合计</th></tr></thead><tbody>';
    mind.projects.forEach(function (p) {
      var d = mind.projMap[p];
      html += '<tr><td>' + FW.esc(p) + '</td>' +
        '<td class="num amt-income">' + FW.fmtMoney(d.base) + '</td>' +
        '<td class="num amt-income">' + FW.fmtMoney(d.bonus) + '</td>' +
        '<td class="num amt-expense">' + FW.fmtMoney(d.commission) + '</td>' +
        '<td class="num">' + FW.fmtMoney(d.base + d.bonus + d.commission) + '</td></tr>';
    });
    html += '<tr class="proj-sum-total"><td>合计</td>' +
      '<td class="num amt-income">' + FW.fmtMoney(mind.grandBase) + '</td>' +
      '<td class="num amt-income">' + FW.fmtMoney(mind.grandBonus) + '</td>' +
      '<td class="num amt-expense">' + FW.fmtMoney(mind.grandCommission) + '</td>' +
      '<td class="num">' + FW.fmtMoney(mind.grandBase + mind.grandBonus + mind.grandCommission) + '</td></tr>';
    html += '</tbody></table></div>';
    return html;
  }

  function buildMindData(year) {
    year = (year == null) ? state.year : year;
    var recs = getRecs().filter(function (r) { return r.year === year; });
    var projMap = {};
    function add(items, type) {
      (items || []).forEach(function (it) {
        var p = (it.project || '').trim() || '未分类';
        if (!projMap[p]) projMap[p] = { base: 0, bonus: 0, commission: 0 };
        projMap[p][type] += num(it.amount);
      });
    }
    recs.forEach(function (r) {
      var n = normalizeRec(r);
      add(n.baseItems, 'base');
      add(n.bonusItems, 'bonus');
      add(n.commissionItems, 'commission');
    });
    var projects = Object.keys(projMap);
    var grandBase = 0, grandBonus = 0, grandCommission = 0;
    projects.forEach(function (p) { grandBase += projMap[p].base; grandBonus += projMap[p].bonus; grandCommission += projMap[p].commission; });
    projects.sort(function (a, b) { return (projMap[b].base + projMap[b].bonus + projMap[b].commission) - (projMap[a].base + projMap[a].bonus + projMap[a].commission); });
    var branches = projects.map(function (p) {
      var d = projMap[p];
      return {
        label: p + '  ' + FW.fmtMoney(d.base + d.bonus + d.commission),
        value: '',
        color: '#C9A227',
        children: [
          { label: '底薪', value: FW.fmtMoney(d.base), color: '#C9A227' },
          { label: '奖金', value: FW.fmtMoney(d.bonus), color: '#C8102E' },
          { label: '提成', value: FW.fmtMoney(d.commission), color: '#1f9d55' }
        ]
      };
    });
    var root = { label: year + '年 工资(底薪+奖金+提成)', value: '总 ' + FW.fmtMoney(grandBase + grandBonus + grandCommission), color: '#3A0F14' };
    return { svg: FW.mindMap({ root: root, branches: branches }), grandBase: grandBase, grandBonus: grandBonus, grandCommission: grandCommission, projMap: projMap, projects: projects };
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
    var remark = rec ? (rec.remark || '') : '';
    var recBaseItems = (rec && rec.baseItems && rec.baseItems.length) ? rec.baseItems : (rec && num(rec.base) > 0 ? [{ project: '', amount: num(rec.base) }] : []);
    var recBonusItems = (rec && rec.bonusItems && rec.bonusItems.length) ? rec.bonusItems : (rec && num(rec.bonus) > 0 ? [{ project: '', amount: num(rec.bonus) }] : []);
    var recCommItems = (rec && rec.commissionItems && rec.commissionItems.length) ? rec.commissionItems : (rec && num(rec.commission) > 0 ? [{ project: '', amount: num(rec.commission) }] : []);

    var projOpts = getProjectNames();
    function projSelect(selected) {
      selected = (selected || '').trim();
      var html = '<select class="pi-proj"><option value=""' + (selected ? '' : ' selected') + '>— 不分类 —</option>';
      projOpts.forEach(function (p) {
        html += '<option value="' + FW.esc(p) + '"' + (p === selected ? ' selected' : '') + '>' + FW.esc(p) + '</option>';
      });
      html += '</select>';
      return html;
    }

    function rowsHtml(items, kindLabel) {
      if (!items.length) return '<div class="pi-empty muted">暂无，点下面「＋ 添加' + kindLabel + '项」</div>';
      return items.map(function (it) {
        return '<div class="pi-row">' +
          projSelect(it.project) +
          '<input class="pi-amt" type="number" step="0.01" value="' + (it.amount != null ? it.amount : '') + '" placeholder="金额">' +
          '<button type="button" class="btn sm danger pi-del">✕</button></div>';
      }).join('');
    }
    function sumHint(items) {
      return FW.fmtMoney(items.reduce(function (s, it) { return s + num(it.amount); }, 0));
    }

    var body = '<div class="form">' +
      '<div class="form-row"><label>员工</label><div class="form-static">' + FW.esc(emp.name) + ' · ' + state.year + '年' + month + '月</div></div>' +
      '<div class="form-section"><div class="form-sec-title">💰 底薪明细（可按项目分类）</div>' +
        '<div id="baseItems" class="pi-list">' + rowsHtml(recBaseItems, '底薪') + '</div>' +
        '<button type="button" class="btn sm" id="addBaseItem">＋ 添加底薪项</button>' +
        '<div class="pi-total">底薪合计：<b id="baseTotal">' + sumHint(recBaseItems) + '</b></div></div>' +
      '<div class="form-section"><div class="form-sec-title">🏆 奖金明细（可按项目分类）</div>' +
        '<div id="bonusItems" class="pi-list">' + rowsHtml(recBonusItems, '奖金') + '</div>' +
        '<button type="button" class="btn sm" id="addBonusItem">＋ 添加奖金项</button>' +
        '<div class="pi-total">奖金合计：<b id="bonusTotal">' + sumHint(recBonusItems) + '</b></div></div>' +
      '<div class="form-section"><div class="form-sec-title">💎 提成明细（可按项目分类）</div>' +
        '<div id="commissionItems" class="pi-list">' + rowsHtml(recCommItems, '提成') + '</div>' +
        '<button type="button" class="btn sm" id="addCommItem">＋ 添加提成项</button>' +
        '<div class="pi-total">提成合计：<b id="commTotal">' + sumHint(recCommItems) + '</b></div></div>' +
      '<div class="form-row"><label>备注</label><input id="mRemark" type="text" value="' + FW.esc(remark) + '" placeholder="如 年终奖 / 项目提成"></div>' +
      '</div>' +
      '<div class="modal-foot"><button class="btn" id="mDel">删除</button><button class="btn primary" id="mSave">保存</button></div>';

    FW.openModal(state.year + '年' + month + '月 · ' + emp.name, body, function () {
      function recompute(cid, tid) {
        var sum = 0;
        Array.prototype.forEach.call(document.querySelectorAll('#' + cid + ' .pi-row'), function (row) {
          var a = row.querySelector('.pi-amt').value;
          if (a !== '' && !isNaN(parseFloat(a))) sum += parseFloat(a);
        });
        var t = document.getElementById(tid); if (t) t.textContent = FW.fmtMoney(sum);
      }
      function bindList(cid, tid) {
        Array.prototype.forEach.call(document.querySelectorAll('#' + cid + ' .pi-row'), function (row) {
          row.querySelector('.pi-amt').oninput = function () { recompute(cid, tid); };
          row.querySelector('.pi-del').onclick = function () { row.parentNode.removeChild(row); recompute(cid, tid); };
        });
      }
      function makeAdd(btnId, cid, tid) {
        var btn = document.getElementById(btnId);
        if (!btn) return;
        btn.onclick = function () {
          var cont = document.getElementById(cid);
          var empty = cont.querySelector('.pi-empty'); if (empty) cont.removeChild(empty);
          var div = document.createElement('div');
          div.className = 'pi-row';
          div.innerHTML = projSelect('') + '<input class="pi-amt" type="number" step="0.01" placeholder="金额"><button type="button" class="btn sm danger pi-del">✕</button>';
          cont.appendChild(div);
          div.querySelector('.pi-amt').oninput = function () { recompute(cid, tid); };
          div.querySelector('.pi-del').onclick = function () { cont.removeChild(div); recompute(cid, tid); };
        };
      }
      function collect(cid) {
        var items = [];
        Array.prototype.forEach.call(document.querySelectorAll('#' + cid + ' .pi-row'), function (row) {
          var p = row.querySelector('.pi-proj').value.trim();
          var a = row.querySelector('.pi-amt').value;
          if (a === '' || isNaN(parseFloat(a))) return;
          items.push({ project: p, amount: parseFloat(a) });
        });
        return items;
      }

      bindList('baseItems', 'baseTotal');
      bindList('bonusItems', 'bonusTotal');
      bindList('commissionItems', 'commTotal');
      makeAdd('addBaseItem', 'baseItems', 'baseTotal');
      makeAdd('addBonusItem', 'bonusItems', 'bonusTotal');
      makeAdd('addCommItem', 'commissionItems', 'commTotal');

      document.getElementById('mSave').onclick = function () {
        var baseItems = collect('baseItems');
        var bonusItems = collect('bonusItems');
        var commissionItems = collect('commissionItems');
        var base = baseItems.reduce(function (s, it) { return s + it.amount; }, 0);
        var bonus = bonusItems.reduce(function (s, it) { return s + it.amount; }, 0);
        var commission = commissionItems.reduce(function (s, it) { return s + it.amount; }, 0);
        if (base === 0 && bonus === 0 && commission === 0) {
          FW.toast('请至少填写底薪 / 奖金 / 提成 中的一项'); return;
        }
        var recs2 = getRecs();
        var exist = recs2.filter(function (r) { return r.empId === empId && r.year === state.year && r.month === month; })[0];
        var obj = {
          empId: empId, year: state.year, month: month,
          base: base, baseItems: baseItems,
          bonus: bonus, commission: commission,
          bonusItems: bonusItems, commissionItems: commissionItems,
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
      var fb = document.getElementById('addBaseItem'); if (fb) fb.focus();
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
    // 裁掉“整列为空”的列：Excel 常因格式刷/样式残留产生海量空列（如 dimension 达到 OCC 列），
    // 导致导入界面列出上万列并全部误判为忽略。表头或任意数据行有内容的列予以保留。
    function trimEmptyCols(rows) {
      if (!rows || !rows.length) return rows;
      var ncol = 0;
      for (var r = 0; r < rows.length; r++) if (rows[r] && rows[r].length > ncol) ncol = rows[r].length;
      var keep = [];
      for (var c = 0; c < ncol; c++) {
        var has = false;
        for (var r2 = 0; r2 < rows.length; r2++) {
          var v = rows[r2] ? rows[r2][c] : undefined;
          if (v !== undefined && v !== null && String(v).trim() !== '') { has = true; break; }
        }
        if (has) keep.push(c);
      }
      return rows.map(function (r) { return keep.map(function (c) { return r ? r[c] : ''; }); });
    }
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
          rows = trimEmptyCols(rows); // 裁掉 Excel 残留的空列，避免导入界面列爆炸
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
      cb(trimEmptyCols(lines.map(function (l) { return csvSplit(l); })));
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
    var projOpts = getProjectNames().map(function (p) { return '<option value="' + FW.esc(p) + '">' + FW.esc(p) + '</option>'; }).join('');
    var selHtml = headers.map(function (h, i) {
      var def = guess.name === i ? 'name' : (guess.dept === i ? 'dept' : (guess.month === i ? 'month' : (guess.year === i ? 'year' : (guess.base === i ? 'base' : (guess.bonus === i ? 'bonus' : (guess.commission === i ? 'commission' : 'ignore'))))));
      map[i] = def;
      var opts = roles.map(function (r) { return '<option value="' + r[0] + '"' + (def === r[0] ? ' selected' : '') + '>' + r[1] + '</option>'; }).join('');
      return '<div class="form-row"><label>' + FW.esc(h || ('列' + (i + 1))) + '</label><select data-col="' + i + '">' + opts + '</select></div>';
    }).join('');

    var body = '<div class="form" style="max-height:46vh;overflow:auto">' + selHtml + '</div>' +
      '<div class="form-row"><label>默认年份（无年份列时）</label><input id="salDefYear" type="number" value="' + state.year + '"></div>' +
      '<div class="form-row"><label>默认月份（文件无月份列时必填，已预填当月，可按需改）</label><input id="salDefMonth" type="number" min="1" max="12" value="' + (new Date().getMonth() + 1) + '" placeholder="如 3"></div>' +
      '<div class="form-row"><label>默认项目（可选：本次导入的所有工资直接归入该项目，避免变成未分类）</label><select id="salDefProject"><option value="">— 不指定（保持未分类）—</option>' + projOpts + '</select></div>' +
      '<div id="salPrev" class="muted" style="font-size:12px;margin:8px 0"></div>' +
      '<div class="modal-foot"><button class="btn" id="salMapCancel">取消</button><button class="btn" id="salMapPrev">预览</button><button class="btn primary" id="salMapOk">确认导入</button></div>';

    FW.openModal('导入工资 · 列映射', body, function () {
      function build() {
        var m = {};
        // 注意：parseSalaryRows 需要的是 { 角色: 列索引 }，而 DOM 里存的是 { 列索引: 角色 }，这里做一次翻转
        Array.prototype.forEach.call(document.querySelectorAll('select[data-col]'), function (s) {
          var col = s.getAttribute('data-col');
          var role = s.value;
          if (role && role !== 'ignore') m[role] = +col;
        });
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
        var defProject = (document.getElementById('salDefProject').value || '').trim();
        r.newEmps.forEach(function (nm) {
          var e = { id: 'emp_' + Date.now() + '_' + Math.floor(Math.random() * 1000), name: nm, dept: r.deptByEmp[nm] || '', remark: '' };
          FW.db.upsert('salary_employees', e);
          byName[nm.toLowerCase()] = e;
        });
        r.rows.forEach(function (rec) {
          var emp = byName[(rec.name || '').trim().toLowerCase()];
          if (!emp) return;
          var id = recId(emp.id, rec.year, rec.month);
          var baseItems = rec.base > 0 ? [{ project: defProject, amount: rec.base }] : [];
          var bonusItems = rec.bonus > 0 ? [{ project: defProject, amount: rec.bonus }] : [];
          var commissionItems = rec.commission > 0 ? [{ project: defProject, amount: rec.commission }] : [];
          FW.db.upsert('salary_records', { id: id, empId: emp.id, year: rec.year, month: rec.month, base: rec.base, bonus: rec.bonus, commission: rec.commission, baseItems: baseItems, bonusItems: bonusItems, commissionItems: commissionItems, remark: '' });
        });
        FW.closeModal();
        FW.toast('已导入 ' + r.rows.length + ' 条，新建 ' + r.newEmps.length + ' 名员工');
        render();
      };
    });
  }

  function detailOf(items) {
    var map = {};
    (items || []).forEach(function (it) { var p = (it.project || '未分类'); map[p] = (map[p] || 0) + num(it.amount); });
    return Object.keys(map).map(function (p) { return p + ':' + map[p]; }).join('; ');
  }

  function exportCSV(rows) {
    var header = ['员工', '部门'];
    MONTHS.forEach(function (m) { header.push(m + '底薪', m + '奖金', m + '提成', m + '金额'); });
    header.push('底薪明细(项目:金额)', '奖金明细(项目:金额)', '提成明细(项目:金额)', '累计底薪', '累计奖金', '累计提成', '累计金额');
    var lines = [header.join(',')];
    rows.forEach(function (rw) {
      var byMonth = {};
      rw.calc.months.forEach(function (m) { byMonth[m.month] = m; });
      var allBase = [], allBonus = [], allComm = [];
      rw.calc.months.forEach(function (m) {
        (m.baseItems || []).forEach(function (it) { allBase.push(it); });
        (m.bonusItems || []).forEach(function (it) { allBonus.push(it); });
        (m.commissionItems || []).forEach(function (it) { allComm.push(it); });
      });
      var line = [rw.emp.name, rw.emp.dept || ''];
      for (var mo = 1; mo <= 12; mo++) {
        var m = byMonth[mo];
        line.push(m ? m.base : '', m ? m.bonus : '', m ? m.commission : '', m ? m.amount : '');
      }
      line.push(detailOf(allBase), detailOf(allBonus), detailOf(allComm), rw.calc.cumBase, rw.calc.cumBonus, rw.calc.cumCommission, rw.calc.cumAmount);
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

  // ===== 工资核算：上传考勤 → 按可配置规则自动核算实发工资 =====
  // 规则只需设置一次（自动存 salary_calc_rules），之后每次上传同类考勤表即可一键核算。
  var CALC_ROLES = [
    { key: 'name', label: '姓名', req: true, words: ['姓名', '名字', '员工', '职员', '名称', 'name'] },
    { key: 'base', label: '基本工资（可选）', req: false, words: ['基本工资', '底薪', '基础工资', '固定工资', '工资', 'base'] },
    { key: 'attend', label: '出勤天数', req: false, words: ['出勤', '考勤', '实际出勤'] },
    { key: 'std', label: '应出勤天数（满勤标准）', req: false, words: ['应出勤', '满勤', '标准出勤', '应到'] },
    { key: 'ot', label: '加班小时', req: false, words: ['加班', '加班时长', '加班小时', 'ot'] },
    { key: 'lateCnt', label: '迟到次数', req: false, words: ['迟到次数', '迟到次'] },
    { key: 'lateMin', label: '迟到分钟', req: false, words: ['迟到分钟', '迟到时长'] },
    { key: 'leave', label: '请假天数', req: false, words: ['请假', '缺勤', '事假', '病假'] },
    { key: 'subsidy', label: '补助天数', req: false, words: ['补助', '补贴', '天数'] }
  ];
  var calcState = { headers: [], rows: [], mapping: {}, result: [] };

  function loadCalcRules() {
    var def = { baseFixed: 5000, stdAttend: 26, fullBonus: 300, otRate: 20, latePerTime: 50, latePerMin: 2, leavePerDay: 100, subsidyPerDay: 50, prorateBase: false, mapping: {} };
    try {
      var list = FW.db.getList('salary_calc_rules') || [];
      if (list.length) { var s = list[0]; for (var k in def) if (!(k in s)) s[k] = def[k]; return s; }
    } catch (e) {}
    return def;
  }
  function saveCalcRules(r) { FW.db.saveList('salary_calc_rules', [r]); }

  function guessCalcMap(headers) {
    var used = {}; var g = {};
    CALC_ROLES.forEach(function (role) {
      if (!role.words) return;
      for (var i = 0; i < headers.length; i++) {
        if (used[i]) continue;
        var hh = (headers[i] == null ? '' : String(headers[i])).toLowerCase().replace(/\s+/g, '');
        for (var w = 0; w < role.words.length; w++) {
          if (hh.indexOf(role.words[w].toLowerCase()) > -1) { used[i] = true; g[role.key] = (headers[i] == null ? '' : String(headers[i]).trim()); break; }
        }
        if (g[role.key]) break;
      }
    });
    return g;
  }

  function calcMapSelect(role, headers, sel) {
    var html = '<select class="calc-sel" data-role="' + role.key + '"><option value="">（不使用）</option>';
    headers.forEach(function (h) {
      var hh = (h == null ? '' : String(h)).trim();
      if (hh === '') return;
      html += '<option' + (hh === sel ? ' selected' : '') + '>' + FW.esc(hh) + '</option>';
    });
    html += '</select>';
    return html;
  }

  function renderCalcMap() {
    var el = document.getElementById('calcMapArea'); if (!el) return;
    var headers = calcState.headers || [];
    if (!headers.length) { el.innerHTML = '<div class="muted">请先上传考勤文件，系统会自动识别表头并生成映射。</div>'; return; }
    var mapping = calcState.mapping || {};
    var html = '<table class="tbl calc-map"><thead><tr><th>字段角色</th><th>对应表格列</th></tr></thead><tbody>';
    CALC_ROLES.forEach(function (role) {
      html += '<tr><td>' + role.label + (role.req ? ' <span class="req">*</span>' : '') + '</td><td>' + calcMapSelect(role, headers, mapping[role.key] || '') + '</td></tr>';
    });
    html += '</tbody></table>';
    el.innerHTML = html;
    Array.prototype.forEach.call(el.querySelectorAll('.calc-sel'), function (s) {
      s.onchange = function () { calcState.mapping = calcState.mapping || {}; calcState.mapping[s.getAttribute('data-role')] = s.value; };
    });
  }

  function openCalcFile(file) {
    if (!file) return;
    readFileRows(file, '', function (rows) {
      if (!rows || !rows.length) { FW.toast('文件为空或解析失败'); return; }
      var headers = (rows[0] || []).map(function (h) { return (h == null ? '' : String(h)).trim(); });
      var dataRows = (rows.slice(1) || []).map(function (r) {
        var o = {}; headers.forEach(function (h, i) { o[h] = r[i]; }); return o;
      }).filter(function (o) { return Object.keys(o).length; });
      calcState.headers = headers;
      calcState.rows = dataRows;
      var rules = loadCalcRules();
      var auto = {};
      if (rules.mapping) {
        CALC_ROLES.forEach(function (role) { if (rules.mapping[role.key] && headers.indexOf(rules.mapping[role.key]) > -1) auto[role.key] = rules.mapping[role.key]; });
      }
      if (Object.keys(auto).length === 0) auto = guessCalcMap(headers);
      calcState.mapping = auto;
      var info = document.getElementById('calcFileInfo');
      if (info) info.innerHTML = '✅ 已读取 <b>' + dataRows.length + '</b> 行，识别到 <b>' + headers.length + '</b> 列表头。请确认下方映射是否正确。';
      renderCalcMap();
      if (auto.name) doCalc(true);
    });
  }

  function readCalcCoef() {
    function v(id, def) { var e = document.getElementById(id); return e ? num(e.value) : def; }
    function c(id) { var e = document.getElementById(id); return e ? e.checked : false; }
    var rules = loadCalcRules();
    return {
      baseFixed: v('co_base', rules.baseFixed), stdAttend: v('co_std', rules.stdAttend),
      fullBonus: v('co_full', rules.fullBonus), otRate: v('co_ot', rules.otRate),
      latePerTime: v('co_lateT', rules.latePerTime), latePerMin: v('co_lateM', rules.latePerMin),
      leavePerDay: v('co_leave', rules.leavePerDay), subsidyPerDay: v('co_subsidy', rules.subsidyPerDay),
      prorateBase: c('co_prorate') ? true : (rules.prorateBase || false)
    };
  }

  function calcCoefHtml(r) {
    function f(id, label, val, hint) {
      return '<div class="form-row"><label>' + label + '</label><input id="' + id + '" type="number" step="0.01" value="' + (r[id] != null ? r[id] : '') + '"><span class="hint">' + hint + '</span></div>';
    }
    return '<div class="calc-grid">' +
      f('co_base', '固定基本工资(元/月)', r.baseFixed, '考勤表含基本工资列时优先用列值，否则用此固定额') +
      f('co_std', '默认应出勤天数', r.stdAttend, '未提供应出勤列时用于判定满勤') +
      f('co_full', '满勤奖(元)', r.fullBonus, '当月满勤（无迟到/请假且出勤≥应出勤）才发放') +
      f('co_ot', '加班费(元/小时)', r.otRate, '加班小时 × 此费率') +
      f('co_lateT', '迟到扣款(元/次)', r.latePerTime, '迟到次数列 × 此值') +
      f('co_lateM', '迟到扣款(元/分钟)', r.latePerMin, '迟到分钟列 × 此值') +
      f('co_leave', '请假扣款(元/天)', r.leavePerDay, '请假天数列 × 此值') +
      f('co_subsidy', '补助(元/天)', r.subsidyPerDay, '补助天数列 × 此值（根据补助天数计算）') +
      '<label class="calc-chk"><input type="checkbox" id="co_prorate"' + (r.prorateBase ? ' checked' : '') + '> 固定工资随出勤天数折算（不勾＝固定工资不扣全勤）</label>' +
      '</div>';
  }

  function doCalc(silent) {
    var rules = readCalcCoef();
    var m = calcState.mapping || {};
    if (!m.name) { FW.toast('请先在映射中选择「姓名」列'); return; }
    var rows = (calcState.rows || []).filter(function (r) { return r[m.name] != null && String(r[m.name]).trim() !== ''; });
    if (!rows.length) { FW.toast('没有可核算的数据行'); return; }
    var out = rows.map(function (r) {
      var has = function (k) { return m[k] != null && m[k] !== ''; };
      var base = has('base') ? num(r[m.base]) : 0; base = base > 0 ? base : num(rules.baseFixed);
      var attend = has('attend') ? num(r[m.attend]) : 0;
      var std = has('std') ? num(r[m.std]) : (attend || num(rules.stdAttend) || 0);
      var ot = has('ot') ? num(r[m.ot]) : 0;
      var lateCnt = has('lateCnt') ? num(r[m.lateCnt]) : 0;
      var lateMin = has('lateMin') ? num(r[m.lateMin]) : 0;
      var leave = has('leave') ? num(r[m.leave]) : 0;
      var subsidy = has('subsidy') ? num(r[m.subsidy]) : 0;
      var full = (lateCnt === 0 && lateMin === 0 && leave === 0 && attend > 0 && (std > 0 ? attend >= std : true));
      var baseEff = (rules.prorateBase && std > 0) ? base * Math.min(attend / std, 1) : base;
      var otPay = ot * num(rules.otRate);
      var fullBonus = full ? num(rules.fullBonus) : 0;
      var lateDed = lateCnt * num(rules.latePerTime) + lateMin * num(rules.latePerMin);
      var leaveDed = leave * num(rules.leavePerDay);
      var subsidyPay = subsidy * num(rules.subsidyPerDay);
      var yingfa = baseEff + otPay + fullBonus + subsidyPay;
      var koukuan = lateDed + leaveDed;
      return { name: String(r[m.name]).trim(), base: baseEff, attend: attend, std: std, full: full, otPay: otPay, fullBonus: fullBonus, lateDed: lateDed, leaveDed: leaveDed, subsidyPay: subsidyPay, yingfa: yingfa, shifa: yingfa - koukuan };
    });
    calcState.result = out;
    renderCalcResult(out);
    var saved = loadCalcRules(); saved.mapping = calcState.mapping; saveCalcRules(saved);
    if (!silent) FW.toast('已核算 ' + out.length + ' 人，实发合计 ' + FW.fmtMoney(out.reduce(function (s, r) { return s + r.shifa; }, 0)));
  }

  function renderCalcResult(out) {
    var el = document.getElementById('calcResult'); if (!el) return;
    if (!out || !out.length) { el.innerHTML = '<div class="muted">暂无核算结果，上传考勤并点「核算实发工资」。</div>'; return; }
    var total = out.reduce(function (s, r) { return s + r.shifa; }, 0);
    var head = '<tr><th>姓名</th><th class="num">基本工资</th><th class="num">出勤</th><th class="num">应出勤</th><th>满勤</th><th class="num">加班费</th><th class="num">满勤奖</th><th class="num">迟到扣</th><th class="num">请假扣</th><th class="num">补助</th><th class="num">应发</th><th class="num">实发</th></tr>';
    var trs = out.map(function (r) {
      return '<tr><td>' + FW.esc(r.name) + '</td>' +
        '<td class="num">' + FW.fmtMoney(r.base) + '</td>' +
        '<td class="num">' + (r.attend || 0) + '</td>' +
        '<td class="num">' + (r.std || 0) + '</td>' +
        '<td class="center">' + (r.full ? '<span class="full-yes">✓</span>' : '<span class="full-no">✗</span>') + '</td>' +
        '<td class="num">' + FW.fmtMoney(r.otPay) + '</td>' +
        '<td class="num">' + FW.fmtMoney(r.fullBonus) + '</td>' +
        '<td class="num">' + (r.lateDed ? '-' + FW.fmtMoney(r.lateDed) : '0.00') + '</td>' +
        '<td class="num">' + (r.leaveDed ? '-' + FW.fmtMoney(r.leaveDed) : '0.00') + '</td>' +
        '<td class="num">' + FW.fmtMoney(r.subsidyPay) + '</td>' +
        '<td class="num">' + FW.fmtMoney(r.yingfa) + '</td>' +
        '<td class="num strong">' + FW.fmtMoney(r.shifa) + '</td></tr>';
    }).join('');
    el.innerHTML = '<table class="tbl calc-tbl"><thead>' + head + '</thead><tbody>' + trs + '</tbody><tfoot><tr><td>合计（' + out.length + ' 人）</td><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td class="num">' + FW.fmtMoney(total) + '</td><td class="num strong">' + FW.fmtMoney(total) + '</td></tr></tfoot></table>';
  }

  function exportCalcCSV(out) {
    if (!out || !out.length) { FW.toast('没有可导出的核算结果'); return; }
    var header = ['姓名', '基本工资', '出勤天数', '应出勤天数', '满勤', '加班费', '满勤奖', '迟到扣款', '请假扣款', '补助', '应发', '实发'];
    var lines = [header.join(',')];
    out.forEach(function (r) {
      lines.push([r.name, r.base, r.attend, r.std, r.full ? '是' : '否', r.otPay, r.fullBonus, r.lateDed, r.leaveDed, r.subsidyPay, r.yingfa, r.shifa].join(','));
    });
    var csv = '﻿' + lines.join('\r\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a'); a.href = url; a.download = '工资核算_' + (new Date().toISOString().slice(0, 10)) + '.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    FW.toast('已导出 CSV');
  }

  function renderCalc() {
    var top = document.getElementById('topActions');
    if (top) {
      top.innerHTML = '<button class="btn" id="calcBack">‹ 返回工资登记</button>';
      var bk = document.getElementById('calcBack'); if (bk) bk.onclick = function () { state.tab = 'table'; render(); };
    }
    var rules = loadCalcRules();
    var html = '<div class="salary-wrap">';
    html += '<div class="tabs sal-tabs">' +
      '<button class="tab" data-tab="table">工资表</button>' +
      '<button class="tab" data-tab="records">记录管理</button>' +
      '<button class="tab" data-tab="mind">项目工资图</button>' +
      '<button class="tab active" data-tab="calc">工资核算</button>' +
      '</div>';
    html += '<p class="sal-tip">📋 上传考勤表（.xls/.xlsx/.csv），系统按下方「列映射」与「计算规则」自动核算每人<strong>实发工资</strong>。规则设置一次后会自动保存，之后每次上传同类表格即可一键核算。实发 ＝ 基本工资＋加班费＋满勤奖＋补助 − 迟到扣款 − 请假扣款。</p>';
    html += '<div class="card calc-card"><h3>① 上传考勤并核对列映射</h3>' +
      '<div class="calc-upload"><button class="btn primary" id="calcUploadBtn">📁 选择考勤文件</button><input type="file" id="calcFile" accept=".csv,.xlsx,.xls,text/csv" style="display:none"><span id="calcFileInfo" class="muted"></span></div>' +
      '<div id="calcMapArea"></div></div>';
    html += '<div class="card calc-card"><h3>② 计算规则（按需调整，自动保存）</h3>' + calcCoefHtml(rules) + '<button class="btn" id="calcSaveRules">💾 保存规则</button></div>';
    html += '<div class="card calc-card"><div class="calc-toolbar">' +
      '<button class="btn primary" id="calcRun">⚙ 核算实发工资</button>' +
      '<button class="btn" id="calcExport">⬇ 导出CSV</button>' +
      '<span id="calcMsg" class="muted"></span></div>' +
      '<div id="calcResult"></div></div>';
    html += '</div>';
    var c = document.getElementById('content'); if (c) c.innerHTML = html;
    bindTabs();
    var up = document.getElementById('calcUploadBtn'); if (up) up.onclick = function () { var f = document.getElementById('calcFile'); if (f) f.click(); };
    var fi = document.getElementById('calcFile'); if (fi) fi.onchange = function () { if (fi.files && fi.files[0]) openCalcFile(fi.files[0]); fi.value = ''; };
    var sr = document.getElementById('calcSaveRules'); if (sr) sr.onclick = function () {
      var coef = readCalcCoef(); coef.mapping = calcState.mapping || loadCalcRules().mapping || {}; saveCalcRules(coef); FW.toast('规则已保存');
    };
    var run = document.getElementById('calcRun'); if (run) run.onclick = function () { doCalc(false); };
    var ex = document.getElementById('calcExport'); if (ex) ex.onclick = function () { exportCalcCSV(calcState.result); };
    renderCalcMap();
    if (calcState.result && calcState.result.length) renderCalcResult(calcState.result);
  }

  FW.modules = FW.modules || {};
  FW.modules.salary = {
    title: '工资登记',
    render: render
  };
})(window);
