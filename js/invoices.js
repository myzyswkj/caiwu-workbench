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
  if (global.pdfjsLib) { try { global.pdfjsLib.GlobalWorkerOptions.workerSrc = 'js/vendor/pdf.worker.min.js'; } catch (e) {} }
  var KEY = 'invoices';
  var CONTRACT_KEY = 'contracts';
  var STOCK_KEY = 'stock';
  var DEDUCT_OPTS = ['未勾选', '已勾选', '已认证', '不抵扣'];
  var KIND_OPTS = ['专票', '普票', '数电票', '机动车', '其他'];
  var STATUS_OPTS = ['待签订', '履行中', '已完成', '已终止'];
  var CTYPE_OPTS = ['采购合同', '销售合同', '服务合同', '工程合同', '其他'];
  var PAY_OPTS = ['一次性付款', '分期付款', '月结', '货到付款', '其他'];
  // 库存台账：出入库 / 退货类型（dir: in 入库方向 / out 出库方向）
  var STOCK_TYPES = [
    { label: '采购入库', dir: 'in' },
    { label: '其他入库', dir: 'in' },
    { label: '销售退货', dir: 'in' },
    { label: '销售出库', dir: 'out' },
    { label: '其他出库', dir: 'out' },
    { label: '采购退货', dir: 'out' }
  ];
  function stockDir(label) { var t = STOCK_TYPES.filter(function (x) { return x.label === label; })[0]; return t ? t.dir : 'in'; }

  var state = {
    tab: 'all',          // all / in / out / contract / stock
    deduction: '',       // 进项抵扣筛选
    kw: '',
    from: '', to: '',
    photos: [],
    // 合同台账筛选
    ctKw: '', ctFrom: '', ctTo: '', ctStatus: '',
    ctPhotos: [], ctDocFiles: [], ctAttachments: [],
    // 库存台账筛选
    stKw: '', stFrom: '', stTo: '', stType: '',
    stPhotos: []
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

  /* ---------- 主渲染（按 tab 分发） ---------- */
  function render() {
    if (state.tab === 'contract') return renderContractView();
    if (state.tab === 'stock') return renderStockView();
    return renderInvoiceView();
  }

  function renderInvoiceView() {
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

  /* ============================================================
   * 合同台账（与发票台账共用模块，作为第 4 个 tab）
   *   - 记录合同编号 / 名称 / 对方单位 / 类型 / 签订·到期日 / 金额 / 付款方式 / 履行状态
   *   - 自动汇总：合同总数、合同总金额、各状态金额（履行中/已完成/已终止）
   *   - 到期提醒（履行中且到期日早于今天标红）
   *   - 支持期间筛选、状态筛选、关键词搜索、CSV 导出、合同照片附件
   * 数据键：contracts（按账本隔离，见 db.js）
   * ============================================================ */
  function contractsAll() { return FW.db.getList(CONTRACT_KEY).sort(function (a, b) { return (a.signDate < b.signDate ? 1 : a.signDate > b.signDate ? -1 : 0); }); }
  function isOverdue(t) {
    if (!t.dueDate) return false;
    if (t.status === '已完成' || t.status === '已终止') return false;
    return t.dueDate < FW.today();
  }
  function contractsFiltered(kw, from, to, status) {
    var rows = contractsAll();
    if (status) rows = rows.filter(function (t) { return (t.status || '待签订') === status; });
    if (from) rows = rows.filter(function (t) { return t.signDate >= from; });
    if (to) rows = rows.filter(function (t) { return t.signDate <= to; });
    if (kw) {
      var k = kw.toLowerCase();
      rows = rows.filter(function (t) {
        return [t.no, t.name, t.party, t.type, t.owner, t.remark].some(function (f) { return (f || '').toLowerCase().indexOf(k) >= 0; });
      });
    }
    return rows;
  }
  function contractSummary(rows) {
    var byStatus = {};
    STATUS_OPTS.forEach(function (st) { byStatus[st] = 0; });
    rows.forEach(function (t) { byStatus[t.status || '待签订'] = (byStatus[t.status || '待签订'] || 0) + num(t.amount); });
    var total = rows.reduce(function (a, t) { return a + num(t.amount); }, 0);
    return { count: rows.length, total: total, byStatus: byStatus };
  }

  function renderContractView() {
    var c = document.getElementById('content');
    var kw = state.ctKw || '', from = state.ctFrom || '', to = state.ctTo || '', status = state.ctStatus || '';
    var rows = contractsFiltered(kw, from, to, status);
    var s = contractSummary(contractsAll());
    var statusOpts = '<option value="">全部状态</option>' + STATUS_OPTS.map(function (d) { return '<option' + (status === d ? ' selected' : '') + '>' + d + '</option>'; }).join('');

    c.innerHTML =
      '<div class="card" style="margin-bottom:14px"><div class="toolbar">' +
        '<span style="font-size:13px;color:var(--muted);align-self:center">签订期间：</span>' +
        '<button class="btn ghost sm" data-r="cmonth">本月</button>' +
        '<button class="btn ghost sm" data-r="cyear">本年</button>' +
        '<button class="btn ghost sm" data-r="call">全部</button>' +
        '<div class="field"><input id="ctFrom" type="date" value="' + FW.esc(from) + '" title="开始日期"></div>' +
        '<div class="field"><input id="ctTo" type="date" value="' + FW.esc(to) + '" title="结束日期"></div>' +
      '</div></div>' +
      '<div class="stat-row" id="ctSummary"></div>' +
      '<div class="card">' +
        '<div class="toolbar">' +
          '<div class="field"><input id="ctKw" placeholder="搜索合同编号/名称/对方单位" value="' + FW.esc(kw) + '"></div>' +
          '<div class="field"><select id="ctStatus">' + statusOpts + '</select></div>' +
          '<button class="btn ghost sm" id="ctReset">重置</button>' +
        '</div>' +
        '<div id="ctWrap"></div>' +
      '</div>';

    var ta = document.getElementById('topActions');
    ta.innerHTML = '<button class="btn ghost" id="ctPrint">🖨 打印</button><button class="btn ghost" id="ctCsv">⬇ 导出CSV</button><button class="btn" id="addCtBtn">＋ 新增合同</button>';
    document.getElementById('ctPrint').onclick = function () { window.print(); };
    document.getElementById('ctCsv').onclick = exportContractCsv;
    document.getElementById('addCtBtn').onclick = function () { openContractForm(null); };

    drawContractSummary(s);
    drawContractTable(rows);

    FW.qa('#content [data-r]').forEach(function (b) { b.onclick = function () { setContractRange(b.dataset.r); }; });
    var cf = document.getElementById('ctFrom'), ct = document.getElementById('ctTo');
    if (cf) cf.onchange = function () { state.ctFrom = this.value; renderContractView(); };
    if (ct) ct.onchange = function () { state.ctTo = this.value; renderContractView(); };
    var ck = document.getElementById('ctKw'); if (ck) ck.oninput = function () { state.ctKw = this.value.trim(); drawContractTable(contractsFiltered(state.ctKw, state.ctFrom, state.ctTo, state.ctStatus)); };
    var cs = document.getElementById('ctStatus'); if (cs) cs.onchange = function () { state.ctStatus = this.value; drawContractTable(contractsFiltered(state.ctKw, state.ctFrom, state.ctTo, state.ctStatus)); };
    var cr = document.getElementById('ctReset'); if (cr) cr.onclick = function () { state.ctKw = ''; state.ctStatus = ''; state.ctFrom = ''; state.ctTo = ''; renderContractView(); };
  }

  function drawContractSummary(s) {
    var el = document.getElementById('ctSummary');
    if (!el) return;
    el.innerHTML =
      '<div class="stat"><div class="label">合同总数</div><div class="value">' + s.count + '</div><div class="sub">份</div></div>' +
      '<div class="stat"><div class="label">合同总金额</div><div class="value income">' + money(s.total) + '</div><div class="sub">所有状态合计</div></div>' +
      '<div class="stat"><div class="label">履行中金额</div><div class="value">' + money(s.byStatus['履行中'] || 0) + '</div><div class="sub">进行中</div></div>' +
      '<div class="stat"><div class="label">已完成金额</div><div class="value">' + money(s.byStatus['已完成'] || 0) + '</div><div class="sub">已结</div></div>' +
      '<div class="stat"><div class="label">已终止金额</div><div class="value expense">' + money(s.byStatus['已终止'] || 0) + '</div><div class="sub">中止/取消</div></div>';
  }

  function drawContractTable(rows) {
    var el = document.getElementById('ctWrap');
    if (!el) return;
    if (!rows.length) {
      el.innerHTML = '<div class="empty">没有符合条件的合同。点右上角「＋ 新增合同」登记第一份，或调整筛选条件。</div>';
      return;
    }
    var trs = rows.map(function (t) {
      var st = t.status || '待签订';
      var stCls = st === '已完成' ? 'ok' : (st === '已终止' ? 'neutral' : 'warn');
      var due = t.dueDate ? '<span class="' + (isOverdue(t) ? 'expense' : 'muted') + '">' + FW.esc(t.dueDate) + '</span>' : '<span class="muted">—</span>';
      var amt = '<span class="' + (num(t.amount) < 0 ? 'expense' : '') + '">' + money(t.amount) + '</span>';
      return '<tr>' +
        '<td class="nowrap">' + FW.esc(t.no || '') + '</td>' +
        '<td>' + FW.esc(t.name || '—') + (t.type ? '<div class="muted" style="font-size:11px">' + FW.esc(t.type) + '</div>' : '') + '</td>' +
        '<td>' + FW.esc(t.party || '—') + '</td>' +
        '<td class="nowrap">' + FW.esc(t.signDate || '—') + '</td>' +
        '<td class="num">' + amt + '</td>' +
        '<td>' + (t.payMethod ? FW.esc(t.payMethod) : '<span class="muted">—</span>') + '</td>' +
        '<td><span class="tag ' + stCls + '">' + FW.esc(st) + '</span></td>' +
        '<td class="nowrap">' + due + '</td>' +
        '<td>' + FW.esc(t.remark || '') + '</td>' +
        (function () { var c = (t.docFiles ? t.docFiles.length : 0) + (t.attachments ? t.attachments.length : 0) + (t.photos ? t.photos.length : 0); return '<td class="nowrap">' + (c ? '<button class="btn ghost sm" data-att="' + t.id + '">📎 ' + c + '</button>' : '<span class="muted">—</span>') + '</td>'; })() +
        '<td class="row-actions nowrap"><button class="btn ghost sm row-edit" data-id="' + t.id + '">编辑</button><button class="btn danger sm row-del" data-id="' + t.id + '">删</button></td>' +
        '</tr>';
    }).join('');
    el.innerHTML = '<table><thead><tr>' +
      '<th>合同编号</th><th>合同名称</th><th>对方单位</th><th>签订日期</th><th class="num">合同金额</th><th>付款方式</th><th>履行状态</th><th>到期日</th><th>备注</th><th>附件</th><th>操作</th>' +
      '</tr></thead><tbody>' + trs + '</tbody></table>';
    FW.qa('#ctWrap .row-edit').forEach(function (b) { b.onclick = function () { openContractForm(b.dataset.id); }; });
    FW.qa('#ctWrap .row-del').forEach(function (b) { b.onclick = function () { delContract(b.dataset.id); }; });
    FW.qa('#ctWrap [data-att]').forEach(function (b) { b.onclick = function () { openContractAttachments(b.dataset.att); }; });
  }

  /* ===== 合同文档解析与附件 ===== */
  function fileExt(name) { var i = (name || '').lastIndexOf('.'); return i >= 0 ? (name.slice(i + 1).toLowerCase()) : ''; }
  function fileToUint8(dataUrl) {
    var b64 = (dataUrl || '').split(',')[1] || '';
    var bin = atob(b64);
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }
  function readAsArrayBuffer(file) {
    return new Promise(function (res) {
      var r = new FileReader();
      r.onload = function () { res(r.result); };
      r.onerror = function () { res(null); };
      r.readAsArrayBuffer(file);
    });
  }
  // 从上传文件提取纯文本；图片/不支持格式返回 ''
  function extractTextFromFile(file, dataUrl) {
    var ext = fileExt(file.name);
    if (ext === 'txt' || ext === 'text' || file.type === 'text/plain') {
      return new Promise(function (res) {
        var r = new FileReader();
        r.onload = function () { res(r.result); };
        r.onerror = function () { res(''); };
        r.readAsText(file, 'utf-8');
      });
    }
    if (ext === 'pdf') {
      if (!global.pdfjsLib) return Promise.resolve('');
      try {
        var loadingTask = global.pdfjsLib.getDocument({ data: fileToUint8(dataUrl) });
        return loadingTask.promise.then(function (pdf) {
          var tasks = [];
          for (var p = 1; p <= pdf.numPages; p++) {
            tasks.push(pdf.getPage(p).then(function (pg) {
              return pg.getTextContent().then(function (tc) {
                return tc.items.map(function (it) { return it.str || ''; }).join(' ');
              });
            }));
          }
          return Promise.all(tasks).then(function (arr) { return arr.join('\n'); });
        }).catch(function () { return ''; });
      } catch (e) { return Promise.resolve(''); }
    }
    if (ext === 'docx') {
      if (!global.mammoth) return Promise.resolve('');
      try {
        return readAsArrayBuffer(file).then(function (ab) {
          if (!ab) return '';
          return global.mammoth.extractRawText({ arrayBuffer: ab }).then(function (r) { return r.value || ''; }).catch(function () { return ''; });
        }).catch(function () { return ''; });
      } catch (e) { return Promise.resolve(''); }
    }
    if (ext === 'xlsx' || ext === 'xls') {
      if (!global.XLSX) return Promise.resolve('');
      try {
        return readAsArrayBuffer(file).then(function (ab) {
          if (!ab) return '';
          var wb = global.XLSX.read(ab, { type: 'array' });
          return wb.SheetNames.map(function (sn) { return global.XLSX.utils.sheet_to_csv(wb.Sheets[sn]); }).join('\n');
        }).catch(function () { return ''; });
      } catch (e) { return Promise.resolve(''); }
    }
    return Promise.resolve('');
  }
  function ymd(y, m, d) {
    return y + '-' + (+m < 10 ? '0' + (+m) : '' + (+m)) + '-' + (+d < 10 ? '0' + (+d) : '' + (+d));
  }
  function firstDateNear(text, kwRe) {
    var m = text.match(kwRe);
    if (m) {
      var near = text.slice(m.index, m.index + 80);
      var d = near.match(/(\d{4})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})/);
      if (d) return ymd(d[1], d[2], d[3]);
    }
    return '';
  }
  function firstDateInText(text) {
    var d = text.match(/(\d{4})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})/);
    return d ? ymd(d[1], d[2], d[3]) : '';
  }
  function parseAmount(str) {
    if (!str) return 0;
    var m = ('' + str).match(/([\d][\d,]*\.?\d*)\s*(万|亿)?/);
    if (!m) return 0;
    var n = parseFloat(m[1].replace(/,/g, ''));
    if (isNaN(n)) return 0;
    if (m[2] === '万') n *= 10000;
    else if (m[2] === '亿') n *= 100000000;
    return n;
  }
  // 从合同文本提取关键字段（仅返回能识别到的项），fileName 用于兜底合同名称
  function extractContractFields(text, fileName) {
    text = text || '';
    var out = {};
    var noM = text.match(/(?:合同编号|合同号|编号|NO\.?|No\.?)\s*[:：]?\s*([A-Za-z0-9][A-Za-z0-9\-_／/\u4e00-\u9fa5]{2,30})/i)
          || text.match(/(?:HT|合同)\s*[-_]\s*([A-Za-z0-9\-_／/]{3,30})/i);
    if (noM) out.no = noM[1].trim();
    var name = fileName ? fileName.replace(/\.[^.]+$/, '') : '';
    var nameM = text.match(/(?:项目名称|工程名称|协议名称|关于)\s*[:：]?\s*([^\n，,。；;]{2,40}?)(?:的|合同|协议)/);
    if (!name && nameM) name = nameM[1].trim();
    if (name) out.name = name;
    var partyM = text.match(/(?:甲方|乙方|供方|需方|卖方|买方|出租方|承租方|发包方|承包方|定作方|承揽方|委托方|受托方|采购方|销售方)\s*[:：]?\s*[（(]?\s*([^\n，,。；;）)]{2,40})/);
    if (partyM) out.party = partyM[1].trim();
    else { var compM = text.match(/([^\n，,。；;（）()]{2,30}?(?:有限公司|股份公司|公司|集团))/); if (compM) out.party = compM[1].trim(); }
    out.signDate = firstDateNear(text, /(?:签订|签署|订立|签约|日期)/) || firstDateInText(text);
    out.dueDate = firstDateNear(text, /(?:到期|终止|届满|完毕)/);
    var amtM = text.match(/(?:合同总价|合同总价款|总价|合同价款|合同金额|总金额|价款|金额)\s*[:：]?\s*(?:人民币|RMB|￥|¥)?\s*([\d][\d,]*\.?\d*)\s*(万|亿元|万元|元|万)?/i);
    if (amtM) out.amount = parseAmount(amtM[1] + (amtM[2] || ''));
    var payMap = ['一次性付款', '分期付款', '月结', '货到付款', '按进度付款', '先款后货', '年付', '季付', '月付'];
    for (var i = 0; i < payMap.length; i++) { if (text.indexOf(payMap[i]) >= 0) { out.payMethod = payMap[i]; break; } }
    var ownerM = text.match(/(?:负责人|经办人|联系人)\s*[:：]?\s*([^\n，,。；;]{2,10}?)(?:[，,。；;]|$)/);
    if (ownerM) out.owner = ownerM[1].trim();
    return out;
  }
  // 把识别到的字段回填到表单（不覆盖用户已填内容）
  function fillContractFields(ext) {
    var map = { no: 'c_no', name: 'c_name', party: 'c_party', signDate: 'c_sign', dueDate: 'c_due', amount: 'c_amt', payMethod: 'c_pay', owner: 'c_owner' };
    var filled = 0;
    Object.keys(ext).forEach(function (k) {
      var id = map[k]; if (!id) return;
      var el = document.getElementById(id); if (!el) return;
      if (k === 'payMethod') {
        if (!el.value) { el.value = ext.payMethod; filled++; }
        return;
      }
      if (!el.value) { el.value = ext[k]; filled++; }
    });
    return filled;
  }
  function fileIcon(type, ext) {
    if (ext === 'pdf') return '📕';
    if (ext === 'doc' || ext === 'docx') return '📘';
    if (ext === 'xls' || ext === 'xlsx') return '📗';
    if (ext === 'txt' || ext === 'text') return '📄';
    if ((type || '').indexOf('image/') === 0) return '🖼';
    return '📎';
  }
  function downloadFile(id, name) {
    FW.db.getPhoto(id).then(function (d) {
      if (!d) { FW.toast('文件已丢失'); return; }
      var a = document.createElement('a');
      a.href = d; a.download = name || 'file';
      document.body.appendChild(a); a.click();
      try { document.body.removeChild(a); } catch (e) {}
    }).catch(function () { FW.toast('文件读取失败'); });
  }
  function openFile(id, name) {
    FW.db.getPhoto(id).then(function (d) {
      if (!d) { FW.toast('文件已丢失'); return; }
      window.open(d, '_blank');
    }).catch(function () { FW.toast('文件读取失败'); });
  }
  // 渲染文件网格（合同正文文档 docFiles / 相关附件 attachments）；doExtract=true 时上传后自动解析提取字段
  function renderContractFileGrid(gridId, files, doExtract) {
    var grid = document.getElementById(gridId);
    if (!grid) return;
    grid.innerHTML = '';
    (files || []).forEach(function (f) {
      var ext = fileExt(f.name);
      var row = document.createElement('div'); row.className = 'ct-file';
      var sz = f.size ? (f.size > 1048576 ? (f.size / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round(f.size / 1024)) + 'KB') : '';
      row.innerHTML = '<span class="ct-file-ic">' + fileIcon(f.type, ext) + '</span>' +
        '<span class="ct-file-name" title="' + FW.esc(f.name) + '">' + FW.esc(f.name) + '</span>' +
        '<span class="ct-file-sz muted">' + sz + '</span>' +
        '<span class="ct-file-act"><a href="#" data-act="open">预览</a><a href="#" data-act="dl">下载</a><a href="#" data-act="del">删除</a></span>';
      row.querySelector('[data-act="dl"]').onclick = function (e) { e.preventDefault(); downloadFile(f.id, f.name); };
      row.querySelector('[data-act="open"]').onclick = function (e) { e.preventDefault(); openFile(f.id, f.name); };
      row.querySelector('[data-act="del"]').onclick = function (e) {
        e.preventDefault();
        files.splice(files.indexOf(f), 1); FW.db.deletePhoto(f.id); renderContractFileGrid(gridId, files, doExtract);
      };
      grid.appendChild(row);
    });
    var add = document.createElement('div'); add.className = 'ct-file-add'; add.textContent = '＋ 上传';
    add.onclick = function () {
      var inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = doExtract ? '.pdf,.doc,.docx,.txt,.xlsx,.xls,image/*' : '*';
      inp.multiple = true;
      inp.onchange = function () {
        Array.prototype.slice.call(inp.files).forEach(function (file) {
          var reader = new FileReader();
          reader.onload = function () {
            FW.db.savePhoto(reader.result).then(function (fid) {
              var rec = { id: fid, name: file.name, type: file.type || '', size: file.size || 0 };
              files.push(rec);
              renderContractFileGrid(gridId, files, doExtract);
              if (doExtract) {
                extractTextFromFile(file, reader.result).then(function (txt) {
                  if (txt && txt.trim()) {
                    var ext = extractContractFields(txt, file.name);
                    var n = fillContractFields(ext);
                    if (n > 0) FW.toast('已从「' + file.name + '」识别并填入 ' + n + ' 项信息，请核对');
                  } else {
                    showOcrHint(file.name, gridId);
                  }
                });
              }
            });
          };
          reader.readAsDataURL(file);
        });
      };
      inp.click();
    };
      grid.appendChild(add);
  }

  // C方案：上传扫描件/图片 PDF 未取到文字层时的友好自救引导（不启用 OCR 引擎，纯静态零依赖）
  // 提示条插到附件网格下方（父容器兄弟节点），不会被 grid 重渲染冲掉，也不覆盖正在填的表单
  function showOcrHint(name, gridId) {
    var grid = document.getElementById(gridId);
    if (!grid || !grid.parentNode) return;
    var prev = grid.parentNode.querySelector('.ocr-hint');
    if (prev) prev.parentNode.removeChild(prev);
    var safeName = FW.esc(name || '该文件');
    var hint = document.createElement('div');
    hint.className = 'ocr-hint';
    hint.innerHTML =
      '<div class="ocr-hint-ic">⚠️</div>' +
      '<div class="ocr-hint-body">' +
        '<div class="ocr-hint-title">未识别到文字层：' + safeName + '</div>' +
        '<div class="ocr-hint-text">通常是 <b>图片版 / 扫描件 PDF</b> 或图片文件，系统无法直接读取合同内容。' +
        '可先用 <b>Edge / Chrome / Adobe / WPS</b> 打开 → 点「<b>识别文字 / 扫描和 OCR</b>」→ 另存为带文字层的 PDF → 重新上传即可自动提取；也可直接手动填写表单。</div>' +
      '</div>' +
      '<button class="ocr-hint-close" title="关闭">×</button>';
    hint.querySelector('.ocr-hint-close').onclick = function () { if (hint.parentNode) hint.parentNode.removeChild(hint); };
    grid.parentNode.insertBefore(hint, grid.nextSibling);
  }

  // 列表/详情查看某合同全部附件
  function openContractAttachments(id) {
    var rec = FW.db.getById(CONTRACT_KEY, id);
    if (!rec) return;
    var docs = rec.docFiles || [], atts = rec.attachments || [], photos = rec.photos || [];
    var all = docs.map(function (f) { return { f: f, tag: '正文文档' }; })
      .concat(atts.map(function (f) { return { f: f, tag: '相关附件' }; }))
      .concat(photos.map(function (fid) { return { f: { id: fid, name: '合同照片', type: 'image', size: 0 }, tag: '照片' }; }));
    if (!all.length) { FW.toast('该合同暂无附件'); return; }
    var rows = all.map(function (item) {
      var ext = fileExt(item.f.name);
      return '<div class="ct-file"><span class="ct-file-ic">' + fileIcon(item.f.type, ext) + '</span>' +
        '<span class="ct-file-tag">' + item.tag + '</span>' +
        '<span class="ct-file-name" title="' + FW.esc(item.f.name) + '">' + FW.esc(item.f.name) + '</span>' +
        '<span class="ct-file-act"><a href="#" data-act="open" data-id="' + item.f.id + '" data-name="' + FW.esc(item.f.name) + '">预览</a>' +
        '<a href="#" data-act="dl" data-id="' + item.f.id + '" data-name="' + FW.esc(item.f.name) + '">下载</a></span></div>';
    }).join('');
    var body = '<div id="ct-attach-list" class="ct-attach-list">' + rows + '</div>';
    FW.openModal('合同附件（' + all.length + '）', body, function () {
      FW.qa('#ct-attach-list .ct-file [data-act]').forEach(function (a) {
        a.onclick = function (e) {
          e.preventDefault();
          if (a.dataset.act === 'dl') downloadFile(a.dataset.id, a.dataset.name);
          else openFile(a.dataset.id, a.dataset.name);
        };
      });
    });
  }

  function openContractForm(id) {
    var edit = id ? FW.db.getById(CONTRACT_KEY, id) : null;
    var v = {
      no: '', name: '', party: '', type: '采购合同',
      signDate: FW.today(), dueDate: '', amount: '',
      payMethod: '一次性付款', status: '履行中',
      owner: '', remark: '', photos: [], docFiles: [], attachments: []
    };
    if (edit) {
      v = {
        no: edit.no || '', name: edit.name || '', party: edit.party || '', type: edit.type || '采购合同',
        signDate: edit.signDate || FW.today(), dueDate: edit.dueDate || '', amount: edit.amount,
        payMethod: edit.payMethod || '一次性付款', status: edit.status || '履行中',
        owner: edit.owner || '', remark: edit.remark || '', photos: edit.photos || [],
        docFiles: edit.docFiles || [], attachments: edit.attachments || []
      };
    }
    state.ctPhotos = v.photos.slice();
    state.ctDocFiles = (v.docFiles || []).slice();
    state.ctAttachments = (v.attachments || []).slice();

    var body =
      '<div class="form-grid">' +
        '<div class="field"><label>合同编号</label><input id="c_no" value="' + FW.esc(v.no) + '" placeholder="合同编号（必填）"></div>' +
        '<div class="field"><label>合同名称</label><input id="c_name" value="' + FW.esc(v.name) + '" placeholder="如：XX采购合同"></div>' +
        '<div class="field full"><label>对方单位名称</label><input id="c_party" value="' + FW.esc(v.party) + '" placeholder="甲方 / 乙方单位"></div>' +
        '<div class="field"><label>合同类型</label><select id="c_type">' + CTYPE_OPTS.map(function (k) { return '<option ' + (k === v.type ? 'selected' : '') + '>' + k + '</option>'; }).join('') + '</select></div>' +
        '<div class="field"><label>签订日期</label><input id="c_sign" type="date" value="' + FW.esc(v.signDate) + '"></div>' +
        '<div class="field"><label>到期日</label><input id="c_due" type="date" value="' + FW.esc(v.dueDate) + '"></div>' +
        '<div class="field"><label>合同金额（元）</label><input id="c_amt" type="number" step="0.01" min="0" value="' + FW.esc(v.amount) + '"></div>' +
        '<div class="field"><label>付款方式</label><select id="c_pay">' + PAY_OPTS.map(function (k) { return '<option ' + (k === v.payMethod ? 'selected' : '') + '>' + k + '</option>'; }).join('') + '</select></div>' +
        '<div class="field"><label>履行状态</label><select id="c_status">' + STATUS_OPTS.map(function (k) { return '<option ' + (k === v.status ? 'selected' : '') + '>' + k + '</option>'; }).join('') + '</select></div>' +
        '<div class="field"><label>负责人</label><input id="c_owner" value="' + FW.esc(v.owner) + '" placeholder="选填"></div>' +
        '<div class="field full"><label>备注</label><textarea id="c_remark" rows="2" placeholder="主要条款 / 关联单据">' + FW.esc(v.remark) + '</textarea></div>' +
        '<div class="field full"><label>合同 / 附件照片</label><div class="photo-grid" id="ctPhotoGrid"></div></div>' +
        '<div class="field full"><label>合同正文文档（自动识别提取关键信息）</label><div class="ct-file-grid" id="ctDocGrid"></div><div class="muted" style="font-size:12px;margin-top:4px">支持 PDF / Word / Excel / 文本，上传后立即提取合同编号、对方单位、金额、签订/到期日期等并填入下方表单，请核对。</div></div>' +
        '<div class="field full"><label>相关附件（发票 / 图纸 / 其他）</label><div class="ct-file-grid" id="ctAttGrid"></div></div>' +
      '</div>' +
      '<div class="form-actions"><button class="btn ghost" id="ctCancel">取消</button><button class="btn" id="ctSave">保存</button></div>';

    FW.openModal(edit ? '编辑合同' : '新增合同', body, function () {
      renderContractPhotoGrid(state.ctPhotos);
      renderContractFileGrid('ctDocGrid', state.ctDocFiles, true);
      renderContractFileGrid('ctAttGrid', state.ctAttachments, false);
      document.getElementById('ctCancel').onclick = FW.closeModal;
      document.getElementById('ctSave').onclick = function () {
        var no = document.getElementById('c_no').value.trim();
        if (!no) { FW.toast('请填写合同编号'); return; }
        var amount = num(document.getElementById('c_amt').value);
        if (!(amount >= 0)) { FW.toast('合同金额不能为负'); return; }
        var rec = {
          id: edit ? edit.id : FW.db.uid('ct_'),
          no: no,
          name: document.getElementById('c_name').value.trim(),
          party: document.getElementById('c_party').value.trim(),
          type: document.getElementById('c_type').value,
          signDate: document.getElementById('c_sign').value || FW.today(),
          dueDate: document.getElementById('c_due').value || '',
          amount: amount,
          payMethod: document.getElementById('c_pay').value,
          status: document.getElementById('c_status').value,
          owner: document.getElementById('c_owner').value.trim(),
          remark: document.getElementById('c_remark').value.trim(),
          photos: state.ctPhotos,
          docFiles: state.ctDocFiles,
          attachments: state.ctAttachments
        };
        FW.db.upsert(CONTRACT_KEY, rec);
        FW.closeModal(); renderContractView(); FW.toast('已保存');
      };
    });
  }

  function delContract(id) {
    var rec = FW.db.getById(CONTRACT_KEY, id);
    if (!rec) return;
    var cnt = (rec.photos ? rec.photos.length : 0) + (rec.docFiles ? rec.docFiles.length : 0) + (rec.attachments ? rec.attachments.length : 0);
    if (!confirm('确定删除该合同？' + (cnt ? '（将同时删除 ' + cnt + ' 个附件）' : ''))) return;
    FW.db.remove(CONTRACT_KEY, id);
    var ids = (rec.photos || []).concat((rec.docFiles || []).map(function (f) { return f.id; })).concat((rec.attachments || []).map(function (f) { return f.id; }));
    if (ids.length) FW.db.deletePhotos(ids);
    renderContractView(); FW.toast('已删除');
  }

  function renderContractPhotoGrid(photos) {
    var grid = document.getElementById('ctPhotoGrid');
    if (!grid) return;
    grid.innerHTML = '';
    (photos || []).forEach(function (pid) {
      var wrap = document.createElement('div'); wrap.style.position = 'relative';
      var img = document.createElement('img'); img.className = 'photo-thumb';
      FW.db.getPhoto(pid).then(function (d) { if (d) img.src = d; }).catch(function () {});
      var del = document.createElement('span');
      del.textContent = '✕'; del.style.cssText = 'position:absolute;top:-6px;right:-6px;background:#d33;color:#fff;border-radius:50%;width:16px;height:16px;font-size:11px;line-height:16px;text-align:center;cursor:pointer';
      del.onclick = function () { photos.splice(photos.indexOf(pid), 1); FW.db.deletePhoto(pid); renderContractPhotoGrid(photos); };
      img.style.cursor = 'pointer';
      wrap.appendChild(img); wrap.appendChild(del); grid.appendChild(wrap);
    });
    var add = document.createElement('div'); add.className = 'photo-add'; add.textContent = '＋'; add.title = '上传合同照片/附件';
    add.onclick = function () {
      var inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = true;
      inp.onchange = function () {
        var files = Array.prototype.slice.call(inp.files);
        var pending = files.map(function (f) { return new Promise(function (res) { var r = new FileReader(); r.onload = function () { FW.db.savePhoto(r.result).then(res); }; r.readAsDataURL(f); }); });
        Promise.all(pending).then(function (ids) { ids.forEach(function (i) { photos.push(i); }); renderContractPhotoGrid(photos); });
      };
      inp.click();
    };
    grid.appendChild(add);
  }

  function setContractRange(kind) {
    var now = new Date(), y = now.getFullYear(), m = now.getMonth(), p = function (n) { return n < 10 ? '0' + n : '' + n; };
    if (kind === 'cmonth') { state.ctFrom = y + '-' + p(m + 1) + '-01'; state.ctTo = y + '-' + p(m + 1) + '-' + new Date(y, m + 1, 0).getDate(); }
    else if (kind === 'cyear') { state.ctFrom = y + '-01-01'; state.ctTo = y + '-12-31'; }
    else { state.ctFrom = ''; state.ctTo = ''; }
    renderContractView();
  }

  function exportContractCsv() {
    var rows = contractsFiltered(state.ctKw, state.ctFrom, state.ctTo, state.ctStatus);
    if (!rows.length) { FW.toast('没有可导出的合同'); return; }
    var head = ['合同编号', '合同名称', '对方单位', '合同类型', '签订日期', '到期日', '合同金额', '付款方式', '履行状态', '负责人', '备注', '附件数'];
    var data = rows.map(function (t) {
      var attCnt = (t.docFiles ? t.docFiles.length : 0) + (t.attachments ? t.attachments.length : 0) + (t.photos ? t.photos.length : 0);
      return [t.no, t.name || '', t.party || '', t.type || '', t.signDate || '', t.dueDate || '', t.amount, t.payMethod || '', t.status || '待签订', t.owner || '', t.remark || '', attCnt];
    });
    var csv = '﻿' + [head].concat(data).map(function (r) {
      return r.map(function (c) { return '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"'; }).join(',');
    }).join('\r\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '合同台账_' + FW.today() + '.csv';
    a.click();
    FW.toast('已导出 ' + rows.length + ' 份合同（CSV）');
  }

  FW.contractCalc = { contractSummary: contractSummary, extractContractFields: extractContractFields };

  /* ============================================================
   * 库存台账（采购 / 入库 / 出库 / 退货）
   *   - 记录商品/物料的出入库与退货流水：日期/单号/名称/规格/单位/类型/数量/单价/金额/往来单位/仓库
   *   - 类型含方向：入库方向(in) 采购入库·其他入库·销售退货；出库方向(out) 销售出库·其他出库·采购退货
   *   - 自动汇总：入库合计(数量/金额)、出库合计、退货合计(采购+销售退货)、库存结存(数量=入-出)
   *   - 支持期间筛选、类型筛选、关键词搜索、CSV 导出、单据照片
   * 数据键：stock（按账本隔离，见 db.js）
   * ============================================================ */
  function stockAll() { return FW.db.getList(STOCK_KEY).sort(function (a, b) { return (a.date < b.date ? 1 : a.date > b.date ? -1 : 0); }); }
  function stockFiltered(kw, from, to, type) {
    var rows = stockAll();
    if (type) rows = rows.filter(function (t) { return t.type === type; });
    if (from) rows = rows.filter(function (t) { return t.date >= from; });
    if (to) rows = rows.filter(function (t) { return t.date <= to; });
    if (kw) {
      var k = kw.toLowerCase();
      rows = rows.filter(function (t) {
        return [t.no, t.item, t.spec, t.unit, t.type, t.party, t.warehouse, t.remark].some(function (f) { return (f || '').toLowerCase().indexOf(k) >= 0; });
      });
    }
    return rows;
  }
  function stockSummary(rows) {
    var inQ = 0, inA = 0, outQ = 0, outA = 0, retQ = 0, retA = 0;
    rows.forEach(function (t) {
      var q = num(t.qty), a = num(t.amount);
      if (t.type === '采购退货' || t.type === '销售退货') { retQ += q; retA += a; }
      if (stockDir(t.type) === 'in') { inQ += q; inA += a; } else { outQ += q; outA += a; }
    });
    return { inQ: inQ, inA: inA, outQ: outQ, outA: outA, retQ: retQ, retA: retA, balance: inQ - outQ };
  }

  function renderStockView() {
    var c = document.getElementById('content');
    var kw = state.stKw || '', from = state.stFrom || '', to = state.stTo || '', type = state.stType || '';
    var rows = stockFiltered(kw, from, to, type);
    var s = stockSummary(stockAll());
    var typeOpts = '<option value="">全部类型</option>' + STOCK_TYPES.map(function (t) { return '<option' + (type === t.label ? ' selected' : '') + '>' + t.label + '</option>'; }).join('');

    c.innerHTML =
      '<div class="card" style="margin-bottom:14px"><div class="toolbar">' +
        '<span style="font-size:13px;color:var(--muted);align-self:center">业务期间：</span>' +
        '<button class="btn ghost sm" data-r="smonth">本月</button>' +
        '<button class="btn ghost sm" data-r="syear">本年</button>' +
        '<button class="btn ghost sm" data-r="sall">全部</button>' +
        '<div class="field"><input id="stFrom" type="date" value="' + FW.esc(from) + '" title="开始日期"></div>' +
        '<div class="field"><input id="stTo" type="date" value="' + FW.esc(to) + '" title="结束日期"></div>' +
      '</div></div>' +
      '<div class="stat-row" id="stSummary"></div>' +
      '<div class="card">' +
        '<div class="toolbar">' +
          '<div class="field"><input id="stKw" placeholder="搜索名称/单号/往来单位" value="' + FW.esc(kw) + '"></div>' +
          '<div class="field"><select id="stType">' + typeOpts + '</select></div>' +
          '<button class="btn ghost sm" id="stReset">重置</button>' +
        '</div>' +
        '<div id="stWrap"></div>' +
      '</div>';

    var ta = document.getElementById('topActions');
    ta.innerHTML = '<button class="btn ghost" id="stPrint">🖨 打印</button><button class="btn ghost" id="stCsv">⬇ 导出CSV</button><button class="btn" id="addStBtn">＋ 新增单据</button>';
    document.getElementById('stPrint').onclick = function () { window.print(); };
    document.getElementById('stCsv').onclick = exportStockCsv;
    document.getElementById('addStBtn').onclick = function () { openStockForm(null); };

    drawStockSummary(s);
    drawStockTable(rows);

    FW.qa('#content [data-r]').forEach(function (b) { b.onclick = function () { setStockRange(b.dataset.r); }; });
    var sf = document.getElementById('stFrom'), st = document.getElementById('stTo');
    if (sf) sf.onchange = function () { state.stFrom = this.value; renderStockView(); };
    if (st) st.onchange = function () { state.stTo = this.value; renderStockView(); };
    var sk = document.getElementById('stKw'); if (sk) sk.oninput = function () { state.stKw = this.value.trim(); drawStockTable(stockFiltered(state.stKw, state.stFrom, state.stTo, state.stType)); };
    var sp = document.getElementById('stType'); if (sp) sp.onchange = function () { state.stType = this.value; drawStockTable(stockFiltered(state.stKw, state.stFrom, state.stTo, state.stType)); };
    var sr = document.getElementById('stReset'); if (sr) sr.onclick = function () { state.stKw = ''; state.stType = ''; state.stFrom = ''; state.stTo = ''; renderStockView(); };
  }

  function drawStockSummary(s) {
    var el = document.getElementById('stSummary');
    if (!el) return;
    el.innerHTML =
      '<div class="stat"><div class="label">入库合计</div><div class="value income">' + s.inQ + ' 件</div><div class="sub">金额 ' + money(s.inA) + '</div></div>' +
      '<div class="stat"><div class="label">出库合计</div><div class="value expense">' + s.outQ + ' 件</div><div class="sub">金额 ' + money(s.outA) + '</div></div>' +
      '<div class="stat"><div class="label">退货合计</div><div class="value">' + s.retQ + ' 件</div><div class="sub">金额 ' + money(s.retA) + '</div></div>' +
      '<div class="stat"><div class="label">库存结存（数量）</div><div class="value">' + s.balance + ' 件</div><div class="sub">入 − 出</div></div>';
  }

  function drawStockTable(rows) {
    var el = document.getElementById('stWrap');
    if (!el) return;
    if (!rows.length) {
      el.innerHTML = '<div class="empty">没有符合条件的单据。点右上角「＋ 新增单据」登记第一笔，或调整筛选条件。</div>';
      return;
    }
    var trs = rows.map(function (t) {
      var dir = stockDir(t.type);
      var dirTag = dir === 'in' ? '<span class="tag ok">入</span>' : '<span class="tag warn">出</span>';
      var qtyCls = dir === 'in' ? 'income' : 'expense';
      return '<tr>' +
        '<td class="nowrap">' + FW.esc(t.date || '') + '</td>' +
        '<td>' + FW.esc(t.no || '') + '</td>' +
        '<td>' + FW.esc(t.item || '—') + (t.spec ? '<div class="muted" style="font-size:11px">' + FW.esc(t.spec) + '</div>' : '') + '</td>' +
        '<td>' + (t.unit ? FW.esc(t.unit) : '<span class="muted">—</span>') + '</td>' +
        '<td><span class="tag">' + FW.esc(t.type || '—') + '</span> ' + dirTag + '</td>' +
        '<td class="num ' + qtyCls + '">' + (dir === 'in' ? '' : '−') + num(t.qty) + '</td>' +
        '<td class="num">' + money(t.price) + '</td>' +
        '<td class="num">' + money(t.amount) + '</td>' +
        '<td>' + (t.party ? FW.esc(t.party) : '<span class="muted">—</span>') + '</td>' +
        '<td>' + (t.warehouse ? FW.esc(t.warehouse) : '<span class="muted">—</span>') + '</td>' +
        '<td>' + FW.esc(t.remark || '') + '</td>' +
        '<td class="row-actions nowrap"><button class="btn ghost sm row-edit" data-id="' + t.id + '">编辑</button><button class="btn danger sm row-del" data-id="' + t.id + '">删</button></td>' +
        '</tr>';
    }).join('');
    el.innerHTML = '<table><thead><tr>' +
      '<th>日期</th><th>单号</th><th>商品/物料</th><th>单位</th><th>类型</th><th class="num">数量</th><th class="num">单价</th><th class="num">金额</th><th>往来单位</th><th>仓库</th><th>备注</th><th>操作</th>' +
      '</tr></thead><tbody>' + trs + '</tbody></table>';
    FW.qa('#stWrap .row-edit').forEach(function (b) { b.onclick = function () { openStockForm(b.dataset.id); }; });
    FW.qa('#stWrap .row-del').forEach(function (b) { b.onclick = function () { delStock(b.dataset.id); }; });
  }

  function openStockForm(id) {
    var edit = id ? FW.db.getById(STOCK_KEY, id) : null;
    var v = {
      date: FW.today(), no: '', item: '', spec: '', unit: '个',
      type: '采购入库', qty: '', price: '', amount: '',
      party: '', warehouse: '', remark: '', photos: []
    };
    if (edit) {
      v = {
        date: edit.date || FW.today(), no: edit.no || '', item: edit.item || '', spec: edit.spec || '', unit: edit.unit || '个',
        type: edit.type || '采购入库', qty: edit.qty, price: edit.price, amount: edit.amount,
        party: edit.party || '', warehouse: edit.warehouse || '', remark: edit.remark || '', photos: edit.photos || []
      };
    }
    state.stPhotos = v.photos.slice();

    var body =
      '<div class="form-grid">' +
        '<div class="field"><label>日期</label><input id="s_date" type="date" value="' + FW.esc(v.date) + '"></div>' +
        '<div class="field"><label>单号</label><input id="s_no" value="' + FW.esc(v.no) + '" placeholder="出入库单号（选填）"></div>' +
        '<div class="field full"><label>商品/物料名称</label><input id="s_item" value="' + FW.esc(v.item) + '" placeholder="名称（必填）"></div>' +
        '<div class="field"><label>规格</label><input id="s_spec" value="' + FW.esc(v.spec) + '" placeholder="选填"></div>' +
        '<div class="field"><label>单位</label><input id="s_unit" value="' + FW.esc(v.unit) + '" placeholder="个/件/箱"></div>' +
        '<div class="field"><label>业务类型</label><select id="s_type">' + STOCK_TYPES.map(function (t) { return '<option ' + (t.label === v.type ? 'selected' : '') + '>' + t.label + '</option>'; }).join('') + '</select></div>' +
        '<div class="field"><label>数量</label><input id="s_qty" type="number" step="0.01" min="0" value="' + FW.esc(v.qty) + '"></div>' +
        '<div class="field"><label>单价（元）</label><input id="s_price" type="number" step="0.01" min="0" value="' + FW.esc(v.price) + '"></div>' +
        '<div class="field"><label>金额（元）</label><input id="s_amount" type="number" step="0.01" min="0" value="' + FW.esc(v.amount) + '" placeholder="留空自动算"></div>' +
        '<div class="field"><label>往来单位</label><input id="s_party" value="' + FW.esc(v.party) + '" placeholder="供应商/客户"></div>' +
        '<div class="field"><label>仓库</label><input id="s_wh" value="' + FW.esc(v.warehouse) + '" placeholder="选填"></div>' +
        '<div class="field full"><label>备注</label><textarea id="s_remark" rows="2" placeholder="用途 / 关联单据">' + FW.esc(v.remark) + '</textarea></div>' +
        '<div class="field full"><label>单据照片</label><div class="photo-grid" id="stPhotoGrid"></div></div>' +
      '</div>' +
      '<div class="form-actions"><button class="btn ghost" id="stCancel">取消</button><button class="btn" id="stSave">保存</button></div>';

    FW.openModal(edit ? '编辑单据' : '新增单据', body, function () {
      renderStockPhotoGrid(state.stPhotos);
      // 自动计算金额
      function autoAmount() {
        var q = num(document.getElementById('s_qty').value);
        var p = num(document.getElementById('s_price').value);
        var am = document.getElementById('s_amount');
        if (q > 0 && p > 0 && !am.value) am.value = (q * p).toFixed(2);
      }
      document.getElementById('s_qty').oninput = autoAmount;
      document.getElementById('s_price').oninput = autoAmount;
      document.getElementById('stCancel').onclick = FW.closeModal;
      document.getElementById('stSave').onclick = function () {
        var item = document.getElementById('s_item').value.trim();
        if (!item) { FW.toast('请填写商品/物料名称'); return; }
        var qty = num(document.getElementById('s_qty').value);
        if (!(qty > 0)) { FW.toast('数量必须大于 0'); return; }
        var price = num(document.getElementById('s_price').value);
        var amountRaw = document.getElementById('s_amount').value;
        var amount = amountRaw ? num(amountRaw) : (qty * price);
        var rec = {
          id: edit ? edit.id : FW.db.uid('st_'),
          date: document.getElementById('s_date').value || FW.today(),
          no: document.getElementById('s_no').value.trim(),
          item: item,
          spec: document.getElementById('s_spec').value.trim(),
          unit: document.getElementById('s_unit').value.trim() || '个',
          type: document.getElementById('s_type').value,
          qty: qty, price: price, amount: amount,
          party: document.getElementById('s_party').value.trim(),
          warehouse: document.getElementById('s_wh').value.trim(),
          remark: document.getElementById('s_remark').value.trim(),
          photos: state.stPhotos
        };
        FW.db.upsert(STOCK_KEY, rec);
        FW.closeModal(); renderStockView(); FW.toast('已保存');
      };
    });
  }

  function delStock(id) {
    var rec = FW.db.getById(STOCK_KEY, id);
    if (!rec) return;
    if (!confirm('确定删除该单据？' + (rec.photos && rec.photos.length ? '（将同时删除 ' + rec.photos.length + ' 张单据照片）' : ''))) return;
    FW.db.remove(STOCK_KEY, id);
    if (rec.photos && rec.photos.length) FW.db.deletePhotos(rec.photos);
    renderStockView(); FW.toast('已删除');
  }

  function renderStockPhotoGrid(photos) {
    var grid = document.getElementById('stPhotoGrid');
    if (!grid) return;
    grid.innerHTML = '';
    (photos || []).forEach(function (pid) {
      var wrap = document.createElement('div'); wrap.style.position = 'relative';
      var img = document.createElement('img'); img.className = 'photo-thumb';
      FW.db.getPhoto(pid).then(function (d) { if (d) img.src = d; }).catch(function () {});
      var del = document.createElement('span');
      del.textContent = '✕'; del.style.cssText = 'position:absolute;top:-6px;right:-6px;background:#d33;color:#fff;border-radius:50%;width:16px;height:16px;font-size:11px;line-height:16px;text-align:center;cursor:pointer';
      del.onclick = function () { photos.splice(photos.indexOf(pid), 1); FW.db.deletePhoto(pid); renderStockPhotoGrid(photos); };
      img.style.cursor = 'pointer';
      wrap.appendChild(img); wrap.appendChild(del); grid.appendChild(wrap);
    });
    var add = document.createElement('div'); add.className = 'photo-add'; add.textContent = '＋'; add.title = '上传单据照片';
    add.onclick = function () {
      var inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = true;
      inp.onchange = function () {
        var files = Array.prototype.slice.call(inp.files);
        var pending = files.map(function (f) { return new Promise(function (res) { var r = new FileReader(); r.onload = function () { FW.db.savePhoto(r.result).then(res); }; r.readAsDataURL(f); }); });
        Promise.all(pending).then(function (ids) { ids.forEach(function (i) { photos.push(i); }); renderStockPhotoGrid(photos); });
      };
      inp.click();
    };
    grid.appendChild(add);
  }

  function setStockRange(kind) {
    var now = new Date(), y = now.getFullYear(), m = now.getMonth(), p = function (n) { return n < 10 ? '0' + n : '' + n; };
    if (kind === 'smonth') { state.stFrom = y + '-' + p(m + 1) + '-01'; state.stTo = y + '-' + p(m + 1) + '-' + new Date(y, m + 1, 0).getDate(); }
    else if (kind === 'syear') { state.stFrom = y + '-01-01'; state.stTo = y + '-12-31'; }
    else { state.stFrom = ''; state.stTo = ''; }
    renderStockView();
  }

  function exportStockCsv() {
    var rows = stockFiltered(state.stKw, state.stFrom, state.stTo, state.stType);
    if (!rows.length) { FW.toast('没有可导出的单据'); return; }
    var head = ['日期', '单号', '商品/物料', '规格', '单位', '业务类型', '方向', '数量', '单价', '金额', '往来单位', '仓库', '备注'];
    var data = rows.map(function (t) {
      return [t.date, t.no || '', t.item || '', t.spec || '', t.unit || '', t.type || '', (stockDir(t.type) === 'in' ? '入' : '出'), t.qty, t.price, t.amount, t.party || '', t.warehouse || '', t.remark || ''];
    });
    var csv = '﻿' + [head].concat(data).map(function (r) {
      return r.map(function (c) { return '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"'; }).join(',');
    }).join('\r\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '库存台账_' + FW.today() + '.csv';
    a.click();
    FW.toast('已导出 ' + rows.length + ' 条单据（CSV）');
  }

  FW.stockCalc = { stockSummary: stockSummary };

  FW.modules = FW.modules || {};
  FW.modules.invoices = {
    title: '发票台账',
    render: render,
    tabs: [
      { key: 'all', label: '全部' },
      { key: 'in', label: '进项发票' },
      { key: 'out', label: '销项发票' },
      { key: 'contract', label: '合同台账' },
      { key: 'stock', label: '库存台账' }
    ],
    getTab: function () { return state.tab; },
    setTab: function (k) { state.tab = k; state.deduction = ''; render(); if (window.FW.nav) FW.nav.refreshSubNav(); }
  };
})(window);
