/* ============================================================
 * 备忘录模块
 * 支持分类、置顶、搜索、到期提醒标记
 * ============================================================ */
(function (global) {
  'use strict';
  var FW = global.FW;
  var KEY = 'memos';
  var state = { kw: '', cat: '' };

  function all() {
    return FW.db.getList(KEY).sort(function (a, b) {
      if (a.pin !== b.pin) return a.pin ? -1 : 1;
      return (a.updatedAt || 0) < (b.updatedAt || 0) ? 1 : -1;
    });
  }
  function cats() { var s = {}; FW.db.getList(KEY).forEach(function (m) { if (m.cat) s[m.cat] = 1; }); return Object.keys(s); }

  function render() {
    var list = all().filter(function (m) {
      if (state.cat && m.cat !== state.cat) return false;
      if (state.kw && (m.title + m.body).indexOf(state.kw) < 0) return false;
      return true;
    });
    var catOpts = '<option value="">全部分类</option>' + cats().map(function (c) { return '<option ' + (state.cat === c ? 'selected' : '') + '>' + FW.esc(c) + '</option>'; }).join('');

    var html =
      '<div class="toolbar">' +
        '<div class="field"><input id="mKw" placeholder="搜索备忘" value="' + FW.esc(state.kw) + '"></div>' +
        '<div class="field"><select id="mCat">' + catOpts + '</select></div>' +
        '<button class="btn ghost sm" id="mReset">重置</button>' +
      '</div>';

    if (!list.length) {
      html += '<div class="card"><div class="empty">还没有备忘，点右上角「新建备忘」记录一下。</div></div>';
    } else {
      var cards = list.map(function (m) {
        var due = m.due ? '<span class="tag ' + (m.due < FW.today() ? 'expense' : 'income') + '">⏰ ' + FW.esc(m.due) + '</span>' : '';
        var pin = m.pin ? '<span class="tag">📌 置顶</span>' : '';
        var cat = m.cat ? '<span class="tag">' + FW.esc(m.cat) + '</span>' : '';
        return '<div class="kb-card">' +
          '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">' +
            '<h4 style="margin:0">' + FW.esc(m.title || '（无标题）') + '</h4>' +
            '<div class="row-actions">' +
              '<button class="btn ghost sm m-pin" data-id="' + m.id + '">' + (m.pin ? '取消置顶' : '置顶') + '</button>' +
              '<button class="btn ghost sm m-edit" data-id="' + m.id + '">编辑</button>' +
              '<button class="btn danger sm m-del" data-id="' + m.id + '">删</button>' +
            '</div>' +
          '</div>' +
          '<div style="margin:8px 0">' + cat + ' ' + pin + ' ' + due + '</div>' +
          '<p style="white-space:pre-wrap;margin:0">' + FW.esc(m.body || '') + '</p>' +
          '<div class="muted" style="font-size:11px;margin-top:8px">更新：' + FW.esc(FW.fmtDate(m.updatedAt)) + '</div>' +
          '</div>';
      }).join('');
      html += '<div class="kb-list">' + cards + '</div>';
    }
    document.getElementById('content').innerHTML = html;

    document.getElementById('mKw').oninput = function () { state.kw = this.value.trim(); render(); };
    document.getElementById('mCat').onchange = function () { state.cat = this.value; render(); };
    document.getElementById('mReset').onclick = function () { state.kw = ''; state.cat = ''; render(); };
    FW.qa('#content .m-edit').forEach(function (b) { b.onclick = function () { openForm(b.dataset.id); }; });
    FW.qa('#content .m-del').forEach(function (b) { b.onclick = function () { if (confirm('删除该备忘？')) { FW.db.remove(KEY, b.dataset.id); render(); FW.toast('已删除'); } }; });
    FW.qa('#content .m-pin').forEach(function (b) { b.onclick = function () { var m = FW.db.getById(KEY, b.dataset.id); m.pin = !m.pin; FW.db.upsert(KEY, m); render(); }; });

    var ta = document.getElementById('topActions');
    ta.innerHTML = '<button class="btn" id="mAdd">＋ 新建备忘</button>';
    document.getElementById('mAdd').onclick = function () { openForm(); };
  }

  function openForm(id) {
    var edit = id ? FW.db.getById(KEY, id) : null;
    var v = edit || { title: '', cat: '', due: '', body: '', pin: false };
    var body =
      '<div class="form-grid">' +
        '<div class="field full"><label>标题</label><input id="m_title" value="' + FW.esc(v.title) + '" placeholder="备忘标题"></div>' +
        '<div class="field"><label>分类</label><input id="m_cat" list="mCatList" value="' + FW.esc(v.cat) + '" placeholder="如：待办/客户/税期"><datalist id="mCatList">' + cats().map(function (c) { return '<option>' + FW.esc(c) + '</option>'; }).join('') + '</datalist></div>' +
        '<div class="field"><label>提醒日期</label><input id="m_due" type="date" value="' + FW.esc(v.due) + '"></div>' +
        '<div class="field full"><label>内容</label><textarea id="m_body" rows="6" placeholder="记录内容…">' + FW.esc(v.body) + '</textarea></div>' +
        '<div class="field full"><label><input type="checkbox" id="m_pin" ' + (v.pin ? 'checked' : '') + ' style="width:auto;margin-right:6px">置顶显示</label></div>' +
      '</div>' +
      '<div class="form-actions"><button class="btn ghost" id="mCancel">取消</button><button class="btn" id="mSave">保存</button></div>';
    FW.openModal(edit ? '编辑备忘' : '新建备忘', body, function () {
      document.getElementById('mCancel').onclick = FW.closeModal;
      document.getElementById('mSave').onclick = function () {
        var rec = {
          id: edit ? edit.id : FW.db.uid('m_'),
          title: document.getElementById('m_title').value.trim(),
          cat: document.getElementById('m_cat').value.trim(),
          due: document.getElementById('m_due').value,
          body: document.getElementById('m_body').value,
          pin: document.getElementById('m_pin').checked,
          updatedAt: Date.now()
        };
        if (!rec.title && !rec.body) { FW.toast('标题和内容不能都为空'); return; }
        FW.db.upsert(KEY, rec); FW.closeModal(); render(); FW.toast('已保存');
      };
    });
  }

  FW.modules = FW.modules || {};
  FW.modules.memo = { title: '备忘录', render: render };
})(window);
