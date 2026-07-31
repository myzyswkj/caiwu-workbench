/* ============================================================
 * 云端同步层（Supabase）
 * - 登录 / 注册 / 退出（邮箱 / 手机短信）
 * - 把整个应用状态当作「快照」实时存到 Supabase
 * - 启用本地加密时：上传的是密文快照，密钥仅在本机内存，云端/他端均无法解密
 * - 包裹 FW.db 的写方法自动标记 dirty，定时 + 关页前推送
 * - 未配置 APP_CONFIG 时自动降级为纯本地模式（不报错）
 * ============================================================ */
(function (global) {
  'use strict';
  var FW = global.FW;

  var cfg = global.APP_CONFIG || {};
  var url = cfg.SUPABASE_URL, anon = cfg.SUPABASE_ANON_KEY;
  var enabled = !!(url && anon);

  var sb = null;       // supabase client
  var user = null;     // 当前用户
  var dirty = false;   // 是否有未推送改动
  var suppress = false;// 拉取/导入期间抑制 dirty 标记
  var timer = null;

  function hasSupabase() { return !!(global.supabase && global.supabase.createClient); }

  /* ---------- UI 回调（在 ui.js 中定义） ---------- */
  function setAuth(u) { if (FW.ui && FW.ui.setAuth) FW.ui.setAuth(u); }
  function setSync(t) { if (FW.ui && FW.ui.setSyncTime) FW.ui.setSyncTime(t); }

  /* ---------- 初始化 ---------- */
  var inited = false;
  function init() {
    if (inited) return;
    inited = true;
    if (!enabled || !hasSupabase()) {
      // 降级：纯本地，不显示登录入口
      var area = document.getElementById('authArea');
      if (area) area.innerHTML = '';
      return;
    }
    try { sb = global.supabase.createClient(url, anon); }
    catch (e) { console.warn('Supabase 初始化失败', e); return; }

    // 启动登录入口
    renderAuthArea();

    // 现有会话
    sb.auth.getSession().then(function (r) {
      if (r.data && r.data.session) { user = r.data.session.user; onLogin(); }
    });

    // 登录态变化
    sb.auth.onAuthStateChange(function (ev, sess) {
      if (sess && sess.user) { user = sess.user; onLogin(); }
      else { user = null; setAuth(null); }
    });

    hookDb();
    startAutosave();
  }

  // 只有本端有实际数据才回推，避免用空数据覆盖云端（解决"空快照饿死"）
  function pushIfHasData() {
    return FW.db.exportAll().then(function (snap) {
      var has = snap && snap.raw && Object.keys(snap.raw).length > 0;
      if (!has) return false;
      return push(true);
    });
  }

  // 完整双向同步：先拉（合并云端数据到本机），再推（把合并后的最新状态回传云端）
  function syncNow() {
    if (!user) { FW.toast('请先登录'); return Promise.resolve(); }
    if (FW.db.cryptoEnabled() && !FW.db.isUnlocked()) { FW.toast('请先解锁加密再同步'); return Promise.resolve(); }
    return pull().then(function () {
      return pushIfHasData();
    }).then(function () {
      markClean();
      FW.toast('同步完成');
    }).catch(function (e) {
      markClean();
      FW.toast('同步失败：' + (e && e.message ? e.message : '未知错误'));
    });
  }

  function onLogin() {
    setAuth(user);
    // 已启用加密但尚未解锁：先不拉取，等解锁后由 afterUnlock 触发
    if (FW.db.cryptoEnabled() && !FW.db.isUnlocked()) return;
    syncNow();
  }

  // 解锁完成后由 main.boot 调用：若已登录则拉取/推送
  function afterUnlock() {
    if (!user) return;
    if (FW.db.cryptoEnabled() && !FW.db.isUnlocked()) return;
    syncNow();
  }

  /* ---------- 包裹写方法，自动标记 dirty ---------- */
  function hookDb() {
    // 注意：setLedgers 走 db.js 内部闭包，不经 FW.db.lsSet，故需单独包裹，
    // 否则「新建/重命名/删除账本」不会标记 dirty，也就不会自动同步到账本列表。
    var keys = ['lsSet', 'saveList', 'upsert', 'remove', 'savePhoto', 'deletePhoto', 'deletePhotos', 'setLedgers'];
    keys.forEach(function (m) {
      var orig = FW.db[m];
      if (typeof orig !== 'function') return;
      FW.db[m] = function () {
        var res = orig.apply(FW.db, arguments);
        if (!suppress) dirty = true;
        return res;
      };
    });
  }

  function markDirty() { dirty = true; }
  function markClean() { dirty = false; setSync(new Date()); }

  /* ---------- 推送（本地 → 云端） ---------- */
  function push(force) {
    if (!user || (!dirty && !force)) return Promise.resolve(false);
    if (FW.db.cryptoEnabled() && !FW.db.isUnlocked()) return Promise.resolve(false);
    return FW.db.exportAll().then(function (snap) {
      return FW.db.encryptSnapshot(snap).then(function (payload) {
        return sb.from('snapshots').upsert({
          user_id: user.id,
          data: payload,
          updated_at: new Date().toISOString()
        }, { onConflict: 'user_id' }).then(function (r) {
          if (r.error) { FW.toast('同步失败：' + r.error.message); return false; }
          markClean();
          return true;
        });
      });
    }).catch(function (e) {
      FW.toast('同步失败：' + (e && e.message ? e.message : '未知错误'));
      return false;
    });
  }

  /* ---------- 拉取（云端 → 本地） ---------- */
  function pull() {
    if (!user) return Promise.resolve(false);
    return sb.from('snapshots').select('data').eq('user_id', user.id).maybeSingle().then(function (r) {
      if (r.error && r.error.code !== 'PGRST116') { FW.toast('拉取失败：' + r.error.message); return false; }
      if (!r.data || !r.data.data) return false; // 尚无云端数据
      var payload = r.data.data;
      // 云端为密文但本端未解锁（多设备首次）：弹出密码解锁后再拉
      if (payload && payload.__enc && !FW.db.isUnlocked()) {
        if (FW.cryptoUI && FW.cryptoUI.showUnlock) FW.cryptoUI.showUnlock(function () { pull(); }, payload.salt);
        return false;
      }
      return FW.db.decryptSnapshot(payload).then(function (snap) {
        suppress = true;
        var keepCur = FW.db.getCurrentLedger(); // 各设备保持自己的当前账本，不同步选中态
        return FW.db.importAll(snap, true).then(function () {
          suppress = false;
          FW.db.setCurrentLedger(keepCur);
          // 重新渲染账本切换器（关键：否则新建/同步的账本不显示在下拉列表）
          if (FW.refreshLedgers) FW.refreshLedgers();
          if (FW.modules.sidebar) FW.modules.sidebar.render();
          var active = document.querySelector('#moduleNav .nav-item.active');
          if (active && FW.setModule) FW.setModule(active.dataset.module);
          FW.toast('已从云端同步最新数据');
          return true; // 标记：已导入云端数据
        }).catch(function () { suppress = false; return false; });
      }).catch(function () {
        FW.toast('云端数据解密失败（主密码不符？）');
        return false;
      });
    });
  }

  /* ---------- 自动保存 ---------- */
  function startAutosave() {
    timer = setInterval(function () { if (user && dirty) push(); }, 15000);
    global.addEventListener('beforeunload', function () { if (user && dirty) push(); });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden' && user && dirty) push();
    });
  }

  /* ---------- 登录 / 注册界面 ---------- */
  function renderAuthArea() {
    var area = document.getElementById('authArea');
    if (!area) return;
    var brand = document.getElementById('brandDate');
    if (!user) {
      area.innerHTML = '<button class="auth-btn" id="authLogin">🔐 登录/注册</button>';
      document.getElementById('authLogin').onclick = openLogin;
    } else {
      if (brand) brand.textContent = '☁ 云端同步 · 多设备';
      area.innerHTML =
        '<span class="auth-state" id="authState">已同步</span>' +
        '<button class="auth-btn ghost" id="authSync">↻ 立即同步</button>' +
        '<button class="auth-btn" id="authOut">退出(' + FW.esc(user.email || '用户') + ')</button>';
      document.getElementById('authSync').onclick = syncNow;
      document.getElementById('authOut').onclick = function () {
        if (dirty) push(); // 退出前尽量保存
        sb.auth.signOut().then(function () { user = null; setAuth(null); if (brand) brand.textContent = '本地数据'; FW.toast('已退出'); });
      };
    }
  }

  function openLogin() {
    var body =
      '<div class="tabs" style="margin-bottom:10px">' +
        '<button class="tab active" id="lgTab">邮箱登录</button>' +
        '<button class="tab" id="rgTab">邮箱注册</button>' +
        '<button class="tab" id="phTab">手机登录</button>' +
      '</div>' +
      '<div id="auEmailForm">' +
        '<div class="field"><label>邮箱</label><input id="au_email" type="email" placeholder="you@example.com" autocomplete="username"></div>' +
        '<div class="field"><label>密码（至少 6 位）</label><input id="au_pwd" type="password" placeholder="••••••" autocomplete="current-password"></div>' +
      '</div>' +
      '<div id="auPhoneForm" style="display:none">' +
        '<div class="field"><label>手机号（含国家码，如 +8613800138000）</label><input id="au_phone" type="tel" placeholder="+8613800138000" autocomplete="tel"></div>' +
        '<div class="field" id="auCodeWrap" style="display:none"><label>短信验证码</label><input id="au_code" type="text" placeholder="6 位验证码" inputmode="numeric"></div>' +
        '<div class="muted" id="auPhoneHint" style="font-size:12px;margin:6px 0 10px"></div>' +
      '</div>' +
      '<div class="muted" id="auMsg" style="font-size:12px;margin:6px 0 10px"></div>' +
      '<div class="form-actions"><button class="btn ghost" id="auCancel">取消</button><button class="btn" id="auGo">登录</button></div>';
    FW.openModal('账号登录 / 注册', body, function () {
      var mode = 'login';
      function showForm() {
        document.getElementById('auEmailForm').style.display = (mode === 'phone') ? 'none' : '';
        document.getElementById('auPhoneForm').style.display = (mode === 'phone') ? '' : 'none';
        document.getElementById('auCodeWrap').style.display = 'none';
        document.getElementById('auGo').textContent = (mode === 'phone') ? '获取验证码' : (mode === 'reg' ? '注册并登录' : '登录');
        document.getElementById('auMsg').textContent = '';
      }
      document.getElementById('lgTab').onclick = function () {
        mode = 'login'; this.classList.add('active');
        document.getElementById('rgTab').classList.remove('active');
        document.getElementById('phTab').classList.remove('active');
        showForm();
      };
      document.getElementById('rgTab').onclick = function () {
        mode = 'reg'; this.classList.add('active');
        document.getElementById('lgTab').classList.remove('active');
        document.getElementById('phTab').classList.remove('active');
        showForm();
      };
      document.getElementById('phTab').onclick = function () {
        mode = 'phone'; this.classList.add('active');
        document.getElementById('lgTab').classList.remove('active');
        document.getElementById('rgTab').classList.remove('active');
        showForm();
      };
      document.getElementById('auCancel').onclick = FW.closeModal;
      document.getElementById('auGo').onclick = function () {
        var msg = document.getElementById('auMsg');
        if (mode === 'phone') {
          var phone = document.getElementById('au_phone').value.trim();
          if (!phone) { msg.textContent = '请输入手机号'; return; }
          if (!phone.startsWith('+')) phone = '+86' + phone.replace(/^\+?86/, '');
          // 第一步：发送验证码
          if (document.getElementById('auCodeWrap').style.display === 'none') {
            msg.textContent = '发送中…';
            sb.auth.signInWithOtp({ phone: phone }).then(function (r) {
              if (r.error) { msg.textContent = '发送失败：' + r.error.message; return; }
              document.getElementById('auCodeWrap').style.display = '';
              msg.textContent = '验证码已发送，请查收短信';
              document.getElementById('auGo').textContent = '登录';
            }).catch(function (e) { msg.textContent = '错误：' + (e && e.message ? e.message : e); });
            return;
          }
          // 第二步：校验验证码
          var code = document.getElementById('au_code').value.trim();
          if (!code) { msg.textContent = '请输入验证码'; return; }
          msg.textContent = '验证中…';
          sb.auth.verifyOtp({ phone: phone, token: code, type: 'sms' }).then(function (r) {
            if (r.error) { msg.textContent = '验证失败：' + r.error.message; return; }
            FW.closeModal(); // onAuthStateChange 会触发拉取
          }).catch(function (e) { msg.textContent = '错误：' + (e && e.message ? e.message : e); });
          return;
        }
        // 邮箱登录 / 注册
        var email = document.getElementById('au_email').value.trim();
        var pwd = document.getElementById('au_pwd').value;
        if (!email || !pwd) { msg.textContent = '请输入邮箱和密码'; return; }
        if (pwd.length < 6) { msg.textContent = '密码至少 6 位'; return; }
        msg.textContent = '处理中…';
        var p = mode === 'reg'
          ? sb.auth.signUp({ email: email, password: pwd })
          : sb.auth.signInWithPassword({ email: email, password: pwd });
        p.then(function (r) {
          if (r.error) { msg.textContent = '失败：' + r.error.message; return; }
          if (mode === 'reg' && r.data.user && !r.data.session) {
            msg.textContent = '注册成功！请到邮箱点击验证链接，再回来登录。';
            return;
          }
          FW.closeModal(); // onAuthStateChange 会触发拉取
        }).catch(function (e) { msg.textContent = '错误：' + (e && e.message ? e.message : e); });
      };
    });
  }

  /* ---------- 对外接口 ---------- */
  FW.sync = {
    init: init,
    enabled: function () { return enabled; },
    isLoggedIn: function () { return !!user; },
    push: push,
    pull: pull,
    syncNow: syncNow,
    afterUnlock: afterUnlock,
    // 供 ui.js 在登录态变化时刷新顶栏
    _refreshArea: renderAuthArea
  };

  // 页面加载即尝试初始化（main.js 也会再调一次，幂等）
  if (document.readyState !== 'loading') init();
  else document.addEventListener('DOMContentLoaded', init);
})(window);
