// Content Script 入口 — 根据 URL 路由 + 消息监听

// 🔴 发布打包前改为 false：关闭 window.postMessage 测试桥，防同页恶意脚本触发自动投递
const TEST_BRIDGE_ENABLED = false;

// ── 同步诊断：直接写 documentElement.dataset.diagSync ringer（零 await，零 race） ──
// 决策：ErrorLogger.logError 是 async read-modify-write，多个 _dbg 连续调用时后写覆盖前写
// 实测 2026-05-24：click flow 11 个 _dbg 实际只留 5 个，apiCheck/bossInfo/hrExtracted 等中间项被冲掉
// 同步 attribute 写在 isolated world 内单线程同步执行，绝不丢数据；osascript 读 data-diag-sync 即可
function _persistDiag(prefix, info) {
  try {
    var el = document.documentElement;
    if (!el) return;
    var raw = el.getAttribute('data-diag-sync') || '[]';
    var arr;
    try { arr = JSON.parse(raw); } catch (e) { arr = []; }
    if (!Array.isArray(arr)) arr = [];
    arr.push({ t: Date.now(), m: '[' + prefix + '] ' + JSON.stringify(info || {}) });
    if (arr.length > 500) arr = arr.slice(-500);
    el.setAttribute('data-diag-sync', JSON.stringify(arr));
  } catch (e) {}
}

// Self-test 入口：main world (osascript inject) 通过 CustomEvent 跨 world 触发 CS 自己调
// _persistDiag N 次，用于验证「修改后 content.js 已被加载 + 同步诊断写无丢失」。
// 用法：document.dispatchEvent(new CustomEvent('ZITOU_DIAG_TEST', {detail:{n:100}}))
try {
  document.addEventListener('ZITOU_DIAG_TEST', function(e) {
    var n = (e && e.detail && e.detail.n) || 100;
    for (var i = 0; i < n; i++) _persistDiag('test:' + i, { i: i, ts: Date.now() });
  });
} catch (_) {}

// ── #39 导航中止哨兵 ──
// 真机坐实：点「立即沟通」触发 BOSS 整页跳转后，pagehide 已触发但文档拆毁延迟数秒，
// handleBatchExtract 若继续跑会在拆毁中 DOM 上 findCard 全败 → 假失败记账 + 提前发
// EXTRACT_COMPLETE → SW stage1 假结算。哨兵置位后批处理循环立即中止，交 SW 恢复环重发。
// （575 行附近 DiagLogger 的 pagehide 监听在守卫块内不可共用，此处独立注册。）
var _navAborting = false;
try { window.addEventListener('pagehide', function() { _navAborting = true; }); } catch (_) {}

// ── JobClicker 内联到 content.js（manifest 中文件顺序有时不可靠）──
async function waitForElHidden(selectors, timeoutMs) {
  timeoutMs = timeoutMs || 5000;
  var start = Date.now();
  while (Date.now() - start < timeoutMs) {
    var visible = false;
    for (var si = 0; si < (Array.isArray(selectors) ? selectors : [selectors]).length; si++) {
      var el = document.querySelector((Array.isArray(selectors) ? selectors : [selectors])[si]);
      if (el && el.offsetParent !== null) { visible = true; break; }
    }
    if (!visible) return true;
    await new Promise(function(r) { setTimeout(r, 200); });
  }
  return false;
}

function sleep(ms) {
  return new Promise(function(r) { setTimeout(r, ms); });
}

// ── HR 活跃解析 + 阈值判定（Item2，send 期逐岗判定）──
function parseHrActivity(onlineText, activeText){
  if(onlineText && /在线/.test(onlineText)) return {online:true, activeDays:0, desc:'在线'};
  var t=(activeText||'').trim();
  if(!t) return {online:false, activeDays:null, desc:''};
  if(/刚刚|今日|今天/.test(t)) return {online:false, activeDays:1, desc:t};
  var dm=t.match(/(\d+)\s*日内/); if(dm) return {online:false, activeDays:parseInt(dm[1]), desc:t};
  if(/本周/.test(t)) return {online:false, activeDays:7, desc:t};
  var wm=t.match(/(\d+)\s*周内/); if(wm) return {online:false, activeDays:parseInt(wm[1])*7, desc:t};
  if(/本月/.test(t)) return {online:false, activeDays:30, desc:t};
  var mm=t.match(/(\d+)\s*月内/); if(mm) return {online:false, activeDays:parseInt(mm[1])*30, desc:t};
  if(/半年内|近半年/.test(t)) return {online:false, activeDays:180, desc:t};
  if(/半年前|年前|更早/.test(t)) return {online:false, activeDays:999, desc:t};
  return {online:false, activeDays:null, desc:t};
}
// fail-open：未知/读不到→放行（避免读取毛刺误杀）；online 永远通过
function passActivityFilter(filter, act){
  if(!filter || filter==='不限') return true;
  if(filter==='只投在线') return act.online===true;
  var maxMap={'3日内活跃':3,'本周内活跃':7,'本月内活跃':30};
  var max=maxMap[filter]; if(max==null) return true;
  if(act.online) return true;
  if(act.activeDays==null) return true;
  return act.activeDays<=max;
}

