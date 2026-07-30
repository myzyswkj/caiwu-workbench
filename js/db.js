/* ============================================================
 * 数据存储层
 * - 文本数据：localStorage（按 key 存 JSON） 或 加密内存模型（启用加密时）
 * - 照片凭证：IndexedDB（存 base64 dataURL；启用加密时一并加密）
 * - 多账本：除「全局键」外，所有数据键按当前账本命名空间隔离
 * - 加密：主密码 → PBKDF2 派生密钥 → AES-GCM；密钥只在内存，云端/本地均为密文
 * ============================================================ */
(function (global) {
  'use strict';

  var LS_PREFIX = 'fw_';              // finance workbench
  var PHOTO_DB = 'fw_photos';
  var PHOTO_STORE = 'photos';
  var META_KEY = 'crypto_meta';
  var VAULT_KEY = 'vault';

  // 全局键（跨账本共享，不被命名空间隔离）
  var GLOBAL_KEYS = ['sites', 'memos', 'kb_notes', 'ledgers', 'currentLedger', 'tax_templates'];
  // 按账本隔离的键
  var PERLEDGER_KEYS = ['internal', 'internal_budget', 'internal_cats', 'internal_openings', 'internal_accounts', 'tax_vouchers', 'tax_journals', 'tax_statements', 'contacts', 'tax_openings', 'tax_assets', 'invoices', 'contracts', 'stock', 'tax_filings', 'tax_calendar_custom', 'salary_employees', 'salary_records'];

  // ---------- 加密状态 ----------
  var encMode = false;     // 已启用加密且已解锁
  var encKey = null;       // CryptoKey
  var metaSalt = null;     // 当前 salt（base64）
  var mem = {};            // 加密态下的内存数据（nsKey → 值）
  var persistTimer = null;

  /* ---------- 明文 localStorage 读写（降级/未加密时） ---------- */
  function lsRaw(key, fallback) {
    try {
      var raw = localStorage.getItem(LS_PREFIX + key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      console.warn('读取失败', key, e);
      return fallback;
    }
  }
  function lsWrite(key, value) {
    try {
      localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
      return true;
    } catch (e) {
      console.error('写入失败（可能超出容量）', key, e);
      global.FW && global.FW.toast && global.FW.toast('保存失败：本地存储空间不足');
      return false;
    }
  }
  function lsDel(key) { localStorage.removeItem(LS_PREFIX + key); }

  /* ---------- 账本管理 ---------- */
  function getLedgers() { return lsGet('ledgers', []); }
  function setLedgers(list) { return lsSet('ledgers', list); }
  function getCurrentLedger() {
    var cur = lsGet('currentLedger', null);
    if (cur) return cur;
    var list = getLedgers();
    return list.length ? list[0].id : 'default';
  }
  function setCurrentLedger(id) { return lsSet('currentLedger', id); }

  // 把旧版（无账本）数据迁移进默认账本
  function migrate() {
    var ledgers = lsGet('ledgers', null);
    if (ledgers === null) {
      var defaultId = 'L1';
      setLedgers([{ id: defaultId, name: '默认账本' }]);
      setCurrentLedger(defaultId);
      PERLEDGER_KEYS.forEach(function (base) {
        var old = lsGet(base, null);
        if (old !== null) { lsSet(base + '_' + defaultId, old); lsRemove(base); }
      });
    } else {
      // 兼容：若当前账本不在列表中，回退到第一个
      var cur = lsGet('currentLedger', null);
      if (!cur || !ledgers.some(function (l) { return l.id === cur; })) setCurrentLedger(ledgers[0].id);
    }
  }

  /* ---------- 命名空间 ---------- */
  function ns(base) {
    if (GLOBAL_KEYS.indexOf(base) >= 0) return base;
    return base + '_' + getCurrentLedger();
  }

  /* ---------- localStorage 文本存储（经命名空间，按加密态分支） ---------- */
  function lsGet(key, fallback) {
    if (encMode) return (mem[ns(key)] !== undefined) ? mem[ns(key)] : fallback;
    return lsRaw(ns(key), fallback);
  }
  function lsSet(key, value) {
    if (encMode) { mem[ns(key)] = value; schedulePersist(); return true; }
    return lsWrite(ns(key), value);
  }
  function lsRemove(key) {
    if (encMode) { delete mem[ns(key)]; schedulePersist(); return; }
    lsDel(ns(key));
  }

  /* 通用集合 CRUD（数组形式） */
  function getList(key) { return lsGet(key, []); }
  function saveList(key, arr) { return lsSet(key, arr); }
  function upsert(key, item) {
    var arr = getList(key);
    var i = arr.findIndex(function (x) { return x.id === item.id; });
    if (i >= 0) arr[i] = item; else arr.push(item);
    saveList(key, arr);
    return item;
  }
  function remove(key, id) {
    var arr = getList(key).filter(function (x) { return x.id !== id; });
    saveList(key, arr);
  }
  function getById(key, id) {
    return getList(key).find(function (x) { return x.id === id; }) || null;
  }

  function uid(prefix) {
    return (prefix || '') + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  // 删除某账本的全部业务数据
  function deleteLedgerData(id) {
    PERLEDGER_KEYS.forEach(function (base) { lsRemove(base + '_' + id); });
  }

  /* ---------- IndexedDB 照片存储 ---------- */
  function openPhotoDB() {
    return new Promise(function (resolve, reject) {
      if (!global.indexedDB) { reject(new Error('当前浏览器不支持 IndexedDB')); return; }
      var req = indexedDB.open(PHOTO_DB, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(PHOTO_STORE)) {
          db.createObjectStore(PHOTO_STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  // 加密态下对照片 dataURL 加解密
  function encPhoto(dataUrl) {
    if (!encMode || !encKey) return Promise.resolve(dataUrl);
    return FW.crypto.encrypt(encKey, dataUrl);
  }
  function decPhoto(payload) {
    if (!payload || typeof payload === 'string') return Promise.resolve(payload);
    if (!encMode || !encKey) return Promise.resolve(payload); // 理论上不会命中
    return FW.crypto.decrypt(encKey, payload).catch(function () { return payload; });
  }

  function savePhoto(dataUrl) {
    return openPhotoDB().then(function (db) {
      return encPhoto(dataUrl).then(function (store) {
        return new Promise(function (resolve, reject) {
          var id = uid('p_');
          var tx = db.transaction(PHOTO_STORE, 'readwrite');
          tx.objectStore(PHOTO_STORE).put({ id: id, data: store, enc: encMode, ts: Date.now() });
          tx.oncomplete = function () { resolve(id); };
          tx.onerror = function () { reject(tx.error); };
        });
      });
    });
  }

  function getPhoto(id) {
    return openPhotoDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(PHOTO_STORE, 'readonly');
        var req = tx.objectStore(PHOTO_STORE).get(id);
        req.onsuccess = function () {
          var r = req.result;
          if (!r) { resolve(null); return; }
          decPhoto(r.data).then(resolve).catch(function () { resolve(r.data); });
        };
        req.onerror = function () { reject(tx.error); };
      });
    });
  }

  function deletePhoto(id) {
    return openPhotoDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(PHOTO_STORE, 'readwrite');
        tx.objectStore(PHOTO_STORE).delete(id);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function deletePhotos(ids) {
    if (!ids || !ids.length) return Promise.resolve();
    return openPhotoDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(PHOTO_STORE, 'readwrite');
        var store = tx.objectStore(PHOTO_STORE);
        ids.forEach(function (id) { store.delete(id); });
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  // 读取全部照片（用于整库备份）；无 IndexedDB 时返回空数组
  function getAllPhotos() {
    if (!global.indexedDB) return Promise.resolve([]);
    return openPhotoDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(PHOTO_STORE, 'readonly');
        var req = tx.objectStore(PHOTO_STORE).getAll();
        req.onsuccess = function () {
          var list = (req.result || []).map(function (r) { return { id: r.id, data: r.data }; });
          Promise.all(list.map(function (it) {
            return decPhoto(it.data).then(function (d) { return { id: it.id, data: d }; });
          })).then(resolve).catch(function () { resolve(list); });
        };
        req.onerror = function () { reject(tx.error); };
      });
    });
  }

  // 按指定 id 写回照片（用于备份还原，保持 id 不变）
  function putPhotoById(id, dataUrl) {
    if (!global.indexedDB) return Promise.resolve();
    return openPhotoDB().then(function (db) {
      return encPhoto(dataUrl).then(function (store) {
        return new Promise(function (resolve, reject) {
          var tx = db.transaction(PHOTO_STORE, 'readwrite');
          tx.objectStore(PHOTO_STORE).put({ id: id, data: store, enc: encMode, ts: Date.now() });
          tx.oncomplete = function () { resolve(); };
          tx.onerror = function () { reject(tx.error); };
        });
      });
    });
  }

  /* ---------- 数据导入导出（整库快照，含账本与照片凭证） ---------- */
  function memSnapshot() {
    var o = {};
    for (var k in mem) { if (Object.prototype.hasOwnProperty.call(mem, k)) o[k] = mem[k]; }
    return o;
  }
  function scanLocalRaw() {
    var raw = {};
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && k.indexOf(LS_PREFIX) === 0) {
        var name = k.slice(LS_PREFIX.length);
        if (name === VAULT_KEY || name === META_KEY) continue;
        try { raw[name] = JSON.parse(localStorage.getItem(k)); }
        catch (e) { raw[name] = localStorage.getItem(k); }
      }
    }
    return raw;
  }

  // 返回 Promise：{ _app, _version, _exportedAt, raw, photos:[{id,data}] }
  function exportAll() {
    var raw = encMode ? memSnapshot() : scanLocalRaw();
    return getAllPhotos().then(function (photos) {
      return { _app: '财务工作台', _version: 3, _exportedAt: new Date().toISOString(), raw: raw, photos: photos };
    }).catch(function () {
      return { _app: '财务工作台', _version: 3, _exportedAt: new Date().toISOString(), raw: raw, photos: [] };
    });
  }

  // 返回 Promise；先还原文本数据，再还原照片凭证（保持 id 不变）
  // merge=true 时：数组按 id 合并（云端优先覆盖同 id，本地独有项保留），用于跨设备同步避免互相覆盖
  function importAll(data, merge) {
    if (!data || !data.raw) throw new Error('文件格式不正确');
    function apply(k, v) {
      if (merge && Array.isArray(v) && v.length && typeof v[0] === 'object' && v[0] && ('id' in v[0])) {
        var localArr = (encMode ? (mem[k] || []) : lsRaw(k, [])) || [];
        if (!Array.isArray(localArr)) localArr = [];
        var byId = {}, extra = [];
        localArr.forEach(function (x) { if (x && x.id != null) byId[x.id] = x; else extra.push(x); });
        v.forEach(function (x) { if (x && x.id != null) byId[x.id] = x; else extra.push(x); });
        v = Object.keys(byId).map(function (id) { return byId[id]; }).concat(extra);
      }
      if (encMode) { mem[k] = v; } else { lsWrite(k, v); }
    }
    Object.keys(data.raw).forEach(function (k) { apply(k, data.raw[k]); });
    if (encMode) schedulePersist();
    var photos = data.photos || [];
    if (!global.indexedDB || !photos.length) return Promise.resolve();
    return Promise.all(photos.map(function (p) { return putPhotoById(p.id, p.data); }));
  }

  /* ---------- 加密：元信息 / 仓库持久化 ---------- */
  function getMeta() {
    try { return JSON.parse(localStorage.getItem(LS_PREFIX + META_KEY) || 'null'); }
    catch (e) { return null; }
  }
  function setMeta(obj) {
    try { localStorage.setItem(LS_PREFIX + META_KEY, JSON.stringify(obj)); } catch (e) { console.warn('写元信息失败', e); }
  }
  function cryptoEnabled() {
    var m = getMeta();
    return !!(m && m.enabled);
  }
  function isUnlocked() { return encMode && !!encKey; }

  function schedulePersist() {
    if (!encMode || !encKey) return;
    if (persistTimer) return; // 简单防抖：400ms 内合并多次写入
    persistTimer = setTimeout(function () {
      persistTimer = null;
      persistVaultNow();
    }, 400);
  }
  function persistVaultNow() {
    if (!encMode || !encKey) return Promise.resolve();
    return FW.crypto.encrypt(encKey, { v: 1, data: memSnapshot() }).then(function (env) {
      try {
        localStorage.setItem(LS_PREFIX + VAULT_KEY, JSON.stringify({ __enc: true, salt: metaSalt, iv: env.iv, ct: env.ct }));
      } catch (e) { console.error('保存加密仓库失败', e); }
    }).catch(function (e) { console.error('加密失败', e); });
  }
  function flushVault() {
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
    return persistVaultNow();
  }

  // 将现有明文 localStorage 读入内存（启用加密时的迁移）
  function loadPlainIntoMem() {
    mem = {};
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && k.indexOf(LS_PREFIX) === 0) {
        var name = k.slice(LS_PREFIX.length);
        if (name === VAULT_KEY || name === META_KEY) continue;
        try { mem[name] = JSON.parse(localStorage.getItem(k)); }
        catch (e) { mem[name] = localStorage.getItem(k); }
      }
    }
  }

  // 启用加密（首次设置主密码）
  function enableCrypto(password) {
    if (!FW.crypto || !FW.crypto.available) return Promise.reject(new Error('当前环境不支持加密（需 HTTPS）'));
    if (encMode) return Promise.reject(new Error('已处于加密状态'));
    return FW.crypto.deriveKey(password).then(function (r) {
      encKey = r.key; metaSalt = r.saltB64;
      loadPlainIntoMem();
      encMode = true;
      setMeta({ enabled: true, salt: metaSalt, v: 1 });
      // 清除明文键，避免明文残留
      for (var k in mem) { if (Object.prototype.hasOwnProperty.call(mem, k)) localStorage.removeItem(LS_PREFIX + k); }
      return flushVault();
    });
  }

  // 解锁（saltB64 用于跨设备：以云端信封的 salt 派生密钥）
  function unlock(password, saltB64) {
    if (!FW.crypto || !FW.crypto.available) return Promise.reject(new Error('当前环境不支持加密（需 HTTPS）'));
    var meta = getMeta();
    if (!meta || !meta.enabled) {
      // 未启用却要求解锁（多设备首次从云端解密）：以云端 salt 派生
      return FW.crypto.deriveKey(password, saltB64 || null).then(function (r) {
        encKey = r.key; metaSalt = r.saltB64;
        mem = {}; encMode = true;
        setMeta({ enabled: true, salt: metaSalt, v: 1 });
        return flushVault();
      });
    }
    var vaultStr = localStorage.getItem(LS_PREFIX + VAULT_KEY);
    if (!vaultStr) {
      return FW.crypto.deriveKey(password, meta.salt).then(function (r) {
        encKey = r.key; metaSalt = r.saltB64;
        mem = {}; encMode = true;
        return flushVault();
      });
    }
    var vault = JSON.parse(vaultStr);
    var salt = saltB64 || meta.salt;
    return FW.crypto.deriveKey(password, salt).then(function (r) {
      encKey = r.key; metaSalt = r.saltB64;
      return FW.crypto.decrypt(encKey, { iv: vault.iv, ct: vault.ct }).then(function (payload) {
        mem = (payload && payload.data) ? payload.data : {};
        encMode = true;
        return true;
      });
    });
  }

  function lock() {
    encMode = false; encKey = null; mem = {};
    // 仓库仍在 localStorage，下次需重新解锁
  }

  // 修改主密码（需先解锁）
  function changePassword(oldPwd, newPwd) {
    if (!isUnlocked()) return Promise.reject(new Error('请先解锁'));
    return unlock(oldPwd).then(function () {
      return FW.crypto.deriveKey(newPwd, metaSalt).then(function (r) {
        encKey = r.key; metaSalt = r.saltB64;
        setMeta({ enabled: true, salt: metaSalt, v: 1 });
        return flushVault();
      });
    }).catch(function () { return Promise.reject(new Error('原密码错误')); });
  }

  // 关闭加密（解密回明文 localStorage）
  function disableCrypto(password) {
    if (!isUnlocked()) return Promise.reject(new Error('请先解锁'));
    return unlock(password).then(function () {
      Object.keys(mem).forEach(function (k) { lsWrite(k, mem[k]); });
      localStorage.removeItem(LS_PREFIX + VAULT_KEY);
      localStorage.removeItem(LS_PREFIX + META_KEY);
      encMode = false; encKey = null; mem = {};
      return true;
    }).catch(function () { return Promise.reject(new Error('密码错误')); });
  }

  // 快照加解密（供 sync 使用，密钥不外露）
  function encryptSnapshot(obj) {
    if (!encKey) return Promise.resolve(obj);
    return FW.crypto.encrypt(encKey, obj).then(function (env) {
      return { __enc: true, salt: metaSalt, iv: env.iv, ct: env.ct };
    });
  }
  function decryptSnapshot(payload) {
    if (!payload || !payload.__enc) return Promise.resolve(payload);
    if (!encKey) return Promise.reject(new Error('未解锁'));
    return FW.crypto.decrypt(encKey, { iv: payload.iv, ct: payload.ct });
  }

  global.FW = global.FW || {};
  global.FW.db = {
    lsGet: lsGet, lsSet: lsSet, lsRemove: lsRemove,
    getList: getList, saveList: saveList, upsert: upsert, remove: remove, getById: getById,
    uid: uid,
    savePhoto: savePhoto, getPhoto: getPhoto, deletePhoto: deletePhoto, deletePhotos: deletePhotos,
    getAllPhotos: getAllPhotos, putPhotoById: putPhotoById,
    exportAll: exportAll, importAll: importAll,
    // 账本
    getLedgers: getLedgers, setLedgers: setLedgers,
    getCurrentLedger: getCurrentLedger, setCurrentLedger: setCurrentLedger,
    deleteLedgerData: deleteLedgerData, migrate: migrate,
    // 加密
    cryptoEnabled: cryptoEnabled, isUnlocked: isUnlocked,
    enableCrypto: enableCrypto, unlock: unlock, lock: lock,
    changePassword: changePassword, disableCrypto: disableCrypto,
    flushVault: flushVault,
    encryptSnapshot: encryptSnapshot, decryptSnapshot: decryptSnapshot
  };
})(window);
