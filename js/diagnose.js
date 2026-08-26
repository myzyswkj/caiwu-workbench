/* 数据诊断 / 自检面板 —— 一键检测本地数据健康度与同步状态 */
(function (global) {
  'use strict';
  var FW = global.FW;
  function esc(s) { return FW.esc(s == null ? '' : String(s)); }

  function countKeys() {
    var keys = ['internal', 'internal_budget', 'projectCost', 'salary', 'invoices', 'contacts', 'memos', 'tax', 'knowledge', 'sites'];
    return keys.map(function (k) {
      var n = 0; try { n = FW.db.getList(k).length; } catch (e) {}
      return { k: k, n: n };
    });
  }
  function photoStats() {
    var rows = FW.db.getList('internal');
    var total = 0, pids = [];
    rows.forEach(function (t) { (t.photos || []).forEach(function (p) { if (p) { total++; pids.push(p); } }); });
    var sample = pids.slice(0, 60);
    return Promise.all(sample.map(function (pid) {
      return FW.db.getPhoto(pid).then(function (d) { return d ? null : pid; }).catch(function () { return pid; });
    })).then(function (res) {
      var missing = res.filter(Boolean).length;
      return { total: total, sample: sample.length, missing: missing };
    });
  }
  function unallocCount() {
    var rows = FW.db.getList('internal');
    var n = 0;
    rows.forEach(function (t) {
      var allocatable = (t.type === 'income' || t.type === 'expense' || t.type === 'refund');
      if (allocatable && !t.project && !t.skipAlloc) n++;
    });
    return n;
  }
  function syncStatus() {
    var logged = false;
    try { logged = Object.keys(localStorage).some(function (k) { return k.indexOf('-auth-token') >= 0; }); } catch (e) {}
    return logged;
  }
  function swStatus() {
    if (!('serviceWorker' in navigator)) return Promise.resolve({ registered: false, caches: [] });
    return navigator.serviceWorker.getRegistrations().then(function (regs) {
      return caches.keys().then(function (ck) { return { registered: regs.length > 0, caches: ck }; });
    }).catch(function () { return { registered: false, caches: [] }; });
  }

  function row(name, value, badge) {
    var b = badge ? ' <span class="dg-badge ' + (badge.cls || '') + '">' + (badge.text || '') + '</span>' : '';
    return '<div class="dg-row"><span class="dg-name">' + esc(name) + '</span><span class="dg-val">' + esc(value) + b + '</span></div>';
  }

  function run() {
    var body = document.getElementById('dgBody'); if (!body) return;
    body.innerHTML = '<div class="muted">正在检测…</div>';
    var keys = countKeys();
    var unalloc = unallocCount();
    var logged = syncStatus();
    var photoP = photoStats();
    var swP = swStatus();

    Promise.all([photoP, swP]).then(function (r) {
      var photo = r[0], sw = r[1];
      var html = '';
      html += '<div class="dg-card"><div class="dg-card-h">各模块数据量</div>';
      keys.forEach(function (o) { html += row(o.k, o.n + ' 条'); });
      html += '</div>';

      var photoBadge = photo.missing > 0 ? { cls: 'bad', text: '缺失 ' + photo.missing } : (photo.total > 0 ? { cls: 'ok', text: '正常' } : null);
      html += '<div class="dg-card"><div class="dg-card-h">凭证图</div>';
      html += row('凭证图总数', photo.total + ' 张');
      html += row('抽样检测（' + photo.sample + ' 张）缺失', photo.missing + ' 张', photoBadge);
      html += '</div>';

      var unBadge = unalloc > 0 ? { cls: 'warn', text: '待处理' } : { cls: 'ok', text: '无' };
      html += '<div class="dg-card"><div class="dg-card-h">分摊状态</div>';
      html += row('未分摊（有收支无项目）笔数', unalloc, unBadge);
      html += '</div>';

      html += '<div class="dg-card"><div class="dg-card-h">云同步</div>';
      html += row('Supabase 登录状态', logged ? '已登录' : '未登录', logged ? { cls: 'ok', text: '已连' } : { cls: 'warn', text: '未连' });
      html += '</div>';

      var swBadge = sw.registered ? { cls: 'ok', text: '已注册' } : { cls: 'bad', text: '未注册' };
      html += '<div class="dg-card"><div class="dg-card-h">Service Worker / 缓存</div>';
      html += row('SW 注册', sw.registered ? '是' : '否', swBadge);
      (sw.caches || []).forEach(function (k) { html += row('缓存版本', k); });
      html += '</div>';

      body.innerHTML = html;
    }).catch(function (e) {
      body.innerHTML = '<div class="dg-row"><span class="dg-name">检测异常</span><span class="dg-val">' + esc(e && e.message || e) + '</span></div>';
    });
  }

  function render() {
    var c = document.getElementById('content');
    c.innerHTML =
      '<div class="dg-wrap">' +
        '<h1 class="dg-title">数据自检 / 诊断</h1>' +
        '<div id="dgBody" class="dg-body"><div class="muted">正在检测…</div></div>' +
        '<div class="dg-actions no-print"><button class="btn" id="dgRefresh">🔄 重新检测</button></div>' +
      '</div>';
    document.getElementById('dgRefresh').onclick = run;
    run();
  }

  FW.modules = FW.modules || {};
  FW.modules.diagnose = { title: '数据诊断', render: render };
})(window);