var JobClicker = {
  findCardByLink: function(jobLink) {
    var found = queryAllJobCards(document);
    var cards = found.nodes;
    var jobId = (jobLink || '').split('/').pop();
    if (jobId) jobId = jobId.replace('.html', '');
    if (!jobId) return null;
    for (var c = 0; c < cards.length; c++) {
      var links = cards[c].querySelectorAll('a');
      for (var l = 0; l < links.length; l++) {
        if ((links[l].getAttribute('href') || '').includes(jobId)) return cards[c];
      }
    }
    return null;
  },
  _companyMatches: function(display, collected) {
    var a = (display || '').trim();
    var b = (collected || '').trim();
    if (!a || !b) return false;
    return a.indexOf(b) >= 0 || b.indexOf(a) >= 0;
  },
  findCardByText: function(positionName, companyName) {
    var found = queryAllJobCards(document);
    var cards = found.nodes;
    for (var c = 0; c < cards.length; c++) {
      var nameEl = cards[c].querySelector(SELECTORS.jobs.jobName);
      var companyEl = cards[c].querySelector(SELECTORS.jobs.company);
      if (!nameEl || !companyEl) continue;
      if (nameEl.textContent.trim() === positionName && this._companyMatches(companyEl.textContent.trim(), companyName)) return cards[c];
    }
    return null;
  },
  findCardByPositionName: function(positionName) {
    if (!positionName) return null;
    var target = String(positionName).trim();
    if (!target) return null;
    var found = queryAllJobCards(document);
    var cards = found.nodes;
    var hits = [];
    for (var c = 0; c < cards.length; c++) {
      var nameEl = cards[c].querySelector(SELECTORS.jobs.jobName);
      if (!nameEl) continue;
      if (nameEl.textContent.trim() === target) hits.push(cards[c]);
    }
    return hits.length === 1 ? hits[0] : null;
  },
  scrollAndFindCard: async function(jobLink, positionName, companyName, fastMode, platformGreeting) {
    var card = this.findCardByLink(jobLink);
    if (card) return card;
    if (positionName && companyName) {
      card = this.findCardByText(positionName, companyName);
      if (card) return card;
    }
    if (positionName) {
      card = this.findCardByPositionName(positionName);
      if (card) return card;
    }
    var scrollMs = platformGreeting ? 1000 : (fastMode ? 450 : 800);
    var maxRounds = platformGreeting ? 28 : (fastMode ? 8 : 16);
    var prevCount = queryAllJobCards(document).nodes.length;
    for (var i = 0; i < maxRounds; i++) {
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(scrollMs);
      card = this.findCardByLink(jobLink);
      if (card) { window.scrollTo(0, 0); return card; }
      if (positionName && companyName) {
        card = this.findCardByText(positionName, companyName);
        if (card) { window.scrollTo(0, 0); return card; }
      }
      if (positionName) {
        card = this.findCardByPositionName(positionName);
        if (card) { window.scrollTo(0, 0); return card; }
      }
      var count = queryAllJobCards(document).nodes.length;
      if (count <= prevCount + 1) break;
      prevCount = count;
    }
    window.scrollTo(0, 0);
    return null;
  },

  // v5: 只点"立即沟通"，提取HR信息，关闭弹窗，不导航页面
  // progressCtx（可选，#39 阶段1跳转恢复）：{ index, jobId, jobName }，仅 handleBatchExtract 传入，
  // 用于点「立即沟通」前上报 beforeClick 进度（点击可能触发整页跳转摧毁本 CS，SW 据此恢复断头批次）。
  clickImmediateChat: async function(jobLink, positionName, companyName, hrActiveFilter, progressCtx) {
    // 同步诊断 _persistDiag 是真相源（dataset 写无 race）；ErrorLogger 保留双写仅作 SW 侧回看。
    // 2026-05-24 修复：ErrorLogger.logError 多写 race 导致中间项丢失 → _persistDiag 同步直写 dataset 永不丢。
    var _dbg = function(s, i) {
      _persistDiag(s, i);
      try { chrome.runtime.sendMessage({ type: 'CS_DBG', stage: s, info: i || {} }).catch(function(){}); } catch (_) {}
      try {
        if (typeof ErrorLogger !== 'undefined' && ErrorLogger.logError) {
          ErrorLogger.logError('[' + s + '] ' + JSON.stringify(i || {}), '', 'click.diag');
        }
      } catch (_) {}
    };
    _dbg('click:start', { jobLink: jobLink, positionName: positionName });
    // 硬中止：每个 await 边界前后检查 stopped，停了立即 bail（不点卡片/不点立即沟通/不开弹窗）
    var _isStopped = function() { return typeof JobCollector !== 'undefined' && JobCollector.stopped; };
    if (_isStopped()) { _dbg('click:bail', { at: 'start' }); return { success: false, stopped: true }; }
    var platformGreeting = !!(progressCtx && progressCtx.platformGreeting);
    // 快速投递时是否同时发送简历图片：true=点「继续沟通」进聊天页发图；false=点「留在此页」
    var sendResumeImage = !!(progressCtx && progressCtx.sendResumeImage);
    // 平台快速投递禁用 fastMode：350ms 不足以渲染 .job-boss-info → 全员「无法提取HR信息」
    var fastMode = !!(progressCtx && progressCtx.fastMode && !platformGreeting);
    // 对齐 jitou：先同步 findCard，找不到再滚动加载
    var card = null;
    if (platformGreeting) {
      // 方案 B：与 jitou 一致，warm tab 上仅同步 find，不滚动（滚动在冷 DOM 上易早停且慢）
      if (jobLink) card = this.findCardByLink(jobLink);
      if (!card && positionName && companyName) card = this.findCardByText(positionName, companyName);
    } else {
      if (jobLink) card = this.findCardByLink(jobLink);
      if (!card && positionName && companyName) card = this.findCardByText(positionName, companyName);
      if (!card) card = await this.scrollAndFindCard(jobLink, positionName, companyName, fastMode, false);
    }
    _dbg('click:findCard', { found: !!card, jobLink: jobLink, positionName: positionName, fastMode: fastMode });
    if (!card) return { success: false, error: '未找到岗位卡片: ' + (positionName || jobLink) };
    card.scrollIntoView({ block: 'center', behavior: 'instant' });
    await sleep(platformGreeting ? 200 : (fastMode ? 100 : 200));
    if (_isStopped()) { _dbg('click:bail', { at: 'beforeCardClick' }); return { success: false, stopped: true }; }
    _dbg('click:beforeCardClick', { urlBefore: location.href });
    card.click();
    await sleep(platformGreeting ? 800 : (fastMode ? 350 : 800));
    if (_isStopped()) { _dbg('click:bail', { at: 'afterCardClick' }); return { success: false, stopped: true }; }
    _dbg('click:afterCardClick', { urlAfter: location.href });
    if (typeof detectCaptcha === 'function' && detectCaptcha().detected) {
      _dbg('click:captcha', {});
      return { success: false, error: 'captcha detected after clicking card' };
    }

    // 提取HR信息（详情面板 .job-boss-info）—— 等平台招呼弹窗场景需等面板渲染
    var bossInfo = await waitForElement('.job-boss-info', platformGreeting ? 8000 : (fastMode ? 4000 : 8000));
    if (!bossInfo) bossInfo = document.querySelector('.job-boss-info');
    _dbg('click:bossInfo', { found: !!bossInfo });
    var hrName = '';
    var hrCompany = '';
    if (bossInfo) {
      var nameH2 = bossInfo.querySelector('h2.name, .name');
      if (nameH2) {
        for (var ci = 0; ci < nameH2.childNodes.length; ci++) {
          var node = nameH2.childNodes[ci];
          if (node.nodeType === 3) { hrName += node.nodeValue; }
          else if (node.nodeType === 1 && node.tagName !== 'I') break;
        }
        hrName = hrName.trim();
      }
      var attrEl = bossInfo.querySelector('.boss-info-attr');
      if (attrEl) {
        var attrText = attrEl.textContent.trim();
        hrCompany = (attrText.split(' · ')[0] || '').trim();
      }
    }
    _dbg('click:hrExtracted', { hrName: hrName, hrCompany: hrCompany });
    if (!hrName) return { success: false, error: '无法提取HR信息' };

    // HR 活跃筛选：复用已打开的 .job-boss-info 面板，零额外请求；不达标则跳过、不发起联系
    var _act = parseHrActivity(
      (bossInfo.querySelector('.boss-online-tag') || {}).textContent || '',
      (bossInfo.querySelector('.boss-active-time') || {}).textContent || ''
    );
    if (!passActivityFilter(hrActiveFilter, _act)) {
      _dbg('click:activitySkip', { filter: hrActiveFilter, desc: _act.desc });
      return { success: false, skipped: true, skipReason: 'HR活跃不符', activeDesc: _act.desc };
    }

    // 点击"立即沟通"
    if (_isStopped()) { _dbg('click:bail', { at: 'beforeWaitChatBtn' }); return { success: false, stopped: true }; }
    _dbg('click:waitChatBtn', {});
    var chatBtn = await waitForElement(SELECTORS.jobs.immediateChatBtn, 5000);
    _dbg('click:chatBtnFound', { found: !!chatBtn });
    if (!chatBtn) return { success: false, error: '未找到立即沟通按钮' };
    // 关键：等到按钮后若已停止，绝不点击「立即沟通」、不发起联系
    if (_isStopped()) { _dbg('click:bail', { at: 'beforeChatClick' }); return { success: false, stopped: true }; }

    // #39 预判：按钮文本含「继续沟通」= 该 HR 此前已沟通过，点了会整页跳转消息页摧毁 CS → 不点，标记 alreadyChatted
    var chatBtnTxt = (chatBtn.textContent || '').trim();
    if (chatBtnTxt.indexOf('继续沟通') >= 0) {
      _dbg('click:alreadyChatted', { hrName: hrName, hrCompany: hrCompany, btnText: chatBtnTxt });
      try { if (typeof DiagLogger !== 'undefined') DiagLogger.info('cs.flow', '检测到继续沟通按钮，跳过点击 标记alreadyChatted hr=' + hrName + ' btnText=' + chatBtnTxt); } catch (_) {}
      return { success: true, hrName: hrName, hrCompany: hrCompany, alreadyChatted: true };
    }

    // #39 阶段1跳转恢复：即将点「立即沟通」——同 HR 新岗位场景 BOSS 会整页跳转 /web/geek/chat
    // 摧毁本 CS，故点前 fire-and-forget 上报 beforeClick（带已提取的 HR 信息），绝不阻塞流程。
    if (progressCtx) {
      try {
        chrome.runtime.sendMessage({
          type: MSG.EXTRACT_PROGRESS,
          index: progressCtx.index,
          jobId: progressCtx.jobId,
          jobName: progressCtx.jobName,
          hrName: hrName,
          hrCompany: hrCompany,
          stage: 'beforeClick',
        }).catch(function(){});
      } catch (_) {}
    }

    // 诊断：click 前后 diff performance resource entries，看 BOSS conv create wapi 是否真被调用
    // 2026-05-25 实测根因：单独 chatBtn.click() 只触发 dapCommon 上报，不触发 friend/add.json
    // → BOSS Vue add friend handler 监 mousedown+mouseup+click 完整序列；单 click 事件不足
    // → 改为完整鼠标序列（osascript inject 3 连点实测 3/3 add.json 全发出）
    var _apiBefore = (performance.getEntriesByType('resource') || []).length;
    var _mOpts = { bubbles: true, cancelable: true, view: window, button: 0 };
    chatBtn.dispatchEvent(new MouseEvent('mousedown', _mOpts));
    chatBtn.dispatchEvent(new MouseEvent('mouseup', _mOpts));
    chatBtn.dispatchEvent(new MouseEvent('click', _mOpts));
    await sleep(platformGreeting ? 1200 : (fastMode ? 400 : 800));
    try {
      var _all = performance.getEntriesByType('resource') || [];
      var _newOnes = _all.slice(_apiBefore);
      var _wapiNew = _newOnes.filter(function(e) { return /wapi/.test(e.name || ''); }).map(function(e) {
        return {
          url: (e.name || '').replace('https://www.zhipin.com', '').substring(0, 150),
          dur: Math.round(e.duration || 0),
          size: e.transferSize || 0,
        };
      }).slice(0, 10);
      _persistDiag('click:apiCheck', {
        hrName: hrName,
        hrCompany: hrCompany,
        wapiNewCount: _wapiNew.length,
        wapiNew: _wapiNew,
      });
      if (typeof ErrorLogger !== 'undefined' && ErrorLogger.logError) {
        ErrorLogger.logError('[click:apiCheck] ' + JSON.stringify({
          hrName: hrName,
          hrCompany: hrCompany,
          wapiNewCount: _wapiNew.length,
          wapiNew: _wapiNew,
        }), '', 'click.diag');
      }
    } catch (_) {}

    // 关闭打招呼弹窗（可能是普通弹窗，也可能是同HR多岗位弹窗）
    if (_isStopped()) { _dbg('click:bail', { at: 'beforeCloseDialog' }); return { success: false, stopped: true }; }
    _dbg('click:beforeCloseDialog', {});
    await this._closeGreetDialog(platformGreeting, sendResumeImage);
    _dbg('click:afterCloseDialog', {});

    return { success: true, hrName: hrName, hrCompany: hrCompany };
  },

  // v6 stage1 详情页路径：不依赖搜索页 DOM 卡片，直接在当前 /job_detail/ 页提取 HR 并点立即沟通
  extractOnDetailPage: async function(jobLink, positionName, companyName, hrActiveFilter, progressCtx) {
    var _dbg = function(s, i) {
      _persistDiag(s, i);
      try { chrome.runtime.sendMessage({ type: 'CS_DBG', stage: s, info: i || {} }).catch(function(){}); } catch (_) {}
    };
    _dbg('detailExtract:start', { jobLink: jobLink, positionName: positionName, url: location.href });
    var _isStopped = function() { return typeof JobCollector !== 'undefined' && JobCollector.stopped; };
    if (_isStopped()) return { success: false, stopped: true };
    var fastMode = !!(progressCtx && progressCtx.fastMode);
    var platformGreeting = !!(progressCtx && progressCtx.platformGreeting);
    var sendResumeImage = !!(progressCtx && progressCtx.sendResumeImage);
    if (location.pathname.indexOf('/job_detail/') < 0) {
      return { success: false, error: '不在岗位详情页: ' + location.pathname };
    }
    var bossInfo = await waitForElement('.job-boss-info', fastMode ? 8000 : 12000);
    if (!bossInfo) bossInfo = document.querySelector('.job-boss-info');
    _dbg('detailExtract:bossInfo', { found: !!bossInfo });
    var hrName = '';
    var hrCompany = '';
    if (bossInfo) {
      var nameH2 = bossInfo.querySelector('h2.name, .name');
      if (nameH2) {
        for (var ci = 0; ci < nameH2.childNodes.length; ci++) {
          var node = nameH2.childNodes[ci];
          if (node.nodeType === 3) { hrName += node.nodeValue; }
          else if (node.nodeType === 1 && node.tagName !== 'I') break;
        }
        hrName = hrName.trim();
      }
      var attrEl = bossInfo.querySelector('.boss-info-attr');
      if (attrEl) {
        var attrText = attrEl.textContent.trim();
        hrCompany = (attrText.split(' · ')[0] || '').trim();
      }
    }
    _dbg('detailExtract:hrExtracted', { hrName: hrName, hrCompany: hrCompany });
    if (!hrName) return { success: false, error: '详情页无法提取HR信息' };
    var _act = parseHrActivity(
      (bossInfo.querySelector('.boss-online-tag') || {}).textContent || '',
      (bossInfo.querySelector('.boss-active-time') || {}).textContent || ''
    );
    if (!passActivityFilter(hrActiveFilter, _act)) {
      _dbg('detailExtract:activitySkip', { filter: hrActiveFilter, desc: _act.desc });
      return { success: false, skipped: true, skipReason: 'HR活跃不符', activeDesc: _act.desc };
    }
    if (_isStopped()) return { success: false, stopped: true };
    var chatBtn = await waitForElement(SELECTORS.jobs.immediateChatBtn, 5000);
    if (!chatBtn) chatBtn = document.querySelector(SELECTORS.jobs.immediateChatBtn);
    _dbg('detailExtract:chatBtnFound', { found: !!chatBtn });
    if (!chatBtn) return { success: false, error: '详情页未找到立即沟通按钮' };
    if (_isStopped()) return { success: false, stopped: true };
    var chatBtnTxt = (chatBtn.textContent || '').trim();
    if (chatBtnTxt.indexOf('继续沟通') >= 0) {
      _dbg('detailExtract:alreadyChatted', { hrName: hrName, btnText: chatBtnTxt });
      return { success: true, hrName: hrName, hrCompany: hrCompany, alreadyChatted: true };
    }
    if (progressCtx) {
      try {
        chrome.runtime.sendMessage({
          type: MSG.EXTRACT_PROGRESS,
          index: progressCtx.index || 0,
          jobId: progressCtx.jobId,
          jobName: progressCtx.jobName,
          hrName: hrName,
          hrCompany: hrCompany,
          stage: 'beforeClick',
        }).catch(function(){});
      } catch (_) {}
    }
    var _mOpts = { bubbles: true, cancelable: true, view: window, button: 0 };
    chatBtn.dispatchEvent(new MouseEvent('mousedown', _mOpts));
    chatBtn.dispatchEvent(new MouseEvent('mouseup', _mOpts));
    chatBtn.dispatchEvent(new MouseEvent('click', _mOpts));
    await sleep(platformGreeting ? 1200 : (fastMode ? 400 : 800));
    if (_isStopped()) return { success: false, stopped: true };
    await this._closeGreetDialog(platformGreeting, sendResumeImage);
    return { success: true, hrName: hrName, hrCompany: hrCompany };
  },

  _closeGreetDialog: async function(platformGreeting, sendResumeImage) {
    await closeBlockingDialogs(platformGreeting ? 6 : 3, { waitGreetBoss: !!platformGreeting, sendResumeImage: !!sendResumeImage });
  },
};

