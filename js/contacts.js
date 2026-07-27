/* ============================================================
 * 往来账模块（应收 / 应付）
 * 借鉴：金蝶 / 柠檬云「往来管理」（客户应收账款、供应商应付账款、账龄分析）
 * 核销时可一键登记到「登记内账」流水，实现业务→财务联动
 * ============================================================ */
(function (global) {
  'use strict';
  var FW = global.FW;
  var KEY = 'contacts';
  var ACCTS = ['现金', '银行卡', '支付宝', '微信', '对公账户', '其他'];

  function all() {
    return FW.db.getList(KEY).sort(function (a, b) { return (a.date < b.date ? 1 : a.date > b.date ? -1 : 0); });
  }
  function balance(r) { return (Number(r.amount) || 0) - (Number(r.settled) || 0); }
  function ageDays(r) {
    if (balance(r) <= 0) return 0;
    return Math.floor((Date.now() - new Date(r.date).getTime()) / 86400000);
  }

  function render() {
    var list = all();
    var recA = list.filter(function (r) { return r.kind === '应收'; }).reduce(function (a, r) { return a + balance(r); }, 0);
    var payA = list.filter(function (r) { return r.kind === '应付'; }).reduce(function (a, r) { return a + balance(r); }, 0);

    // 账龄（未结清合计）
    var buckets = [0, 0, 0, 0];
    list.forEach(function (r) { var b = balance(r); if (b <= 0) return; var age = ageDays(r); if (age <= 30) buckets[0] += b; else if (age <= 60) buckets[1] += b; else if (age <= 90) buckets[2] += b; else buckets[3] += b; });
    var totalOut = buckets[0] + buckets[1] + buckets[2] + buckets[3];
    var agingHtml = '<div class="aging">' +
      agingRow('0–30 天', buckets[0], totalOut) +
      agingRow('31–60 天', buckets[1], totalOut) +
      agingRow('61–90 天', buckets[2], totalOut) +
      agingRow('90 天以上', buckets[3], totalOut) +
      '</div>';

    document.getElementById('content').innerHTML =
      '<div class="stat-row">' +
        '<div class="stat"><div class="label">应收未结（别人欠我）</div><div class="value expense">' + FW.fmtMoney(recA) + '</div></div>' +
        '<div class="stat"><div class="label">应付未结（我欠别人）</div><div class="value income">' + FW.fmtMoney(payA) + '</div></div>' +
        '<div class="stat"><div class="label">净头寸</div><div class="value">' + FW.fmtMoney(recA - payA) + '</div></div>' +
      '</div>' +
      '<div class="card"><h3>账龄分析 <span class="sub">未结清合计 ' + FW.fmtMoney(totalOut) + '</span></h3>' + agingHtml + '</div>' +
      '<div class="card"><h3>往来明细</h3>' + (list.length ? tableHtml(list) : '<div class="empty">还没有往来账，点右上角「＋ 新增往来」登记客户 / 供应商的应收应付。</div>') + '</div>';

    FW.qa('#content .c-settle').forEach(function (b) { b.onclick = function () { openSettle(b.dataset.id); }; });
    FW.qa('#content .c-del').forEach(function (b) { b.onclick = function () { if (confirm('删除该往来单？')) { FW.db.remove(KEY, b.dataset.id); render(); FW.toast('已删除'); } }; });

    var ta = document.getElementById('topActions');
    ta.innerHTML = '<button class="btn" id="cAdd">＋ 新增往来</button>';
    document.getElementById('cAdd').onclick = function () { openForm(); };
  }

  function agingRow(label, val, total) {
    var pct = total > 0 ? (val / total * 100) : 0;
    return '<div class="aging-row"><span class="aging-label">' + label + '</span>' +
      '<span class="aging-bar"><span class="aging-fill" style="width:' + pct.toFixed(0) + '%"></span></span>' +
      '<span class="aging-val">' + FW.fmtMoney(val) + '</span></div>';
  }

  function tableHtml(list) {
    var trs = list.map(function (r) {
      var b = balance(r), age = ageDays(r);
      var status = b <= 0 ? '<span class="tag">已结清</span>' : (Number(r.settled) > 0 ? '<span class="tag" style="background:#fff3e0;color:#f0a020">部分</span>' : '<span class="tag expense">未结</span>');
      var kindTag = r.kind === '应收' ? '<span class="tag expense">应收</span>' : '<span class="tag income">应付</span>';
      var ageTxt = b <= 0 ? '—' : age + ' 天';
      return '<tr>' +
        '<td>' + FW.esc(r.party) + '</td>' +
        '<td>' + FW.esc(r.category || '—') + '</td>' +
        '<td>' + kindTag + '</td>' +
        '<td class="num">' + FW.fmtMoney(r.amount) + '</td>' +
        '<td class="num">' + FW.fmtMoney(r.settled || 0) + '</td>' +
        '<td class="num ' + (b > 0 ? (r.kind === '应收' ? 'expense' : 'income') : '') + '"><b>' + FW.fmtMoney(b) + '</b></td>' +
        '<td class="nowrap">' + ageTxt + '</td>' +
        '<td>' + status + '</td>' +
        '<td class="row-actions nowrap"><button class="btn ghost sm c-settle" data-id="' + r.id + '">核销</button><button class="btn danger sm c-del" data-id="' + r.id + '">删</button></td>' +
        '</tr>';
    }).join('');
    return '<table><thead><tr><th>对方</th><th>类别</th><th>类型</th><th class="num">金额</th><th class="num">已收/付</th><th class="num">余额</th><th>账龄</th><th>状态</th><th>操作</th></tr></thead><tbody>' + trs + '</tbody></table>';
  }

  function openForm(id) {
    var edit = id ? FW.db.getById(KEY, id) : null;
    var v = edit || { party: '', kind: '应收', category: '客户', date: FW.today(), amount: '', remark: '', settled: 0 };
    var body =
      '<div class="form-grid">' +
        '<div class="field"><label>对方名称（客户/供应商）</label><input id="c_party" value="' + FW.esc(v.party) + '" placeholder="如：XX公司"></div>' +
        '<div class="field"><label>类型</label><select id="c_kind"><option value="应收" ' + (v.kind === '应收' ? 'selected' : '') + '>应收（别人欠我）</option><option value="应付" ' + (v.kind === '应付' ? 'selected' : '') + '>应付（我欠别人）</option></select></div>' +
        '<div class="field"><label>类别</label><select id="c_cat"><option ' + (v.category === '客户' ? 'selected' : '') + '>客户</option><option ' + (v.category === '供应商' ? 'selected' : '') + '>供应商</option><option ' + (v.category === '其他' ? 'selected' : '') + '>其他</option></select></div>' +
        '<div class="field"><label>发生日期</label><input id="c_date" type="date" value="' + FW.esc(v.date) + '"></div>' +
        '<div class="field"><label>金额（元）</label><input id="c_amount" type="number" step="0.01" min="0" value="' + FW.esc(v.amount) + '"></div>' +
        '<div class="field full"><label>备注</label><textarea id="c_remark" rows="2" placeholder="业务说明">' + FW.esc(v.remark || '') + '</textarea></div>' +
      '</div>' +
      '<div class="form-actions"><button class="btn ghost" id="cCancel">取消</button><button class="btn" id="cSave">保存</button></div>';
    FW.openModal(edit ? '编辑往来' : '新增往来', body, function () {
      document.getElementById('cCancel').onclick = FW.closeModal;
      document.getElementById('cSave').onclick = function () {
        var amt = parseFloat(document.getElementById('c_amount').value);
        if (!(amt >= 0) || isNaN(amt)) { FW.toast('请输入有效金额'); return; }
        var party = document.getElementById('c_party').value.trim();
        if (!party) { FW.toast('请填写对方名称'); return; }
        var rec = {
          id: edit ? edit.id : FW.db.uid('c_'),
          party: party,
          kind: document.getElementById('c_kind').value,
          category: document.getElementById('c_cat').value,
          date: document.getElementById('c_date').value || FW.today(),
          amount: amt,
          settled: Number(v.settled) || 0,
          remark: document.getElementById('c_remark').value.trim()
        };
        FW.db.upsert(KEY, rec); FW.closeModal(); render(); FW.toast('已保存');
      };
    });
  }

  function openSettle(id) {
    var r = FW.db.getById(KEY, id); if (!r) return;
    var remain = balance(r);
    var acctOpts = ACCTS.map(function (a) { return '<option>' + a + '</option>'; }).join('');
    var body =
      '<div class="settle-info"> ' + FW.esc(r.party) + ' · ' + r.kind + ' · 余额 <b>' + FW.fmtMoney(remain) + '</b></div>' +
      '<div class="form-grid">' +
        '<div class="field"><label>本次收/付金额（元）</label><input id="s_amt" type="number" step="0.01" min="0" max="' + remain + '" value="' + remain + '"></div>' +
        '<div class="field"><label>日期</label><input id="s_date" type="date" value="' + FW.today() + '"></div>' +
        '<div class="field"><label>账户（仅登记内账用）</label><select id="s_acct">' + acctOpts + '</select></div>' +
        '<div class="field full"><label>备注</label><input id="s_remark" value="' + FW.esc(r.party + (r.kind === '应收' ? ' 收款' : ' 付款')) + '"></div>' +
        '<div class="field full"><label><input type="checkbox" id="s_link" checked style="width:auto;margin-right:6px">同时登记到「登记内账」流水</label></div>' +
      '</div>' +
      '<div class="form-actions"><button class="btn ghost" id="sCancel">取消</button><button class="btn" id="sSave">确认核销</button></div>';
    FW.openModal('核销 · ' + r.party, body, function () {
      document.getElementById('sCancel').onclick = FW.closeModal;
      document.getElementById('sSave').onclick = function () {
        var amt = parseFloat(document.getElementById('s_amt').value);
        if (!(amt > 0) || isNaN(amt)) { FW.toast('请输入有效金额'); return; }
        if (amt > remain + 0.001) { FW.toast('不能超过余额 ' + FW.fmtMoney(remain)); return; }
        r.settled = (Number(r.settled) || 0) + amt;
        FW.db.upsert(KEY, r);
        if (document.getElementById('s_link').checked) {
          var type = r.kind === '应收' ? 'income' : 'expense';
          var cat = r.kind === '应收' ? '其他收入' : '其他支出';
          FW.db.upsert('internal', {
            id: FW.db.uid('t_'),
            date: document.getElementById('s_date').value || FW.today(),
            type: type,
            project: r.party,
            category: cat,
            account: document.getElementById('s_acct').value,
            amount: amt,
            remark: document.getElementById('s_remark').value.trim(),
            photos: []
          });
        }
        FW.closeModal(); render(); FW.toast('已核销 ' + FW.fmtMoney(amt));
      };
    });
  }

  FW.modules = FW.modules || {};
  FW.modules.contacts = { title: '往来账', render: render };
})(window);
