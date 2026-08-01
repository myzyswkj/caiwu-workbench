/* ============================================================
 * 版本与备份
 *   - 版本日志：列出每次上线版本（版本号=commit 短哈希 / 日期 / 改动说明 / 状态）；
 *     当前版本高亮；「恢复此版本」提交恢复请求（由开发者通过 git 重新部署该版本，数据不受影响）。
 *   - 数据备份与恢复：复用 FW.db.exportAll / importAll（含全部账本数据与照片凭证），
 *     并记录备份/恢复日志（localStorage），便于追溯。
 * ============================================================ */
(function (window) {
  'use strict';
  var FW = window.FW || (window.FW = {});

  // 版本历史（每次上线由开发者维护，最新一条为 current）
  var VERSIONS = [
    { v: '54d706e', date: '2026-08-01', title: '修复项目核算 render 整页崩溃——tableHtml 参数契约错误，新增渲染冒烟测试', status: 'current' },
    { v: 'fba41c3', date: '2026-08-01', title: '项目核算增强：搜索与盈亏筛选、利润率横向对比条、利润瀑布图、导出 Excel(xlsx)', status: 'stable' },
    { v: '8de1c22', date: '2026-08-01', title: '合同台账支持上传文档并自动提取关键信息 + 附件管理（PDF/Word/Excel/文本解析）', status: 'stable' },
    { v: 'b631ce3', date: '2026-08-01', title: '流水明细筛选新增二级分类联动下拉（选一级后可再筛二级）', status: 'stable' },
    { v: '8075022', date: '2026-08-01', title: '同步拉取出错时禁止推送覆盖云端，并新增两种安全同步模式', status: 'stable' },
    { v: 'da5e0b1', date: '2026-08-01', title: '修复云端同步导致本地数据重复——合并去重 + 并发守卫 + 手动合并工具', status: 'stable' },
    { v: '078c209', date: '2026-08-01', title: '收入可按净额记——新增「已扣支出」字段，还原实际收入并计入成本', status: 'stable' },
    { v: 'c45b171', date: '2026-08-01', title: '项目核算详情-流水成本构成增加二级分类下钻明细表', status: 'stable' },
    { v: 'e3e91c9', date: '2026-08-01', title: '流水明细新增「退款收入」类型——不计入总收入、冲减流水支出', status: 'stable' },
    { v: '5ccacd7', date: '2026-08-01', title: '项目核算总成本改为 流水成本-应收回款项+工资成本', status: 'stable' },
    { v: 'b2c3001', date: '2026-08-01', title: '项目核算总成本/利润纳入应收回款项（预付占用）', status: 'stable' },
    { v: 'c3aa806', date: '2026-08-01', title: '项目核算应收回款项支持下钻——查看每笔预付款来源', status: 'stable' },
    { v: '048327e', date: '2026-08-01', title: '往来账新增「预付」类型+关联项目；项目核算联动「应收回款项」', status: 'stable' },
    { v: '26d8352', date: '2026-08-01', title: '项目核算新增 成本结构拆解/逐月趋势/未分配提醒/排名+下钻', status: 'stable' },
    { v: '3778785', date: '2026-08-01', title: '新增「项目核算」模块——按项目汇总收入/支出/工资成本，核算利润与利润率', status: 'stable' }
  ];

  var ROLLBACK_KEY = 'fw_rollback_request';
  var BACKUP_LOG_KEY = 'fw_backup_log';

  function getRollback() { try { return JSON.parse(localStorage.getItem(ROLLBACK_KEY) || 'null'); } catch (e) { return null; } }
  function setRollback(r) { try { localStorage.setItem(ROLLBACK_KEY, JSON.stringify(r)); } catch (e) {} }
  function clearRollback() { try { localStorage.removeItem(ROLLBACK_KEY); } catch (e) {} }

  function getBackupLog() { try { return JSON.parse(localStorage.getItem(BACKUP_LOG_KEY) || '[]'); } catch (e) { return []; } }
  function addBackupLog(type, detail) {
    var log = getBackupLog();
    log.unshift({ ts: new Date().toISOString(), type: type, detail: detail || '' });
    if (log.length > 50) log = log.slice(0, 50);
    try { localStorage.setItem(BACKUP_LOG_KEY, JSON.stringify(log)); } catch (e) {}
  }

  function esc(s) { return FW.esc ? FW.esc(s) : String(s == null ? '' : s); }
  function todayStr() { var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }

  function renderVersions() {
    var rows = VERSIONS.map(function (x) {
      var isCur = x.status === 'current';
      var badge = isCur ? '<span class="badge ok">当前</span>'
        : (x.status === 'bad' ? '<span class="badge bad">已知问题</span>' : '<span class="badge">稳定</span>');
      var rb = isCur ? '<span class="muted">—</span>' : '<button class="btn ghost sm" data-rollback="' + esc(x.v) + '">恢复此版本</button>';
      return '<tr class="' + (isCur ? 'ver-cur' : '') + '">' +
        '<td class="mono">' + esc(x.v) + '</td>' +
        '<td>' + esc(x.date) + '</td>' +
        '<td>' + esc(x.title) + '</td>' +
        '<td>' + badge + '</td>' +
        '<td>' + rb + '</td>' +
        '</tr>';
    }).join('');
    return '<table class="ver-table"><thead><tr><th>版本</th><th>日期</th><th>改动说明</th><th>状态</th><th>操作</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  function renderRollbackBanner() {
    var r = getRollback();
    if (!r) return '';
    return '<div class="ver-rb-banner">⏳ 待恢复：版本 <b>' + esc(r.v) + '</b>（请求于 ' + esc((r.ts || '').replace('T', ' ').slice(0, 19)) +
      '）。恢复需开发者通过 git 重新部署该版本；如急需，请先用下方「导入恢复」恢复数据。' +
      ' <button class="btn ghost sm" id="verRbCancel">取消请求</button></div>';
  }

  function renderBackupLog() {
    var log = getBackupLog();
    if (!log.length) return '<div class="muted" style="font-size:12px">暂无备份 / 恢复记录</div>';
    var rows = log.slice(0, 12).map(function (x) {
      var t = (x.ts || '').replace('T', ' ').slice(0, 19);
      var label = x.type === 'export' ? '导出备份' : (x.type === 'import' ? '导入恢复' : (x.type || ''));
      return '<div class="ver-log-row">' +
        '<span class="ver-log-type type-' + (x.type || '') + '">' + label + '</span>' +
        '<span class="ver-log-ts">' + esc(t) + '</span>' +
        '<span class="ver-log-detail">' + esc(x.detail || '') + '</span>' +
        '</div>';
    }).join('');
    return '<div class="ver-log">' + rows + '</div>';
  }

  function render() {
    var html =
      '<div class="salary-wrap">' +
      renderRollbackBanner() +
      '<div class="ver-card">' +
      '<h3>版本日志</h3>' +
      '<div class="muted" style="font-size:12px;margin-bottom:8px">记录每次上线的版本。当前版本已高亮；若某版本导致问题，可点「恢复此版本」提交恢复请求（由开发者通过 git 重新部署该版本，<b>账本数据不受影响</b>）。</div>' +
      renderVersions() +
      '</div>' +
      '<div class="ver-card">' +
      '<h3>数据备份与恢复</h3>' +
      '<div class="ver-btns">' +
      '<button class="btn" id="verExport">💾 导出备份（下载 JSON）</button>' +
      '<button class="btn ghost" id="verImport">📂 导入恢复（选择文件）</button>' +
      '<input type="file" id="verImportFile" accept="application/json,.json" hidden>' +
      '</div>' +
      '<div class="muted" style="font-size:12px;margin:8px 0">备份包含全部账本数据与照片凭证。建议定期导出保存到本地 / 网盘；系统异常或换设备时，用「导入恢复」还原。备份 / 恢复记录如下：</div>' +
      renderBackupLog() +
      '</div>' +
      '</div>';
    var c = document.getElementById('content');
    if (c) c.innerHTML = html;

    // 恢复请求按钮
    FW.qa && FW.qa('#content [data-rollback]').forEach(function (b) {
      b.onclick = function () {
        var v = b.getAttribute('data-rollback');
        var item = null;
        for (var i = 0; i < VERSIONS.length; i++) { if (VERSIONS[i].v === v) { item = VERSIONS[i]; break; } }
        var msg = '确定请求恢复到版本 ' + v + '（' + (item ? item.title : '') + '）吗？\n恢复由开发者通过 git 重新部署该版本，账本数据不受影响。';
        var go = (typeof window.confirm === 'function') ? window.confirm(msg) : true;
        if (!go) return;
        setRollback({ v: v, title: item ? item.title : '', ts: new Date().toISOString() });
        FW.toast && FW.toast('已提交恢复请求（版本 ' + v + '）');
        render();
      };
    });
    var cancel = document.getElementById('verRbCancel');
    if (cancel) cancel.onclick = function () { clearRollback(); FW.toast && FW.toast('已取消恢复请求'); render(); };

    // 导出备份
    var exp = document.getElementById('verExport');
    if (exp) exp.onclick = function () {
      FW.db.exportAll().then(function (data) {
        var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = '财务工作台_备份_' + todayStr() + '.json';
        a.click();
        var pc = (data.photos && data.photos.length) || 0;
        addBackupLog('export', '含 ' + pc + ' 张照片凭证');
        FW.toast && FW.toast('已导出备份（含 ' + pc + ' 张照片凭证）');
        render();
      }).catch(function () { FW.toast && FW.toast('导出失败'); });
    };
    // 导入恢复
    var imp = document.getElementById('verImport');
    var impFile = document.getElementById('verImportFile');
    if (imp) imp.onclick = function () { if (impFile) impFile.click(); };
    if (impFile) impFile.onchange = function (e) {
      var f = e.target.files[0]; if (!f) return;
      var r = new FileReader();
      r.onload = function () {
        var payload;
        try { payload = JSON.parse(r.result); } catch (err) { FW.toast && FW.toast('导入失败：文件格式不正确'); return; }
        FW.db.importAll(payload).then(function () {
          if (FW.modules.sidebar) FW.modules.sidebar.render();
          var pc = (payload.photos && payload.photos.length) || 0;
          addBackupLog('import', '已恢复' + (pc ? pc + ' 张照片凭证' : '数据'));
          FW.toast && FW.toast('导入成功' + (pc ? '（已恢复 ' + pc + ' 张照片凭证）' : ''));
          render();
        }).catch(function (err) { FW.toast && FW.toast('导入失败：' + (err && err.message ? err.message : '未知错误')); });
      };
      r.readAsText(f);
      e.target.value = '';
    };
  }

  FW.modules = FW.modules || {};
  FW.modules.version = { title: '版本与备份', render: render };

  FW.versionCalc = {
    VERSIONS: VERSIONS,
    getRollback: getRollback, setRollback: setRollback, clearRollback: clearRollback,
    getBackupLog: getBackupLog, addBackupLog: addBackupLog
  };
})(window);