// ── 关闭挡路弹窗（打招呼/同HR多岗位/沟通次数上限/投递成功率较低/温馨提示 等）──
// 两层策略：先 `.icon-close.click()`，剩余仍可见的弹窗 fallback `.remove()`。
// 决策依据（2026-05-25 实测：osascript inject 4 连点对照矩阵）：
//   - `.remove()` 单用：1/4 add（第 1 个 add 后弹「招呼输入框」被 remove → Vue 状态保留
//     「该 HR 正在打招呼」→ 后续岗位 card.click 切换后 chatBtn 直接 disabled，add API 不发）
//   - `.icon-close.click()` 单用：3/3 add（走 Vue close handler 正常释放 BOSS 内部业务状态）
//   - chat-block-dialog 无 .icon-close → 该弹窗为业务异常（限速/超额），无 add 流程不会污染状态
//     用 fallback .remove() 兜底安全（不触发 sure-btn 跳转副作用）
// 旧版「.remove() 零副作用」结论是单弹窗实测，没覆盖「连续多岗位 add」场景下的 Vue 状态污染。
// 陷阱 #39（2026-06-12）：「继续沟通新职位」二次确认弹窗（同 HR 此前已沟通过其他岗位）
// 只关/删会让该岗位进不了可发送状态 → 卡住。产品决策（user 拍板）：点「继续沟通」确认继续投。
// Step 0 判定（2026-06-12 真机抓 DOM 定死）：弹窗本体 .change-job-tip-dialog，确认钮
// span.boss-dialog__button（非 .button-outline）且文本 trim 后精确等于「沟通新职位」才点。
// 点过确认的弹窗打 data-zitou-sure-clicked 标记，按已处理对待，不再进 Step 1/2（绝不 remove 污染 Vue state）。
// #39 诊断埋点：未识别弹窗 DOM 快照去重表（每个 className 每次页面加载只快照一次）
var _snapDone = {};
function _isGreetBossDialogEl(el) {
  try {
    if (!el) return false;
    if (el.classList && el.classList.contains('greet-boss-dialog')) return true;
    return !!(el.closest && el.closest('.greet-boss-dialog'));
  } catch (e) { return false; }
}
function _tryClickGreetBossContinueDialog() {
  var confirmed = 0;
  var dlgs = document.querySelectorAll('.greet-boss-dialog, .dialog-wrap .greet-boss-container');
  for (var d = 0; d < dlgs.length; d++) {
    var dlg = dlgs[d].classList.contains('greet-boss-dialog')
      ? dlgs[d]
      : (dlgs[d].closest('.greet-boss-dialog') || dlgs[d].closest('.dialog-wrap'));
    if (!dlg || dlg.offsetHeight <= 0) continue;
    try {
      if (dlg.closest && dlg.closest('[data-zitou-sure-clicked]')) continue;
    } catch (e) { continue; }
    var sureCandidates = dlg.querySelectorAll('.greet-boss-footer a.sure-btn, a.default-btn.sure-btn, a.sure-btn, .sure-btn');
    for (var sb = 0; sb < sureCandidates.length; sb++) {
      var gbtn = sureCandidates[sb];
      if (gbtn.offsetHeight <= 0) continue;
      var gtxt = (gbtn.textContent || '').trim();
      if (gtxt.indexOf('继续沟通') < 0) continue;
      try {
        var gmark = dlg.closest('.dialog-wrap') || dlg;
        gmark.setAttribute('data-zitou-sure-clicked', '1');
        gbtn.click();
        confirmed++;
        _persistDiag('dialog:greetBossContinue', { text: (dlg.textContent || '').trim().substring(0, 60) });
        try { if (typeof DiagLogger !== 'undefined') DiagLogger.info('cs.flow', '命中自动打招呼预览弹窗，已点「继续沟通」'); } catch (_) {}
      } catch (e) {}
      break;
    }
  }
  return confirmed;
}
// 搜索模式「留在此页」：与浏览模式一致，弹窗出现后点「留在此页」而非「继续沟通」
// 仅当用户未勾选「同时发送简历图片」时走此路径——BOSS 平台招呼语已发出，留在搜索页继续下一个
function _tryClickGreetBossStayOnPage() {
  var clicked = 0;
  var dlgs = document.querySelectorAll('.greet-boss-dialog, .dialog-wrap .greet-boss-container');
  for (var d = 0; d < dlgs.length; d++) {
    var dlg = dlgs[d].classList.contains('greet-boss-dialog')
      ? dlgs[d]
      : (dlgs[d].closest('.greet-boss-dialog') || dlgs[d].closest('.dialog-wrap'));
    if (!dlg || dlg.offsetHeight <= 0) continue;
    try {
      if (dlg.closest && dlg.closest('[data-zitou-sure-clicked]')) continue;
    } catch (e) { continue; }
    // 找「留在此页」按钮（cancel-btn，与浏览模式的 _clickStayOnPageInDialog 同款选择器）
    var cancelCandidates = dlg.querySelectorAll('.greet-boss-footer a.cancel-btn, a.cancel-btn, .default-btn.cancel-btn');
    for (var cb = 0; cb < cancelCandidates.length; cb++) {
      var cbtn = cancelCandidates[cb];
      if (cbtn.offsetHeight <= 0) continue;
      var ctxt = (cbtn.textContent || '').trim();
      if (ctxt.indexOf('留在此页') < 0) continue;
      try {
        var gmark = dlg.closest('.dialog-wrap') || dlg;
        gmark.setAttribute('data-zitou-sure-clicked', '1');
        cbtn.click();
        clicked++;
        _persistDiag('dialog:greetBossStayOnPage', { text: (dlg.textContent || '').trim().substring(0, 60) });
        try { if (typeof DiagLogger !== 'undefined') DiagLogger.info('cs.flow', '命中自动打招呼预览弹窗，已点「留在此页」（未勾选发送简历图片）'); } catch (_) {}
      } catch (e) {}
      break;
    }
  }
  return clicked;
}
async function closeBlockingDialogs(maxRounds, opts) {
  maxRounds = maxRounds || 3;
  opts = opts || {};
  if (opts.waitGreetBoss) {
    var greetDeadline = Date.now() + 3500;
    while (Date.now() < greetDeadline) {
      var greetDlg = document.querySelector('.greet-boss-dialog');
      if (greetDlg && greetDlg.offsetHeight > 0) break;
      await sleep(200);
    }
  }
  // 已点过确认的弹窗（含其内部嵌套节点）按已处理对待
  var _isConfirmed = function(el) {
    try { return !!(el.closest && el.closest('[data-zitou-sure-clicked]')); } catch (e) { return false; }
  };
  // #39 诊断埋点：btn-sure 弹窗出现但没点确认时记原因（textMismatch 时 btnText 是关键证据）。
  // 每个弹窗节点只记一次（防多轮重复刷屏）。纯留痕，不改任何流程。
  var _diagSureSkip = function(dlg, reason, btnTxt) {
    try {
      if (dlg.getAttribute('data-zitou-sure-skip-logged')) return;
      dlg.setAttribute('data-zitou-sure-skip-logged', '1');
      var snippet = (dlg.textContent || '').trim().substring(0, 80);
      var msg = '[#39] btn-sure 弹窗未点确认 reason=' + reason + ' btnText=「' + btnTxt + '」 dlgCls=' + dlg.className + ' dlgText=' + snippet;
      try { if (typeof DiagLogger !== 'undefined') DiagLogger.warn('cs.flow', msg); } catch (_) {}
      _persistDiag('dialog:sureSkip', { reason: reason, btnText: btnTxt, text: snippet, cls: dlg.className });
      console.warn('[即投] closeBlockingDialogs: ' + msg);
    } catch (e) {}
  };
  for (var round = 0; round < maxRounds; round++) {
    await new Promise(function(r) { setTimeout(r, 400); });
    var confirmed = 0;

    // Step 0a: BOSS 自动打招呼预览弹窗（平台快速投递）
    //  sendResumeImage=true  → 点「继续沟通」进聊天页发简历图（原有行为）
    //  sendResumeImage=false → 点「留在此页」留在搜索页（与浏览模式一致）
    if (opts.sendResumeImage) {
      confirmed += _tryClickGreetBossContinueDialog();
    } else {
      confirmed += _tryClickGreetBossStayOnPage();
    }
    if (confirmed > 0) {
      await sleep(500);
    }

    // Step 0: 「继续沟通新职位」确认弹窗 → 点 span.boss-dialog__button 本身（最内层，陷阱 #14：click 只向上冒泡）
    // 2026-06-12 真机抓 DOM 定死：弹窗本体 .change-job-tip-dialog；确认钮 span.boss-dialog__button
    // （非 outline），文本 trim 后 =「沟通新职位」；取消钮带 .button-outline。span.btn-sure 不存在。
    var step0Dialogs = document.querySelectorAll('[class*="dialog"]');
    for (var s0 = 0; s0 < step0Dialogs.length; s0++) {
      var dlg = step0Dialogs[s0];
      if (dlg.offsetHeight <= 0 || _isConfirmed(dlg)) continue;
      var target = dlg.classList.contains('change-job-tip-dialog') ? dlg : dlg.querySelector('.change-job-tip-dialog');
      if (!target) {
        // 结构漂移监测：弹窗文案像「沟通新职位」确认框却找不到 .change-job-tip-dialog → 留痕（难复现，没痕迹测试白跑）
        var dlgTxt0 = (dlg.textContent || '').trim();
        if (dlgTxt0.indexOf('沟通新职位') >= 0 || dlgTxt0.indexOf('新一轮沟通') >= 0) {
          _diagSureSkip(dlg, 'noConfirmDialog', '');
        }
        continue;
      }
      var sureBtn = target.querySelector('span.boss-dialog__button:not(.button-outline)');
      if (!sureBtn) { _diagSureSkip(dlg, 'noConfirmDialog', ''); continue; }
      var sureBtnTxt = (sureBtn.textContent || '').trim();
      if (sureBtn.offsetHeight <= 0) { _diagSureSkip(dlg, 'btnHidden', sureBtnTxt); continue; }
      if ((sureBtn.className || '').indexOf('disabled') >= 0) { _diagSureSkip(dlg, 'btnDisabled', sureBtnTxt); continue; }
      // 按钮文本精确匹配（真机实测定死：「沟通新职位」），别的弹窗绝不误点
      if (sureBtnTxt !== '沟通新职位') { _diagSureSkip(dlg, 'textMismatch', sureBtnTxt); continue; }
      var dlgText = (dlg.textContent || '').trim();
      var dlgSnippet = dlgText.substring(0, 50);
      try {
        // 标记打在根容器 .dialog-wrap（本体/icon-close 都是其后代）→ Step 1 绝不点其 icon-close、Step 2 绝不 remove
        var markRoot = target.closest('.dialog-wrap') || dlg;
        markRoot.setAttribute('data-zitou-sure-clicked', '1'); // 先标记防多轮重复点
        sureBtn.click();
        confirmed++;
        _persistDiag('dialog:continueChatConfirm', { text: dlgSnippet, cls: dlg.className });
        try { if (typeof DiagLogger !== 'undefined') DiagLogger.info('cs.flow', '命中「继续沟通新职位」确认弹窗，已点 btn-sure 继续投递。文案=' + dlgSnippet); } catch (_) {}
        try {
          if (typeof ErrorLogger !== 'undefined' && ErrorLogger.logError) {
            ErrorLogger.logError('[dialog:continueChatConfirm] ' + dlgSnippet, '', 'closeBlockingDialogs');
          }
        } catch (_) {}
        console.log('[即投] closeBlockingDialogs: 命中继续沟通确认弹窗，已点 btn-sure。text=' + dlgSnippet);
      } catch (e) {}
    }
    if (confirmed > 0) {
      await new Promise(function(r) { setTimeout(r, 400); }); // 等 Vue handlerConfirm 处理
      // #39 诊断埋点：点完确认后弹窗是否真关掉（仍可见 = handlerConfirm 没生效，必须留痕）
      try {
        var afterNodes = document.querySelectorAll('[data-zitou-sure-clicked]');
        var stillVis = 0;
        for (var a0 = 0; a0 < afterNodes.length; a0++) {
          if (afterNodes[a0].offsetHeight > 0) {
            stillVis++;
            var aTxt = (afterNodes[a0].textContent || '').trim().substring(0, 80);
            try { if (typeof DiagLogger !== 'undefined') DiagLogger.warn('cs.flow', '[#39] 点了 btn-sure 但 400ms 后弹窗仍可见 dlgText=' + aTxt); } catch (_) {}
            _persistDiag('dialog:sureClickedStillOpen', { text: aTxt });
          }
        }
        if (stillVis === 0) {
          try { if (typeof DiagLogger !== 'undefined') DiagLogger.info('cs.flow', '[#39] btn-sure 点击后确认弹窗已关闭（共 ' + confirmed + ' 个）'); } catch (_) {}
        }
      } catch (e) {}
    }

    // Step 1: 优先 .icon-close.click() 走 Vue close handler（释放 BOSS 业务状态）
    var closers = document.querySelectorAll('.icon-close');
    var clicked = 0;
    for (var ci = 0; ci < closers.length; ci++) {
      if (_isGreetBossDialogEl(closers[ci])) continue;
      if (closers[ci].offsetHeight > 0 && !_isConfirmed(closers[ci])) {
        try { closers[ci].click(); clicked++; } catch (e) {}
      }
    }
    await new Promise(function(r) { setTimeout(r, 300); });

    // Step 2: 仍可见的弹窗（如 chat-block-dialog 无 .icon-close）→ fallback .remove()
    var dialogs = document.querySelectorAll('[class*="dialog"]');
    var removed = 0;
    for (var i = 0; i < dialogs.length; i++) {
      if (dialogs[i].offsetHeight <= 0 || _isConfirmed(dialogs[i])) continue;
      if (_isGreetBossDialogEl(dialogs[i])) {
        confirmed += _tryClickGreetBossContinueDialog();
        continue;
      }
      // #39 诊断埋点：remove 前快照未识别弹窗 DOM（每 className 只快照一次），纯留痕不影响 remove
        try {
          var snapCls = dialogs[i].className;
          if (!_snapDone[snapCls]) {
            _snapDone[snapCls] = true;
            var snapHtml = dialogs[i].outerHTML || '';
            var snapRawLen = snapHtml.length;
            if (snapHtml.length > 2400) snapHtml = snapHtml.substring(0, 2400);
            try {
              if (typeof DiagLogger !== 'undefined') {
                var snapTotal = Math.ceil(snapHtml.length / 260);
                DiagLogger.warn('cs.flow', '[#39] 未识别弹窗即将被remove，DOM快照如下 cls=' + snapCls);
                for (var sk = 0; sk < snapTotal; sk++) {
                  DiagLogger.warn('cs.flow', '[#39][snap ' + (sk + 1) + '/' + snapTotal + '] ' + snapHtml.substring(sk * 260, (sk + 1) * 260));
                }
              }
            } catch (_) {}
            _persistDiag('dialog:removeSnapshot', { cls: snapCls, len: snapRawLen });
          }
        } catch (e) {}
        try { dialogs[i].remove(); removed++; } catch (e) {}
    }
    if (confirmed > 0 || clicked > 0 || removed > 0) {
      console.log('[即投] closeBlockingDialogs: round=' + (round + 1) + ' sureConfirmed=' + confirmed + ' iconClicked=' + clicked + ' fallbackRemoved=' + removed);
      try { if (typeof DiagLogger !== 'undefined') DiagLogger.debug('cs.flow', 'closeBlockingDialogs round=' + (round + 1) + ' sureConfirmed=' + confirmed + ' iconClicked=' + clicked + ' fallbackRemoved=' + removed); } catch (_) {}
    }
    await new Promise(function(r) { setTimeout(r, 300); });
    var stillOpen = false;
    var nodes = document.querySelectorAll('[class*="dialog"]');
    for (var j = 0; j < nodes.length; j++) {
      if (nodes[j].offsetHeight > 0 && !_isConfirmed(nodes[j])) { stillOpen = true; break; }
    }
    if (!stillOpen) return true;
  }
  var leftover = document.querySelectorAll('[class*="dialog"]');
  for (var k = 0; k < leftover.length; k++) {
    if (leftover[k].offsetHeight > 0 && !_isConfirmed(leftover[k])) {
      console.warn('[即投] closeBlockingDialogs: 多轮后弹窗仍在，cls=' +
        leftover[k].className + ' text=' + (leftover[k].textContent || '').trim().substring(0, 100));
      try { if (typeof DiagLogger !== 'undefined') DiagLogger.warn('cs.flow', '[#39] 多轮后弹窗仍在 cls=' + leftover[k].className + ' text=' + (leftover[k].textContent || '').trim().substring(0, 80)); } catch (_) {}
      _persistDiag('dialog:leftoverOpen', { cls: leftover[k].className, text: (leftover[k].textContent || '').trim().substring(0, 80) });
      return false;
    }
  }
  return true;
}

