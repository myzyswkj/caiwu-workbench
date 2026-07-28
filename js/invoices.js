/* ============================================================
 * 发票台账模块
 *   - 进项发票（采购）：记录销售方、税额、抵扣状态（未勾选/已勾选/已认证/不抵扣）
 *   - 销项发票（销售）：记录购买方、销项税额（应纳）
 *   - 自动汇总：进项可抵扣税额、待勾选税额、销项税额、增值税测算（含留抵）
 *   - 支持期间筛选、关键词搜索、CSV 导出、打印
 * 数据键：invoices（按账本隔离，见 db.js）
 * ============================================================ */
(function (global) {
  'use strict';
  var FW = global.FW;
  var KEY = 'invoices';
  var DEDUCT_OPTS = ['未勾选', '已勾选', '已认证', '不抵扣'];
  var KIND_OPTS = ['专票', '普票', '数电票', '机动车', '其他'];

  var state = {
    tab: 'all',          // all / in / out
    deduction: '',       // 进项抵扣筛选
    kw: '',
    from: '', to: '',
    photos: []
  };

  /* ---------- 数据读写 ---------- */
  function all() { return FW.db.getList(KEY).sort(function (a, b) { return (a.date < b.date ? 1 : a.date > b.date ? -1 : 0); }); }
  function num(v) { var n = Number(v); return isNaN(n) ? 0 : n; }
  function inRange(t, from, to) { return (!from || t.date >= from) && (!to || t.date <= to); }
  function hasKw(t) {
    if (!state.kw) return true;
    var k = state.kw.toLowerCase();
    return [t.number, t.code, t.party, t.remark, t.category].some(function (f) { return (f || '').toLowerCase().indexOf(k) >= 0; });
  }
  function filtered() {
    return all().filter(function (t) {
      if (state.tab === 'in' && t.direction !== 'in') return false;
      if (state.tab === 'out' && t.direction !== 'out') return false;
      if (state.deduction && t.direction === 'in' && t.deduction !== state.deduction) return false;
      if (!inRange(t, state.from, state.to)) return false;
      return hasKw(t);
    });
  }

  /* ---------- 汇总计算（供验证 / 复用） ---------- */
  function computeSummary(rows, from, to) {
    var list = rows.filter(function (t) { return inRange(t, from, to); });
    var ins = list.filter(function (t) { return t.direction === 'in'; });
    var outs = list.filter(function (t) { return t.direction === 'out'; });
    function sum(arr, f) { return arr.reduce(function (a, t) { return a + num(t[f]); }, 0); }
    var inTotal = sum(ins, 'total'), inAmt = sum(ins, 'amount'), inTax = sum(ins, 'tax');
    var outTotal = sum(outs, 'total'), outAmt = sum(outs, 'amount'), outTax = sum(outs, 'tax');
    var deductible = ins.filter(function (t) { return t.deduction === '已勾选' || t.deduction === '已认证'; }).reduce(function (a, t) { return a + num(t.tax); }, 0);
    var pending = ins.filter(function (t) { return t.deduction === '未勾选'; }).reduce(function (a, t) { return a + num(t.tax); }, 0);
    var nonDeduct = ins.filter(function (t) { return t.deduction === '不抵扣'; }).reduce(function (a, t) { return a + num(t.tax); }, 0);
    var vat = outTax - deductible; // 负数=留抵
    return {
      inCount: ins.length, inTotal: inTotal, inAmt: inAmt, inTax: inTax,
      outCount: outs.length, outTotal: outTotal, outAmt: outAmt, outTax: outTax,
      deductible: deductible, pending: pending, nonDeduct: nonDeduct,
      vat: vat, carryForward: vat < 0 ? -vat : 0
    };
  }

  /* ---------- 渲染辅助 ---------- */
  function money(x) { return FW.fmtMoney(x); }
  function dirMeta(t) {
    if (t.direction === 'in') return { tag: '进项', cls: 'expense' };
    return { tag: '销项', cls: 'income' };
  }
  function dedMeta(d) {
    if (d === '已勾选' || d === '已认证') return 'ok';
    if (d === '不抵扣') return 'neutral';
    return 'warn';
  }

  /* ---------- 主渲染 ---------- */
  function render() {
    var c = document.getElementById('content');
    var list = filtered();
    var s = computeSummary(all(), state.from, state.to);

    var dedOpts = '<option value="">全部抵扣状态</option>' + DEDUCT_OPTS.map(function (d) { return '<option' + (state.deduction === d ? ' selected' : '') + '>' + d + '</option>'; }).join('');

    c.innerHTML =
      '<div class="card" style="margin-bottom:14px"><div class="toolbar">' +
        '<span style="font-size:13px;color:var(--muted);align-self:center">统计期间：</span>' +
        '<button class="btn ghost sm" data-r="month">本月</button>' +
        '<button class="btn ghost sm" data-r="quarter">本季</button>' +
        '<button class="btn ghost sm" data-r="year">本年</button>' +
        '<button class="btn ghost sm" data-r="all">全部</button>' +
        '<div class="field"><input id="invFrom" type="date" value="' + FW.esc(state.from) + '" title="开始日期"></div>' +
        '<div class="field"><input id="invTo" type="date" value="' + FW.esc(state.to) + '" title="结束日期"></div>' +
      '</div></div>' +
      '<div class="stat-row" id="invSummary"></div>' +
      '<div class="tabs" id="invTabs">' +
        '<button class="tab ' + (state.tab === 'all' ? 'active' : '') + '" data-t="all">全部</button>' +
        '<button class="tab ' + (state.tab === 'in' ? 'active' : '') + '" data-t="in">进项发票</button>' +
        '<button class="tab ' + (state.tab === 'out' ? 'active' : '') + '" data-t="out">销项发票</button>' +
      '</div>' +
      '<div class="card">' +
        '<div class="toolbar">' +
          '<div class="field"><input id="invKw" placeholder="搜索发票号码/单位/备注" value="' + FW.esc(state.kw) + '"></div>' +
          (state.tab === 'in' ? '<div class="field"><select id="invDed">' + dedOpts + '</select></div>' : '') +
          '<button class="btn ghost sm" id="invReset">重置</button>' +
        '</div>' +
        '<div id="invWrap"></div>' +
      '</div>';

    // 顶部操作区
    var ta = document.getElementById('topActions');
    ta.innerHTML = '<button class="btn ghost" id="invPrint">🖨 打印</button><button class="btn ghost" id="invCsv">⬇ 导出CSV</button><button class="btn" id="addInvBtn">＋ 新增发票</button>';
    document.getElementById('invPrint').onclick = function () { window.print(); };
    document.getElementById('invCsv').onclick = exportCsv;
    document.getElementById('addInvBtn').onclick = function () { openForm(null, state.tab === 'in' ? 'in' : (state.tab === 'out' ? 'out' : 'in')); };

    drawSummary(s);
    drawTable(list);

    // 事件
    FW.qa('#content [data-r]').forEach(function (b) { b.onclick = function () { setRange(b.dataset.r); }; });
    var gf = document.getElementById('invFrom'), gt = document.getElementById('invTo');
    if (gf) gf.onchange = function () { state.from = this.value; render(); };
    if (gt) gt.onchange = function () { state.to = this.value; render(); };
    var gk = document.getElementById('invKw'); if (gk) gk.oninput = function () { state.kw = this.value.trim(); drawTable(filtered()); };
    var gd = document.getElementById('invDed'); if (gd) gd.onchange = function () { state.deduction = this.value; drawTable(filtered()); };
    var gr = document.getElementById('invReset'); if (gr) gr.onclick = function () { state.kw = ''; state.deduction = ''; state.from = ''; state.to = ''; render(); };
    FW.qa('#invTabs .tab').forEach(function (b) {
      b.onclick = function () { state.tab = b.dataset.t; state.deduction = ''; FW.qa('#invTabs .tab').forEach(function (x) { x.classList.toggle('active', x === b); }); render(); };
    });
  }

  function drawSummary(s) {
    var el = document.getElementById('invSummary');
    if (!el) return;
    el.innerHTML =
      '<div class="stat"><div class="label">进项（' + s.inCount + '份）</div><div class="value">' + money(s.inTotal) + '</div><div class="sub">税额 ' + money(s.inTax) + '</div></div>' +
      '<div class="stat"><div class="label">进项·可抵扣</div><div class="value income">' + money(s.deductible) + '</div><div class="sub">已勾选+已认证</div></div>' +
      '<div class="stat"><div class="label">进项·待勾选</div><div class="value ' + (s.pending > 0 ? 'expense' : '') + '">' + money(s.pending) + '</div><div class="sub">待认证</div></div>' +
      '<div class="stat"><div class="label">销项（' + s.outCount + '份）</div><div class="value">' + money(s.outTotal) + '</div><div class="sub">销项税额 ' + money(s.outTax) + '</div></div>' +
      '<div class="stat"><div class="label">增值税测算</div><div class="value ' + (s.vat >= 0 ? 'expense' : 'income') + '">' + money(s.vat) + '</div><div class="sub">' + (s.vat < 0 ? ('留抵 ' + money(s.carryForward)) : '应纳') + '</div></div>';
  }

  function drawTable(rows) {
    var el = document.getElementById('invWrap');
    if (!el) return;
    if (!rows.length) {
      el.innerHTML = '<div class="empty">没有符合条件的发票。点右上角「＋ 新增发票」登记第一张，或切到「全部」查看。</div>';
      return;
    }
    var trs = rows.map(function (t) {
      var dm = dirMeta(t);
      var ded = t.direction === 'in'
        ? '<span class="tag ' + dedMeta(t.deduction) + '">' + FW.esc(t.deduction || '未勾选') + '</span>'
        : '<span class="muted">—</span>';
      return '<tr>' +
        '<td class="nowrap">' + FW.esc(t.date) + '</td>' +
        '<td><span class="tag ' + dm.cls + '">' + dm.tag + '</span></td>' +
        '<td>' + FW.esc(t.kind || '—') + '</td>' +
        '<td>' + FW.esc(t.number || '') + (t.code ? '<div class="muted" style="font-size:11px">代码 ' + FW.esc(t.code) + '</div>' : '') + '</td>' +
        '<td>' + FW.esc(t.party || '—') + '</td>' +
        '<td>' + (t.category ? FW.esc(t.category) : '<span class="muted">—</span>') + '</td>' +
        '<td class="num">' + money(t.total) + '</td>' +
        '<td class="num">' + (t.direction === 'in' ? '<span class="expense">' + money(t.tax) + '</span>' : '<span class="income">' + money(t.tax) + '</span>') + '</td>' +
        '<td>' + ded + '</td>' +
        '<td>' + FW.esc(t.remark || '') + '</td>' +
        '<td class="row-actions nowrap"><button class="btn ghost sm row-edit" data-id="' + t.id + '">编辑</button><button class="btn danger sm row-del" data-id="' + t.id + '">删</button></td>' +
        '</tr>';
    }).join('');
    el.innerHTML = '<table><thead><tr>' +
      '<th>日期</th><th>方向</th><th>类型</th><th>发票号码</th><th>对方单位</th><th>用途分类</th><th class="num">价税合计</th><th class="num">税额</th><th>抵扣状态</th><th>备注</th><th>操作</th>' +
      '</tr></thead><tbody>' + trs + '</tbody></table>';
    FW.qa('#invWrap .row-edit').forEach(function (b) { b.onclick = function () { openForm(b.dataset.id); }; });
    FW.qa('#invWrap .row-del').forEach(function (b) { b.onclick = function () { delInv(b.dataset.id); }; });
  }

  /* ---------- 新增 / 编辑 表单 ---------- */
  function openForm(id, presetDir) {
    var edit = id ? FW.db.getById(KEY, id) : null;
    var v = {
      date: FW.today(), direction: presetDir || 'in', kind: '专票',
      code: '', number: '', party: '', amount: '', tax: '', total: '',
      deduction: '未勾选', category: '', remark: '', photos: []
    };
    if (edit) {
      v = {
        date: edit.date || FW.today(), direction: edit.direction || 'in', kind: edit.kind || '专票',
        code: edit.code || '', number: edit.number || '', party: edit.party || '',
        amount: edit.amount, tax: edit.tax, total: edit.total,
        deduction: edit.deduction || '未勾选', category: edit.category || '', remark: edit.remark || '', photos: edit.photos || []
      };
    }
    state.photos = v.photos.slice();

    var cats = (FW.modules.internal && FW.modules.internal.cats) ? FW.modules.internal.cats() : [];
    var catOpts = '<option value="">（不归类）</option>' + cats.map(function (c) { return '<option ' + (c.name === v.category ? 'selected' : '') + '>' + FW.esc(c.name) + '</option>'; }).join('');

    function dirHtml() {
      var sel = (v.direction === 'in')
        ? '<option value="in" selected>进项（采购·可抵扣）</option><option value="out">销项（销售·应纳）</option>'
        : '<option value="in">进项（采购·可抵扣）</option><option value="out" selected>销项（销售·应纳）</option>';
      return '<select id="f_dir">' + sel + '</select>';
    }

    var body =
      '<div class="form-grid">' +
        '<div class="field"><label>方向</label>' + dirHtml() + '</div>' +
        '<div class="field"><label>发票类型</label><select id="f_kind">' + KIND_OPTS.map(function (k) { return '<option ' + (k === v.kind ? 'selected' : '') + '>' + k + '</option>'; }).join('') + '</select></div>' +
        '<div class="field"><label>开票日期</label><input id="f_date" type="date" value="' + FW.esc(v.date) + '"></div>' +
        '<div class="field"><label>发票号码</label><input id="f_no" value="' + FW.esc(v.number) + '" placeholder="发票号码（必填）"></div>' +
        '<div class="field"><label>发票代码</label><input id="f_code" value="' + FW.esc(v.code) + '" placeholder="选填"></div>' +
        '<div class="field full"><label>对方单位名称</label><input id="f_party" value="' + FW.esc(v.party) + '" placeholder="进项填销售方 / 销项填购买方"></div>' +
        '<div class="field"><label>不含税金额（元）</label><input id="f_amt" type="number" step="0.01" min="0" value="' + FW.esc(v.amount) + '"></div>' +
        '<div class="field"><label>税额（元）</label><input id="f_tax" type="number" step="0.01" min="0" value="' + FW.esc(v.tax) + '"></div>' +
        '<div class="field"><label>价税合计（元）</label><input id="f_total" type="number" step="0.01" min="0" value="' + FW.esc(v.total) + '" placeholder="留空自动算"></div>' +
        '<div class="field"><label>用途分类</label><select id="f_cat">' + catOpts + '</select></div>' +
        '<div class="field" id="dedField"><label>抵扣状态</label><select id="f_ded">' + DEDUCT_OPTS.map(function (d) { return '<option ' + (d === v.deduction ? 'selected' : '') + '>' + d + '</option>'; }).join('') + '</select></div>' +
        '<div class="field full"><label>备注</label><textarea id="f_remark" rows="2" placeholder="用途说明 / 关联单据">' + FW.esc(v.remark) + '</textarea></div>' +
        '<div class="field full"><label>发票 / 凭证照片</label><div class="photo-grid" id="photoGrid"></div></div>' +
      '</div>' +
      '<div class="form-actions"><button class="btn ghost" id="invCancel">取消</button><button class="btn" id="invSave">保存</button></div>';

    FW.openModal(edit ? '编辑发票' : '新增发票', body, function () {
      var dirSel = document.getElementById('f_dir');
      function syncDir() {
        var isIn = dirSel.value === 'in';
        document.getElementById('dedField').style.display = isIn ? '' : 'none';
      }
      dirSel.onchange = syncDir; syncDir();
      renderPhotoGrid(state.photos);

      // 自动计算价税合计
      function autoTotal() {
        var a = num(document.getElementById('f_amt').value);
        var tx = num(document.getElementById('f_tax').value);
        var tt = document.getElementById('f_total');
        if (a > 0 && tx > 0 && !tt.value) tt.value = (a + tx).toFixed(2);
      }
      document.getElementById('f_amt').oninput = autoTotal;
      document.getElementById('f_tax').oninput = autoTotal;

      document.getElementById('invCancel').onclick = FW.closeModal;
      document.getElementById('invSave').onclick = function () {
        var number = document.getElementById('f_no').value.trim();
        if (!number) { FW.toast('请填写发票号码'); return; }
        var amount = num(document.getElementById('f_amt').value);
        var tax = num(document.getElementById('f_tax').value);
        var totalRaw = document.getElementById('f_total').value;
        var total = totalRaw ? num(totalRaw) : (amount + tax);
        if (!(total > 0)) { FW.toast('价税合计必须大于 0'); return; }
        var direction = dirSel.value;
        var rec = {
          id: edit ? edit.id : FW.db.uid('inv_'),
          direction: direction,
          kind: document.getElementById('f_kind').value,
          code: document.getElementById('f_code').value.trim(),
          number: number,
          date: document.getElementById('f_date').value || FW.today(),
          party: document.getElementById('f_party').value.trim(),
          amount: amount, tax: tax, total: total,
          deduction: direction === 'in' ? document.getElementById('f_ded').value : '',
          category: document.getElementById('f_cat').value,
          remark: document.getElementById('f_remark').value.trim(),
          photos: state.photos
        };
        FW.db.upsert(KEY, rec);
        FW.closeModal(); render(); FW.toast('已保存');
      };
    });
  }

  function delInv(id) {
    var rec = FW.db.getById(KEY, id);
    if (!rec) return;
    if (!confirm('确定删除该张发票？' + (rec.photos && rec.photos.length ? '（将同时删除 ' + rec.photos.length + ' 张凭证照片）' : ''))) return;
    FW.db.remove(KEY, id);
    if (rec.photos && rec.photos.length) FW.db.deletePhotos(rec.photos);
    render(); FW.toast('已删除');
  }

  /* ---------- 照片网格（复刻 internal 的精简版） ---------- */
  function renderPhotoGrid(photos) {
    var grid = document.getElementById('photoGrid');
    if (!grid) return;
    grid.innerHTML = '';
    (photos || []).forEach(function (pid) {
      var wrap = document.createElement('div'); wrap.style.position = 'relative';
      var img = document.createElement('img'); img.className = 'photo-thumb';
      FW.db.getPhoto(pid).then(function (d) { if (d) img.src = d; }).catch(function () {});
      var del = document.createElement('span');
      del.textContent = '✕'; del.style.cssText = 'position:absolute;top:-6px;right:-6px;background:#d33;color:#fff;border-radius:50%;width:16px;height:16px;font-size:11px;line-height:16px;text-align:center;cursor:pointer';
      del.onclick = function () { photos.splice(photos.indexOf(pid), 1); FW.db.deletePhoto(pid); renderPhotoGrid(photos); };
      img.style.cursor = 'pointer';
      wrap.appendChild(img); wrap.appendChild(del); grid.appendChild(wrap);
    });
    var add = document.createElement('div'); add.className = 'photo-add'; add.textContent = '＋'; add.title = '上传凭证照片';
    add.onclick = function () {
      var inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = true;
      inp.onchange = function () {
        var files = Array.prototype.slice.call(inp.files);
        var pending = files.map(function (f) { return new Promise(function (res) { var r = new FileReader(); r.onload = function () { FW.db.savePhoto(r.result).then(res); }; r.readAsDataURL(f); }); });
        Promise.all(pending).then(function (ids) { ids.forEach(function (i) { photos.push(i); }); renderPhotoGrid(photos); });
      };
      inp.click();
    };
    grid.appendChild(add);
  }

  /* ---------- 期间 ---------- */
  function setRange(kind) {
    var now = new Date(), y = now.getFullYear(), m = now.getMonth(), p = function (n) { return n < 10 ? '0' + n : '' + n; };
    if (kind === 'month') { state.from = y + '-' + p(m + 1) + '-01'; state.to = y + '-' + p(m + 1) + '-' + new Date(y, m + 1, 0).getDate(); }
    else if (kind === 'quarter') { var q = Math.floor(m / 3) * 3; state.from = y + '-' + p(q + 1) + '-01'; state.to = y + '-' + p(q + 3) + '-' + new Date(y, q + 3, 0).getDate(); }
    else if (kind === 'year') { state.from = y + '-01-01'; state.to = y + '-12-31'; }
    else { state.from = ''; state.to = ''; }
    render();
  }

  /* ---------- 导出 CSV ---------- */
  function exportCsv() {
    var rows = filtered();
    if (!rows.length) { FW.toast('没有可导出的发票'); return; }
    var head = ['日期', '方向', '类型', '发票代码', '发票号码', '对方单位', '用途分类', '不含税金额', '税额', '价税合计', '抵扣状态', '备注'];
    var data = rows.map(function (t) {
      return [t.date, t.direction === 'in' ? '进项' : '销项', t.kind || '', t.code || '', t.number, t.party || '', t.category || '', t.amount, t.tax, t.total, t.direction === 'in' ? (t.deduction || '未勾选') : '', t.remark || ''];
    });
    var csv = '﻿' + [head].concat(data).map(function (r) {
      return r.map(function (c) { return '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"'; }).join(',');
    }).join('\r\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '发票台账_' + FW.today() + '.csv';
    a.click();
    FW.toast('已导出 ' + rows.length + ' 张发票（CSV）');
  }

  // 暴露核心计算（便于自动化验证与未来复用）
  FW.invoiceCalc = { computeSummary: computeSummary };

  FW.modules = FW.modules || {};
  FW.modules.invoices = {
    title: '发票台账',
    render: render
  };
})(window);
