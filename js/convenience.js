/* 便利增强模块（caiwu-workbench）
 * 功能：① 常用流水模板（一键填单） ② 凭证图批量上传+自动匹配
 *       ③ 月结锁定+月度快照 ④ 行内计算(=公式)+同商户智能默认
 * 设计为独立模块，重逻辑放此处，internal.js 仅做最小接线。
 */
(function (global) {
  'use strict';
  var FW = global.FW;
  var KEY = 'internal';              // 与 internal.js 的 KEY 一致
  var TPL_KEY = 'internal_tpl';      // 流水模板
  var CLOSED_KEY = 'internal_closed';// 已结账月份 ['YYYY-MM']
  var SNAP_KEY = 'internal_snap';    // 月度快照
  var VPOOL_KEY = 'internal_vpool';  // 未关联凭证池

  function cat2Opts(c1, sel) { return (FW.modules.internal && FW.modules.internal.cat2Opts) ? FW.modules.internal.cat2Opts(c1, sel) : ''; }
  function typeLabel(t) { return (FW.modules.internal && FW.modules.internal.typeLabel) ? FW.modules.internal.typeLabel(t) : (t.type || ''); }

  /* ===== ③ 月结锁定 ===== */
  function isClosedMonth(date) {
    if (!date) return false;
    var m = String(date).slice(0, 7);
    return (FW.db.getList(CLOSED_KEY) || []).indexOf(m) >= 0;
  }
  function monthOptions() {
    var ms = {};
    (FW.db.getList(KEY) || []).forEach(function (t) { if (t.date) ms[String(t.date).slice(0, 7)] = 1; });
    return Object.keys(ms).sort().reverse();
  }
  function computeMonth(month) {
    var list = (FW.db.getList(KEY) || []).filter(function (t) { return String(t.date || '').slice(0, 7) === month; });
    var inc = 0, exp = 0, eqIn = 0, eqOut = 0, div = 0;
    list.forEach(function (t) {
      var a = Number(t.amount) || 0;
      if (t.type === 'income' || t.type === 'refund') inc += a;
      else if (t.type === 'expense') exp += a;
      else if (t.type === 'equity') { if (t.equityDir === 'out') eqOut += a; else eqIn += a; }
      else if (t.type === 'dividend') div += a;
    });
    return { month: month, income: inc, expense: exp, net: inc - exp, equityIn: eqIn, equityOut: eqOut, dividend: div, count: list.length };
  }
  function openMonthClose() {
    var closed = FW.db.getList(CLOSED_KEY) || [];
    var opts = monthOptions().map(function (m) { return '<option value="' + m + '">' + m + '</option>'; }).join('') || '<option value="">（暂无流水）</option>';
    var closedHtml = closed.length ? closed.map(function (m) {
      return '<span style="display:inline-block;background:#f1f5fa;border:1px solid #dbe4ee;border-radius:14px;padding:3px 10px;margin:3px;font-size:13px">📅 ' + m + ' <a href="#" data-undo="' + m + '" style="color:#c0392b;margin-left:6px">撤销</a></span>';
    }).join('') : '<span class="muted">暂无已结账月份</span>';
    var body =
      '<div class="tx-form">' +
      '<div class="tx-section"><div class="tx-title">选择月份结账</div>' +
      '<div class="form-grid"><div class="field full"><select id="mcMonth">' + opts + '</select></div></div>' +
      '<div class="muted" style="font-size:12px;margin:6px 0">结账后该月所有流水将被锁定，无法编辑/删除（防止跨月误改）。生成快照可在下方撤销。</div>' +
      '<button class="btn" id="mcDo">📅 结账并生成快照</button></div>' +
      '<div class="tx-section"><div class="tx-title">已结账月份</div><div id="mcClosed">' + closedHtml + '</div></div>' +
      '</div>';
    FW.openModal('月结 / 月度快照', body, function () {
      var doBtn = document.getElementById('mcDo');
      if (doBtn) doBtn.onclick = function () {
        var m = document.getElementById('mcMonth').value; if (!m) { FW.toast('无可选月份'); return; }
        var snap = computeMonth(m); snap.ts = Date.now();
        var cs = FW.db.getList(CLOSED_KEY) || []; if (cs.indexOf(m) < 0) cs.push(m); FW.db.saveList(CLOSED_KEY, cs);
        var snaps = FW.db.getList(SNAP_KEY) || [];
        var i = snaps.findIndex(function (s) { return s.month === m; });
        if (i >= 0) snaps[i] = snap; else snaps.push(snap);
        FW.db.saveList(SNAP_KEY, snaps);
        FW.toast('已结账 ' + m + '：收入 ' + FW.fmtMoney(snap.income) + ' / 支出 ' + FW.fmtMoney(snap.expense) + ' / 净额 ' + FW.fmtMoney(snap.net));
        FW.closeModal(); if (FW.modules.internal) FW.modules.internal.render ? FW.modules.internal.render() : (global.render && render());
      };
      Array.prototype.forEach.call(document.querySelectorAll('#mcClosed a[data-undo]'), function (a) {
        a.onclick = function (e) {
          e.preventDefault();
          var m = a.getAttribute('data-undo');
          FW.db.saveList(CLOSED_KEY, (FW.db.getList(CLOSED_KEY) || []).filter(function (x) { return x !== m; }));
          FW.toast('已撤销 ' + m + ' 结账'); FW.closeModal(); openMonthClose();
        };
      });
    });
  }

  /* ===== ① 常用流水模板 ===== */
  function initTplBar() {
    var sel = document.getElementById('f_tpl');
    if (!sel) return;
    var tpls = FW.db.getList(TPL_KEY) || [];
    sel.innerHTML = '<option value="">— 套用模板 —</option>' + tpls.map(function (t) {
      return '<option value="' + FW.esc(t.id) + '">' + FW.esc(t.name) + '（' + FW.esc(t.type) + '）</option>';
    }).join('');
    sel.onchange = function () { var id = this.value; if (id) { applyTpl(id); } this.value = ''; };
    var saveBtn = document.getElementById('f_saveTpl');
    if (saveBtn) saveBtn.onclick = function () { saveTplFromForm(); };
  }
  function applyTpl(id) {
    var tpl = (FW.db.getList(TPL_KEY) || []).filter(function (t) { return t.id === id; })[0];
    if (!tpl) return;
    var typeSel = document.getElementById('f_type');
    if (typeSel) { typeSel.value = tpl.type; if (typeSel.onchange) typeSel.onchange(); }
    var setVal = function (fid, val) { var el = document.getElementById(fid); if (el && val != null && val !== '') el.value = val; };
    setVal('f_cat1', tpl.cat1);
    if (tpl.cat1) { var c2 = document.getElementById('f_cat2'); if (c2) { c2.innerHTML = cat2Opts(tpl.cat1, ''); if (tpl.cat2) c2.value = tpl.cat2; } }
    setVal('f_account', tpl.account);
    setVal('f_project', tpl.project);
    setVal('f_party', tpl.party);
    setVal('f_reimburser', tpl.reimburser);
    setVal('f_remark', tpl.remark);
    var hint = document.getElementById('tplHint'); if (hint) hint.textContent = '已套用模板：' + (tpl.name || '');
  }
  function saveTplFromForm() {
    var name = global.prompt ? global.prompt('给这个模板起个名字（如：每月房租）：', '') : '';
    if (name == null) return;
    name = String(name).trim(); if (!name) { FW.toast('名称不能为空'); return; }
    var get = function (fid) { var el = document.getElementById(fid); return el ? el.value.trim() : ''; };
    var tpl = {
      id: FW.db.uid('tpl_'), name: name, type: get('f_type'),
      cat1: get('f_cat1'), cat2: get('f_cat2'), account: get('f_account'),
      project: get('f_project'), party: get('f_party'), reimburser: get('f_reimburser'), remark: get('f_remark')
    };
    var tpls = FW.db.getList(TPL_KEY) || [];
    tpls.push(tpl); FW.db.saveList(TPL_KEY, tpls);
    FW.toast('已保存模板：' + name);
    initTplBar();
  }

  /* ===== ② 凭证图批量上传 + 自动匹配 ===== */
  function openVoucherPool() {
    var pool = FW.db.getList(VPOOL_KEY) || [];
    function savePool() { FW.db.saveList(VPOOL_KEY, pool); }
    function renderPool() {
      var grid = document.getElementById('vpGrid'); if (!grid) return;
      grid.innerHTML = '';
      pool.forEach(function (item) {
        var wrap = document.createElement('div'); wrap.style.cssText = 'position:relative;display:inline-block';
        var img = document.createElement('img'); img.className = 'photo-thumb'; img.dataset.load = item.id;
        FW.db.getPhoto(item.id).then(function (d) { if (d) img.src = d; }).catch(function () {});
        var chk = document.createElement('input'); chk.type = 'checkbox'; chk.className = 'vp-chk'; chk.dataset.id = item.id;
        chk.style.cssText = 'position:absolute;top:2px;left:2px';
        var amt = document.createElement('input'); amt.type = 'text'; amt.placeholder = '金额'; amt.value = item.amt || '';
        amt.className = 'vp-amt'; amt.dataset.id = item.id;
        amt.style.cssText = 'position:absolute;bottom:2px;left:2px;width:64px;font-size:11px';
        amt.oninput = function () { item.amt = amt.value.trim(); savePool(); };
        var ocrBtn = document.createElement('button'); ocrBtn.type = 'button'; ocrBtn.textContent = '识别'; ocrBtn.className = 'vp-ocr';
        ocrBtn.style.cssText = 'position:absolute;top:2px;right:2px;font-size:10px;padding:1px 4px';
        ocrBtn.onclick = function () { runOcr(item.id, function (a) { item.amt = String(a); amt.value = String(a); savePool(); }); };
        wrap.appendChild(img); wrap.appendChild(chk); wrap.appendChild(amt); wrap.appendChild(ocrBtn); grid.appendChild(wrap);
      });
      var cnt = document.getElementById('vpCount'); if (cnt) cnt.textContent = pool.length;
    }
    var body =
      '<div class="tx-form">' +
      '<div class="tx-section"><div class="tx-title">① 上传凭证图（未关联 <b id="vpCount">0</b> 张）</div>' +
      '<div class="muted" style="font-size:12px;margin-bottom:6px">一次选多张或拖拽到下方；每张可填金额用于自动匹配。上传后到右侧选流水挂接。</div>' +
      '<input type="file" id="vpFile" accept="image/*" multiple>' +
      '<div class="photo-grid" id="vpGrid" style="margin-top:8px"></div></div>' +
      '<div class="tx-section"><div class="tx-title">② 选择流水挂接</div>' +
      '<div class="form-grid"><div class="field full"><input id="vpSearch" placeholder="搜索对方 / 备注 / 日期"></div></div>' +
      '<button class="btn sm" id="vpAuto">⚡ 按金额自动匹配</button>' +
      '<div id="vpTxList" style="max-height:42vh;overflow:auto;margin-top:8px"></div>' +
      '<div class="muted" style="font-size:12px">操作：勾选左侧凭证 → 点击右侧某笔流水即挂接；或点「按金额自动匹配」（金额唯一对应一笔时自动挂）。</div></div>' +
      '</div>';
    FW.openModal('批量挂凭证', body, function () {
      renderPool();
      function addFiles(files) {
        var imgs = Array.prototype.slice.call(files).filter(function (f) { return f.type.indexOf('image') === 0; });
        if (!imgs.length) return;
        var pend = imgs.map(function (f) { return new Promise(function (res) { var r = new FileReader(); r.onload = function () { FW.db.savePhoto(r.result).then(res); }; r.readAsDataURL(f); }); });
        Promise.all(pend).then(function (ids) { ids.forEach(function (id) { pool.push({ id: id, amt: '' }); }); savePool(); renderPool(); FW.toast('已上传 ' + ids.length + ' 张'); });
      }
      var file = document.getElementById('vpFile');
      if (file) file.onchange = function () { addFiles(file.files); };
      var grid = document.getElementById('vpGrid');
      if (grid) {
        grid.ondragover = function (e) { e.preventDefault(); };
        grid.ondrop = function (e) { e.preventDefault(); if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files); };
      }
      function drawTx() {
        var q = (document.getElementById('vpSearch').value || '').trim().toLowerCase();
        var rows = (FW.db.getList(KEY) || []).slice().sort(function (a, b) { return String(b.date || '').localeCompare(String(a.date || '')); });
        if (q) rows = rows.filter(function (t) { return (String(t.party || '') + ' ' + String(t.remark || '') + ' ' + String(t.date || '')).toLowerCase().indexOf(q) >= 0; });
        var list = document.getElementById('vpTxList'); if (!list) return;
        list.innerHTML = rows.slice(0, 200).map(function (t) {
          return '<div class="vp-tx" data-id="' + FW.esc(t.id) + '" style="padding:6px 8px;border-bottom:1px solid #eee;cursor:pointer"><b>' + FW.esc(t.date) + '</b> ' + FW.esc(typeLabel(t)) + ' <span>' + FW.fmtMoney(t.amount) + '</span> · ' + FW.esc(t.party || '') + (t.photos && t.photos.length ? ' 📎' + t.photos.length : '') + '</div>';
        }).join('');
        Array.prototype.forEach.call(list.querySelectorAll('.vp-tx'), function (row) {
          row.onclick = function () {
            var ids = pool.filter(function (p) { var c = document.querySelector('.vp-chk[data-id="' + p.id + '"]'); return c && c.checked; }).map(function (p) { return p.id; });
            if (!ids.length) { FW.toast('请先在左侧勾选要挂的凭证'); return; }
            var rec = FW.db.getById(KEY, row.getAttribute('data-id')); if (!rec) return;
            rec.photos = (rec.photos || []).concat(ids);
            FW.db.upsert(KEY, rec);
            pool = pool.filter(function (p) { return ids.indexOf(p.id) < 0; }); savePool(); renderPool(); drawTx();
            FW.toast('已为「' + (rec.party || rec.date) + '」挂 ' + ids.length + ' 张凭证');
          };
        });
      }
      var search = document.getElementById('vpSearch'); if (search) search.oninput = drawTx;
      drawTx();
      var auto = document.getElementById('vpAuto');
      if (auto) auto.onclick = function () {
        var matched = 0;
        pool.slice().forEach(function (p) {
          var amt = parseFloat(String(p.amt || '').replace(/,/g, '')); if (!(amt > 0)) return;
          var cand = (FW.db.getList(KEY) || []).filter(function (t) { return Math.abs((Number(t.amount) || 0) - amt) < 0.01; });
          if (cand.length === 1) {
            var rec = cand[0]; rec.photos = (rec.photos || []).concat([p.id]);
            FW.db.upsert(KEY, rec); pool = pool.filter(function (x) { return x.id !== p.id; }); matched++;
          }
        });
        savePool(); renderPool(); drawTx();
        FW.toast(matched ? ('已按金额自动匹配 ' + matched + ' 张') : '无唯一匹配（金额对应多笔或无可匹配金额）');
      };
    });
  }

  /* ===== ④ 行内计算 + 同商户智能默认（全局委托，加载即生效）===== */
  function evalExpr(expr) {
    expr = String(expr).replace(/[^0-9+\-*/().%\s]/g, '');
    if (!expr) return null;
    try { var r = Function('"use strict";return (' + expr + ')')(); return (typeof r === 'number' && isFinite(r)) ? r : null; } catch (e) { return null; }
  }
  if (!global.__cwBound) {
    global.__cwBound = true;
    document.addEventListener('change', function (e) {
      var el = e.target; if (!el || !el.id) return;
      if (el.id === 'f_amount') {
        var v = (el.value || '').trim();
        if (v.charAt(0) === '=') {
          var r = evalExpr(v.slice(1));
          if (r == null) FW.toast('公式无法计算：' + v);
          else { el.value = String(+r.toFixed(2)); FW.toast('已计算 ' + v + ' = ' + el.value); if (el.oninput) el.oninput(); }
        }
        return;
      }
      if (el.id === 'f_party') {
        var rawParty = el.value.trim(); if (!rawParty) return;
        var party = normalizeParty(rawParty); if (party !== rawParty) { el.value = party; }
        var last = (FW.db.getList(KEY) || []).filter(function (t) { return (t.party || '') === party; })
          .sort(function (a, b) { return String(b.date || '').localeCompare(String(a.date || '')); })[0];
        if (!last) return;
        var filled = [];
        if (last.category) {
          var parts = last.category.split(' / ');
          var c1 = document.getElementById('f_cat1');
          if (c1 && !c1.value) {
            c1.value = parts[0]; filled.push('分类');
            var c2 = document.getElementById('f_cat2');
            if (c2) { c2.innerHTML = cat2Opts(parts[0], ''); if (parts[1]) c2.value = parts[1]; }
          }
        }
        var acc = document.getElementById('f_account'); if (acc && !acc.value && last.account) { acc.value = last.account; filled.push('账户'); }
        if (filled.length) FW.toast('已按「' + party + '」带出上次' + filled.join('/'));
      }
    });
  }

  /* ===================== v43 新增：录入增强 ===================== */
  var DRAFT_KEY = 'internal_draft';
  var ALIAS_KEY = 'internal_alias';
  var OCR_KEY = 'internal_ocr';

  /* ---- 同名商户别名合并 ---- */
  function aliasMap() { return FW.db.getList(ALIAS_KEY) || []; }
  function normalizeParty(name) {
    if (!name) return name;
    var m = aliasMap();
    for (var i = 0; i < m.length; i++) { if (m[i].alias === name) return m[i].std; }
    return name;
  }
  function openAliasManager() {
    function renderBody() {
      var m = aliasMap();
      var rows = m.length ? m.map(function (a, i) {
        return '<tr><td>' + FW.esc(a.alias) + '</td><td style="text-align:center">→</td><td>' + FW.esc(a.std) + '</td><td><a href="#" data-del="' + i + '" style="color:#c0392b">删除</a></td></tr>';
      }).join('') : '<tr><td colspan="4" class="muted">暂无别名。例：微信账单「腾讯科技」与「腾讯科技有限公司」实为一家，映射后统计不分散。</td></tr>';
      var body = '<div class="tx-form">' +
        '<div class="tx-section"><div class="tx-title">新增别名映射</div>' +
        '<div class="form-grid"><div class="field"><input id="alAlias" placeholder="别名（如：XX科技）"></div>' +
        '<div class="field"><input id="alStd" placeholder="标准名（如：XX科技有限公司）"></div>' +
        '<button class="btn sm" id="alAdd" type="button">＋ 添加</button></div>' +
        '<div class="muted" style="font-size:12px">录入时填写「别名」会自动归一为标准名，归类与统计不再分散。</div></div>' +
        '<div class="tx-section"><div class="tx-title">现有映射</div>' +
        '<table id="alTable"><thead><tr><th>别名</th><th></th><th>标准名</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div></div>';
      FW.openModal('商户别名合并', body, function () {
        var add = document.getElementById('alAdd');
        if (add) add.onclick = function () {
          var a = document.getElementById('alAlias').value.trim();
          var s = document.getElementById('alStd').value.trim();
          if (!a || !s) { FW.toast('请填别名和标准名'); return; }
          var mm = aliasMap(); mm.push({ alias: a, std: s }); FW.db.saveList(ALIAS_KEY, mm);
          FW.toast('已添加：' + a + ' → ' + s); renderBody();
        };
        Array.prototype.forEach.call(document.querySelectorAll('#alTable a[data-del]'), function (x) {
          x.onclick = function (e) { e.preventDefault(); var mm = aliasMap(); mm.splice(+x.dataset.del, 1); FW.db.saveList(ALIAS_KEY, mm); renderBody(); };
        });
      });
    }
    renderBody();
  }

  /* ---- 自动联想（对方单位 / 摘要） ---- */
  var AC_KEYS = ['f_party', 'f_remark'];
  function acCandidates(field) {
    var list = FW.db.getList(KEY) || [];
    var seen = {}, out = [];
    for (var i = list.length - 1; i >= 0; i--) {
      var v = field === 'f_party' ? (list[i].party || '') : (list[i].remark || '');
      if (v && !seen[v]) { seen[v] = 1; out.push(v); }
    }
    return out;
  }
  if (!global.__cwAcBound) {
    global.__cwAcBound = true;
    document.addEventListener('input', function (e) {
      var el = e.target; if (!el || AC_KEYS.indexOf(el.id) < 0) return;
      var val = (el.value || '').trim();
      var box = document.getElementById('acBox');
      if (!val) { if (box) box.style.display = 'none'; return; }
      var cands = acCandidates(el.id).filter(function (c) { return c.indexOf(val) >= 0 && c !== val; }).slice(0, 8);
      if (!cands.length) { if (box) box.style.display = 'none'; return; }
      if (!box) { box = document.createElement('div'); box.id = 'acBox'; box.className = 'ac-box no-print'; document.body.appendChild(box); }
      var rect = el.getBoundingClientRect();
      box.style.cssText = 'position:fixed;left:' + rect.left + 'px;top:' + (rect.bottom + 2) + 'px;z-index:99999;background:#fff;border:1px solid #dbe4ee;border-radius:8px;box-shadow:0 6px 18px rgba(0,0,0,.12);max-height:210px;overflow:auto;min-width:' + Math.max(rect.width, 160) + 'px';
      box.innerHTML = cands.map(function (c) { return '<div class="ac-item" data-v="' + FW.esc(c) + '">' + FW.esc(c) + '</div>'; }).join('');
      box.style.display = 'block';
      Array.prototype.forEach.call(box.querySelectorAll('.ac-item'), function (it) {
        it.onmousedown = function (ev) { ev.preventDefault(); el.value = it.getAttribute('data-v'); box.style.display = 'none'; if (el.oninput) el.oninput(); var ev2 = document.createEvent('Event'); ev2.initEvent('change', true, true); el.dispatchEvent(ev2); };
      });
    });
    document.addEventListener('click', function (e) {
      var box = document.getElementById('acBox');
      if (box && !box.contains(e.target) && e.target.id !== 'f_party' && e.target.id !== 'f_remark') box.style.display = 'none';
    });
  }

  /* ---- 流水草稿箱 ---- */
  var FORM_IDS = ['f_date', 'f_type', 'f_project', 'f_party', 'f_reimburser', 'f_amount', 'f_remark', 'f_cat1', 'f_cat2', 'f_account', 'f_from', 'f_to', 'f_edir', 'f_fee_permille', 'f_fee_name'];
  function collectForm() {
    var o = {}; FORM_IDS.forEach(function (id) { var el = document.getElementById(id); if (el) o[id] = el.value; }); return o;
  }
  function formHasContent(d) {
    return d && ((d.f_amount && d.f_amount.trim()) || (d.f_party && d.f_party.trim()) || (d.f_remark && d.f_remark.trim()) || (d.f_cat1 && d.f_cat1.trim()));
  }
  function saveDraftFromForm() { var d = collectForm(); if (!formHasContent(d)) { FW.db.saveList(DRAFT_KEY, []); return; } d._ts = Date.now(); FW.db.saveList(DRAFT_KEY, [d]); }
  function getDraft() { var d = FW.db.getList(DRAFT_KEY) || []; return d.length ? d[0] : null; }
  function clearDraft() { FW.db.saveList(DRAFT_KEY, []); }
  function applyDraftToForm(d) {
    if (!d) return;
    FORM_IDS.forEach(function (id) { var el = document.getElementById(id); if (el && d[id] != null && d[id] !== '') el.value = d[id]; });
  }
  function maybeRestoreDraft() {
    var d = getDraft(); if (!d) return;
    FW.closeModal();
    clearDraft();
    if (FW.modules.internal && FW.modules.internal.openForm) FW.modules.internal.openForm(null, d);
  }

  /* ---- 复制上一笔 ---- */
  function dupLast() {
    var list = (FW.db.getList(KEY) || []).slice().sort(function (a, b) { return String(b.date || '').localeCompare(String(a.date || '')); });
    if (!list.length) { FW.toast('还没有流水可复制'); return; }
    var rec = list[0];
    var prefill = {
      date: FW.today(), type: rec.type || 'expense', cat1: '', cat2: '',
      account: rec.account || '', amount: '', remark: rec.remark || '', project: rec.project || '',
      party: rec.party || '', reimburser: rec.reimburser || '', photos: [],
      fromAccount: rec.fromAccount || '', toAccount: rec.toAccount || '', equityDir: rec.equityDir || 'in'
    };
    if (rec.category) { var p = rec.category.split(' / '); prefill.cat1 = p[0]; prefill.cat2 = p[1] || ''; }
    if (FW.modules.internal && FW.modules.internal.openForm) FW.modules.internal.openForm(null, prefill);
  }

  /* ---- 凭证 OCR（可配置） ---- */
  function getOcrCfg() { try { return JSON.parse(FW.db.getList(OCR_KEY)[0] || '{}'); } catch (e) { return {}; } }
  function openOcrSettings() {
    var cfg = getOcrCfg();
    var body = '<div class="tx-form"><div class="tx-section"><div class="tx-title">OCR 识别设置</div>' +
      '<div class="muted" style="font-size:12px;margin-bottom:8px">凭证拍照后自动识别金额需接入识别服务（如腾讯云 / 百度 OCR）。填入接口地址与令牌；图片以 base64 POST 上传，返回 JSON 中含金额字段即回填。</div>' +
      '<div class="form-grid"><div class="field full"><label>接口地址（URL）</label><input id="ocrUrl" value="' + FW.esc(cfg.url || '') + '" placeholder="https://your-ocr-api/recognize"></div>' +
      '<div class="field full"><label>令牌 / Token</label><input id="ocrToken" value="' + FW.esc(cfg.token || '') + '" placeholder="Bearer xxxx（留空则不带）"></div>' +
      '<div class="field full"><label>金额字段名</label><input id="ocrField" value="' + FW.esc(cfg.field || 'amount') + '" placeholder="返回 JSON 中的金额键名"></div></div>' +
      '<div class="form-actions"><button class="btn ghost" id="ocrCancel" type="button">取消</button><button class="btn" id="ocrSave" type="button">保存</button></div></div>';
    FW.openModal('OCR 设置', body, function () {
      document.getElementById('ocrCancel').onclick = FW.closeModal;
      document.getElementById('ocrSave').onclick = function () {
        var c = { url: document.getElementById('ocrUrl').value.trim(), token: document.getElementById('ocrToken').value.trim(), field: document.getElementById('ocrField').value.trim() || 'amount' };
        FW.db.saveList(OCR_KEY, [JSON.stringify(c)]); FW.closeModal(); FW.toast(c.url ? 'OCR 已配置' : '已清除 OCR 配置');
      };
    });
  }
  function runOcr(photoId, onAmt) {
    var cfg = getOcrCfg();
    if (!cfg.url) { FW.toast('未配置 OCR，请到工具栏「🔍 OCR设置」'); return; }
    FW.db.getPhoto(photoId).then(function (dataUrl) {
      if (!dataUrl) { FW.toast('凭证图读取失败'); return; }
      FW.toast('识别中…');
      var h = { 'Content-Type': 'application/json' }; if (cfg.token) h['Authorization'] = cfg.token;
      fetch(cfg.url, { method: 'POST', headers: h, body: JSON.stringify({ image: dataUrl }) }).then(function (r) { return r.json(); }).then(function (j) {
        var amt = j && (j[cfg.field] != null ? j[cfg.field] : j.amount);
        amt = parseFloat(String(amt).replace(/[￥¥,\s]/g, ''));
        if (!(amt > 0)) { FW.toast('OCR 未返回有效金额'); return; }
        onAmt(amt); FW.toast('OCR 识别金额：' + FW.fmtMoney(amt));
      }).catch(function () { FW.toast('OCR 请求失败，检查接口 / 网络'); });
    }).catch(function () { FW.toast('凭证图读取失败'); });
  }

  /* ---- 全局快捷键 ---- */
  if (!global.__cwKeyBound) {
    global.__cwKeyBound = true;
    document.addEventListener('keydown', function (e) {
      var t = e.target; var tag = t && t.tagName ? t.tagName.toLowerCase() : '';
      var typing = tag === 'input' || tag === 'textarea' || tag === 'select' || (t && t.isContentEditable);
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      var k = e.key;
      if (k === 'n' || k === 'N') { e.preventDefault(); if (FW.modules.internal && FW.modules.internal.openForm) FW.modules.internal.openForm(null); }
      else if (k === '/') { e.preventDefault(); var s = document.getElementById('fKw'); if (s) { s.focus(); s.select(); } }
      else if (k === 'c' || k === 'C') { e.preventDefault(); if (FW.convenience) FW.convenience.openMonthClose(); }
    });
  }

  FW.convenience = {
    isClosedMonth: isClosedMonth,
    openMonthClose: openMonthClose,
    openVoucherPool: openVoucherPool,
    initTplBar: initTplBar,
    applyTpl: applyTpl,
    saveTplFromForm: saveTplFromForm,
    normalizeParty: normalizeParty,
    openAliasManager: openAliasManager,
    saveDraftFromForm: saveDraftFromForm,
    getDraft: getDraft,
    clearDraft: clearDraft,
    maybeRestoreDraft: maybeRestoreDraft,
    applyDraftToForm: applyDraftToForm,
    dupLast: dupLast,
    openOcrSettings: openOcrSettings,
    runOcr: runOcr
  };
})(window);