// ── #39 阶段1跳转恢复：消息页确认「沟通新职位」弹窗（SW 主动指派，独立于 closeBlockingDialogs）──
// 背景：同 HR 新岗位点「立即沟通」后 BOSS 整页跳转 /web/geek/chat，确认弹窗弹在消息页，
// 岗位页 CS 已死。本函数运行在消息页 CS，收 CONFIRM_CHANGE_JOB_DIALOG 后执行。
// DOM 铁证（2026-06-12 真机抓取）：根 div.dialog-wrap.active，本体 class 含 change-job-tip-dialog，
// 确认钮 span.boss-dialog__button（文本两侧有空白+Vue 注释节点），取消钮多 button-outline 类。
// 弹窗内有 .icon-close 但绝不点它（点了 = 取消建联）。
async function confirmChangeJobDialog() {
  try { if (typeof DiagLogger !== 'undefined') DiagLogger.info('cs.flow', '[#39] confirmChangeJobDialog 开始轮询弹窗 url=' + location.href); } catch (_) {}
  _persistDiag('confirmChangeJob:start', { url: location.href });

  // 轮询最多 8s（500ms 间隔）等可见 .change-job-tip-dialog
  var dlg = null;
  var deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    var cands = document.querySelectorAll('.change-job-tip-dialog');
    for (var ci = 0; ci < cands.length; ci++) {
      if (cands[ci].offsetHeight > 0) { dlg = cands[ci]; break; }
    }
    if (dlg) break;
    await new Promise(function(r) { setTimeout(r, 500); });
  }
  if (!dlg) {
    try { if (typeof DiagLogger !== 'undefined') DiagLogger.warn('cs.flow', '[#39] 8s 内未等到可见 .change-job-tip-dialog'); } catch (_) {}
    _persistDiag('confirmChangeJob:dialogNotFound', { url: location.href });
    return { clicked: false, reason: 'dialogNotFound' };
  }

  // 确认钮严校验：非 outline、可见、className 不含 disabled、文本 trim 后精确等于「沟通新职位」
  var btns = dlg.querySelectorAll('span.boss-dialog__button:not(.button-outline)');
  var btn = null;
  var seenTxt = '';
  for (var bi = 0; bi < btns.length; bi++) {
    var t = (btns[bi].textContent || '').trim();
    seenTxt = seenTxt ? seenTxt + '|' + t : t;
    if (btns[bi].offsetHeight > 0 && (btns[bi].className || '').indexOf('disabled') < 0 && t === '沟通新职位') {
      btn = btns[bi];
      break;
    }
  }
  if (!btn) {
    try { if (typeof DiagLogger !== 'undefined') DiagLogger.warn('cs.flow', '[#39] 确认钮不符（不可见/disabled/文本不等「沟通新职位」） seen=「' + seenTxt + '」'); } catch (_) {}
    _persistDiag('confirmChangeJob:btnMismatch', { seen: seenTxt, dlgCls: dlg.className });
    return { clicked: false, reason: 'btnMismatch:' + seenTxt };
  }

  // 先在根容器打标记（closeBlockingDialogs 据此跳过，绝不二次处理/remove 污染 Vue state）再点击
  var markRoot = dlg.closest('.dialog-wrap') || dlg;
  markRoot.setAttribute('data-zitou-sure-clicked', '1');
  btn.click();
  await new Promise(function(r) { setTimeout(r, 400); });
  var stillOpen = document.contains(dlg) && dlg.offsetHeight > 0;
  if (stillOpen) {
    try { if (typeof DiagLogger !== 'undefined') DiagLogger.warn('cs.flow', '[#39] 已点「沟通新职位」但 400ms 后弹窗仍可见'); } catch (_) {}
  } else {
    try { if (typeof DiagLogger !== 'undefined') DiagLogger.info('cs.flow', '[#39] 已点「沟通新职位」确认钮，弹窗已消失'); } catch (_) {}
  }
  _persistDiag('confirmChangeJob:clicked', { stillOpen: stillOpen });
  return { clicked: true, reason: 'ok' };
}

// ── 投递错位止血：公司名归一化（剥离常见后缀/地域后双向 includes）──
// job.hrCompany 与对话列表/详情公司名同实体（都抓自 HR/猎头卡），归一化后正常岗应能匹配。
// 仅用于 fallback 命中（公司未经主循环双键验证）的发送前身份断言，不参与 exact 主路径。
function _normCompanyName(s) {
  s = (s || '').trim();
  if (!s) return '';
  // 剥离常见公司后缀
  s = s.replace(/(股份)?有限责任公司|(股份)?有限公司|有限公司|集团|科技|网络|信息|技术|服务|咨询|文化|传媒|互联网|电子商务|发展|实业|控股|分公司|公司/g, '');
  // 剥离常见地域前缀/词
  s = s.replace(/北京|上海|广州|深圳|杭州|成都|重庆|武汉|南京|西安|苏州|天津|长沙|郑州|东莞|佛山|宁波|青岛|沈阳|大连|厦门|福州|合肥|济南|无锡|昆明|哈尔滨|长春|南昌|贵阳|南宁|石家庄|太原|中国|（[^）]*）|\([^)]*\)/g, '');
  // 剥离空白与常见标点
  s = s.replace(/[\s·•・，,.。、\-—()（）]/g, '');
  return s;
}

// 归一化后双向 includes 判定公司名是否同实体
function _companyMatch(a, b) {
  var na = _normCompanyName(a);
  var nb = _normCompanyName(b);
  if (!na || !nb) return false;
  return na === nb || na.indexOf(nb) !== -1 || nb.indexOf(na) !== -1;
}

// ── 聊天页辅助：根据HR名字+公司名查找对话 ──
// 返回的元素上挂 dataset 旁路标记 _jtMatchMode = 'exact' | 'fallback'，
// 调用方据此决定发送前是否需做身份断言（fallback 高危，公司未验）。
function _tagMatchMode(el, mode) {
  // 在 DOM 节点上挂一个非持久化属性，供同步调用链读取命中方式
  try { if (el) el._jtMatchMode = mode; } catch (_) {}
  return el;
}

function findChatConversation(hrName, hrCompany) {
  var items = document.querySelectorAll('.user-list-content li, .friend-content-warp');
  hrName = (hrName || '').trim();
  hrCompany = (hrCompany || '').trim();
  console.log('[即投] findChatConversation: 在', items.length, '个对话中搜索 hrName="' + hrName + '" hrCompany="' + hrCompany + '"');

  for (var i = 0; i < items.length; i++) {
    var nameEl = items[i].querySelector('.name-text');
    if (!nameEl) continue;
    var nameText = nameEl.textContent.trim();
    if (!nameText.includes(hrName) && hrName !== nameText) continue;
    // 检查公司名匹配
    var nameBox = items[i].querySelector('.name-box');
    if (nameBox) {
      var spans = nameBox.querySelectorAll('span');
      for (var s = 0; s < spans.length; s++) {
        if (spans[s].classList.contains('name-text')) continue;
        var companyText = spans[s].textContent.trim();
        if (companyText.includes(hrCompany) || hrCompany === companyText) {
          console.log('[即投] findChatConversation: 找到匹配对话 idx=' + i + ' name="' + nameText + '"');
          // 必须返回 .friend-content（内层div），不能返回 .friend-content-warp（外层div）
          // BOSS Vue 2 的 click handler 绑在 .friend-content 上
          // JS .click() 事件从目标元素开始，只向上冒泡，不向下传递到子元素
          // 如果点 .friend-content-warp，事件不会到达 .friend-content，handler 不触发
          if (items[i].tagName === 'LI') {
            return _tagMatchMode(items[i].querySelector('.friend-content, [class*="friend-content"]') || items[i].querySelector('.friend-content-warp') || items[i], 'exact');
          }
          if (items[i].classList.contains('friend-content-warp')) {
            return _tagMatchMode(items[i].querySelector('.friend-content') || items[i], 'exact');
          }
          return _tagMatchMode(items[i], 'exact');
        }
      }
      // 公司名不匹配，跳过这个 item
      continue;
    }
  }
  // ── 兜底（投递错位止血 #1）：只按名字匹配（公司名可能对不上）──
  // 旧逻辑命中第一个同名即返回 → 同名异公司错投。
  // 改：先遍历统计 name-only 命中数；>1 个歧义 → 返回 null（绝不盲选）；恰好 1 个唯一命中才返回。
  var nameOnlyHits = [];
  for (var j = 0; j < items.length; j++) {
    var nEl = items[j].querySelector('.name-text');
    if (nEl) {
      var nText = nEl.textContent.trim();
      if (nText.includes(hrName) || hrName === nText) {
        nameOnlyHits.push(items[j]);
      }
    }
  }
  if (nameOnlyHits.length > 1) {
    console.warn('[即投] findChatConversation: 兜底命中 ' + nameOnlyHits.length + ' 个同名HR（歧义）→ 不返回，转定位失败/补发');
    try {
      if (typeof ErrorLogger !== 'undefined' && ErrorLogger.logError) {
        ErrorLogger.logError('[findConv:ambiguous] ' + JSON.stringify({
          searchHrName: hrName, searchHrCompany: hrCompany, nameOnlyHitCount: nameOnlyHits.length,
        }), '', 'findConv.ambiguous');
      }
    } catch (_) {}
    return null;
  }
  if (nameOnlyHits.length === 1) {
    var hit = nameOnlyHits[0];
    console.log('[即投] findChatConversation: 兜底唯一匹配 name="' + (hit.querySelector('.name-text') ? hit.querySelector('.name-text').textContent.trim() : '') + '" → 标记 fallback（公司未验，发前断言）');
    if (hit.tagName === 'LI') {
      return _tagMatchMode(hit.querySelector('.friend-content, [class*="friend-content"]') || hit.querySelector('.friend-content-warp') || hit, 'fallback');
    }
    if (hit.classList.contains('friend-content-warp')) {
      return _tagMatchMode(hit.querySelector('.friend-content') || hit, 'fallback');
    }
    return _tagMatchMode(hit, 'fallback');
  }
  try {
    if (typeof ErrorLogger !== 'undefined' && ErrorLogger.logError) {
      var _listNames = [];
      for (var d = 0; d < items.length && _listNames.length < 20; d++) {
        var _ne = items[d].querySelector('.name-text');
        if (_ne) _listNames.push(_ne.textContent.trim());
      }
      ErrorLogger.logError('[findConv:diag] ' + JSON.stringify({
        searchHrName: hrName,
        searchHrCompany: hrCompany,
        listCount: items.length,
        listNames: _listNames,
        url: location.href,
      }), '', 'findConv.diag');
    }
  } catch (e) {}
  console.warn('[即投] findChatConversation: 未找到匹配对话');
  return null;
}

