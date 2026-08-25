/* ============================================================
 * 登记内账模块（重做版：逻辑自洽）
 * 核心恒等式：
 *   账户余额 = 期初余额 + 本期收支(收入-支出) + 本期往来(互转净额+股本净)
 *   资金总计 = Σ账户余额 = 期初总计 + 区间结余(收入-支出) + 股本净变动
 *   —— 互转净额恒为 0，故不影响「结余 / 利润」，只改变资金在各账户的归属。
 * 两层概念：
 *   利润层：收入 / 支出（影响结余，不影响资金归属）
 *   资金层：各账户余额（含期初 + 收支 + 互转 + 股本）
 * ============================================================ */
(function (global) {
  'use strict';
  var FW = global.FW;
  var KEY = 'internal';
  var OPEN_KEY = 'internal_openings';      // 期初余额（按账户）
  var BKEY = 'internal_budget';
  var CATKEY = 'internal_cats';
  var RULEKEY = 'internal_catrules';     // 科目智能匹配规则（用户可编辑，否则用 CatMatch.DEFAULT_RULES）
  var catAutoTouched = false;            // 本次表单中用户是否手动改过分类（改过则停止自动匹配，避免覆盖）
  var DEFAULT_CATS = ['办公用品', '差旅费', '餐饮招待', '工资薪酬', '房租物业', '交通出行', '广告宣传', '材料采购', '设备购置', '税费', '利息收入', '其他收入', '其他支出'];
  var SEP = ' / ';   // 账户层级分隔符（与分类一致）
  var DEFAULT_ACCTS = ['现金', '银行卡', '支付宝', '微信', '对公账户', '其他'];
  var ACCT_KEY = 'internal_accounts';   // 自定义账户列表（按账本隔离，二级结构：[{name, children:[name]}])

  // 账户一级/二级拆分
  function acct1(name) { return (name || '').split(SEP)[0]; }
  function acct2(name) { return (name || '').split(SEP).slice(1).join(SEP); }

  // 账户树（一级 + 二级）；兼容旧数据 [{name}] 无 children 的情况
  function getAccountTree() {
    var list = FW.db.getList(ACCT_KEY);
    if (!list.length) return DEFAULT_ACCTS.map(function (n) { return { name: n, children: [] }; });
    return list.map(function (a) {
      var kids = (a.children || []).map(function (c) { return (typeof c === 'string') ? c : (c && c.name) || ''; }).filter(Boolean);
      return { name: a.name || '', children: kids };
    }).filter(function (a) { return a.name; });
  }
  // 扁平账户名（一级 +「一级 / 二级」），供下拉/筛选/余额定位使用
  function getAccounts() {
    var out = [];
    getAccountTree().forEach(function (a) {
      out.push(a.name);
      (a.children || []).forEach(function (c) { out.push(a.name + SEP + c); });
    });
    return out;
  }
  function saveAccounts(tree) {
    // 兼容旧调用方：支持 [字符串] 或 [{name, children:[字符串|{name}]}]
    var arr = (tree || []).map(function (a) {
      if (typeof a === 'string') return { name: a.trim(), children: [] };
      return {
        name: (a.name || '').trim(),
        children: (a.children || []).map(function (c) { return (typeof c === 'string') ? c.trim() : (c && c.name || '').trim(); }).filter(Boolean)
      };
    }).filter(function (a) { return a.name; });
    FW.db.saveList(ACCT_KEY, arr);
  }
  // 兼容旧代码中直接引用 ACCTS 的地方（余额统计/期初等）
  var ACCTS = getAccounts();

  // 账户配色：按账户在账户列表中的固定顺序分配颜色，保证不同账户一定不同色（hash 取色易撞色）
  var ACC_COLORS = ['#1F6FB2', '#B45F06', '#7A4FB5', '#0E8C8C', '#C77F0A', '#3F7CAC', '#5E35B1', '#00695C', '#4E342E', '#37474F'];
  var ACC_COLOR_MAP = null;  // 账户名 -> 颜色，按 getAccounts() 顺序建立，缓存
  function buildAccColorMap() {
    ACC_COLOR_MAP = {};
    var list = getAccounts();
    list.forEach(function (n, i) {
      if (n) ACC_COLOR_MAP[n] = ACC_COLORS[i % ACC_COLORS.length];
    });
  }
  function accColor(name) {
    var s = String(name || '');
    if (!s) return '#1F2D3D';
    if (ACC_COLOR_MAP === null) buildAccColorMap();
    if (ACC_COLOR_MAP[s]) return ACC_COLOR_MAP[s];
    // 不在账户列表里的（旧数据/临时值）：回退到稳定 hash 取色
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return ACC_COLORS[h % ACC_COLORS.length];
  }
  function refreshAccts() { ACCTS = getAccounts(); ACC_COLOR_MAP = null; }

  var CATKEY_ = CATKEY;
  function cats() { return FW.db.getList(CATKEY_); }
  function ensureCats() { if (!cats().length) FW.db.saveList(CATKEY_, DEFAULT_CATS.map(function (n) { return { name: n, children: [] }; })); }
  function cat1Name(t) { return (t.category || '').split(' / ')[0]; }
  function cat2Name(t) { return (t.category || '').split(' / ')[1] || ''; }

  /* ---------- 期初余额 ---------- */
  function getOpenings() { return FW.db.getList(OPEN_KEY); }
  function openingsTotal() { return getOpenings().reduce(function (s, o) { return s + (Number(o.amount) || 0); }, 0); }
  function saveOpenings(arr) { FW.db.saveList(OPEN_KEY, arr); }

  /* ---------- 预算辅助 ---------- */
  function getBudget(month) { return FW.db.getList(BKEY).filter(function (b) { return b.month === month; })[0] || null; }
  function monthExpense(month) {
    var rows = all().filter(function (t) { return t.date.slice(0, 7) === month; });
    var exp = rows.filter(function (t) { return t.type === 'expense'; }).reduce(function (a, t) { return a + Number(t.amount); }, 0);
    var rf = rows.filter(function (t) { return t.type === 'refund'; }).reduce(function (a, t) { return a + Number(t.amount); }, 0);
    return exp - rf;
  }
  function monthSum(m) {
    var inc = 0, exp = 0;
    all().forEach(function (t) { if (t.date && t.date.slice(0, 7) === m) { if (t.type === 'income') inc += +t.amount; else if (t.type === 'expense') exp += +t.amount; else if (t.type === 'refund') exp -= +t.amount; } });
    return { inc: inc, exp: exp, net: inc - exp };
  }
  function prevMonth(ym) { var y = +ym.slice(0, 4), m = +ym.slice(5, 7); m--; if (m === 0) { m = 12; y--; } return y + '-' + (m < 10 ? '0' + m : m); }
  function shiftMonth(ym, delta) { var y = +ym.slice(0, 4), m = +ym.slice(5, 7) - 1 + delta; y += Math.floor(m / 12); m = (m % 12 + 12) % 12; return y + '-' + (m + 1 < 10 ? '0' + (m + 1) : m + 1); }

  var state = { tab: 'list', filter: { project: '', category: '', category2: '', account: '', type: '', kw: '', from: '', to: '', noAlloc: false }, statFrom: '', statTo: '', calMonth: '', calSel: '', fundType: '', bankAcct: '', showVoucher: true, selMode: false, selIds: {} };

  function all() { return FW.db.getList(KEY).sort(function (a, b) { return (a.date < b.date ? 1 : a.date > b.date ? -1 : 0); }); }
  function projects() {
    var set = {};
    FW.db.getList(KEY).forEach(function (t) {
      if (t.project) set[t.project] = 1;
      (t.allocations || []).forEach(function (a) { if (a.project) set[a.project] = 1; });
    });
    return Object.keys(set);
  }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function lastDay(y, m) { return new Date(y, m + 1, 0).getDate(); }
  function rangeDates(kind) {
    var now = new Date(); var y = now.getFullYear(), m = now.getMonth();
    if (kind === 'month') return { from: y + '-' + pad(m + 1) + '-01', to: y + '-' + pad(m + 1) + '-' + lastDay(y, m) };
    if (kind === 'quarter') { var q = Math.floor(m / 3) * 3; return { from: y + '-' + pad(q + 1) + '-01', to: y + '-' + pad(q + 2 + 1) + '-' + lastDay(y, q + 2) }; }
    if (kind === 'year') return { from: y + '-01-01', to: y + '-12-31' };
    return { from: '', to: '' };
  }
  function inRange(t, from, to) { return (!from || t.date >= from) && (!to || t.date <= to); }

  function filteredRows() { return filterRows(state.filter); }
  // 账户匹配：筛选值为二级完整名则精确匹配；为一级名则匹配其下所有二级
  function accMatch(fa, ta) {
    if (!fa || !ta) return false;
    if (fa.indexOf(SEP) >= 0) return fa === ta;
    return acct1(fa) === acct1(ta);
  }
  function filterRows(f) {
    return all().filter(function (t) {
      if (f.project) {
        var projHit = (t.project === f.project);
        if (!projHit && t.allocations) projHit = t.allocations.some(function (a) { return (a.project || '').trim() === f.project; });
        if (!projHit) return false; // 单项目直接比；已分摊的交易按各 allocation 项目匹配，避免分摊出去的交易在按项目筛时消失
      }
      if (f.category && cat1Name(t) !== f.category) return false;
      if (f.category2 && cat2Name(t) !== f.category2) return false;
      if (f.account) {
        var matched = (t.type === 'transfer')
          ? (accMatch(f.account, t.fromAccount) || accMatch(f.account, t.toAccount))
          : accMatch(f.account, t.account);
        if (!matched) return false;
      }
      if (f.type && t.type !== f.type) return false;
      if (f.from && t.date < f.from) return false;
      if (f.to && t.date > f.to) return false;
      if (f.kw && ((t.remark || '') + (txProjectText(t)) + (t.category || '')).indexOf(f.kw) < 0) return false;
      if (f.noAlloc) {
        var allocatable = (t.type === 'income' || t.type === 'expense' || t.type === 'refund');
        var hasAlloc = !!(t.allocations && t.allocations.length);
        var hasProject = !!(t.project && String(t.project).trim());
        if (!allocatable || hasAlloc || hasProject) return false; // 只保留「连单项目都没挂、又没做分摊」的收支/退款
      }
      return true;
    });
  }
  // 取一笔记录的“主账户”（用于筛选/账户维度统计）
  function accountOf(t) {
    if (t.type === 'transfer') return (t.fromAccount || '') + '→' + (t.toAccount || '');
    return t.account || '';
  }

  /* ============================================================
   * 核心计算（逻辑通的关键）
   * ============================================================ */
  // 账户余额分解：返回树状结构 [{name, opening, flow, move, bal, children:[{name,...,bal}]}]
  // 一级账户余额 = 其直接流水 + 各二级子账户余额之和
  function accountBreakdown(upto) {
    var open = {}, flow = {}, move = {};
    getOpenings().forEach(function (o) { if (o.account) open[o.account] = (open[o.account] || 0) + (Number(o.amount) || 0); });
    all().forEach(function (t) {
      if (upto && t.date > upto) return;
      var a = Number(t.amount) || 0;
      if (t.type === 'income') { flow[t.account] = (flow[t.account] || 0) + a; }
      else if (t.type === 'expense') { flow[t.account] = (flow[t.account] || 0) - a; }
      else if (t.type === 'refund') { flow[t.account] = (flow[t.account] || 0) + a; }
      else if (t.type === 'transfer') {
        if (t.fromAccount) move[t.fromAccount] = (move[t.fromAccount] || 0) - a;
        if (t.toAccount) move[t.toAccount] = (move[t.toAccount] || 0) + a;
      } else if (t.type === 'equity') {
        var s = t.equityDir === 'out' ? -1 : 1;
        if (t.account) move[t.account] = (move[t.account] || 0) + s * a;
      }
      else if (t.type === 'dividend') {
        if (t.account) move[t.account] = (move[t.account] || 0) - a;
      }
    });
    // 按完整账户名聚合期初/收支/往来
    var byFull = {};
    function bump(name, part, val) { if (!name) return; if (!byFull[name]) byFull[name] = { opening: 0, flow: 0, move: 0 }; byFull[name][part] += val; }
    Object.keys(open).forEach(function (k) { bump(k, 'opening', open[k]); });
    Object.keys(flow).forEach(function (k) { bump(k, 'flow', flow[k]); });
    Object.keys(move).forEach(function (k) { bump(k, 'move', move[k]); });
    // 归并到一级 / 二级
    var prim = {};
    Object.keys(byFull).forEach(function (fn) {
      var p1 = acct1(fn), p2 = acct2(fn);
      if (!prim[p1]) prim[p1] = { direct: { opening: 0, flow: 0, move: 0 }, subs: {} };
      var tgt = p2 ? (prim[p1].subs[p2] || (prim[p1].subs[p2] = { opening: 0, flow: 0, move: 0 })) : prim[p1].direct;
      var src = byFull[fn];
      tgt.opening += src.opening; tgt.flow += src.flow; tgt.move += src.move;
    });
    var order = [], seenP = {};
    ACCTS.forEach(function (k) { var p1 = acct1(k); if (prim[p1] && !seenP[p1]) { seenP[p1] = 1; order.push(p1); } });
    Object.keys(prim).forEach(function (p1) { if (!seenP[p1]) { seenP[p1] = 1; order.push(p1); } });
    return order.map(function (p1) {
      var pr = prim[p1];
      var children = Object.keys(pr.subs).map(function (p2) {
        var s = pr.subs[p2];
        return { name: p1 + SEP + p2, opening: s.opening, flow: s.flow, move: s.move, bal: s.opening + s.flow + s.move };
      });
      var directBal = pr.direct.opening + pr.direct.flow + pr.direct.move;
      var subBal = children.reduce(function (a, c) { return a + c.bal; }, 0);
      return { name: p1, opening: pr.direct.opening, flow: pr.direct.flow, move: pr.direct.move, bal: directBal + subBal, children: children };
    });
  }
  // 账户余额（扁平，供报表中心复用）：返回各叶子账户 [{name, bal}]
  function accountBalances(upto) {
    var out = [];
    accountBreakdown(upto).forEach(function (p) {
      if (p.children.length) p.children.forEach(function (c) { out.push({ name: c.name, bal: c.bal }); });
      else out.push({ name: p.name, bal: p.bal });
    });
    return out;
  }
  // 账户余额（树状，供首页看板复用）：返回 [{name, bal, children:[{name, bal}]}]
  function accountBalancesTree(upto) { return accountBreakdown(upto); }
  // 区间经营结余（仅收入-支出）
  function netProfit(from, to) {
    return all().reduce(function (s, t) {
      if (!inRange(t, from, to)) return s;
      if (t.type === 'income') return s + (Number(t.amount) || 0);
      if (t.type === 'expense') return s - (Number(t.amount) || 0);
      if (t.type === 'refund') return s + (Number(t.amount) || 0);
      return s;
    }, 0);
  }
  // 区间股本净变动
  function equityNet(from, to) {
    return all().reduce(function (s, t) {
      if (t.type !== 'equity' || !inRange(t, from, to)) return s;
      return s + (Number(t.amount) || 0) * (t.equityDir === 'out' ? -1 : 1);
    }, 0);
  }

  /* ---------- 渲染主框架 ---------- */
  function render() {
    ensureCats();
    var c = document.getElementById('content');
    c.innerHTML =
      '<div id="inToolbar" class="toolbar"></div>' +
      '<div id="inOverview"></div>' +
      '<div id="inBody"></div>';
    drawBody();

    var ov = document.getElementById('inOverview');
    if (ov) ov.innerHTML = overviewHtml();

    // 顶栏只保留主操作「＋ 新增流水」；其余次级操作下放到内容区顶部工具条（避免 9 个按钮在窄屏被裁切）
    var ta = document.getElementById('topActions');
    ta.innerHTML = '<button class="btn" id="addTxBtn">＋ 新增流水</button>';
    document.getElementById('addTxBtn').onclick = openForm;

    var tb = document.getElementById('inToolbar');
    if (tb) {
      tb.innerHTML = '<button class="btn ghost" id="openBtn">⚙ 设置期初</button><button class="btn ghost" id="accMgrBtn">🏦 账户管理</button><button class="btn ghost" id="budgetBtn">⚙ 设置预算</button><button class="btn ghost" id="catBtn">🏷 分类管理</button><button class="btn ghost" id="impBtn">📥 批量导入</button><button class="btn ghost" id="catMatchBtn">🤖 智能归类</button><span class="exp-menu-wrap"><button class="btn ghost" id="expTxBtn">⬇ 导出 ▾</button><div class="exp-menu no-print" id="expTxMenu" style="display:none"><div class="em-hint">给老板看 / 分享</div><button data-fmt="xlsx">📊 Excel（.xlsx）</button><button data-fmt="xlsxpic">🖼 Excel（含凭证图）</button><button class="em-img" data-fmt="img">🖼 导出图片（PNG）</button><button class="em-pdf" data-fmt="print">🖨 打印 / 转 PDF</button><button data-fmt="csv">📄 CSV（兼容）</button></div></span><button class="btn ghost" id="dedupeBtn">🔧 合并重复</button><button class="btn ghost" id="bulkBtn">' + (state.selMode ? '✕ 退出批量' : '☑ 批量修改') + '</button><button class="btn ghost danger" id="clearBtn">🗑 清空内账</button>';
      document.getElementById('openBtn').onclick = openOpenings;
      document.getElementById('accMgrBtn').onclick = openAccManager;
      document.getElementById('budgetBtn').onclick = openBudgetForm;
      document.getElementById('catBtn').onclick = openCatManager;
      document.getElementById('impBtn').onclick = openImport;
      var cmBtn = document.getElementById('catMatchBtn'); if (cmBtn) cmBtn.onclick = bulkAutoCategorize;
      var expBtn = document.getElementById('expTxBtn');
      var expMenu = document.getElementById('expTxMenu');
      if (expBtn && expMenu) {
        expBtn.onclick = function (e) { e.stopPropagation(); expMenu.style.display = (expMenu.style.display === 'none' ? 'block' : 'none'); };
        expMenu.querySelectorAll('button[data-fmt]').forEach(function (b) {
          b.onclick = function (e) {
            e.stopPropagation();
            expMenu.style.display = 'none';
            var fmt = b.getAttribute('data-fmt');
            if (fmt === 'xlsx') exportXLSX(false);
            else if (fmt === 'xlsxpic') exportXLSX(true);
            else if (fmt === 'print') openPrintView();
            else if (fmt === 'img') exportImage();
            else exportTable();
          };
        });
        if (!state._menuBound) {
          document.addEventListener('click', function () { var m = document.getElementById('expTxMenu'); if (m) m.style.display = 'none'; });
          state._menuBound = true;
        }
      }
      document.getElementById('dedupeBtn').onclick = openDedupe;
      document.getElementById('clearBtn').onclick = function () {
        if (!confirm('确定清空【当前账本】的全部内账流水吗？\n（含手动录入的，凭证照片也会一并删除，不可恢复！)\n注意：期初余额不会被清空。')) return;
        all().forEach(function (t) { if (t.photos && t.photos.length) { try { FW.db.deletePhotos(t.photos); } catch (e) {} } });
        FW.db.saveList(KEY, []);
        render();
        FW.toast('已清空当前账本内账流水');
      };
      document.getElementById('bulkBtn').onclick = function () { state.selMode = !state.selMode; state.selIds = {}; render(); };
    }
  }

  /* 合并重复：把内容完全相同的流水（多为跨设备同步产生的“同笔不同 id”）合并为一条 */
  function openDedupe() {
    var list = all();
    var groups = {};
    list.forEach(function (t) {
      var k = FW.db.contentKey(t);
      if (!k) return;
      (groups[k] = groups[k] || []).push(t);
    });
    var dups = Object.keys(groups).map(function (k) { return groups[k]; }).filter(function (g) { return g.length > 1; });
    var total = dups.reduce(function (s, g) { return s + (g.length - 1); }, 0);
    if (!dups.length) { FW.toast('未发现内容完全相同的重复流水 👍'); return; }
    function keepOf(g) {
      return g.slice().sort(function (a, b) {
        return (b.photos && b.photos.length ? 1 : 0) - (a.photos && a.photos.length ? 1 : 0);
      })[0];
    }
    function lbl(t) {
      if (t.type === 'income') return '收入';
      if (t.type === 'expense') return '支出';
      if (t.type === 'refund') return '退款收入';
      if (t.type === 'transfer') return '账户互转';
      if (t.type === 'equity') return (t.equityDir === 'out' ? '股本抽回' : '股本注入');
      if (t.type === 'dividend') return '股东分红';
      return t.type || '';
    }
    var rows = '';
    dups.forEach(function (g, i) {
      var keep = keepOf(g);
      rows += '<tr><td>' + (i + 1) + '</td><td>' + FW.esc(keep.date) + '</td><td>' + FW.esc(lbl(keep)) + '</td><td class="num">' + FW.fmtMoney(keep.amount) + '</td><td>' + FW.esc(keep.project || '') + '</td><td>' + FW.esc(keep.remark || '') + '</td><td>×' + g.length + '</td></tr>';
    });
    var body =
      '<div class="muted" style="font-size:12px;margin-bottom:10px">检测到 <b>' + dups.length + '</b> 组、共 <b>' + total + '</b> 条内容完全相同的重复流水（常见于手机/电脑各录了一遍，或多设备同步后产生）。合并后每组仅保留 1 条（优先保留带凭证照片的那条），其余重复项会被移除。</div>' +
      '<div style="max-height:340px;overflow:auto"><table class="tbl"><thead><tr><th>#</th><th>日期</th><th>类型</th><th>金额</th><th>项目</th><th>备注</th><th>重复数</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<div class="form-actions"><button class="btn ghost" id="ddCancel">取消</button><button class="btn" id="ddGo">合并并移除 ' + total + ' 条重复</button></div>';
    FW.openModal('合并重复流水', body, function () {
      document.getElementById('ddCancel').onclick = FW.closeModal;
      document.getElementById('ddGo').onclick = function () {
        var removeIds = {};
        dups.forEach(function (g) {
          var keep = keepOf(g);
          g.forEach(function (t) { if (t.id !== keep.id) removeIds[t.id] = true; });
        });
        var cleaned = list.filter(function (t) { return !removeIds[t.id]; });
        FW.db.saveList(KEY, cleaned);
        FW.closeModal();
        render();
        FW.toast('已合并，移除 ' + total + ' 条重复');
      };
    });
  }

  /* ---------- 概览面板（一眼可见，常驻顶部，全期累计） ---------- */
  function kpiCell(label, val, signed, neutral) {
    var cls = neutral ? 'muted' : (val >= 0 ? 'income' : 'expense');
    var txt = neutral ? FW.fmtMoney(val) : ((signed && val > 0 ? '+' : '') + FW.fmtMoney(val));
    return '<div class="ov-kpi"><div class="ov-kpi-label">' + label + '</div><div class="ov-kpi-val ' + cls + '">' + txt + '</div></div>';
  }
  function overviewHtml() {
    var bd = accountBreakdown();                 // 全期累计（当前资金状况）
    var cashTotal = bd.reduce(function (s, x) { return s + x.bal; }, 0);
    var openTotal = openingsTotal();
    var profit = netProfit('', '');
    var eqNet = equityNet('', '');
    var balanced = Math.abs(cashTotal - (openTotal + profit + eqNet)) < 0.005;
    var ACCENTS = ['#C8102E', '#C9A227', '#D99A2B', '#A4151B', '#E0B252', '#8B1E1E'];
    var maxAbs = Math.max.apply(null, bd.map(function (x) { return Math.abs(x.bal); }).concat([1]));
    var bars = bd.length ? bd.map(function (x, i) {
      var w = Math.max(3, Math.abs(x.bal) / maxAbs * 100);
      return '<div class="ov-acc-row">' +
        '<span class="ov-acc-name">' + FW.esc(x.name) + '</span>' +
        '<div class="ov-acc-track"><div class="ov-acc-fill" style="width:' + w.toFixed(1) + '%;background:' + ACCENTS[i % ACCENTS.length] + '"></div></div>' +
        '<span class="ov-acc-amt ' + (x.bal >= 0 ? 'income' : 'expense') + '">' + FW.fmtMoney(x.bal) + '</span>' +
      '</div>';
    }).join('') : '<div class="empty">还没有账户余额数据，去「设置期初」或登记流水。</div>';
    return '<div class="ov-panel">' +
      '<div class="ov-head">' +
        '<div class="ov-total"><div class="ov-total-label">资金总计（各账户余额合计）</div><div class="ov-total-val">' + FW.fmtMoney(cashTotal) + '</div></div>' +
        '<span class="badge ' + (balanced ? 'done' : 'warn') + '">' + (balanced ? '✅ 对账平衡' : '⚠️ 对账不平') + '</span>' +
      '</div>' +
      '<div class="ov-kpis">' +
        kpiCell('累计结余（收入−支出）', profit, true, false) +
        kpiCell('期初余额', openTotal, false, false) +
        kpiCell('股本净变动', eqNet, true, false) +
        kpiCell('账户互转净额', 0, false, true) +
      '</div>' +
      '<div class="ov-accs"><div class="ov-accs-title">各账户余额（横向条形越长代表余额越多）</div>' + bars +
        '<div class="ov-hint">说明：账户互转只改变资金在各账户的归属，不改变「资金总计」与「结余」；股本注入 / 抽回影响资金但不影响经营利润。</div>' +
      '</div>' +
    '</div>';
  }

  function drawBody() {
    // 切换 tab 时同步顶栏操作区：报表中心覆盖为打印/导出，其余恢复为「新增流水」
    var ta = document.getElementById('topActions');
    if (state.tab !== 'reports' && ta) {
      ta.innerHTML = '<button class="btn" id="addTxBtn">＋ 新增流水</button>';
      var ab = document.getElementById('addTxBtn'); if (ab) ab.onclick = openForm;
    }
    if (state.tab === 'list') drawList();
    else if (state.tab === 'calendar') drawCalendar();
    else if (state.tab === 'fund') drawFund();
    else if (state.tab === 'reconcile') drawReconcile();
    else if (state.tab === 'reports') drawReportsTab();
    else drawStat();
  }

  function drawReportsTab() {
    var host = document.getElementById('inBody');
    if (!host) return;
    if (!FW.renderReports) { host.innerHTML = '<div class="empty">报表模块未加载</div>'; return; }
    FW.renderReports(host);
  }

  /* ---------- 流水明细 ---------- */
  function drawList() {
    var f = state.filter;
    var projOpts = '<option value="">全部项目</option>' + projects().map(function (p) { return '<option>' + FW.esc(p) + '</option>'; }).join('');
    var catOpts = '<option value="">全部分类</option>' + cats().map(function (c) { return '<option' + (c.name === f.category ? ' selected' : '') + '>' + FW.esc(c.name) + '</option>'; }).join('');
    var cat2OptsF = cat2OptsForFilter(f.category, f.category2);
    var accOpts = accOptsAll(f.account);
    document.getElementById('inBody').innerHTML =
      '<div id="budgetCard">' + budgetBannerHtml() + '</div>' +
      '<div id="txStats" class="stat-row"></div>' +
      // 「按账户（收支维度）」小表：老板视角（每个账户赚了/花了多少、互转头寸），随筛选实时重算
      '<div id="accSummary" class="flow-acc-inline"></div>' +
      '<div class="card">' +
      '<div class="toolbar filter-bar">' +
        '<div class="field"><input id="fKw" placeholder="搜索备注/项目" value="' + FW.esc(f.kw) + '"></div>' +
          '<div class="field"><select id="fProj">' + projOpts + '</select></div>' +
          '<div class="field"><select id="fCat">' + catOpts + '</select></div>' +
          '<div class="field"><select id="fCat2">' + cat2OptsF + '</select></div>' +
          '<div class="field"><select id="fAcc">' + accOpts + '</select></div>' +
          '<div class="field"><select id="fType"><option value="">全部类型</option><option value="income">收入</option><option value="expense">支出</option><option value="refund">退款收入</option><option value="transfer">账户互转</option><option value="equity">股本资金</option><option value="dividend">股东分红</option></select></div>' +
          '<div class="field"><input id="fFrom" type="date" title="起始日期"></div>' +
          '<div class="field"><input id="fTo" type="date" title="结束日期"></div>' +
          '<button class="btn ghost sm" id="fReset">重置</button>' +
          '<label class="chk-inline"><input type="checkbox" id="fNoAlloc"' + (f.noAlloc ? ' checked' : '') + '> 仅看未分摊</label>' +
          '<label class="chk-inline"><input type="checkbox" id="fVoucher"' + (state.showVoucher ? ' checked' : '') + '> 显示凭证图</label>' +
          '<button class="btn ghost sm" id="fResetColW" title="恢复默认列宽">重置列宽</button>' +
        '</div>' +
        (state.selMode ? bulkBarHtml() : '') +
        '<div id="txWrap"></div>' +
      '</div>';
    document.getElementById('fProj').value = f.project;
    document.getElementById('fCat').value = f.category;
    document.getElementById('fCat2').value = f.category2;
    document.getElementById('fAcc').value = f.account;
    document.getElementById('fType').value = f.type || '';
    document.getElementById('fFrom').value = f.from;
    document.getElementById('fTo').value = f.to;
    bindFilter();
    drawTable();
    if (state.selMode) bindBulkBar();
    var gb = document.getElementById('goBudget');
    if (gb) gb.onclick = openBudgetForm;
  }

  function bindFilter() {
    var g = function (id) { return document.getElementById(id); };
    g('fKw').oninput = function () { state.filter.kw = this.value.trim(); drawTable(); };
    g('fProj').onchange = function () { state.filter.project = this.value; drawTable(); };
    g('fCat').onchange = function () {
      state.filter.category = this.value;
      state.filter.category2 = '';
      var c2 = document.getElementById('fCat2');
      if (c2) { c2.innerHTML = cat2OptsForFilter(this.value, ''); c2.value = ''; }
      drawTable();
    };
    g('fCat2').onchange = function () { state.filter.category2 = this.value; drawTable(); };
    g('fAcc').onchange = function () { state.filter.account = this.value; drawTable(); };
    g('fType').onchange = function () { state.filter.type = this.value; drawTable(); };
    g('fFrom').onchange = function () { state.filter.from = this.value; drawTable(); };
    g('fTo').onchange = function () { state.filter.to = this.value; drawTable(); };
    g('fReset').onclick = function () { state.filter = { project: '', category: '', category2: '', account: '', type: '', kw: '', from: '', to: '', noAlloc: false }; drawList(); };
    g('fNoAlloc').onchange = function () { state.filter.noAlloc = this.checked; drawTable(); };
    g('fVoucher').onchange = function () { state.showVoucher = this.checked; drawTable(); };
    g('fResetColW').onclick = resetColWidths;
  }

  function drawTable() {
    var rows = filteredRows();
    var income = rows.filter(function (t) { return t.type === 'income'; }).reduce(function (a, t) { return a + Number(t.amount); }, 0);
    var expense = rows.filter(function (t) { return t.type === 'expense'; }).reduce(function (a, t) { return a + Number(t.amount); }, 0);
    var refund = rows.filter(function (t) { return t.type === 'refund'; }).reduce(function (a, t) { return a + Number(t.amount); }, 0);
    var netExpense = expense - refund;
    var unalloc = all().filter(function (t) {
      var allocatable = (t.type === 'income' || t.type === 'expense' || t.type === 'refund');
      var hasAlloc = !!(t.allocations && t.allocations.length);
      return allocatable && !hasAlloc;
    }).length;
    document.getElementById('txStats').innerHTML =
      '<div class="stat"><div class="label">筛选后收入</div><div class="value income">' + FW.fmtMoney(income) + '</div></div>' +
      '<div class="stat"><div class="label">筛选后支出（净额）</div><div class="value expense">' + FW.fmtMoney(netExpense) + '</div></div>' +
      '<div class="stat"><div class="label">退款收入（冲减支出）</div><div class="value refund">' + FW.fmtMoney(refund) + '</div></div>' +
      '<div class="stat"><div class="label">筛选后结余</div><div class="value">' + FW.fmtMoney(income - netExpense) + '</div></div>' +
      '<div class="stat"><div class="label">笔数</div><div class="value">' + rows.length + '</div></div>' +
      '<div class="stat"><div class="label">未分摊笔数</div><div class="value' + (unalloc ? ' expense' : '') + '" title="应收项目分摊、但还没填分摊的收支/退款笔数；点上方「仅看未分摊」可列出">' + unalloc + '</div></div>';
    document.getElementById('txWrap').innerHTML = rows.length ? tableHtml(rows) : '<div class="empty">没有符合条件的流水，点右上角「新增流水」开始登记。</div>';
    // 「按账户（收支维度）」小表：随筛选实时重算（与流水表共用 filteredRows 口径）
    var accEl = document.getElementById('accSummary');
    if (accEl) accEl.innerHTML = accSummaryHtml(rows, state.filter);
    FW.qa('#txTable .row-edit').forEach(function (b) { b.onclick = function () { openForm(b.dataset.id); }; });
    FW.qa('#txTable .row-del').forEach(function (b) { b.onclick = function () { delTx(b.dataset.id); }; });
    FW.qa('#txTable .photo-cell img').forEach(function (img) { img.onclick = function () { previewPhoto(img.dataset.pid); }; });
    loadThumbs();
    applyColWidths();
    bindColResize();
    if (state.selMode) bindBulkRowEvents();
  }

  function typeMeta(t) {
    if (t.type === 'income') return { tag: '收入', cls: 'income' };
    if (t.type === 'expense') return { tag: '支出', cls: 'expense' };
    if (t.type === 'refund') return { tag: '退款收入', cls: 'refund' };
    if (t.type === 'transfer') return { tag: '账户互转', cls: 'transfer' };
    if (t.type === 'equity') return { tag: (t.equityDir === 'out' ? '股本抽回' : '股本注入'), cls: 'equity' };
    if (t.type === 'dividend') return { tag: '股东分红', cls: 'neutral' };
    return { tag: t.type || '—', cls: '' };
  }

  // 流水表列定义（用于 colgroup + 表头拖拽手柄）
  var TX_COLS = ['日期', '类型', '项目', '分类', '账户', '金额', '备注', '凭证', '对方/个人', '报销人', '操作'];
  // 与 TX_COLS 一一对应的语义 id：屏幕列宽按此键持久化，导出（Excel/图片/PDF）复用同一套宽度
  var TX_COL_IDS = ['date', 'type', 'project', 'category', 'account', 'amount', 'remark', 'voucher', 'party', 'reimburser', 'op'];
  // 默认列宽：紧凑版（间距 11+内 padding 9/11），让初始看起来不那么"远"；还嫌宽的话继续拖
  var TX_DEF_W = { 0: 92, 1: 84, 2: 116, 3: 96, 4: 88, 5: 108, 6: 148, 7: 96, 8: 112, 9: 84, 10: 108 };
  var COLW_KEY = 'fw_tx_colwidths';

  function tableHtml(rows) {
    var trs = rows.map(function (t) {
      var m = typeMeta(t);
      var affects = (t.type === 'income' || t.type === 'expense' || t.type === 'refund');
      var amtCls = affects ? m.cls : 'neutral';
      var acctTxt = accountOf(t);
      var pcount = (t.photos && t.photos.length) || 0;
      var selTd = state.selMode ? '<td><input type="checkbox" class="sel-cb" data-id="' + t.id + '"' + (state.selIds[t.id] ? ' checked' : '') + '></td>' : '';
      // 凭证图片直接落在本行的「凭证」列内（与打印视图口径一致，不另起子行）
      var vcell;
      if (!pcount) vcell = '<span class="muted">—</span>';
      else if (!state.showVoucher) vcell = '<span class="v-count" title="该笔有 ' + pcount + ' 张凭证">📎 ' + pcount + '</span>';
      else vcell = '<div class="v-imgs">' + t.photos.filter(Boolean).map(function (pid) {
        return '<img class="v-inline" data-pid="' + pid + '" data-load="' + pid + '" alt="凭证" title="点击查看大图">';
      }).join('') + '</div>';
      return '<tr>' + selTd +
        '<td class="nowrap tx-detail">' + FW.esc(t.date) + '</td>' +
        '<td class="tx-detail">' + (affects ? '<span class="tag ' + m.cls + '">' + m.tag + '</span>' : '<span class="tag ' + m.cls + '">' + m.tag + '</span><div class="muted" style="font-size:11px">不影响收支</div>') + '</td>' +
        '<td class="tx-detail">' + txProjectLabel(t) + '</td>' +
        '<td class="tx-detail">' + FW.esc(t.category || (affects ? '—' : '—')) + '</td>' +
        '<td class="col-tight-r tx-detail" style="color:' + accColor(acctTxt) + '"><b>' + FW.esc(acctTxt) + '</b></td>' +
        '<td class="num ' + amtCls + ' col-tight-l">' + FW.fmtMoney(t.amount) + (t.type === 'income' && t.deduct > 0 ? '<div class="muted" style="font-size:11px">实际收入 ' + FW.fmtMoney(t.amount + t.deduct) + '</div>' : '') + '</td>' +
        '<td class="remark col-loose-l">' + FW.esc(t.remark || '') + (t.type === 'income' && t.deduct > 0 ? '<div class="muted" style="font-size:11px">已扣' + FW.esc(t.feeName || '支出') + ' ' + FW.fmtMoney(t.deduct) + '（计入项目成本）</div>' : '') + '</td>' +
        '<td class="photo-cell">' + vcell + '</td>' +
        '<td>' + FW.esc(t.party || '—') + '</td>' +
        '<td>' + FW.esc(t.reimburser || '—') + '</td>' +
        '<td class="row-actions nowrap"><button class="btn ghost sm row-edit" data-id="' + t.id + '">编辑</button><button class="btn danger sm row-del" data-id="' + t.id + '">删</button></td>' +
        '</tr>';
    }).join('');
    var selHead = state.selMode ? '<th><input type="checkbox" id="selAll" title="全选当前列表"></th>' : '';
    // colgroup：每列一个 <col>，data-col 为「语义列序号」（与是否批量模式无关），宽度由 localStorage 持久化 + 默认兜底
    var colTags = '';
    if (state.selMode) colTags += '<col data-col="sel">';
    TX_COLS.forEach(function (c, i) {
      colTags += '<col data-col="' + i + '">';
    });
    // 表头：除最后一列外，每个 th 右侧加拖拽手柄（data-col 用语义序号，导出复用同一套宽度）
    // 用相邻列 padding 控制「列间距离」：账户↔金额 收紧(col-tight)、金额↔备注 拉开(col-loose)
    var headCells = TX_COLS.map(function (c, i) {
      var isLast = (i === TX_COLS.length - 1);
      var cls = '';
      if (c === '金额') cls = 'num';
      if (c === '账户') cls = (cls ? cls + ' ' : '') + 'col-tight-r';
      if (c === '备注') cls = (cls ? cls + ' ' : '') + 'col-loose-l';
      var rz = isLast ? '' : '<span class="col-resizer" data-col="' + i + '" title="拖拽调整列宽"></span>';
      // 给内容列 th 加 data-col（与 colgroup 的 <col data-col> 一一对应），供导出读取真实渲染宽度
      return '<th' + (cls ? ' class="' + cls + '"' : '') + ' data-col="' + i + '">' + c + rz + '</th>';
    }).join('');
    return '<table id="txTable"><colgroup>' + colTags + '</colgroup><thead><tr>' + selHead +
      headCells +
      '</tr></thead><tbody>' + trs + '</tbody></table>';
  }

  // 凭证图全部加载失败时页面顶部横幅（用户无需跑 Console）
  function showPhotoDiagBanner(total) {
    if (document.getElementById('photoDiagBanner')) return;
    var b = document.createElement('div');
    b.id = 'photoDiagBanner';
    b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#C8102E;color:#fff;padding:10px 16px;font-size:13px;display:flex;gap:12px;align-items:center;box-shadow:0 2px 10px rgba(0,0,0,.25)';
    b.innerHTML = '<span style="flex:1">⚠️ 检测到 ' + total + ' 张凭证图全部加载失败，可能是数据丢失或浏览器权限问题</span>' +
      '<button id="photoDiagBtn" style="background:#fff;color:#C8102E;border:none;padding:5px 14px;border-radius:6px;cursor:pointer;font-weight:600">查看诊断</button>' +
      '<button id="photoDiagClose" style="background:transparent;color:#fff;border:1px solid rgba(255,255,255,.6);padding:5px 10px;border-radius:6px;cursor:pointer">关闭</button>';
    document.body.appendChild(b);
    b.querySelector('#photoDiagBtn').onclick = diagnosePhotosDetail;
    b.querySelector('#photoDiagClose').onclick = function () { b.remove(); };
  }

  // 直接读 IndexedDB 诊断凭证数据状态（不依赖业务代码）
  function diagnosePhotosDetail() {
    try {
      if (!global.indexedDB) { FW.toast('当前浏览器不支持 IndexedDB'); return; }
      var req = indexedDB.open('fw_photos', 1);
      req.onsuccess = function () {
        var db = req.result;
        var tx = db.transaction('photos', 'readonly');
        var all = tx.objectStore('photos').getAll();
        all.onsuccess = function () {
          var list = all.result || [];
          var total = list.length, valid = 0;
          list.forEach(function (p) {
            var d = p && p.data;
            if (typeof d === 'string' && d.indexOf('data:image') === 0) valid++;
          });
          var lines = ['凭证数据库诊断', '─────────────', '数据库：fw_photos（版本 ' + db.version + '）', '凭证记录总数：' + total + ' 张', '有效图片：' + valid + ' 张'];
          if (total === 0) lines.push('⚠️ 数据为空：凭证图可能已丢失（清过浏览器数据？或从备份/Supabase 恢复）');
          else if (valid < total) lines.push('⚠️ 有 ' + (total - valid) + ' 张数据损坏（非图片格式），需重新上传');
          else lines.push('✅ 数据正常，可能是显示逻辑问题，请联系我修复');
          FW.openModal('凭证诊断', '<pre style="white-space:pre-wrap;font-size:13px;line-height:1.8;margin:0">' + lines.join('\n') + '</pre>');
        };
        all.onerror = function () { FW.toast('读取失败：' + (all.error && all.error.message)); };
      };
      req.onerror = function () { FW.toast('数据库打不开：' + (req.error && req.error.message) + '（可能是浏览器权限或隐私模式）'); };
      req.onupgradeneeded = function () { FW.toast('⚠️ 数据库需要升级，可能数据结构已变'); };
    } catch (e) { FW.toast('诊断出错：' + e.message); }
  }

  function loadThumbs() {
    var imgs = FW.qa('#txTable img[data-load]');
    if (!imgs.length) return;
    var _total = imgs.length, _finished = 0, _failed = 0;
    imgs.forEach(function (img) {
      var pid = img.dataset.load;
      var done = false;
      function markBad(reason) {
        if (done) return;
        done = true; _finished++; _failed++;
        clearTimeout(timer);
        img.style.opacity = '0.4';
        img.title = reason;
        console.warn('[loadThumbs] ' + reason);
        if (_finished === _total && _failed === _total) showPhotoDiagBanner(_total);
      }
      // 加超时兜底：部分异常 dataURL 会导致 onload/onerror 都不触发（已踩坑）
      var timer = setTimeout(function () {
        if (done) return;
        markBad('凭证图加载超时（pid=' + pid + '）');
      }, 8000);
      // 修：<img src=""> 初始空 src 会在浏览器立即触发 onerror，被误判为"加载失败"→ 设 0.4 透明度盖住真图
      // 双保险：onerror 忽略 src 为空/无效的误触；同时拿到 d 后清掉可能的残留 opacity
      img.onerror = function () {
        if (!img.src || img.src === window.location.href || /^data:,$/.test(img.src)) return;
        markBad('凭证图加载失败（pid=' + pid + '），可能数据损坏');
      };
      FW.db.getPhoto(pid).then(function (d) {
        if (done) return;
        if (d) {
          img.onerror = null;        // 拿到真图后关 onerror，避免后续重新加载时误触
          img.style.opacity = '';    // 兜底清除旧 markBad 残留的 0.4 透明度
          img.src = d;
          done = true; _finished++;
        }
        else markBad('凭证图数据为空（pid=' + pid + '）');
      }).catch(function (e) {
        markBad('凭证图读取异常：' + (e && e.message ? e.message : e));
      });
    });
  }

  /* ---------- 列宽拖拽（用户可自定义流水表列宽，localStorage 持久化） ---------- */
  // 存储按「语义列序号」(TX_COLS 索引 0-10) 持久化，与是否勾选批量无关，导出也可复用同一套宽度
  function getColWidths() {
    try { return JSON.parse(localStorage.getItem(COLW_KEY) || '{}') || {}; }
    catch (e) { return {}; }
  }
  function setColWidths(obj) {
    try { localStorage.setItem(COLW_KEY, JSON.stringify(obj)); } catch (e) {}
  }
  // 读取屏幕表头单元格的「真实渲染宽度」：table-layout:fixed + width:max-content 会把窄列撑到
  // 内容宽度，所以这里返回的是用户真正看到的宽度。导出用它，才能和界面显示完全一致
  // （之前直接用存储的字面窄 width，导致屏幕被撑开、导出被压碎，二者不一致）。
  function readRenderedColWidths() {
    var map = {};
    var tbl = document.getElementById('txTable');
    if (!tbl) return map;
    tbl.querySelectorAll('thead th[data-col]').forEach(function (th) {
      var i = parseInt(th.getAttribute('data-col'), 10);
      if (!isFinite(i)) return;
      var w = Math.round(th.getBoundingClientRect().width);
      if (isFinite(w) && w > 0) map[i] = w;
    });
    return map;
  }
  // 屏幕列宽（px）单一来源：优先用表头真实渲染宽度（=肉眼所见），读不到时回退到存储/默认宽度。
  // 屏幕与导出（图片/Excel/PDF）统一使用，保证导出与界面显示一致。
  function screenColPx() {
    var s = getColWidths();
    var rendered = readRenderedColWidths();
    var any = Object.keys(rendered).length > 0;
    return TX_COLS.map(function (c, i) {
      if (any && rendered[i] != null) return rendered[i];
      return s[i] != null ? s[i] : (TX_DEF_W[i] != null ? TX_DEF_W[i] : 100);
    });
  }
  // 把一组语义列 id 映射成屏幕 px 宽度（导出复用）
  function txExportColWidths(ids) {
    var px = screenColPx();
    return ids.map(function (id) { var i = TX_COL_IDS.indexOf(id); return i >= 0 ? px[i] : 100; });
  }
  // 导出图片的列 = 界面流水表（去掉「操作」列）。顺序 / 标签与界面逐一对齐，
  // 用户要求「导出的图片和界面排版一样」。作为单一来源供 exportImage 与测试复用。
  function txExportColumns() {
    return {
      ids: TX_COL_IDS.slice(0, TX_COL_IDS.length - 1),
      labels: TX_COLS.slice(0, TX_COLS.length - 1)
    };
  }
  // 拖拽下限：允许列缩到更窄，方便把"距离"压小（之前 40 → 28 → 20）
  var COL_MIN_W = 20;
  function applyColWidths() {
    var tbl = document.getElementById('txTable');
    if (!tbl) return;
    var cg = tbl.querySelector('colgroup');
    if (!cg) return;
    var s = getColWidths();
    cg.querySelectorAll('col[data-col]').forEach(function (col) {
      var k = col.getAttribute('data-col');
      if (k === 'sel') return;            // 批量模式的全选列不参与自定义
      var i = parseInt(k, 10);
      var w = s[i] != null ? s[i] : (TX_DEF_W[i] != null ? TX_DEF_W[i] : 100);
      if (w) col.style.width = w + 'px';
    });
  }
  function bindColResize() {
    var wrap = document.getElementById('txWrap');
    if (!wrap || wrap._colBound) return;
    wrap._colBound = true;
    // 双击手柄：重置该列到默认宽度（不需点"重置列宽"按钮）
    wrap.addEventListener('dblclick', function (e) {
      var rz = e.target && e.target.closest ? e.target.closest('.col-resizer') : null;
      if (!rz) return;
      e.preventDefault();
      var semantic = parseInt(rz.dataset.col, 10);
      var def = TX_DEF_W[semantic] != null ? TX_DEF_W[semantic] : 100;
      var tbl = document.getElementById('txTable');
      var col = tbl.querySelector('colgroup col[data-col="' + semantic + '"]');
      if (col) col.style.width = def + 'px';
      var w = getColWidths();
      delete w[semantic];                      // 持久化里也清掉
      if (Object.keys(w).length) setColWidths(w);
      else { try { localStorage.removeItem(COLW_KEY); } catch (e) {} }
      if (FW.toast) FW.toast('该列已恢复默认');
    });
    wrap.addEventListener('mousedown', function (e) {
      var rz = e.target && e.target.closest ? e.target.closest('.col-resizer') : null;
      if (!rz) return;
      e.preventDefault();
      var semantic = parseInt(rz.dataset.col, 10); // 语义列序号（与是否批量无关）
      var tbl = document.getElementById('txTable');
      var col = tbl.querySelector('colgroup col[data-col="' + semantic + '"]');
      if (!col) return;
      rz.classList.add('dragging');
      var startX = e.clientX;
      var startW = col.getBoundingClientRect().width;
      var curW = startW;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      function onMove(ev) {
        curW = Math.max(COL_MIN_W, startW + (ev.clientX - startX));
        col.style.width = curW + 'px';
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        rz.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        var w = getColWidths();
        w[semantic] = Math.round(curW);
        setColWidths(w);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }
  function resetColWidths() {
    try { localStorage.removeItem(COLW_KEY); } catch (e) {}
    applyColWidths();
    if (FW.toast) FW.toast('已重置列宽');
  }

  /* ---------- 统计分析（逻辑分层 + 对账校验） ---------- */
  function groupSum(rows, keyFn) {
    var map = {};
    rows.forEach(function (t) {
      if (t.type !== 'income' && t.type !== 'expense' && t.type !== 'refund') return;
      var k = keyFn(t);
      if (!map[k]) map[k] = { income: 0, expense: 0 };
      if (t.type === 'income') map[k].income += Number(t.amount);
      else if (t.type === 'expense') map[k].expense += Number(t.amount);
      else if (t.type === 'refund') map[k].expense -= Number(t.amount);
    });
    return map;
  }

  function drawStat() {
    var from = state.statFrom, to = state.statTo;
    var rowsIn = all().filter(function (t) { return inRange(t, from, to); });
    var byProj = projAgg(rowsIn);
    var byMonth = groupSum(rowsIn, function (t) { return t.date.slice(0, 7); });
    var byDay = groupSum(rowsIn, function (t) { return t.date; });
    var byCat = groupSum(rowsIn, function (t) { return t.category || '其他'; });
    var byAcc = buildAccMap(rowsIn);

    var totalIncome = rowsIn.reduce(function (a, t) { return a + (t.type === 'income' ? +t.amount : 0); }, 0);
    var totalRefund = rowsIn.reduce(function (a, t) { return a + (t.type === 'refund' ? +t.amount : 0); }, 0);
    var totalExpense = rowsIn.reduce(function (a, t) { return a + ((t.type === 'expense' ? +t.amount : 0) - (t.type === 'refund' ? +t.amount : 0)); }, 0);
    var curMonth = FW.today().slice(0, 7);
    var prev = monthSum(prevMonth(curMonth));
    function mom(cur, pv) { if (!(pv > 0)) return null; return (cur - pv) / pv * 100; }
    var incMom = mom(totalIncome, prev.inc);
    var expMom = mom(totalExpense, prev.exp);

    // 资金层（口径：截至所选区间末「累计」，与账户余额分解口径一致，保证对账恒平衡）
    var breakdown = accountBreakdown(to);                 // 截至所选期末的账户分解（累计）
    var cashTotal = breakdown.reduce(function (s, x) { return s + x.bal; }, 0);
    var openTotal = openingsTotal();
    var profitCum = netProfit('', to);                    // 累计结余（截至区间末）
    var eqNetCum = equityNet('', to);                     // 累计股本净（截至区间末）
    var balanced = Math.abs(cashTotal - (openTotal + profitCum + eqNetCum)) < 0.005;

    // 「区间」口径（用户所选窗口），仅用于上方 KPI 展示，不影响对账
    var profit = netProfit(from, to);
    var eqNet = equityNet(from, to);

    // 月度柱状图
    var months = Object.keys(byMonth).sort();
    var monthItems = months.map(function (m) { return { label: m.slice(5) + '月', value: byMonth[m].income - byMonth[m].expense }; });
    var catItems = Object.keys(byCat).map(function (k) { return { label: k, value: byCat[k].expense }; }).filter(function (x) { return x.value > 0; });
    var accItems = Object.keys(byAcc).map(function (k) { return { label: k, value: byAcc[k].income + byAcc[k].expense }; }).filter(function (x) { return x.value > 0; });

    // 各项目收支（分组柱状图数据）
    var projLabels = Object.keys(byProj).sort();
    var projSeries = [
      { name: '收入', color: '#C8102E', values: projLabels.map(function (k) { return byProj[k].income; }) },
      { name: '支出', color: '#1f9d55', values: projLabels.map(function (k) { return byProj[k].expense; }) }
    ];

    var rangeTxt = (from || to) ? ('（' + (from || '最早') + ' 至 ' + (to || '最新') + '）') : '（全部期间）';
    var html =
      '<div class="card" style="margin-bottom:14px"><div class="toolbar">' +
        '<span style="font-size:13px;color:var(--muted);align-self:center">统计时间区间：</span>' +
        '<div class="field"><input id="statFrom" type="date" value="' + FW.esc(from) + '" title="开始日期"></div>' +
        '<div class="field"><input id="statTo" type="date" value="' + FW.esc(to) + '" title="结束日期"></div>' +
        '<button class="btn ghost sm" data-range="month">本月</button>' +
        '<button class="btn ghost sm" data-range="quarter">本季</button>' +
        '<button class="btn ghost sm" data-range="year">本年</button>' +
        '<button class="btn ghost sm" id="statReset">全部</button>' +
      '</div></div>' +

      // —— 利润层 ——
      '<div class="stat-row">' +
        '<div class="stat"><div class="label">区间收入 ' + rangeTxt + '</div><div class="value income">' + FW.fmtMoney(totalIncome) + '</div></div>' +
        '<div class="stat"><div class="label">区间支出（净额）</div><div class="value expense">' + FW.fmtMoney(totalExpense) + '</div></div>' +
        '<div class="stat"><div class="label">退款收入（冲减支出）</div><div class="value refund">' + FW.fmtMoney(totalRefund) + '</div></div>' +
        '<div class="stat"><div class="label">区间结余（利润）</div><div class="value">' + FW.fmtMoney(totalIncome - totalExpense) + '</div></div>' +
        '<div class="stat"><div class="label">收入环比（上月）</div><div class="value ' + (incMom == null ? '' : (incMom >= 0 ? 'income' : 'expense')) + '">' + (incMom == null ? '—' : (incMom >= 0 ? '▲' : '▼') + Math.abs(incMom).toFixed(1) + '%') + '</div></div>' +
        '<div class="stat"><div class="label">支出环比（上月）</div><div class="value ' + (expMom == null ? '' : (expMom >= 0 ? 'income' : 'expense')) + '">' + (expMom == null ? '—' : (expMom >= 0 ? '▲' : '▼') + Math.abs(expMom).toFixed(1) + '%') + '</div></div>' +
      '</div>' +

      // —— 资金层 ——
      '<div class="stat-row">' +
        '<div class="stat"><div class="label">资金总计（各账户余额和）</div><div class="value">' + FW.fmtMoney(cashTotal) + '</div></div>' +
        '<div class="stat"><div class="label">期初余额</div><div class="value">' + FW.fmtMoney(openTotal) + '</div></div>' +
        '<div class="stat"><div class="label">区间股本净变动</div><div class="value ' + (eqNet >= 0 ? 'income' : 'expense') + '">' + FW.fmtMoney(eqNet) + '</div></div>' +
        '<div class="stat"><div class="label">区间互转净额</div><div class="value muted">0.00</div></div>' +
      '</div>' +

      // —— 对账校验 ——
      '<div class="card" style="margin-bottom:18px;' + (balanced ? 'border-color:#bfe6cd' : 'border-color:#f4d79a') + '">' +
        '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">' +
          '<span class="badge ' + (balanced ? 'done' : 'warn') + '">' + (balanced ? '✅ 对账平衡' : '⚠️ 对账不平') + '</span>' +
          '<span class="muted" style="font-size:13px">资金总计 ' + FW.fmtMoney(cashTotal) + ' ＝ 期初 ' + FW.fmtMoney(openTotal) + ' ＋ 累计结余 ' + FW.fmtMoney(profitCum) + ' ＋ 股本净 ' + FW.fmtMoney(eqNetCum) + '</span>' +
        '</div>' +
        '<div class="muted" style="font-size:12px;margin-top:8px">说明：账户互转只改变资金在各账户间的归属，不改变「资金总计」与「结余」；股本注入/抽回影响资金但不影响经营利润。</div>' +
      '</div>' +

      '<div class="chart-wrap">' +
        (months.length ? FW.lineChart('月度收支趋势（收入/支出）', [{ name: '收入', color: '#e63946', points: months.map(function (m) { return { label: m.slice(5) + '月', value: byMonth[m].income }; }) }, { name: '支出', color: '#1f9d55', points: months.map(function (m) { return { label: m.slice(5) + '月', value: byMonth[m].expense }; }) }]) : '') +
        (months.length ? FW.barChart('每月净收支（收入-支出）', monthItems, { color: '#C9A227' }) : '') +
        (catItems.length ? FW.pieChart('支出分类占比', catItems) : '') +
        (projLabels.length ? FW.groupedBarChart('各项目收支', projSeries, projLabels) : '') +
      '</div>';

    // —— 各账户余额分解表（资金层核心） ——
    var balRows = breakdown.map(function (x) {
      return '<tr>' +
        '<td>' + FW.esc(x.name) + '</td>' +
        '<td class="num">' + FW.fmtMoney(x.opening) + '</td>' +
        '<td class="num ' + (x.flow >= 0 ? 'income' : 'expense') + '">' + (x.flow >= 0 ? '+' : '') + FW.fmtMoney(x.flow) + '</td>' +
        '<td class="num ' + (x.move >= 0 ? 'income' : 'expense') + '">' + (x.move >= 0 ? '+' : '') + FW.fmtMoney(x.move) + '</td>' +
        '<td class="num"><b>' + (x.bal >= 0 ? '+' : '') + FW.fmtMoney(x.bal) + '</b></td>' +
        '</tr>';
    }).join('');
    html +=
      '<div class="card" style="margin-top:18px"><h3>各账户余额 <span class="sub">期初＋收支＋往来' + ((from || to) ? '（截至所选区间末）' : '（累计全部）') + '</span></h3>' +
        (breakdown.length ? '<table><thead><tr><th>账户</th><th class="num">期初</th><th class="num">本期收支</th><th class="num">本期往来</th><th class="num">余额</th></tr></thead><tbody>' + balRows +
          '<tr class="bold"><td>资金总计</td><td class="num">' + FW.fmtMoney(openTotal) + '</td><td class="num">' + FW.fmtMoney(profitCum) + '</td><td class="num">' + FW.fmtMoney(eqNetCum) + '</td><td class="num">' + FW.fmtMoney(cashTotal) + '</td></tr>' +
          '</tbody></table>' : '<div class="empty">暂无账户余额数据，去「流水明细」登记收入/支出/互转/股本，或在「设置期初」录入开户金额。</div>') +
      '</div>' +

      // 明细统计表（四个维度 tab）
      '<div class="card" style="margin-top:18px"><div class="tabs" id="statTabs">' +
        '<button class="tab active" data-s="proj">项目统计</button>' +
        '<button class="tab" data-s="month">每月统计</button>' +
        '<button class="tab" data-s="day">每日统计</button>' +
        '<button class="tab" data-s="catacc">分类账户统计</button>' +
      '</div><div id="statTable"></div></div>';

    document.getElementById('inBody').innerHTML = html;
    drawStatTable('proj', byProj, byMonth, byDay, byCat, byAcc);

    var g = function (id) { return document.getElementById(id); };
    g('statFrom').onchange = function () { state.statFrom = this.value; drawStat(); };
    g('statTo').onchange = function () { state.statTo = this.value; drawStat(); };
    g('statReset').onclick = function () { state.statFrom = ''; state.statTo = ''; drawStat(); };
    FW.qa('#inBody [data-range]').forEach(function (b) {
      b.onclick = function () { var r = rangeDates(b.dataset.range); state.statFrom = r.from; state.statTo = r.to; drawStat(); };
    });
    FW.qa('#statTabs .tab').forEach(function (b) {
      b.onclick = function () {
        FW.qa('#statTabs .tab').forEach(function (x) { x.classList.toggle('active', x === b); });
        drawStatTable(b.dataset.s, byProj, byMonth, byDay, byCat, byAcc);
      };
    });
  }

  // 按账户汇总（与统计 tab 一致：收入/支出/退款；refund 抵减支出；并单列账户互转净）
  // 先预置全部账户（含筛选期间无发生额的账户），保证筛选后仍能列出所有账户；发生额按流水叠加。
  function buildAccMap(rows) {
    var map = {};
    getAccounts().forEach(function (a) { map[a] = { income: 0, expense: 0, transfer: 0 }; });
    function ensure(k) { if (!map[k]) map[k] = { income: 0, expense: 0, transfer: 0 }; return map[k]; }
    rows.forEach(function (t) {
      var a = Number(t.amount) || 0;
      if (t.type === 'income') { ensure(t.account || '其他').income += a; }
      else if (t.type === 'expense') { ensure(t.account || '其他').expense += a; }
      else if (t.type === 'refund') { ensure(t.account || '其他').expense -= a; }
      else if (t.type === 'transfer') {
        if (t.fromAccount) ensure(t.fromAccount).transfer -= a;
        if (t.toAccount) ensure(t.toAccount).transfer += a;
      }
    });
    return map;
  }
  // 日期减一天（YYYY-MM-DD）
  function prevDay(d) {
    if (!d) return '';
    var dt = new Date(d + 'T00:00:00');
    dt.setDate(dt.getDate() - 1);
    return dt.getFullYear() + '-' + pad(dt.getMonth() + 1) + '-' + pad(dt.getDate());
  }
  // 取截至 upto 的扁平账户余额表：name -> bal
  function balMapAt(upto) {
    var m = {};
    accountBalances(upto).forEach(function (x) { m[x.name] = x.bal; });
    return m;
  }
  // 筛选开始前的账户余额：设了 f.from 则取截至 from 前一天；否则取期初（无任何流水前）
  function startBalanceMap(f) {
    if (f && f.from) return balMapAt(prevDay(f.from));
    var m = {};
    getOpenings().forEach(function (o) { if (o.account) m[o.account] = (m[o.account] || 0) + (Number(o.amount) || 0); });
    return m;
  }
  function statTableRows(map, fmtKey, balMaps, showTransfer) {
    var keys = Object.keys(map).sort(function (a, b) {
      return (map[b].income + map[b].expense + Math.abs(map[b].transfer || 0)) - (map[a].income + map[a].expense + Math.abs(map[a].transfer || 0));
    });
    if (!keys.length) return '<div class="empty">暂无数据</div>';
    var head = '<th>' + fmtKey + '</th>';
    if (balMaps) head += '<th class="num">区间期初</th>';
    head += '<th class="num">收入</th><th class="num">支出</th>';
    if (showTransfer) head += '<th class="num">互转</th>';
    head += '<th class="num">区间收支合计</th>';
    if (balMaps) head += '<th class="num">区间期末余额</th>';
    var trs = keys.map(function (k) {
      var v = map[k];
      // 账户分类：账户名用专属颜色区分（导出/打印/统计页一致）
      var nameCell = (fmtKey === '账户')
        ? '<td><span style="color:' + accColor(k) + ';font-weight:600">' + FW.esc(k) + '</span></td>'
        : '<td>' + FW.esc(k) + '</td>';
      var cells = nameCell;
      if (balMaps) cells += '<td class="num">' + FW.fmtMoney(balMaps.start[k] || 0) + '</td>';
      cells += '<td class="num income">' + FW.fmtMoney(v.income) + '</td><td class="num expense">' + FW.fmtMoney(v.expense) + '</td>';
      if (showTransfer) {
        var tr = v.transfer || 0;
        var trCls = tr > 0 ? 'income' : (tr < 0 ? 'expense' : '');
        cells += '<td class="num ' + trCls + '">' + FW.fmtMoney(tr) + '</td>';
      }
      cells += '<td class="num"><b>' + FW.fmtMoney(v.income - v.expense) + '</b></td>';
      if (balMaps) cells += '<td class="num"><b>' + FW.fmtMoney(balMaps.end[k] || 0) + '</b></td>';
      return '<tr>' + cells + '</tr>';
    }).join('');
    return '<table><thead><tr>' + head + '</tr></thead><tbody>' + trs + '</tbody></table>';
  }
  function drawStatTable(s, byProj, byMonth, byDay, byCat, byAcc) {
    var el = document.getElementById('statTable');
    if (s === 'proj') el.innerHTML = statTableRows(byProj, '项目');
    else if (s === 'month') el.innerHTML = statTableRows(byMonth, '月份');
    else if (s === 'day') el.innerHTML = statTableRows(byDay, '日期');
    else if (s === 'catacc') {
      el.innerHTML = '<h4 style="margin:4px 0 8px">按分类</h4>' + statTableRows(byCat, '分类') +
        '<h4 style="margin:18px 0 8px">按账户（收支维度）</h4>' + statTableRows(byAcc, '账户', null, true);
    }
  }

  // 流水明细页的「按账户（收支维度）」小表（界面版，6 列紧凑表：账户/区间期初/收入/支出/互转/区间期末余额）。
  // 与打印视图 / Excel / 图片导出口径一致（共用 buildAccMap + startBalanceMap + balMapAt），随筛选实时重算。
  // 输入：rows = 当前筛选后的流水（filteredRows 口径，含 transfer 互转数据）；f = 当前筛选（用于取开始/期末余额）。
  // 口径：区间期初 = startBalanceMap(f)[账户]（筛选开始前的账户余额，含期初/互转/股本）；
  //       区间期末余额 = balMapAt(f.to || 今天)[账户]（筛选期末的真实账户余额 = 区间期初 + 收入 − 支出 + 互转 + 股本净变动）。
  // 输出：HTML 字符串；无账户或无数据时返回 ''。
  function accSummaryHtml(rows, f) {
    if (!getAccounts().length) return '';
    var accMap = buildAccMap(rows);
    var keys = Object.keys(accMap);
    if (!keys.length) return '';
    f = f || {};
    var startBal = startBalanceMap(f);
    var endBal = balMapAt(f.to || FW.today());
    // 按「收入+支出+|互转|」降序——与 statTableRows / 导出图片副表 排序保持一致
    keys.sort(function (a, b) {
      var va = accMap[a], vb = accMap[b];
      return (vb.income + vb.expense + Math.abs(vb.transfer || 0)) - (va.income + va.expense + Math.abs(va.transfer || 0));
    });
    function trCls(n) { return n > 0 ? 'income' : (n < 0 ? 'expense' : ''); }
    function signedCls(n) { return n > 0 ? 'income' : (n < 0 ? 'expense' : ''); }
    var totalIn = 0, totalEx = 0, totalTr = 0, totalStart = 0, totalCur = 0;
    var trs = keys.map(function (k) {
      var v = accMap[k];
      var tr = v.transfer || 0;
      var s = startBal[k] || 0;
      var cur = endBal[k] || 0;
      totalIn += v.income; totalEx += v.expense; totalTr += tr; totalStart += s; totalCur += cur;
      return '<tr>' +
        '<td>' + FW.esc(k) + '</td>' +
        '<td class="num ' + signedCls(s) + '">' + FW.fmtMoney(s) + '</td>' +
        '<td class="num income">' + FW.fmtMoney(v.income) + '</td>' +
        '<td class="num expense">' + FW.fmtMoney(v.expense) + '</td>' +
        '<td class="num ' + trCls(tr) + '">' + FW.fmtMoney(tr) + '</td>' +
        '<td class="num ' + signedCls(cur) + '"><b>' + FW.fmtMoney(cur) + '</b></td>' +
        '</tr>';
    }).join('');
    trs += '<tr class="acc-sum-row">' +
      '<td>合计（' + keys.length + ' 账户）</td>' +
      '<td class="num ' + signedCls(totalStart) + '">' + FW.fmtMoney(totalStart) + '</td>' +
      '<td class="num income">' + FW.fmtMoney(totalIn) + '</td>' +
      '<td class="num expense">' + FW.fmtMoney(totalEx) + '</td>' +
      '<td class="num ' + trCls(totalTr) + '">' + FW.fmtMoney(totalTr) + '</td>' +
      '<td class="num ' + signedCls(totalCur) + '"><b>' + FW.fmtMoney(totalCur) + '</b></td>' +
      '</tr>';
    return '<div class="flow-acc-head">按账户（收支维度）</div>' +
      '<table class="flow-acc-tbl"><thead><tr><th>账户</th><th class="num">区间期初</th><th class="num">收入</th><th class="num">支出</th><th class="num">互转</th><th class="num">区间期末余额</th></tr></thead><tbody>' + trs + '</tbody></table>' +
      '<div class="flow-acc-note">区间期初 = 筛选开始前的账户余额；区间期末余额 = 区间期初 + 收入 − 支出 + 互转 + 股本净变动，即筛选期末的账户余额。互转 = 转入 − 转出（账户互转净头寸，单列不影响收支）。</div>';
  }

  /* ---------- 资金变动明细（账户互转 / 股本，不影响收支） ---------- */
  function drawFund() {
    var fType = state.fundType || '';
    var rows = all().filter(function (t) { return t.type === 'transfer' || t.type === 'equity'; });
    if (fType === 'transfer') rows = rows.filter(function (t) { return t.type === 'transfer'; });
    else if (fType === 'equity') rows = rows.filter(function (t) { return t.type === 'equity'; });

    var transfers = rows.filter(function (t) { return t.type === 'transfer'; });
    var equities = rows.filter(function (t) { return t.type === 'equity'; });
    var transferSum = transfers.reduce(function (a, t) { return a + Number(t.amount); }, 0);
    var eqIn = equities.filter(function (t) { return t.equityDir !== 'out'; }).reduce(function (a, t) { return a + Number(t.amount); }, 0);
    var eqOut = equities.filter(function (t) { return t.equityDir === 'out'; }).reduce(function (a, t) { return a + Number(t.amount); }, 0);

    var acctMap = {};
    all().forEach(function (t) {
      var amt = Number(t.amount);
      if (t.type === 'transfer') {
        if (t.fromAccount) acctMap[t.fromAccount] = (acctMap[t.fromAccount] || 0) - amt;
        if (t.toAccount) acctMap[t.toAccount] = (acctMap[t.toAccount] || 0) + amt;
      } else if (t.type === 'equity') {
        var s = t.equityDir === 'out' ? -1 : 1;
        if (t.account) acctMap[t.account] = (acctMap[t.account] || 0) + s * amt;
      }
    });
    var acctKeys = Object.keys(acctMap).filter(function (k) { return acctMap[k] !== 0; });
    var acctTrs = acctKeys.map(function (k) {
      var v = acctMap[k];
      return '<tr><td>' + FW.esc(k) + '</td><td class="num ' + (v >= 0 ? 'income' : 'expense') + '">' + (v >= 0 ? '+' : '') + FW.fmtMoney(v) + '</td></tr>';
    }).join('');

    var trs = rows.map(function (t) {
      var m = typeMeta(t);
      var detail;
      if (t.type === 'transfer') detail = FW.esc(t.fromAccount) + ' <span class="muted">→</span> ' + FW.esc(t.toAccount);
      else detail = (t.equityDir === 'out' ? '股本抽回' : '股本注入') + '（' + FW.esc(t.account) + '）';
      return '<tr>' +
        '<td class="nowrap">' + FW.esc(t.date) + '</td>' +
        '<td><span class="tag ' + m.cls + '">' + m.tag + '</span><div class="muted" style="font-size:11px">不影响收支</div></td>' +
        '<td>' + txProjectLabel(t) + '</td>' +
        '<td>' + detail + '</td>' +
        '<td class="num neutral">' + FW.fmtMoney(t.amount) + '</td>' +
        '<td>' + FW.esc(t.remark || '') + '</td>' +
        '<td class="row-actions nowrap"><button class="btn danger sm fund-del" data-id="' + t.id + '">删</button></td>' +
        '</tr>';
    }).join('');

    var html =
      '<div class="toolbar" style="margin-bottom:14px">' +
        '<div class="field"><select id="fundType">' +
          '<option value="">全部资金变动</option>' +
          '<option value="transfer">仅账户互转</option>' +
          '<option value="equity">仅股本资金</option>' +
        '</select></div>' +
        '<span class="muted" style="align-self:center">账户互转与股本资金只改变资金归属，不计入收支结余。</span>' +
      '</div>' +
      '<div class="stat-row">' +
        '<div class="stat"><div class="label">账户互转笔数</div><div class="value">' + transfers.length + '</div></div>' +
        '<div class="stat"><div class="label">账户互转金额</div><div class="value">' + FW.fmtMoney(transferSum) + '</div></div>' +
        '<div class="stat"><div class="label">股本注入</div><div class="value income">' + FW.fmtMoney(eqIn) + '</div></div>' +
        '<div class="stat"><div class="label">股本抽回</div><div class="value expense">' + FW.fmtMoney(eqOut) + '</div></div>' +
        '<div class="stat"><div class="label">股本资金净变动</div><div class="value ' + ((eqIn - eqOut) >= 0 ? 'income' : 'expense') + '">' + FW.fmtMoney(eqIn - eqOut) + '</div></div>' +
      '</div>' +
      '<div class="card" style="margin-bottom:18px"><h3>各账户资金净变动 <span class="sub">仅含互转与股本，不含收支</span></h3>' +
        (acctKeys.length ? '<table><thead><tr><th>账户</th><th class="num">净变动</th></tr></thead><tbody>' + acctTrs + '</tbody></table>' : '<div class="empty">暂无资金变动记录</div>') +
      '</div>' +
      '<div class="card"><h3>资金变动明细 <span class="sub">账户互转 / 股本资金，不影响收支</span></h3>' +
        (rows.length ? '<table><thead><tr><th>日期</th><th>类型</th><th>项目</th><th>资金流向</th><th class="num">金额</th><th>备注</th><th>操作</th></tr></thead><tbody>' + trs + '</tbody></table>' : '<div class="empty">暂无账户互转或股本资金记录。可在「流水明细」中点「新增流水」选择对应类型登记。</div>') +
      '</div>';
    document.getElementById('inBody').innerHTML = html;
    document.getElementById('fundType').value = fType;
    document.getElementById('fundType').onchange = function () { state.fundType = this.value; drawFund(); };
    FW.qa('#inBody .fund-del').forEach(function (b) { b.onclick = function () { delTx(b.dataset.id); }; });
  }

  /* ---------- 期初余额录入 ---------- */
  function openOpenings() {
    var cur = getOpenings();
    function find(acc) { for (var i = 0; i < cur.length; i++) if (cur[i].account === acc) return cur[i]; return null; }
    var rows = ACCTS.map(function (acc) {
      var o = find(acc);
      return '<div class="open-row"><span class="open-name">' + FW.esc(acc) + '</span>' +
        '<input class="open-amt" type="number" step="0.01" data-acc="' + FW.esc(acc) + '" value="' + (o ? o.amount : '') + '" placeholder="0"></div>';
    }).join('');
    var total = cur.reduce(function (s, o) { return s + (Number(o.amount) || 0); }, 0);
    var body =
      '<div class="muted" style="font-size:12px;margin-bottom:8px">录入每个账户在「记账开始前」已有的金额（如开户时银行卡里的钱）。这将作为账户余额的起点，使余额与银行实际一致。留空表示 0。可填负数表示透支/欠款。</div>' +
      '<div class="open-list">' + rows + '</div>' +
      '<div class="muted" style="font-size:12px;margin:10px 0 6px">期初余额合计：<b id="openSum">' + FW.fmtMoney(total) + '</b></div>' +
      '<div class="form-actions"><button class="btn ghost" id="openCancel">取消</button><button class="btn" id="openSave">保存期初</button></div>';
    FW.openModal('设置期初余额', body, function () {
      var inputs = FW.qa('#modalBody .open-amt');
      function recalc() {
        var s = 0;
        inputs.forEach(function (inp) { var v = parseFloat(inp.value); if (!isNaN(v)) s += v; });
        var el = document.getElementById('openSum'); if (el) el.textContent = FW.fmtMoney(s);
      }
      inputs.forEach(function (inp) { inp.oninput = recalc; });
      document.getElementById('openCancel').onclick = FW.closeModal;
      document.getElementById('openSave').onclick = function () {
        var arr = [];
        inputs.forEach(function (inp) {
          var v = parseFloat(inp.value);
          if (!isNaN(v) && v !== 0) arr.push({ account: inp.dataset.acc, amount: v });
        });
        saveOpenings(arr);
        FW.closeModal(); render(); FW.toast('期初余额已保存（合计 ' + FW.fmtMoney(arr.reduce(function (s, o) { return s + o.amount; }, 0)) + '）');
      };
    });
  }

  /* ---------- 账户管理（自定义增删改排序） ---------- */
  function openAccManager() {
    // 账户树 + 稳定 id（用于改名时按 id 映射历史流水，避免删除导致的下标错位）
    var _idc = 0;
    function withIds(t) {
      return t.map(function (p) {
        return { id: 'p' + (_idc++), name: p.name, children: (p.children || []).map(function (c) { return { id: 'c' + (_idc++), name: c }; }) };
      });
    }
    var tree = withIds(getAccountTree());
    var oldTree = JSON.parse(JSON.stringify(tree));

    function renderList() {
      return tree.map(function (p, i) {
        var subs = (p.children || []).map(function (c, j) {
          return '<div class="acc-sub-row">' +
            '<input class="acc-mgr-cname" data-pi="' + i + '" data-ci="' + j + '" value="' + FW.esc(c.name) + '" placeholder="二级账户名">' +
            '<button class="btn ghost acc-sub-del" data-pi="' + i + '" data-ci="' + j + '" title="删除二级">✕</button>' +
            '</div>';
        }).join('');
        return '<div class="acc-mgr-prim" data-pi="' + i + '">' +
          '<div class="acc-mgr-prow">' +
            '<span class="acc-mgr-handle" title="拖拽排序">☰</span>' +
            '<input class="acc-mgr-pname" data-pi="' + i + '" value="' + FW.esc(p.name) + '" placeholder="一级账户名称">' +
            '<button class="btn ghost acc-sub-add" data-pi="' + i + '" title="添加二级账户">＋ 二级</button>' +
            '<button class="btn ghost acc-mgr-pdel" data-pi="' + i + '" title="删除该账户"' + (tree.length <= 1 ? ' disabled style="opacity:.4;cursor:not-allowed"' : '') + '>✕</button>' +
          '</div>' +
          '<div class="acc-mgr-children">' + subs + '</div>' +
        '</div>';
      }).join('');
    }
    function renderBody() {
      return '<div class="muted" style="font-size:12px;margin-bottom:10px">支持「一级 / 二级」账户（如 银行卡 / 工商、招商）。记账、期初、筛选、余额看板都会按层级展示。改名时可选择同步更新历史流水（默认保留旧名）。至少保留 1 个一级账户。</div>' +
        '<button class="btn ghost" id="accMgrClean" style="margin-bottom:12px">🔧 清理游离账户</button>' +
        '<div id="accMgrList">' + renderList() + '</div>' +
        '<button class="btn ghost" id="accMgrAdd">＋ 添加一级账户</button>' +
        '<div class="form-actions" style="margin-top:12px"><button class="btn ghost" id="accMgrCancel">取消</button><button class="btn" id="accMgrSave">保存</button></div>';
    }
    FW.openModal('账户管理', renderBody(), function () {
      function rebind() {
        document.getElementById('accMgrList').innerHTML = renderList();
        FW.qa('.acc-mgr-pname').forEach(function (inp) {
          inp.oninput = function () { tree[+this.dataset.pi].name = this.value; };
        });
        FW.qa('.acc-mgr-cname').forEach(function (inp) {
          inp.oninput = function () { tree[+this.dataset.pi].children[+this.dataset.ci].name = this.value; };
        });
        FW.qa('.acc-sub-add').forEach(function (btn) {
          btn.onclick = function () { tree[+this.dataset.pi].children.push({ id: 'c' + (_idc++), name: '' }); rebind(); };
        });
        FW.qa('.acc-sub-del').forEach(function (btn) {
          btn.onclick = function () { var i = +this.dataset.pi, j = +this.dataset.ci; tree[i].children.splice(j, 1); rebind(); };
        });
        FW.qa('.acc-mgr-pdel').forEach(function (btn) {
          btn.onclick = function () {
            if (tree.length <= 1) { FW.toast('至少保留一个一级账户'); return; }
            tree.splice(+this.dataset.pi, 1); rebind();
          };
        });
      }
      document.getElementById('accMgrAdd').onclick = function () {
        tree.push({ id: 'p' + (_idc++), name: '新账户' + (tree.length + 1), children: [] });
        rebind();
      };
      document.getElementById('accMgrCancel').onclick = FW.closeModal;
      document.getElementById('accMgrClean').onclick = function () { FW.closeModal(); openAccCleanup(); };
      document.getElementById('accMgrSave').onclick = function () {
        // 清洗：去空、去重（一级 + 二级）
        var clean = tree.filter(function (p) { return (p.name || '').trim(); }).map(function (p) {
          return { name: p.name.trim(), children: (p.children || []).map(function (c) { return (c.name || '').trim(); }).filter(Boolean) };
        });
        var seenP = {};
        clean = clean.filter(function (p) { if (seenP[p.name]) return false; seenP[p.name] = true; return true; });
        clean.forEach(function (p) { var s = {}; p.children = p.children.filter(function (c) { if (s[c]) return false; s[c] = true; return true; }); });
        if (!clean.length) { FW.toast('至少需要一个账户'); return; }

        // 改名映射：按 id 比对 old/new 全名（一级改名会带动二级前缀）
        var oById = {}, nById = {};
        oldTree.forEach(function (p) { oById[p.id] = p; });
        tree.forEach(function (p) { nById[p.id] = p; });
        var renames = [];
        Object.keys(nById).forEach(function (id) {
          var np = nById[id], op = oById[id];
          if (!op) return;
          if (np.name !== op.name && np.name.trim()) renames.push({ old: op.name, new: np.name.trim() });
          var oc = {}, nc = {};
          (op.children || []).forEach(function (c) { oc[c.id] = c; });
          (np.children || []).forEach(function (c) { nc[c.id] = c; });
          Object.keys(nc).forEach(function (cid) {
            var nch = nc[cid], och = oc[cid];
            if (!och || !nch.name.trim()) return;
            var ofn = op.name + SEP + och.name, nfn = np.name.trim() + SEP + nch.name.trim();
            if (ofn !== nfn) renames.push({ old: ofn, new: nfn });
          });
        });

        var map = {}; renames.forEach(function (r) { map[r.old] = r.new; });
        var affected = 0;
        if (renames.length) {
          FW.db.getList(KEY).forEach(function (t) {
            renames.forEach(function (r) {
              if (t.account === r.old || t.fromAccount === r.old || t.toAccount === r.old) affected++;
            });
          });
        }

        var sync = false;
        if (affected > 0 && confirm('以下账户已改名：\n' + renames.map(function (r) { return '· ' + r.old + ' → ' + r.new; }).join('\n') +
          '\n\n是否同步更新 ' + affected + ' 条历史流水中的账户名？\n（取消则保留历史记录中的旧名称）')) {
          sync = true;
          var txns = FW.db.getList(KEY);
          renames.forEach(function (r) {
            txns.forEach(function (t) {
              if (t.account === r.old) t.account = r.new;
              if (t.fromAccount === r.old) t.fromAccount = r.new;
              if (t.toAccount === r.old) t.toAccount = r.new;
              if (t.type === 'transfer') t.account = (t.fromAccount || '') + ' → ' + (t.toAccount || '');
            });
          });
          FW.db.saveList(KEY, txns);
          var ops = getOpenings();
          renames.forEach(function (r) { ops.forEach(function (o) { if (o.account === r.old) o.account = r.new; }); });
          saveOpenings(ops);
        }

        saveAccounts(clean);
        refreshAccts();
        FW.closeModal(); render();
        FW.toast('已更新 ' + clean.length + ' 个一级账户' + (sync ? '，并同步 ' + affected + ' 条历史' : ''));
      };
      rebind();
    });
  }

  /* ---------- 分类 / 账户 辅助 ---------- */
  // 两级账户下拉：一级作为 optgroup，二级作为选项；一级自身也可直接选中（汇总）
  function accOptsHtml(sel) {
    var tree = getAccountTree();
    return tree.map(function (a) {
      if (a.children && a.children.length) {
        var opts = '<option value="' + FW.esc(a.name) + '"' + (a.name === sel ? ' selected' : '') + '>' + FW.esc(a.name) + '（汇总）</option>';
        opts += a.children.map(function (c) {
          var fn = a.name + SEP + c;
          return '<option value="' + FW.esc(fn) + '"' + (fn === sel ? ' selected' : '') + '>' + FW.esc(c) + '</option>';
        }).join('');
        return '<optgroup label="' + FW.esc(a.name) + '">' + opts + '</optgroup>';
      }
      return '<option value="' + FW.esc(a.name) + '"' + (a.name === sel ? ' selected' : '') + '>' + FW.esc(a.name) + '</option>';
    }).join('');
  }
  function accOpts(sel) { return accOptsHtml(sel); }
  function accOptsAll(sel) { return '<option value="">全部账户</option>' + accOptsHtml(sel); }
  // 游离账户扫描：流水/期初引用、但不在账户树中的名字（改名未同步历史时产生）
  function scanOrphanAccounts() {
    var tree = getAccountTree(), defined = {};
    tree.forEach(function (a) {
      defined[a.name] = true;
      (a.children || []).forEach(function (c) { defined[a.name + SEP + c] = true; });
    });
    var counts = {};
    function bump(n) { if (n) counts[n] = (counts[n] || 0) + 1; }
    FW.db.getList(KEY).forEach(function (t) {
      if (t.type === 'transfer') { bump(t.fromAccount); bump(t.toAccount); } else bump(t.account);
    });
    getOpenings().forEach(function (o) { bump(o.account); });
    var orphans = [];
    Object.keys(counts).forEach(function (fn) { if (!defined[fn]) orphans.push({ name: fn, count: counts[fn] }); });
    return orphans;
  }
  // 把某账户的全部引用改名到新账户（流水 + 期初，含转账互转）
  function mergeAccount(oldName, newName) {
    var txns = FW.db.getList(KEY);
    txns.forEach(function (t) {
      if (t.account === oldName) t.account = newName;
      if (t.type === 'transfer') {
        if (t.fromAccount === oldName) t.fromAccount = newName;
        if (t.toAccount === oldName) t.toAccount = newName;
        t.account = (t.fromAccount || '') + ' → ' + (t.toAccount || '');
      }
    });
    FW.db.saveList(KEY, txns);
    var ops = getOpenings();
    ops.forEach(function (o) { if (o.account === oldName) o.account = newName; });
    saveOpenings(ops);
    refreshAccts();
  }
  function openAccCleanup() {
    var orphans = scanOrphanAccounts();
    function optsHtml() {
      var tree = getAccountTree(), hs = '<option value="">选择目标账户…</option>';
      tree.forEach(function (a) {
        hs += '<option value="' + FW.esc(a.name) + '">' + FW.esc(a.name) + '（汇总）</option>';
        (a.children || []).forEach(function (c) {
          var fn = a.name + SEP + c;
          hs += '<option value="' + FW.esc(fn) + '">　' + FW.esc(c) + '</option>';
        });
      });
      return hs;
    }
    function renderBody() {
      if (!orphans.length) return '<div class="empty">没有发现游离账户，所有流水/期初引用的账户都在账户列表内，无需清理。</div><div class="form-actions"><button class="btn ghost" id="accCleanClose">关闭</button></div>';
      var rows = orphans.map(function (o) {
        return '<div class="acc-clean-row" data-name="' + FW.esc(o.name) + '">' +
          '<div class="acc-clean-info"><b>' + FW.esc(o.name) + '</b> <span class="muted">（' + o.count + ' 条引用）</span></div>' +
          '<div class="acc-clean-act"><select class="acc-clean-target">' + optsHtml() + '</select><button class="btn ghost acc-clean-do">合并</button></div>' +
          '</div>';
      }).join('');
      return '<div class="muted" style="font-size:12px;margin-bottom:10px">这些是流水/期初里引用、但已不在账户列表中的「游离账户」。选一个目标账户后点「合并」，即可把它们的引用统一改名，余额与统计会自动归位。</div>' + rows + '<div class="form-actions"><button class="btn ghost" id="accCleanClose">关闭</button></div>';
    }
    FW.openModal('清理游离账户', renderBody(), function () {
      var cb = document.getElementById('accCleanClose'); if (cb) cb.onclick = FW.closeModal;
      FW.qa('.acc-clean-do').forEach(function (btn) {
        btn.onclick = function () {
          var row = btn.closest('.acc-clean-row');
          var oldName = row.getAttribute('data-name');
          var target = row.querySelector('.acc-clean-target').value;
          if (!target) { FW.toast('请先选择目标账户'); return; }
          mergeAccount(oldName, target);
          row.remove();
          FW.toast('已将「' + oldName + '」合并到「' + target + '」');
          if (!document.querySelector('.acc-clean-row')) { var b = document.getElementById('modalBody'); if (b) b.innerHTML = '<div class="empty">已全部清理完成。</div>'; }
        };
      });
    });
  }
  function cat1Opts(sel) {
    return '<option value="">（不选）</option>' + cats().map(function (c) { return '<option ' + (c.name === sel ? 'selected' : '') + '>' + FW.esc(c.name) + '</option>'; }).join('');
  }
  function cat2Opts(c1, sel) {
    var c = null; cats().forEach(function (x) { if (x.name === c1) c = x; });
    var kids = c ? (c.children || []) : [];
    return '<option value="">（无二级）</option>' + kids.map(function (k) { return '<option ' + (k === sel ? 'selected' : '') + '>' + FW.esc(k) + '</option>'; }).join('');
  }
  // 筛选区用的二级分类下拉：依赖已选的一级分类
  function cat2OptsForFilter(c1, sel) {
    if (!c1) return '<option value="">（先选一级）</option>';
    var c = null; cats().forEach(function (x) { if (x.name === c1) c = x; });
    var kids = c ? (c.children || []) : [];
    return '<option value="">全部二级</option>' + kids.map(function (k) { return '<option' + (k === sel ? ' selected' : '') + '>' + FW.esc(k) + '</option>'; }).join('');
  }
  var ssDocClickBound = false;
  function makeSearchableSelect(selId) {
    var sel = document.getElementById(selId);
    if (!sel) return;
    var wrapper = null, p = sel.parentNode;
    while (p) { if (p.classList && p.classList.contains('search-select')) { wrapper = p; break; } p = p.parentNode; }
    if (wrapper) { wrapper.parentNode.insertBefore(sel, wrapper); wrapper.parentNode.removeChild(wrapper); }
    wrapper = document.createElement('div');
    wrapper.className = 'search-select';
    sel.parentNode.insertBefore(wrapper, sel);
    wrapper.appendChild(sel);
    sel.style.display = 'none';
    var inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'ss-input';
    inp.placeholder = '搜索分类...';
    inp.autocomplete = 'off';
    wrapper.appendChild(inp);
    var dd = document.createElement('div');
    dd.className = 'ss-dropdown';
    wrapper.appendChild(dd);
    var options = [], active = -1;
    function escHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
    function build(q) {
      q = String(q || '').toLowerCase().trim();
      options = [];
      for (var i = 0; i < sel.options.length; i++) {
        var o = sel.options[i];
        if (q && o.textContent.toLowerCase().indexOf(q) < 0) continue;
        options.push({ el: o, text: o.textContent, value: o.value });
      }
      if (options.length === 0) { dd.innerHTML = '<div class="ss-no">无匹配</div>'; return; }
      dd.innerHTML = options.map(function (o, idx) {
        var t = escHtml(o.text);
        if (q) {
          var pos = o.text.toLowerCase().indexOf(q);
          if (pos >= 0) t = escHtml(o.text.slice(0, pos)) + '<mark>' + escHtml(o.text.slice(pos, pos + q.length)) + '</mark>' + escHtml(o.text.slice(pos + q.length));
        }
        return '<div class="ss-option" data-i="' + idx + '">' + t + '</div>';
      }).join('');
    }
    function syncInp() { var o = sel.options[sel.selectedIndex]; inp.value = o ? o.textContent : ''; }
    function open() { build(''); dd.style.display = 'block'; active = -1; }
    function close() { dd.style.display = 'none'; active = -1; syncInp(); }
    function pick(idx) {
      if (idx < 0 || idx >= options.length) return;
      sel.value = options[idx].value;
      close();
      var ev = document.createEvent('HTMLEvents');
      ev.initEvent('change', true, false);
      sel.dispatchEvent(ev);
    }
    function updateActive() {
      var list = dd.querySelectorAll('.ss-option');
      for (var i = 0; i < list.length; i++) list[i].classList.toggle('active', i === active);
      var a = dd.querySelector('.ss-option.active');
      if (a) a.scrollIntoView({ block: 'nearest' });
    }
    inp.onfocus = open;
    inp.oninput = function () { build(this.value); dd.style.display = 'block'; active = -1; };
    inp.onkeydown = function (e) {
      if (!dd.style.display || dd.style.display === 'none') open();
      if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, options.length - 1); updateActive(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, -1); updateActive(); }
      else if (e.key === 'Enter') { e.preventDefault(); if (active >= 0) pick(active); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); inp.blur(); }
    };
    dd.onclick = function (e) {
      var n = e.target;
      while (n && n !== dd && !n.classList.contains('ss-option')) n = n.parentNode;
      if (!n) return;
      var i = +n.getAttribute('data-i');
      if (!isNaN(i)) pick(i);
    };
    if (!ssDocClickBound) {
      document.addEventListener('click', function (e) { if (!wrapper.contains(e.target)) close(); }, true);
      ssDocClickBound = true;
    }
    syncInp(); build(''); close();
  }
  function renderDyn(type, v) {
    var el = document.getElementById('dynArea');
    if (type === 'transfer') {
      el.innerHTML =
        '<div class="tx-title">账户互转</div>' +
        '<div class="form-grid">' +
          '<div class="field"><label>源账户</label><select id="f_from">' + accOpts(v.fromAccount) + '</select></div>' +
          '<div class="field"><label>目标账户</label><select id="f_to">' + accOpts(v.toAccount) + '</select></div>' +
        '</div>';
    } else if (type === 'equity') {
      el.innerHTML =
        '<div class="tx-title">股本资金</div>' +
        '<div class="form-grid">' +
          '<div class="field"><label>方向</label><select id="f_edir"><option value="in" ' + (v.equityDir !== 'out' ? 'selected' : '') + '>股本注入（增加）</option><option value="out" ' + (v.equityDir === 'out' ? 'selected' : '') + '>股本抽回（减少）</option></select></div>' +
          '<div class="field"><label>账户</label><select id="f_account">' + accOpts(v.account) + '</select></div>' +
        '</div>';
    } else if (type === 'dividend') {
      el.innerHTML =
        '<div class="tx-title">股东分红</div>' +
        '<div class="muted" style="font-size:12px;margin-bottom:8px">股东分红属于利润分配，<b>不计入经营收支</b>，仅减少账户余额（资金流出）。</div>' +
        '<div class="form-grid">' +
          '<div class="field"><label>转出账户</label><select id="f_account">' + accOpts(v.account) + '</select></div>' +
        '</div>';
    } else {
      var c1 = v.cat1 || '', c2 = v.cat2 || '';
      var deductField = '';
      if (type === 'income') {
        var feeP = (v.feePermille != null && v.feePermille !== '') ? v.feePermille : '';
        var feeN = v.feeName || '服务费';
        deductField = '<div class="field full"><label>已扣服务费（反推毛收入，按收入占比分摊到各项目成本）</label>' +
          '<div class="form-grid" style="margin-top:6px">' +
            '<div class="field"><label>费率（‰）</label><input id="f_fee_permille" type="number" step="0.1" min="0" value="' + FW.esc(feeP) + '" placeholder="如 6 表示千分之六"></div>' +
            '<div class="field"><label>费用名称</label><input id="f_fee_name" type="text" value="' + FW.esc(feeN) + '" placeholder="如 快递代收服务费"></div>' +
          '</div>' +
          '<div id="feePreview" class="muted" style="font-size:12px;margin-top:6px"></div>' +
          '<div class="muted" style="font-size:12px;margin-top:4px">填写费率后：服务费 = 本笔金额 × 费率 ÷ (1 − 费率)（按毛收入口径反推）；实际收入 = 本笔金额 + 服务费。多项目分摊时，服务费按各项目收入占比自动分摊，并作为独立成本分类「<b>' + FW.esc(feeN) + '</b>」计入对应项目。</div></div>';
      }
      el.innerHTML =
        '<div class="tx-title">核算维度</div>' +
        '<div class="form-grid">' +
          '<div class="field"><label>分类（一级）</label><select id="f_cat1">' + cat1Opts(c1) + '</select></div>' +
          '<div class="field"><label>分类（二级）</label><select id="f_cat2">' + cat2Opts(c1, c2) + '</select> <a href="#" id="mgCats" style="font-size:12px;color:var(--primary);align-self:center">管理分类</a> <a href="#" id="mgRules" style="font-size:12px;color:var(--primary);align-self:center">匹配规则</a></div>' +
          '<div class="field full"><span id="catHint" class="cat-hint"></span></div>' +
          '<div class="field"><label>账户</label><select id="f_account">' + accOpts(v.account) + '</select></div>' +
          deductField +
        '</div>' +
        allocBoxHtml();
      var c1sel = document.getElementById('f_cat1');
      if (c1sel) c1sel.onchange = function () { catAutoTouched = true; document.getElementById('f_cat2').innerHTML = cat2Opts(this.value, ''); clearCatHint(); makeSearchableSelect('f_cat2'); };
      var c2sel = document.getElementById('f_cat2');
      if (c2sel) c2sel.onchange = function () { catAutoTouched = true; clearCatHint(); };
      makeSearchableSelect('f_cat1');
      makeSearchableSelect('f_cat2');
      var mg = document.getElementById('mgCats');
      if (mg) mg.onclick = function (e) { e.preventDefault(); openCatManager(); };
      var mgr = document.getElementById('mgRules');
      if (mgr) mgr.onclick = function (e) { e.preventDefault(); openCatMatchManager(); };
      if (type === 'income' || type === 'expense' || type === 'refund') bindAllocBox();
      if (type === 'income') {
        function updateFeePreview() {
          var amtEl = document.getElementById('f_amount');
          var perEl = document.getElementById('f_fee_permille');
          var prev = document.getElementById('feePreview');
          if (!amtEl || !perEl || !prev) return;
          var amt = parseFloat(amtEl.value) || 0;
          var per = parseFloat(perEl.value);
          if (!(per > 0)) { prev.innerHTML = '未填费率：不自动计算服务费。'; prev.className = 'muted'; return; }
          var r = per / 1000;
          var deduct = amt * r / (1 - r);
          var gross = amt + deduct;
          prev.innerHTML = '费率 ' + per + '‰（' + (r * 100).toFixed(3) + '%）｜ 服务费 <b>' + FW.fmtMoney(deduct) + '</b> ｜ 实际收入（毛） <b>' + FW.fmtMoney(gross) + '</b>';
          prev.className = 'muted';
        }
        var perEl2 = document.getElementById('f_fee_permille');
        if (perEl2) perEl2.oninput = updateFeePreview;
        var amtEl2 = document.getElementById('f_amount');
        if (amtEl2) amtEl2.addEventListener('input', updateFeePreview);
        updateFeePreview();
      }
    }
  }

  /* ===================== 批量导入（微信账单 / 表格） ===================== */
  var impPreviewState = null;
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
      var text;
      try {
        if (enc === 'utf8') text = (window.iconv ? window.iconv.decode(buf, 'utf-8') : new TextDecoder('utf-8').decode(buf));
        else if (enc === 'gbk') text = (window.iconv ? window.iconv.decode(buf, 'gbk') : new TextDecoder('gbk').decode(buf));
        else {
          var u = (window.iconv ? window.iconv.decode(buf, 'utf-8') : new TextDecoder('utf-8').decode(buf));
          text = ((u.match(/�/g) || []).length === 0) ? u : (window.iconv ? window.iconv.decode(buf, 'gbk') : new TextDecoder('gbk').decode(buf));
        }
      } catch (e) { text = ''; }
      cb(text.replace(/^﻿/, ''));
    };
    r.onerror = function () { cb(''); };
    r.readAsArrayBuffer(file);
  }
  function parseWeChatBill(text) {
    var lines = text.split(/\r?\n/);
    var headerIdx = -1, header = null;
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].indexOf('交易时间') > -1 && lines[i].indexOf('收/支') > -1) { headerIdx = i; header = csvSplit(lines[i]); break; }
    }
    if (headerIdx < 0) return { ok: false, msg: '未识别到微信账单表头，请确认导出的是「用于个人对账」的 CSV 文件。', rows: [], skipped: 0 };
    function col(name) { for (var k = 0; k < header.length; k++) if (header[k].indexOf(name) > -1) return k; return -1; }
    var cTime = col('交易时间'), cParty = col('交易对方'), cGoods = col('商品'),
        cInout = col('收/支'), cAmt = col('金额'), cPay = col('支付方式'), cStatus = col('当前状态'), cNote = col('备注');
    var rows = [], skipped = 0;
    for (var j = headerIdx + 1; j < lines.length; j++) {
      var ln = lines[j].trim();
      if (!ln) continue;
      var f = csvSplit(ln);
      var inout = (f[cInout] || '').trim();
      var status = (f[cStatus] || '').trim();
      if (inout === '不计收支') { skipped++; continue; }
      var isRefund = /退还|退款/.test(status);
      // 退款：未收到的跳过；已收到的记为「退款收入」（冲减支出，不计入总收入）
      if (isRefund) {
        if (/已收钱|已转账/.test(status)) {
          var ramt = parseFloat((f[cAmt] || '').replace(/[￥¥\s,]/g, ''));
          if (isNaN(ramt)) { skipped++; continue; }
          ramt = Math.abs(ramt);
          var rdt = (f[cTime] || '').slice(0, 10);
          var rparty = (f[cParty] || '').trim();
          var rgoods = (f[cGoods] || '').trim();
          var rnote = (f[cNote] || '').trim();
          var rremark = rgoods + (rnote ? (rgoods ? ' · ' : '') + rnote : '');
          var rpay = (f[cPay] || '').trim();
          var raccount = /银行卡|信用卡/.test(rpay) ? '银行卡' : '微信';
          rows.push({ date: rdt, type: 'refund', amount: ramt, project: '', party: rparty, remark: rremark, account: raccount, _status: status, _inout: inout });
          continue;
        }
        skipped++; continue;
      }
      if (inout !== '收入' && inout !== '支出') { skipped++; continue; }
      var amt = parseFloat((f[cAmt] || '').replace(/[￥¥\s,]/g, ''));
      if (isNaN(amt)) { skipped++; continue; }
      // 微信 Excel 账单中支出金额可能以负数存储（金额反映资金流向），统一取绝对值，
      // 方向完全由「收/支」列决定，避免负数导致汇总时支出被抵消 / 收入支出颠倒。
      amt = Math.abs(amt);
      var dt = (f[cTime] || '').slice(0, 10);
      var party = (f[cParty] || '').trim();
      var goods = (f[cGoods] || '').trim();
      var note = (f[cNote] || '').trim();
      var remark = goods + (note ? (goods ? ' · ' : '') + note : '');
      var pay = (f[cPay] || '').trim();
      var account = /银行卡|信用卡/.test(pay) ? '银行卡' : '微信';
      rows.push({ date: dt, type: inout === '收入' ? 'income' : 'expense', amount: amt, project: '', party: party, remark: remark, account: account, _status: status, _inout: inout });
    }
    return { ok: true, rows: rows, skipped: skipped };
  }
  function guessMap(headers) {
    function find(words) {
      for (var i = 0; i < headers.length; i++) {
        var h = (headers[i] || '').toLowerCase().replace(/\s+/g, '');
        for (var w = 0; w < words.length; w++) if (h.indexOf(words[w]) > -1) return i;
      }
      return -1;
    }
    var dateCol = find(['日期', '时间', 'date', '交易日', '记账日', '凭证日', '交易日期']);
    var amountCol = find(['金额', '钱', 'amount', '数额', '发生额', '交易金额', '收支金额', '金额元', '金额(元)', 'price']);
    var typeCol = find(['收/支', '收支', '类型', '方向', 'type', '借贷', '借/贷', '收付款', '收/付', '收付', '进出', 'debit', 'credit']);
    var partyCol = find(['对方', '商户', '姓名', '客户', '名称', '付款方', '收款方', '交易对手', '对手', '户名', '收款人', '付款人', '往来单位', '对方户名', 'counterparty']);
    var remarkCol = find(['备注', '摘要', '说明', '用途', '商品', '描述', '附言', '事由', '交易摘要', '备注说明', '摘要信息', 'memo', 'note', 'remark', 'desc', '摘要说明']);
    return { hasHeader: true, dateCol: dateCol < 0 ? 0 : dateCol, amountCol: amountCol < 0 ? 1 : amountCol, typeCol: typeCol, partyCol: partyCol, remarkCol: remarkCol, signMode: typeCol < 0 ? 'neg' : 'col' };
  }
  function parseRowsCore(rowsArr, map) {
    var startRow = map.hasHeader ? 1 : 0;
    var rows = [], skipped = 0;
    function normDate(s) {
      s = (s == null ? '' : String(s)).trim();
      if (!s) return '';
      if (/^\d{5}$/.test(s)) {
        var base = Date.UTC(1899, 11, 30);
        var dd = new Date(base + (parseInt(s, 10)) * 86400000);
        var yy = dd.getUTCFullYear(), mm = dd.getUTCMonth() + 1, d3 = dd.getUTCDate();
        return yy + '-' + (mm < 10 ? '0' + mm : mm) + '-' + (d3 < 10 ? '0' + d3 : d3);
      }
      var datePart = s.split(/[ T]/)[0];
      var m1 = datePart.match(/^(\d{4})[年\-\/\.](\d{1,2})[月\-\/\.](\d{1,2})/);
      if (m1) { var y1 = +m1[1], mo1 = +m1[2], d1 = +m1[3]; return y1 + '-' + (mo1 < 10 ? '0' + mo1 : mo1) + '-' + (d1 < 10 ? '0' + d1 : d1); }
      var m2 = datePart.match(/^(\d{1,2})[年\-\/\.](\d{1,2})[年\-\/\.](\d{4})/);
      if (m2) { var mo2 = +m2[1], d2 = +m2[2], y2 = +m2[3]; if (mo2 >= 1 && mo2 <= 12 && d2 >= 1 && d2 <= 31) return y2 + '-' + (mo2 < 10 ? '0' + mo2 : mo2) + '-' + (d2 < 10 ? '0' + d2 : d2); }
      var m3 = datePart.match(/^(\d{4})(\d{2})(\d{2})$/);
      if (m3) return m3[1] + '-' + m3[2] + '-' + m3[3];
      return '';
    }
    function halfWidth(s) {
      return (s == null ? '' : String(s)).replace(/[０-９Ａ-Ｚａ-ｚ．，：；！？（）　]/g, function (c) {
        var code = c.charCodeAt(0);
        if (code >= 0xFF01 && code <= 0xFF5E) return String.fromCharCode(code - 0xFEE0);
        if (code === 0x3000) return ' ';
        return c;
      });
    }
    for (var j = startRow; j < rowsArr.length; j++) {
      var f = (rowsArr[j] || []).map(function (x) { return x == null ? '' : String(x); });
      var rawAmt = halfWidth((f[map.amountCol] || '').toString());
      var negAmt = false;
      var rawTrim = rawAmt.replace(/\s/g, '');
      if (/^[\(].*[\)]$/.test(rawTrim)) { negAmt = true; rawAmt = rawAmt.replace(/[\(\)\s]/g, ''); }
      var amt = parseFloat(rawAmt.replace(/[￥¥,\s]/g, ''));
      if (isNaN(amt)) { skipped++; continue; }
      if (negAmt) amt = -amt;
      var type = 'expense';
      if (map.signMode === 'neg') { type = amt < 0 ? 'expense' : 'income'; if (amt < 0) amt = -amt; }
      else {
        var tv = (map.typeCol > -1 ? (f[map.typeCol] || '') : '').trim();
        if (/收|入|贷/.test(tv) && !/支|出/.test(tv)) type = 'income';
        else if (/支|出|付|借/.test(tv)) type = 'expense';
        else type = amt < 0 ? 'expense' : 'income';
        if (amt < 0) amt = -amt;
      }
      var dt = normDate(f[map.dateCol]);
      if (!dt) { skipped++; continue; }
      rows.push({ date: dt, type: type, amount: amt, project: '', party: (map.partyCol > -1 ? (f[map.partyCol] || '').trim() : ''), remark: (map.remarkCol > -1 ? (f[map.remarkCol] || '').trim() : ''), account: '微信', _raw: f });
    }
    return { ok: true, rows: rows, skipped: skipped };
  }
  function parseGenericCsv(text, map) {
    var lines = text.split(/\r?\n/).filter(function (l) { return l.trim(); });
    var rowsArr = lines.map(function (l) { return csvSplit(l); });
    return parseRowsCore(rowsArr, map);
  }
  function doImportRows(rows) {
    var n = 0;
    rows.forEach(function (r) {
      var rec = {
        id: FW.db.uid('t_'), date: r.date, type: r.type, project: r.project || '', party: r.party || '',
        amount: Number(r.amount), remark: r.remark || '', photos: [],
        category: '', account: r.account || '微信', fromAccount: '', toAccount: '', equityDir: 'in'
      };
      FW.db.upsert(KEY, rec); n++;
    });
    return n;
  }
  function openImportPreview(rows, skipped, mode) {
    impPreviewState = { rows: rows, chosen: rows.map(function () { return true; }) };
    var s = impPreviewState;
    function renderPreview() {
      var trs = s.rows.map(function (r, i) {
        var cls = r.type === 'income' ? 'income' : (r.type === 'refund' ? 'refund' : 'expense');
        return '<tr>' +
          '<td><input type="checkbox" class="pc" data-i="' + i + '" ' + (s.chosen[i] ? 'checked' : '') + '></td>' +
          '<td>' + FW.esc(r.date) + '</td>' +
          '<td class="' + cls + '">' + (r.type === 'income' ? '收入' : r.type === 'refund' ? '退款收入' : '支出') + '</td>' +
          '<td class="num ' + cls + '">' + FW.fmtMoney(r.amount) + '</td>' +
          '<td>' + FW.esc(r.party || '—') + '</td>' +
          '<td>' + FW.esc(r.remark || '—') + '</td>' +
          '<td>' + FW.esc(r.account || '—') + '</td>' +
        '</tr>';
      }).join('');
      var cnt = s.chosen.filter(Boolean).length;
      var body =
        '<div class="muted" style="font-size:12px;margin-bottom:8px">共解析 <b>' + s.rows.length + '</b> 笔' + (skipped ? '，跳过 ' + skipped + ' 笔（退款 / 不计收支 / 无法识别）' : '') + '。勾选要导入的，取消的将被忽略。</div>' +
        '<div style="max-height:46vh;overflow:auto"><table id="impPrevTable"><thead><tr><th><input type="checkbox" id="impAll" checked></th><th>日期</th><th>类型</th><th class="num">金额</th><th>对方单位/个人</th><th>备注</th><th>账户</th></tr></thead><tbody>' + trs + '</tbody></table></div>' +
        '<div class="form-actions"><button class="btn ghost" id="impPrevCancel">取消</button><button class="btn" id="impDo">确认导入 <span id="impCnt">' + cnt + '</span> 笔</button></div>';
      FW.openModal('确认导入', body, function () {
        FW.qa('#impPrevTable .pc').forEach(function (cb) {
          cb.onchange = function () { s.chosen[+cb.dataset.i] = cb.checked; document.getElementById('impCnt').textContent = s.chosen.filter(Boolean).length; document.getElementById('impAll').checked = s.chosen.every(Boolean); };
        });
        document.getElementById('impAll').onchange = function () { var v = this.checked; FW.qa('#impPrevTable .pc').forEach(function (cb) { cb.checked = v; s.chosen[+cb.dataset.i] = v; }); document.getElementById('impCnt').textContent = s.chosen.filter(Boolean).length; };
        document.getElementById('impPrevCancel').onclick = FW.closeModal;
        document.getElementById('impDo').onclick = function () {
          var sel = s.rows.filter(function (r, i) { return s.chosen[i]; });
          if (!sel.length) { FW.toast('请至少选择一笔'); return; }
          var n = doImportRows(sel);
          FW.closeModal(); render(); FW.toast('已导入 ' + n + ' 笔流水');
        };
      });
    }
    renderPreview();
  }
  function openImport() {
    var body =
      '<div class="field"><label>导入方式</label><div class="seg">' +
        '<button type="button" class="seg-btn active" data-m="wechat">微信账单</button>' +
        '<button type="button" class="seg-btn" data-m="table">表格导入</button>' +
      '</div></div>' +
      '<div class="field"><label>选择文件（CSV 或 Excel）</label><input type="file" id="impFile" accept=".csv,.xlsx,.xls,text/csv"></div>' +
      '<div class="field"><label>编码</label><select id="impEnc"><option value="auto">自动（推荐）</option><option value="gbk">GBK（微信 / 老 Excel）</option><option value="utf8">UTF-8</option></select><span class="muted" style="font-size:12px;margin-left:6px">（仅 CSV 需要，Excel 自动识别）</span></div>' +
      '<div class="muted" style="font-size:12px;margin-top:6px" id="impTip">微信账单：在微信「服务通知 / 钱包 → 账单 → 常见问题 → 下载账单 → 用于个人对账」导出 CSV（GBK）或 Excel（.xlsx）。表格导入：支持 Excel（.xlsx/.xls）直接选文件，或 CSV（自动识别日期 / 金额 / 收支列）。</div>' +
      '<div class="form-actions"><button class="btn ghost" id="impCancel">取消</button><button class="btn" id="impParse">解析并预览</button></div>';
    FW.openModal('批量导入流水', body, function () {
      var mode = 'wechat';
      var segs = FW.qa('.seg-btn');
      segs.forEach(function (b) {
        b.onclick = function () {
          mode = b.dataset.m;
          segs.forEach(function (x) { x.classList.toggle('active', x === b); });
          document.getElementById('impTip').textContent = mode === 'wechat'
            ? '微信账单：在微信「服务通知 / 钱包 → 账单 → 常见问题 → 下载账单 → 用于个人对账」导出 CSV（GBK）或 Excel（.xlsx）。'
            : '表格导入：支持 Excel（.xlsx/.xls）直接选文件，或 CSV；系统自动识别日期 / 金额 / 收支列。';
        };
      });
      document.getElementById('impCancel').onclick = FW.closeModal;
      document.getElementById('impParse').onclick = function () {
        var file = document.getElementById('impFile').files[0];
        if (!file) { FW.toast('请先选择文件'); return; }
        var fname = (file.name || '').toLowerCase();
        var isExcel = /\.(xlsx|xls)$/.test(fname);

        // ---- Excel 文件：统一走 XLSX 解析（两种模式都支持） ----
        if (isExcel) {
          if (typeof XLSX === 'undefined') { FW.toast('Excel 解析库未加载，请刷新页面后重试'); return; }
          var fr = new FileReader();
          fr.onload = function () {
            try {
              var wb = XLSX.read(new Uint8Array(fr.result), { type: 'array' });
              if (!wb.SheetNames.length) { FW.toast('Excel 中没有工作表'); return; }
              var ws = wb.Sheets[wb.SheetNames[0]];
              var rowsArr = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
              while (rowsArr.length && rowsArr[rowsArr.length - 1].every(function (c) { return c === '' || c == null; })) rowsArr.pop();
              if (!rowsArr.length) { FW.toast('Excel 中没有数据'); return; }

              var res;
              if (mode === 'wechat') {
                // 微信账单模式：将 Excel 行转为 CSV 文本，复用 parseWeChatBill
                var csvText = rowsArr.map(function (row) {
                  return row.map(function (cell) {
                    var s = (cell == null ? '' : String(cell));
                    if (s.indexOf(',') > -1 || s.indexOf('"') > -1 || s.indexOf('\n') > -1) {
                      return '"' + s.replace(/"/g, '""') + '"';
                    }
                    return s;
                  }).join(',');
                }).join('\r\n');
                res = parseWeChatBill(csvText);
              } else {
                // 表格导入模式：列猜测 + 通用解析
                var headers = rowsArr[0].map(function (c) { return c == null ? '' : String(c); });
                var map = guessMap(headers);
                res = parseRowsCore(rowsArr, map);
              }

              if (res.ok === false) { FW.toast(res.msg); return; }
              if (!res.rows.length) { FW.toast('没有可导入的记录（跳过 ' + res.skipped + ' 行）'); return; }
              FW.closeModal();
              openImportPreview(res.rows, res.skipped, mode);
            } catch (e) { FW.toast('Excel 解析失败：' + (e && e.message ? e.message : e)); }
          };
          fr.onerror = function () { FW.toast('文件读取失败'); };
          fr.readAsArrayBuffer(file);
          return;
        }

        // ---- CSV / 文本文件 ----
        var enc = document.getElementById('impEnc').value;
        decodeFile(file, enc, function (text) {
          if (!text) { FW.toast('文件读取失败'); return; }
          var res;
          if (mode === 'wechat') {
            res = parseWeChatBill(text);
          } else {
            var lines = text.split(/\r?\n/).filter(function (l) { return l.trim(); });
            var headers = lines.length ? csvSplit(lines[0]) : [];
            var map = guessMap(headers);
            res = parseGenericCsv(text, map);
            if (!res.rows.length && lines.length > 1) res = parseGenericCsv(text, Object.assign({}, map, { hasHeader: false }));
          }
          if (res.ok === false) { FW.toast(res.msg); return; }
          if (!res.rows.length) { FW.toast('没有可导入的记录（跳过 ' + res.skipped + ' 行）'); return; }
          FW.closeModal();
          openImportPreview(res.rows, res.skipped, mode);
        });
      };
    });
  }

  FW.internalImport = { parseWeChatBill: parseWeChatBill, parseGenericCsv: parseGenericCsv, parseRowsCore: parseRowsCore, csvSplit: csvSplit, guessMap: guessMap };

  /* ---------- 银行对账（导入银行流水 + 自动勾对 + 余额调节表） ---------- */
  var bankImport = null;   // { account, rows:[{date,type,amount,summary,party,balance,income,expense,_raw}], skipped, parsedAt }
  var lastRecon = null;    // 缓存最近一次勾对结果，供一键补录使用

  function bankNormDate(s) {
    s = (s == null ? '' : String(s)).trim();
    if (!s) return '';
    if (/^\d{5}$/.test(s)) {
      var base = Date.UTC(1899, 11, 30);
      var dd = new Date(base + (parseInt(s, 10)) * 86400000);
      var yy = dd.getUTCFullYear(), mm = dd.getUTCMonth() + 1, d3 = dd.getUTCDate();
      return yy + '-' + (mm < 10 ? '0' + mm : mm) + '-' + (d3 < 10 ? '0' + d3 : d3);
    }
    var dp = s.split(/[ T]/)[0];
    var m1 = dp.match(/^(\d{4})[年\-\/\.](\d{1,2})[月\-\/\.](\d{1,2})/);
    if (m1) { var y1 = +m1[1], mo1 = +m1[2], d1 = +m1[3]; return y1 + '-' + (mo1 < 10 ? '0' + mo1 : mo1) + '-' + (d1 < 10 ? '0' + d1 : d1); }
    var m2 = dp.match(/^(\d{1,2})[年\-\/\.](\d{1,2})[年\-\/\.](\d{4})/);
    if (m2) { var mo2 = +m2[1], d2 = +m2[2], y2 = +m2[3]; if (mo2 >= 1 && mo2 <= 12 && d2 >= 1 && d2 <= 31) return y2 + '-' + (mo2 < 10 ? '0' + mo2 : mo2) + '-' + (d2 < 10 ? '0' + d2 : d2); }
    var m3 = dp.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (m3) return m3[1] + '-' + m3[2] + '-' + m3[3];
    return '';
  }
  function guessBankMap(headers) {
    function find(words) {
      for (var i = 0; i < headers.length; i++) {
        var h = (headers[i] || '').toLowerCase().replace(/\s+/g, '');
        for (var w = 0; w < words.length; w++) if (h.indexOf(words[w]) > -1) return i;
      }
      return -1;
    }
    var base = guessMap(headers);
    var incomeCol = find(['收入', '存入', '进账', '贷方', '收方', '贷方金额', '到账', '存款', '贷']);
    var expenseCol = find(['支出', '取出', '支取', '出账', '借方', '付方', '借方金额', '扣款', '取款', '消费', '借']);
    var balanceCol = find(['余额', '本余', '期末余额', '账户余额', '当前余额', '结存', '结余', '账面余额']);
    return Object.assign({}, base, { incomeCol: incomeCol, expenseCol: expenseCol, balanceCol: balanceCol });
  }
  function bankToNum(s) {
    s = (s == null ? '' : String(s)).replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); }).replace(/[￥¥,\s（）()]/g, '');
    if (!s.trim()) return null;
    var neg = /^[\(（].*[\)）]$/.test(s.trim());
    var n = parseFloat(s);
    if (isNaN(n)) return null;
    return neg ? -n : n;
  }
  function parseBankRowsCore(rowsArr, map) {
    var startRow = map.hasHeader ? 1 : 0;
    var rows = [], skipped = 0;
    for (var j = startRow; j < rowsArr.length; j++) {
      var f = (rowsArr[j] || []).map(function (x) { return x == null ? '' : String(x); });
      var dt = bankNormDate(f[map.dateCol]);
      if (!dt) { skipped++; continue; }
      var inc = map.incomeCol > -1 ? bankToNum(f[map.incomeCol]) : null;
      var exp = map.expenseCol > -1 ? bankToNum(f[map.expenseCol]) : null;
      var type, amount;
      if (inc != null && inc > 0) { type = 'income'; amount = inc; }
      else if (exp != null && exp > 0) { type = 'expense'; amount = exp; }
      else {
        var amt = bankToNum(f[map.amountCol]);
        if (amt == null) { skipped++; continue; }
        if (map.signMode === 'neg') { type = amt < 0 ? 'expense' : 'income'; amount = Math.abs(amt); }
        else {
          var tv = (map.typeCol > -1 ? (f[map.typeCol] || '') : '').trim();
          if (/收|入|贷/.test(tv) && !/支|出/.test(tv)) { type = 'income'; amount = Math.abs(amt); }
          else if (/支|出|付|借/.test(tv)) { type = 'expense'; amount = Math.abs(amt); }
          else { type = amt < 0 ? 'expense' : 'income'; amount = Math.abs(amt); }
        }
      }
      var bal = map.balanceCol > -1 ? bankToNum(f[map.balanceCol]) : null;
      rows.push({ date: dt, type: type, amount: amount, summary: (map.remarkCol > -1 ? (f[map.remarkCol] || '').trim() : ''), party: (map.partyCol > -1 ? (f[map.partyCol] || '').trim() : ''), balance: bal, income: type === 'income' ? amount : 0, expense: type === 'expense' ? amount : 0, _raw: f });
    }
    return { ok: true, rows: rows, skipped: skipped };
  }
  function dayDiff(d1, d2) {
    var t1 = Date.parse(d1), t2 = Date.parse(d2);
    if (isNaN(t1) || isNaN(t2)) return 999;
    return Math.abs((t1 - t2) / 86400000);
  }
  function reconcile(bankRows, bookRows) {
    var used = {};
    var matched = [], bankOnly = [], bookOnly = [];
    bankRows.forEach(function (b) {
      var found = null;
      for (var i = 0; i < bookRows.length; i++) {
        var t = bookRows[i];
        if (used[t.id]) continue;
        if (t.date !== b.date) continue;
        if (b.type === 'income' && (t.type === 'income' || t.type === 'refund') && Math.abs(t.amount - b.amount) < 0.01) { found = t; break; }
        if (b.type === 'expense' && t.type === 'expense' && Math.abs(t.amount - b.amount) < 0.01) { found = t; break; }
      }
      if (!found) {
        for (var k = 0; k < bookRows.length; k++) {
          var t2 = bookRows[k];
          if (used[t2.id]) continue;
          if (dayDiff(t2.date, b.date) > 1) continue;
          if (b.type === 'income' && (t2.type === 'income' || t2.type === 'refund') && Math.abs(t2.amount - b.amount) < 0.01) { found = t2; break; }
          if (b.type === 'expense' && t2.type === 'expense' && Math.abs(t2.amount - b.amount) < 0.01) { found = t2; break; }
        }
      }
      if (found) { used[found.id] = true; matched.push({ bank: b, book: found }); }
      else bankOnly.push(b);
    });
    bookRows.forEach(function (t) { if (!used[t.id]) bookOnly.push(t); });
    return { matched: matched, bankOnly: bankOnly, bookOnly: bookOnly };
  }
  function computeAdjust(recon, bookBal, bankEnd) {
    var enterRecv = recon.bookOnly.filter(function (t) { return t.type === 'income' || t.type === 'refund'; }).reduce(function (s, t) { return s + t.amount; }, 0);
    var enterPay = recon.bookOnly.filter(function (t) { return t.type === 'expense'; }).reduce(function (s, t) { return s + t.amount; }, 0);
    var bankRecv = recon.bankOnly.filter(function (b) { return b.type === 'income'; }).reduce(function (s, b) { return s + b.amount; }, 0);
    var bankPay = recon.bankOnly.filter(function (b) { return b.type === 'expense'; }).reduce(function (s, b) { return s + b.amount; }, 0);
    var adjBook = bookBal + bankRecv - bankPay;
    var adjBank = (bankEnd == null ? 0 : bankEnd) + enterRecv - enterPay;
    return { enterRecv: enterRecv, enterPay: enterPay, bankRecv: bankRecv, bankPay: bankPay, adjBook: adjBook, adjBank: adjBank, balanced: Math.abs(adjBook - adjBank) < 0.02 };
  }
  function statCard(label, val, cls) {
    return '<div class="stat"><div class="label">' + label + '</div><div class="value ' + (cls || '') + '">' + val + '</div></div>';
  }
  function reconcileBodyHtml(bi, bd) {
    var acct = bi.account;
    var bookRows = all().filter(function (t) { return t.account === acct && (t.type === 'income' || t.type === 'expense' || t.type === 'refund'); })
      .map(function (t) { return { id: t.id, date: t.date, type: t.type, amount: Number(t.amount), project: t.project, remark: t.remark }; });
    var recon = reconcile(bi.rows, bookRows);
    lastRecon = recon;
    var acctBalObj = bd.filter(function (x) { return x.name === acct; })[0];
    var bookBal = acctBalObj ? acctBalObj.bal : 0;
    var bankEnd = null;
    for (var i = bi.rows.length - 1; i >= 0; i--) { if (bi.rows[i].balance != null) { bankEnd = bi.rows[i].balance; break; } }
    var adj = computeAdjust(recon, bookBal, bankEnd);
    var enterRecv = adj.enterRecv, enterPay = adj.enterPay, bankRecv = adj.bankRecv, bankPay = adj.bankPay, adjBook = adj.adjBook, adjBank = adj.adjBank, balanced = adj.balanced;

    var kpi = '<div class="stat-row">' +
      statCard('银行流水', bi.rows.length + ' 笔') +
      statCard('已勾对', recon.matched.length + ' 笔', 'income') +
      statCard('银行未达（企未记）', recon.bankOnly.length + ' 笔', recon.bankOnly.length ? 'expense' : '') +
      statCard('企业未达（银未达）', recon.bookOnly.length + ' 笔', recon.bookOnly.length ? 'expense' : '') +
    '</div>';

    var adjust = '<div class="card" style="margin-bottom:14px;' + (balanced ? 'border-color:#bfe6cd' : 'border-color:#f4d79a') + '">' +
      '<h3>银行存款余额调节表 <span class="sub">' + FW.esc(acct) + '</span></h3>' +
      '<table class="adj-table">' +
        '<tr><td>企业账面余额（内账' + FW.esc(acct) + '）</td><td class="num">' + FW.fmtMoney(bookBal) + '</td></tr>' +
        '<tr><td>＋ 银行已收、企业未收</td><td class="num income">+' + FW.fmtMoney(bankRecv) + '</td></tr>' +
        '<tr><td>－ 银行已付、企业未付</td><td class="num expense">−' + FW.fmtMoney(bankPay) + '</td></tr>' +
        '<tr><td><b>调节后余额（企业侧）</b></td><td class="num"><b>' + FW.fmtMoney(adjBook) + '</b></td></tr>' +
        '<tr><td>银行对账单余额（期末）</td><td class="num">' + FW.fmtMoney(bankEnd == null ? 0 : bankEnd) + '</td></tr>' +
        '<tr><td>＋ 企业已收、银行未收</td><td class="num income">+' + FW.fmtMoney(enterRecv) + '</td></tr>' +
        '<tr><td>－ 企业已付、银行未付</td><td class="num expense">−' + FW.fmtMoney(enterPay) + '</td></tr>' +
        '<tr><td><b>调节后余额（银行侧）</b></td><td class="num"><b>' + FW.fmtMoney(adjBank) + '</b></td></tr>' +
      '</table>' +
      '<div class="muted" style="font-size:12px;margin-top:8px">' + (balanced ? '✅ 两侧调节后余额一致，对账平衡。' : '⚠️ 两侧调节后余额不一致（差 ' + FW.fmtMoney(Math.abs(adjBook - adjBank)) + '），请检查未达账项或期初余额。') + '</div>' +
    '</div>';

    var unrecBank = recon.bankOnly.length ? '<div class="card" style="margin-bottom:14px">' +
      '<h3>银行已记录、内账未记录 <span class="sub">企业未达账项，建议补录</span></h3>' +
      '<div style="margin-bottom:8px"><button class="btn" id="bkAppendAll">一键补录全部到内账</button></div>' +
      '<table id="bkUnrecTable"><thead><tr><th>日期</th><th>摘要</th><th>对方</th><th class="num">收入</th><th class="num">支出</th><th class="num">余额</th><th>操作</th></tr></thead><tbody>' +
      recon.bankOnly.map(function (b, i) { return '<tr><td>' + FW.esc(b.date) + '</td><td>' + FW.esc(b.summary || '—') + '</td><td>' + FW.esc(b.party || '—') + '</td><td class="num income">' + (b.income ? FW.fmtMoney(b.income) : '') + '</td><td class="num expense">' + (b.expense ? FW.fmtMoney(b.expense) : '') + '</td><td class="num">' + (b.balance != null ? FW.fmtMoney(b.balance) : '') + '</td><td><button class="btn ghost sm bk-append" data-i="' + i + '">补录</button></td></tr>'; }).join('') +
      '</tbody></table></div>' : '';

    var unrecBook = recon.bookOnly.length ? '<div class="card" style="margin-bottom:14px">' +
      '<h3>内账已记录、银行未记录 <span class="sub">银行未达账项（在途/未到账）</span></h3>' +
      '<table><thead><tr><th>日期</th><th>类型</th><th>项目</th><th class="num">金额</th></tr></thead><tbody>' +
      recon.bookOnly.map(function (t) { return '<tr><td>' + FW.esc(t.date) + '</td><td>' + (t.type === 'income' ? '收入' : t.type === 'refund' ? '退款收入' : '支出') + '</td><td>' + txProjectLabel(t) + '</td><td class="num ' + (t.type === 'income' ? 'income' : t.type === 'refund' ? 'refund' : 'expense') + '">' + FW.fmtMoney(t.amount) + '</td></tr>'; }).join('') +
      '</tbody></table></div>' : '';

    var matchedHtml = recon.matched.length ? '<div class="card">' +
      '<h3>已勾对明细 <span class="sub">' + recon.matched.length + ' 笔</span></h3>' +
      '<table><thead><tr><th>日期</th><th>银行摘要</th><th class="num">银行金额</th><th>内账项目</th><th class="num">内账金额</th></tr></thead><tbody>' +
      recon.matched.map(function (m) { return '<tr><td>' + FW.esc(m.bank.date) + '</td><td>' + FW.esc(m.bank.summary || '—') + '</td><td class="num ' + (m.bank.type === 'income' ? 'income' : 'expense') + '">' + FW.fmtMoney(m.bank.amount) + '</td><td>' + FW.esc(m.book.project || '—') + '</td><td class="num ' + (m.book.type === 'income' ? 'income' : m.book.type === 'refund' ? 'refund' : 'expense') + '">' + FW.fmtMoney(m.book.amount) + '</td></tr>'; }).join('') +
      '</tbody></table></div>' : '';

    return kpi + adjust + unrecBank + unrecBook + matchedHtml;
  }
  function bindReconcileActions() {
    var allBtn = document.getElementById('bkAppendAll');
    if (allBtn) allBtn.onclick = function () { appendBankUnrec(null); };
    FW.qa('.bk-append').forEach(function (b) { b.onclick = function () { appendBankUnrec(+this.dataset.i); }; });
  }
  function appendBankUnrec(idx) {
    if (!bankImport || !lastRecon) return;
    var targets = idx == null ? lastRecon.bankOnly.slice() : [lastRecon.bankOnly[idx]];
    if (!targets.length) return;
    var n = 0;
    targets.forEach(function (b) {
      var rec = { id: FW.db.uid('t_'), date: b.date, type: b.type, project: '', party: b.party || '', amount: Number(b.amount), remark: b.summary || '', photos: [], category: '', account: bankImport.account, fromAccount: '', toAccount: '', equityDir: 'in' };
      FW.db.upsert(KEY, rec); n++;
      var pos = bankImport.rows.indexOf(b); if (pos > -1) bankImport.rows.splice(pos, 1);
    });
    FW.toast('已补录 ' + n + ' 笔到内账（' + FW.esc(bankImport.account) + '）');
    drawReconcile();
  }
  function openBankImport() {
    var body = '<div class="field"><label>选择银行流水文件（CSV 或 Excel）</label><input type="file" id="bkFile" accept=".csv,.xlsx,.xls,text/csv"></div>' +
      '<div class="field"><label>编码</label><select id="bkEnc"><option value="auto">自动</option><option value="gbk">GBK</option><option value="utf8">UTF-8</option></select><span class="muted" style="font-size:12px">（仅 CSV 需要）</span></div>' +
      '<div class="muted" style="font-size:12px">支持含「日期 / 摘要 / 收入 / 支出 / 余额 / 对方户名」等列的表格；系统自动识别列。</div>' +
      '<div class="form-actions"><button class="btn ghost" id="bkCancel">取消</button><button class="btn" id="bkParse">解析</button></div>';
    FW.openModal('导入银行流水', body, function () {
      document.getElementById('bkCancel').onclick = FW.closeModal;
      document.getElementById('bkParse').onclick = function () {
        var file = document.getElementById('bkFile').files[0];
        if (!file) { FW.toast('请先选择文件'); return; }
        var fname = (file.name || '').toLowerCase();
        var isExcel = /\.(xlsx|xls)$/.test(fname);
        function handleRows(rowsArr) {
          var headers = rowsArr[0].map(function (c) { return c == null ? '' : String(c); });
          var map = guessBankMap(headers);
          var res = parseBankRowsCore(rowsArr, map);
          if (!res.rows.length) { FW.toast('没有可解析的流水（跳过 ' + res.skipped + ' 行）'); return; }
          bankImport = { account: state.bankAcct || getAccounts()[0], rows: res.rows, skipped: res.skipped, parsedAt: Date.now() };
          FW.closeModal();
          drawReconcile();
          FW.toast('已解析 ' + res.rows.length + ' 笔银行流水' + (res.skipped ? ('，跳过 ' + res.skipped + ' 行') : ''));
        }
        if (isExcel) {
          if (typeof XLSX === 'undefined') { FW.toast('Excel 解析库未加载，请刷新页面后重试'); return; }
          var fr = new FileReader();
          fr.onload = function () {
            try {
              var wb = XLSX.read(new Uint8Array(fr.result), { type: 'array' });
              if (!wb.SheetNames.length) { FW.toast('Excel 中没有工作表'); return; }
              var ws = wb.Sheets[wb.SheetNames[0]];
              var rowsArr = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
              while (rowsArr.length && rowsArr[rowsArr.length - 1].every(function (c) { return c === '' || c == null; })) rowsArr.pop();
              if (!rowsArr.length) { FW.toast('Excel 中没有数据'); return; }
              handleRows(rowsArr);
            } catch (e) { FW.toast('Excel 解析失败：' + (e && e.message ? e.message : e)); }
          };
          fr.onerror = function () { FW.toast('文件读取失败'); };
          fr.readAsArrayBuffer(file);
          return;
        }
        var enc = document.getElementById('bkEnc').value;
        decodeFile(file, enc, function (text) {
          if (!text) { FW.toast('文件读取失败'); return; }
          var lines = text.split(/\r?\n/).filter(function (l) { return l.trim(); });
          var rowsArr = lines.map(function (l) { return csvSplit(l); });
          if (!rowsArr.length) { FW.toast('文件无数据'); return; }
          handleRows(rowsArr);
        });
      };
    });
  }
  function drawReconcile() {
    var bd = accountBreakdown();
    var c = document.getElementById('inBody');
    var acctSel = state.bankAcct || getAccounts()[0];
    var html = '<div class="card" style="margin-bottom:14px">' +
      '<div class="toolbar">' +
        '<span style="font-size:13px;color:var(--muted);align-self:center">对账账户：</span>' +
        '<select id="bankAcct" class="field" style="width:auto">' + accOpts(acctSel) + '</select>' +
        '<button class="btn" id="bankImportBtn">📥 导入银行流水</button>' +
        '<button class="btn ghost" id="bankClearBtn">清除</button>' +
      '</div>' +
      '<div class="muted" style="font-size:12px;margin-top:8px">导入银行导出的 CSV / Excel 流水（含日期、收支、余额），系统会自动与「' + FW.esc(acctSel) + '」账户的内账逐笔勾对，找出未达账项并生成《银行存款余额调节表》。支持工行、建行、招行等常见格式。</div>' +
    '</div>';

    if (bankImport && bankImport.account === acctSel) {
      html += reconcileBodyHtml(bankImport, bd);
    } else if (bankImport) {
      html += '<div class="card"><div class="muted">当前展示的是「' + FW.esc(bankImport.account) + '」的银行流水，与所选账户不一致，请重新导入或切换账户。</div></div>';
    } else {
      html += '<div class="empty" style="padding:30px">还没有导入银行流水。点「导入银行流水」选择银行导出的对账单文件（CSV 或 Excel）。</div>';
    }
    c.innerHTML = html;

    var sel = document.getElementById('bankAcct');
    if (sel) sel.onchange = function () { state.bankAcct = this.value; if (bankImport && bankImport.account !== this.value) bankImport = null; drawReconcile(); };
    var ib = document.getElementById('bankImportBtn');
    if (ib) ib.onclick = openBankImport;
    var cl = document.getElementById('bankClearBtn');
    if (cl) cl.onclick = function () { bankImport = null; drawReconcile(); };
    bindReconcileActions();
  }

  /* ---------- 费用分摊（一笔支出归属多个项目） ---------- */
  // 表单草稿：每一行 { project, amount }
  var allocDraft = [];

  // 单行分摊的「项目」控件：已有项目用下拉直接选；自定义（库里没有的）项目名用文本框直接填
  function allocProjCtrl(a, i) {
    var existing = projects();
    if (a.project && existing.indexOf(a.project) < 0) {
      return '<input class="alloc-proj" data-i="' + i + '" value="' + FW.esc(a.project) + '" placeholder="项目名">';
    }
    var opts = '<option value="">（不选）</option>' + existing.map(function (p) {
      return '<option value="' + FW.esc(p) + '"' + (p === a.project ? ' selected' : '') + '>' + FW.esc(p) + '</option>';
    }).join('') + '<option value="__NEW__">＋ 新建项目…</option>';
    return '<select class="alloc-proj" data-i="' + i + '">' + opts + '</select>';
  }
  function allocRowHtml(a, i) {
    return '<div class="alloc-row" data-i="' + i + '">' +
      allocProjCtrl(a, i) +
      '<input class="alloc-amt" type="number" step="0.01" min="0" data-i="' + i + '" value="' + (a.amount === '' || a.amount == null ? '' : a.amount) + '" placeholder="金额">' +
      '<button type="button" class="btn ghost sm alloc-del" data-i="' + i + '" title="删除此行">✕</button>' +
      '</div>';
  }

  function allocBoxHtml() {
    var rows = allocDraft.map(allocRowHtml).join('');
    return '<div class="alloc-box">' +
      '<div class="alloc-head">⊞ 项目分摊（一笔收支需归属多个项目时填写）</div>' +
      '<div class="muted" style="font-size:12px;margin:2px 0 6px">填写后，上方「项目」将被忽略，本笔金额按下列各项目分配；各项目金额合计须等于本笔金额。项目可直接从下拉选，或选「＋ 新建项目…」输入新项目名。</div>' +
      '<div id="allocRows">' + rows + '</div>' +
      '<button type="button" class="btn ghost sm alloc-add" id="allocAdd">＋ 添加分摊行</button>' +
      '<div class="alloc-total" id="allocTotal"></div>' +
      '</div>';
  }

  function refreshAlloc() {
    var box = document.getElementById('allocRows');
    if (!box) return;
    box.innerHTML = allocDraft.map(allocRowHtml).join('');
    updateAllocTotal();
  }

  function updateAllocTotal() {
    var totEl = document.getElementById('allocTotal');
    if (!totEl) return;
    var amtEl = document.getElementById('f_amount');
    var total = parseFloat(amtEl ? amtEl.value : '') || 0;
    var sum = allocDraft.reduce(function (s, a) { return s + (parseFloat(a.amount) || 0); }, 0);
    var diff = sum - total;
    var okEq = Math.abs(diff) < 0.01;
    totEl.innerHTML = '本笔金额 <b>' + FW.fmtMoney(total) + '</b> ｜ 已分摊合计 <b>' + FW.fmtMoney(sum) + '</b> ' +
      (allocDraft.length ? (okEq ? '<span class="alloc-ok">✓ 已平衡</span>' : '<span class="alloc-warn">差额 ' + FW.fmtMoney(diff) + '</span>') : '');
  }

  function bindAllocBox() {
    var addBtn = document.getElementById('allocAdd');
    if (addBtn) addBtn.onclick = function () { allocDraft.push({ project: '', amount: '' }); refreshAlloc(); };
    var rowsEl = document.getElementById('allocRows');
    if (rowsEl) {
      rowsEl.onclick = function (e) {
        var del = e.target.closest && e.target.closest('.alloc-del');
        if (del) { allocDraft.splice(+del.dataset.i, 1); refreshAlloc(); }
      };
      // 文本框输入（自定义项目名 / 金额）：实时写入草稿
      rowsEl.oninput = function (e) {
        var inp = e.target;
        if (inp.classList.contains('alloc-amt')) {
          allocDraft[+inp.dataset.i].amount = (inp.value === '' ? '' : parseFloat(inp.value));
          updateAllocTotal();
        } else if (inp.classList.contains('alloc-proj') && inp.tagName === 'INPUT') {
          allocDraft[+inp.dataset.i].project = inp.value;
          updateAllocTotal();
        }
      };
      // 下拉选择：选「＋ 新建项目…」则换成文本框；选已有项目则直接写入草稿
      rowsEl.onchange = function (e) {
        var inp = e.target;
        if (inp.classList.contains('alloc-proj') && inp.tagName === 'SELECT') {
          if (inp.value === '__NEW__') { swapToNewProject(inp); return; }
          allocDraft[+inp.dataset.i].project = inp.value;
          updateAllocTotal();
          // 自动定位到金额框，让用户接着输金额——避免「选了下拉却感觉没反应」
          var row = inp.closest && inp.closest('.alloc-row');
          var amt = row && row.querySelector && row.querySelector('.alloc-amt');
          if (amt) { amt.focus(); try { amt.select(); } catch (_) {} }
        }
      };
    }
  }
  // 选「＋ 新建项目…」时把 <select> 换成文本框，方便直接输入新项目名
  function swapToNewProject(sel) {
    var i = +sel.dataset.i;
    var inp = document.createElement('input');
    inp.className = 'alloc-proj';
    inp.dataset.i = i;
    inp.placeholder = '输入新项目名';
    inp.value = '';
    if (sel.parentNode) sel.parentNode.replaceChild(inp, sel);
    inp.focus();
  }

  // 流水列表 / 打印中的「项目」列：分摊交易显示 ⊞ 标记 + 各项目名（悬停看金额）
  function txProjectLabel(t) {
    var items = (t.allocations || []).filter(function (a) { return (a.project || '').trim(); });
    if (!items.length) return FW.esc(t.project || '—');
    var names = items.map(function (a) { return (a.project || '').trim(); });
    var shown = names.slice(0, 2).join('/');
    if (names.length > 2) shown += '…(' + names.length + ')';
    var tip = '已分摊：' + items.map(function (a) { return (a.project || '') + ' ' + FW.fmtMoney(Number(a.amount) || 0); }).join('；');
    return '<span class="alloc-tag" title="' + FW.esc(tip) + '">⊞ ' + FW.esc(shown) + '</span>';
  }
  function txProjectText(t) {
    var items = (t.allocations || []).filter(function (a) { return (a.project || '').trim(); });
    if (!items.length) return (t && t.project) ? t.project : '';
    return items.map(function (a) { return (a.project || '').trim(); }).join('/');
  }

  // 项目统计（按项目汇总收支）：支出 / 退款按 allocations 拆分
  function projAgg(rows) {
    var map = {};
    function add(k, inc, exp) {
      if (!map[k]) map[k] = { income: 0, expense: 0 };
      if (inc) map[k].income += inc;
      if (exp) map[k].expense += exp;
    }
    (rows || []).forEach(function (t) {
      if (t.type !== 'income' && t.type !== 'expense' && t.type !== 'refund') return;
      var sign = (t.type === 'refund') ? -1 : 1;
      var alloc = (FW.projectCostCalc && FW.projectCostCalc.splitAmounts) ? FW.projectCostCalc.splitAmounts(t) : null;
      if (alloc) {
        if (t.type === 'income') alloc.forEach(function (s) { add(s.project || '未分类项目', s.amount, 0); });
        else alloc.forEach(function (s) { add(s.project || '未分类项目', 0, s.amount * sign); });
      } else {
        add(t.project || '未分类项目', (t.type === 'income' ? Number(t.amount) : 0), (t.type === 'income' ? 0 : Number(t.amount) * sign));
      }
    });
    return map;
  }

  /* ---------- 新增 / 编辑 表单 ---------- */
  function openForm(id) {
    catAutoTouched = false;
    var edit = id ? FW.db.getById(KEY, id) : null;
    allocDraft = (edit && edit.allocations && edit.allocations.length) ? edit.allocations.map(function (a) { return { project: (a.project || '').trim(), amount: (a.amount == null ? '' : a.amount) }; }) : [];
    var projList = projects().map(function (p) { return '<option>' + FW.esc(p) + '</option>'; }).join('');
    var v = { date: FW.today(), type: 'expense', cat1: DEFAULT_CATS[0], cat2: '', account: ACCTS[0], amount: '', remark: '', project: '', party: '', reimburser: '', photos: [],
      fromAccount: ACCTS[0], toAccount: ACCTS[1] || ACCTS[0], equityDir: 'in' };
    if (edit) {
      v = { date: edit.date || FW.today(), type: edit.type || 'expense', cat1: '', cat2: '', account: edit.account || ACCTS[0],
        amount: edit.amount, remark: edit.remark || '', project: edit.project || '', party: edit.party || '', reimburser: edit.reimburser || '', photos: edit.photos || [],
        fromAccount: ACCTS[0], toAccount: ACCTS[1] || ACCTS[0], equityDir: 'in' };
      if (edit.category) { var parts = edit.category.split(' / '); v.cat1 = parts[0]; v.cat2 = parts[1] || ''; }
      if (edit.type === 'transfer') { v.fromAccount = edit.fromAccount || ACCTS[0]; v.toAccount = edit.toAccount || (ACCTS[1] || ACCTS[0]); }
      if (edit.type === 'equity') { v.equityDir = edit.equityDir || 'in'; }
    }
    var photos = (edit && edit.photos) ? edit.photos.slice() : [];
    var body =
      '<div class="tx-form">' +
        // —— 基础信息 ——
        '<div class="tx-section">' +
          '<div class="form-grid">' +
            '<div class="field"><label>日期</label><input id="f_date" type="date" value="' + FW.esc(v.date) + '"></div>' +
            '<div class="field"><label>类型</label><select id="f_type">' +
              '<option value="expense" ' + (v.type === 'expense' ? 'selected' : '') + '>支出</option>' +
              '<option value="income" ' + (v.type === 'income' ? 'selected' : '') + '>收入</option>' +
              '<option value="refund" ' + (v.type === 'refund' ? 'selected' : '') + '>退款收入（冲减支出）</option>' +
              '<option value="transfer" ' + (v.type === 'transfer' ? 'selected' : '') + '>账户互转（不影响收支）</option>' +
              '<option value="equity" ' + (v.type === 'equity' ? 'selected' : '') + '>股本资金（不影响收支）</option>' +
              '<option value="dividend" ' + (v.type === 'dividend' ? 'selected' : '') + '>股东分红（不影响收支）</option>' +
            '</select></div>' +
          '</div>' +
        '</div>' +
        // —— 往来与归属 ——
        '<div class="tx-section">' +
          '<div class="tx-title">往来与归属</div>' +
          '<div class="form-grid">' +
            '<div class="field"><label>项目</label><input id="f_project" list="projList" value="' + FW.esc(v.project) + '" placeholder="如：XX项目"><datalist id="projList">' + projList + '</datalist></div>' +
            '<div class="field"><label>对方单位 / 个人</label><input id="f_party" value="' + FW.esc(v.party) + '" placeholder="如：XX公司 / 张三"></div>' +
            '<div class="field full"><label>报销人</label><input id="f_reimburser" value="' + FW.esc(v.reimburser) + '" placeholder="报销人姓名（如：李四）"></div>' +
          '</div>' +
        '</div>' +
        // —— 动态区：分类 / 账户 / 分摊 / 互转 / 股本（由 renderDyn 注入 section 结构）——
        '<div class="tx-section" id="dynArea"></div>' +
        // —— 金额与备注 ——
        '<div class="tx-section">' +
          '<div class="tx-title">金额与备注</div>' +
          '<div class="form-grid">' +
            '<div class="field full"><label>金额（元）</label><input id="f_amount" type="number" step="0.01" min="0" value="' + FW.esc(v.amount) + '"></div>' +
            '<div class="field full"><label>备注</label><textarea id="f_remark" rows="2" placeholder="用途说明">' + FW.esc(v.remark) + '</textarea></div>' +
          '</div>' +
        '</div>' +
        // —— 收付款凭证 ——
        '<div class="tx-section">' +
          '<div class="tx-title">收付款凭证</div>' +
          '<div class="field full"><div class="muted" style="font-size:12px;margin-bottom:4px">可点「＋」选择，也可直接 <b>Ctrl+V 粘贴</b> 或把图片拖到下方</div><div class="photo-grid" id="photoGrid"></div></div>' +
        '</div>' +
      '</div>' +
      '<div class="form-actions"><button class="btn ghost" id="txCancel">取消</button><button class="btn" id="txSave">保存</button></div>';

    FW.openModal(edit ? '编辑流水' : '新增流水', body, function () {
      var typeSel = document.getElementById('f_type');
      renderDyn(typeSel.value, v);
      typeSel.onchange = function () { renderDyn(this.value, v); };
      var amtEl = document.getElementById('f_amount');
      if (amtEl) amtEl.oninput = updateAllocTotal;
      updateAllocTotal();
      renderPhotoGrid(photos);
      var remEl = document.getElementById('f_remark');
      if (remEl) remEl.oninput = function () { autoMatchCat(this.value); };
      var unbind = bindPaste(photos);
      document.getElementById('txCancel').onclick = function () { unbind(); FW.closeModal(); };
      document.getElementById('txSave').onclick = function () {
        var amount = parseFloat(document.getElementById('f_amount').value);
        if (!(amount >= 0) || isNaN(amount)) { FW.toast('请输入有效金额'); return; }
        var type = document.getElementById('f_type').value;
        var rec = {
          id: edit ? edit.id : FW.db.uid('t_'),
          date: document.getElementById('f_date').value || FW.today(),
          type: type,
          project: document.getElementById('f_project').value.trim(),
          party: document.getElementById('f_party').value.trim(),
          reimburser: document.getElementById('f_reimburser').value.trim(),
          amount: amount,
          remark: document.getElementById('f_remark').value.trim(),
          photos: photos,
          category: '', account: '', fromAccount: '', toAccount: '', equityDir: 'in'
        };
        if (type === 'income' || type === 'expense' || type === 'refund') {
          var c1 = document.getElementById('f_cat1').value;
          var c2 = document.getElementById('f_cat2').value;
          rec.category = c1 ? (c2 ? c1 + ' / ' + c2 : c1) : '';
          rec.account = document.getElementById('f_account').value;
          if (type === 'income') {
            var per = parseFloat(document.getElementById('f_fee_permille').value);
            var feeName = (document.getElementById('f_fee_name').value || '').trim();
            if (per > 0 && !isNaN(per)) {
              var rr = per / 1000;
              rec.deduct = +((amount * rr / (1 - rr))).toFixed(2);
              rec.feePermille = per;
              rec.feeName = feeName || '服务费';
            } else {
              rec.deduct = 0; rec.feePermille = ''; rec.feeName = '';
            }
          }
        } else if (type === 'transfer') {
          rec.fromAccount = document.getElementById('f_from').value;
          rec.toAccount = document.getElementById('f_to').value;
          rec.account = rec.fromAccount + ' → ' + rec.toAccount;
        } else if (type === 'equity') {
          rec.equityDir = document.getElementById('f_edir').value;
          rec.account = document.getElementById('f_account').value;
        }
        else if (type === 'dividend') {
          rec.account = document.getElementById('f_account').value;
        }
        // ===== 项目分摊：收入 / 支出 / 退款可拆分到多个项目 =====
        if (type === 'income' || type === 'expense' || type === 'refund') {
          var valid = allocDraft.filter(function (a) { return (a.project || '').trim() && (parseFloat(a.amount) || 0) > 0; });
          if (valid.length) {
            var validSum = valid.reduce(function (s, a) { return s + parseFloat(a.amount); }, 0);
            if (Math.abs(validSum - amount) > 0.01) { FW.toast('分摊金额合计(' + FW.fmtMoney(validSum) + ')需等于本笔金额(' + FW.fmtMoney(amount) + ')'); return; }
            rec.project = '';
            rec.allocations = valid.map(function (a) { return { project: (a.project || '').trim(), amount: parseFloat(a.amount) }; });
          }
        }
        unbind();
        FW.db.upsert(KEY, rec);
        FW.closeModal(); render(); FW.toast('已保存');
      };
    });
  }

  /* ===================== 科目智能匹配 ===================== */
  function catRules() {
    var r = FW.db.getList(RULEKEY);
    return (r && r.length) ? r : (window.CatMatch ? window.CatMatch.DEFAULT_RULES : []);
  }
  function clearCatHint() { var h = document.getElementById('catHint'); if (h) h.innerHTML = ''; }
  // 输入摘要时自动匹配一级/二级分类；用户手动改过分类后停止，避免覆盖其选择
  function autoMatchCat(text) {
    if (catAutoTouched) return;
    var c1 = document.getElementById('f_cat1');
    if (!c1) return;
    var CM = window.CatMatch;
    if (!CM) return;
    var m = CM.match(text, catRules());
    if (!m || !m.cat1) return;
    var has1 = Array.prototype.some.call(c1.options, function (o) { return o.value === m.cat1; });
    if (!has1) return;
    c1.value = m.cat1;
    var c2 = document.getElementById('f_cat2');
    if (c2) {
      c2.innerHTML = cat2Opts(m.cat1, '');
      if (m.cat2) {
        var has2 = Array.prototype.some.call(c2.options, function (o) { return o.value === m.cat2; });
        if (has2) c2.value = m.cat2;
      }
    }
    var label = m.cat1 + (m.cat2 ? (' / ' + m.cat2) : '');
    var hint = document.getElementById('catHint');
    if (hint) hint.innerHTML = '🤖 已自动匹配：<b>' + FW.esc(label) + '</b> <a href="#" id="catHintOff" style="font-size:12px">不再自动</a>';
    var off = document.getElementById('catHintOff');
    if (off) off.onclick = function (e) { e.preventDefault(); catAutoTouched = true; clearCatHint(); };
  }
  // 批量：为「无分类」的收支/退款流水按摘要智能补分类（不覆盖已有分类）
  function bulkAutoCategorize() {
    if (!window.CatMatch) { FW.toast('智能匹配模块未加载'); return; }
    var rows = FW.db.getList(KEY);
    var valid = window.CatMatch.filterValid(catRules(), cats().map(function (c) { return c.name; }));
    var n = 0;
    rows.forEach(function (t) {
      if ((t.type === 'income' || t.type === 'expense' || t.type === 'refund') && !t.category) {
        var m = window.CatMatch.match(t.remark, valid);
        if (m && m.cat1) {
          t.category = m.cat2 ? (m.cat1 + ' / ' + m.cat2) : m.cat1;
          FW.db.upsert(KEY, t);
          n++;
        }
      }
    });
    render();
    FW.toast(n ? ('已为 ' + n + ' 条流水智能匹配分类') : '没有需要匹配的空分类流水');
  }
  // 匹配规则管理弹窗（关键字 → 分类，可开关 / 编辑 / 增删 / 恢复默认）
  function openCatMatchManager() {
    var rules = catRules().map(function (r) {
      return { kw: (r.kw || []).slice(), cat1: r.cat1 || '', cat2: r.cat2 || '', enabled: (r.enabled !== false), note: r.note || '' };
    });
    function persist() { FW.db.saveList(RULEKEY, rules); }
    function cat1Select(sel) {
      return '<select class="cm-c1">' + cats().map(function (c) { return '<option ' + (c.name === sel ? 'selected' : '') + '>' + FW.esc(c.name) + '</option>'; }).join('') + '</select>';
    }
    function render() {
      var rows = rules.map(function (r, i) {
        return '<div class="cm-rule" data-i="' + i + '">' +
          '<input type="checkbox" class="cm-en" ' + (r.enabled ? 'checked' : '') + ' title="启用">' +
          '<input class="cm-kw" value="' + FW.esc((r.kw || []).join('，')) + '" placeholder="关键字，逗号分隔，如：工资，薪资">' +
          '<span class="cm-arrow">→</span>' + cat1Select(r.cat1) +
          '<button class="btn danger sm cm-del" data-i="' + i + '">删</button></div>';
      }).join('');
      var body =
        '<div class="cm-wrap">' +
        '<div class="muted" style="font-size:12px;margin-bottom:8px">输入摘要时，含下方「关键字」的流水会自动归入对应「分类」。规则从上到下优先匹配，靠前的先命中。</div>' +
        '<div class="cm-head"><span>启用</span><span>关键字（逗号分隔）</span><span>→ 分类</span><span></span></div>' +
        (rows || '<div class="muted">（暂无规则，点下方「＋ 新增规则」）</div>') +
        '<div style="margin-top:10px"><button class="btn sm" id="cmAdd">＋ 新增规则</button> <button class="btn ghost sm" id="cmReset">恢复默认规则</button></div>' +
        '</div>';
      FW.openModal('科目智能匹配规则', body, function () {
        function rebind() {
          FW.qa('.cm-en').forEach(function (cb) { cb.onchange = function () { rules[+cb.parentNode.dataset.i].enabled = cb.checked; persist(); }; });
          FW.qa('.cm-kw').forEach(function (inp) { inp.oninput = function () { var i = +inp.parentNode.dataset.i; rules[i].kw = inp.value.split(/[，,]/).map(function (s) { return s.trim(); }).filter(Boolean); persist(); }; });
          FW.qa('.cm-c1').forEach(function (sel) { sel.onchange = function () { rules[+sel.parentNode.dataset.i].cat1 = sel.value; persist(); }; });
          FW.qa('.cm-del').forEach(function (b) { b.onclick = function () { rules.splice(+b.dataset.i, 1); persist(); render(); }; });
        }
        var add = document.getElementById('cmAdd');
        if (add) add.onclick = function () { rules.push({ kw: [], cat1: (cats()[0] || {}).name || '', cat2: '', enabled: true }); persist(); render(); };
        var reset = document.getElementById('cmReset');
        if (reset) reset.onclick = function () {
          if (confirm('恢复为内置默认规则？当前自定义规则将被覆盖。')) {
            rules = window.CatMatch.DEFAULT_RULES.map(function (r) { return { kw: r.kw.slice(), cat1: r.cat1, cat2: r.cat2 || '', enabled: (r.enabled !== false), note: r.note || '' }; });
            persist(); render();
          }
        };
        rebind();
      });
    }
    render();
  }

  function bindPaste(photos) {
    var mask = document.getElementById('modalMask');
    if (!mask) return function () {};
    function onPaste(e) {
      var cd = e.clipboardData || (global.clipboardData);
      if (!cd || !cd.items) return;
      var handled = false;
      Array.prototype.forEach.call(cd.items, function (it) {
        if (it.type && it.type.indexOf('image') === 0) {
          var file = it.getAsFile();
          if (file) {
            handled = true;
            var r = new FileReader();
            r.onload = function () { FW.db.savePhoto(r.result).then(function (id) { photos.push(id); renderPhotoGrid(photos); }).catch(function () {}); };
            r.readAsDataURL(file);
          }
        }
      });
      if (handled) e.preventDefault();
    }
    mask.addEventListener('paste', onPaste);
    return function () { mask.removeEventListener('paste', onPaste); };
  }
  function renderPhotoGrid(photos) {
    var grid = document.getElementById('photoGrid');
    if (!grid) return;
    grid.innerHTML = '';
    photos.forEach(function (pid) {
      var wrap = document.createElement('div');
      wrap.style.position = 'relative';
      var img = document.createElement('img');
      img.className = 'photo-thumb'; img.dataset.load = pid;
      FW.db.getPhoto(pid).then(function (d) { if (d) img.src = d; }).catch(function () {});
      var del = document.createElement('span');
      del.textContent = '✕'; del.style.cssText = 'position:absolute;top:-6px;right:-6px;background:#d33;color:#fff;border-radius:50%;width:16px;height:16px;font-size:11px;line-height:16px;text-align:center;cursor:pointer';
      del.onclick = function () { photos.splice(photos.indexOf(pid), 1); FW.db.deletePhoto(pid); renderPhotoGrid(photos); };
      img.onclick = function () { previewPhoto(pid); };
      wrap.appendChild(img); wrap.appendChild(del); grid.appendChild(wrap);
    });
    var add = document.createElement('div');
    add.className = 'photo-add'; add.textContent = '＋';
    add.title = '上传凭证照片';
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
    grid.ondragover = function (e) { e.preventDefault(); grid.classList.add('drag'); };
    grid.ondragleave = function () { grid.classList.remove('drag'); };
    grid.ondrop = function (e) {
      e.preventDefault(); grid.classList.remove('drag');
      var files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) addFiles(files, photos);
    };
  }
  function addFiles(fileList, photos) {
    var files = Array.prototype.slice.call(fileList).filter(function (f) { return f.type.indexOf('image') === 0; });
    if (!files.length) return;
    var pending = files.map(function (f) { return new Promise(function (res) { var r = new FileReader(); r.onload = function () { FW.db.savePhoto(r.result).then(res); }; r.readAsDataURL(f); }); });
    Promise.all(pending).then(function (ids) { ids.forEach(function (i) { photos.push(i); }); renderPhotoGrid(photos); });
  }

  /* ---------- 用途分类管理（支持拖拽排序） ---------- */
  function moveInArray(arr, from, to) {
    if (to < 0 || to >= arr.length || from < 0 || from >= arr.length || from === to) return false;
    var x = arr.splice(from, 1)[0];
    arr.splice(to, 0, x);
    return true;
  }
  function openCatManager() {
    var dragState = null;
    function delCat1(i) {
      var l = cats(); var name = l[i].name;
      var used = FW.db.getList(KEY).some(function (t) { return cat1Name(t) === name; });
      if (used && !confirm('「' + name + '」下已有流水记录，删除后该分类将显示为空白，仍要删除？')) return;
      l.splice(i, 1); FW.db.saveList(CATKEY_, l); render();
    }
    function addCat2(i) {
      var n = prompt('输入二级分类名称：'); if (!n) return; n = n.trim();
      var l = cats(); var c = l[i];
      if ((c.children || []).indexOf(n) >= 0) { FW.toast('已存在该二级分类'); return; }
      c.children = c.children || []; c.children.push(n); FW.db.saveList(CATKEY_, l); render();
    }
    function delCat2(i, j) {
      var l = cats(); l[i].children.splice(j, 1); FW.db.saveList(CATKEY_, l); render();
    }
    function render() {
      var list = cats();
      var rows = list.map(function (c, i) {
        var kids = (c.children || []).map(function (k, j) {
          return '<div class="cat-l2" draggable="true" data-i="' + i + '" data-j="' + j + '">' +
            '<span class="drag-h" draggable="false">⇕</span><span>↳ ' + FW.esc(k) + '</span>' +
            '<button class="btn danger sm cat-l2-del" data-i="' + i + '" data-j="' + j + '">删</button></div>';
        }).join('');
        return '<div class="cat-l1" draggable="true" data-i="' + i + '">' +
          '<div class="cat-l1-head"><span class="drag-h" draggable="false">⇕</span><b>' + FW.esc(c.name) + '</b>' +
          '<span class="cat-ops"><button class="btn ghost sm cat-l2-add" data-i="' + i + '">＋二级</button><button class="btn danger sm cat-l1-del" data-i="' + i + '">删</button></span></div>' +
          (kids || '<div class="muted" style="font-size:12px">（暂无二级分类）</div>') + '</div>';
      }).join('');
      var body = '<div class="cat-hint muted">提示：拖动左侧 ⇕ 手柄可调整分类顺序，顺序将被保存。</div>' +
        '<div class="cat-mgr">' + rows + '</div>' +
        '<div class="field" style="margin-top:12px"><label>新增一级分类</label><input id="newCat1" placeholder="如：通讯费"><button class="btn" id="addCat1" style="margin-left:8px">添加</button></div>' +
        '<div class="form-actions"><button class="btn ghost" id="cmClose">关闭</button></div>';
      FW.openModal('管理用途分类（一级 / 二级 · 可拖拽排序）', body, function () {
        FW.qa('#modalBody .cat-l1-del').forEach(function (b) { b.onclick = function () { delCat1(parseInt(b.dataset.i, 10)); }; });
        FW.qa('#modalBody .cat-l2-add').forEach(function (b) { b.onclick = function () { addCat2(parseInt(b.dataset.i, 10)); }; });
        FW.qa('#modalBody .cat-l2-del').forEach(function (b) { b.onclick = function () { delCat2(parseInt(b.dataset.i, 10), parseInt(b.dataset.j, 10)); }; });
        document.getElementById('addCat1').onclick = function () {
          var n = document.getElementById('newCat1').value.trim();
          if (!n) { FW.toast('请输入名称'); return; }
          var l = cats();
          if (l.some(function (x) { return x.name === n; })) { FW.toast('已存在该一级分类'); return; }
          l.push({ name: n, children: [] }); FW.db.saveList(CATKEY_, l); render();
        };
        document.getElementById('cmClose').onclick = FW.closeModal;
        FW.qa('#modalBody .cat-l1').forEach(function (el) {
          var i = parseInt(el.dataset.i, 10);
          el.ondragstart = function (e) { dragState = { type: 'l1', from: i }; e.dataTransfer.effectAllowed = 'move'; el.classList.add('dragging'); };
          el.ondragend = function () { el.classList.remove('dragging'); FW.qa('#modalBody .cat-l1,#modalBody .cat-l2').forEach(function (x) { x.classList.remove('dragging'); }); };
          el.ondragover = function (e) { e.preventDefault(); el.classList.add('drop-over'); };
          el.ondragleave = function () { el.classList.remove('drop-over'); };
          el.ondrop = function (e) {
            e.preventDefault(); el.classList.remove('drop-over');
            if (dragState && dragState.type === 'l1') {
              var l = cats();
              if (moveInArray(l, dragState.from, i)) { FW.db.saveList(CATKEY_, l); render(); }
              dragState = null;
            }
          };
        });
        FW.qa('#modalBody .cat-l2').forEach(function (el) {
          var i = parseInt(el.dataset.i, 10), j = parseInt(el.dataset.j, 10);
          el.ondragstart = function (e) { e.stopPropagation(); dragState = { type: 'l2', pi: i, from: j }; el.classList.add('dragging'); };
          el.ondragover = function (e) { e.preventDefault(); e.stopPropagation(); el.classList.add('drop-over'); };
          el.ondragleave = function () { el.classList.remove('drop-over'); };
          el.ondrop = function (e) {
            e.preventDefault(); el.classList.remove('drop-over');
            if (dragState && dragState.type === 'l2') {
              e.stopPropagation();
              var l = cats();
              var item = l[dragState.pi].children.splice(dragState.from, 1)[0];
              l[i].children = l[i].children || [];
              l[i].children.splice(j, 0, item);
              FW.db.saveList(CATKEY_, l); render();
              dragState = null;
            }
          };
        });
      });
    }
    render();
  }

  function previewPhoto(pid) {
    FW.db.getPhoto(pid).then(function (d) {
      if (!d) { FW.toast('照片读取失败'); return; }
      FW.openModal('凭证照片', '<div style="text-align:center"><img src="' + d + '" style="max-width:100%;border-radius:8px"></div>');
    }).catch(function () { FW.toast('照片读取失败'); });
  }
  function delTx(id) {
    var rec = FW.db.getById(KEY, id);
    if (!rec) return;
    if (!confirm('确定删除该笔流水？' + (rec.photos && rec.photos.length ? '（将同时删除 ' + rec.photos.length + ' 张凭证照片）' : ''))) return;
    FW.db.remove(KEY, id);
    if (rec.photos && rec.photos.length) FW.db.deletePhotos(rec.photos);
    render(); FW.toast('已删除');
  }
  /* ---------- 批量修改 ---------- */
  function bulkBarHtml() {
    return '<div id="bulkBar" class="bulk-bar">' +
      '<span class="bulk-info">已选 <b id="bulkCount">0</b> 条</span>' +
      '<button class="btn sm" id="bulkSetBtn">批量设置字段值</button>' +
      '<button class="btn sm" id="bulkDateBtn">批量调整日期</button>' +
      '<button class="btn danger sm" id="bulkDelBtn">批量删除</button>' +
      '<button class="btn ghost sm" id="bulkExitBtn">退出批量</button>' +
    '</div>';
  }
  function updateBulkCount() {
    var el = document.getElementById('bulkCount');
    if (el) el.textContent = Object.keys(state.selIds).length;
  }
  function bindBulkBar() {
    var set = document.getElementById('bulkSetBtn'); if (set) set.onclick = openBulkSet;
    var dt = document.getElementById('bulkDateBtn'); if (dt) dt.onclick = openBulkDate;
    var del = document.getElementById('bulkDelBtn'); if (del) del.onclick = openBulkDelete;
    var ex = document.getElementById('bulkExitBtn'); if (ex) ex.onclick = function () { state.selMode = false; state.selIds = {}; render(); };
    updateBulkCount();
  }
  function bindBulkRowEvents() {
    FW.qa('#txTable .sel-cb').forEach(function (cb) {
      cb.onchange = function () {
        if (cb.checked) state.selIds[cb.dataset.id] = true; else delete state.selIds[cb.dataset.id];
        updateBulkCount();
      };
    });
    var sa = document.getElementById('selAll');
    if (sa) sa.onchange = function () {
      var rows = filteredRows();
      if (sa.checked) rows.forEach(function (t) { state.selIds[t.id] = true; });
      else rows.forEach(function (t) { delete state.selIds[t.id]; });
      FW.qa('#txTable .sel-cb').forEach(function (cb) { cb.checked = sa.checked; });
      updateBulkCount();
    };
  }
  var BULK_FIELDS = { category: '分类', account: '账户', project: '项目', party: '对方单位/个人', reimburser: '报销人', type: '类型' };
  function bulkFieldInputHtml(field) {
    if (field === 'category') {
      return '<div class="field"><label>一级分类</label><select id="bulkCat1">' + cat1Opts('') + '</select></div>' +
             '<div class="field"><label>二级分类（可选）</label><select id="bulkCat2">' + cat2Opts('', '') + '</select></div>';
    }
    if (field === 'account') {
      return '<div class="field"><label>账户</label><select id="bulkAccount">' + accOptsHtml('') + '</select></div>';
    }
    if (field === 'type') {
      return '<div class="field"><label>类型</label><select id="bulkType"><option value="income">收入</option><option value="expense">支出</option><option value="refund">退款收入</option><option value="dividend">股东分红</option></select></div>';
    }
    var idMap = { project: 'bulkProject', party: 'bulkParty', reimburser: 'bulkReimburser' };
    var phMap = { project: '如：XX项目', party: '如：XX公司 / 张三', reimburser: '如：李四' };
    var dl = field === 'project' ? '<datalist id="bulkProjList">' + projects().map(function (p) { return '<option value="' + FW.esc(p) + '">'; }).join('') + '</datalist>' : '';
    return '<div class="field"><label>' + BULK_FIELDS[field] + '</label><input id="' + idMap[field] + '" list="' + (field === 'project' ? 'bulkProjList' : '') + '" placeholder="' + phMap[field] + '">' + dl + '</div>';
  }
  function bindBulkCat1() {
    var c1 = document.getElementById('bulkCat1'); if (!c1) return;
    function fill() {
      var c2 = document.getElementById('bulkCat2'); if (!c2) return;
      c2.innerHTML = cat2Opts(c1.value, '');
    }
    c1.onchange = fill; fill();
  }
  function readBulkValue(field) {
    if (field === 'category') {
      var c1 = document.getElementById('bulkCat1').value;
      var c2 = document.getElementById('bulkCat2').value;
      return c1 ? (c2 ? c1 + ' / ' + c2 : c1) : '';
    }
    if (field === 'account') return document.getElementById('bulkAccount').value;
    if (field === 'type') return document.getElementById('bulkType').value;
    var idMap = { project: 'bulkProject', party: 'bulkParty', reimburser: 'bulkReimburser' };
    return (document.getElementById(idMap[field]).value || '').trim();
  }
  function applyBulkSet(field, value) {
    var list = all(); var n = 0;
    list.forEach(function (t) {
      if (state.selIds[t.id]) { t[field] = value; n++; }
    });
    FW.db.saveList(KEY, list);
    FW.toast('已批量更新 ' + n + ' 条流水的「' + BULK_FIELDS[field] + '」');
  }
  function openBulkSet() {
    var ids = Object.keys(state.selIds);
    if (!ids.length) { FW.toast('请先勾选要修改的流水'); return; }
    var fieldOpts = Object.keys(BULK_FIELDS).map(function (k) { return '<option value="' + k + '">' + BULK_FIELDS[k] + '</option>'; }).join('');
    var body =
      '<div class="muted" style="font-size:12px;margin-bottom:10px">将把选中的 <b>' + ids.length + '</b> 条流水统一设置某个字段（其它字段保持不变）。</div>' +
      '<div class="field"><label>要设置的字段</label><select id="bulkField">' + fieldOpts + '</select></div>' +
      '<div id="bulkFieldInput">' + bulkFieldInputHtml('category') + '</div>' +
      '<div class="form-actions"><button class="btn ghost" id="bkSetCancel">取消</button><button class="btn" id="bkSetGo">应用修改</button></div>';
    FW.openModal('批量设置字段值', body, function () {
      bindBulkCat1();
      var fsel = document.getElementById('bulkField');
      fsel.onchange = function () {
        document.getElementById('bulkFieldInput').innerHTML = bulkFieldInputHtml(this.value);
        if (this.value === 'category') bindBulkCat1();
      };
      document.getElementById('bkSetCancel').onclick = FW.closeModal;
      document.getElementById('bkSetGo').onclick = function () {
        var field = fsel.value;
        var val = readBulkValue(field);
        if ((field === 'category' || field === 'account') && !val) { FW.toast('请选择' + BULK_FIELDS[field]); return; }
        if ((field === 'project' || field === 'party' || field === 'reimburser') && !val) { FW.toast('请输入' + BULK_FIELDS[field]); return; }
        applyBulkSet(field, val);
        FW.closeModal(); render();
      };
    });
  }
  function shiftDate(d, n) {
    var m = (d || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return d;
    var dt = new Date(+m[1], +m[2] - 1, +m[3]);
    dt.setDate(dt.getDate() + n);
    var y = dt.getFullYear(), mo = dt.getMonth() + 1, da = dt.getDate();
    return y + '-' + (mo < 10 ? '0' + mo : mo) + '-' + (da < 10 ? '0' + da : da);
  }
  function openBulkDate() {
    var ids = Object.keys(state.selIds);
    if (!ids.length) { FW.toast('请先勾选要修改的流水'); return; }
    var body =
      '<div class="muted" style="font-size:12px;margin-bottom:10px">将把选中的 <b>' + ids.length + '</b> 条流水的日期统一偏移（正数后移，负数前移）。</div>' +
      '<div class="field"><label>偏移天数（如 7 或 -3）</label><input id="bulkDays" type="number" value="0"></div>' +
      '<div class="form-actions"><button class="btn ghost" id="bkDateCancel">取消</button><button class="btn" id="bkDateGo">应用</button></div>';
    FW.openModal('批量调整日期', body, function () {
      document.getElementById('bkDateCancel').onclick = FW.closeModal;
      document.getElementById('bkDateGo').onclick = function () {
        var n = parseInt(document.getElementById('bulkDays').value, 10);
        if (isNaN(n) || n === 0) { FW.toast('请输入非零整数天数'); return; }
        var list = all(); var c = 0;
        list.forEach(function (t) { if (state.selIds[t.id]) { t.date = shiftDate(t.date, n); c++; } });
        FW.db.saveList(KEY, list);
        FW.closeModal(); render();
        FW.toast('已调整 ' + c + ' 条流水的日期（' + (n > 0 ? '+' : '') + n + ' 天）');
      };
    });
  }
  function openBulkDelete() {
    var ids = Object.keys(state.selIds);
    if (!ids.length) { FW.toast('请先勾选要删除的流水'); return; }
    if (!confirm('确定删除选中的 ' + ids.length + ' 条流水吗？\n（将同时删除它们的凭证照片，不可恢复！）')) return;
    var list = all();
    list.forEach(function (t) { if (state.selIds[t.id] && t.photos && t.photos.length) { try { FW.db.deletePhotos(t.photos); } catch (e) {} } });
    var kept = list.filter(function (t) { return !state.selIds[t.id]; });
    FW.db.saveList(KEY, kept);
    state.selIds = {};
    render();
    FW.toast('已删除 ' + ids.length + ' 条流水');
  }

  function typeLabel(t) {
    if (t.type === 'income') return '收入';
    if (t.type === 'expense') return '支出';
    if (t.type === 'refund') return '退款收入';
    if (t.type === 'transfer') return '账户互转';
    if (t.type === 'equity') return (t.equityDir === 'out' ? '股本抽回' : '股本注入');
    if (t.type === 'dividend') return '股东分红';
    return t.type || '';
  }
  function exportTable() {
    var rows = filteredRows();
    if (!rows.length) { FW.toast('没有可导出的流水'); return; }
    var head = ['日期', '类型', '项目', '分类', '账户', '金额', '已扣支出', '实际收入', '备注', '凭证数', '对方单位/个人', '报销人', '是否影响收支'];
    var data = rows.map(function (t) {
      var dv = (t.type === 'income' && t.deduct > 0) ? t.deduct : 0;
      return [t.date, typeLabel(t), txProjectText(t), t.category || '', accountOf(t), t.amount, dv, dv ? (t.amount + dv) : '', (t.remark || '').replace(/[\r\n]+/g, ' '), (t.photos ? t.photos.length : 0), t.party || '', t.reimburser || '', (t.type === 'income' || t.type === 'expense' || t.type === 'refund') ? '是' : '否'];
    });
    var csv = '﻿' + [head].concat(data).map(function (r) {
      return r.map(function (c) { return '"' + String(c).replace(/"/g, '""') + '"'; }).join(',');
    }).join('\r\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '内账流水_' + FW.today() + '.csv';
    a.click();
    FW.toast('已导出 ' + rows.length + ' 笔流水（CSV）');
  }

  // 导出为图片（PNG）：用原生 Canvas 把手绘成一张明细图，给老板看 / 分享最直观
  function exportImage() {
    var rows = filteredRows();
    if (!rows.length) { FW.toast('没有可导出的流水'); return; }
    if (!window.FWTableImg) { FW.toast('图片导出组件未加载，请刷新页面后重试'); return; }
    var f = state.filter;
    var rng = (f.from || f.to) ? ((f.from || '…') + ' 至 ' + (f.to || '…')) : '全部期间';
    var scope = [];
    if (f.account) scope.push('账户：' + f.account);
    if (f.project) scope.push('项目：' + f.project);
    if (f.type) scope.push('类型：' + ({ income: '收入', expense: '支出', refund: '退款收入', transfer: '账户互转', equity: '股本', dividend: '股东分红' }[f.type] || f.type));
    if (f.kw) scope.push('关键词：' + f.kw);
    var inc = 0, exp = 0, n = rows.length;
    rows.forEach(function (t) {
      var a = Number(t.amount) || 0;
      if (t.type === 'income' || t.type === 'refund' || (t.type === 'equity' && t.equityDir === 'in')) inc += a;
      else if (t.type === 'expense' || (t.type === 'equity' && t.equityDir === 'out')) exp += a;
    });
    // 导出图片的列 = 界面流水表（去掉「操作」列），列顺序 / 标签 / 列宽 与界面逐一对齐（用户要「和界面排版一样」）
    var ec = txExportColumns();
    var EXPORT_COL_IDS = ec.ids;
    var head = ec.labels;
    var amountCol = EXPORT_COL_IDS.indexOf('amount'); // 5
    var imgCol = EXPORT_COL_IDS.indexOf('voucher');   // 7
    var remarkIdx = EXPORT_COL_IDS.indexOf('remark'); // 6
    var colWidths = txExportColWidths(EXPORT_COL_IDS);
    // 凭证列在图片里放原图，给个保底最小宽度（避免缩太窄看不清）
    colWidths[imgCol] = Math.max(colWidths[imgCol], 160);
    // 金额列保底：装下最长金额 "-¥999,999.99"（约 100px），避免列被压窄后金额被迫折行成 4 行（与屏幕里被 cell 撑大的观感不一致）
    colWidths[amountCol] = Math.max(colWidths[amountCol], 100);
    var accountCol = EXPORT_COL_IDS.indexOf('account');
    var outRows = rows.map(function (t) {
      var a = Number(t.amount) || 0;
      var cls = 'neutral', sign = '';
      if (t.type === 'income' || t.type === 'refund' || (t.type === 'equity' && t.equityDir === 'in')) { cls = 'income'; sign = '+'; }
      else if (t.type === 'expense' || (t.type === 'equity' && t.equityDir === 'out')) { cls = 'expense'; sign = '−'; }
      var acct = accountOf(t);
      var cellById = {
        date: t.date,
        type: typeLabel(t),
        project: txProjectText(t),
        category: t.category || '',
        account: acct,
        amount: sign + FW.fmtMoney(a),
        remark: (t.remark || '').replace(/[\r\n]+/g, ' '),
        voucher: '',
        party: t.party || '',
        reimburser: t.reimburser || ''
      };
      var cellColors = new Array(EXPORT_COL_IDS.length).fill(null);
      if (accountCol >= 0) cellColors[accountCol] = accColor(acct);
      return { cells: EXPORT_COL_IDS.map(function (id) { return cellById[id] != null ? cellById[id] : ''; }), amountCls: cls, cellColors: cellColors };
    });
    // 按账户收支副表（与打印视图 / Excel 导出同一套算子：buildAccMap / startBalanceMap / balMapAt）
    var accMap = buildAccMap(rows);
    var startBal = startBalanceMap(f), endBal = balMapAt(f.to || FW.today());
    var accKeys = Object.keys(accMap).sort(function (a, b) {
      return (accMap[b].income + accMap[b].expense + Math.abs(accMap[b].transfer || 0)) - (accMap[a].income + accMap[a].expense + Math.abs(accMap[a].transfer || 0));
    });
    var accRows = [], aInc = 0, aExp = 0, aStart = 0, aEnd = 0, aXfer = 0;
    var accRowColors = [];  // 与 accRows 逐行对齐：账户名专属颜色（合计行用 null 保持中性）
    accKeys.forEach(function (k) {
      var v = accMap[k];
      var s = startBal[k] || 0, e = endBal[k] || 0;
      accRows.push([k, FW.fmtMoney(s), FW.fmtMoney(v.income), FW.fmtMoney(v.expense), FW.fmtMoney(v.transfer || 0), FW.fmtMoney(e)]);
      accRowColors.push(accColor(k));
      aInc += v.income; aExp += v.expense; aStart += s; aEnd += e; aXfer += (v.transfer || 0);
    });
    accRows.push(['合计（' + accKeys.length + ' 账户）', FW.fmtMoney(aStart), FW.fmtMoney(aInc), FW.fmtMoney(aExp), FW.fmtMoney(aXfer), FW.fmtMoney(aEnd)]);
    accRowColors.push(null);
    var subtable = {
      title: '按账户（收支维度）',
      note: '注：区间期初 = 筛选开始前的账户余额；区间期末余额 = 区间期初 + 收入 − 支出 + 互转 + 股本净变动，即筛选期末的真实账户余额（含期初、账户互转与股本变动）。互转 = 转入 − 转出（账户互转净头寸），单列不影响收支。',
      head: ['账户', '区间期初', '收入', '支出', '互转（转入−转出）', '区间期末余额'],
      rows: accRows,
      rowColors: accRowColors,
      colWidths: [276, 258, 232, 232, 264, 290],
      rightCols: [1, 2, 3, 4, 5],
      colCls: ['neutral', 'signed', 'income', 'expense', 'signed', 'signed'],
      totalRow: true,
      headerH: 50
    };
    // 凭证图（JPEG dataURL，来自 IndexedDB，绘制不会污染 canvas），按行下标归集
    var pics = {};
    var tasks = [];
    rows.forEach(function (t, ri) {
      (t.photos || []).filter(Boolean).forEach(function (pid) {
        tasks.push(FW.db.getPhoto(pid)
          .then(function (d) { return d ? shrinkPhotoForXlsx(d) : null; })
          .then(function (r) { return r ? { ri: ri, dataUrl: r.dataUrl } : null; })
          .catch(function () { return null; }));
      });
    });
    function buildImgConfig(picMap, fs, scaledColWidths, opts) {
      opts = opts || {};
      var baseCW = scaledColWidths || colWidths;
      var cw = baseCW.slice();
      // 备注列（索引 remarkIdx）单独调宽：覆盖缩放后的备注列宽
      if (opts.remarkW != null) cw[remarkIdx] = opts.remarkW;
      // 凭证大小（picScale）：同步放大凭证「列宽」与「图显示尺寸」，视觉一致
      var picScale = (opts.picScale != null) ? opts.picScale : 1;
      if (picScale !== 1) cw[imgCol] = Math.round(baseCW[imgCol] * picScale);
      function pad2(n) { return (n < 10 ? '0' : '') + n; }
      var d = new Date();
      var stamp = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
      return {
        title: '内账流水明细',
        eyebrow: '财务工作台 · 内账流水',
        subtitle: '账套：' + ledgerName() + '　|　期间：' + rng + (scope.length ? '　|　' + scope.join('，') : '') + '　|　导出日期：' + FW.today(),
        footer: '由 财务工作台 导出 · ' + stamp + ' · 仅供内部参考',
        kpis: [
          { label: '笔数', value: String(n) },
          { label: '收入合计', value: FW.fmtMoney(inc), cls: 'income' },
          { label: '支出合计', value: FW.fmtMoney(exp), cls: 'expense' },
          { label: '区间收支合计', value: FW.fmtMoney(inc - exp) }
        ],
        head: head, rows: opts.rows || outRows, colWidths: cw,
        amountCol: amountCol, imgCol: imgCol, amountAlign: 'left',
        bigCols: [0, 1, 2, 3, 4], typeCol: 1,   // 明细加大列（日期/类型/项目/分类/账户）与「类型」列，导出字号/加粗同步界面
        pics: picMap || {},
        picMaxW: 220 * picScale, picMaxH: 130 * picScale,
        gap: 8,
        fontScale: fs || 1,
        subtable: subtable
      };
    }

    FW.toast('正在准备导出图片，请稍候…');
    Promise.all(tasks).then(function (list) {
      list.forEach(function (it) {
        if (!it) return;
        if (!pics[it.ri]) pics[it.ri] = [];
        pics[it.ri].push(it.dataUrl);
      });
      promptFontSize(pics, n);
    }).catch(function () {
      FW.toast('凭证图片处理失败，已生成不含凭证图的导出');
      promptFontSize({}, n);
    });

    // 导出图片弹窗：字号 / 宽度 / 备注列宽 / 凭证大小 四个滑块 + 实时预览
    function promptFontSize(pics, n) {
      var bodyHtml =
        '<div class="tx-prev">' +
          '<div class="tx-prev-bar">' +
            '<label class="tx-size-label">导出字号：' +
              '<input type="range" id="picSizeRange" min="14" max="48" step="1" value="23">' +
              '<span id="picSizeVal" class="tx-size-val">23px</span>' +
            '</label>' +
            '<label class="tx-size-label">图片宽度：' +
              '<input type="number" id="picWidthRange" min="800" max="2400" step="32" value="1552" style="width:90px">' +
              '<span class="muted">px（800–2400）</span>' +
            '</label>' +
            '<label class="tx-size-label">备注列宽：' +
              '<input type="range" id="remarkWRange" min="80" max="400" step="10" value="148">' +
              '<span id="remarkWVal" class="muted">' + Math.round(colWidths[remarkIdx]) + '</span>' +
            '</label>' +
            '<label class="tx-size-label">凭证大小：' +
              '<input type="range" id="picScaleRange" min="0.6" max="1.6" step="0.05" value="1">' +
              '<span id="picScaleVal" class="muted">1.0x</span>' +
            '</label>' +
            '<span class="muted">（仅影响导出图片，不改原始数据）</span>' +
            '<span class="tx-prev-spacer"></span>' +
          '</div>' +
          '<div class="tx-msg" id="txMsg" style="min-height:18px;margin:2px 0;color:#C8102E;font-size:13px;"></div>' +
          '<div class="tx-prev-canvas" id="txPrevCanvasWrap"><div class="tx-prev-empty">预览生成中…</div></div>' +
          '<div class="form-actions">' +
            '<button type="button" class="btn ghost" id="prevCancel">取消</button>' +
            '<button type="button" class="btn" id="prevDownload">导出 PNG</button>' +
          '</div>' +
        '</div>';
      FW.openModal('导出图片（调整字号 / 宽度 / 备注列宽 / 凭证大小，实时预览）', bodyHtml, function (body) {
        var range = body.querySelector('#picSizeRange');
        var valEl = body.querySelector('#picSizeVal');
        var width = body.querySelector('#picWidthRange');
        var msg = body.querySelector('#txMsg');
        var cancel = body.querySelector('#prevCancel');
        var dl = body.querySelector('#prevDownload');
        var remarkR = body.querySelector('#remarkWRange');
        var remarkVal = body.querySelector('#remarkWVal');
        var picScaleR = body.querySelector('#picScaleRange');
        var picScaleVal = body.querySelector('#picScaleVal');
        var prevWrap = body.querySelector('#txPrevCanvasWrap');
        var busy = false;
        // 宽度滑块默认 = 真实渲染总宽，使 scale 默认≈1（导出与界面 1:1 对齐）
        var _dtw = colWidths.reduce(function (s, w) { return s + w; }, 0);
        if (width) width.value = String(Math.min(2400, Math.max(800, Math.round(_dtw))));
        if (remarkR) remarkR.value = String(Math.round(colWidths[remarkIdx]));
        // 计算配置：预览用前 N 行 + 对应凭证图；下载用完整
        function computeCfg(rows, picMap) {
          var px = parseInt(range ? range.value : '23', 10) || 23;
          var fs = px / 17;
          var defaultTotalW = colWidths.reduce(function (s, w) { return s + w; }, 0);
          var userW = parseInt(width ? width.value : String(defaultTotalW), 10);
          if (!isFinite(userW) || userW < 800) userW = 800;
          if (userW > 2400) userW = 2400;
          var scale = userW / defaultTotalW;
          var scaledColWidths = colWidths.map(function (w) { return Math.round(w * scale); });
          var remarkW = parseInt(remarkR ? remarkR.value : String(colWidths[remarkIdx]), 10);
          var picScale = parseFloat(picScaleR ? picScaleR.value : '1') || 1;
          return buildImgConfig(picMap, fs, scaledColWidths, { rows: rows, remarkW: remarkW, picScale: picScale });
        }
        // 实时预览：只渲染前 N 行 + KPI + 副表（布局真实且轻量），滑块变化后防抖重绘
        var PREVIEW_ROWS = 8;
        var previewTimer = null;
        function doPreview() {
          if (busy || !prevWrap) return;
          var prows = outRows.slice(0, PREVIEW_ROWS);
          var ppics = {};
          Object.keys(pics).forEach(function (k) {
            if (parseInt(k, 10) < PREVIEW_ROWS) ppics[k] = pics[k];
          });
          var cfg = computeCfg(prows, ppics);
          if (msg) msg.textContent = '预览生成中…';
          Promise.resolve().then(function () { return window.FWTableImg.render(cfg); }).then(function (canvas) {
            if (!prevWrap) return;
            prevWrap.innerHTML = '';
            canvas.style.maxWidth = 'none';
            prevWrap.appendChild(canvas);
            if (msg) msg.textContent = '';
          }).catch(function (err) {
            console.error('[导出图片] 预览失败：', err);
            if (prevWrap) prevWrap.innerHTML = '<div class="tx-prev-empty">预览失败：' + (err && err.message ? err.message : err) + '</div>';
            if (msg) msg.textContent = '';
          });
        }
        function schedulePreview() {
          if (previewTimer) clearTimeout(previewTimer);
          previewTimer = setTimeout(doPreview, 200);
        }
        function onAnyInput() {
          if (valEl) valEl.textContent = (range ? range.value : 23) + 'px';
          if (remarkVal) remarkVal.textContent = remarkR ? remarkR.value : '';
          if (picScaleVal) picScaleVal.textContent = (parseFloat(picScaleR ? picScaleR.value : '1') || 1).toFixed(1) + 'x';
          schedulePreview();
        }
        if (range) range.oninput = onAnyInput;
        if (width) width.oninput = onAnyInput;
        if (remarkR) remarkR.oninput = onAnyInput;
        if (picScaleR) picScaleR.oninput = onAnyInput;
        if (cancel) cancel.onclick = FW.closeModal;
        schedulePreview();  // 打开弹窗即出预览
        if (dl) dl.onclick = function () {
          if (busy) return;
          var px = parseInt(range ? range.value : '23', 10) || 23;
          var fs = px / 17;
          var defaultTotalW = colWidths.reduce(function (s, w) { return s + w; }, 0);
          var userW = parseInt(width ? width.value : String(defaultTotalW), 10);
          if (!isFinite(userW) || userW < 800) userW = 800;
          if (userW > 2400) userW = 2400;
          var scale = userW / defaultTotalW;
          var scaledColWidths = colWidths.map(function (w) { return Math.round(w * scale); });
          var remarkW = parseInt(remarkR ? remarkR.value : String(colWidths[remarkIdx]), 10);
          var picScale = parseFloat(picScaleR ? picScaleR.value : '1') || 1;
          busy = true; if (dl) dl.disabled = true; if (cancel) cancel.disabled = true;
          if (msg) msg.textContent = '正在生成图片…';
          // 防御：buildImgConfig / render 任何同步或异步异常都捕获并上屏
          var cfg;
          try {
            cfg = buildImgConfig(pics, fs, scaledColWidths, { rows: outRows, remarkW: remarkW, picScale: picScale });
          } catch (e) {
            console.error('[导出图片] 构建配置失败：', e);
            if (msg) msg.textContent = '构建配置失败：' + (e && e.message ? e.message : e);
            busy = false; if (dl) dl.disabled = false; if (cancel) cancel.disabled = false;
            return;
          }
          Promise.resolve().then(function () {
            return window.FWTableImg.render(cfg);
          }).then(function (canvas) {
            var picN = Object.keys(pics).reduce(function (s, k) { return s + pics[k].length; }, 0);
            var fname = '内账流水' + (picN ? '_含凭证' : '') + '_' + FW.today() + '.png';
            window.FWTableImg.downloadPNG(canvas, fname);
            FW.toast('已导出图片（' + n + ' 笔' + (picN ? '，含 ' + picN + ' 张凭证图' : '') + '）');
            FW.closeModal();
          }).catch(function (err) {
            console.error('[导出图片] 渲染/下载失败：', err);
            if (msg) msg.textContent = '导出失败：' + (err && err.message ? err.message : err) + '（可按 F12 看 console）';
            busy = false; if (dl) dl.disabled = false; if (cancel) cancel.disabled = false;
          });
        };
      });
    }
  }

  // ===== Excel 凭证图片嵌入 =====
  var XPIC_STORE_MAX = 700;  // 写进 Excel 的图片最大边（px）：兼顾放大看清与文件体积
  var XPIC_DISP_H = 96;      // 表格中显示高度（px）
  var XPIC_DISP_MAXW = 220;  // 超宽图的宽度上限（px）
  var XPIC_ROW_HPT = 78;     // 带图行的行高（pt）≈ 104px，给 96px 图留余量

  // 缩放并转 JPEG：凭证原图常有几 MB，直接嵌入会让 Excel 体积失控
  function shrinkPhotoForXlsx(dataUrl) {
    return new Promise(function (res) {
      var im = new Image();
      var done = false;
      function finish(v) { if (done) return; done = true; clearTimeout(tmo); res(v); }
      // 兜底超时：部分图（HEIC/损坏 JPEG）在浏览器里 onload/onerror 都不触发
      var tmo = setTimeout(function () {
        console.warn('[shrinkPhotoForXlsx] 凭证原图加载超时 8s,跳过');
        finish(null);
      }, 8000);
      im.onload = function () {
        var w = im.naturalWidth || im.width, h = im.naturalHeight || im.height;
        if (!w || !h) { finish(null); return; }
        var sc = Math.min(1, XPIC_STORE_MAX / Math.max(w, h));
        var cw = Math.max(1, Math.round(w * sc)), ch = Math.max(1, Math.round(h * sc));
        try {
          var cv = document.createElement('canvas');
          cv.width = cw; cv.height = ch;
          var ctx = cv.getContext('2d');
          ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cw, ch); // 透明 PNG 转 JPEG 会发黑，先铺白底
          ctx.drawImage(im, 0, 0, cw, ch);
          finish({ dataUrl: cv.toDataURL('image/jpeg', 0.82), w: w, h: h });
        } catch (e) {
          console.warn('[shrinkPhotoForXlsx] 绘制/导出失败:', e);
          finish(null);
        }
      };
      im.onerror = function () { finish(null); };
      try { im.src = dataUrl; } catch (e) {
        console.warn('[shrinkPhotoForXlsx] 赋值 src 抛异常:', e);
        finish(null);
      }
    });
  }

  function dataUrlToBytes(d) {
    var i = String(d || '').indexOf(',');
    if (i < 0) return null;
    try {
      var bin = atob(d.slice(i + 1));
      var u = new Uint8Array(bin.length);
      for (var k = 0; k < bin.length; k++) u[k] = bin.charCodeAt(k);
      return u;
    } catch (e) { return null; }
  }

  // 按「行下标」归集凭证图（与打印视图同口径，流水无 id 也不会串行）
  function collectPicsByRow(rows) {
    var tasks = [];
    rows.forEach(function (t, ri) {
      (t.photos || []).filter(Boolean).forEach(function (pid) {
        tasks.push(FW.db.getPhoto(pid)
          .then(function (d) { return d ? shrinkPhotoForXlsx(d) : null; })
          .then(function (r) {
            if (!r) return null;
            var bytes = dataUrlToBytes(r.dataUrl);
            return bytes ? { ri: ri, bytes: bytes, w: r.w, h: r.h } : null;
          })
          .catch(function () { return null; }));
      });
    });
    return Promise.all(tasks).then(function (list) {
      var map = {};
      list.forEach(function (r) {
        if (!r) return;
        if (!map[r.ri]) map[r.ri] = [];
        map[r.ri].push(r);
      });
      return map;
    });
  }

  // 导出真正的 Excel（.xlsx）：金额列为数值，便于老板在 WPS/Excel 直接求和、筛选
  function exportXLSX(withPics) {
    var rows = filteredRows();
    if (!rows.length) { FW.toast('没有可导出的流水'); return; }
    if (!window.XLSX) { FW.toast('Excel 导出组件未加载，请刷新页面后重试'); return; }
    if (!withPics) { buildXLSX(rows, null); return; }
    if (!window.FWXlsxPic) { FW.toast('凭证嵌入组件未加载，请刷新页面后重试'); return; }
    var total = rows.reduce(function (s, t) { return s + (t.photos || []).filter(Boolean).length; }, 0);
    if (!total) { FW.toast('所选流水没有凭证图片，已按普通 Excel 导出'); buildXLSX(rows, null); return; }
    FW.toast('正在处理 ' + total + ' 张凭证图片，请稍候…');
    collectPicsByRow(rows).then(function (picMap) {
      buildXLSX(rows, picMap);
    }).catch(function () {
      FW.toast('凭证图片处理失败，已导出不含图片的 Excel');
      buildXLSX(rows, null);
    });
  }

  function buildXLSX(rows, picMap) {
    var x = window.XLSX;
    var withPics = !!(picMap && Object.keys(picMap).length);
    var head = ['日期', '类型', '项目', '分类', '账户', '金额', '已扣支出', '实际收入', '备注', '凭证数', '对方单位/个人', '报销人', '是否影响收支'];
    if (withPics) head.push('凭证图');
    var aoa = [head];
    var sumInc = 0, sumExp = 0;
    rows.forEach(function (t) {
      var dv = (t.type === 'income' && t.deduct > 0) ? t.deduct : 0;
      var amt = Number(t.amount) || 0;
      if (t.type === 'income' || t.type === 'refund' || (t.type === 'equity' && t.equityDir === 'in')) sumInc += amt;
      else if (t.type === 'expense' || (t.type === 'equity' && t.equityDir === 'out')) sumExp += amt;
      var line = [
        t.date, typeLabel(t), txProjectText(t), t.category || '', accountOf(t), amt, dv, dv ? (t.amount + dv) : '',
        (t.remark || '').replace(/[\r\n]+/g, ' '), (t.photos ? t.photos.length : 0), t.party || '', t.reimburser || '',
        (t.type === 'income' || t.type === 'expense' || t.type === 'refund') ? '是' : '否'
      ];
      if (withPics) line.push('');
      aoa.push(line);
    });
    // 合计行
    var totalLine = ['', '合计（' + rows.length + ' 笔）', '', '', '', sumInc - sumExp, '', '', '收入 ' + FW.fmtMoney(sumInc) + ' ／ 支出 ' + FW.fmtMoney(sumExp), '', '', '', ''];
    if (withPics) totalLine.push('');
    aoa.push(totalLine);
    var wb = x.utils.book_new();
    var ws = x.utils.aoa_to_sheet(aoa);
    // 列宽与屏幕调整一致：Excel 列按语义映射到屏幕宽度（px→wch ≈ /7.5），Excel 专属列给固定默认
    var XLSX_COL_IDS = ['date', 'type', 'project', 'category', 'account', 'amount', null, null, 'remark', null, 'party', 'reimburser', null];
    var XLSX_COL_DEF = { 6: 10, 7: 12, 9: 8, 12: 12 }; // 已扣支出/实际收入/凭证数/是否影响收支
    var px = screenColPx();
    // 金额列保底 wch=14（约 105px），装得下最宽金额 "-¥999,999.99"；用户拖到接近下限 20px 时也不会被压成 "####"
    var amountMinWch = 14;
    var cols = XLSX_COL_IDS.map(function (id, idx) {
      if (id == null) return { wch: XLSX_COL_DEF[idx] != null ? XLSX_COL_DEF[idx] : 12 };
      var i = TX_COL_IDS.indexOf(id);
      var wch = Math.max(4, Math.round(px[i] / 7.5));
      if (id === 'amount') wch = Math.max(wch, amountMinWch);
      return { wch: wch };
    });
    // 凭证图列：图片自该列起向右铺开（右侧无数据，不会遮挡）
    var pics = [];
    if (withPics) {
      cols.push({ wch: 32 });
      var rowsMeta = [{}];
      rows.forEach(function (t, ri) { rowsMeta.push(picMap[ri] ? { hpt: XPIC_ROW_HPT } : {}); });
      ws['!rows'] = rowsMeta;
      pics = window.FWXlsxPic.layoutRowPics(picMap, {
        col: head.length - 1,   // 凭证图列（最后一列），图片自此向右铺开
        rowBase: 1,             // 第 0 行是表头
        dispH: XPIC_DISP_H,
        maxW: XPIC_DISP_MAXW
      });
    }
    ws['!cols'] = cols;
    // 与界面流水一致：日期/类型/项目/分类/账户 加大字号（13pt），收入/支出（含退款收入）加粗；金额恒加粗左对齐
    var xlAmtIdx = head.indexOf('金额');
    var xlBigCols = [0, 1, 2, 3, 4];
    var xlTypeCol = 1;
    var BIG_FONT_SZ = 13;
    for (var ri = 1; ri < aoa.length; ri++) {
      var t = rows[ri - 1];   // aoa 第 0 行是表头，数据行与 rows 对齐
      var incExp = !!(t && (t.type === 'income' || t.type === 'expense' || t.type === 'refund'));
      xlBigCols.forEach(function (ci) {
        var caddr = x.utils.encode_cell({ r: ri, c: ci });
        var cell = ws[caddr];
        if (!cell) return;
        cell.s = cell.s || {};
        cell.s.font = cell.s.font || {};
        cell.s.font.sz = BIG_FONT_SZ;
        if (ci === xlTypeCol && incExp) cell.s.font.bold = true;
      });
      if (xlAmtIdx >= 0) {
        var aaddr = x.utils.encode_cell({ r: ri, c: xlAmtIdx });
        var acell = ws[aaddr];
        if (acell) {
          acell.s = acell.s || {};
          acell.s.font = acell.s.font || {};
          acell.s.font.bold = true;
          acell.s.alignment = acell.s.alignment || { horizontal: 'left', vertical: 'center' };
        }
      }
    }
    x.utils.book_append_sheet(wb, ws, '内账流水');
    // 第二张表：按账户收支（老板视角），含区间期初与区间期末余额
    var f = state.filter;
    var accMap = buildAccMap(rows);
    var startBal = startBalanceMap(f), endBal = balMapAt(f.to || FW.today());
    var accKeys = Object.keys(accMap).sort(function (a, b) { return (accMap[b].income + accMap[b].expense + Math.abs(accMap[b].transfer || 0)) - (accMap[a].income + accMap[a].expense + Math.abs(accMap[a].transfer || 0)); });
    var accAoa = [['账户', '区间期初', '收入', '支出', '互转（转入−转出）', '区间收支合计', '区间期末余额']];
    var accSumInc = 0, accSumExp = 0, accSumStart = 0, accSumEnd = 0, accSumXfer = 0;
    accKeys.forEach(function (k) {
      var v = accMap[k];
      var s = startBal[k] || 0, e = endBal[k] || 0;
      accAoa.push([k, s, v.income, v.expense, v.transfer || 0, v.income - v.expense, e]);
      accSumInc += v.income; accSumExp += v.expense; accSumStart += s; accSumEnd += e; accSumXfer += (v.transfer || 0);
    });
    accAoa.push(['合计（' + accKeys.length + ' 账户）', accSumStart, accSumInc, accSumExp, accSumXfer, accSumInc - accSumExp, accSumEnd]);
    var ws2 = x.utils.aoa_to_sheet(accAoa);
    ws2['!cols'] = [{ wch: 22 }, { wch: 16 }, { wch: 14 }, { wch: 14 }, { wch: 16 }, { wch: 18 }, { wch: 16 }];
    x.utils.book_append_sheet(wb, ws2, '按账户收支');
    var u8 = new Uint8Array(x.write(wb, { bookType: 'xlsx', type: 'array', cellStyles: true }));
    // SheetJS 社区版不支持写图，这里把凭证图注入到它生成的 zip 包里
    var picCount = 0;
    if (pics.length) {
      var injected = window.FWXlsxPic.injectPics(u8, 'xl/worksheets/sheet1.xml', pics);
      if (injected) { u8 = injected; picCount = pics.length; }
      else FW.toast('凭证嵌入失败，已导出不含图片的 Excel');
    }
    var blob = new Blob([u8], { type: 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = '内账流水' + (picCount ? '_含凭证' : '') + '_' + FW.today() + '.xlsx';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    FW.toast(picCount
      ? ('已导出 Excel（' + rows.length + ' 笔，含 ' + picCount + ' 张凭证图）')
      : ('已导出 Excel（' + rows.length + ' 笔）'));
  }

  // 打印 / 转 PDF：打开一个格式化、带期间与汇总的「流水明细表」，老板可直接看或打印/存 PDF
  function ledgerName() {
    try {
      var id = FW.db.getCurrentLedger();
      var list = FW.db.getLedgers() || [];
      var l = list.filter(function (xx) { return xx.id === id; })[0];
      return (l && l.name) ? l.name : '默认账套';
    } catch (e) { return '当前账套'; }
  }
  function openPrintView() {
    var rows = filteredRows();
    if (!rows.length) { FW.toast('没有可打印的流水'); return; }
    var f = state.filter;
    var rng = (f.from || f.to) ? ((f.from || '…') + ' 至 ' + (f.to || '…')) : '全部期间';
    var scope = [];
    if (f.account) scope.push('账户：' + f.account);
    if (f.project) scope.push('项目：' + f.project);
    if (f.type) scope.push('类型：' + ({ income: '收入', expense: '支出', refund: '退款收入', transfer: '账户互转', equity: '股本', dividend: '股东分红' }[f.type] || f.type));
    if (f.kw) scope.push('关键词：' + f.kw);
    var inc = 0, exp = 0;
    rows.forEach(function (t) {
      var a = Number(t.amount) || 0;
      if (t.type === 'income' || t.type === 'refund' || (t.type === 'equity' && t.equityDir === 'in')) inc += a;
      else if (t.type === 'expense' || (t.type === 'equity' && t.equityDir === 'out')) exp += a;
    });
    function amtCell(t) {
      var a = Number(t.amount) || 0;
      var cls = 'num', sign = '';
      if (t.type === 'income' || t.type === 'refund' || (t.type === 'equity' && t.equityDir === 'in')) { cls += ' income'; sign = '+'; }
      else if (t.type === 'expense' || (t.type === 'equity' && t.equityDir === 'out')) { cls += ' expense'; sign = '−'; }
      else { cls += ' neutral'; }
      return '<td class="' + cls + '" style="text-align:left">' + sign + FW.fmtMoney(a) + '</td>';
    }
    var subLine = '账套：' + FW.esc(ledgerName()) + '　|　期间：' + FW.esc(rng) + (scope.length ? '　|　' + FW.esc(scope.join('，')) : '') + '　|　导出日期：' + FW.today();
    var titleBlock =
        '<h2>内账流水明细</h2>' +
        '<div class="fp-sub">' + subLine + '</div>' +
        '<div class="fp-kpis">' +
          '<div class="fp-kpi">笔数<b>' + rows.length + '</b></div>' +
          '<div class="fp-kpi">收入合计<b class="income">' + FW.fmtMoney(inc) + '</b></div>' +
          '<div class="fp-kpi">支出合计<b class="expense">' + FW.fmtMoney(exp) + '</b></div>' +
          '<div class="fp-kpi">区间收支合计<b>' + FW.fmtMoney(inc - exp) + '</b></div>' +
        '</div>';
    // 每页重复用的紧凑标题（仅报表名 + 账套/期间，不含 KPI，放进明细表 thead 由浏览器自动跨页重复）
    var titleCompact = '<h2 class="fp-run">内账流水明细</h2><div class="fp-sub">' + subLine + '</div>';
    // ec（导出列单一来源）= 界面流水表去掉「操作」列；在 openPrintView 函数作用域声明，
    // 供下方 IIFE（生成表头）与 tbody 的 rows.map 共同使用，避免作用域错位导致点击打印无反应
    var ec = txExportColumns();
    // baseW = 各列基础 px 宽度（屏幕真实渲染宽度），totalW = 列宽之和；
    // 在 openPrintView 作用域声明，供 IIFE（生成表头）与 onMount（列宽滑块缩放）共用
    var baseW = [], totalW = 0;
    var html =
      '<div class="flow-print print-area vsz-m">' +
        '<div class="fp-title" id="fpTitle">' + titleBlock + '</div>' +
        // 按账户收支维度：老板看流水时通常最关心"每个账户赚了/花了多少"
        '<h4 class="fp-h4">按账户（收支维度）</h4>' +
        '<div class="flow-acc-table">' + statTableRows(buildAccMap(rows), '账户', { start: startBalanceMap(f), end: balMapAt(f.to || FW.today()) }, true) + '</div>' +
        '<div class="fp-note">注：区间期初 / 区间期末余额为各账户资金余额（含期初、账户互转与股本变动）。互转 = 转入 − 转出（账户互转净头寸），单列不影响收支；区间期末余额 = 区间期初 + 收入 − 支出 + 互转 + 股本净变动。</div>' +
        '<h4 class="fp-h4">流水明细</h4>' +
        (function () {
          // 打印表列 = 界面流水表（去掉「操作」列），顺序 / 标签 / 列宽与界面逐一对齐（用户要求与界面一致）
          // 改用 table-layout: fixed + 精确内联列宽，列宽由 colgroup 严格决定（不再被浏览器按内容自动重排），
          // 这样「列宽可调」才能真正生效：窄列（凭证 / 分类）不会被挤压竖排
          var ppx = screenColPx();
          baseW = ec.ids.map(function (id) {
            var i = TX_COL_IDS.indexOf(id);
            var w = i >= 0 ? ppx[i] : 100;
            if (id === 'voucher') w = Math.max(w, 150); // 凭证列保底，避免缩太窄
            if (id === 'amount') w = Math.max(w, 100);  // 金额列保底，避免被拖窄后打印/PDF 中金额被折行
            return w;
          });
          // 应用上次拖拽保存的逐列宽度（若存在且与列数一致），否则用屏幕默认宽
          try {
            var savedW = JSON.parse(localStorage.getItem('fw_pref_print_colw') || 'null');
            if (Array.isArray(savedW) && savedW.length === baseW.length) {
              baseW = savedW.map(function (w) { return Math.max(COL_MIN_W, w | 0); });
            }
          } catch (e) {}
          var pc = baseW.map(function (w) { return '<col style="width:' + w + 'px">'; }).join('');
          totalW = baseW.reduce(function (a, b) { return a + b; }, 0);
          // 个别列带特殊样式：金额左对齐、凭证列 / 报销人列固定 class（其余由 ec.labels 驱动，与界面一致）
          var TH_SP = { amount: ' style="text-align:left"', voucher: ' class="fp-vth"', reimburser: ' class="fp-rb"' };
          // 表头 th 带 data-col 与 data-edge；列宽调节改用「表头边缘检测拖拽」（见 onMount 绑定），
          // 不内嵌 absolute 手柄，避免 table-cell 内 absolute 子元素在 border-collapse/fixed 布局下定位失效、抓不到
          var headTh = ec.ids.map(function (id, k) {
            return '<th' + (TH_SP[id] || '') + ' data-col="' + k + '" data-edge="0">' + ec.labels[k] + '</th>';
          }).join('');
          return '<table id="fpDetailTable" style="width:' + totalW + 'px"><colgroup>' + pc + '</colgroup><thead id="fpDetailHead"><tr class="fp-colhead">' + headTh + '</tr></thead><tbody>';
        })() +
        rows.map(function (t, i) {
          var np = (t.photos || []).filter(Boolean).length;
          var vcell = '<td class="fp-vcell" data-vi="' + i + '">' +
            '<span class="fp-vn">' + (np ? np + ' 张' : '—') + '</span>' +
            '<span class="fp-vbox">' + (np ? '<span class="fp-vload">加载中…</span>' : '<span class="fp-vnone">—</span>') + '</span>' +
          '</td>';
          var cells = {
            date: '<td class="fp-detail-big">' + FW.esc(t.date) + '</td>',
            type: '<td class="fp-detail-big' + ((t.type === 'income' || t.type === 'expense' || t.type === 'refund') ? ' fp-type-bold' : '') + '">' + FW.esc(typeLabel(t)) + '</td>',
            project: '<td class="fp-detail-big">' + txProjectLabel(t) + '</td>',
            category: '<td class="fp-detail-big">' + FW.esc(t.category || '') + '</td>',
            account: '<td class="fp-detail-big">' + FW.esc(accountOf(t)) + '</td>',
            amount: amtCell(t),
            remark: '<td>' + FW.esc((t.remark || '').replace(/[\r\n]+/g, ' ')) + '</td>',
            voucher: vcell,
            party: '<td>' + FW.esc(t.party || '') + '</td>',
            reimburser: '<td class="fp-rb">' + FW.esc(t.reimburser || '') + '</td>'
          };
          return '<tr>' + ec.ids.map(function (id) { return cells[id]; }).join('') + '</tr>';
        }).join('') +
        '</tbody></table>' +
      '</div>' +
      '<div class="form-actions no-print" style="margin-top:14px">' +
        '<label class="fp-inc"><input type="checkbox" id="fpTitleEvery"> 每页带标题</label>' +
        '<label class="fp-inc"><input type="checkbox" id="fpIncImg" checked> 包含凭证图片</label>' +
        '<label class="fp-inc">凭证图大小 <select id="fpVSize"><option value="vsz-s">小</option><option value="vsz-m" selected>中</option><option value="vsz-l">大</option></select></label>' +
        '<span class="fp-inc fp-colhint">拖动表头列线可调列宽</span>' +
        '<button class="btn ghost" id="fpResetColW">重置列宽</button>' +
        '<button class="btn" id="fpPrint">🖨 打印 / 保存为 PDF</button>' +
        '<button class="btn ghost" id="fpClose">关闭</button>' +
      '</div>' +
      '<div class="fp-tip no-print">已自动去掉页眉页脚（网址 / 日期 / 页码）。若个别浏览器仍显示，请在打印窗口「更多设置」中取消勾选「页眉和页脚」。</div>';
    FW.openModal('内账流水 · 打印预览', html, function (body) {
      var m = document.querySelector('.modal'); if (m) m.classList.add('modal-wide');
      var pb = body.querySelector('#fpPrint'); if (pb) pb.onclick = function () { setTimeout(function () { window.print(); }, 60); };
      var cb = body.querySelector('#fpClose'); if (cb) cb.onclick = FW.closeModal;
      renderVouchers(body, rows);
      var incChk = body.querySelector('#fpIncImg');
      if (incChk) incChk.onchange = function () { renderVouchers(body, rows); };
      var szSel = body.querySelector('#fpVSize');
      var wrap = body.querySelector('.flow-print');
      if (szSel && wrap) {
        szSel.onchange = function () {
          wrap.classList.remove('vsz-s', 'vsz-m', 'vsz-l');
          wrap.classList.add(szSel.value);
        };
      }
      // 拖拽列边界调整列宽：像 Excel 一样按住表头列与列之间的分隔线左右拖动，单独拉宽/拉窄任意一列，
      // 每列宽度数组持久化到 fw_pref_print_colw，下次打开自动还原。
      var tableEl = body.querySelector('#fpDetailTable');
      var WRAP_K = 'fw_pref_print_colw';
      function persistColW() {
        try { localStorage.setItem(WRAP_K, JSON.stringify(baseW)); } catch (e) {}
      }
      function setColWidth(k, w) {
        w = Math.max(COL_MIN_W, w | 0);
        baseW[k] = w;
        if (!tableEl) return;
        var cols = tableEl.querySelectorAll('colgroup col');
        if (cols[k]) cols[k].style.width = w + 'px';
        var total = baseW.reduce(function (a, b) { return a + b; }, 0);
        tableEl.style.width = total + 'px';
      }
      // 拖拽列边界：鼠标移到某列表头最右 COL_EDGE px 内即高亮右边界 + 显示 col-resize 光标、按下即拖（像 Excel）。
      // 用「表头边缘检测」而非内嵌 absolute 手柄，避开 table-cell 内 absolute 子元素在 border-collapse/fixed 布局下定位失效。
      // 每列宽度数组持久化到 fw_pref_print_colw，下次打开自动还原。
      var headThs = tableEl ? tableEl.querySelectorAll('.fp-colhead th') : [];
      var COL_EDGE = 9; // 边缘感应宽度（px）
      headThs.forEach(function (th) {
        var k = parseInt(th.getAttribute('data-col'), 10);
        if (isNaN(k)) return;
        th.addEventListener('mousemove', function (e) {
          var rect = th.getBoundingClientRect();
          var rel = e.clientX - rect.left;
          if (rect.width > 0 && rel >= rect.width - COL_EDGE) {
            th.style.cursor = 'col-resize';
            th.setAttribute('data-edge', '1');
          } else {
            if (th.style.cursor === 'col-resize') th.style.cursor = '';
            th.setAttribute('data-edge', '0');
          }
        });
        th.addEventListener('mouseleave', function () {
          th.style.cursor = '';
          th.setAttribute('data-edge', '0');
        });
        th.addEventListener('mousedown', function (e) {
          if (th.getAttribute('data-edge') !== '1') return; // 只在边缘才拖，避免误选中表头文字
          e.preventDefault();
          var startX = e.clientX, startW = baseW[k];
          document.body.classList.add('fp-no-select');
          function mm(ev) { setColWidth(k, startW + (ev.clientX - startX)); }
          function mu() {
            document.removeEventListener('mousemove', mm);
            document.removeEventListener('mouseup', mu);
            document.body.classList.remove('fp-no-select');
            persistColW();
          }
          document.addEventListener('mousemove', mm);
          document.addEventListener('mouseup', mu);
          e.stopPropagation();
        });
      });
      // 重置列宽：清空持久化并恢复屏幕默认宽度
      var resetBtn = body.querySelector('#fpResetColW');
      if (resetBtn) {
        resetBtn.onclick = function () {
          try { localStorage.removeItem(WRAP_K); } catch (e) {}
          var ppx = screenColPx();
          baseW = ec.ids.map(function (id) {
            var i = TX_COL_IDS.indexOf(id);
            var w = i >= 0 ? ppx[i] : 100;
            if (id === 'voucher') w = Math.max(w, 150);
            if (id === 'amount') w = Math.max(w, 100);
            return w;
          });
          if (tableEl) {
            var cols = tableEl.querySelectorAll('colgroup col');
            var total = 0;
            baseW.forEach(function (w, k) { if (cols[k]) cols[k].style.width = w + 'px'; total += w; });
            tableEl.style.width = total + 'px';
          }
        };
      }
      var titleChk = body.querySelector('#fpTitleEvery');
      if (titleChk) {
        titleChk.onchange = function () { applyTitleEvery(body); };
        applyTitleEvery(body);
      }
    });

    // 凭证照片直接填进每笔流水所在行右侧的「凭证」列（异步取图，含加密凭证自动解密）
    // 按 rows 的下标定位单元格，避免流水缺少 id 时分组串行
    function renderVouchers(body, rows) {
      var wrap = body.querySelector('.flow-print');
      var cells = Array.prototype.slice.call(body.querySelectorAll('.fp-vcell'));
      if (!cells.length) return;
      var incChk = body.querySelector('#fpIncImg');
      var include = !incChk || incChk.checked;
      if (wrap) { if (include) wrap.classList.remove('no-voucher'); else wrap.classList.add('no-voucher'); }
      if (!include || body.__fpVLoaded) return;
      var tasks = [];
      rows.forEach(function (t, i) {
        (t.photos || []).forEach(function (pid) {
          if (!pid) return;
          tasks.push(FW.db.getPhoto(pid).then(function (d) { return { i: i, d: d || '' }; }).catch(function () { return null; }));
        });
      });
      if (!tasks.length) { body.__fpVLoaded = true; return; }
      Promise.all(tasks).then(function (res) {
        var byIdx = {};
        res.forEach(function (r) {
          if (!r || !r.d) return;
          if (!byIdx[r.i]) byIdx[r.i] = [];
          byIdx[r.i].push(r.d);
        });
        cells.forEach(function (td) {
          var box = td.querySelector('.fp-vbox');
          if (!box) return;
          var imgs = byIdx[Number(td.getAttribute('data-vi'))];
          if (!imgs || !imgs.length) {
            if (box.querySelector('.fp-vload')) box.innerHTML = '<span class="fp-vnone">—</span>';
            return;
          }
          box.innerHTML = imgs.map(function (d) { return '<img src="' + d + '" alt="凭证">'; }).join('');
        });
        body.__fpVLoaded = true;
      });
    }

    // 每页带标题：勾选时把「报告标题行 + 列头行」都放进明细表 thead，浏览器原生 table-header-group
    // 会让 thead 跨页每页重复，于是每页都有标题 + 列头；
    // 取消勾选则：① 移除报告标题行，② 把列头行从 thead 移到 tbody 首行（tbody 不重复），
    // 这样只有第 1 页顶部有表头，后续页是纯数据行，实现「每页不带标题」。
    function applyTitleEvery(body) {
      var table = body.querySelector('#fpDetailTable');
      var head = body.querySelector('#fpDetailHead');
      var chk = body.querySelector('#fpTitleEvery');
      if (!table || !head || !chk) return;
      var tbody = table.querySelector('tbody');
      var colhead = head.querySelector('.fp-colhead') || (tbody && tbody.querySelector('.fp-colhead'));
      var titleRow = head.querySelector('.fp-title-row');
      if (chk.checked) {
        if (!titleRow) {
          titleRow = document.createElement('tr');
          titleRow.className = 'fp-title-row';
          var td = document.createElement('td');
          td.colSpan = 10; // 与明细表列数一致（日期/类型/项目/分类/账户/金额/对方/报销人/备注/凭证）
          td.innerHTML = titleCompact;
          titleRow.appendChild(td);
          head.insertBefore(titleRow, head.firstChild);
        }
        if (colhead && colhead.parentNode !== head) head.appendChild(colhead);
      } else {
        if (titleRow && titleRow.parentNode) titleRow.parentNode.removeChild(titleRow);
        if (colhead && tbody && colhead.parentNode !== tbody) tbody.insertBefore(colhead, tbody.firstChild);
      }
    }
  }

  /* ---------- 预算横幅 ---------- */
  function budgetBannerHtml() {
    var month = FW.today().slice(0, 7);
    var b = getBudget(month);
    if (!b) {
      return '<div class="card budget-card" style="margin-bottom:14px">本月（' + month + '）尚未设置预算，<a href="#" id="goBudget" style="color:var(--primary)">点击设置</a>，超支会及时提醒。</div>';
    }
    var exp = monthExpense(month);
    var total = Number(b.total) || 0;
    var pct = total > 0 ? (exp / total * 100) : 0;
    var over = pct > 100;
    var barColor = over ? '#e63946' : (pct > 80 ? '#f0a020' : '#1f9d55');
    return '<div class="card budget-card" style="margin-bottom:14px">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">' +
        '<span>本月预算使用 <b style="color:' + (over ? 'var(--income)' : 'var(--expense)') + '">' + pct.toFixed(0) + '%</b></span>' +
        '<span class="muted">支出 ' + FW.fmtMoney(exp) + ' / 预算 ' + FW.fmtMoney(total) + (over ? ' <span class="tag expense">已超支 ' + FW.fmtMoney(exp - total) + '</span>' : '') + '</span>' +
      '</div>' +
      '<div class="budget-bar"><div class="budget-fill" style="width:' + Math.min(pct, 100).toFixed(0) + '%;background:' + barColor + '"></div></div>' +
    '</div>';
  }
  function openBudgetForm() {
    var month = FW.today().slice(0, 7);
    var cur = getBudget(month) || { month: month, total: '', cats: {} };
    var catRows = cats().map(function (c) {
      return '<div class="bud-row"><span>' + FW.esc(c.name) + '</span><input type="number" step="0.01" min="0" data-cat="' + FW.esc(c.name) + '" value="' + (cur.cats && cur.cats[c.name] != null ? cur.cats[c.name] : '') + '" placeholder="0"></div>';
    }).join('');
    var body =
      '<div class="form-grid">' +
        '<div class="field"><label>预算月份</label><input id="b_month" value="' + month + '" type="month"></div>' +
        '<div class="field"><label>月度总预算（元）</label><input id="b_total" type="number" step="0.01" min="0" value="' + FW.esc(cur.total) + '"></div>' +
        '<div class="field full"><label>分类预算（可选，留空表示不限制该类）</label><div class="bud-grid">' + catRows + '</div></div>' +
      '</div>' +
      '<div class="form-actions"><button class="btn ghost" id="bCancel">取消</button><button class="btn" id="bSave">保存预算</button></div>';
    FW.openModal('设置预算', body, function () {
      document.getElementById('bCancel').onclick = FW.closeModal;
      document.getElementById('bSave').onclick = function () {
        var m = document.getElementById('b_month').value || month;
        var total = document.getElementById('b_total').value;
        var cats = {};
        FW.qa('#modalBody [data-cat]').forEach(function (inp) { var v = parseFloat(inp.value); if (v > 0) cats[inp.dataset.cat] = v; });
        var rec = { id: (cur.id || FW.db.uid('b_')), month: m, total: total === '' ? '' : Number(total), cats: cats };
        var list = FW.db.getList(BKEY).filter(function (x) { return x.month !== m; });
        list.push(rec); FW.db.saveList(BKEY, list);
        FW.closeModal(); render(); FW.toast('预算已保存（' + m + '）');
      };
    });
  }

  /* ---------- 收支日历 ---------- */
  function drawCalendar() {
    var now = new Date();
    if (!state.calMonth) state.calMonth = now.getFullYear() + '-' + pad(now.getMonth() + 1);
    var ym = state.calMonth;
    var y = +ym.slice(0, 4), m = +ym.slice(5, 7) - 1;
    var first = new Date(y, m, 1).getDay();
    var days = lastDay(y, m);
    var todayStr = FW.today();
    var dayMap = {};
    all().forEach(function (t) {
      if (!t.date || t.date.slice(0, 7) !== ym) return;
      if (t.type !== 'income' && t.type !== 'expense' && t.type !== 'refund') return;
      if (!dayMap[t.date]) dayMap[t.date] = { inc: 0, exp: 0 };
      if (t.type === 'income') dayMap[t.date].inc += +t.amount;
      else if (t.type === 'refund') dayMap[t.date].exp -= +t.amount;
      else dayMap[t.date].exp += +t.amount;
    });
    var weekNames = ['日', '一', '二', '三', '四', '五', '六'];
    var head = '<div class="cal-head"><button class="btn ghost sm" id="calPrev">‹</button><span id="calTitle">' + y + '年 ' + (m + 1) + '月</span><button class="btn ghost sm" id="calNext">›</button><button class="btn ghost sm" id="calToday">今天</button></div>';
    var week = '<div class="cal-grid cal-week">' + weekNames.map(function (w) { return '<div>' + w + '</div>'; }).join('') + '</div>';
    var grid = '<div class="cal-grid">';
    for (var i = 0; i < first; i++) grid += '<div class="cal-cell empty"></div>';
    for (var d = 1; d <= days; d++) {
      var ds = ym + '-' + (d < 10 ? '0' + d : d);
      var dm = dayMap[ds] || { inc: 0, exp: 0 };
      var net = dm.inc - dm.exp;
      var has = (dm.inc + dm.exp) > 0;
      var cls = 'cal-cell' + (ds === todayStr ? ' today' : '') + (state.calSel === ds ? ' sel' : '') + (has ? ' has' : '');
      grid += '<div class="' + cls + '" data-d="' + ds + '">' +
        '<div class="cal-d">' + d + '</div>' +
        (has ? '<div class="cal-net ' + (net >= 0 ? 'pos' : 'neg') + '">' + (net >= 0 ? '+' : '') + FW.shortMoney(net) + '</div>' : '') +
        '</div>';
    }
    grid += '</div>';
    document.getElementById('inBody').innerHTML = head + week + grid + '<div class="cal-legend muted">点击某天 → 查看当天流水明细（仅显示收入/支出）</div>';
    document.getElementById('calPrev').onclick = function () { state.calMonth = shiftMonth(ym, -1); state.calSel = ''; drawCalendar(); };
    document.getElementById('calNext').onclick = function () { state.calMonth = shiftMonth(ym, 1); state.calSel = ''; drawCalendar(); };
    document.getElementById('calToday').onclick = function () { state.calMonth = now.getFullYear() + '-' + pad(now.getMonth() + 1); state.calSel = ''; drawCalendar(); };
    FW.qa('#inBody .cal-cell[data-d]').forEach(function (c) {
      c.onclick = function () {
        var day = c.dataset.d;
        state.tab = 'list';
        state.filter = { project: '', category: '', account: '', type: '', kw: '', from: day, to: day };
        render();
      };
    });
  }

  /* ---------- 暴露计算接口（供报表中心复用，保证逻辑一致） ---------- */
  FW.internalCalc = {
    accountBalances: accountBalances,        // (upto) -> [{name,bal}] 含期初（扁平叶子）
    accountBalancesTree: accountBalancesTree, // (upto) -> [{name,bal,children:[{name,bal}]}] 树状（首页看板用）
    accountBreakdown: accountBreakdown,      // (upto) -> 树状 [{name,opening,flow,move,bal,children}]
    openingsTotal: openingsTotal,            // () -> 期初合计
    getOpeningsTotal: openingsTotal,         // 别名（报表用）
    netProfit: netProfit,                    // (from,to) -> 区间经营结余
    equityNet: equityNet,                    // (from,to) -> 区间股本净
    filterRows: filterRows,                  // (filter) -> 按筛选条件过滤流水（支持二级分类 category2）
    cat2Name: cat2Name                       // (t) -> 提取二级分类名
  };

  FW.internalAccMgr = { getAccounts: getAccounts, saveAccounts: saveAccounts, refreshAccts: refreshAccts };

  FW.modules = FW.modules || {};
  FW.modules.internal = {
    title: '登记内账',
    render: function () { render(); loadThumbs(); },
    onShow: function () { render(); loadThumbs(); },
    tabs: [
      { key: 'list', label: '流水明细' },
      { key: 'calendar', label: '收支日历' },
      { key: 'stat', label: '统计分析' },
      { key: 'fund', label: '资金变动明细' },
      { key: 'reconcile', label: '银行对账' },
      { key: 'reports', label: '报表中心' }
    ],
    getTab: function () { return state.tab; },
    setTab: function (k) { state.tab = k; drawBody(); if (window.FW.nav) FW.nav.refreshSubNav(); },
    reorderCat: function (from, to) { var l = cats(); if (moveInArray(l, from, to)) { FW.db.saveList(CATKEY_, l); return true; } return false; },
    reorderSubCat: function (pi, from, j) {
      var l = cats(); if (!l[pi]) return false;
      var item = (l[pi].children || []).splice(from, 1)[0]; if (item == null) return false;
      l[pi].children = l[pi].children || []; l[pi].children.splice(j, 0, item);
      FW.db.saveList(CATKEY_, l); return true;
    },
    cats: cats,
    internalReconcile: { parseBankRowsCore: parseBankRowsCore, reconcile: reconcile, guessBankMap: guessBankMap, computeAdjust: computeAdjust, dayDiff: dayDiff },
    accSummaryHtml: accSummaryHtml,
    // 暴露纯函数与表单构造器，供轻量自动化测试直接加载真实模块、防止运行期回归（如 editxProjectText 笔误 / txProjectText 无限递归）
    txProjectText: txProjectText,
    txProjectLabel: txProjectLabel,
    openForm: openForm,
    allocBoxHtml: allocBoxHtml,
    // 科目智能匹配：暴露给回归测试 / 外部一致性校验
    catRules: catRules,
    autoMatchCat: autoMatchCat,
    bulkAutoCategorize: bulkAutoCategorize,
    openCatMatchManager: openCatMatchManager,
    // 列宽单一来源：屏幕与导出复用同一套宽度，暴露供测试/外部一致性校验
    screenColPx: screenColPx,
    txExportColWidths: txExportColWidths,
    // 导出图片列定义（界面流水表去掉「操作」），与界面排版一致；暴露供回归测试
    txExportColumns: txExportColumns
  };
})(window);
