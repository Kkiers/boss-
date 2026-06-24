// ════════════════════════════════════════════════════════════
// 即投 — 账户/会员激活（popup 设置抽屉「账户/会员」区）— 纯新增模块
// 职责：① 打开抽屉时 GET /entitlement 渲染权益徽标
//        ② 订单号输入 + 「激活」按钮 → POST /activate
//        ③ 同一个框兼作换机重贴：换设备 device_id 变，重贴订单号即可
//        ④ 无额度拦截页（noQuota）内联激活框复用同一套激活逻辑
// ⚠️ 本轮只做「能激活 + 能看状态」，不做任何功能门禁——
//    激活与否不影响现有任何投递/采集/招呼语功能。
// ════════════════════════════════════════════════════════════
(function () {
  'use strict';

  var BASE = 'https://cloudbase-d7gpznxde64f324c6-1428092559.ap-shanghai.app.tcloudbase.com';

  // ── 设备码：复用 shared/device-id.js ──
  function getDeviceId() {
    try {
      if (typeof DeviceId !== 'undefined' && DeviceId.get) return DeviceId.get();
    } catch (e) {}
    return Promise.resolve('');
  }

  function fmtExpire(iso) {
    if (!iso) return '';
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return String(iso);
      function p(x) { return (x < 10 ? '0' : '') + x; }
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    } catch (e) { return String(iso); }
  }

  // ── 权益徽标渲染 ──
  function renderBadge(state) {
    var badge = document.getElementById('acctBadge');
    if (!badge) return;
    if (state === 'loading') {
      badge.className = 'acct-badge acct-badge-loading';
      badge.textContent = '查询中…';
      return;
    }
    if (state && state.active) {
      badge.className = 'acct-badge acct-badge-active';
      var label = state.plan ? ('已开通 · ' + state.plan) : '已开通';
      if (state.expire_at) label += ' · ' + fmtExpire(state.expire_at) + ' 到期';
      badge.textContent = label;
    } else {
      badge.className = 'acct-badge acct-badge-inactive';
      badge.textContent = '未开通';
    }
  }

  // msgId 默认会员区 acctMsg；noQuota 页传 nqMsg
  function setMsg(text, kind, msgId) {
    var el = document.getElementById(msgId || 'acctMsg');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'acct-msg' + (kind ? ' acct-msg-' + kind : '');
  }

  // ── GET /entitlement?device_id ──
  function refreshEntitlement() {
    renderBadge('loading');
    return getDeviceId().then(function (deviceId) {
      if (!deviceId) { renderBadge({ active: false }); return; }
      return fetch(BASE + '/entitlement?device_id=' + encodeURIComponent(deviceId), {
        method: 'GET',
      }).then(function (resp) {
        return resp.json();
      }).then(function (data) {
        if (data && data.code === 200) renderBadge(data);
        else renderBadge({ active: false });
        // 版本提醒：拿到后端返回的最新版本号才比对；旧后端无此字段则跳过（向后兼容）
        if (data && data.latest_version) checkVersion(data.latest_version);
      }).catch(function () {
        // 网络/查询失败：保守显示未开通，不阻塞任何流程
        // 离线/后端挂时不调 checkVersion，绝不误报落后
        renderBadge({ active: false });
      });
    });
  }

  // ════════════════════════════════════════════════════════════
  // 版本升级提醒
  // 后端 /entitlement 返回 latest_version；与本地 manifest.version 语义化比较。
  // 不持久化「是否落后」（每次开 popup 实时重拉判断）；只持久化用户已忽略的
  // 版本号 dismissedUpdateVersion——出现更高版本时再次提示。
  // 离线/旧后端：refreshEntitlement 不调本函数 → 红点/条零渲染，绝不误报。
  // ════════════════════════════════════════════════════════════

  // 语义化版本比较：a>b 返回 1，a<b 返回 -1，相等 0。
  // 按 . 拆三段 parseInt 逐段比，避免 "1.10" < "1.9" 的字符串陷阱。
  // 缺位/异常补 0（保守，不误报落后）。
  function cmpVersion(a, b) {
    var pa = String(a || '').split('.');
    var pb = String(b || '').split('.');
    for (var i = 0; i < 3; i++) {
      var na = parseInt(pa[i], 10) || 0;
      var nb = parseInt(pb[i], 10) || 0;
      if (na > nb) return 1;
      if (na < nb) return -1;
    }
    return 0;
  }

  function getCurrentVersion() {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest) {
        return chrome.runtime.getManifest().version || '';
      }
    } catch (e) {}
    return '';
  }

  // 「下载并查看更新方法」→ 打开扩展内置引导页 update.html（复用 openLegal 同款方式）。
  // 真正的下载地址占位在 update.js 的 UPDATE_URL（user 自建网页上线后改那一处即可）。
  function openUpdateGuide() {
    var path = 'src/popup/update.html';
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
        var url = chrome.runtime.getURL(path);
        if (chrome.tabs && chrome.tabs.create) { chrome.tabs.create({ url: url }); return; }
        window.open(url, '_blank'); return;
      }
    } catch (e) {}
    try { window.open(path, '_blank'); } catch (e) {}
  }

  // 渲染红点 + 抽屉升级条。latest=后端最新版，cur=本地当前版。
  function renderUpdate(latest, cur) {
    var dot = document.getElementById('updDot');
    var bar = document.getElementById('updBar');
    var title = document.getElementById('updBarTitle');
    var desc = document.getElementById('updBarDesc');
    if (dot) dot.classList.add('show');
    if (bar) bar.classList.add('show');
    if (title) title.textContent = '有新版本 v' + latest;
    if (desc) desc.textContent = '当前 v' + (cur || '?') + ' · 开发者模式需手动更新';
  }

  function checkVersion(latest) {
    var cur = getCurrentVersion();
    if (!cur || cmpVersion(latest, cur) <= 0) return; // 已最新/版本异常：零痕迹
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(['dismissedUpdateVersion'], function (r) {
          var dismissed = r && r.dismissedUpdateVersion;
          // 只静音「已忽略且不低于最新版」的情况；出现更高版本则重现
          if (dismissed && cmpVersion(dismissed, latest) >= 0) return;
          renderUpdate(latest, cur);
        });
        return;
      }
    } catch (e) {}
    // 无 storage 时直接渲染（不影响主流程）
    renderUpdate(latest, cur);
  }

  function dismissUpdate() {
    var title = document.getElementById('updBarTitle');
    // 从标题文案回取当前提示的版本号（"有新版本 vX.X.X"）
    var m = title && title.textContent ? title.textContent.match(/v([\d.]+)/) : null;
    var ver = m ? m[1] : '';
    var dot = document.getElementById('updDot');
    var bar = document.getElementById('updBar');
    if (dot) dot.classList.remove('show');
    if (bar) bar.classList.remove('show');
    if (!ver) return;
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ dismissedUpdateVersion: ver });
      }
    } catch (e) {}
  }

  // ── POST /activate ──
  // 工厂：会员区与 noQuota 页各自的 input/btn/msg id + 成功文案不同，逻辑复用。
  // successText 传则覆盖默认成功文案（noQuota 用「请重新点立即发送」引导重投）。
  function makeActivate(inputId, btnId, msgId, successText) {
    return function () {
      var input = document.getElementById(inputId);
      var btn = document.getElementById(btnId);
      if (!input || !btn) return;
      var orderNo = (input.value || '').trim();
      if (!orderNo) { setMsg('请先粘贴订单号', 'warn', msgId); return; }

      btn.disabled = true;
      var originText = btn.textContent;
      btn.textContent = '激活中…';
      setMsg('', '', msgId);

      getDeviceId().then(function (deviceId) {
        return fetch(BASE + '/activate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ out_trade_no: orderNo, device_id: deviceId }),
        });
      }).then(function (resp) {
        return resp.json();
      }).then(function (data) {
        btn.disabled = false;
        btn.textContent = originText;
        if (data && data.code === 200) {
          if (successText) {
            setMsg(successText, 'ok', msgId);
          } else {
            // 套餐/到期看上方 badge，换机说明看下方常驻 hint，此处不复述
            setMsg('激活成功', 'ok', msgId);
          }
          renderBadge({ active: true, plan: data.plan, expire_at: data.expire_at });
        } else {
          setMsg((data && data.message) ? data.message : '激活失败，请检查订单号', 'warn', msgId);
        }
      }).catch(function () {
        btn.disabled = false;
        btn.textContent = originText;
        setMsg('网络异常，请稍后重试', 'warn', msgId);
      });
    };
  }

  var doActivate = makeActivate('acctOrderInput', 'acctActivateBtn', 'acctMsg', null);
  var doActivateNoQuota = makeActivate('nqOrderInput', 'nqActivateBtn', 'nqMsg', '激活成功，请重新点「立即发送」继续投递。');

  // ── 购买：在新标签打开爱发电商品页 ──
  var BUY_URL_7D = 'https://www.ifdian.net/item/4d5a42a867ae11f1bb3852540025c377';
  var BUY_URL_30D = 'https://www.ifdian.net/item/1261878867b311f1ad105254001e7c00';
  function openBuy(url) {
    try {
      if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.create) {
        chrome.tabs.create({ url: url });
        return;
      }
    } catch (e) {}
    try { window.open(url, '_blank'); } catch (e) {}
  }

  // 暴露购买入口供其他模块复用（如无额度拦截时的内联购买按钮），避免散落 URL/逻辑
  window.JitouBuy = {
    buy7: function () { openBuy(BUY_URL_7D); },
    buy30: function () { openBuy(BUY_URL_30D); },
  };

  // ── 法务文档：在新标签打开帮助与条款页（免责声明 / 退款政策 / FAQ）──
  function openLegal(tab) {
    var path = 'src/popup/legal.html' + (tab ? '?tab=' + tab : '');
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
        var url = chrome.runtime.getURL(path);
        if (chrome.tabs && chrome.tabs.create) { chrome.tabs.create({ url: url }); return; }
        window.open(url, '_blank'); return;
      }
    } catch (e) {}
    try { window.open(path, '_blank'); } catch (e) {}
  }

  function wire() {
    var btn = document.getElementById('acctActivateBtn');
    var input = document.getElementById('acctOrderInput');
    var buy7 = document.getElementById('acctBuy7');
    var buy30 = document.getElementById('acctBuy30');
    if (buy7) buy7.addEventListener('click', function () { openBuy(BUY_URL_7D); });
    if (buy30) buy30.addEventListener('click', function () { openBuy(BUY_URL_30D); });
    // 法务文档链接（帮助与条款）
    var legalLinks = document.querySelectorAll('.legal-link');
    for (var i = 0; i < legalLinks.length; i++) {
      legalLinks[i].addEventListener('click', function (e) {
        e.preventDefault();
        openLegal(this.getAttribute('data-legal'));
      });
    }
    if (btn) btn.addEventListener('click', doActivate);
    if (input) {
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); doActivate(); }
      });
    }

    // ── 无额度拦截页（noQuota）内联激活（购买按钮已由 events-b.js 绑 window.JitouBuy，此处只补激活框）──
    var nqBtn = document.getElementById('nqActivateBtn');
    var nqInput = document.getElementById('nqOrderInput');
    if (nqBtn) nqBtn.addEventListener('click', doActivateNoQuota);
    if (nqInput) {
      nqInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); doActivateNoQuota(); }
      });
    }

    // ── 版本升级条按钮 ──
    var updDl = document.getElementById('updDownloadBtn');
    var updDismiss = document.getElementById('updDismissBtn');
    if (updDl) updDl.addEventListener('click', openUpdateGuide);
    if (updDismiss) updDismiss.addEventListener('click', dismissUpdate);

    // 打开设置抽屉时刷新权益（齿轮按钮触发）
    var gear = document.getElementById('gearBtn');
    if (gear) gear.addEventListener('click', function () { refreshEntitlement(); });
    // 首次也查一次（抽屉默认隐藏，查到的徽标待打开即见）
    refreshEntitlement();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
})();