// ── 投递错位止血 #2：发送前身份断言（仅 fallback 命中调用）──
// 读「当前激活对话」的 HR名+公司，跟目标 job 比；HR名匹配 且 公司归一化后匹配 才放行。
// ⚠️ 真机实证：聊天详情顶栏根本不显示公司名，原顶栏候选选择器全失效（已删）。
// 可靠数据源 = 当前激活列表项 `.friend-content.selected`（真机 outerHTML 实证，
// 同时带 HR名 .name-text + 公司名，连猎头对话也带）。读不到一律 cannotVerify 转补发，不再猜顶栏。
function assertOpenConversationIdentity(targetHrName, targetHrCompany) {
  var hrName = (targetHrName || '').trim();

  // 边界兜底：必须恰好 1 个激活对话，否则无法确定当前打开的是哪个 → cannotVerify 转补发
  var sels = document.querySelectorAll('.friend-content.selected');
  if (sels.length !== 1) {
    console.warn('[即投] assertOpenConversationIdentity: .friend-content.selected 数量=' + sels.length + '（非唯一）→ cannotVerify，转补发');
    return { ok: false, cannotVerify: true, openName: '', openCompany: '' };
  }
  var sel = sels[0];

  // HR 名
  var nameEl = sel.querySelector('.name-text');
  var openName = (nameEl && nameEl.textContent) ? nameEl.textContent.trim() : '';

  // 公司名 = .name-box 内 .name-text 之后第一个「有文本的 span」。
  // span 顺序 = [HR名, 公司名, 头衔]，中间可能夹 i.vline / 占位 → 用 nextElementSibling 逐个向后跳，
  // 只认 SPAN 且首个有文本者 = 公司名；命中即停（绝不继续走到第三个 span=头衔），故不会取到头衔。
  var openCompany = '';
  var nameTextEl = sel.querySelector('.name-box .name-text');
  if (nameTextEl) {
    var cur = nameTextEl.nextElementSibling;
    while (cur) {
      if (cur.tagName === 'SPAN') {
        var t = (cur.textContent || '').trim();
        if (t) { openCompany = t; break; } // 首个有文本 span = 公司名，命中即停
      }
      cur = cur.nextElementSibling;
    }
  }

  // 取不到名或公司 → 无法核验，按核心原则（错投 >> 漏发）当失败转补发
  if (!openName || !openCompany) {
    console.warn('[即投] assertOpenConversationIdentity: .selected 取不到 name/company（name="' + openName + '" company="' + openCompany + '"）→ cannotVerify，转补发');
    return { ok: false, cannotVerify: true, openName: openName, openCompany: openCompany };
  }
  var nameOk = openName.indexOf(hrName) !== -1 || hrName.indexOf(openName) !== -1 || openName === hrName;
  var companyOk = _companyMatch(openCompany, targetHrCompany);
  if (nameOk && companyOk) {
    return { ok: true, openName: openName, openCompany: openCompany };
  }
  console.warn('[即投] assertOpenConversationIdentity: 身份断言失败 target="' + hrName + '/' + (targetHrCompany || '') + '" open="' + openName + '/' + openCompany + '" nameOk=' + nameOk + ' companyOk=' + companyOk + ' → 转补发');
  try {
    if (typeof ErrorLogger !== 'undefined' && ErrorLogger.logError) {
      ErrorLogger.logError('[identityAssert:fail] ' + JSON.stringify({
        targetHrName: hrName, targetHrCompany: targetHrCompany,
        openName: openName, openCompany: openCompany, nameOk: nameOk, companyOk: companyOk,
      }), '', 'identityAssert.fail');
    }
  } catch (_) {}
  return { ok: false, cannotVerify: false, openName: openName, openCompany: openCompany };
}

