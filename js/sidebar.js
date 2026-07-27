/* ============================================================
 * 左侧「常用网站」管理
 * ============================================================ */
(function (global) {
  'use strict';
  var FW = global.FW;
  var KEY = 'sites';

  function faviconUrl(url) {
    try {
      var u = new URL(url);
      return 'https://www.google.com/s2/favicons?domain=' + u.hostname + '&sz=32';
    } catch (e) { return ''; }
  }

  function render() {
    var list = FW.db.getList(KEY);
    var ul = document.getElementById('siteList');
    ul.innerHTML = '';
    if (!list.length) {
      ul.innerHTML = '<li class="muted" style="font-size:12px;padding:6px 8px">暂无，点右上角 ＋ 添加</li>';
      return;
    }
    list.forEach(function (s) {
      var li = document.createElement('li');
      li.className = 'site-item';
      li.title = s.name + '\n' + s.url;
      li.innerHTML =
        '<span class="site-fav"><img src="' + FW.esc(faviconUrl(s.url)) + '" onerror="this.style.display=\'none\'" alt=""></span>' +
        '<span class="site-name">' + FW.esc(s.name) + '</span>' +
        '<span class="site-del" data-id="' + s.id + '" title="删除">✕</span>';
      li.addEventListener('click', function (e) {
        if (e.target.classList.contains('site-del')) return;
        window.open(s.url, '_blank', 'noopener');
      });
      li.querySelector('.site-del').addEventListener('click', function (e) {
        e.stopPropagation();
        FW.db.remove(KEY, s.id);
        render();
        FW.toast('已删除：' + s.name);
      });
      ul.appendChild(li);
    });
  }

  function addSite() {
    var body =
      '<div class="form-grid">' +
      '  <div class="field full"><label>网站名称</label><input id="siteName" placeholder="如：电子税务局" /></div>' +
      '  <div class="field full"><label>网址 URL</label><input id="siteUrl" placeholder="https://..." /></div>' +
      '</div>' +
      '<div class="form-actions"><button class="btn ghost" id="siteCancel">取消</button><button class="btn" id="siteSave">保存</button></div>';
    FW.openModal('添加常用网站', body, function () {
      document.getElementById('siteCancel').onclick = FW.closeModal;
      document.getElementById('siteSave').onclick = function () {
        var name = document.getElementById('siteName').value.trim();
        var url = document.getElementById('siteUrl').value.trim();
        if (!name) { FW.toast('请填写名称'); return; }
        if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
        FW.db.upsert(KEY, { id: FW.db.uid('s_'), name: name, url: url });
        FW.closeModal(); render(); FW.toast('已添加');
      };
    });
  }

  function init() {
    render();
    document.getElementById('addSiteBtn').addEventListener('click', addSite);
  }

  FW.modules = FW.modules || {};
  FW.modules.sidebar = { init: init, render: render };
})(window);
