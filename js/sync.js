/* ============================================================
 * 云端同步层（Supabase）
 * - 登录 / 注册 / 退出（邮箱 / 手机短信）
 * - 把整个应用状态当作「快照」实时存到 Supabase
 * - 启用本地加密时：上传的是密文快照，密钥仅在本机内存，云端/他端均无法解密
 * - 包裹 FW.db 的写方法自动标记 dirty（仅标记，不再自动推送；同步完全手动，点「立即同步」触发）
 * - 未配置 APP_CONFIG 时自动降级为纯本地模式（不报错）
 * ============================================================ */
(function (global) {
  'use strict';
  var FW = global.FW;

  var cfg = global.APP_CONFIG || {};
  var url = cfg.SUPABASE_URL, anon = cfg.SUPABASE_ANON_KEY;
  var enabled = !!(url && anon);

  var sb = null;       // supabase client
  var cachedSession = null; // 缓存已恢复的登录会话（含 access_token），供 storage REST 取 token（避免依赖 v2 已废弃的 sb.auth.session()）
  var user = null;     // 当前用户
  var dirty = false;   // 是否有未推送改动
  var suppress = false;// 拉取/导入期间抑制 dirty 标记
  var syncing = false; // 是否正在同步（防止登录态回调并发触发多次重叠同步）
  var timer = null;

  function hasSupabase() { return !!(global.supabase && global.supabase.createClient); }

  // 通用超时包装：网络层挂起时（国内→Supabase 链路不稳/522）主动失败，而不是无限等待
  function withTimeout(promise, ms, msg) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var t = setTimeout(function () { if (!done) { done = true; reject(new Error(msg || '请求超时')); } }, ms);
      promise.then(function (r) { if (!done) { done = true; clearTimeout(t); resolve(r); } },
                   function (e) { if (!done) { done = true; clearTimeout(t); reject(e); } });
    });
  }
  var NET_HINT = '当前网络到云端不稳定（已等待超时）。可稍后再试；不登录也能正常记账、导出。';

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

    // 尝试恢复已存会话（带 8s 超时）：网络不稳时不再无限挂起/522，失败则静默保持未登录态。
    // 恢复成功会自动拉取最新云端数据（多设备习惯不变）
    withTimeout(sb.auth.getSession(), 8000, '恢复会话超时').then(function (r) {
      if (r && r.data && r.data.session) { user = r.data.session.user; cachedSession = r.data.session; onLogin(); }
    }).catch(function () {});

    // 登录态变化（显式登录/注册/验证码成功时触发）
    sb.auth.onAuthStateChange(function (ev, sess) {
      if (sess && sess.user) { user = sess.user; cachedSession = sess; onLogin(); }
      else { user = null; setAuth(null); }
    });

    hookDb();
    startAutosave();
  }

  // 只有本端有实际数据才回推，避免用空数据覆盖云端（解决"空快照饿死"）
  function pushIfHasData() {
    return FW.db.exportSyncSnapshot().then(function (snap) {
      var has = snap && snap.raw && Object.keys(snap.raw).length > 0;
      if (!has) return false;
      return push(true);
    });
  }

  // 完整双向同步：先拉（合并云端数据到本机），再推（把合并后的最新状态回传云端）
  function syncNow() {
    if (syncing) return Promise.resolve(); // 已有同步在进行，避免重叠竞争导致重复
    if (!user) { FW.toast('请先登录'); return Promise.resolve(); }
    if (FW.db.cryptoEnabled() && !FW.db.isUnlocked()) { FW.toast('请先解锁加密再同步'); return Promise.resolve(); }
    syncing = true;
    return pull().then(function (res) {
      // 关键修复：拉取出错时绝不推送，避免用本机旧/不完整数据整行覆盖云端，导致他端数据丢失
      if (res === 'error') {
        syncing = false;
        FW.toast('拉取云端失败，已取消推送以保护云端数据');
        return;
      }
      // 'merged'（有云端数据并合并）或 'empty'（首次初始化）都可安全推送
      return pushIfHasData();
    }).then(function () {
      syncing = false;
      if (dirty) { FW.toast('已从云端合并，但推送到云端失败——本地改动已保留，可稍后再点同步'); return; }
      return syncPhotos().then(function (pr) {
        if (pr && pr.error) FW.toast('业务已同步；凭证图同步失败：' + pr.error);
        else if (pr && pr.needSetup) FW.toast('业务数据已同步；凭证图云同步未开启（Supabase 需建存储桶 vouchers）');
        else if (pr && (pr.up || pr.dl)) FW.toast('同步完成（凭证图：上传' + (pr.up || 0) + '/下载' + (pr.dl || 0) + (pr.del ? '/清理' + pr.del : '') + '）');
        else FW.toast('同步完成');
      }).catch(function () { FW.toast('同步完成（凭证图同步跳过）'); });
    }).catch(function (e) {
      syncing = false;
      FW.toast('同步失败：' + (e && e.message ? e.message : '未知错误'));
    });
  }

  function onLogin() {
    setAuth(user);
    // 已启用加密但尚未解锁：先不拉取，等解锁后由 afterUnlock 触发
    if (FW.db.cryptoEnabled() && !FW.db.isUnlocked()) return;
    // 取消自动同步：登录/恢复会话后不再自动 pull/push，避免云端与本机数据在用户不知情时互相覆盖。
    // 数据同步完全交给用户手动点「立即同步」。
    updateDirtyBadge();
  }

  // 解锁完成后由 main.boot 调用：仅刷新登录态/未同步标记，不再自动拉取/推送
  function afterUnlock() {
    if (!user) return;
    if (FW.db.cryptoEnabled() && !FW.db.isUnlocked()) return;
    updateDirtyBadge();
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

  function markDirty() { dirty = true; updateDirtyBadge(); }
  function markClean() { dirty = false; setSync(new Date()); updateDirtyBadge(); }
  // 顶栏同步状态徽标：有未同步改动时标红「待同步」，否则显示「已同步」
  function updateDirtyBadge() {
    var el = document.getElementById('authState');
    if (!el || !user) return;
    if (dirty) { el.textContent = '● 待同步'; el.className = 'auth-state warn'; }
    else { el.textContent = '☁ 已同步'; el.className = 'auth-state'; }
  }

  /* ---------- 推送（本地 → 云端） ---------- */
  // 单次推送（含 45s 超时）；失败由 push() 决定是否重试
  function pushOnce(payload) {
    return withTimeout(sb.from('snapshots').upsert({
      user_id: user.id,
      data: payload,
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id' }), 90000, '推送云端超时，网络不稳定');
  }

  function push(force) {
    if (!user || (!dirty && !force)) return Promise.resolve(false);
    if (FW.db.cryptoEnabled() && !FW.db.isUnlocked()) return Promise.resolve(false);
    return FW.db.exportSyncSnapshot().then(function (snap) {
      return FW.db.encryptSnapshot(snap).then(function (payload) {
        var attempt = 0, lastErr = null;
        function tryOnce() {
          attempt++;
          return pushOnce(payload).then(function (r) {
            if (r && r.error) { lastErr = r.error; return 'bizerr'; } // 业务错误（约束/权限）不重试
            markClean();
            return 'ok';
          }).catch(function (e) {
            lastErr = e;
            if (attempt >= 3) return 'fail'; // 最多重试 3 次
            return new Promise(function (res) { setTimeout(res, 800 * attempt); }).then(tryOnce); // 指数退避后重试
          });
        }
        return tryOnce().then(function (st) {
          if (st === 'ok') return true;
          var msg = (lastErr && lastErr.message) ? lastErr.message : '未知错误';
          if (st === 'bizerr') FW.toast('同步失败：' + msg);
          else FW.toast('同步失败（已重试 ' + attempt + ' 次）：' + msg);
          return false;
        });
      });
    }).catch(function (e) {
      FW.toast('同步失败：' + (e && e.message ? e.message : '未知错误'));
      return false;
    });
  }

  /* ---------- 拉取（云端 → 本地） ---------- */
  // 返回 Promise，resolve 值为同步语义：
  //   'merged' 已成功拉取并合并云端数据到本机
  //   'empty'  云端暂无数据（首次使用），可安全推送本机数据做初始化
  //   'error'  拉取/解密失败 —— 调用方严禁继续推送，否则会用本机旧数据覆盖云端导致他端数据丢失
  function pull() {
    if (!user) return Promise.resolve('error');
    return withTimeout(sb.from('snapshots').select('data').eq('user_id', user.id).maybeSingle(), 15000, '拉取云端超时，网络不稳定').then(function (r) {
      if (r.error && r.error.code !== 'PGRST116') { FW.toast('拉取失败：' + r.error.message); return 'error'; }
      if (!r.data || !r.data.data) return 'empty'; // 尚无云端数据，可安全推送初始化
      var payload = r.data.data;
      // 云端为密文但本端未解锁（多设备首次）：弹出密码解锁后再拉
      if (payload && payload.__enc && !FW.db.isUnlocked()) {
        if (FW.cryptoUI && FW.cryptoUI.showUnlock) FW.cryptoUI.showUnlock(function () { pull(); }, payload.salt);
        return 'error';
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
          // 刷新内账模块的账户缓存（否则自定义账户不会出现在下拉列表）
          if (FW.internalAccMgr && FW.internalAccMgr.refreshAccts) FW.internalAccMgr.refreshAccts();
          FW.toast('已从云端同步最新数据');
          return 'merged';
        }).catch(function () { suppress = false; return 'error'; });
      }).catch(function () {
        FW.toast('云端数据解密失败（主密码不符？）');
        return 'error';
      });
    });
  }

  // 以云端为准覆盖本机：丢弃本机独有数据，完全对齐云端（用于本机数据混乱/不一致时一键对齐）
  function overwriteFromCloud() {
    if (syncing) return Promise.resolve();
    if (!user) { FW.toast('请先登录'); return Promise.resolve(); }
    if (FW.db.cryptoEnabled() && !FW.db.isUnlocked()) { FW.toast('请先解锁加密再同步'); return Promise.resolve(); }
    if (!global.confirm || !global.confirm('将以云端数据完全覆盖本机（本机独有数据将丢失），确定继续？')) return Promise.resolve();
    syncing = true;
    return withTimeout(sb.from('snapshots').select('data').eq('user_id', user.id).maybeSingle(), 15000, '拉取云端超时，网络不稳定').then(function (r) {
      if (r.error && r.error.code !== 'PGRST116') { FW.toast('拉取失败：' + r.error.message); syncing = false; return false; }
      if (!r.data || !r.data.data) { FW.toast('云端暂无数据，无法覆盖'); syncing = false; return false; }
      var payload = r.data.data;
      if (payload && payload.__enc && !FW.db.isUnlocked()) {
        if (FW.cryptoUI && FW.cryptoUI.showUnlock) FW.cryptoUI.showUnlock(function () { overwriteFromCloud(); }, payload.salt);
        syncing = false; return false;
      }
      return FW.db.decryptSnapshot(payload).then(function (snap) {
        suppress = true;
        return FW.db.importAll(snap, false).then(function () { // false = 覆盖式，不按 id 合并
          suppress = false;
          var keepCur = FW.db.getCurrentLedger();
          FW.db.setCurrentLedger(keepCur);
          if (FW.refreshLedgers) FW.refreshLedgers();
          if (FW.modules.sidebar) FW.modules.sidebar.render();
          var active = document.querySelector('#moduleNav .nav-item.active');
          if (active && FW.setModule) FW.setModule(active.dataset.module);
          if (FW.internalAccMgr && FW.internalAccMgr.refreshAccts) FW.internalAccMgr.refreshAccts();
          markClean();
          return pullPhotos().then(function (pr) {
            if (pr && pr.error) FW.toast('已以云端为准覆盖本机；凭证图同步失败：' + pr.error);
            else if (pr && pr.needSetup) FW.toast('已以云端为准覆盖本机（凭证图云同步未开启）');
            else FW.toast('已以云端为准覆盖本机' + (pr && pr.dl ? '（凭证图已下拉' + pr.dl + '张）' : ''));
          }).catch(function () { FW.toast('已以云端为准覆盖本机'); }).then(function () { syncing = false; return true; });
        }).catch(function () { suppress = false; syncing = false; return false; });
      }).catch(function () { FW.toast('云端数据解密失败（主密码不符？）'); syncing = false; return false; });
    });
  }

  // 以本机为准覆盖云端：用本机数据整行覆盖云端（谨慎！其他端独有数据将丢失）。仅用于云端被污染时恢复。
  function forcePushLocal() {
    if (syncing) return Promise.resolve();
    if (!user) { FW.toast('请先登录'); return Promise.resolve(); }
    if (FW.db.cryptoEnabled() && !FW.db.isUnlocked()) { FW.toast('请先解锁加密再同步'); return Promise.resolve(); }
    if (!global.confirm || !global.confirm('将用本机数据完全覆盖云端（其他设备独有数据将丢失），仅建议在云端数据出错时恢复，确定继续？')) return Promise.resolve();
    syncing = true;
    return push(true).then(function (ok) {
      syncing = false;
      if (!ok) return ok;
      return syncPhotos({ mirror: true }).then(function (pr) {
        if (pr && pr.error) FW.toast('已用本机数据覆盖云端；凭证图同步失败：' + pr.error);
        else if (pr && pr.needSetup) FW.toast('已用本机数据覆盖云端（凭证图云同步未开启）');
        else FW.toast('已用本机数据覆盖云端' + (pr && (pr.up || pr.del) ? '（凭证图：上传' + (pr.up || 0) + '/清理云端' + (pr.del || 0) + '）' : ''));
      }).catch(function () { FW.toast('已用本机数据覆盖云端'); });
      return ok;
    });
  }

  /* ---------- 凭证图云同步（Supabase Storage，与业务快照分离，避免 POST 过大超时） ---------- */
  // 需先在 Supabase 建私有桶 vouchers 并放行已登录用户（见部署说明）；未建桶时自动跳过、不阻塞业务同步。
  var PHOTO_BUCKET = 'vouchers';
  function photoKey(uid, pid) { return uid + '/' + pid; }
  // 是否启用凭证图云同步：仅需 REST URL 与 anon key，不再依赖 sb.storage()（浏览器缓存住旧版 supabase.js 仍可正常工作）
  function storageReady() { return !!(url && anon); }
  function restBase() { return String(url).replace(/\/$/, '') + '/storage/v1/object'; }
  // Storage REST 需 Authorization: Bearer {access_token}（RLS policy 用 auth.uid() 校验），未登录时回退 anon
  // 取 storage REST 用的 access_token（Bearer）。RLS policy 用 auth.uid() 校验，必须是「真实用户 token」，
  // 不能用 anon（anon 调私有桶会被 Supabase 一律返回 Bucket not found，从而被误判成 needSetup）。
  // supabase-js v2 已废弃/移除 sb.auth.session() 同步方法，若它不存在或返回 null 会回退 anon —— 这正是
  // 「桶已建好却报凭证图同步未开启」的根因。故改为三层取法，不依赖该废弃方法：
  //   cachedSession（init 里 getSession() 恢复后缓存） -> 老接口 session() -> 直接读 localStorage 里 supabase 存的 session
  function getAccessToken() {
    try {
      if (sb && sb.auth) {
        if (cachedSession && cachedSession.access_token) return cachedSession.access_token;
        if (typeof sb.auth.session === 'function') {
          var s = sb.auth.session();
          if (s && s.access_token) return s.access_token;
        }
        // 兜底：supabase 把 session 存到 localStorage，key 形如 sb-<ref>-auth-token，JSON 含 access_token
        var ls = global.localStorage;
        if (ls) {
          var keys = Object.keys(ls);
          for (var i = 0; i < keys.length; i++) {
            if (/auth-token$/.test(keys[i])) {
              try {
                var p = JSON.parse(ls.getItem(keys[i]) || '{}');
                if (p && p.access_token) return p.access_token;
              } catch (e2) {}
            }
          }
        }
      }
    } catch (e) {}
    return anon;
  }
  function apiHeaders(extra) {
    var h = { 'apikey': anon, 'authorization': 'Bearer ' + getAccessToken() };
    if (extra) for (var k in extra) h[k] = extra[k];
    return h;
  }
  // 通用 fetch：响应非 ok 时把 {statusCode, message} 形态抛错，sync.js 内层 isBucketMissing() 直接判
  function fetchOk(promise) {
    return promise.then(function (r) {
      if (r.ok) return r;
      return r.text().then(function (txt) {
        var msg = txt;
        try { var j = JSON.parse(txt); msg = j.message || j.error || txt; } catch (e) {}
        throw { statusCode: r.status, message: msg, error: msg };
      });
    });
  }

  function dataUrlToBlob(dataUrl) {
    return new Promise(function (resolve, reject) {
      try {
        var parts = String(dataUrl).split(',');
        var mime = (parts[0].match(/data:([^;]+)/) || [])[1] || 'image/jpeg';
        var bin = atob(parts[1] || '');
        var arr = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        resolve(new Blob([arr], { type: mime }));
      } catch (e) { reject(e); }
    });
  }
  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(fr.error); };
      fr.readAsDataURL(blob);
    });
  }
  function isBucketMissing(err) {
    if (!err) return false;
    var m = String(err.message || err.error || '');
    // Supabase Storage 对不存在的桶返回 statusCode=400 + message 含 "Bucket not found"（注意：不是 404）
    // 容忍 400 / 404 / 无 statusCode（网络/解析失败）三种，但 message 必须明确命中桶不存在关键词
    var hits = /NoSuchBucket/i.test(m) || /Bucket\s*not\s*found/i.test(m) || /BucketNotFound/i.test(m);
    var code = err.statusCode;
    return hits && (code === 400 || code === 404 || !code);
  }
  function listCloudPhotos(uid) {
    var u = restBase() + '/list/' + PHOTO_BUCKET + '?prefix=' + encodeURIComponent(uid + '/') + '&limit=3000';
    return withTimeout(
      fetchOk(fetch(u, { method: 'GET', headers: apiHeaders() })).then(function (r) { return r.json().then(function (arr) { return { data: arr || [], error: null }; }); }),
      30000, '列举云端凭证图超时'
    ).catch(function (e) {
      // 不要把任何 Bucket 相关错误一律判 needSetup；fetchOk 已 throw {statusCode,message}，交给上层 isBucketMissing() 按收紧后的规则判定
      try { console.warn('[sync.listCloudPhotos]', 'uid=' + uid, 'err=', e && (e.statusCode || e.code), e && e.message); } catch (_) {}
      throw e;
    });
  }
  function uploadPhoto(uid, pid, dataUrl) {
    return dataUrlToBlob(dataUrl).then(function (blob) {
      var u = restBase() + '/' + PHOTO_BUCKET + '/' + uid + '/' + encodeURIComponent(pid);
      var headers = apiHeaders({ 'content-type': blob.type || 'image/jpeg', 'x-upsert': 'true', 'cache-control': 'max-age=3600' });
      return withTimeout(fetchOk(fetch(u, { method: 'POST', headers: headers, body: blob })), 60000, '上传凭证图超时');
    });
  }
  function downloadPhoto(uid, pid) {
    var u = restBase() + '/' + PHOTO_BUCKET + '/' + uid + '/' + encodeURIComponent(pid);
    return withTimeout(
      fetchOk(fetch(u, { method: 'GET', headers: apiHeaders() })).then(function (r) { return r.blob().then(blobToDataUrl); }),
      60000, '下载凭证图超时'
    );
  }
  function removeCloudPhoto(uid, pid) {
    var u = restBase() + '/' + PHOTO_BUCKET;
    var body = JSON.stringify({ prefixes: [uid + '/' + pid] });
    return withTimeout(
      fetchOk(fetch(u, { method: 'DELETE', headers: apiHeaders({ 'content-type': 'application/json' }), body: body })),
      30000, '删除云端凭证图超时'
    );
  }
  // 双向凭证图同步：
  //   toUp = 本地有/云端无 → 上传（本机为准，补齐云端）
  //   toDl = 云端有/本地无 → 下载（合并他端新增）
  //   toDel = 仅在 opts.mirror（「本机为准覆盖云端」）时清理云端多出的凭证图；
  //           双向合并默认不删，避免误删其他设备独有照片（无 tombstone 无法区分"他端新增"与"本端已删"）。
  // 返回 { up, dl, del?, needSetup?, skipped?, error? }
  function syncPhotos(opts) {
    opts = opts || {};
    if (!user || !storageReady()) return Promise.resolve({ skipped: true });
    if (FW.db.cryptoEnabled() && !FW.db.isUnlocked()) return Promise.resolve({ skipped: true });
    var uid = user.id;
    // db.js 新增 API（2026-08-07）：老测试 mock 未必跟上，加 fallback 避免抛错
    var getLocalIds = FW.db.listLocalPhotoIds || function () { return Promise.resolve([]); };
    return getLocalIds().then(function (localIds) {
      return listCloudPhotos(uid).then(function (lr) {
        if (lr.error) { if (isBucketMissing(lr.error)) return { needSetup: true }; throw lr.error; }
        var cloudIds = (lr.data || []).map(function (o) { return o.name; });
        var toUp = localIds.filter(function (id) { return cloudIds.indexOf(id) < 0; });
        // 合并模式才下载云端独有（他端新增）；mirror（本机为准）时本地优先，不把云端独有拉下来
        var toDl = opts.mirror ? [] : cloudIds.filter(function (id) { return localIds.indexOf(id) < 0; });
        return Promise.all(toUp.map(function (id) {
          return FW.db.getPhoto(id).then(function (d) { return d ? uploadPhoto(uid, id, d).then(function () { return 1; }).catch(function () { return 0; }) : 0; });
        })).then(function (ups) {
          var upN = ups.reduce(function (a, b) { return a + b; }, 0);
          return Promise.all(toDl.map(function (id) {
            return downloadPhoto(uid, id).then(function (d) { return FW.db.putPhotoById(id, d).then(function () { return 1; }).catch(function () { return 0; }); }).catch(function () { return 0; });
          })).then(function (dls) {
            var dlN = dls.reduce(function (a, b) { return a + b; }, 0);
            if (!opts.mirror) return { up: upN, dl: dlN };
            var toDel = cloudIds.filter(function (id) { return localIds.indexOf(id) < 0; });
            if (!toDel.length) return { up: upN, dl: dlN };
            return Promise.all(toDel.map(function (id) { return removeCloudPhoto(uid, id).catch(function () { return 0; }); })).then(function (rs) {
              return { up: upN, dl: dlN, del: rs.length };
            });
          });
        });
      });
    }).catch(function (e) {
      if (isBucketMissing(e)) { try { console.warn('[sync.syncPhotos] needSetup, err=', e); } catch (_) {} return { needSetup: true }; }
      try { console.warn('[sync.syncPhotos] failed, err=', e); } catch (_) {}
      return { error: (e && e.message) || String(e) };
    });
  }
  // 以云端为准拉取凭证图（仅下载，不删本地）
  function pullPhotos() {
    if (!user || !storageReady()) return Promise.resolve({ skipped: true });
    var uid = user.id;
    return listCloudPhotos(uid).then(function (lr) {
      if (lr.error) { if (isBucketMissing(lr.error)) return { needSetup: true }; throw lr.error; }
      var cloudIds = (lr.data || []).map(function (o) { return o.name; });
      return Promise.all(cloudIds.map(function (id) {
        return downloadPhoto(uid, id).then(function (d) { return FW.db.putPhotoById(id, d).then(function () { return 1; }).catch(function () { return 0; }); }).catch(function () { return 0; });
      })).then(function (rs) { return { dl: rs.reduce(function (a, b) { return a + b; }, 0) }; });
    }).catch(function (e) {
      if (isBucketMissing(e)) { try { console.warn('[sync.pullPhotos] needSetup, err=', e); } catch (_) {} return { needSetup: true }; }
      try { console.warn('[sync.pullPhotos] failed, err=', e); } catch (_) {}
      return { error: (e && e.message) || String(e) };
    });
  }

  /* ---------- 手动同步（已取消自动同步） ---------- */
  function startAutosave() {
    // 已取消自动同步：不再定时/页面隐藏时自动推送本地数据到云端，全部由用户手动点「立即同步」。
    // 仅保留关闭/刷新页面时的「未同步提醒」：有关键改动未上传时给一次确认，避免静默丢失用户感知。
    global.addEventListener('beforeunload', function (e) {
      if (user && dirty) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  /* ---------- 登录 / 注册界面 ---------- */

  function openLogin() {
    // 直接弹出登录/注册表单（会话恢复已由 init 的 getSession 兜底，此处不再等待网络）
    showLoginForm();
  }

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
        '<button class="auth-btn ghost" id="authSyncOpts">⚙ 同步选项</button>' +
        '<button class="auth-btn" id="authOut">退出(' + FW.esc(user.email || '用户') + ')</button>';
      document.getElementById('authSync').onclick = syncNow;
      document.getElementById('authSyncOpts').onclick = openSyncMenu;
      updateDirtyBadge();
      document.getElementById('authOut').onclick = function () {
        // 取消自动同步：退出前不再静默推送。若本地有未同步改动，先征求确认以免数据「消失」。
        if (dirty && global.confirm && !global.confirm('本地有未同步的改动，退出后这些改动不会自动上传云端。\n重新登录后点「立即同步」即可上传。确定退出？')) return;
        withTimeout(sb.auth.signOut(), 8000, '退出超时').then(function () { user = null; setAuth(null); if (brand) brand.textContent = '本地数据'; FW.toast('已退出'); })
          .catch(function () { user = null; setAuth(null); if (brand) brand.textContent = '本地数据'; FW.toast('已退出（网络异常，仅本地退出）'); });
      };
    }
  }

  function openSyncMenu() {
    var body =
      '<p class="muted" style="font-size:12px;margin:0 0 12px">选择同步方式：</p>' +
      '<div style="margin:10px 0">' +
        '<button class="btn" id="smMerge" style="width:100%">↻ 双向合并同步（推荐）</button>' +
        '<p class="muted" style="font-size:12px;margin:6px 0 0">拉取云端并合并本机独有数据，再推回云端。最安全，不会丢数据。</p>' +
      '</div>' +
      '<div style="margin:14px 0">' +
        '<button class="btn ghost" id="smCloud" style="width:100%">☁ 以云端为准覆盖本机</button>' +
        '<p class="muted" style="font-size:12px;margin:6px 0 0">丢弃本机独有数据，完全对齐云端。本机数据杂乱或与云端不一致时使用。</p>' +
      '</div>' +
      '<div style="margin:14px 0">' +
        '<button class="btn ghost danger" id="smLocal" style="width:100%">💾 以本机为准覆盖云端</button>' +
        '<p class="muted" style="font-size:12px;margin:6px 0 0">谨慎！用本机数据覆盖云端，其他设备独有数据将丢失。仅用于云端被污染时恢复。</p>' +
      '</div>';
    FW.openModal('同步选项', body, function () {
      document.getElementById('smMerge').onclick = function () { FW.closeModal(); syncNow(); };
      document.getElementById('smCloud').onclick = function () { FW.closeModal(); overwriteFromCloud(); };
      document.getElementById('smLocal').onclick = function () { FW.closeModal(); forcePushLocal(); };
    });
  }

  function showLoginForm() {
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
            withTimeout(sb.auth.signInWithOtp({ phone: phone }), 8000, NET_HINT).then(function (r) {
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
          withTimeout(sb.auth.verifyOtp({ phone: phone, token: code, type: 'sms' }), 8000, NET_HINT).then(function (r) {
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
        var p = withTimeout(
          mode === 'reg'
            ? sb.auth.signUp({ email: email, password: pwd })
            : sb.auth.signInWithPassword({ email: email, password: pwd }),
          8000, NET_HINT);
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
    // 测试/调试钩子：暴露 token 取法，便于锁定「v2 废弃 session() 后仍能从 localStorage 取真实 token」的不变量
    _getAccessToken: getAccessToken,
    enabled: function () { return enabled; },
    isLoggedIn: function () { return !!user; },
    push: push,
    pull: pull,
    syncNow: syncNow,
    afterUnlock: afterUnlock,
    overwriteFromCloud: overwriteFromCloud,
    forcePushLocal: forcePushLocal,
    syncPhotos: syncPhotos, pullPhotos: pullPhotos,
    // 供 ui.js 在登录态变化时刷新顶栏
    // 一键诊断：把 storage 同步链路里所有关键状态打到 console + return 对象。
    // 用户遇到「凭证图云同步未开启」/「Bucket not found」类问题时，Console 跑一行 FW.sync._diagnose()，
    // 把输出的 JSON 复制给我，能一眼看出是 token 取错、桶真不存在、还是 RLS 没放行。
    _diagnose: async function () {
      var out = {};
      try {
        // (1) 模块内 cachedSession 状态
        out.cachedSession = !!(cachedSession && cachedSession.user);
        out.userId = (cachedSession && cachedSession.user && cachedSession.user.id) || null;
        // (2) 当前取到的 token：前 16 字符 + 长度 + 是否就是 anon key
        var token = getAccessToken();
        out.tokenPrefix = token ? token.substring(0, 16) : '(null)';
        out.tokenLen = token ? token.length : 0;
        try {
          var anon = (global.APP_CONFIG && APP_CONFIG.SUPABASE_ANON_KEY) || null;
          out.tokenIsAnon = anon ? (token === anon) : null;
        } catch (_) { out.tokenIsAnon = 'err'; }
        // (3) localStorage 探测：supabase-js v2 默认 key = sb-<ref>-auth-token，存 JSON.stringify(session)
        out.localStorageAuthKey = null;
        out.localStorageHasAccessToken = false;
        if (typeof localStorage !== 'undefined') {
          try {
            var k = Object.keys(localStorage).find(function (kk) { return kk.indexOf('-auth-token') >= 0; }) || null;
            if (k) {
              out.localStorageAuthKey = k;
              var raw = localStorage.getItem(k);
              var parsed = raw ? JSON.parse(raw) : null;
              out.localStorageHasAccessToken = !!(parsed && parsed.access_token);
              if (!out.userId && parsed && parsed.user && parsed.user.id) out.userId = parsed.user.id;
            }
          } catch (e) { out.localStorageError = (e && e.message) || String(e); }
        }
        // (4) 真实 list 接口探测：直接打一次，看 status + body 前 200 字符
        var uid = out.userId;
        if (uid) {
          try {
            var u = restBase() + '/list/' + PHOTO_BUCKET + '?prefix=' + encodeURIComponent(uid + '/') + '&limit=5';
            var r = await fetch(u, { method: 'GET', headers: apiHeaders() });
            out.listStatus = r.status;
            out.listOk = r.ok;
            var body = await r.text();
            out.listBodyShort = body.substring(0, 200);
            try {
              out.listIsBucketMissing = isBucketMissing({ statusCode: r.status, message: body });
            } catch (_) { out.listIsBucketMissing = 'err'; }
          } catch (e) { out.listError = (e && e.message) || String(e); }
        } else {
          out.listSkipped = '(no uid)';
        }
      } catch (e) {
        out.diagnoseError = (e && e.message) || String(e);
      }
      try { console.log('[FW.sync._diagnose] ' + JSON.stringify(out)); } catch (_) {}
      return out;
    },
    _refreshArea: renderAuthArea
  };

  // 页面加载即尝试初始化（main.js 也会再调一次，幂等）
  if (document.readyState !== 'loading') init();
  else document.addEventListener('DOMContentLoaded', init);
})(window);