(async () => {
  const href = window.location.href;

  // ── 全局错误捕获 ──
  self.addEventListener('error', (event) => {
    if (typeof ErrorLogger !== 'undefined') {
      ErrorLogger.logError(event.message, event.filename + ':' + event.lineno, 'Content script global error');
    }
    try { if (typeof DiagLogger !== 'undefined') DiagLogger.error('cs.global', event.message + ' at ' + event.filename + ':' + event.lineno); } catch (_) {}
  });
  self.addEventListener('unhandledrejection', (event) => {
    if (typeof ErrorLogger !== 'undefined') {
      ErrorLogger.logError(event.reason?.message || String(event.reason), event.reason?.stack, 'Content script unhandled rejection');
    }
    try { if (typeof DiagLogger !== 'undefined') DiagLogger.error('cs.global', 'unhandledrejection: ' + (event.reason?.message || String(event.reason))); } catch (_) {}
  });

  // ── 诊断包：页面级用户行为信号（纯新增，不碰业务逻辑）──
  // visibilitychange/pagehide 帮助区分「程序 bug」vs「用户切走/关页/导航走」。
  // 只在任务相关页（jobs 搜索页 / chat 页）记录；ring buffer 自然限量。
  try {
    if (typeof DiagLogger !== 'undefined' && (href.includes('/web/geek/jobs') || href.includes('/web/geek/chat'))) {
      var _diagPath = '';
      try { _diagPath = location.pathname; } catch (e2) {}
      document.addEventListener('visibilitychange', function () {
        try { DiagLogger.userEvent('cs.page', 'visibility=' + document.visibilityState + ' path=' + _diagPath); } catch (_) {}
      });
      window.addEventListener('pagehide', function () {
        try {
          DiagLogger.userEvent('cs.page', 'pagehide（页面被关闭/导航走）path=' + _diagPath);
          DiagLogger.flush(); // 尽力落盘，页面销毁可能丢最后几条，可接受
        } catch (_) {}
      });
    }
  } catch (_) {}

  // ── 初始化：把已存储的错误日志同步到 DOM ──
  if (typeof ErrorLogger !== 'undefined') {
    ErrorLogger.getErrors().then(function(errors) {
      if (document.documentElement) {
        if (errors.length > 0) {
          document.documentElement.setAttribute('data-error-log', JSON.stringify(errors));
        }
      }
    }).catch(function(){});
  }

  // ── window.postMessage 监听 ──
  if (TEST_BRIDGE_ENABLED) {
  window.addEventListener('message', function(event) {
    if (!event.data || !event.data.type) return;

    function setSplitAttr(baseName, data) {
      var json = JSON.stringify(data);
      if (json.length <= 10240) {
        document.documentElement.setAttribute('data-' + baseName, json);
        return;
      }
      var idx = 0;
      while (idx * 10240 < json.length) {
        document.documentElement.setAttribute(
          'data-' + baseName + '-' + idx,
          json.slice(idx * 10240, (idx + 1) * 10240)
        );
        idx++;
      }
    }

    switch (event.data.type) {
      case 'GET_ERROR_LOG':
        if (typeof ErrorLogger !== 'undefined' && typeof ErrorLogger.syncToDOM === 'function') {
          ErrorLogger.syncToDOM();
        }
        break;

      case 'GET_EXTENSION_STATE':
        chrome.storage.local.get(['sw:phase', 'sw:jobs', 'sw:greetings', 'sw:sendProgress', 'sw:sentJobIds', 'sw:sendResults', 'ui:filterState'], function(items) {
          setSplitAttr('ext-state', items);
        });
        break;

      case 'TRIGGER_GREETING_GEN':
        chrome.runtime.sendMessage({ type: 'REGENERATE_GREETING' }, function(resp) {
          setTimeout(function() {
            chrome.storage.local.get(['sw:greetings'], function(data) {
              var result = { response: resp, greetings: data['sw:greetings'] };
              if (typeof ErrorLogger !== 'undefined') {
                ErrorLogger.getErrors().then(function(errors) {
                  result.errorLog = errors;
                  setSplitAttr('greeting-result', result);
                }).catch(function() {
                  setSplitAttr('greeting-result', result);
                });
              } else {
                setSplitAttr('greeting-result', result);
              }
            });
          }, 5000);
        });
        break;

      case 'RELOAD_EXTENSION':
        // 全自动开发重载（零抢屏）：content script 无 chrome.runtime.reload 特权，故转发给 SW 执行。
        // SW 置 __pending_tab_reload flag 后 reload；扩展重启后 SW top-level 读 flag 原地
        // chrome.tabs.reload 所有 BOSS tab → Chrome 自动注入新版 CS（不开新 tab、不切焦点）。
        try {
          chrome.runtime.sendMessage({ type: 'RELOAD_EXT_SELF' });
          document.documentElement.setAttribute('data-ext-cmd-result', 'reload_requested');
        }
        catch(e) { document.documentElement.setAttribute('data-ext-cmd-result', 'reload_failed: ' + e.message); }
        break;

      case 'CLEAR_ERRORS':
        if (typeof ErrorLogger !== 'undefined' && typeof ErrorLogger.clearErrors === 'function') {
          ErrorLogger.clearErrors().then(function() {
            document.documentElement.setAttribute('data-ext-cmd-result', 'errors_cleared');
          }).catch(function() {
            document.documentElement.setAttribute('data-ext-cmd-result', 'error_clear_failed');
          });
        } else {
          document.documentElement.setAttribute('data-ext-cmd-result', 'error_logger_unavailable');
        }
        break;

      case 'GET_SEND_STATUS':
        chrome.storage.local.get(['sw:sendProgress', 'sw:sentJobIds', 'sw:sendResults', 'sw:phase'], function(data) {
          setSplitAttr('send-status', data);
        });
        break;

      case 'TRIGGER_COLLECT': {
        var params = event.data.params;
        if (!params) {
          params = {};
          try {
            var urlParams = new URLSearchParams(window.location.search);
            urlParams.forEach(function(value, key) { params[key] = value; });
          } catch (e) {
            if (typeof ErrorLogger !== 'undefined') {
              ErrorLogger.logError(e.message, e.stack, 'TRIGGER_COLLECT parseURL');
            }
          }
        }
        chrome.runtime.sendMessage({ type: 'START_COLLECT', params: params }, function(resp) {
          if (chrome.runtime.lastError) {
            document.documentElement.setAttribute('data-ext-cmd-result', JSON.stringify({ success: false, error: chrome.runtime.lastError.message }));
            if (typeof ErrorLogger !== 'undefined') {
              ErrorLogger.logError(chrome.runtime.lastError.message, null, 'TRIGGER_COLLECT sendMessage');
            }
            return;
          }
          document.documentElement.setAttribute('data-ext-cmd-result', JSON.stringify(resp || {}));
        });
        break;
      }

      case 'SET_GREETING':
        chrome.storage.local.set({'sw:greetings': event.data.greetings}, function() {
          document.documentElement.setAttribute('data-greeting-set', 'done');
        });
        break;

      // 测试桥：把一张简历图写进 resumeImages storage（产品发送路径 _sendResumeImages 读的同一个 key）。
      // 复刻 A 页上传 events-a.js 写入的 storage 条目形状 {name,type,data,id,thumb,fullSrc} + 原子 get-then-set
      // （等价 helpers.js atomicUpdateResumeImages），保证发送路径能读到、popup 重载后缩略图也能渲染。
      // 仅测试用：osascript 够不到 chrome.storage / file picker 需可信用户手势，无此桥无法自动喂图。产品流程永不发此消息。
      case 'EXT_TEST_SET_RESUME': {
        try {
          var _du = event.data.dataUrl || '';
          var _comma = _du.indexOf(',');
          var _meta = _comma >= 0 ? _du.slice(0, _comma) : '';
          var _b64 = _comma >= 0 ? _du.slice(_comma + 1) : _du;
          var _typeM = _meta.match(/data:([^;]+)/);
          var _type = (_typeM && _typeM[1]) || 'image/jpeg';
          var _bin = atob(_b64);
          var _data = new Array(_bin.length);
          for (var _i = 0; _i < _bin.length; _i++) _data[_i] = _bin.charCodeAt(_i);
          var _name = event.data.name || 'resume.jpg';
          var _id = Date.now() + '_' + Math.random().toString(36).slice(2, 6);
          var _entry = { name: _name, type: _type, data: _data, id: _id, thumb: _du, fullSrc: _du };
          chrome.storage.local.get('resumeImages', function(r) {
            var arr = r.resumeImages || [];
            arr.push(_entry);
            chrome.storage.local.set({ resumeImages: arr }, function() {
              document.documentElement.setAttribute('data-ext-set-resume', JSON.stringify({ success: true, count: arr.length, bytes: _data.length }));
            });
          });
        } catch (e) {
          document.documentElement.setAttribute('data-ext-set-resume', JSON.stringify({ success: false, error: e && e.message }));
        }
        break;
      }

      case 'CLEAR_SENT_JOB_IDS':
        chrome.runtime.sendMessage({type:'CLEAR_SENT_JOB_IDS'});
        chrome.storage.local.remove('sw:sentJobIds');
        chrome.storage.local.remove('sw:sendResults');
        document.documentElement.setAttribute('data-ext-cmd-result','sent_job_ids_cleared');
        break;

      case 'TRIGGER_SEND_V4': {
        var jobIds = event.data.jobIds;
        var _testHrFilter = event.data.hrActiveFilter || '不限';
        var doSend = function(ids) {
          chrome.runtime.sendMessage({ type: 'START_SEND', jobIds: ids, hrActiveFilter: _testHrFilter }, function(resp) {
            if (chrome.runtime.lastError) {
              document.documentElement.setAttribute('data-ext-cmd-result', JSON.stringify({ success: false, error: chrome.runtime.lastError.message }));
              if (typeof ErrorLogger !== 'undefined') {
                ErrorLogger.logError(chrome.runtime.lastError.message, null, 'TRIGGER_SEND_V4 sendMessage');
              }
              return;
            }
            document.documentElement.setAttribute('data-ext-cmd-result', JSON.stringify(resp || {}));
          });
        };
        if (!jobIds || !Array.isArray(jobIds) || jobIds.length === 0) {
          chrome.storage.local.get(['sw:jobs'], function(items) {
            var jobs = items['sw:jobs'] || [];
            if (jobs.length > 0) {
              doSend([jobs[0].id]);
            } else {
              document.documentElement.setAttribute('data-ext-cmd-result', JSON.stringify({ success: false, error: 'No jobs found in storage' }));
            }
          });
        } else {
          doSend(jobIds);
        }
        break;
      }

      case 'EXT_TEST_OPEN_POPUP':
        chrome.runtime.sendMessage({ type: '__TEST_OPEN_POPUP__' }, function(resp) {
          if (chrome.runtime.lastError) {
            document.documentElement.setAttribute('data-test-popup-tab-id', JSON.stringify({ success: false, error: chrome.runtime.lastError.message }));
            return;
          }
          document.documentElement.setAttribute('data-test-popup-tab-id', JSON.stringify(resp || { success: false, error: 'no response' }));
        });
        break;

      case 'EXT_TEST_CLOSE_POPUP':
        chrome.runtime.sendMessage({ type: '__TEST_CLOSE_POPUP__', tabId: event.data.tabId }, function(resp) {
          if (chrome.runtime.lastError) {
            document.documentElement.setAttribute('data-test-popup-close', JSON.stringify({ success: false, error: chrome.runtime.lastError.message }));
            return;
          }
          document.documentElement.setAttribute('data-test-popup-close', JSON.stringify(resp || { success: false, error: 'no response' }));
        });
        break;

      case 'EXT_TEST_OPEN_TAB':
        // 测试桥：SW 用 chrome.tabs.create({active:false}) 开后台 BOSS tab（不抢屏）。
        chrome.runtime.sendMessage({ type: '__TEST_OPEN_TAB__', url: event.data.url }, function(resp) {
          if (chrome.runtime.lastError) {
            document.documentElement.setAttribute('data-test-open-tab', JSON.stringify({ success: false, error: chrome.runtime.lastError.message }));
            return;
          }
          document.documentElement.setAttribute('data-test-open-tab', JSON.stringify(resp || { success: false, error: 'no response' }));
        });
        break;
    }
  });
  }

  // ── 消息监听 ──
  try { chrome.runtime.sendMessage({ type: 'CS_DBG', stage: 'cs:listenerRegister', info: { url: location.href, msgKeys: Object.keys(MSG || {}).length, doBatchExtract: MSG && MSG.DO_BATCH_EXTRACT } }).catch(function(){}); } catch (_) {}
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // 全消息桥到 SW：诊断 case 是否命中
    if (msg && msg.type !== 'CS_DBG') {
      try { chrome.runtime.sendMessage({ type: 'CS_DBG', stage: 'cs:onMessage', info: { rcvType: msg.type, isDoBatchExtract: msg.type === MSG.DO_BATCH_EXTRACT, isPing: msg.type === MSG.PING } }).catch(function(){}); } catch (_) {}
    }
    if (msg.type === MSG.PING) {
      sendResponse({ type: MSG.PONG, url: location.href });
      return true;
    }

    switch (msg.type) {
      case MSG.DO_COLLECT:
        handleCollect(msg.params).then(
          (result) => sendResponse({ success: true, ...result }),
          (e) => sendResponse({ success: false, error: e.message })
        );
        return true;

      case MSG.DO_SEND:
        handleSend(msg.jobIds).then(
          (result) => sendResponse({ success: true, ...result }),
          (e) => sendResponse({ success: false, error: e.message })
        );
        return true;

      case MSG.DO_START_CHAT:
        // v5: 搜索页点"立即沟通"，返回 HR 信息
        handleStartChat(msg).then((result) => {
          sendResponse(result);
        }, (e) => {
          sendResponse({ success: false, error: e.message });
        });
        return true;

      case MSG.DO_SEND_CHAT:
        // v5: 聊天页匹配对话 + 发送消息
        handleSendChat(msg).then(
          (result) => sendResponse(result),
          (e) => sendResponse({ success: false, error: e.message })
        );
        return true;

      case MSG.DO_STOP:
        try { if (typeof DiagLogger !== 'undefined') DiagLogger.info('cs.flow', 'DO_STOP 到达，停止本页采集/发送'); } catch (_) {}
        if (typeof JobCollector !== 'undefined') JobCollector.stopped = true;
        if (typeof BrowseSender !== 'undefined') BrowseSender.stop();
        if (typeof JobSender !== 'undefined') JobSender.stop();
        if (typeof ChatListMonitor !== 'undefined') ChatListMonitor.stop();
        sendResponse({ success: true });
        break;

      case MSG.DO_BROWSE:
        BrowseSender.run(msg.params).then(
          function (result) { sendResponse({ success: true, result: result }); },
          function (e) { sendResponse({ success: false, error: e.message }); }
        );
        return true;

      case MSG.DO_BATCH_EXTRACT:
        console.log('[即投] DO_BATCH_EXTRACT 到达 CS, queueLen:', msg.queue?.length, 'url:', location.href);
        _persistDiag('DO_BATCH_EXTRACT:rcv', { queueLen: msg.queue?.length, url: location.href });
        handleBatchExtract(msg).then(
          (result) => sendResponse(result),
          (e) => sendResponse({ success: false, error: e.message })
        );
        return true;

      case MSG.DO_SINGLE_EXTRACT:
        handleSingleExtract(msg).then(
          (result) => sendResponse(result),
          (e) => sendResponse({ success: false, error: e.message })
        );
        return true;

      case MSG.WORKER_ACTIVATE:
        handleWorkerActivate(msg).then(
          (result) => sendResponse(result),
          (e) => sendResponse({ success: false, error: e.message })
        );
        return true;

      case MSG.WORKER_SEND:
        handleWorkerSend(msg).then(
          (result) => sendResponse(result),
          (e) => sendResponse({ success: false, error: e.message })
        );
        return true;

      case MSG.WORKER_REPAIR:
        handleWorkerRepair(msg).then(
          (result) => sendResponse(result),
          (e) => sendResponse({ complete: false, error: e.message })
        );
        return true;

      case MSG.CONFIRM_CHANGE_JOB_DIALOG:
        // #39 阶段1跳转恢复：SW 指派消息页 CS 点「沟通新职位」确认弹窗
        confirmChangeJobDialog().then(
          (result) => sendResponse(result),
          (e) => sendResponse({ clicked: false, reason: 'error:' + e.message })
        );
        return true;

      case MSG.QUEUE_EMPTY:
        // 不再自动关闭 tab — 留给用户手动关闭，确保消息有充足时间发送完毕
        return;

      case MSG.CHECK_GREETING_SETTING:
        // pre-flight: 读 BOSS「自动打招呼」开关状态（CS 同源 fetch 带 cookie）
        handleCheckGreetingSetting().then(
          (result) => sendResponse(result),
          (e) => sendResponse({ success: false, error: e.message })
        );
        return true;

      case MSG.ENABLE_GREETING_SETTING:
        // pre-flight: API 写开（status=1）+ getGreetingList 复读自检
        handleEnableGreetingSetting(msg.templateId).then(
          (result) => sendResponse(result),
          (e) => sendResponse({ ok: false, error: e.message })
        );
        return true;

      case MSG.DISABLE_GREETING_SETTING:
        handleDisableGreetingSetting().then(
          (result) => sendResponse(result),
          (e) => sendResponse({ ok: false, error: e.message })
        );
        return true;

      case 'GET_ERROR_LOG':
        if (typeof ErrorLogger !== 'undefined') {
          ErrorLogger.getErrors()
            .then(errors => sendResponse({ success: true, errors }))
            .catch(() => sendResponse({ success: false, error: 'Failed to read error log' }));
        } else {
          sendResponse({ success: false, error: 'ErrorLogger not available' });
        }
        return true;
    }
  });

  // ── 路由 ──
  if (href.includes('/web/geek/jobs')) {
    console.log('[即投] 岗位搜索页已就绪 (v5 双页并行)');
  } else if (href.includes('/web/geek/chat')) {
    if (typeof ChatListMonitor !== 'undefined') ChatListMonitor.start();
    console.log('[即投] 聊天页已就绪 (v5 双页并行)');
  } else if (href.includes('/job_detail/')) {
    console.log('[即投] 岗位详情页已就绪');
  }

  // ── 通知 SW：CS 注入完成（携带角色信息）──
  var role = '';
  if (href.includes('/web/geek/jobs')) {
    role = 'search';
  } else if (href.includes('/web/geek/chat')) {
    role = 'worker';
  }
  try { if (typeof DiagLogger !== 'undefined' && role) DiagLogger.info('cs.flow', 'CS 就绪 role=' + role + ' path=' + location.pathname); } catch (_) {}
  chrome.runtime.sendMessage({ type: MSG.CS_READY, url: href, role: role }).catch(() => {});
})();

// ── 处理收集 ──
async function handleCollect(params) {
  const result = await runCollection(params, (progress) => {
    chrome.runtime.sendMessage({ type: MSG.COLLECT_PROGRESS, ...progress });
  });
  chrome.runtime.sendMessage({
    type: MSG.JOBS_COLLECTED,
    jobs: result.jobs,
    clusters: result.clusters,
    jdSamples: result.jdSamples,
  });
  return result;
}

