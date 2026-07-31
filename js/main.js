/* ============================================================
 * 主入口：导航路由、账本切换、启动门控（加密解锁）
 * ============================================================ */
(function (global) {
  'use strict';
  var FW = global.FW;

  function setModule(name) {
    var mod = FW.modules[name];
    if (!mod) return;
    FW.qa('#moduleNav .nav-item').forEach(function (b) { b.classList.toggle('active', b.dataset.module === name); });
    // 自动展开该模块所在的分组
    var item = document.querySelector('#moduleNav .nav-item[data-module="' + name + '"]');
    if (item && item.classList.contains('nav-child')) {
      var group = item.closest('.nav-group');
      if (group) { group.classList.add('open'); var body = group.querySelector('.nav-group-body'); if (body) body.hidden = false; }
    }
    document.getElementById('topTitle').textContent = mod.title || name;
    mod.render();
    renderSubNav(name);
  }

  /* ---------- 侧栏子导航：折叠自各模块顶部的标签栏目，内联展开在当前模块下方 ---------- */
  function clearInlineSubnav() {
    FW.qa('#moduleNav .subnav').forEach(function (el) { el.remove(); });
  }
  function renderSubNav(name) {
    clearInlineSubnav();
    var mod = FW.modules[name];
    var tabs = mod && mod.tabs;
    if (!tabs || !tabs.length) return;
    var item = document.querySelector('#moduleNav .nav-item[data-module="' + FW.esc(name) + '"]');
    if (!item) return;
    var cur = (mod.getTab && mod.getTab()) || tabs[0].key;
    var wrap = document.createElement('div');
    wrap.className = 'subnav';
    wrap.innerHTML = tabs.map(function (t) {
      return '<button class="subnav-item ' + (t.key === cur ? 'active' : '') + '" data-k="' + FW.esc(t.key) + '">' +
        '<span class="sn-dot"></span>' + FW.esc(t.label) + '</button>';
    }).join('');
    // 内联插入到当前模块的导航项正下方（手风琴式展开）
    item.insertAdjacentElement('afterend', wrap);
    FW.qa('.subnav-item', wrap).forEach(function (b) {
      b.onclick = function () {
        if (mod.setTab) mod.setTab(b.dataset.k);
        renderSubNav(name); // 刷新高亮
      };
    });
  }
  function refreshSubNav() {
    var active = document.querySelector('#moduleNav .nav-item.active');
    if (active) renderSubNav(active.dataset.module);
  }
  FW.nav = { renderSubNav: renderSubNav, refreshSubNav: refreshSubNav };
  // 供云端同步（sync.js pull）在合并数据后刷新界面：重渲染账本切换器 + 当前模块
  FW.setModule = setModule;
  FW.refreshLedgers = renderLedgerSwitch;

  /* ---------- 账本切换 ---------- */
  function renderLedgerSwitch() {
    var ledgers = FW.db.getLedgers();
    var cur = FW.db.getCurrentLedger();
    var curName = (ledgers.filter(function (l) { return l.id === cur; })[0] || { name: '默认账本' }).name;
    var btn = document.getElementById('lsCurrent');
    btn.textContent = '📚 ' + curName + ' ▾';

    var menu = document.getElementById('lsMenu');
    menu.innerHTML = ledgers.map(function (l) {
      return '<div class="ls-item ' + (l.id === cur ? 'active' : '') + '" data-id="' + l.id + '">' +
        '<span class="ls-name">' + FW.esc(l.name) + '</span>' +
        '<span class="ls-ops">' +
          '<button class="ls-op" data-act="rename" data-id="' + l.id + '" title="重命名">✎</button>' +
          '<button class="ls-op" data-act="del" data-id="' + l.id + '" title="删除账本">🗑</button>' +
        '</span></div>';
    }).join('') +
      '<div class="ls-item ls-add" data-act="add">＋ 新增账本</div>';

    FW.qa('#lsMenu .ls-item[data-id]').forEach(function (el) {
      el.onclick = function (e) {
        if (e.target.dataset.act) return; // 操作按钮单独处理
        switchLedger(el.dataset.id);
      };
    });
    FW.qa('#lsMenu .ls-op').forEach(function (op) {
      op.onclick = function (e) {
        e.stopPropagation();
        var id = op.dataset.id, act = op.dataset.act;
        if (act === 'rename') renameLedger(id);
        else if (act === 'del') deleteLedger(id);
      };
    });
    var addEl = menu.querySelector('[data-act="add"]');
    if (addEl) addEl.onclick = function () { addLedger(); };
  }

  function switchLedger(id) {
    if (id === FW.db.getCurrentLedger()) { document.getElementById('lsMenu').hidden = true; return; }
    FW.db.setCurrentLedger(id);
    document.getElementById('lsMenu').hidden = true;
    renderLedgerSwitch();
    var active = document.querySelector('#moduleNav .nav-item.active');
    if (active) setModule(active.dataset.module);
    FW.toast('已切换到「' + (FW.db.getLedgers().filter(function (l) { return l.id === id; })[0] || {}).name + '」');
  }

  function addLedger() {
    FW.openModal('新增账本', '<div class="field"><label>账本名称</label><input id="nl_name" placeholder="如：2026年公司账、家庭账"></div><div class="form-actions"><button class="btn ghost" id="nlCancel">取消</button><button class="btn" id="nlSave">创建</button></div>', function () {
      document.getElementById('nlCancel').onclick = FW.closeModal;
      document.getElementById('nlSave').onclick = function () {
        var name = document.getElementById('nl_name').value.trim();
        if (!name) { FW.toast('请输入账本名称'); return; }
        var list = FW.db.getLedgers();
        var id = 'L' + (Date.now().toString(36));
        list.push({ id: id, name: name });
        FW.db.setLedgers(list);
        FW.db.setCurrentLedger(id);
        FW.closeModal(); renderLedgerSwitch();
        var active = document.querySelector('#moduleNav .nav-item.active');
        if (active) setModule(active.dataset.module);
        FW.toast('已创建并切换到「' + name + '」');
      };
    });
  }

  function renameLedger(id) {
    var list = FW.db.getLedgers();
    var rec = list.filter(function (l) { return l.id === id; })[0]; if (!rec) return;
    FW.openModal('重命名账本', '<div class="field"><label>账本名称</label><input id="rn_name" value="' + FW.esc(rec.name) + '"></div><div class="form-actions"><button class="btn ghost" id="rnCancel">取消</button><button class="btn" id="rnSave">保存</button></div>', function () {
      document.getElementById('rnCancel').onclick = FW.closeModal;
      document.getElementById('rnSave').onclick = function () {
        var name = document.getElementById('rn_name').value.trim();
        if (!name) { FW.toast('请输入名称'); return; }
        rec.name = name; FW.db.setLedgers(list);
        FW.closeModal(); renderLedgerSwitch(); FW.toast('已重命名');
      };
    });
  }

  function deleteLedger(id) {
    var list = FW.db.getLedgers();
    if (list.length <= 1) { FW.toast('至少保留一个账本'); return; }
    var rec = list.filter(function (l) { return l.id === id; })[0]; if (!rec) return;
    if (!confirm('确定删除账本「' + rec.name + '」？\n该账本下的内账、报税、往来等全部数据将被清除，且不可恢复！')) return;
    FW.db.deleteLedgerData(id);
    var newList = list.filter(function (l) { return l.id !== id; });
    FW.db.setLedgers(newList);
    if (FW.db.getCurrentLedger() === id) FW.db.setCurrentLedger(newList[0].id);
    FW.closeModal(); renderLedgerSwitch();
    var active = document.querySelector('#moduleNav .nav-item.active');
    if (active) setModule(active.dataset.module);
    FW.toast('已删除账本「' + rec.name + '」');
  }

  function start() {
    // 数据迁移 + 账本初始化
    FW.db.migrate();

    // 品牌日期
    var d = new Date();
    document.getElementById('brandDate').textContent = (d.getMonth() + 1) + '月' + d.getDate() + '日 · 本地数据';

    // 侧栏常用网站
    FW.modules.sidebar.init();

    // 账本切换器
    renderLedgerSwitch();
    document.getElementById('lsCurrent').onclick = function (e) {
      e.stopPropagation();
      var m = document.getElementById('lsMenu');
      m.hidden = !m.hidden;
    };
    document.addEventListener('click', function () { document.getElementById('lsMenu').hidden = true; });

    // 模块导航（含分组折叠）
    FW.qa('#moduleNav .nav-item').forEach(function (b) {
      b.onclick = function () { setModule(b.dataset.module); };
    });
    FW.qa('#moduleNav .nav-group-head').forEach(function (h) {
      h.onclick = function () {
        var group = h.parentElement;
        var body = group.querySelector('.nav-group-body');
        var isOpen = !group.classList.contains('open');
        // 关闭其他组
        FW.qa('#moduleNav .nav-group.open').forEach(function (g) {
          if (g !== group) { g.classList.remove('open'); g.querySelector('.nav-group-body').hidden = true; }
        });
        group.classList.toggle('open', isOpen);
        body.hidden = !isOpen;
      };
    });

    // 加密设置入口
    var cryptoBtn = document.getElementById('cryptoBtn');
    if (cryptoBtn) cryptoBtn.onclick = function () { FW.cryptoUI.openSettings(); };

    // 导出 / 导入（含 IndexedDB 照片凭证）
    document.getElementById('exportBtn').onclick = function () {
      FW.db.exportAll().then(function (data) {
        var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = '财务工作台_备份_' + FW.today() + '.json';
        a.click();
        var pc = (data.photos && data.photos.length) || 0;
        FW.toast('已导出备份（含 ' + pc + ' 张照片凭证）');
      }).catch(function () { FW.toast('导出失败'); });
    };
    document.getElementById('importBtn').onclick = function () { document.getElementById('importFile').click(); };
    document.getElementById('importFile').onchange = function (e) {
      var f = e.target.files[0]; if (!f) return;
      var r = new FileReader();
      r.onload = function () {
        var payload;
        try { payload = JSON.parse(r.result); }
        catch (err) { FW.toast('导入失败：文件格式不正确'); return; }
        FW.db.importAll(payload).then(function () {
          renderLedgerSwitch();
          FW.modules.sidebar.render();
          setModule(document.querySelector('#moduleNav .nav-item.active').dataset.module);
          var pc = (payload.photos && payload.photos.length) || 0;
          FW.toast('导入成功' + (pc ? '（已恢复 ' + pc + ' 张照片凭证）' : ''));
        }).catch(function (err) { FW.toast('导入失败：' + (err && err.message ? err.message : '未知错误')); });
      };
      r.readAsText(f);
      e.target.value = '';
    };

    // 默认进入首页
    setModule('home');
  }

  // 启动门控：已启用加密则先解锁，再启动并拉取云端；否则直接启动
  function boot() {
    try {
      if (FW.db.cryptoEnabled()) {
        FW.cryptoUI.showUnlock(function () {
          if (FW.sync) FW.sync.afterUnlock();
          start();
        });
      } else {
        start();
      }
    } catch (e) {
      console.error('[财务工作台] 启动失败', e);
      // 兜底：至少让用户看到界面
      try { start(); } catch(e2) {
        document.getElementById('content').innerHTML = '<div style="padding:40px;text-align:center;color:#e63946">⚠️ 应用启动异常，请刷新页面重试（Ctrl+F5）</div>';
      }
    }
  }

  // 全局错误兜底：防止任何未捕获的脚本错误导致白屏
  window.addEventListener('error', function (e) {
    console.error('[财务工作台] 脚本错误', e.message, e.filename, e.lineno);
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);
