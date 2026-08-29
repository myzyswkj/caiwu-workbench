/* ============================================================
 * 项目成本利润盈亏单产核算
 *   - 收入：登记内账流水中「类型=收入」且带「项目」的合计
 *   - 流水成本：登记内账流水中「类型=支出」且带「项目」的合计（按分类拆解）
 *   - 工资成本：工资登记中底薪/奖金/提成按「项目」分类的合计（按类型拆解）
 *   - 总成本 = 流水成本 - 应收回款项 + 工资成本
 *   - 利润 = 收入 - 总成本
 *   - 单产：利润率 = 利润 / 收入；投入产出比 = 收入 / 总成本
 *   - 额外：成本结构拆解、逐月趋势、未分配资金提醒、排名 + 下钻
 *   可按年度筛选（默认「全部年度」）。
 *
 * 【新增】点击表格中的「收入」金额单元格，弹出该项目的收入明细弹窗，
 *         展示每笔收入的日期、对方、分类、到账金额、已扣支出、实际收入。
 * ============================================================ */
(function (window) {
  'use strict';
  var FW = window.FW || (window.FW = {});

  function num(v) { var n = parseFloat(v); return isNaN(n) ? 0 : n; }

  // 表格列定义（用于「显示列」控制）
  var COL_DEFS = [
    { key: 'rank', label: '排名', fixed: true },
    { key: 'project', label: '项目', fixed: true },
    { key: 'qty', label: '签收单量' },
    { key: 'revenue', label: '收入' },
    { key: 'revUnit', label: '收入单产' },
    { key: 'flowCost', label: '流水成本' },
    { key: 'recoverable', label: '应收回款项' },
    { key: 'laborCost', label: '工资成本' },
    { key: 'totalCost', label: '总成本' },
    { key: 'profit', label: '利润' },
    { key: 'profitUnit', label: '净利润单产' },
    { key: 'rate', label: '利润率' },
    { key: 'costRate', label: '成本率', dynamicLabel: true },
    { key: 'roi', label: '投入产出比' },
    { key: 'pnl', label: '盈亏' }
  ];

  // 往来账余额：金额 − 已核销
  function contactBalance(r) { return (Number(r.amount) || 0) - (Number(r.settled) || 0); }

  function getInternal() { return FW.db.getList('internal'); }
  function getSalaryRecs() { return FW.db.getList('salary_records'); }

  /* ===== 库存台账（stock）→ 项目核算 =====
   * 口径：营期名 = 项目名；采购成本 = 调货金额 − 退货冲减（退货取绝对值，方向与结存无关）。
   * 自动计入流水成本，分类固定为「采购成本」；不再向内账写入流水（内账已记过同一批货，写会翻倍）。
   * 若内账那笔采购支出已挂了同名项目，会在成本分类面板里取消勾选「采购成本」即可排除。
   */
  var STOCK_KEY = 'stock';
  var STOCK_CAT = '采购成本';
  var STOCK_CAT2 = '采购成本 / 采购成本';
  var STOCK_DIRS = { '采购入库': 'in', '其他入库': 'in', '销售退货': 'in', '销售出库': 'out', '其他出库': 'out', '采购退货': 'out' };
  function isStockReturn(type) { return type === '销售退货' || type === '采购退货'; }
  function stockDir(type) { return STOCK_DIRS[type] || 'in'; }
  function stockYearOk(t, year) { return year === 'all' || String((t.date || '').slice(0, 4)) === String(year); }
  // 按营期聚合 → { 营期: {period, inQ, inA, retQ, retA, outQ, outA, net, from, to, items:{}} }
  function stockPeriodAgg(year) {
    var map = {};
    (FW.db.getList(STOCK_KEY) || []).forEach(function (t) {
      if (!t || !stockYearOk(t, year)) return;
      var p = String(t.period || '').trim();
      if (!p || p === '未填营期') return;
      var g = map[p] || (map[p] = { period: p, inQ: 0, inA: 0, retQ: 0, retA: 0, outQ: 0, outA: 0, from: '', to: '', items: {}, iorder: [] });
      var q = num(t.qty), a = num(t.amount), d = t.date || '';
      var it = null;
      if (isStockReturn(t.type)) { g.retQ += Math.abs(q); g.retA += Math.abs(a); }
      else if (stockDir(t.type) === 'in') { g.inQ += q; g.inA += a; }
      else { g.outQ += q; g.outA += a; }
      if (!isStockReturn(t.type) && stockDir(t.type) === 'in' || isStockReturn(t.type)) {
        var k = (String(t.item || '—').trim() || '—') + '||' + (String(t.unit || '').trim());
        it = g.items[k] || (g.items[k] = { item: k.split('||')[0], unit: k.split('||')[1], inQ: 0, inA: 0, retQ: 0, retA: 0 });
        if (isStockReturn(t.type)) { it.retQ += Math.abs(q); it.retA += Math.abs(a); }
        else { it.inQ += q; it.inA += a; }
      }
      if (d) { if (!g.from || d < g.from) g.from = d; if (!g.to || d > g.to) g.to = d; }
    });
    Object.keys(map).forEach(function (p) {
      var g = map[p];
      g.net = g.inA - g.retA;
      g.items = Object.keys(g.items).map(function (k) { return g.items[k]; });
    });
    return map;
  }

  // 一级分类（"主 / 子" 取主）
  function cat1(t) { return ((t.category || '').split(' / ')[0] || '').trim() || '其他'; }

  // 完整分类路径（保留 "一级 / 二级" 用于下钻）
  function catFull(t) { return (t.category || '').trim() || '其他 / 其他'; }

  // 把一笔「合计收支（收入 / 支出 / 退款）」按 allocations 拆成各项目应承担额（纯函数，便于测试与外部复用）。
  // 返回 [{project, amount}] 或 null（无有效分摊 → 走单项目逻辑）。
  // 规则：仅保留「有项目名且金额>0」的有效行；有效行金额合计 <= 本笔金额时，余差（含无效行金额）归到最后一项；
  //       合计 > 本笔金额时，按比例缩放回本笔金额（避免超额分摊）。保证全部分摊完，总额 = 本笔金额。
  function splitAmounts(t) {
    var alloc = t && t.allocations;
    if (!alloc || !alloc.length) return null;
    var total = num(t.amount);
    if (total <= 0) return null;
    var valid = [];
    alloc.forEach(function (a) {
      var p = (a.project || '').trim();
      var amt = Math.max(0, num(a.amount));
      if (p && amt > 0) valid.push({ project: p, amount: amt });
    });
    if (!valid.length) return null;
    var sum = valid.reduce(function (s, x) { return s + x.amount; }, 0);
    var eff;
    if (sum <= total) {
      eff = valid.map(function (x) { return x.amount; });
      eff[eff.length - 1] += (total - sum);                 // 余差（含无效行金额）归末项
      if (eff[eff.length - 1] < 0) eff[eff.length - 1] = 0;  // 极端超额截断
    } else {
      eff = valid.map(function (x) { return total * x.amount / sum; }); // 超分：按比例缩放
    }
    return valid.map(function (x, i) { return { project: x.project, amount: eff[i] }; });
  }

  // 把一条工资记录拆成 {project, type, amount} 明细（type: base/bonus/commission；兼容新旧数据）
  function salaryComps(r) {
    var out = [];
    function push(arr, type) {
      (arr || []).forEach(function (it) {
        out.push({ project: (it.project || '').trim() || '未分类', type: type, amount: num(it.amount) });
      });
    }
    push(r.baseItems, 'base'); push(r.bonusItems, 'bonus'); push(r.commissionItems, 'commission');
    if (!r.baseItems && !r.bonusItems && !r.commissionItems) {
      if (num(r.base) > 0) out.push({ project: '未分类', type: 'base', amount: num(r.base) });
      if (num(r.bonus) > 0) out.push({ project: '未分类', type: 'bonus', amount: num(r.bonus) });
      if (num(r.commission) > 0) out.push({ project: '未分类', type: 'commission', amount: num(r.commission) });
    }
    return out;
  }

  // 对外兼容接口（旧数值工资 → 单条「未分类」）
  function salaryItems(r) {
    return salaryComps(r).map(function (c) { return { project: c.project, amount: c.amount }; });
  }

  function inYear(val, year) {
    if (year === 'all') return true;
    return String(val) === String(year);
  }

  // 核心聚合：返回 { rows, tot, avgRate, avgRoi, cats, laborTypes, monthly, unalloc, allCats }
  function compute(year, hiddenCats) {
    year = (year == null) ? state.year : year;
    hiddenCats = hiddenCats || {};
    function catHidden(c) { return !!hiddenCats[c]; }
    var allCats = {};
    var txs = getInternal().filter(function (t) { return inYear((t.date || '').slice(0, 4), year); });
    var recs = getSalaryRecs().filter(function (r) { return inYear(r.year, year); });

    var map = {};
    function ensure(p) {
      if (!map[p]) map[p] = { revenue: 0, flowCost: 0, laborCost: 0, byCat: {}, byCat2: {}, revByCat: {}, revByCat2: {}, laborByType: { base: 0, bonus: 0, commission: 0 }, recoverable: 0, recoverList: [] };
      return map[p];
    }

    // ===== 未分配统计 =====
    var unFlowCount = 0, unFlowAmt = 0;
    var unLaborAmt = 0, laborUnallocRecs = {};
    var preUnallocCount = 0, preUnallocAmt = 0;

    // 流水：收入 / 支出（仅统计带项目的流水；不带项目的进入未分配）
    txs.forEach(function (t) {
      var dv = (t.type === 'income' && num(t.deduct) > 0) ? num(t.deduct) : 0; // 已扣支出（代付/代扣）
      // ===== 项目分摊：一笔合计收支（收入 / 支出 / 退款）按 allocations 拆分到多个项目 =====
      if (t.type === 'expense' || t.type === 'refund' || t.type === 'income') {
        var split = splitAmounts(t);
        if (split) {
          if (t.type === 'income') {
            // 收入分摊：各项目收入增加
            split.forEach(function (s) {
              var dd = ensure(s.project);
              dd.revenue += s.amount;
              var rn1 = cat1(t), rn2 = catFull(t);
              dd.revByCat[rn1] = (dd.revByCat[rn1] || 0) + s.amount;
              dd.revByCat2[rn2] = (dd.revByCat2[rn2] || 0) + s.amount;
            });
            // 已扣支出(dv)按各项目分摊额占比计入对应项目流水成本（总额守恒、不再漏计）
            if (dv > 0) {
              var sumAmt = split.reduce(function (s2, x) { return s2 + x.amount; }, 0) || 1;
              // 服务费类扣除：按自定义名称归为独立成本分类（如「快递代收服务费」）；否则归入收入原分类
              var dn1 = t.feeName ? t.feeName : cat1(t);
              var dn2 = t.feeName ? (t.feeName + ' / ' + t.feeName) : catFull(t);
              allCats[dn1] = 1;
              if (!catHidden(dn1)) {
                split.forEach(function (s) {
                  var ddv = dv * s.amount / sumAmt;
                  if (ddv > 0) { var dd = ensure(s.project); dd.flowCost += ddv; dd.byCat[dn1] = (dd.byCat[dn1] || 0) + ddv; dd.byCat2[dn2] = (dd.byCat2[dn2] || 0) + ddv; }
                });
              }
            }
          } else {
            var sgn = t.type === 'refund' ? -1 : 1;
            var c = cat1(t), cf = catFull(t);
            allCats[c] = 1;
            if (!catHidden(c)) {
              split.forEach(function (s) {
                var d = ensure(s.project);
                var a2 = s.amount * sgn;
                d.flowCost += a2;
                d.byCat[c] = (d.byCat[c] || 0) + a2;
                d.byCat2[cf] = (d.byCat2[cf] || 0) + a2;
              });
            }
          }
          return; // 已按分摊分发，不再走单项目分支（也不计未分配）
        }
      }
      var p = (t.project || '').trim();
      var a = num(t.amount);
      if (!p) { unFlowCount++; unFlowAmt += (a + dv); return; }
      var d = ensure(p);
      if (t.type === 'income') {
        // 实际收入 = 到账净额 + 已扣支出（还原毛额）；已扣支出计入流水成本（只计一次，不重复）
        d.revenue += (a + dv);
        var ic = cat1(t), icf = catFull(t);
        d.revByCat[ic] = (d.revByCat[ic] || 0) + (a + dv);
        d.revByCat2[icf] = (d.revByCat2[icf] || 0) + (a + dv);
        allCats[ic] = 1;
        if (dv > 0) {
          var fcat1 = t.feeName ? t.feeName : ic;
          var fcat2 = t.feeName ? (t.feeName + ' / ' + t.feeName) : icf;
          allCats[fcat1] = 1;
          if (!catHidden(fcat1)) { d.flowCost += dv; d.byCat[fcat1] = (d.byCat[fcat1] || 0) + dv; d.byCat2[fcat2] = (d.byCat2[fcat2] || 0) + dv; }
        }
      }
      else if (t.type === 'expense') {
        var c = cat1(t), cf = catFull(t);
        allCats[c] = 1;
        if (!catHidden(c)) { d.flowCost += a; d.byCat[c] = (d.byCat[c] || 0) + a; d.byCat2[cf] = (d.byCat2[cf] || 0) + a; }
      }
      else if (t.type === 'refund') {
        var c2 = cat1(t), cf2 = catFull(t);
        allCats[c2] = 1;
        if (!catHidden(c2)) { d.flowCost -= a; d.byCat[c2] = (d.byCat[c2] || 0) - a; d.byCat2[cf2] = (d.byCat2[cf2] || 0) - a; }
      }
    });

    // ===== 库存台账：营期净额（调货 − 退货）自动计入流水成本，分类「采购成本」 =====
    // 营期名即项目名；不写内账流水（内账已记过），避免同一批货成本翻倍
    var stockMap = stockPeriodAgg(year);
    var stockKeys = Object.keys(stockMap);
    var stockOn = !catHidden(STOCK_CAT);
    var stockTot = 0;
    if (stockKeys.length) allCats[STOCK_CAT] = 1;
    stockKeys.forEach(function (p) {
      var g = stockMap[p];
      if (Math.abs(g.net) < 0.005) return;
      stockTot += g.net;
      if (!stockOn) return;
      var d = ensure(p);
      d.flowCost += g.net;
      d.byCat[STOCK_CAT] = (d.byCat[STOCK_CAT] || 0) + g.net;
      d.byCat2[STOCK_CAT2] = (d.byCat2[STOCK_CAT2] || 0) + g.net;
      d.stockPeriods = d.stockPeriods || [];
      d.stockPeriods.push(g.period);
    });

    // 工资：底薪/奖金/提成按项目汇总；「未分类」部分进入未分配
    recs.forEach(function (r) {
      var recKey = r.id || (r.empId + '-' + r.year + '-' + r.month);
      salaryComps(r).forEach(function (c) {
        if (c.project === '未分类') { unLaborAmt += c.amount; laborUnallocRecs[recKey] = 1; }
        else { var d = ensure(c.project); d.laborCost += c.amount; d.laborByType[c.type] += c.amount; }
      });
    });

    // ===== 往来账：预付款未用完余额 → 应收回款项（按项目） =====
    FW.db.getList('contacts').filter(function (r) {
      return r.kind === '预付' && inYear((r.date || '').slice(0, 4), year);
    }).forEach(function (r) {
      var b = contactBalance(r);
      if (b <= 0) return;
      var p = (r.project || '').trim();
      if (!p) { preUnallocCount++; preUnallocAmt += b; return; }
      var dp = ensure(p);
      dp.recoverable += b;
      dp.recoverList.push({ party: (r.party || '').trim() || '—', date: r.date || '', amount: num(r.amount), settled: num(r.settled), balance: b });
    });

    var projects = Object.keys(map).filter(function (p) {
      var d = map[p]; return d.revenue || d.flowCost || d.laborCost || d.recoverable;
    });
    projects.sort(function (a, b) {
      var da = map[a], db = map[b];
      var pa = da.revenue - da.flowCost + (da.recoverable || 0) - da.laborCost;
      var pb = db.revenue - db.flowCost + (db.recoverable || 0) - db.laborCost;
      return pb - pa;
    });

    var vis = {
      flow: state.visibleCols.indexOf('flowCost') > -1,
      rec: state.visibleCols.indexOf('recoverable') > -1,
      labor: state.visibleCols.indexOf('laborCost') > -1,
      rev: state.visibleCols.indexOf('revenue') > -1
    };
    var rows = projects.map(function (p, idx) {
      var d = map[p];
      var totalCost = d.flowCost - (d.recoverable || 0) + d.laborCost;
      var profit = d.revenue - totalCost;
      var rate = d.revenue > 0 ? profit / d.revenue * 100 : 0;
      var roi = totalCost > 0 ? d.revenue / totalCost : (d.revenue > 0 ? Infinity : 0);
      // 可见值：隐藏对应列后，该项不计入总成本，利润/利润率/成本率/投入产出比随之重算
      var vFlow = vis.flow ? d.flowCost : 0;
      var vRec = vis.rec ? (d.recoverable || 0) : 0;
      var vLabor = vis.labor ? d.laborCost : 0;
      var vTotal = vFlow - vRec + vLabor;
      var vRev = vis.rev ? d.revenue : 0;
      var vProfit = vRev - vTotal;
      var vRate = vRev > 0 ? vProfit / vRev * 100 : NaN;
      var vRoi = vTotal > 0 ? vRev / vTotal : (vRev > 0 ? Infinity : NaN);
      var vCostRate = vRev > 0 ? vTotal / vRev * 100 : NaN;
      return {
        project: p, revenue: d.revenue, flowCost: d.flowCost, laborCost: d.laborCost,
        totalCost: totalCost, profit: profit, rate: rate, roi: roi, gain: profit >= 0,
        vRevenue: vRev, vFlowCost: vFlow, vRecoverable: vRec, vLaborCost: vLabor,
        vTotalCost: vTotal, vProfit: vProfit, vRate: vRate, vCostRate: vCostRate, vRoi: vRoi,
        rank: idx + 1, byCat: d.byCat, byCat2: d.byCat2, revByCat: d.revByCat, revByCat2: d.revByCat2, laborByType: d.laborByType, recoverable: d.recoverable || 0, recoverList: d.recoverList || []
      };
    });

    var tot = { revenue: 0, flowCost: 0, laborCost: 0, totalCost: 0, profit: 0, recoverable: 0 };
    var vTot = { revenue: 0, flowCost: 0, laborCost: 0, recoverable: 0, totalCost: 0, profit: 0, rate: NaN, roi: NaN, costRate: NaN };
    rows.forEach(function (r) {
      tot.revenue += r.revenue; tot.flowCost += r.flowCost; tot.laborCost += r.laborCost;
      tot.totalCost += r.totalCost; tot.profit += r.profit; tot.recoverable += (r.recoverable || 0);
      vTot.revenue += r.vRevenue; vTot.flowCost += r.vFlowCost; vTot.laborCost += r.vLaborCost;
      vTot.recoverable += r.vRecoverable; vTot.totalCost += r.vTotalCost; vTot.profit += r.vProfit;
    });
    var avgRate = tot.revenue > 0 ? tot.profit / tot.revenue * 100 : 0;
    var avgRoi = tot.totalCost > 0 ? tot.revenue / tot.totalCost : (tot.revenue > 0 ? Infinity : 0);
    vTot.rate = vTot.revenue > 0 ? vTot.profit / vTot.revenue * 100 : NaN;
    vTot.roi = vTot.totalCost > 0 ? vTot.revenue / vTot.totalCost : (vTot.revenue > 0 ? Infinity : NaN);
    vTot.costRate = vTot.revenue > 0 ? vTot.totalCost / vTot.revenue * 100 : NaN;

    // ===== 成本结构（全局） =====
    var catTot = {};
    rows.forEach(function (r) { Object.keys(r.byCat).forEach(function (c) { catTot[c] = (catTot[c] || 0) + r.byCat[c]; }); });
    var cat2Tot = {};
    rows.forEach(function (r) { Object.keys(r.byCat2 || {}).forEach(function (k) { cat2Tot[k] = (cat2Tot[k] || 0) + r.byCat2[k]; }); });
    var cats = Object.keys(catTot).map(function (c) { return { label: c, value: catTot[c] }; })
      .sort(function (a, b) { return b.value - a.value; });
    var laborTot = { base: 0, bonus: 0, commission: 0 };
    rows.forEach(function (r) { laborTot.base += r.laborByType.base; laborTot.bonus += r.laborByType.bonus; laborTot.commission += r.laborByType.commission; });
    var laborTypes = [
      { label: '底薪', value: laborTot.base },
      { label: '奖金', value: laborTot.bonus },
      { label: '提成', value: laborTot.commission }
    ].filter(function (x) { return x.value > 0; });

    // ===== 逐月趋势 =====
    var mMap = {};
    function mEnsure(k) { if (!mMap[k]) mMap[k] = { rev: 0, flow: 0, labor: 0 }; return mMap[k]; }
    txs.forEach(function (t) {
      var k = (t.date || '').slice(0, 7); if (k.length < 7) return;
      // 项目分摊：支出 / 退款 / 收入按 allocations 拆分到各项目的月度趋势
      if (t.type === 'expense' || t.type === 'refund' || t.type === 'income') {
        var split = splitAmounts(t);
        if (split) {
          if (t.type === 'income') { if (vis.rev) split.forEach(function (s) { mEnsure(k).rev += s.amount; }); }
          else { var sgn = t.type === 'refund' ? -1 : 1; var mc = cat1(t); if (!catHidden(mc) && vis.flow) split.forEach(function (s) { mEnsure(k).flow += s.amount * sgn; }); }
          return;
        }
      }
      var p = (t.project || '').trim(); if (!p) return;
      var d = mEnsure(k);
      if (t.type === 'income') { if (vis.rev) d.rev += num(t.amount); }
      else if (t.type === 'expense') { var me = cat1(t); if (!catHidden(me) && vis.flow) d.flow += num(t.amount); }
      else if (t.type === 'refund') { var mr = cat1(t); if (!catHidden(mr) && vis.flow) d.flow -= num(t.amount); }
    });
    recs.forEach(function (r) {
      var k = String(r.year) + '-' + ('0' + r.month).slice(-2);
      var sum = salaryComps(r).reduce(function (s, c) { return s + (c.project === '未分类' ? 0 : c.amount); }, 0);
      if (vis.labor) mEnsure(k).labor += sum;
    });
    // 库存台账采购成本按月归集（入库 +金额 / 退货 −金额），与分项表口径一致
    if (stockOn && vis.flow) {
      (FW.db.getList(STOCK_KEY) || []).forEach(function (t) {
        if (!t || !stockYearOk(t, year)) return;
        var p = String(t.period || '').trim();
        if (!p || p === '未填营期') return;
        var k = (t.date || '').slice(0, 7); if (k.length < 7) return;
        var a = num(t.amount);
        if (isStockReturn(t.type)) mEnsure(k).flow -= Math.abs(a);
        else if (stockDir(t.type) === 'in') mEnsure(k).flow += a;
      });
    }
    var mkeys = Object.keys(mMap).sort();
    var monthly = {
      labels: mkeys.map(function (k) { return year === 'all' ? k : k.slice(5); }),
      revenue: mkeys.map(function (k) { return mMap[k].rev; }),
      cost: mkeys.map(function (k) { return mMap[k].flow + mMap[k].labor; }),
      profit: mkeys.map(function (k) { return mMap[k].rev - mMap[k].flow - mMap[k].labor; })
    };

    var unalloc = {
      flowCount: unFlowCount, flowAmt: unFlowAmt,
      laborCount: Object.keys(laborUnallocRecs).length, laborAmt: unLaborAmt,
      prepayCount: preUnallocCount, prepayAmt: preUnallocAmt
    };

    var allCatKeys = Object.keys(allCats).sort();
    return {
      rows: rows, tot: tot, vTot: vTot, avgRate: vTot.rate, avgRoi: vTot.roi,
      cats: cats, laborTypes: laborTypes, monthly: monthly, unalloc: unalloc,
      catTot: catTot, cat2Tot: cat2Tot, allCats: allCatKeys,
      stockMap: stockMap, stockOn: stockOn, stockTot: stockTot, stockCount: stockKeys.length
    };
  }

  function getYears() {
    var set = {};
    getInternal().forEach(function (t) { if (t.date && t.date.length >= 4) set[t.date.slice(0, 4)] = 1; });
    getSalaryRecs().forEach(function (r) { if (r.year) set[String(r.year)] = 1; });
    return Object.keys(set).sort();
  }

  var state = {
    year: 'all', expanded: {}, kw: '', pnl: 'all',
    costType: '', costType2: '', costExcl: false,
    sortKey: 'profit', sortDir: 'desc',
    hiddenCats: {}, showCatPanel: false,
    visibleCols: COL_DEFS.map(function (c) { return c.key; }),
    showColPanel: false
  };

  // 项目筛选（关键词匹配项目名 + 盈亏过滤）；纯函数，便于测试与外部复用
  function filterRows(rows, kw, pnl) {
    kw = (kw || '').trim().toLowerCase();
    pnl = pnl || 'all';
    return (rows || []).filter(function (r) {
      if (kw && (r.project || '').toLowerCase().indexOf(kw) < 0) return false;
      if (pnl === 'profit' && r.profit < 0) return false;
      if (pnl === 'loss' && r.profit >= 0) return false;
      return true;
    });
  }

  // ===== 签收单量（手动录入，按项目维度持久化；与统计年度无关，按账本隔离） =====
  var QTY_KEY = 'project_qty';
  // 返回 { 项目名: 单量 }
  function getQtyMap() {
    var m = {};
    FW.db.getList(QTY_KEY).forEach(function (it) { if (it && it.project) m[it.project] = num(it.qty); });
    return m;
  }
  // 写入某个项目的单量（负数归零；空项目忽略）
  function setQty(project, qty) {
    project = (project || '').trim();
    if (!project) return;
    qty = num(qty); if (qty < 0) qty = 0;
    var arr = FW.db.getList(QTY_KEY), id = null;
    arr.forEach(function (it) { if (it.project === project) id = it.id; });
    if (id) FW.db.upsert(QTY_KEY, { id: id, project: project, qty: qty });
    else FW.db.upsert(QTY_KEY, { id: FW.db.uid('pq_'), project: project, qty: qty });
  }
  // 在筛选之后，把单量 / 单产补全到每行（收入单产 = 收入 / 单量；净利润单产 = 利润 / 单量）
  function enrichRows(rows) {
    var m = getQtyMap();
    (rows || []).forEach(function (r) {
      var q = m[r.project] || 0;
      r.qty = q;
      r.revUnit = q > 0 ? r.revenue / q : null;       // 收入单产
      r.profitUnit = q > 0 ? r.vProfit / q : null;     // 净利润单产（随隐藏列重算）
    });
    return rows;
  }

  // 自定义排序：按 state.sortKey / state.sortDir 排序，并重排 rank（使「排名」列等于当前显示顺序）
  function sortRows(rows) {
    var key = state.sortKey || 'profit';
    var dir = state.sortDir === 'asc' ? 1 : -1;
    var arr = (rows || []).slice().sort(function (a, b) {
      var va, vb;
      if (key === 'cr') {
        va = state.costType ? costRateOf(a, state.costType, state.costType2, state.costExcl).rate : (isFinite(a.vCostRate) ? a.vCostRate : -Infinity);
        vb = state.costType ? costRateOf(b, state.costType, state.costType2, state.costExcl).rate : (isFinite(b.vCostRate) ? b.vCostRate : -Infinity);
      } else if (key === 'roi') {
        va = a.vRoi === Infinity ? Number.MAX_VALUE : (isFinite(a.vRoi) ? a.vRoi : -Infinity);
        vb = b.vRoi === Infinity ? Number.MAX_VALUE : (isFinite(b.vRoi) ? b.vRoi : -Infinity);
      } else if (key === 'project') {
        var ca = (a.project || '').toString(), cb = (b.project || '').toString();
        var cmp = ca.localeCompare(cb, 'zh-Hans-CN');
        if (cmp === 0) return 0;
        return cmp < 0 ? -dir : dir;
      } else {
        va = (typeof a[key] === 'number') ? a[key] : 0;
        vb = (typeof b[key] === 'number') ? b[key] : 0;
      }
      if (va === vb) return 0;
      return va < vb ? -dir : dir;
    });
    arr.forEach(function (r, i) { r.rank = i + 1; });
    return arr;
  }

  // 成本率：默认用总成本口径（总成本 / 收入）；可选某一级 / 二级分类成本，或「工资成本」作为口径
  // costExcl=true 时口径变为「总成本 − 所选类成本」（即不含该类的总成本率）
  function costRateOf(r, costType, costType2, costExcl) {
    costType = costType || ''; costType2 = costType2 || ''; costExcl = !!costExcl;
    var baseCost; // 所选类别的绝对成本（总成本模式为 null）
    if (!costType) baseCost = null;
    else if (costType === '__labor__') baseCost = r.laborCost;
    else if (costType2) baseCost = r.byCat2[(costType + ' / ' + costType2)] || 0;
    else baseCost = r.byCat[costType] || 0;
    var cost;
    if (costExcl && baseCost != null) cost = r.totalCost - baseCost; // 不含所选类
    else if (baseCost == null) cost = r.totalCost;                   // 总成本（默认）
    else cost = baseCost;                                            // 所选类占比
    var rate = r.revenue > 0 ? cost / r.revenue * 100 : 0;
    return { cost: cost, rate: rate };
  }

  // 成本率列动态表头（随口径变化，便于一眼看清当前口径）
  function costRateLabel() {
    if (!state.costType) return '成本率(总成本)';
    var lbl = state.costType === '__labor__' ? '工资' : (state.costType2 ? (state.costType + ' / ' + state.costType2) : state.costType);
    return '成本率(' + (state.costExcl ? ('不含' + lbl) : lbl) + ')';
  }

  // 合计行的成本率口径成本（绝对金额）；与 costRateOf 的口径逻辑保持一致
  function costBasisTot(data) {
    if (!state.costType) return data.tot.totalCost;
    var sel = state.costType === '__labor__' ? data.tot.laborCost
      : (state.costType2 ? (data.cat2Tot[(state.costType + ' / ' + state.costType2)] || 0)
        : (data.catTot[state.costType] || 0));
    return state.costExcl ? (data.tot.totalCost - sel) : sel;
  }
  function totalCostRatePct(data) {
    var basis = costBasisTot(data);
    return data.tot.revenue > 0 ? basis / data.tot.revenue * 100 : 0;
  }

  /* ============================================================
   * 【新增】收入明细弹窗功能
   * 点击表格中的收入金额 → 弹出该项目所有收入流水的明细列表
   * ============================================================ */

  /**
   * 打开指定项目的收入明细弹窗
   * @param {string} projectName - 项目名称
   */
  function openIncomeDetail(projectName) {
    var year = state.year;
    // 筛选当前年度的所有收入流水
    var txs = getInternal().filter(function (t) {
      return t.type === 'income' && inYear((t.date || '').slice(0, 4), year);
    });

    var items = [];

    txs.forEach(function (t) {
      var p = (t.project || '').trim();
      var split = splitAmounts(t);

      if (split) {
        // 分摊收入：只取目标项目的份额，并按占比补上应摊的已扣支出
        var dvTotal = num(t.deduct);
        var splitSum = split.reduce(function (s2, x) { return s2 + x.amount; }, 0) || 1;
        split.forEach(function (s) {
          if (s.project === projectName) {
            var dShare = dvTotal > 0 ? dvTotal * s.amount / splitSum : 0;
            items.push({
              date: t.date || '',
              party: t.party || '',
              category: catFull(t),
              amount: s.amount,
              deduct: dShare,
              actual: s.amount + dShare,
              remark: '(分摊)',
              feeName: t.feeName || '',
              id: t.id
            });
          }
        });
      } else if (p === projectName) {
        // 单项目归属的收入
        var dv = num(t.deduct);
        items.push({
          date: t.date || '',
          party: t.party || '',
          category: catFull(t),
          amount: num(t.amount),
          deduct: dv,
          actual: num(t.amount) + dv,
          remark: t.remark || '',
          feeName: t.feeName || '',
          id: t.id
        });
      }
    });

    // 按日期降序（最新的在前）
    items.sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });

    var totalActual = items.reduce(function (s, it) { return s + it.actual; }, 0);

    // 无数据提示
    if (!items.length) {
      FW.openModal('「' + FW.esc(projectName) + '」收入明细',
        '<div style="padding:30px 20px;text-align:center;color:var(--muted)">' +
        '<div style="font-size:36px;margin-bottom:12px">📋</div>' +
        '<div style="font-size:14px">当前筛选年度下没有找到该项目的收入记录。</div>' +
        '<div style="font-size:12px;margin-top:8px">请检查「登记内账」中是否有标记为「<b>' + FW.esc(projectName) + '</b>」的收入流水。</div>' +
        '</div>');
      return;
    }

    // 构建明细表格 HTML
    var body =
      '<div style="margin-bottom:10px;font-size:13px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
        '<span style="color:var(--muted)">共</span><b style="color:var(--income)">' + items.length + '</b><span style="color:var(--muted)">笔收入</span>' +
        '<span style="margin:0 4px;color:var(--border)">|</span>' +
        '<span style="color:var(--muted)">合计</span><b class="amt-income" style="font-size:16px">' + FW.fmtMoney(totalActual) + '</b>' +
      '</div>' +
      '<div style="max-height:52vh;overflow:auto;border:1px solid var(--border);border-radius:8px">' +
      '<table class="pc-income-detail-table"><thead><tr>' +
        '<th style="width:90px">日期</th>' +
        '<th style="width:120px">对方 / 客户</th>' +
        '<th>分类</th>' +
        '<th class="num" style="width:100px">到账金额</th>' +
        '<th class="num" style="width:90px">已扣支出</th>' +
        '<th class="num" style="width:100px">实际收入</th>' +
        '<th style="width:80px">备注</th>' +
      '</tr></thead><tbody>';

    items.forEach(function (it) {
      body += '<tr>' +
        '<td>' + FW.esc(it.date) + '</td>' +
        '<td>' + (it.party ? FW.esc(it.party) : '<span class="muted">—</span>') + '</td>' +
        '<td><span class="tag" style="font-size:11px">' + FW.esc(it.category) + '</span></td>' +
        '<td class="num">' + FW.fmtMoney(it.amount) + '</td>' +
        '<td class="num">' + (it.deduct > 0 ? '<span class="amt-expense">' + FW.fmtMoney(it.deduct) + '</span>' + (it.feeName ? '<div class="muted" style="font-size:11px">' + FW.esc(it.feeName) + '</div>' : '') : '<span class="muted">—</span>') + '</td>' +
        '<td class="num amt-income"><b>' + FW.fmtMoney(it.actual) + '</b></td>' +
        '<td class="muted" style="font-size:11px">' + FW.esc(it.remark || '—') + '</td>' +
        '</tr>';
    });

    body += '</tbody><tfoot><tr>' +
      '<td colspan="5" style="text-align:right;padding:10px;background:#fff8f0;font-weight:700;color:var(--text)">合计</td>' +
      '<td class="num amt-income" style="padding:10px;background:#fff8f0"><b>' + FW.fmtMoney(totalActual) + '</b></td>' +
      '<td style="background:#fff8f0"></td>' +
      '</tr></tfoot></table></div>' +
      '<div class="muted" style="font-size:11px;margin-top:8px;line-height:1.6">' +
        '• 到账金额 = 实际到账的净额 &nbsp;|&nbsp; 已扣服务费 = 按费率反推（毛收入口径），名称可自定义（如快递代收服务费）&nbsp;|&nbsp; 实际收入 = 到账金额 + 已扣服务费<br>' +
        '• 标记「(分摊)」的记录表示该笔收入按比例分摊到了多个项目<br>' +
        '• 数据来源：「登记内账」→ 类型=收入 且 项目=' + FW.esc(projectName) +
      '</div>';

    FW.openModal('「' + FW.esc(projectName) + '」 — 收入明细', body);
  }

  /* ============================================================
   * 【新增】计算结果下钻：点击利润率 / 成本率 / 投入产出比 / 净利润单产 /
   *         盈亏 / 总成本 / 利润 等单元格，弹出该数字由哪些基础数字计算而来。
   * ============================================================ */
  function openCalcDetail(row, colKey, data) {
    var isTotal = !row;
    var v;
    if (isTotal) {
      v = {
        project: '合计',
        revenue: data.vTot.revenue,
        flowCost: data.vTot.flowCost,
        recoverable: data.vTot.recoverable,
        laborCost: data.vTot.laborCost,
        totalCost: data.vTot.totalCost,
        profit: data.vTot.profit,
        rate: data.vTot.rate,
        costRate: data.vTot.costRate,
        roi: data.vTot.roi,
        qty: (data.rows || []).reduce(function (s, r) { return s + (r.qty || 0); }, 0)
      };
    } else {
      v = {
        project: row.project,
        revenue: row.vRevenue,
        flowCost: row.vFlowCost,
        recoverable: row.vRecoverable,
        laborCost: row.vLaborCost,
        totalCost: row.vTotalCost,
        profit: row.vProfit,
        rate: row.vRate,
        costRate: row.vCostRate,
        roi: row.vRoi,
        qty: row.qty || 0
      };
    }

    // 自定义成本率口径（仅非合计行且选了成本分类口径时）
    var cr = null;
    if (colKey === 'costRate' && state.costType && !isTotal) {
      cr = costRateOf(row, state.costType, state.costType2, state.costExcl);
    }

    function valRow(label, value, colorVar) {
      var style = 'padding:8px 12px;border-bottom:1px solid var(--border);';
      var valStyle = style + 'font-weight:700;text-align:right;';
      if (colorVar) valStyle += 'color:var(--' + colorVar + ');';
      var disp = (typeof value === 'number' && !isNaN(value)) ? FW.fmtMoney(value) : value;
      return '<tr><td style="' + style + 'color:var(--muted)">' + FW.esc(label) + '</td>' +
        '<td style="' + valStyle + '">' + disp + '</td></tr>';
    }

    var title, formula = '', body = '';
    switch (colKey) {
      case 'profitUnit':
        title = '净利润单产';
        formula = '净利润单产 = 利润 ÷ 签收单量';
        body += '<table style="width:100%;border-collapse:collapse;margin:12px 0">' +
          valRow('利润', v.profit, v.profit >= 0 ? 'income' : 'expense') +
          valRow('签收单量', v.qty, '') +
          valRow('净利润单产', v.qty > 0 ? FW.fmtMoney(v.profit / v.qty) : '—', '') +
          '</table>';
        break;
      case 'rate':
        title = '利润率';
        formula = '利润率 = 利润 ÷ 收入 × 100%';
        body += '<table style="width:100%;border-collapse:collapse;margin:12px 0">' +
          valRow('利润', v.profit, v.profit >= 0 ? 'income' : 'expense') +
          valRow('收入', v.revenue, 'income') +
          valRow('利润率', (isFinite(v.rate) ? v.rate.toFixed(1) : '—') + '%', '') +
          '</table>';
        break;
      case 'costRate':
        title = '成本率';
        if (cr) {
          var rateName = costRateLabel().replace('成本率', '').replace(/[()]/g, '');
          formula = '成本率（' + rateName + '）= 所选成本 ÷ 收入 × 100%';
          body += '<table style="width:100%;border-collapse:collapse;margin:12px 0">' +
            valRow('所选成本口径', cr.cost, 'expense') +
            valRow('收入', v.revenue, 'income') +
            valRow('成本率', cr.rate.toFixed(1) + '%', '') +
            '</table>';
        } else {
          formula = '成本率 = 总成本 ÷ 收入 × 100%';
          body += '<table style="width:100%;border-collapse:collapse;margin:12px 0">' +
            valRow('总成本', v.totalCost, 'expense') +
            valRow('收入', v.revenue, 'income') +
            valRow('成本率', (isFinite(v.costRate) ? v.costRate.toFixed(1) : '—') + '%', '') +
            '</table>';
        }
        break;
      case 'roi':
        title = '投入产出比';
        formula = '投入产出比 = 收入 ÷ 总成本';
        body += '<table style="width:100%;border-collapse:collapse;margin:12px 0">' +
          valRow('收入', v.revenue, 'income') +
          valRow('总成本', v.totalCost, 'expense') +
          valRow('投入产出比', isFinite(v.roi) ? v.roi.toFixed(2) : '∞', '') +
          '</table>';
        break;
      case 'pnl':
        title = '盈亏状态';
        formula = '盈亏由利润决定：利润 ≥ 0 为盈利，< 0 为亏损';
        body += '<table style="width:100%;border-collapse:collapse;margin:12px 0">' +
          valRow('利润', v.profit, v.profit >= 0 ? 'income' : 'expense') +
          valRow('状态', v.profit >= 0 ? '盈利' : '亏损', v.profit >= 0 ? 'income' : 'expense') +
          '</table>';
        break;
      case 'totalCost':
        title = '总成本';
        formula = '总成本 = 流水成本 − 应收回款项 + 工资成本';
        body += '<table style="width:100%;border-collapse:collapse;margin:12px 0">' +
          valRow('流水成本', v.flowCost, 'expense') +
          valRow('应收回款项（扣减）', -v.recoverable, 'recover') +
          valRow('工资成本', v.laborCost, 'expense') +
          valRow('总成本', v.totalCost, 'expense') +
          '</table>';
        break;
      case 'profit':
        title = '利润';
        formula = '利润 = 收入 − 总成本';
        body += '<table style="width:100%;border-collapse:collapse;margin:12px 0">' +
          valRow('收入', v.revenue, 'income') +
          valRow('总成本', v.totalCost, 'expense') +
          valRow('利润', v.profit, v.profit >= 0 ? 'income' : 'expense') +
          '</table>';
        break;
      default:
        return;
    }

    var html =
      '<div style="background:#f7f9fb;border:1px solid var(--border);border-radius:8px;padding:12px 16px;margin-bottom:14px">' +
      '<div style="font-size:12px;color:var(--muted);margin-bottom:4px">计算公式</div>' +
      '<div style="font-size:15px;font-weight:700;color:var(--text);line-height:1.5">' + FW.esc(formula) + '</div></div>' +
      body;

    // 合计行额外展示各项目贡献 Top 5
    if (isTotal && data.rows && data.rows.length) {
      var metricMap = {
        profit: ['vProfit', '利润', '利润贡献 Top 5'],
        revenue: ['vRevenue', '收入', '收入贡献 Top 5'],
        flowCost: ['vFlowCost', '流水成本', '流水成本 Top 5'],
        laborCost: ['vLaborCost', '工资成本', '工资成本 Top 5'],
        totalCost: ['vTotalCost', '总成本', '总成本 Top 5'],
        rate: ['vRate', '利润率', '利润率 Top 5'],
        costRate: ['vCostRate', '成本率', '成本率 Top 5'],
        roi: ['vRoi', '投入产出比', '投入产出比 Top 5']
      };
      var mm = metricMap[colKey];
      if (mm) {
        var metric = mm[0], label = mm[1], desc = mm[2];
        var sorted = data.rows.slice().sort(function (a, b) {
          var va = a[metric], vb = b[metric];
          if (va === Infinity) return -1; if (vb === Infinity) return 1;
          if (!isFinite(va)) va = -Infinity; if (!isFinite(vb)) vb = -Infinity;
          return vb - va;
        }).slice(0, 5);
        var list = sorted.map(function (r, i) {
          var val = r[metric];
          var disp = metric === 'vRate' || metric === 'vCostRate' ? (isFinite(val) ? val.toFixed(1) + '%' : '—') :
            metric === 'vRoi' ? (isFinite(val) ? val.toFixed(2) : '∞') :
              FW.fmtMoney(val);
          return '<tr><td style="padding:6px 10px;border-bottom:1px solid var(--border)">' + (i + 1) + '</td>' +
            '<td style="padding:6px 10px;border-bottom:1px solid var(--border)">' + FW.esc(r.project) + '</td>' +
            '<td class="num" style="padding:6px 10px;border-bottom:1px solid var(--border);font-weight:600">' + disp + '</td></tr>';
        }).join('');
        html += '<div style="margin-top:16px"><div style="font-size:12px;color:var(--muted);margin-bottom:8px">' + FW.esc(desc) + '</div>' +
          '<table style="width:100%;border-collapse:collapse">' +
          '<thead><tr><th style="text-align:left;padding:6px 10px;border-bottom:1px solid var(--border);font-weight:600">排名</th>' +
          '<th style="text-align:left;padding:6px 10px;border-bottom:1px solid var(--border);font-weight:600">项目</th>' +
          '<th class="num" style="padding:6px 10px;border-bottom:1px solid var(--border);font-weight:600">' + FW.esc(label) + '</th></tr></thead>' +
          '<tbody>' + list + '</tbody></table></div>';
      }
    }

    html += '<div class="muted" style="font-size:11px;margin-top:14px;line-height:1.6">' +
      '• 以上金额均按当前「显示列」设置口径计算；隐藏的收入 / 流水成本 / 应收回款项 / 工资成本列不会计入<br>' +
      '• 点击项目行可展开查看完整成本分类、工资构成与应收回款项明细；点击收入金额可查看收入流水明细' +
      '</div>';

    FW.openModal('「' + FW.esc(v.project) + '」 — ' + FW.esc(title) + '计算过程', html);
  }

  // ---------- 未归类收支提醒（②：解决“项目利润对不上”最常见原因） ----------
  function unclassifiedList() {
    return (FW.db.getList('internal') || []).filter(function (t) {
      if (t.type !== 'income' && t.type !== 'expense' && t.type !== 'refund') return false;
      var p = (t.project || '').trim();
      return !p || p === '未分配' || p === '—' || p === '-';
    });
  }
  function unclassifiedBanner() {
    var arr = unclassifiedList();
    if (!arr.length) return '';
    return '<div class="pc-warn-banner no-print" id="pcUnclassBanner">⚠️ 有 <b>' + arr.length + '</b> 笔收支未填写「项目」，不计入任何项目核算（会使相关项目成本偏低、利润虚高）。' +
      '<button class="btn sm" id="pcUnclassView">查看并补归类</button></div>';
  }
  function openUnclassified() {
    var arr = unclassifiedList();
    if (!arr.length) { FW.toast('没有未归类的收支'); return; }
    var rowsHtml = arr.slice().sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); }).map(function (t) {
      var tcls = t.type === 'income' ? 'amt-income' : (t.type === 'refund' ? 'amt-recover' : 'amt-expense');
      var tlabel = t.type === 'income' ? '收入' : (t.type === 'refund' ? '退款收入' : '支出');
      return '<tr>' +
        '<td>' + FW.esc(t.date || '') + '</td>' +
        '<td>' + tlabel + '</td>' +
        '<td class="num ' + tcls + '">' + FW.fmtMoney(Number(t.amount)) + '</td>' +
        '<td>' + FW.esc(t.party || '—') + '</td>' +
        '<td>' + FW.esc(t.remark || '—') + '</td>' +
        '<td><button class="btn sm" data-edit="' + FW.esc(t.id) + '">去补归类</button></td>' +
        '</tr>';
    }).join('');
    var body = '<div class="muted" style="font-size:12px;margin-bottom:8px">以下收支未填「项目」。点「去补归类」打开编辑，填写项目后保存即计入对应项目核算。未填项目的笔数越多，项目成本越偏低、利润越虚高。</div>' +
      '<div style="max-height:52vh;overflow:auto"><table class="pc-unclass-table"><thead><tr><th>日期</th><th>类型</th><th class="num">金额</th><th>对方</th><th>摘要</th><th>操作</th></tr></thead><tbody>' + rowsHtml + '</tbody></table></div>';
    FW.openModal('未归类收支（' + arr.length + ' 笔）', body, function () {
      FW.qa('[data-edit]').forEach(function (btn) {
        btn.onclick = function () {
          var id = this.getAttribute('data-edit');
          FW.closeModal();
          if (FW.modules.internal && FW.modules.internal.openForm) FW.modules.internal.openForm(id);
        };
      });
    });
  }

  // ---------- 单项目逐笔明细（④：成本/收入“钱去哪了”透明） ----------
  // 下钻：列出某项目（或全部项目）的逐笔流水；filter: all/income/cost/labor/recover
  function openProjectDetail(project, filter) {
    filter = filter || 'all';
    var txRows = [], inc = 0, exp = 0, rf = 0, dv = 0;
    function pushInternal(t) {
      var cls = (t.type === 'income') ? 'amt-income' : (t.type === 'refund' ? 'amt-recover' : (t.type === 'dividend' ? 'amt-gold' : 'amt-expense'));
      var tl = t.type === 'income' ? '收入' : (t.type === 'refund' ? '退款收入' : (t.type === 'dividend' ? '分红' : '支出'));
      txRows.push({ date: t.date || '', type: tl, category: (t.category || t.cat1 || '—'), party: (t.party || '—'), amount: Number(t.amount), remark: (t.remark || '—'), cls: cls, srcId: t.id });
      if (t.type === 'income') inc += Number(t.amount);
      else if (t.type === 'expense') exp += Number(t.amount);
      else if (t.type === 'refund') rf += Number(t.amount);
      else if (t.type === 'dividend') dv += Number(t.amount);
    }
    if (filter === 'labor') {
      var emps = FW.db.getList('salary_employees') || [];
      getSalaryRecs().forEach(function (r) {
        salaryComps(r).forEach(function (c) {
          if (project && c.project !== project) return;
          if (!project && c.project === '未分类') return;
          var emp = emps.find(function (e) { return e.id === r.empId; }) || {};
          var tl = c.type === 'base' ? '工资·底薪' : (c.type === 'bonus' ? '工资·奖金' : '工资·提成');
          var period = (r.year || '') + '-' + (r.month ? ('0' + r.month).slice(-2) : '');
          txRows.push({ date: period, type: tl, category: '工资成本', party: (emp.name || r.empId || '—'), amount: c.amount, remark: (r.remark || '—'), cls: 'amt-expense' });
        });
      });
      txRows.sort(function (a, b) { return (b.date || '').localeCompare(a.date || '') || (b.amount - a.amount); });
    } else if (filter === 'recover') {
      (FW.db.getList('contacts') || []).filter(function (r) { return r.kind === '预付'; }).forEach(function (r) {
        if (project && (r.project || '').trim() !== project) return;
        var b = num(r.amount) - num(r.settled);
        if (b <= 0) return;
        txRows.push({ date: r.date || '', type: '预付款', category: '应收回款项', party: (r.party || '—'), amount: b, remark: '未用完余额（预付−已核销）', cls: 'amt-recover' });
      });
      txRows.sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
    } else {
      (FW.db.getList('internal') || []).forEach(function (t) {
        var p = (t.project || '').trim();
        var split = splitAmounts(t);
        if (split) {
          // 有 allocations 分摊：按目标项目拆分，与 compute() 口径一致
          var dvTotal = num(t.deduct);
          var splitSum = split.reduce(function (s2, x) { return s2 + x.amount; }, 0) || 1;
          var srcId = t.id;
          var srcBase = '分摊自 #' + (t.id || '?') + '（总额 ' + FW.fmtMoney(Number(t.amount)) + '，占 ';
          split.forEach(function (s) {
            if (s.project !== project) return;
            var a = s.amount;
            var pct = a / splitSum * 100;
            var dShare = (t.type === 'income' && dvTotal > 0) ? dvTotal * a / splitSum : 0;
            var cf = catFull(t), party = (t.party || '—');
            var srcNote = srcBase + pct.toFixed(1) + '%）';
            if (filter === 'income' && t.type === 'income') {
              txRows.push({ date: t.date || '', type: '收入', category: cf, party: party, amount: a, remark: srcNote, srcId: srcId, cls: 'amt-income' });
              inc += a;
            }
            if (filter === 'cost') {
              if (t.type === 'expense') {
                txRows.push({ date: t.date || '', type: '支出', category: cf, party: party, amount: a, remark: srcNote, srcId: srcId, cls: 'amt-expense' });
                exp += a;
              } else if (t.type === 'refund') {
                txRows.push({ date: t.date || '', type: '退款收入', category: cf, party: party, amount: a, remark: srcNote, srcId: srcId, cls: 'amt-recover' });
                rf += a;
              } else if (t.type === 'income' && dShare > 0) {
                var feeName = t.feeName || '已扣支出';
                var dNote = '已扣支出·分摊自 #' + (t.id || '?') + '（已扣总额 ' + FW.fmtMoney(dvTotal) + '，占 ' + (dShare / dvTotal * 100).toFixed(1) + '%）';
                txRows.push({ date: t.date || '', type: feeName, category: cf, party: party, amount: dShare, remark: dNote, srcId: srcId, cls: 'amt-expense' });
                exp += dShare;
              }
            }
            if (filter === 'all') {
              if (t.type === 'income') {
                txRows.push({ date: t.date || '', type: '收入', category: cf, party: party, amount: a, remark: srcNote, srcId: srcId, cls: 'amt-income' });
                inc += a;
                if (dShare > 0) {
                  var feeName2 = t.feeName || '已扣支出';
                  var dNote2 = '已扣支出·分摊自 #' + (t.id || '?') + '（已扣总额 ' + FW.fmtMoney(dvTotal) + '，占 ' + (dShare / dvTotal * 100).toFixed(1) + '%）';
                  txRows.push({ date: t.date || '', type: feeName2, category: cf, party: party, amount: dShare, remark: dNote2, srcId: srcId, cls: 'amt-expense' });
                  exp += dShare;
                }
              } else if (t.type === 'expense') {
                txRows.push({ date: t.date || '', type: '支出', category: cf, party: party, amount: a, remark: srcNote, srcId: srcId, cls: 'amt-expense' });
                exp += a;
              } else if (t.type === 'refund') {
                txRows.push({ date: t.date || '', type: '退款收入', category: cf, party: party, amount: a, remark: srcNote, srcId: srcId, cls: 'amt-recover' });
                rf += a;
              }
            }
          });
          return; // 已处理分摊，不再按单项目字段匹配
        }
        // 无分摊：按单项目字段匹配
        if (project && p !== project) return;
        if (filter === 'income' && t.type !== 'income') return;
        if (filter === 'cost' && t.type !== 'expense' && t.type !== 'refund') return;
        if (filter !== 'all' && filter !== 'income' && filter !== 'cost') return;
        pushInternal(t);
      });
      // 库存台账：营期净额（调货 − 退货）自动计入的采购成本（营期名 = 项目名，不占内账流水）
      if (filter === 'all' || filter === 'cost') {
        var sm = stockPeriodAgg(state.year);
        Object.keys(sm).forEach(function (p) {
          if (project && p !== project) return;
          var g = sm[p];
          if (Math.abs(g.net) < 0.005) return;
          var span = (g.from === g.to || !g.to) ? (g.from || g.to || '') : (g.from + '~' + g.to);
          txRows.push({
            date: span,
            type: '采购成本',
            category: STOCK_CAT2,
            party: '库存台账·' + g.period,
            amount: g.net,
            remark: '营期「' + g.period + '」调货 ' + FW.fmtMoney(g.inA) + ' − 退货 ' + FW.fmtMoney(g.retA) + '（自动计入，内账不重复记）',
            cls: 'amt-expense'
          });
          exp += g.net;
        });
      }
      txRows.sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
    }
    if (!txRows.length) { FW.toast('该项目无相关流水'); return; }
    var fTitle = { all: '逐笔明细', income: '收入流水', cost: '流水成本', labor: '工资成本', recover: '应收回款项' }[filter] || '逐笔明细';
    var scope = project ? ('「' + project + '」') : '全部项目';
    var totalAmt = txRows.reduce(function (s, x) { return s + x.amount; }, 0);
    var kpiHtml;
    if (filter === 'all') {
      kpiHtml = '<div class="pc-pd-kpis">' +
        '<span>收入 <b class="amt-income">' + FW.fmtMoney(inc) + '</b></span>' +
        '<span>支出 <b class="amt-expense">' + FW.fmtMoney(exp) + '</b></span>' +
        '<span>退款 <b class="amt-recover">' + FW.fmtMoney(rf) + '</b></span>' +
        '<span>分红 <b class="amt-gold">' + FW.fmtMoney(dv) + '</b></span>' +
        '<span>净额 <b class="' + (inc - exp + rf - dv >= 0 ? 'amt-income' : 'amt-expense') + '">' + FW.fmtMoney(inc - exp + rf - dv) + '</b></span>' +
        '</div>';
    } else {
      var kcls = filter === 'recover' ? 'amt-recover' : (filter === 'income' ? 'amt-income' : 'amt-expense');
      kpiHtml = '<div class="pc-pd-kpis"><span>' + fTitle + '合计 <b class="' + kcls + '">' + FW.fmtMoney(totalAmt) + '</b></span><span>共 <b>' + txRows.length + '</b> 笔</span></div>';
    }
    var rowsHtml = txRows.map(function (t) {
      var remarkCell = (t.srcId)
        ? '<span class="pc-src" onclick="(FW.modules.internal&&FW.modules.internal.openForm)&&FW.modules.internal.openForm(\'' + String(t.srcId).replace(/'/g, "\\'") + '\')" title="点击查看来源流水">🔗 ' + FW.esc(t.remark) + '</span>'
        : FW.esc(t.remark);
      return '<tr>' +
        '<td>' + FW.esc(t.date) + '</td>' +
        '<td>' + t.type + '</td>' +
        '<td>' + FW.esc(t.category) + '</td>' +
        '<td>' + FW.esc(t.party) + '</td>' +
        '<td class="num ' + t.cls + '">' + FW.fmtMoney(t.amount) + '</td>' +
        '<td>' + remarkCell + '</td>' +
        '</tr>';
    }).join('');
    var tableHtml;
    if (filter === 'labor') {
      tableHtml = laborGroupedTable(txRows);
    } else {
      tableHtml = '<div style="max-height:54vh;overflow:auto"><table class="pc-unclass-table"><thead><tr><th>日期</th><th>类型</th><th>分类</th><th>对方</th><th class="num">金额</th><th>摘要</th></tr></thead><tbody>' + rowsHtml + '</tbody></table></div>';
    }
    var body = kpiHtml + tableHtml;
    FW.openModal(scope + fTitle + '（' + txRows.length + ' 笔）', body, function () {
      var m = document.querySelector('.modal'); if (m) m.classList.add('modal-wide');
    });
  }

  // 工资成本下钻：按底薪/奖金/提成折叠分组（点击分组头可收起/展开）
  function laborGroupedTable(rows) {
    var groups = {};
    rows.forEach(function (r) { (groups[r.type] = groups[r.type] || []).push(r); });
    var order = ['工资·底薪', '工资·奖金', '工资·提成'];
    var keys = Object.keys(groups).sort(function (a, b) { return order.indexOf(a) - order.indexOf(b); });
    var tb = keys.map(function (g) {
      var gr = groups[g];
      var sum = gr.reduce(function (s, x) { return s + x.amount; }, 0);
      var detail = gr.map(function (t) {
        return '<tr class="pc-gr-row" data-g="' + FW.esc(g) + '"><td>' + FW.esc(t.date) + '</td><td>' + t.type + '</td><td>' + FW.esc(t.category) + '</td><td>' + FW.esc(t.party) + '</td><td class="num ' + t.cls + '">' + FW.fmtMoney(t.amount) + '</td><td>' + FW.esc(t.remark) + '</td></tr>';
      }).join('');
      return '<tbody class="pc-gr"><tr class="pc-gr-hd" data-g="' + FW.esc(g) + '" onclick="pcToggleGroup(this)"><td colspan="4">' + FW.esc(g) + ' <span class="pc-gr-cnt">' + gr.length + ' 笔</span></td><td class="num amt-expense">' + FW.fmtMoney(sum) + '</td><td><span class="pc-gr-tg">▼</span></td></tr>' + detail + '</tbody>';
    }).join('');
    return '<div style="max-height:54vh;overflow:auto"><table class="pc-unclass-table">' + tb + '</table></div>';
  }
  window.pcToggleGroup = function (tr) {
    var tbody = tr.parentNode;
    var rows = tbody.querySelectorAll('.pc-gr-row');
    var collapsed = tr.getAttribute('data-collapse') === '1';
    for (var i = 0; i < rows.length; i++) rows[i].style.display = collapsed ? '' : 'none';
    tr.setAttribute('data-collapse', collapsed ? '0' : '1');
    var tg = tr.querySelector('.pc-gr-tg'); if (tg) tg.textContent = collapsed ? '▼' : '▶';
  };
  // ---------- 导出图片（③：与老板月报一致，复用 FWTableImg） ----------
  function exportImage() {
    var v = getView();
    if (!v.rows || !v.rows.length) { FW.toast('没有可导出的项目'); return; }
    if (!FWTableImg || !FWTableImg.render) { FW.toast('图片导出组件未加载'); return; }
    var rows = v.rows.map(function (r) {
      return {
        cells: [
          String(r.rank), r.project, (r.qty || 0),
          FW.fmtMoney(r.revenue), FW.fmtMoney(r.flowCost), FW.fmtMoney(r.laborCost || 0),
          FW.fmtMoney(r.totalCost), FW.fmtMoney(r.profit),
          (isFinite(r.rate) ? r.rate.toFixed(1) + '%' : '—'),
          (isFinite(r.roi) ? fmtRoi(r.roi) : '—'),
          r.profit >= 0 ? '盈利' : '亏损'
        ],
        amountCls: r.profit >= 0 ? 'income' : 'expense'
      };
    });
    FWTableImg.render({
      title: '项目成本利润核算',
      subtitle: (state.year === 'all' ? '全部年度' : state.year + ' 年') + ' · 财务工作台',
      kpis: [
        { label: '参与项目', value: v.rows.length + ' 个' },
        { label: '总收入', value: FW.fmtMoney(v.data.vTot.revenue), cls: 'income' },
        { label: '总成本', value: FW.fmtMoney(v.data.vTot.totalCost), cls: 'expense' },
        { label: '总利润', value: FW.fmtMoney(v.data.vTot.profit), cls: v.data.vTot.profit >= 0 ? 'income' : 'expense' }
      ],
      head: ['排名', '项目', '单量', '收入', '流水成本', '工资成本', '总成本', '利润', '利润率', '投入产出比', '盈亏'],
      rows: rows,
      amountCol: 7,
      footer: '财务工作台 · 项目核算导出'
    }).then(function (canvas) {
      FWTableImg.downloadPNG(canvas, '项目核算_' + (state.year === 'all' ? '全部年度' : state.year) + '.png');
      FW.toast('已导出图片');
    }).catch(function (e) { FW.toast('导出图片失败：' + (e && e.message ? e.message : e)); });
  }

  function render() { buildTop(); buildBody(); }

  // 顶部操作区（仅保留导出 / 校正按钮；筛选控件下移至排名表上方）
  function buildTop() {
    var top = document.getElementById('topActions');
    if (!top) return;
    top.innerHTML =
      '<button class="btn" id="pcExport">⬇ 导出CSV</button>' +
      '<button class="btn ghost" id="pcExportX">⬇ 导出Excel</button>' +
      '<button class="btn ghost" id="pcImg" title="导出当前表格为图片(PNG)">🖼 导出图片</button>' +
      '<button class="btn ghost" id="pcPdf" title="打印为PDF（打印对话框选另存为PDF）">🖨 导出PDF</button>' +
      '<button class="btn ghost" id="pcBatchQty" title="批量粘贴 项目名,单量 录入签收单量">📝 批量录单量</button>' +
      '<button class="btn ghost" id="pcCorrect" title="把按净额记的收入，补填被扣除的支出，还原实际收入与利润率">🛠 校正净额收入</button>';
    document.getElementById('pcExport').onclick = function () { var v = getView(); exportCSV(v.rows, v.data); };
    document.getElementById('pcExportX').onclick = function () { var v = getView(); exportXLSX(v.rows, v.data); };
    document.getElementById('pcImg').onclick = exportImage;
    document.getElementById('pcPdf').onclick = function () { window.print(); };
    document.getElementById('pcBatchQty').onclick = function () { openBatchQty(); };
    document.getElementById('pcCorrect').onclick = function () { openDeductCorrector(); };
  }

  // 筛选行 HTML（年度 / 搜索 / 盈亏 / 成本率口径 / 剔除 / 分类筛选）——插入在排名表正上方
  function filterBarHtml(data) {
    var years = getYears();
    return '<div id="pcFilterBar" class="pc-filter-bar">' +
      '<label class="pc-year-label">统计年度</label>' +
      '<select id="pcYear" class="pc-year">' +
      '<option value="all"' + (state.year === 'all' ? ' selected' : '') + '>全部年度</option>' +
      years.map(function (y) { return '<option value="' + y + '"' + (state.year === y ? ' selected' : '') + '>' + y + ' 年</option>'; }).join('') +
      '</select>' +
      '<input id="pcSearch" class="pc-search" type="search" placeholder="搜索项目名" value="' + FW.esc(state.kw) + '">' +
      '<select id="pcPnl" class="pc-year">' +
      '<option value="all"' + (state.pnl === 'all' ? ' selected' : '') + '>全部盈亏</option>' +
      '<option value="profit"' + (state.pnl === 'profit' ? ' selected' : '') + '>仅盈利</option>' +
      '<option value="loss"' + (state.pnl === 'loss' ? ' selected' : '') + '>仅亏损</option>' +
      '</select>' +
      '<span class="pc-costtype-label">成本率口径</span>' +
      '<select id="pcCostType" class="pc-year"><option value="">总成本（默认）</option></select>' +
      '<select id="pcCostType2" class="pc-year" disabled><option value="">全部二级</option></select>' +
      '<label class="pc-excl-label"><input type="checkbox" id="pcCostExcl"' + (state.costExcl ? ' checked' : '') + '> 剔除所选成本类</label>' +
      '<button class="btn ghost" id="pcCatToggle">筛选成本分类 ▼</button>' +
      '<button class="btn ghost" id="pcColToggle">显示列 ▼</button>' +
      '<span class="pc-sort-label">排序</span>' +
      '<select id="pcSortKey" class="pc-year">' +
      [['profit', '利润'], ['revenue', '收入'], ['flowCost', '流水成本'], ['recoverable', '应收回款项'], ['laborCost', '工资成本'], ['totalCost', '总成本'], ['rate', '利润率'], ['cr', '成本率'], ['roi', '投入产出比'], ['qty', '签收单量'], ['project', '项目']]
        .map(function (o) { return '<option value="' + o[0] + '"' + (state.sortKey === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') +
      '</select>' +
      '<select id="pcSortDir" class="pc-year">' +
      '<option value="desc"' + (state.sortDir === 'desc' ? ' selected' : '') + '>降序</option>' +
      '<option value="asc"' + (state.sortDir === 'asc' ? ' selected' : '') + '>升序</option>' +
      '</select>' +
      '<button class="btn ghost" id="pcToggleAll">' + (Object.keys(state.expanded).length ? '收起全部' : '展开全部') + '</button>' +
      '</div>' +
      '<div id="pcCatPanel" class="pc-cat-panel"' + (state.showCatPanel ? '' : ' style="display:none"') + '>' +
      '<div class="pc-cat-panel-hd"><b>显示的成本分类</b><span class="muted">取消勾选后，该分类会从流水成本、总成本、利润及成本率中剔除并重算</span></div>' +
      '<div class="pc-cat-list">' + catCheckboxes(data) + '</div>' +
      '<div class="pc-cat-panel-ft"><button class="btn sm" id="pcCatAll">全选</button> <button class="btn sm" id="pcCatNone">全不选</button></div>' +
      '</div>' +
      '<div id="pcColPanel" class="pc-cat-panel"' + (state.showColPanel ? '' : ' style="display:none"') + '>' +
      '<div class="pc-cat-panel-hd"><b>显示的表格列</b><span class="muted">取消勾选「流水成本 / 应收回款项 / 工资成本 / 收入」后，对应项会从总成本中剔除，利润、利润率、成本率、投入产出比随之重算</span></div>' +
      '<div class="pc-cat-list">' + colCheckboxes() + '</div>' +
      '<div class="pc-cat-panel-ft"><button class="btn sm" id="pcColAll">全选</button> <button class="btn sm" id="pcColNone">全不选</button></div>' +
      '</div>';
  }

  // 成本分类筛选面板里的复选框（data.allCats 为全部一级分类，data.catTot 为当前可见金额）
  function catCheckboxes(data) {
    var cats = data.allCats || Object.keys(data.catTot || {}).sort();
    if (!cats.length) return '<span class="muted">暂无成本分类</span>';
    return cats.map(function (c) {
      var checked = !state.hiddenCats[c];
      var amt = data.catTot[c] || 0;
      return '<label class="pc-cat-item"><input type="checkbox" class="pc-cat-chk" value="' + FW.esc(c) + '"' + (checked ? ' checked' : '') + '> ' + FW.esc(c) + ' <span class="muted">' + FW.fmtMoney(amt) + '</span></label>';
    }).join('');
  }

  // 列显示控制面板里的复选框
  function colCheckboxes() {
    return COL_DEFS.map(function (c) {
      var checked = state.visibleCols.indexOf(c.key) > -1;
      var disabled = c.fixed ? ' disabled' : '';
      return '<label class="pc-cat-item' + (c.fixed ? ' disabled' : '') + '"><input type="checkbox" class="pc-col-chk" value="' + FW.esc(c.key) + '"' + (checked ? ' checked' : '') + disabled + '> ' + FW.esc(c.label) + (c.fixed ? ' <span class="muted">固定</span>' : '') + '</label>';
    }).join('');
  }

  // 计算当前视图数据（含筛选 + 单量/单产补全 + 成本分类剔除）
  function getView() {
    var data = compute(state.year, state.hiddenCats);
    var rows = enrichRows(filterRows(data.rows, state.kw, state.pnl));
    return { data: data, rows: rows };
  }

  function buildBody() {
    var v = getView();
    var data = v.data, rows = sortRows(v.rows);
    var hiddenList = Object.keys(state.hiddenCats || {});
    var filterNote = ((state.kw || state.pnl !== 'all' || hiddenList.length) ?
      '<div class="pc-filter-note">已筛选显示 <b>' + rows.length + '</b> 个项目' +
      (hiddenList.length ? '；已剔除成本分类：<b>' + hiddenList.map(FW.esc).join('、') + '</b>（流水成本/总成本/利润/成本率已重算）' : '') +
      '（筛选作用于下方图表与表格；上方 KPI 卡片为当前筛选汇总）。</div>' : '');
    var html = '<div class="salary-wrap">';
    html += statRow(data);
    html += recoverNote(data);
    html += unallocHtml(data);
    // 筛选行 + 排名数据表置于图表上方
  html += filterBarHtml(data);
  html += unclassifiedBanner();
  html += stockNote(data);
  html += filterNote;
    html += tableHtml(rows, data);
    html += chartHtml(data, rows);
    html += profitRateHtml(rows);
    html += trendHtml(data);
    html += '</div>';
    var c = document.getElementById('content'); if (c) c.innerHTML = html;

    // 筛选行控件事件绑定（年度 / 搜索 / 盈亏）
    var yearEl = document.getElementById('pcYear');
    if (yearEl) yearEl.onchange = function () { state.year = this.value; buildBody(); };
    var searchEl = document.getElementById('pcSearch');
    if (searchEl) searchEl.oninput = function () { state.kw = this.value; buildBody(); };
    var pnlEl = document.getElementById('pcPnl');
    if (pnlEl) pnlEl.onchange = function () { state.pnl = this.value; buildBody(); };
  var ub = document.getElementById('pcUnclassView');
  if (ub) ub.onclick = openUnclassified;

  // 清理旧版「计入项目核算」写入的重复流水（带 srcStock 标记）
  var dl = document.getElementById('pcDropLegacy');
  if (dl) dl.onclick = function () {
    var list = legacyStockTx();
    if (!list.length) { FW.toast('没有需要清理的记录'); buildBody(); return; }
    if (!global.confirm('将删除 ' + list.length + ' 笔由旧版「计入项目核算」写入的内账流水（带 srcStock 标记）。你的其它流水不受影响，继续？')) return;
    list.forEach(function (t) { FW.db.remove('internal', t.id); });
    FW.toast('已删除 ' + list.length + ' 笔重复流水');
    buildBody();
  };

    // 自定义排序控件
    var sortKeyEl = document.getElementById('pcSortKey');
    if (sortKeyEl) sortKeyEl.onchange = function () { state.sortKey = this.value; buildBody(); };
    var sortDirEl = document.getElementById('pcSortDir');
    if (sortDirEl) sortDirEl.onchange = function () { state.sortDir = this.value; buildBody(); };

    // 展开全部 / 收起全部
    var toggleEl = document.getElementById('pcToggleAll');
    if (toggleEl) toggleEl.onclick = function () {
      if (Object.keys(state.expanded).length > 0) state.expanded = {};
      else rows.forEach(function (r) { state.expanded[r.project] = true; });
      buildBody();
    };

    // 成本率口径下拉（一级 + 二级联动）
    var ctSel = document.getElementById('pcCostType');
    if (ctSel) {
      var l1set = {};
      rows.forEach(function (r) { Object.keys(r.byCat || {}).forEach(function (k) { l1set[k] = 1; }); });
      ctSel.innerHTML = '<option value="">总成本（默认）</option>' +
        '<option value="__labor__"' + (state.costType === '__labor__' ? ' selected' : '') + '>工资成本（占比）</option>' +
        Object.keys(l1set).sort().map(function (k) {
          return '<option value="' + FW.esc(k) + '"' + (state.costType === k ? ' selected' : '') + '>' + FW.esc(k) + '</option>';
        }).join('');
      ctSel.onchange = function () { state.costType = this.value; state.costType2 = ''; if (!this.value) state.costExcl = false; buildBody(); };
    }
    var ct2Sel = document.getElementById('pcCostType2');
    if (ct2Sel) {
      var l2opts = '<option value="">全部二级</option>';
      if (state.costType && state.costType !== '__labor__') {
        var l2set = {};
        rows.forEach(function (r) {
          Object.keys(r.byCat2 || {}).forEach(function (full) {
            var parts = full.split(' / ');
            if ((parts[0] || '').trim() === state.costType) {
              var sub = (parts.slice(1).join(' / ') || '').trim() || '其他';
              l2set[sub] = 1;
            }
          });
        });
        l2opts += Object.keys(l2set).sort().map(function (s) {
          return '<option value="' + FW.esc(s) + '"' + (state.costType2 === s ? ' selected' : '') + '>' + FW.esc(s) + '</option>';
        }).join('');
      }
      ct2Sel.innerHTML = l2opts;
      ct2Sel.disabled = !state.costType || state.costType === '__labor__';
      ct2Sel.onchange = function () { state.costType2 = this.value; buildBody(); };
    }
    // 剔除所选成本类：仅当选了某成本类 / 工资成本时可用
    var exclEl = document.getElementById('pcCostExcl');
    if (exclEl) {
      exclEl.disabled = !state.costType;
      exclEl.checked = !!state.costExcl && !!state.costType;
      exclEl.onchange = function () { state.costExcl = this.checked; buildBody(); };
    }

    // 成本分类筛选面板
    var catToggle = document.getElementById('pcCatToggle');
    var catPanel = document.getElementById('pcCatPanel');
    if (catToggle && catPanel) {
      catToggle.onclick = function () {
        state.showCatPanel = !state.showCatPanel;
        // 列面板互斥：打开成本分类时关闭列面板
        if (state.showCatPanel) { state.showColPanel = false; var colPanel = document.getElementById('pcColPanel'); if (colPanel) colPanel.style.display = 'none'; var colToggle = document.getElementById('pcColToggle'); if (colToggle) colToggle.textContent = '显示列 ▼'; }
        catPanel.style.display = state.showCatPanel ? '' : 'none';
        catToggle.textContent = '筛选成本分类 ' + (state.showCatPanel ? '▲' : '▼');
      };
      Array.prototype.forEach.call(catPanel.querySelectorAll('.pc-cat-chk'), function (chk) {
        chk.onchange = function () {
          if (this.checked) delete state.hiddenCats[this.value]; else state.hiddenCats[this.value] = 1;
          buildBody();
        };
      });
      var catAll = document.getElementById('pcCatAll');
      if (catAll) catAll.onclick = function () { state.hiddenCats = {}; buildBody(); };
      var catNone = document.getElementById('pcCatNone');
      if (catNone) catNone.onclick = function () { (data.allCats || Object.keys(data.catTot || {})).forEach(function (c) { state.hiddenCats[c] = 1; }); buildBody(); };
    }

    // 列显示控制面板
    var colToggle = document.getElementById('pcColToggle');
    var colPanel = document.getElementById('pcColPanel');
    if (colToggle && colPanel) {
      colToggle.onclick = function () {
        state.showColPanel = !state.showColPanel;
        // 成本分类面板互斥
        if (state.showColPanel) { state.showCatPanel = false; if (catPanel) catPanel.style.display = 'none'; if (catToggle) catToggle.textContent = '筛选成本分类 ▼'; }
        colPanel.style.display = state.showColPanel ? '' : 'none';
        colToggle.textContent = '显示列 ' + (state.showColPanel ? '▲' : '▼');
      };
      Array.prototype.forEach.call(colPanel.querySelectorAll('.pc-col-chk'), function (chk) {
        chk.onchange = function () {
          if (this.checked) {
            if (state.visibleCols.indexOf(this.value) < 0) state.visibleCols.push(this.value);
          } else {
            state.visibleCols = state.visibleCols.filter(function (k) { return k !== this.value; }.bind(this));
          }
          buildBody();
        };
      });
      var colAll = document.getElementById('pcColAll');
      if (colAll) colAll.onclick = function () { state.visibleCols = COL_DEFS.map(function (c) { return c.key; }); buildBody(); };
      var colNone = document.getElementById('pcColNone');
      if (colNone) colNone.onclick = function () { state.visibleCols = COL_DEFS.filter(function (c) { return c.fixed; }).map(function (c) { return c.key; }); buildBody(); };
    }

    // 下钻：点击项目行展开/收起明细
    var tbl = document.getElementById('pcTable');
    if (tbl) {
      tbl.onclick = function (e) {
        if (!e.target) return;
        // 签收单量输入框不触发行展开
        if (e.target.tagName === 'INPUT' || (e.target.closest && e.target.closest('.pc-qty-cell'))) return;
        // 【新增】点击逐笔明细按钮 → 弹出该项目逐笔流水
        var detailBtn = e.target.closest ? e.target.closest('.pc-detail-tx') : null;
        if (detailBtn) { openProjectDetail(detailBtn.getAttribute('data-p')); return; }
        // 【新增】点击收入金额 → 弹出收入明细
        var incomeCell = e.target.closest ? e.target.closest('td.amt-income.clickable-amt') : null;
        if (incomeCell) {
          var incTr = incomeCell.closest ? incomeCell.closest('tr[data-p]') : null;
          if (incTr) { openIncomeDetail(incTr.getAttribute('data-p')); return; }
        }
        // 【新增】点击瀑布图下钻数字（收入/流水成本/应收回款项/工资成本）
        var pfChip = e.target.closest ? e.target.closest('.pc-pf') : null;
        if (pfChip) {
          var pfMap = { income: 'income', flowCost: 'cost', recover: 'recover', labor: 'labor' };
          openProjectDetail(pfChip.getAttribute('data-p'), pfMap[pfChip.getAttribute('data-pf')] || 'all'); return;
        }
        // 【新增】点击主表流水成本/工资成本数字 → 按该项目（或合计行=全部项目）下钻
        var amtCell = e.target.closest ? e.target.closest('td.clickable-amt[data-t]') : null;
        if (amtCell) {
          var amtTr = amtCell.closest ? amtCell.closest('tr') : null;
          var amtProj = (amtTr && amtTr.classList.contains('proj-sum-total')) ? null : (amtTr && amtTr.getAttribute('data-p'));
          var amtType = amtCell.getAttribute('data-t');
          openProjectDetail(amtProj, amtType === 'labor' ? 'labor' : 'cost'); return;
        }
        // 【新增】点击计算结果单元格 → 弹出计算过程
        var calcCell = e.target.closest ? e.target.closest('td.calc-detail, td.calc-detail-total') : null;
        if (calcCell) {
          var calcTr = calcCell.closest ? calcCell.closest('tr') : null;
          var colKey = calcCell.getAttribute('data-col');
          if (calcTr && calcTr.classList.contains('proj-sum-total')) {
            openCalcDetail(null, colKey, data);
          } else {
            var p2 = calcTr && calcTr.getAttribute('data-p');
            var row = p2 && rows.find(function (r) { return r.project === p2; });
            if (row) openCalcDetail(row, colKey, data);
          }
          return;
        }
        var tr = e.target.closest ? e.target.closest('tr[data-p]') : null;
        if (!tr) return;
        var p = tr.getAttribute('data-p');
        if (state.expanded[p]) delete state.expanded[p]; else state.expanded[p] = true;
        buildBody();
      };
      // 签收单量：输入即时保存并局部刷新两个单产单元格（不整页重渲，避免输入框失焦）
      tbl.oninput = function (e) {
        var inp = e.target && e.target.classList && e.target.classList.contains('pc-qty-in') ? e.target : null;
        if (!inp) return;
        var tr = e.target.closest ? e.target.closest('tr[data-p]') : null;
        if (!tr) return;
        var p = tr.getAttribute('data-p');
        var q = parseFloat(inp.value); if (isNaN(q) || q < 0) q = 0;
        setQty(p, q);
        var rev = parseFloat(tr.getAttribute('data-rev')) || 0;
        var prof = parseFloat(tr.getAttribute('data-profit')) || 0;
        var revCell = tr.querySelector('[data-unit="rev"]');
        var profCell = tr.querySelector('[data-unit="profit"]');
        if (revCell) revCell.textContent = q > 0 ? FW.fmtMoney(rev / q) : '—';
        if (profCell) profCell.textContent = q > 0 ? FW.fmtMoney(prof / q) : '—';
      };
    }

    // 收入金额样式已在 tableHtml 中通过 clickable-amt 类设置
  }

  function statCard(label, val, cls) {
    return '<div class="sal-stat"><div class="sal-stat-val ' + (cls || '') + '">' + val + '</div><div class="sal-stat-label">' + label + '</div></div>';
  }

  function statRow(data) {
    var t = data.vTot;
    return '<div class="sal-stats">' +
      statCard('参与核算项目', data.rows.length + ' 个') +
      statCard('总收入', FW.fmtMoney(t.revenue), 'amt-income') +
      statCard('总流水成本', FW.fmtMoney(t.flowCost), 'amt-expense') +
      statCard('总工资成本', FW.fmtMoney(t.laborCost), 'amt-expense') +
      statCard('总成本', FW.fmtMoney(t.totalCost)) +
      statCard('总利润', FW.fmtMoney(t.profit), t.profit >= 0 ? 'amt-income' : 'amt-expense') +
      statCard('应收回款项（预付未用完）', FW.fmtMoney(t.recoverable), 'amt-recover') +
      statCard('平均利润率', (isFinite(t.rate) ? t.rate.toFixed(1) : '—') + '%') +
      statCard('平均投入产出比', isFinite(t.roi) ? t.roi.toFixed(2) : '∞') +
      '</div>';
  }

  // 应收回款项说明（来自往来账预付未用完余额）
  function recoverNote(data) {
    if (!data.tot.recoverable) return '';
    return '<div class="pc-note">' +
      '<span class="pc-note-ico">↩</span>' +
      '<div>项目「应收回款项」合计 <b>' + FW.fmtMoney(data.tot.recoverable) + '</b>：来自「往来账」中标记为 <b>预付</b> 且关联了项目的单据，取其<b>未用完余额</b>（预付款 − 已核销）。这笔<b>待收回</b>的钱从各项目「总成本」中<b>扣除</b>（总成本 = 流水成本 − 应收回款项 + 工资成本）。核销（消耗 / 收回）后余额减少，对总成本与利润的影响会同步联动调整。</div>' +
      '</div>';
  }

  // 旧版遗留：v54「→ 计入项目核算」按钮写入内账的支出流水（带 srcStock 标记），与现在的自动计入重复
  function legacyStockTx() {
    return (FW.db.getList('internal') || []).filter(function (t) { return t && t.srcStock; });
  }

  // 库存台账采购成本说明（营期净额自动计入）
  function stockNote(data) {
    var legacy = legacyStockTx();
    if (!data || (!data.stockCount && !legacy.length)) return '';
    var legacyHtml = legacy.length
      ? '<div class="pc-stock-warn">⚠️ 检测到 <b>' + legacy.length + '</b> 笔旧版「计入项目核算」写入的内账流水（营期：' +
        legacy.map(function (t) { return FW.esc(String(t.srcStock)); }).join('、') +
        '），与现在的自动计入<b>重复</b>，会导致成本翻倍。' +
        '<button class="btn sm" id="pcDropLegacy" style="margin-left:8px">删除这 ' + legacy.length + ' 笔重复流水</button>' +
        '（只删库存生成的，你自己的流水不受影响）</div>'
      : '';
    if (!data.stockCount) {
      return '<div class="pc-note pc-note-stock"><span class="pc-note-ico">📦</span><div>' + legacyHtml + '</div></div>';
    }
    return '<div class="pc-note pc-note-stock">' +
      '<span class="pc-note-ico">📦</span>' +
      '<div>库存台账 <b>' + data.stockCount + '</b> 个营期的<b>净额</b>（调货金额 − 退货金额）合计 <b>' + FW.fmtMoney(data.stockTot || 0) + '</b>，已自动计入各项目「流水成本」，分类固定为 <b>' + STOCK_CAT + '</b>（<b>营期名即项目名</b>，内账流水不重复写入）。' +
      (data.stockOn
        ? '若内账那笔采购支出<b>已挂同名项目</b>，请在上方「成本分类」里取消勾选 <b>' + STOCK_CAT + '</b> 即可排除，避免重复计算。'
        : '当前已剔除 <b>' + STOCK_CAT + '</b>，未计入成本。') +
      legacyHtml +
      '</div></div>';
  }

  // 未分配资金提醒
  function unallocHtml(data) {
    var u = data.unalloc;
    if (!u.flowCount && !u.laborCount && !u.prepayCount) return '';
    var parts = [];
    if (u.flowCount) parts.push('流水 <b>' + u.flowCount + '</b> 笔、合计 <b>' + FW.fmtMoney(u.flowAmt) + '</b> 未填写项目');
    if (u.laborCount) parts.push('工资 <b>' + u.laborCount + '</b> 条、合计 <b>' + FW.fmtMoney(u.laborAmt) + '</b> 未分类项目');
    if (u.prepayCount) parts.push('预付款 <b>' + u.prepayCount + '</b> 笔、余额合计 <b>' + FW.fmtMoney(u.prepayAmt) + '</b> 未关联项目');
    return '<div class="pc-unalloc">' +
      '<span class="pc-unalloc-ico">⚠</span>' +
      '<div class="pc-unalloc-body"><b>有 ' + parts.join('；') + '</b>，未纳入项目核算。' +
      (u.flowCount || u.laborCount ? '补全流水「项目」或工资「按项目分类」后，会自动进入对应项目的成本 / 利润。' : '') +
      (u.prepayCount ? '在「往来账」给预付款登记「关联项目」后，其未用完余额会自动进入对应项目的「应收回款项」。' : '') +
      '</div>' +
      '</div>';
  }

  function fmtRoi(v) { return isFinite(v) ? v.toFixed(2) : '∞'; }

  function chartHtml(data, rows) {
    rows = rows || data.rows;
    if (!rows.length) return '';
    var labels = rows.map(function (r) { return r.project; });
    var series = [
      { name: '收入', color: '#C8102E', values: rows.map(function (r) { return r.vRevenue; }) },
      { name: '总成本', color: '#1f9d55', values: rows.map(function (r) { return r.vTotalCost; }) },
      { name: '利润', color: '#C9A227', values: rows.map(function (r) { return r.vProfit; }) }
    ];
    var chartW = Math.max(440, labels.length * 74 + 70);
    var title = (state.year === 'all' ? '各项目 收入/成本/利润（全部年度）' : '各项目 收入/成本/利润（' + state.year + ' 年）');
    var h = '<div class="mindmap-box"><div style="min-width:' + chartW + 'px">' +
      FW.groupedBarChart(title, series, labels, { width: chartW, height: 240 }) + '</div></div>';

    // 成本结构拆解
    var structParts = [];
    if (data.cats.length) {
      structParts.push(FW.barChart('流水成本结构（按分类）', data.cats, { height: 210 }));
    }
    if (data.laborTypes.length) {
      structParts.push(FW.pieChart('工资成本构成（底薪/奖金/提成）', data.laborTypes));
    }
    if (structParts.length) {
      h += '<div class="pc-section-title">成本结构拆解</div>';
      h += '<div class="pc-charts">' + structParts.join('') + '</div>';
      if (data.vTot.flowCost || data.vTot.laborCost) {
        h += FW.pieChart('总成本构成（流水 vs 工资）', [
          { label: '流水成本', value: data.vTot.flowCost },
          { label: '工资成本', value: data.vTot.laborCost }
        ]);
      }
    }
    return h;
  }

  // 各项目利润率横向对比条（红=盈利 绿=亏损，按利润率降序）
  function profitRateHtml(rows) {
    if (!rows || !rows.length) return '';
    var maxAbs = Math.max.apply(null, rows.map(function (r) { return Math.abs(r.vRate); }).concat([1]));
    var items = rows.slice().sort(function (a, b) { return b.vRate - a.vRate; });
    var bars = items.map(function (r) {
      var w = (Math.abs(r.vRate) / maxAbs * 100).toFixed(1);
      var color = r.vRate >= 0 ? '#C8102E' : '#1f9d55';
      var sign = r.vRate >= 0 ? '+' : '';
      return '<div class="pc-rate-row">' +
        '<span class="pc-rate-name" title="' + FW.esc(r.project) + '">' + FW.esc(FW.clip(r.project, 8)) + '</span>' +
        '<span class="pc-rate-track"><span class="pc-rate-fill" style="width:' + w + '%;background:' + color + '"></span></span>' +
        '<span class="pc-rate-val" style="color:' + color + '">' + sign + (isFinite(r.vRate) ? r.vRate.toFixed(1) : '—') + '%</span>' +
        '</div>';
    }).join('');
    return '<div class="pc-section-title">各项目利润率对比（红=盈利 绿=亏损）</div><div class="pc-rate-list">' + bars + '</div>';
  }

  // 利润形成瀑布图（返回 SVG 片段，由调用方包裹标题）；收入 − 流水成本 + 应收回款项 − 工资成本 = 利润
  function profitWaterfall(r) {
    var w = 340, h = 230, padL = 44, padB = 30, padT = 16, padR = 12;
    var steps = [
      { label: '收入', val: r.revenue, kind: 'inc' },
      { label: '流水成本', val: -r.flowCost, kind: 'dec' },
      { label: '应收回款项', val: r.recoverable, kind: 'rec' },
      { label: '工资成本', val: -r.laborCost, kind: 'dec' },
      { label: '利润', val: r.profit, kind: 'tot' }
    ];
    var run = 0, tops = [], bots = [], levels = [];
    steps.forEach(function (s) {
      var level;
      if (s.kind === 'tot') { tops.push(Math.max(s.val, 0)); bots.push(Math.min(s.val, 0)); level = s.val; }
      else { var a = run, b = run + s.val; tops.push(Math.max(a, b)); bots.push(Math.min(a, b)); level = b; }
      levels.push(level); run = level;
    });
    var hi = Math.max.apply(null, tops.concat([1]));
    var lo = Math.min.apply(null, bots.concat([0]));
    var range = (hi - lo) || 1;
    function Y(v) { return padT + (h - padB - padT) * (1 - (v - lo) / range); }
    var n = steps.length, gw = (w - padL - padR) / n, bw = Math.min(gw * 0.62, 30);
    var col = { inc: '#C8102E', dec: '#1f9d55', rec: '#2C7A6B', tot: r.profit >= 0 ? '#C8102E' : '#1f9d55' };
    var svg = '<svg class="chart-svg" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="xMidYMid meet">';
    svg += '<line x1="' + padL + '" y1="' + Y(0).toFixed(1) + '" x2="' + (w - padR) + '" y2="' + Y(0).toFixed(1) + '" stroke="#E0E5DD"/>';
    steps.forEach(function (s, idx) {
      var x = padL + gw * idx + (gw - bw) / 2;
      var yt = Y(tops[idx]), yb = Y(bots[idx]);
      var hgt = Math.max(Math.abs(yb - yt), 1.5);
      svg += '<rect x="' + x.toFixed(1) + '" y="' + yt.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + hgt.toFixed(1) + '" rx="2" fill="' + col[s.kind] + '" opacity="0.9"/>';
      if (idx < n - 1) { var nx = padL + gw * (idx + 1) + (gw - bw) / 2; svg += '<line x1="' + (x + bw).toFixed(1) + '" y1="' + Y(levels[idx]).toFixed(1) + '" x2="' + nx.toFixed(1) + '" y2="' + Y(levels[idx]).toFixed(1) + '" stroke="#c7cedb" stroke-dasharray="3 2"/>'; }
      svg += '<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (yt - 4).toFixed(1) + '" font-size="8.5" text-anchor="middle" fill="#41506a">' + FW.shortMoney(s.val) + '</text>';
      svg += '<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (h - padB + 13).toFixed(1) + '" font-size="9" text-anchor="middle" fill="#7a869a">' + FW.esc(FW.clip(s.label, 6)) + '</text>';
    });
    svg += '</svg>';
    return svg;
  }

  // 逐月趋势
  function trendHtml(data) {
    if (!data.monthly.labels.length) return '';
    var m = data.monthly;
    var series = [
      { name: '收入', color: '#C8102E', points: m.labels.map(function (lb, i) { return { label: lb, value: m.revenue[i] }; }) },
      { name: '总成本', color: '#1f9d55', points: m.labels.map(function (lb, i) { return { label: lb, value: m.cost[i] }; }) },
      { name: '利润', color: '#C9A227', points: m.labels.map(function (lb, i) { return { label: lb, value: m.profit[i] }; }) }
    ];
    var title = (state.year === 'all' ? '逐月 收入/成本/利润趋势（全部年度）' : '逐月 收入/成本/利润趋势（' + state.year + ' 年）');
    return '<div class="pc-section-title">逐月趋势</div>' + FW.lineChart(title, series, {}) +
      '<div class="muted" style="font-size:12px;margin:-6px 0 8px">点项目行可展开查看该项目的成本分类、工资构成与应收回款项明细。<b>点击收入金额、流水成本、工资成本等数字均可下钻查看逐笔流水。</b>注：本趋势为当月实际收支（不含预付款余额），表格「总成本 / 利润」为已扣除应收回款项（预付未用完）的口径。</div>';
  }

  // 按一二级分类渲染明细表（用于收入构成 / 流水成本构成）
  function cat2DetailTable(byCat2, colorClass) {
    var cat2Keys = Object.keys(byCat2 || {}).filter(function (k) { return byCat2[k] !== 0; });
    if (!cat2Keys.length) return '';
    // 按一级分组
    var grouped = {};
    cat2Keys.forEach(function (full) {
      var parts = full.split(' / ');
      var lvl1 = (parts[0] || '').trim() || '其他';
      var lvl2 = (parts.slice(1).join(' / ') || '').trim() || '其他';
      if (!grouped[lvl1]) grouped[lvl1] = [];
      grouped[lvl1].push({ full: full, sub: lvl2, val: byCat2[full] });
    });
    // 按一级的合计降序
    var lvl1Order = Object.keys(grouped).map(function (l1) {
      return { l1: l1, total: grouped[l1].reduce(function (s, x) { return s + x.val; }, 0), items: grouped[l1] };
    }).sort(function (a, b) { return b.total - a.total; });

    var h = '<table class="pc-cat2-table"><thead><tr><th>一级分类</th><th>二级分类</th><th class="num">金额</th></tr></thead><tbody>';
    lvl1Order.forEach(function (g) {
      g.items.sort(function (a, b) { return Math.abs(b.val) - Math.abs(a.val); });
      var rowSpan = g.items.length;
      g.items.forEach(function (it, ii) {
        h += '<tr>';
        if (ii === 0) h += '<td rowspan="' + rowSpan + '" class="cat2-l1">' + FW.esc(g.l1) + '</td>';
        h += '<td class="cat2-l2">' + FW.esc(it.sub) + '</td>';
        h += '<td class="num ' + colorClass(it.val) + '">' + FW.fmtMoney(it.val) + '</td></tr>';
      });
      // 一级小计行
      h += '<tr class="cat2-subtotal"><td colspan="2" class="cat2-l1-total">「' + FW.esc(g.l1) + '」小计</td>';
      h += '<td class="num"><b>' + FW.fmtMoney(g.total) + '</b></td></tr>';
    });
    h += '</tbody></table>';
    return h;
  }

  // 下钻明细
  function detailHtml(r) {
    var h = '<tr class="pc-detail-row"><td colspan="15"><div class="pc-detail">';
    h += '<div class="pc-detail-block"><h5>利润形成（瀑布图）</h5>' + profitWaterfall(r);
    // 瀑布图下方：可点击下钻的数字（点数字看钱花在哪）
    h += '<div class="pc-pf-chips no-print">' +
      '<span class="pc-pf" data-pf="income" data-p="' + FW.esc(r.project) + '" title="点击查看收入流水">收入 ' + FW.fmtMoney(r.revenue) + '</span>' +
      '<span class="pc-pf" data-pf="flowCost" data-p="' + FW.esc(r.project) + '" title="点击查看流水成本逐笔">流水成本 ' + FW.fmtMoney(r.flowCost) + '</span>' +
      '<span class="pc-pf" data-pf="recover" data-p="' + FW.esc(r.project) + '" title="点击查看应收回款项">应收回款项 ' + FW.fmtMoney(r.recoverable || 0) + '</span>' +
      '<span class="pc-pf" data-pf="labor" data-p="' + FW.esc(r.project) + '" title="点击查看工资成本逐笔">工资成本 ' + FW.fmtMoney(r.laborCost) + '</span>' +
      '</div>';
    // 瀑布图下方：收入构成按分类明细
    var revCatTable = cat2DetailTable(r.revByCat2, function () { return 'amt-income'; });
    if (revCatTable) {
      h += '<div style="margin-top:12px"><h5 style="margin:0 0 8px;font-size:13px;color:var(--text)">收入构成（按分类）</h5>' + revCatTable + '</div>';
    }
    h += '<div class="muted" style="font-size:11px;margin-top:8px">收入 − 流水成本 + 应收回款项 − 工资成本 = 利润（应收回款项为预付未用完、从成本中扣除的可收回项）。<b>点上方任一数字可下钻查看该项目的逐笔流水。</b></div></div>';
    var cats = Object.keys(r.byCat).map(function (c) { return { label: c, value: r.byCat[c] }; }).sort(function (a, b) { return b.value - a.value; });
    h += '<div class="pc-detail-block"><h5>流水成本构成（按分类）</h5>';
    h += cats.length ? FW.barChart('', cats, { height: 180 }) : '<div class="muted">无</div>';

    // 二级分类明细：按一级分组，展示 "一级 → 二级 → 金额"
    var costCatTable = cat2DetailTable(r.byCat2, function (v) { return v >= 0 ? 'amt-expense' : 'amt-recover'; });
    if (costCatTable) h += costCatTable;

    h += '</div>';
    var lt = [
      { label: '底薪', value: r.laborByType.base },
      { label: '奖金', value: r.laborByType.bonus },
      { label: '提成', value: r.laborByType.commission }
    ].filter(function (x) { return x.value > 0; });
    h += '<div class="pc-detail-block"><h5>工资成本构成（底薪/奖金/提成）</h5>';
    h += lt.length ? FW.pieChart('', lt) : '<div class="muted">无</div>';
    h += '</div>';
    if (r.recoverList && r.recoverList.length) {
      h += '<div class="pc-detail-block"><h5>应收回款项明细（预付未用完，来自「往来账」）</h5>';
      h += '<table class="pc-recov-table"><thead><tr>' +
        '<th>供应商 / 对象</th><th>单据日期</th><th class="num">预付金额</th><th class="num">已核销</th><th class="num">未用余额</th></tr></thead><tbody>';
      r.recoverList.forEach(function (x) {
        h += '<tr><td>' + FW.esc(x.party) + '</td><td>' + FW.esc(x.date) + '</td>' +
          '<td class="num">' + FW.fmtMoney(x.amount) + '</td>' +
          '<td class="num">' + FW.fmtMoney(x.settled) + '</td>' +
          '<td class="num amt-recover"><b>' + FW.fmtMoney(x.balance) + '</b></td></tr>';
      });
      h += '</tbody></table>';
      h += '<div class="muted" style="font-size:12px;margin-top:6px">以上为付给各对象的预付款尚未用完（已核销后）的余款，<b>已从本项目「总成本」中扣除</b>（作为可收回项）。核销（消耗 / 收回）后余额变化，总成本与利润会同步联动调整。</div>';
      h += '</div>';
    }
    h += '<div class="pc-detail-foot no-print"><button class="btn sm pc-detail-tx" data-p="' + FW.esc(r.project) + '">📄 查看逐笔明细</button><span class="muted" style="margin-left:8px">点此查看本项目每一笔流水（日期 / 分类 / 对方 / 金额）</span></div>';
    h += '</div></td></tr>';
    return h;
  }

  // 表格单元格渲染（根据列 key 与行/合计数据生成）
  function colTh(colKey) {
    var def = COL_DEFS.find(function (c) { return c.key === colKey; });
    var label = def ? def.label : colKey;
    if (colKey === 'costRate') label = costRateLabel();
    if (colKey === 'revenue') return '<th class="num">' + label + ' 👆</th>';
    if (colKey === 'rank') return '<th class="pc-rank">' + label + '</th>';
    if (['qty', 'revenue', 'revUnit', 'flowCost', 'recoverable', 'laborCost', 'totalCost', 'profit', 'profitUnit', 'rate', 'costRate', 'roi'].indexOf(colKey) > -1) return '<th class="num">' + label + '</th>';
    return '<th>' + label + '</th>';
  }
  function colTd(colKey, r) {
    var profitCls = r.profit >= 0 ? 'amt-income' : 'amt-expense';
    var badge = r.profit >= 0 ? '<span class="badge ok">盈利</span>' : '<span class="badge bad">亏损</span>';
    var open = !!state.expanded[r.project];
    var qtyVal = r.qty ? r.qty : '';
    var cr = costRateOf(r, state.costType, state.costType2, state.costExcl);
    switch (colKey) {
      case 'rank': return '<td class="pc-rank">' + r.rank + '</td>';
      case 'project': return '<td><span class="pc-caret">' + (open ? '▾' : '▸') + '</span> ' + FW.esc(r.project) + '</td>';
      case 'qty': return '<td class="num pc-qty-cell"><input class="pc-qty-in" type="number" min="0" step="1" value="' + qtyVal + '" placeholder="填单量" title="签收单量（手动录入，用于核算收入单产与净利润单产）"></td>';
      case 'revenue': return '<td class="num amt-income clickable-amt" title="点击查看收入明细">' + FW.fmtMoney(r.revenue) + '</td>';
      case 'revUnit': return '<td class="num" data-unit="rev">' + (r.revUnit == null ? '—' : FW.fmtMoney(r.revUnit)) + '</td>';
      case 'flowCost': return '<td class="num amt-expense clickable-amt" data-t="flowCost" title="点击查看流水成本逐笔">' + FW.fmtMoney(r.flowCost) + '</td>';
      case 'recoverable': return '<td class="num amt-recover">' + FW.fmtMoney(r.recoverable || 0) + '</td>';
      case 'laborCost': return '<td class="num amt-expense clickable-amt" data-t="labor" title="点击查看工资成本逐笔">' + FW.fmtMoney(r.laborCost) + '</td>';
      case 'totalCost': return '<td class="num calc-detail" data-col="totalCost" title="点击查看计算过程">' + FW.fmtMoney(r.vTotalCost) + '</td>';
      case 'profit': return '<td class="num ' + profitCls + ' calc-detail" data-col="profit" title="点击查看计算过程"><b>' + FW.fmtMoney(r.vProfit) + '</b></td>';
      case 'profitUnit': return '<td class="num calc-detail" data-col="profitUnit" data-unit="profit" title="点击查看计算过程">' + (r.profitUnit == null ? '—' : FW.fmtMoney(r.profitUnit)) + '</td>';
      case 'rate': return '<td class="num calc-detail" data-col="rate" title="点击查看计算过程">' + (isFinite(r.vRate) ? r.vRate.toFixed(1) + '%' : '—') + '</td>';
      case 'costRate': return '<td class="num calc-detail" data-col="costRate" data-cost="' + (state.costType ? cr.cost : r.vTotalCost) + '" title="点击查看计算过程">' + (state.costType ? cr.rate.toFixed(1) + '%' : (isFinite(r.vCostRate) ? r.vCostRate.toFixed(1) + '%' : '—')) + '</td>';
      case 'roi': return '<td class="num calc-detail" data-col="roi" title="点击查看计算过程">' + fmtRoi(r.vRoi) + '</td>';
      case 'pnl': return '<td class="calc-detail" data-col="pnl" title="点击查看计算过程">' + badge + '</td>';
      default: return '<td></td>';
    }
  }
  function colTotalTd(colKey, data, totalQty) {
    switch (colKey) {
      case 'rank': return '<td></td>';
      case 'project': return '<td>合计</td>';
      case 'qty': return '<td class="num">' + totalQty + '</td>';
      case 'revenue': return '<td class="num amt-income">' + FW.fmtMoney(data.vTot.revenue) + '</td>';
      case 'revUnit': return '<td class="num">—</td>';
      case 'flowCost': return '<td class="num amt-expense clickable-amt" data-t="flowCost" title="点击查看全部项目流水成本逐笔">' + FW.fmtMoney(data.vTot.flowCost) + '</td>';
      case 'recoverable': return '<td class="num amt-recover"><b>' + FW.fmtMoney(data.vTot.recoverable) + '</b></td>';
      case 'laborCost': return '<td class="num amt-expense clickable-amt" data-t="labor" title="点击查看全部项目工资成本逐笔">' + FW.fmtMoney(data.vTot.laborCost) + '</td>';
      case 'totalCost': return '<td class="num calc-detail-total" data-col="totalCost" title="点击查看计算过程">' + FW.fmtMoney(data.vTot.totalCost) + '</td>';
      case 'profit': return '<td class="num calc-detail-total" data-col="profit" title="点击查看计算过程"><b>' + FW.fmtMoney(data.vTot.profit) + '</b></td>';
      case 'profitUnit': return '<td class="num">—</td>';
      case 'rate': return '<td class="num calc-detail-total" data-col="rate" title="点击查看计算过程">' + (isFinite(data.vTot.rate) ? data.vTot.rate.toFixed(1) : '—') + '%</td>';
      case 'costRate': return '<td class="num calc-detail-total" data-col="costRate" title="点击查看计算过程">' + (isFinite(data.vTot.costRate) ? data.vTot.costRate.toFixed(1) : '—') + '%</td>';
      case 'roi': return '<td class="num calc-detail-total" data-col="roi" title="点击查看计算过程">' + fmtRoi(data.vTot.roi) + '</td>';
      case 'pnl': return '<td></td>';
      default: return '<td></td>';
    }
  }

  function tableHtml(rows, data) {
    if (!rows.length) {
      return '<div class="empty-state">' +
        '<div class="empty-ico">📊</div>' +
        '<div class="empty-title">还没有可用于项目核算的数据</div>' +
        '<div class="empty-sub">请在「登记内账」的流水里填写 <b>项目</b> 字段（收入与支出都计入），并在「工资登记」里把底薪 / 奖金 / 提成按 <b>项目</b> 分类。系统会把同一项目的收入、流水支出与工资成本汇总，自动核算利润、利润率与投入产出比（单产）。</div>' +
        '</div>';
    }
    var cols = COL_DEFS.filter(function (c) { return state.visibleCols.indexOf(c.key) > -1; });
    var h = '<div class="proj-sum-wrap"><table class="proj-sum-table" id="pcTable"><thead><tr>' +
      cols.map(function (c) { return colTh(c.key); }).join('') +
      '</tr></thead><tbody>';
    var totalQty = rows.reduce(function (s, r) { return s + (r.qty || 0); }, 0);
    rows.forEach(function (r) {
      var open = !!state.expanded[r.project];
      h += '<tr class="pc-row' + (open ? ' open' : '') + '" data-p="' + FW.esc(r.project) + '" data-rev="' + r.revenue + '" data-profit="' + r.profit + '">' +
        cols.map(function (c) { return colTd(c.key, r); }).join('') +
        '</tr>';
      if (open) h += detailHtml(r);
    });
    h += '<tr class="proj-sum-total">' + cols.map(function (c) { return colTotalTd(c.key, data, totalQty); }).join('') + '</tr>';
    h += '</tbody></table></div>';
    return h;
  }

  function exportCSV(rows, data) {
    if (!rows || !rows.length) { FW.toast('没有可导出的项目'); return; }
    var header = ['排名', '项目', '签收单量', '收入', '收入单产', '流水成本', '应收回款项', '工资成本', '总成本', '利润', '净利润单产', '利润率(%)', '成本率(%)', '投入产出比', '盈亏'];
    var lines = [header.join(',')];
    rows.forEach(function (r) {
      var cr = costRateOf(r, state.costType, state.costType2, state.costExcl);
      lines.push([
        r.rank, r.project, (r.qty || 0), r.revenue, (r.revUnit == null ? '' : Number(r.revUnit.toFixed(2))), r.flowCost, (r.recoverable || 0), r.laborCost, r.totalCost, r.profit,
        (r.profitUnit == null ? '' : Number(r.profitUnit.toFixed(2))), r.rate.toFixed(1), cr.rate.toFixed(1), fmtRoi(r.roi), r.profit >= 0 ? '盈利' : '亏损'
      ].join(','));
    });
    var tq = rows.reduce(function (s, r) { return s + (r.qty || 0); }, 0);
    var totCostRate = totalCostRatePct(data);
    lines.push([
      '', '合计', tq, data.tot.revenue, '', data.tot.flowCost, data.tot.recoverable, data.tot.laborCost, data.tot.totalCost, data.tot.profit,
      '', (isFinite(data.avgRate) ? data.avgRate.toFixed(1) : '—'), totCostRate.toFixed(1), fmtRoi(data.avgRoi), ''
    ].join(','));
    var csv = lines.join('\r\n');
    var blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = '项目成本利润核算_' + (state.year === 'all' ? '全部年度' : state.year) + '.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    FW.toast('已导出 CSV');
  }

  // 导出真正的 Excel（.xlsx）：金额列为数值，便于财务直接求和/筛选
  function exportXLSX(rows, data) {
    if (!rows || !rows.length) { FW.toast('没有可导出的项目'); return; }
    if (!window.XLSX) { FW.toast('Excel 导出组件未加载'); return; }
    var x = window.XLSX;
    var aoa = [['排名', '项目', '签收单量', '收入', '收入单产', '流水成本', '应收回款项', '工资成本', '总成本', '利润', '净利润单产', '利润率(%)', '成本率(%)', '投入产出比', '盈亏']];
    rows.forEach(function (r) {
      var cr = costRateOf(r, state.costType, state.costType2, state.costExcl);
      aoa.push([
        r.rank, r.project, (r.qty || 0), r.revenue, (r.revUnit == null ? '' : Number(r.revUnit.toFixed(2))), r.flowCost, (r.recoverable || 0), r.laborCost, r.totalCost, r.profit,
        (r.profitUnit == null ? '' : Number(r.profitUnit.toFixed(2))), Number(r.rate.toFixed(2)), Number(cr.rate.toFixed(2)), r.roi === Infinity ? '∞' : Number(r.roi.toFixed(2)), r.profit >= 0 ? '盈利' : '亏损'
      ]);
    });
    var tq = rows.reduce(function (s, r) { return s + (r.qty || 0); }, 0);
    var totCostRate = totalCostRatePct(data);
    aoa.push([
      '', '合计', tq, data.tot.revenue, '', data.tot.flowCost, data.tot.recoverable, data.tot.laborCost, data.tot.totalCost, data.tot.profit,
      '', data.avgRate === Infinity ? '—' : Number(data.avgRate.toFixed(2)), Number(totCostRate.toFixed(2)), data.avgRoi === Infinity ? '∞' : Number(data.avgRoi.toFixed(2)), ''
    ]);
    var wb = x.utils.book_new();
    var ws = x.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [
      { wch: 6 }, { wch: 18 }, { wch: 10 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 8 }
    ];
    x.utils.book_append_sheet(wb, ws, '项目核算');
    var out = x.write(wb, { bookType: 'xlsx', type: 'array' });
    var blob = new Blob([out], { type: 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = '项目成本利润核算_' + (state.year === 'all' ? '全部年度' : state.year) + '.xlsx';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    FW.toast('已导出 Excel');
  }

  // 批量录入签收单量：粘贴「项目名,单量」多行文本，一次性写入（单量=0 表示清空）
  function openBatchQty() {
    var body =
      '<div class="muted" style="font-size:12px;margin-bottom:8px">每行填写：<b>项目名,单量</b>（逗号、中文逗号或空格分隔均可，单量=0 表示清空）。例如：<br><code>项目A,120</code> &nbsp; <code>项目B 85</code> &nbsp; <code>项目C，0</code></div>' +
      '<textarea id="pcQtyInput" rows="10" style="width:100%;box-sizing:border-box;font-family:monospace;font-size:13px;padding:8px;border:1px solid var(--border);border-radius:6px" placeholder="项目A,120\n项目B,85"></textarea>' +
      '<div class="form-actions"><button class="btn ghost" id="pcQtyCancel">取消</button><button class="btn" id="pcQtySave">保存</button></div>';
    FW.openModal('批量录入签收单量', body, function () {
      document.getElementById('pcQtyCancel').onclick = FW.closeModal;
      document.getElementById('pcQtySave').onclick = function () {
        var txt = document.getElementById('pcQtyInput').value || '';
        var n = 0, bad = 0;
        txt.split('\n').forEach(function (ln) {
          ln = ln.trim();
          if (!ln) return;
          var m = ln.split(/[,，\s]+/);
          if (m.length < 2) { bad++; return; }
          var proj = (m[0] || '').trim();
          var q = num(m[1]);
          if (!proj) { bad++; return; }
          setQty(proj, q);
          n++;
        });
        FW.closeModal();
        buildBody();
        FW.toast(n ? ('已录入 ' + n + ' 个项目单量' + (bad ? ('，' + bad + ' 行格式有误已跳过') : '')) : (bad ? (bad + ' 行格式有误') : '无变更'));
      };
    });
  }

  // 批量校正：把按净额记的收入，补填被扣除的支出（已扣支出）
  function openDeductCorrector() {
    var inc = FW.db.getList('internal').filter(function (t) { return t.type === 'income'; })
      .sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
    var body =
      '<div class="muted" style="font-size:12px;margin-bottom:8px">以下为所有「收入」流水。若某笔是按<b>净额</b>记的（已扣除代付/代扣支出），请在「已扣支出」列填入被减去的金额。保存后：<b>实际收入</b> = 到账金额 + 已扣支出，已扣支出计入该项目<b>成本</b>（只计一次），利润率即正确；对账与到账金额不受影响。</div>' +
      '<div style="max-height:52vh;overflow:auto"><table class="pc-correct-table"><thead><tr><th>日期</th><th>项目</th><th>对方</th><th class="num">到账金额</th><th class="num">已扣支出</th><th class="num">实际收入</th></tr></thead><tbody>' +
      inc.map(function (t, i) {
        var d = num(t.deduct) > 0 ? num(t.deduct) : 0;
        return '<tr>' +
          '<td>' + FW.esc(t.date || '') + '</td>' +
          '<td>' + FW.esc(t.project || '—') + '</td>' +
          '<td>' + FW.esc(t.party || '—') + '</td>' +
          '<td class="num">' + FW.fmtMoney(num(t.amount)) + '</td>' +
          '<td class="num"><input class="pc-deduct-in" data-i="' + i + '" type="number" step="0.01" min="0" value="' + (d ? d : '') + '" style="width:90px"></td>' +
          '<td class="num pc-actual" data-i="' + i + '">' + FW.fmtMoney(num(t.amount) + d) + '</td>' +
          '</tr>';
      }).join('') +
      '</tbody></table></div>' +
      '<div class="form-actions"><button class="btn ghost" id="pcCorCancel">取消</button><button class="btn" id="pcCorSave">保存校正</button></div>';
    FW.openModal('校正净额收入', body, function () {
      FW.qa('.pc-deduct-in').forEach(function (inp) {
        inp.oninput = function () {
          var i = +this.dataset.i;
          var v = parseFloat(this.value) || 0;
          var cell = document.querySelector('.pc-actual[data-i="' + i + '"]');
          if (cell) cell.textContent = FW.fmtMoney(num(inc[i].amount) + v);
        };
      });
      document.getElementById('pcCorCancel').onclick = FW.closeModal;
      document.getElementById('pcCorSave').onclick = function () {
        var n = 0;
        FW.qa('.pc-deduct-in').forEach(function (inp) {
          var i = +this.dataset.i;
          var v = parseFloat(this.value);
          var dv = (v > 0 && !isNaN(v)) ? v : 0;
          var rec = inc[i];
          if (num(rec.deduct) !== dv) { rec.deduct = dv; FW.db.upsert('internal', rec); n++; }
        });
        FW.closeModal();
        buildBody();
        FW.toast(n ? ('已校正 ' + n + ' 笔收入') : '无变更');
      };
    });
  }

  FW.projectCostCalc = { compute: compute, salaryItems: salaryItems, salaryComps: salaryComps, getYears: getYears, openDeductCorrector: openDeductCorrector, filterRows: filterRows, enrichRows: enrichRows, getQtyMap: getQtyMap, setQty: setQty, costRateOf: costRateOf, costRateLabel: costRateLabel, costBasisTot: costBasisTot, totalCostRatePct: totalCostRatePct, splitAmounts: splitAmounts, openProjectDetail: openProjectDetail, openIncomeDetail: openIncomeDetail };

  FW.modules = FW.modules || {};
  FW.modules.projectCost = { title: '项目核算', render: render };
})(window);