// ── 处理发送（按 jobIds 逐个调用 sendSingle）──
async function handleSend(jobIds) {
  const stateResp = await chrome.runtime.sendMessage({ type: MSG.GET_STATE });
  const { greetings, jobs } = stateResp.state;
  let sent = 0, failed = 0;
  for (const id of jobIds) {
    const job = jobs.find((j) => j.id === id);
    const category = job?.tags?.[0] || '其他';
    const greeting = greetings[category] || '';
    try {
      const result = await JobSender.sendSingle(greeting, id);
      if (result.success) sent++; else failed++;
      chrome.runtime.sendMessage({
        type: MSG.SEND_ITEM_RESULT,
        payload: { jobId: id, ...result },
      }).catch(() => {});
      chrome.runtime.sendMessage({
        type: MSG.SEND_PROGRESS,
        payload: { sent, failed, total: jobIds.length, current: id },
      }).catch(() => {});
      if (result.captchaDetected) break;
    } catch (e) {
      failed++;
      if (typeof ErrorLogger !== 'undefined') { ErrorLogger.logError(e.message, e.stack, 'handleSend'); }
      chrome.runtime.sendMessage({
        type: MSG.SEND_ITEM_RESULT,
        payload: { jobId: id, success: false, error: e.message },
      }).catch(() => {});
      chrome.runtime.sendMessage({
        type: MSG.SEND_PROGRESS,
        payload: { sent, failed, total: jobIds.length, current: id },
      }).catch(() => {});
    }
  }
  const result = { sent, total: jobIds.length, failed };
  chrome.runtime.sendMessage({ type: MSG.SEND_COMPLETE, ...result }).catch(() => {});
  return result;
}

// ── v5: 搜索页点"立即沟通"，提取HR信息 ──
async function handleStartChat(msg) {
  try {
    const result = await JobClicker.clickImmediateChat(msg.jobLink, msg.positionName, msg.companyName);
    return result;
  } catch (e) {
    if (typeof ErrorLogger !== 'undefined') { ErrorLogger.logError(e.message, e.stack, 'handleStartChat'); }
    return { success: false, error: e.message };
  }
}

// ── v5: 聊天页匹配对话 + 发送消息 ──
async function handleSendChat(msg) {
  try {
    // v6: hrName 为空时直接返回，禁止盲目发送
    if (!msg.hrName) {
      return { success: false, error: 'HR名称为空，无法匹配对话' };
    }

    // 先等对话列表容器渲染（异步 AJAX 挂载），否则 findChatConversation 查到 0 节点。
    var listContainer = await waitForElement('.user-list-content', 10000);
    if (!listContainer) {
      return { success: false, error: '对话列表容器未加载' };
    }

    var conversation = findChatConversation(msg.hrName, msg.hrCompany);
    if (!conversation) {
      // 轮询等待：每 500ms 查一次，最多 5s
      for (var retry = 0; retry < 10 && !conversation; retry++) {
        await new Promise(function(r) { setTimeout(r, 500); });
        conversation = findChatConversation(msg.hrName, msg.hrCompany);
      }
    }
    if (!conversation) {
      return { success: false, error: '未找到对话: ' + msg.hrName + ' / ' + (msg.hrCompany || '') };
    }
    // 投递错位止血 #2：记录命中方式（fallback 高危，公司未验）
    var matchMode = conversation._jtMatchMode || 'exact';
    conversation.click();
    await new Promise(function(r) { setTimeout(r, 2000); });

    // fallback 命中 → 点开对话后、发送前做身份断言；不匹配/无法核验则不发，转失败（杜绝同名错投）
    if (matchMode === 'fallback') {
      var idn = assertOpenConversationIdentity(msg.hrName, msg.hrCompany);
      if (!idn.ok) {
        return { success: false, error: idn.cannotVerify ? '兜底命中无法核验对话身份，不发送' : '兜底命中身份断言失败（疑同名错投）：当前对话=' + (idn.openName || '?') + '/' + (idn.openCompany || '?'), identityAssertFailed: true };
      }
    }

    const result = await JobSender.sendSingle(msg.greeting, msg.jobId);
    chrome.runtime.sendMessage({
      type: MSG.SEND_ITEM_RESULT,
      payload: { jobId: msg.jobId, ...result },
    }).catch(() => {});
    return result;
  } catch (e) {
    if (typeof ErrorLogger !== 'undefined') { ErrorLogger.logError(e.message, e.stack, 'handleSendChat'); }
    return { success: false, error: e.message };
  }
}

// ── v6: 搜索页批量提取 HR 信息 ──
function _csDbg(stage, info) {
  try { chrome.runtime.sendMessage({ type: 'CS_DBG', stage: stage, info: info || {} }).catch(function(){}); } catch (_) {}
}

async function handleBatchExtract(msg) {
  var queue = msg.queue || [];
  if (typeof JobCollector !== 'undefined') JobCollector.stopped = false;
  if (typeof JobSender !== 'undefined') JobSender.stopped = false; // 新一批发送开始：重置硬中止标志，杜绝上一轮 stop 残留致本批 bail 不发文/图
  _csDbg('batchExtract:start', { queueLen: queue.length, url: location.href });
  console.log('[即投] handleBatchExtract: 开始，队列长度=', queue.length);
  var results = [];
  var skipped = [];
  var failed = [];
  var captchaDetected = false;
  // #39 导航中止：哨兵置位或已不在岗位页（path 前缀判据，与 role=search 的 /web/geek/jobs 同源）
  // → 文档正在拆毁，继续跑全是假失败。≥0 即中止索引。
  var navAbortedAt = -1;
  var _navGone = function() {
    return _navAborting || location.pathname.indexOf('/web/geek/jobs') !== 0;
  };

  for (var i = 0; i < queue.length; i++) {
    // #39 检查点 1：每岗开始前——导航离开则中止，剩余岗不记 failed 不发 itemDone
    if (_navGone()) { navAbortedAt = i; break; }
    if (typeof JobCollector !== 'undefined' && JobCollector.stopped) {
      _csDbg('batchExtract:stopped', { i: i });
      break;
    }
    var item = queue[i];
    _csDbg('batchExtract:itemStart', { i: i, jobId: item.jobId, jobLink: item.jobLink, positionName: item.positionName, fastMode: !!msg.fastMode });
    var tStart = Date.now();
    // #39 阶段1跳转恢复：逐岗结局快照（itemDone 上报用）
    var itemOutcome = { success: false, alreadyChatted: false, hrName: '', hrCompany: '' };
    var itemTimeout = 15000;
    try {
      // 单 item 硬 timeout 防永挂
      var clickResult = await Promise.race([
        JobClicker.clickImmediateChat(item.jobLink, item.positionName, item.companyName, msg.hrActiveFilter,
          { index: i, jobId: item.jobId, jobName: item.positionName, fastMode: !!msg.fastMode, platformGreeting: !!msg.platformGreeting, sendResumeImage: !!msg.sendResumeImage }),
        new Promise(function(_, rej) { setTimeout(function() { rej(new Error('clickImmediateChat timeout')); }, itemTimeout); })
      ]);
      // #39 检查点 2：click 返回后——导航离开则本岗不记账不发 itemDone（SW 凭 beforeClick 知其在途）
      if (_navGone()) { navAbortedAt = i; break; }
      _csDbg('batchExtract:itemDone', { i: i, ms: Date.now() - tStart, success: clickResult.success, error: clickResult.error, hrName: clickResult.hrName });
      itemOutcome.success = !!clickResult.success;
      itemOutcome.alreadyChatted = !!clickResult.alreadyChatted;
      itemOutcome.hrName = clickResult.hrName || '';
      itemOutcome.hrCompany = clickResult.hrCompany || '';
      if (clickResult.success && clickResult.hrName) {
        results.push({
          jobId: item.jobId,
          hrName: clickResult.hrName,
          hrCompany: clickResult.hrCompany,
          greeting: item.greeting,
          positionName: item.positionName,
          companyName: item.companyName,
          alreadyChatted: !!clickResult.alreadyChatted,
        });
      } else if (clickResult.skipped) {
        skipped.push({ jobId: item.jobId, activeDesc: clickResult.activeDesc });
      } else {
        // 提取失败（非 skip）：带原因回传，不再静默丢弃
        failed.push({ jobId: item.jobId, error: clickResult.error || '未能在搜索页找到该岗位卡片' });
      }
      // 检测验证码
      if (typeof detectCaptcha === 'function') {
        var captcha = detectCaptcha();
        if (captcha.detected) {
          _csDbg('batchExtract:captcha', { i: i });
          captchaDetected = true;
          chrome.runtime.sendMessage({ type: MSG.CAPTCHA_DETECTED }).catch(function(){});
          break;
        }
      }
    } catch (e) {
      // #39 检查点 2'：异常返回路径同检——拆毁中 DOM 抛错即假失败，不记 failed 不发 itemDone
      if (_navGone()) { navAbortedAt = i; break; }
      _csDbg('batchExtract:itemError', { i: i, ms: Date.now() - tStart, msg: e.message });
      if (typeof ErrorLogger !== 'undefined') {
        ErrorLogger.logError(e.message, e.stack, 'handleBatchExtract item=' + i);
      }
      failed.push({ jobId: item.jobId, error: e.message });
    }

    // #39 阶段1跳转恢复：逐岗 itemDone 上报（fire-and-forget，SW 未应答也绝不阻塞循环）
    try {
      chrome.runtime.sendMessage({
        type: MSG.EXTRACT_PROGRESS,
        index: i,
        jobId: item.jobId,
        jobName: item.positionName,
        hrName: itemOutcome.hrName,
        hrCompany: itemOutcome.hrCompany,
        stage: 'itemDone',
        success: itemOutcome.success,
        alreadyChatted: itemOutcome.alreadyChatted,
      }).catch(function(){});
    } catch (_) {}

    chrome.runtime.sendMessage({
      type: MSG.EXTRACT_PROGRESS,
      done: i + 1,
      total: queue.length,
      extracted: results.length,
      jobName: item.positionName || '',
    }).catch(function(){});
  }

  // #39 导航中止收尾：绝不发 EXTRACT_COMPLETE（发了 = SW stage1 假结算 + 假失败入 _stage1DoneJobIds），
  // 直接 return 交 SW 恢复环重发剩余队列。已完成岗位的 itemDone 已逐岗发出，SW 侧记账不丢。
  if (navAbortedAt >= 0) {
    var navRemaining = queue.length - navAbortedAt;
    try { if (typeof DiagLogger !== 'undefined') DiagLogger.warn('cs.flow', '[#39] 检测到页面导航离开，批处理中止于 index=' + navAbortedAt + '，剩余 ' + navRemaining + ' 岗交恢复环重发'); } catch (_) {}
    _persistDiag('batchExtract:navAbort', { index: navAbortedAt, remaining: navRemaining, path: location.pathname, sentinel: _navAborting });
    _csDbg('batchExtract:navAbort', { index: navAbortedAt, remaining: navRemaining });
    return { success: false, navAborted: true, abortedAt: navAbortedAt };
  }

  _csDbg('batchExtract:complete', { resultsLen: results.length, captcha: captchaDetected, url: location.href });
  chrome.runtime.sendMessage({
    type: MSG.EXTRACT_COMPLETE,
    success: true,
    results: results,
    skipped: skipped,
    failed: failed,
    captchaDetected: captchaDetected,
  }).catch(function(){});
  return { success: true, results: results, skipped: skipped, failed: failed, captchaDetected: captchaDetected };
}

async function handleSingleExtract(msg) {
  var item = msg.item || {};
  var platformGreeting = !!msg.platformGreeting;
  var fastMode = !!msg.fastMode && !platformGreeting;
  var progressCtx = {
    index: 0,
    jobId: item.jobId,
    jobName: item.positionName,
    fastMode: fastMode,
    platformGreeting: platformGreeting,
    sendResumeImage: !!msg.sendResumeImage,
  };
  _persistDiag('singleExtract:start', { jobId: item.jobId, url: location.href });
  var result = await JobClicker.extractOnDetailPage(
    item.jobLink, item.positionName, item.companyName, msg.hrActiveFilter, progressCtx
  );
  try {
    chrome.runtime.sendMessage({
      type: MSG.EXTRACT_PROGRESS,
      index: 0,
      jobId: item.jobId,
      jobName: item.positionName,
      hrName: result.hrName || '',
      hrCompany: result.hrCompany || '',
      stage: 'itemDone',
      success: !!result.success,
      alreadyChatted: !!result.alreadyChatted,
    }).catch(function(){});
  } catch (_) {}
  _persistDiag('singleExtract:done', {
    jobId: item.jobId,
    success: result.success,
    error: result.error,
    hrName: result.hrName,
  });
  return { success: true, result: result };
}

