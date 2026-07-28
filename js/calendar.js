/* ============================================================
 * 申报日历提醒
 *   - 内置各税种申报期限模板（按月次月15日 / 按季季末次月15日）
 *   - 自动按当前日期算出下一个截止日 + 倒计时，逾期高亮
 *   - 可标记「已申报」（按账本持久化），临近/逾期统计卡
 *   - 纳税人类型切换（一般纳税人 / 小规模），自定义申报事项
 *   - 导出 CSV、打印
 * 说明：截止日以「次月15日」「季末次月15日」为通用规则（遇节假日顺延以
 *       税务机关通知为准）；本模块只做提醒，不构成申报依据。
 * ============================================================ */
(function (global) {
  'use strict';
  var FW = global.FW;

  /* 各税种申报模板：
     cycle 'month'  = 次月15日前申报上月
     cycle 'quarter'= 季末次月15日前申报该季度
     level：'all' 通用 / 'general' 仅一般纳税人 / 'small' 仅小规模 */
  var TEMPLATES = [
    { key: 'vat_general', name: '增值税（一般纳税人）', cycle: 'month', level: 'general', note: '一般纳税人按月申报，次月15日前完成。' },
    { key: 'surtax', name: '城建税及教育费附加', cycle: 'month', level: 'general', note: '随增值税按月申报，次月15日前。' },
    { key: 'iit', name: '个人所得税（代扣代缴）', cycle: 'month', level: 'all', note: '扣缴义务人每月15日前申报上月工资薪金等。' },
    { key: 'vat_small', name: '增值税（小规模纳税人）', cycle: 'quarter', level: 'small', note: '小规模按季申报，季末次月15日前。' },
    { key: 'cit', name: '企业所得税（预缴）', cycle: 'quarter', level: 'all', note: '按季预缴，季末次月15日前；年度汇缴次年5月31日前。' },
    { key: 'stamp', name: '印花税', cycle: 'quarter', level: 'all', note: '按季申报，季末次月15日前。' }
  ];

  /* ---------------- 纯计算（供验证/UI 共用） ---------------- */
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parseYmd(s) { var p = String(s).split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function addMonths(y, m, n) { var t = new Date(y, m - 1, 1); t.setMonth(t.getMonth() + n); return t; }
  function quarterEndMonth(m) { return (Math.floor((m - 1) / 3) + 1) * 3; }
  function monthDue(y, m) { var d = addMonths(y, m, 1); return new Date(d.getFullYear(), d.getMonth(), 15); }
  function quarterDue(y, qe) { var d = addMonths(y, qe, 1); return new Date(d.getFullYear(), d.getMonth(), 15); }
  function periodLabelMonth(y, m) { return y + '年' + m + '月'; }
  function periodLabelQuarter(y, qe) {
    var q = Math.floor((qe - 1) / 3) + 1;
    var sm = (q - 1) * 3 + 1, em = q * 3;
    return y + '年Q' + q + '（' + sm + '-' + em + '月）';
  }
  function diffDays(due, today) { return Math.ceil((due - today) / 86400000); }

  function mk(t, due, period, cycle) {
    return { key: t.key, name: t.name, note: t.note, cycle: cycle, due: due, dueStr: ymd(due), period: period };
  }

  /* 生成申报项（含最近逾期），按 due 升序 */
  function buildItems(today, opts) {
    opts = opts || {};
    var taxpayer = opts.taxpayer || 'all';
    var horizon = opts.horizonMonths || 6;
    var od = (opts.overdueDays != null) ? opts.overdueDays : 31;
    var ty = today.getFullYear(), tm = today.getMonth() + 1;
    var cutoff = new Date(today.getTime() - od * 86400000);
    var items = [];
    TEMPLATES.forEach(function (t) {
      if (taxpayer !== 'all' && t.level !== 'all' && t.level !== taxpayer) return;
      if (t.cycle === 'month') {
        for (var k = -2; k < horizon; k++) {
          var pm = addMonths(ty, tm, k);
          var py = pm.getFullYear(), pmm = pm.getMonth() + 1;
          var due = monthDue(py, pmm);
          if (due >= cutoff) items.push(mk(t, due, periodLabelMonth(py, pmm), 'month'));
        }
      } else {
        var qe0 = quarterEndMonth(tm);
        var count = Math.max(2, Math.floor(horizon / 3) + 2);
        for (var j = -1; j < count - 1; j++) {
          var qm = addMonths(ty, qe0, 3 * j);
          var qyy = qm.getFullYear(), qmm = qm.getMonth() + 1;
          var due = quarterDue(qyy, qmm);
          if (due >= cutoff) items.push(mk(t, due, periodLabelQuarter(qyy, qmm), 'quarter'));
        }
      }
    });
    items.sort(function (a, b) { return a.due - b.due; });
    return items;
  }

  /* 自定义事项的下一次截止日 */
  function genCustomDue(c, today) {
    var dom = Math.max(1, Math.min(28, c.dom || 15));
    if (c.cycle === 'month') {
      var d = new Date(today.getFullYear(), today.getMonth(), dom);
      if (d < today) d = new Date(today.getFullYear(), today.getMonth() + 1, dom);
      return { due: d, period: d.getFullYear() + '年' + (d.getMonth() + 1) + '月' };
    }
    var qe = quarterEndMonth(today.getMonth() + 1);
    for (var step = 0; step < 8; step++) {
      var qm = addMonths(today.getFullYear(), qe, 3 * step);
      var due = new Date(qm.getFullYear(), qm.getMonth() + 1, dom);
      if (due >= today) return { due: due, period: periodLabelQuarter(qm.getFullYear(), qm.getMonth() + 1) };
    }
    return null;
  }

  /* ---------------- 存储 ---------------- */
  function getFilings() { return (FW.db && FW.db.getList('tax_filings')) || []; }
  function isDone(fkey) { return getFilings().some(function (f) { return f.fkey === fkey; }); }
  function setDone(item, done) {
    var arr = getFilings().filter(function (f) { return f.fkey !== item.fkey; });
    if (done) arr.push({ fkey: item.fkey, name: item.name, period: item.period, markedAt: Date.now() });
    FW.db.saveList('tax_filings', arr);
  }

  /* ---------------- 渲染 ---------------- */
  var state = { taxpayer: 'all', filter: 'all' };
  var lastAll = [];

  function esc(s) { return FW.esc ? FW.esc(s) : String(s == null ? '' : s); }
  function fmtDays(d) { return d < 0 ? ('逾期 ' + Math.abs(d) + ' 天') : (d === 0 ? '今天截止' : ('还有 ' + d + ' 天')); }
  function badgeCls(it) {
    if (it.done) return 'done';
    if (it.days < 0) return 'danger';
    if (it.days <= 3) return 'warn';
    return '';
  }
  function badge(it) {
    if (it.done) return '<span class="badge done">已申报</span>';
    return '<span class="badge ' + badgeCls(it) + '">' + fmtDays(it.days) + '</span>';
  }
  function statCard(label, val, cls) {
    return '<div class="stat-card ' + (cls || '') + '"><div class="stat-val">' + val + '</div><div class="stat-label">' + label + '</div></div>';
  }

  function render() {
    var today = parseYmd(FW.today());
    var items = buildItems(today, { taxpayer: state.taxpayer });

    var customs = (FW.db.getList('tax_calendar_custom') || []).map(function (c) {
      var g = genCustomDue(c, today);
      if (!g) return null;
      return {
        key: 'c_' + c.id, name: c.name, note: c.note || '自定义事项', cycle: c.cycle,
        due: g.due, dueStr: ymd(g.due), period: g.period, custom: true, id: c.id
      };
    }).filter(Boolean);

    var all = items.concat(customs);
    all.forEach(function (it) {
      it.fkey = it.key + '@' + it.dueStr;
      it.days = diffDays(it.due, today);
      it.done = isDone(it.fkey);
    });
    lastAll = all;

    var view = all.filter(function (it) {
      if (state.filter === 'done') return it.done;
      if (state.filter === 'overdue') return !it.done && it.days < 0;
      if (state.filter === 'pending') return !it.done;
      return true;
    });

    var overdueN = all.filter(function (it) { return !it.done && it.days < 0; }).length;
    var pendingN = all.filter(function (it) { return !it.done && it.days >= 0; }).length;
    var nextN = null;
    all.forEach(function (it) { if (!it.done && it.days >= 0) { if (nextN === null || it.days < nextN) nextN = it.days; } });

    var c = document.getElementById('content');
    c.innerHTML =
      '<div class="card" style="margin-bottom:14px"><div class="toolbar">' +
        '<span style="font-size:13px;color:var(--muted)">纳税人类型：</span>' +
        '<select id="calTax">' +
          '<option value="all">全部</option>' +
          '<option value="general">一般纳税人</option>' +
          '<option value="small">小规模纳税人</option>' +
        '</select>' +
        '<span style="font-size:13px;color:var(--muted)">筛选：</span>' +
        '<select id="calFilter">' +
          '<option value="all">全部</option>' +
          '<option value="pending">未申报</option>' +
          '<option value="overdue">已逾期</option>' +
          '<option value="done">已申报</option>' +
        '</select>' +
        '<span class="muted" style="font-size:12px;margin-left:auto">截止日遇节假日顺延，以税务机关通知为准</span>' +
      '</div></div>' +
      '<div class="cal-stats">' +
        statCard('逾期待办', overdueN || '0', overdueN ? 'danger' : '') +
        statCard('待申报', pendingN || '0', pendingN ? 'warn' : '') +
        statCard('最近截止', nextN === null ? '—' : (nextN + ' 天后'), nextN !== null && nextN <= 3 ? 'warn' : '') +
      '</div>' +
      '<div class="cal-list print-area" id="calList">' +
        (view.length ? view.map(itemHtml).join('') : '<div class="empty" style="padding:30px">当前筛选下没有申报事项。</div>') +
      '</div>';

    // 顶部操作
    var ta = document.getElementById('topActions');
    ta.innerHTML = '<button class="btn ghost" id="calAdd">＋ 自定义事项</button>' +
      '<button class="btn ghost" id="calCsv">⬇ 导出CSV</button>' +
      '<button class="btn ghost" id="calPrint">🖨 打印</button>';

    // 控件值回填
    document.getElementById('calTax').value = state.taxpayer;
    document.getElementById('calFilter').value = state.filter;
    document.getElementById('calTax').onchange = function () { state.taxpayer = this.value; render(); };
    document.getElementById('calFilter').onchange = function () { state.filter = this.value; render(); };

    // 列表操作
    FW.qa('#calList [data-mark]').forEach(function (b) {
      b.onclick = function () { var it = findIt(b.getAttribute('data-mark')); if (it) { setDone(it, true); FW.toast('已标记：' + it.name); render(); } };
    });
    FW.qa('#calList [data-unmark]').forEach(function (b) {
      b.onclick = function () { var it = findIt(b.getAttribute('data-unmark')); if (it) { setDone(it, false); FW.toast('已撤销标记'); render(); } };
    });
    FW.qa('#calList [data-del]').forEach(function (b) {
      b.onclick = function () {
        var id = b.getAttribute('data-del');
        FW.db.saveList('tax_calendar_custom', (FW.db.getList('tax_calendar_custom') || []).filter(function (x) { return x.id !== id; }));
        FW.toast('已删除自定义事项'); render();
      };
    });

    document.getElementById('calAdd').onclick = openAddCustom;
    document.getElementById('calCsv').onclick = exportCsv;
    document.getElementById('calPrint').onclick = function () { window.print(); };
  }

  function findIt(fkey) {
    for (var i = 0; i < lastAll.length; i++) if (lastAll[i].fkey === fkey) return lastAll[i];
    return null;
  }

  function itemHtml(it) {
    return '<div class="cal-item ' + (it.done ? 'done' : '') + '">' +
      '<div class="cal-main">' +
        '<div class="cal-name">' + esc(it.name) + (it.custom ? ' <span class="tag">自定义</span>' : '') + '</div>' +
        '<div class="cal-sub">所属期：' + esc(it.period) + '　·　截止：' + esc(it.dueStr) + '</div>' +
        (it.note ? '<div class="cal-note">' + esc(it.note) + '</div>' : '') +
      '</div>' +
      '<div class="cal-side">' +
        badge(it) +
        (it.done
          ? '<button class="btn ghost sm" data-unmark="' + esc(it.fkey) + '">撤销</button>'
          : '<button class="btn sm" data-mark="' + esc(it.fkey) + '">标记已申报</button>') +
        (it.custom ? '<button class="btn ghost sm danger" data-del="' + esc(it.id) + '">删除</button>' : '') +
        (it.cycle ? '<a class="cal-go" href="https://etax.chinatax.gov.cn" target="_blank" rel="noopener">去申报 ›</a>' : '') +
      '</div>' +
    '</div>';
  }

  function openAddCustom() {
    var html = '<div class="form">' +
      '<label>事项名称<input id="ccName" placeholder="如：环保税申报、文化事业建设费"></label>' +
      '<label>周期' +
        '<select id="ccCycle"><option value="month">按月</option><option value="quarter">按季</option></select>' +
      '</label>' +
      '<label>所属日（默认15，1-28）<input id="ccDom" type="number" value="15" min="1" max="28"></label>' +
      '<label>备注<textarea id="ccNote" rows="2" placeholder="选填，如申报入口说明"></textarea></label>' +
      '<div class="modal-actions"><button class="btn ghost" data-close>取消</button><button class="btn" id="ccSave">保存</button></div>' +
    '</div>';
    var m = FW.openModal('添加自定义申报事项', html);
    var save = m.querySelector('#ccSave');
    if (save) save.onclick = function () {
      var name = m.querySelector('#ccName').value.trim();
      if (!name) { FW.toast('请填写事项名称'); return; }
      var dom = parseInt(m.querySelector('#ccDom').value, 10);
      dom = isNaN(dom) ? 15 : Math.max(1, Math.min(28, dom));
      var list = FW.db.getList('tax_calendar_custom') || [];
      list.push({ id: 'c_' + Date.now(), name: name, cycle: m.querySelector('#ccCycle').value, dom: dom, note: m.querySelector('#ccNote').value.trim() });
      FW.db.saveList('tax_calendar_custom', list);
      FW.toast('已添加：' + name);
      render();
    };
    var closeBtn = m.querySelector('[data-close]');
    if (closeBtn) closeBtn.onclick = function () { if (m.close) m.close(); else if (m.remove) m.remove(); else if (m.parentNode) m.parentNode.removeChild(m); };
  }

  function exportCsv() {
    var rows = [['税种', '所属期', '截止日', '倒计时', '状态', '备注']];
    lastAll.forEach(function (it) {
      rows.push([it.name, it.period, it.dueStr, fmtDays(it.days), it.done ? '已申报' : '未申报', it.note || '']);
    });
    var csv = '﻿' + rows.map(function (r) {
      return r.map(function (c) { return '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"'; }).join(',');
    }).join('\r\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '申报日历_' + FW.today() + '.csv';
    a.click();
    FW.toast('已导出申报日历');
  }

  // 暴露核心计算（便于自动化验证与未来复用）
  FW.calendarCalc = {
    buildItems: buildItems,
    genCustomDue: genCustomDue,
    diffDays: diffDays,
    parseYmd: parseYmd,
    TEMPLATES: TEMPLATES
  };

  FW.modules = FW.modules || {};
  FW.modules.calendar = {
    title: '申报日历',
    render: render
  };
})(window);
