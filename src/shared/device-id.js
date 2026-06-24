// ════════════════════════════════════════════════════════════
// 即投 — 设备码 device_id（商业化激活用）— 纯新增模块
// 首次用 crypto.randomUUID() 生成，存 chrome.storage.local，之后读回同一个。
// ⚠️ 故意只存 local，绝不写 storage.sync——每个安装实例独立 =
//    保证「同一订单同时只激活一台设备」。换设备/重装后 device_id 变，
//    用户在激活框重贴订单号即可重新激活（旧设备权益失效）。
// 暴露：window.DeviceId.get() → Promise<string>
// ════════════════════════════════════════════════════════════
(function () {
  'use strict';

  var STORAGE_KEY = 'jitou:deviceId';

  function genUuid() {
    try {
      if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    } catch (e) {}
    // 兜底（极旧环境无 randomUUID）：拼一个 UUID v4 形态
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  // async getDeviceId()：读回已存的；没有则生成并落盘 storage.local
  function getDeviceId() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get([STORAGE_KEY], function (r) {
          if (chrome.runtime.lastError) { resolve(genUuid()); return; }
          var existing = r && r[STORAGE_KEY];
          if (existing && typeof existing === 'string') { resolve(existing); return; }
          var id = genUuid();
          var obj = {};
          obj[STORAGE_KEY] = id;
          chrome.storage.local.set(obj, function () { resolve(id); });
        });
      } catch (e) {
        resolve(genUuid());
      }
    });
  }

  var api = { get: getDeviceId, STORAGE_KEY: STORAGE_KEY };

  if (typeof self !== 'undefined') self.DeviceId = api;
  if (typeof window !== 'undefined') window.DeviceId = api;
})();
