/* ============================================================
 * 加密 UI：解锁覆盖层 + 加密设置弹窗
 * - 启用加密后，每次打开页面需输入主密码（覆盖层，不可误关）
 * - 多设备首次从云端解密时，用云端信封的 salt 派生密钥
 * ============================================================ */
(function (global) {
  'use strict';
  var FW = global.FW = global.FW || {};

  // 解锁覆盖层（saltB64 用于跨设备）
  function showUnlock(onSuccess, saltB64) {
    if (!FW.crypto || !FW.crypto.available) {
      FW.toast('当前环境不支持加密（请通过 HTTPS 或 localhost 打开）');
      if (onSuccess) onSuccess();
      return;
    }
    var ov = document.getElementById('lockOverlay');
    if (!ov) { if (onSuccess) onSuccess(); return; }
    ov.hidden = false;
    ov.innerHTML =
      '<div class="lock-card">' +
        '<div class="lock-logo">🔒</div>' +
        '<div class="lock-title">财务工作台已加密</div>' +
        '<div class="muted" style="margin-bottom:10px">请输入主密码以解锁本地数据</div>' +
        '<input id="lk_pwd" type="password" class="lock-input" placeholder="主密码" autocomplete="off">' +
        '<div class="muted" id="lkMsg" style="font-size:12px;margin:6px 0 10px;color:#e63946;min-height:14px"></div>' +
        '<button class="btn lock-btn" id="lkGo">解锁</button>' +
      '</div>';
    var go = function () {
      var pwd = document.getElementById('lk_pwd').value;
      var msg = document.getElementById('lkMsg');
      if (!pwd) { msg.textContent = '请输入密码'; return; }
      msg.textContent = '解锁中…';
      FW.db.unlock(pwd, saltB64).then(function () {
        ov.hidden = true;
        if (onSuccess) onSuccess();
      }).catch(function () { msg.textContent = '密码错误，请重试'; });
    };
    document.getElementById('lkGo').onclick = go;
    document.getElementById('lk_pwd').addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
    setTimeout(function () { var el = document.getElementById('lk_pwd'); if (el) el.focus(); }, 50);
  }

  // 加密设置弹窗
  function openSettings() {
    var enabled = FW.db.cryptoEnabled();
    var status = enabled ? '已启用本地加密' : '未启用本地加密';
    var body = '<div class="muted" style="margin-bottom:10px">当前状态：' + status + '</div>';
    if (!enabled) {
      body +=
        '<div class="field"><label>设置主密码（用于加密本地与云端数据）</label><input id="cs_pwd" type="password" placeholder="主密码（至少 6 位）"></div>' +
        '<div class="field"><label>确认主密码</label><input id="cs_pwd2" type="password" placeholder="再次输入"></div>' +
        '<div class="muted" id="csMsg" style="font-size:12px;margin:6px 0 10px;color:#e63946;min-height:14px"></div>' +
        '<div class="form-actions"><button class="btn ghost" id="csCancel">取消</button><button class="btn" id="csEnable">启用加密</button></div>' +
        '<div class="muted" style="margin-top:10px">📱 多设备同步：只需在「一台设备」启用加密并登录云账号；其他设备登录同一账号后，输入同一主密码即可解锁并自动同步，无需各自启用加密。</div>' +
        '<div class="muted" style="margin-top:6px">⚠️ 主密码一旦忘记，数据将无法恢复（包括云端）。建议记在密码管理器里。</div>';
    } else {
      body +=
        '<div class="field"><label>当前主密码</label><input id="cs_old" type="password" placeholder="当前密码"></div>' +
        '<div class="field"><label>新主密码（修改时填写，留空则不修改）</label><input id="cs_new" type="password" placeholder="留空则不修改"></div>' +
        '<div class="muted" id="csMsg" style="font-size:12px;margin:6px 0 10px;color:#e63946;min-height:14px"></div>' +
        '<div class="form-actions">' +
          '<button class="btn ghost" id="csCancel">取消</button>' +
          '<button class="btn" id="csChange">保存修改</button>' +
          '<button class="btn ghost" id="csLock">立即锁定</button>' +
          '<button class="btn ghost danger" id="csDisable">关闭加密</button>' +
        '</div>';
    }
    FW.openModal('加密设置', body, function () {
      var msg = document.getElementById('csMsg');
      document.getElementById('csCancel').onclick = FW.closeModal;
      if (!enabled) {
        document.getElementById('csEnable').onclick = function () {
          var p1 = document.getElementById('cs_pwd').value, p2 = document.getElementById('cs_pwd2').value;
          if (p1.length < 6) { msg.textContent = '密码至少 6 位'; return; }
          if (p1 !== p2) { msg.textContent = '两次输入不一致'; return; }
          msg.style.color = '#1f9d55'; msg.textContent = '启用中…';
          FW.db.enableCrypto(p1).then(function () {
            FW.closeModal(); FW.toast('已启用加密，数据已本地加密');
          }).catch(function (e) { msg.style.color = '#e63946'; msg.textContent = '失败：' + (e && e.message ? e.message : e); });
        };
      } else {
        document.getElementById('csChange').onclick = function () {
          var oldP = document.getElementById('cs_old').value;
          var newP = document.getElementById('cs_new').value;
          if (!oldP) { msg.textContent = '请输入当前密码'; return; }
          if (newP && newP.length < 6) { msg.textContent = '新密码至少 6 位'; return; }
          msg.style.color = '#1f9d55'; msg.textContent = '处理中…';
          var op = newP ? FW.db.changePassword(oldP, newP) : FW.db.unlock(oldP).then(function () { return true; });
          op.then(function () { FW.closeModal(); FW.toast(newP ? '主密码已修改' : '验证通过'); })
            .catch(function (e) { msg.style.color = '#e63946'; msg.textContent = '失败：' + (e && e.message ? e.message : e); });
        };
        document.getElementById('csLock').onclick = function () {
          FW.closeModal();
          FW.db.lock();
          showUnlock(function () { FW.toast('已解锁'); });
        };
        document.getElementById('csDisable').onclick = function () {
          var oldP = document.getElementById('cs_old').value;
          if (!oldP) { msg.textContent = '请输入当前密码'; return; }
          msg.style.color = '#1f9d55'; msg.textContent = '关闭中…';
          FW.db.disableCrypto(oldP).then(function () {
            FW.closeModal(); FW.toast('已关闭加密，数据恢复为明文');
          }).catch(function (e) { msg.style.color = '#e63946'; msg.textContent = '失败：' + (e && e.message ? e.message : e); });
        };
      }
    });
  }

  FW.cryptoUI = { showUnlock: showUnlock, openSettings: openSettings };
})(window);