// ── v6: 聊天页 worker 激活，只找对话返回坐标（点击由 SW 通过 CDP 发真实鼠标事件）──
async function handleWorkerActivate(msg) {
  var job = msg.job || {};
  var jobId = job.jobId;
  var positionName = job.positionName;
  var companyName = job.companyName;
  // 同步诊断：worker tab 认领映射。每 zhipin tab 的 data-diag-sync 序列即该 worker 处理的岗位列表。
  _persistDiag('worker:claim', {
    jobId: jobId,
    positionName: positionName,
    companyName: companyName,
    hrName: job.hrName,
    hrCompany: job.hrCompany,
  });
  console.log('[即投] handleWorkerActivate: jobId=' + jobId + ' hrName=' + job.hrName + ' hrCompany=' + job.hrCompany);

  if (!job.hrName) {
    return { success: false, jobId: jobId, error: 'HR名称为空', positionName: positionName, companyName: companyName };
  }

  // 硬中止：停止后绝不进对话、不发起任何动作
  if (typeof JobSender !== 'undefined' && JobSender.stopped) {
    return { success: false, stopped: true, jobId: jobId, error: 'stopped', positionName: positionName, companyName: companyName };
  }

  // worker tab 后台打开 + /web/geek/chat 列表 Vue 异步 AJAX 挂载，进名字匹配 retry 前
  // 先等列表容器 .user-list-content 出现，否则 findChatConversation 查到 0 节点直接空。
  var listContainer = await waitForElement('.user-list-content', 10000);
  if (!listContainer) {
    return { success: false, jobId: jobId, error: '对话列表容器未加载', positionName: positionName, companyName: companyName };
  }

  var conversation = findChatConversation(job.hrName, job.hrCompany);
  for (var retry = 0; retry < 12 && !conversation; retry++) {
    await sleep(500);
    conversation = findChatConversation(job.hrName, job.hrCompany);
  }
  if (!conversation) {
    return { success: false, jobId: jobId, error: '未找到对话', positionName: positionName, companyName: companyName };
  }
  // 投递错位止血 #2：记录命中方式（exact=双键主循环；fallback=兜底唯一命中，公司未验，高危）
  var matchMode = conversation._jtMatchMode || 'exact';

  // 确保拿到可点击的元素（必须是 .friend-content，不能是 .friend-content-warp 或 li）
  // BOSS Vue 2 click handler 绑在 .friend-content 上，点外层不会触发
  var clickEl = conversation;
  if (conversation.tagName === 'LI') {
    clickEl = conversation.querySelector('.friend-content, [class*="friend-content"]') || conversation.querySelector('.friend-content-warp') || conversation;
  } else if (conversation.classList.contains('friend-content-warp')) {
    clickEl = conversation.querySelector('.friend-content') || conversation;
  }

  // 点击对话（不做"已选中"判断——class 可能不在当前元素上）
  if (typeof JobSender !== 'undefined' && JobSender.stopped) {
    return { success: false, stopped: true, jobId: jobId, error: 'stopped', positionName: positionName, companyName: companyName };
  }
  console.log('[即投] handleWorkerActivate: 点击对话 hrName=' + job.hrName + ' tagName=' + clickEl.tagName + ' class=' + clickEl.className);
  clickEl.click();

  // 等待对话加载完成：轮询 chat-input，与 sendText 使用完全一致的可见性检查，最长 10s
  var chatLoaded = false;
  var waited = 0;
  while (waited < 50) {
    await sleep(200);
    waited++;
    // 与 sendText 的 waitForElement 保持一致的 offsetParent 检查（修复固定定位容器内输入框不可见的问题）
    var input = document.querySelector(SELECTORS.chatDetail.chatInput);
    if (input && (input.offsetParent !== null || getComputedStyle(input).position === 'fixed')) {
      console.log('[即投] handleWorkerActivate: 对话加载完成，等待=' + (waited * 200) + 'ms');
      chatLoaded = true;
      break;
    }
    var msgs = document.querySelectorAll('.msg-content, .message, [class*="message"]');
    if (msgs.length > 0) {
      console.log('[即投] handleWorkerActivate: 对话加载完成（消息列表），等待=' + (waited * 200) + 'ms');
      chatLoaded = true;
      break;
    }
  }

  if (!chatLoaded) {
    console.warn('[即投] handleWorkerActivate: 点击后对话未加载，input可见=', !!document.querySelector('.chat-input'));
    return { success: false, jobId: jobId, error: '点击对话后未加载聊天详情', positionName: positionName, companyName: companyName };
  }

  // 进对话后可能弹「同HR多岗位（选之前岗位/新岗位）」「打招呼」等弹窗，挡住输入框 →
  // 不关掉 sendText 会卡住。stage2 发送与补发都经此函数，统一在这里关弹窗。
  // closeBlockingDialogs 多轮轮询（~2s），能接住延迟弹出的弹窗；持续不灭也不阻塞，
  // 让后续 sendText 去如实失败，而不是在这里死等。
  await closeBlockingDialogs(3);

  // 投递错位止血 #2：fallback 命中（公司未经主循环验证）→ 发送前身份断言。
  // 读详情顶栏 HR名+公司核对目标；不匹配或无法核验一律不放行，转补发，杜绝同名错投。
  // exact 命中（绝大多数正常岗）跳过断言，零回归。
  if (matchMode === 'fallback') {
    var idn = assertOpenConversationIdentity(job.hrName, job.hrCompany);
    if (!idn.ok) {
      return {
        success: false, jobId: jobId,
        error: idn.cannotVerify ? '兜底命中无法核验对话身份（顶栏选择器缺失），转补发' : '兜底命中身份断言失败（疑同名错投）：当前对话=' + (idn.openName || '?') + '/' + (idn.openCompany || '?'),
        identityAssertFailed: true,
        positionName: positionName, companyName: companyName,
      };
    }
    console.log('[即投] handleWorkerActivate: fallback 身份断言通过 open="' + idn.openName + '/' + idn.openCompany + '"');
  }

  return {
    success: true,
    jobId: jobId
  };
}

// ── v6: 聊天页 worker 发送（在 CDP 点击后调用）──
async function handleWorkerSend(msg) {
  var job = msg.job || {};
  var jobId = job.jobId;
  console.log('[即投] handleWorkerSend: 开始发送，greeting长度=' + (job.greeting || '').length);
  try {
    // worker 阶段 fail-fast：文字 3s 图片 4s 各单次不重试，未确认即转补发队列。
    // 旧版 sendText 死等 8s + 重试 3 次 = ~28s/岗位 → 招呼语发 3 次（errorLog 实证 baseline=4）；
    // sendImage 同款 3 次重试。worker 阶段抢同账号 WS，重试纯浪费——补发兜底（单连接干净环境）。
    var sendResult = await JobSender.sendSingle(
      job.greeting, jobId,
      { timeoutMs: 4000, maxAttempts: 1 },  // imgOpts
      { timeoutMs: 3000, maxAttempts: 1 }   // textOpts
    );
    console.log('[即投] handleWorkerSend: sendSingle 结果', sendResult);
    return { success: true, jobId: jobId, positionName: job.positionName, companyName: job.companyName, ...sendResult };
  } catch (e) {
    return { success: false, jobId: jobId, error: e.message };
  }
}

// ════════════════════════════════════════════════════════════════
// 招呼语开关 pre-flight（陷阱 #31 / 双发修复）：
// 旧逻辑：投递前强制开启 BOSS「自动打招呼」→ 点「立即沟通」时 BOSS 先发平台模板语，
//         stage2 再 sendText AI 招呼语 → HR 收到两条招呼语。
// 现逻辑：投递前关闭 BOSS 自动打招呼，仅由扩展 sendText 发送 AI 定制招呼语+简历图；
//         投递结束后若用户原先开着，再恢复开关状态。
// fetch 由搜索页 CS 执行：同源带 cookie、且能 document.cookie 读 bst（非 HttpOnly）。
// ════════════════════════════════════════════════════════════════

// 读开关：GET getGreetingList → zpData.greeting.{enabled, templateId}
async function _fetchGreetingSetting() {
  var resp = await fetch('https://www.zhipin.com/wapi/zpchat/greeting/getGreetingList', {
    credentials: 'include',
  });
  var data = await resp.json();
  var g = data && data.zpData && data.zpData.greeting;
  if (!g || typeof g.enabled !== 'boolean') {
    throw new Error('getGreetingList 响应缺 greeting.enabled (code=' + (data && data.code) + ')');
  }
  return { enabled: g.enabled, templateId: g.templateId };
}

async function handleCheckGreetingSetting() {
  try {
    var g = await _fetchGreetingSetting();
    return { success: true, enabled: g.enabled, templateId: g.templateId };
  } catch (e) {
    // 读失败（网络/接口变更）→ SW 侧视为 enabled 未知，放行投递（宁可少拦截不可误拦截）
    return { success: false, error: e.message };
  }
}

function _readCookie(name) {
  var m = document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : '';
}

// 写开关（只写 status=1，绝不写 status=0）+ 复读自检。
// zp_token = cookie bst 原值；traceId BOSS 不校验内容，随机串即可。实测 ~0.5s 生效。
async function handleDisableGreetingSetting() {
  try {
    var bst = _readCookie('bst');
    if (!bst) return { ok: false, error: '未读到 bst cookie（zp_token 缺失）' };
    var body = 'status=0&templateId=';
    await fetch('https://www.zhipin.com/wapi/zpchat/greeting/updateGreetingV2', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
        'zp_token': bst,
        'traceId': 'F-' + Math.random().toString(36).slice(2, 12).toUpperCase(),
      },
      body: body,
    });
    await sleep(600);
    var g = await _fetchGreetingSetting();
    if (!g.enabled) return { ok: true, enabled: false };
    await sleep(1000);
    g = await _fetchGreetingSetting();
    return { ok: !g.enabled, enabled: g.enabled };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function handleEnableGreetingSetting(templateId) {
  try {
    var bst = _readCookie('bst');
    if (!bst) return { ok: false, error: '未读到 bst cookie（zp_token 缺失）' };
    var body = 'status=1&templateId=' + encodeURIComponent(templateId == null ? '' : templateId);
    await fetch('https://www.zhipin.com/wapi/zpchat/greeting/updateGreetingV2', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
        'zp_token': bst,
        'traceId': 'F-' + Math.random().toString(36).slice(2, 12).toUpperCase(),
      },
      body: body,
    });
    // 写后必须复读 enabled 自检（updateGreetingV2 响应不可全信，以 getGreetingList 为准）
    await sleep(600);
    var g = await _fetchGreetingSetting();
    if (g.enabled) return { ok: true, enabled: true };
    // 一次复读未生效 → 再等 1s 复读一次兜底（实测 0.5s 生效，1.6s 仍 false 即判失败走降级）
    await sleep(1000);
    g = await _fetchGreetingSetting();
    return { ok: !!g.enabled, enabled: g.enabled };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── v6 补发：在全新沟通页里重进对话、核对服务器历史、缺啥补啥（单连接、安静期）──
async function handleWorkerRepair(msg) {
  var job = msg.job || {};
  var jobId = job.jobId;
  // 复用 activate 的导航逻辑：找到并进入该 HR 对话，等历史加载
  var act = await handleWorkerActivate(msg);
  if (!act || !act.success) {
    // 对话没建起来 → 补不了（属「未找到对话」独立 bug），如实回报
    return {
      complete: false, foundConv: false, jobId: jobId,
      error: (act && act.error) || '补发时未找到对话',
      positionName: job.positionName, companyName: job.companyName,
    };
  }
  // 等服务器历史 AJAX 渲染稳定再 hasTextInHistory/hasImageInHistory，否则 DOM 没渲染完
  // 误判 hadText:false → 重发招呼语（双发）。上轮 1000→500 过激进引入回归，本轮回退到 1500。
  await sleep(1500);
  try {
    // 补发阶段单连接干净环境无 WS 风暴：5s 单图超时 + 最多 2 次重试 + 600ms 重连间隔，比 worker 耐心
    // 但比 legacy 默认（15s×3）激进得多。补发还会先查服务器历史，已成功的图不会重发（天然防双发）。
    var r = await JobSender.repairSingle(
      job.greeting, jobId,
      { timeoutMs: 5000, maxAttempts: 2, retryDelayMs: 600 }, // imgOpts
      { timeoutMs: 5000, maxAttempts: 2, retryDelayMs: 600 }  // textOpts (跟 imgOpts 同保守值)
    );
    return {
      jobId: jobId, foundConv: true,
      positionName: job.positionName, companyName: job.companyName,
      ...r,
    };
  } catch (e) {
    return { complete: false, foundConv: true, jobId: jobId, error: e.message };
  }
}
