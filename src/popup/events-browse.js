// ════════════════════════════════════════════════════════════
// 即投 — 浏览模式事件与 UI
// ════════════════════════════════════════════════════════════

window.refreshBrowseDailyCount = function () {
  if (typeof chrome === 'undefined' || !chrome.runtime || !MSG.GET_BROWSE_DAILY_COUNT) return;
  chrome.runtime.sendMessage({ type: MSG.GET_BROWSE_DAILY_COUNT }, function (resp) {
    var count = (resp && resp.success && typeof resp.count === 'number') ? resp.count : 0;
    var el = document.getElementById('browseDailyCountDisplay');
    if (el) el.textContent = String(count);
    var dailyQuota = document.getElementById('browseDailyQuota');
    if (dailyQuota) dailyQuota.textContent = '今日累计 ' + count;
  });
};

window.syncBrowseSettingsUI = function () {
  var scope = Store.get('browseScope') || 'current';
  document.querySelectorAll('[data-browse-scope]').forEach(function (btn) {
    btn.classList.toggle('active', btn.dataset.browseScope === scope);
  });
  var limitEl = document.getElementById('browseSessionLimit');
  if (limitEl) {
    var lim = Store.get('browseSessionLimit');
    limitEl.value = lim != null ? String(lim) : '0';
  }
  window.refreshBrowseDailyCount();
};

window.applyWorkModeUI = function () {
  var mode = Store.get('workMode') || 'search';
  var isBrowse = mode === 'browse';
  var onSettings = Store.get('mode') === 'settings';
  var scroll = document.getElementById('scrollContent');
  if (scroll) {
    scroll.classList.toggle('mode-browse', isBrowse);
    scroll.classList.toggle('mode-search', !isBrowse);
  }
  var bsp = document.getElementById('browseSettingsPanel');
  if (bsp && onSettings) {
    bsp.classList.toggle('hidden', !isBrowse);
  }
  document.querySelectorAll('.work-mode-btn').forEach(function (btn) {
    btn.classList.toggle('active', btn.dataset.workMode === mode);
  });
  // 显式切换底部按钮（避免 .hidden 与 mode 类 CSS 冲突导致点错按钮）
  var btnCollect = document.getElementById('btnCollect');
  var btnBrowse = document.getElementById('btnBrowse');
  var btnReset = document.getElementById('btnReset');
  if (btnCollect) btnCollect.classList.toggle('hidden', isBrowse);
  if (btnBrowse) btnBrowse.classList.toggle('hidden', !isBrowse);
  if (btnReset) btnReset.classList.toggle('hidden', isBrowse);
  if (isBrowse && typeof window.syncBrowseSettingsUI === 'function') {
    window.syncBrowseSettingsUI();
  }
};

window.updateBrowseProgress = function (stats) {
  stats = stats || {};
  var sent = stats.sent || 0;
  var skipped = stats.skipped || 0;
  var failed = stats.failed || 0;
  var processed = stats.processed || 0;
  var tag = stats.currentTag || '';
  var sessionSent = stats.sessionSent != null ? stats.sessionSent : sent;
  var sessionLimit = stats.sessionLimit != null ? stats.sessionLimit : (Store.get('browseSessionLimit') || 0);
  var dailyTotal = stats.dailyTotal;
  var elSent = document.getElementById('browseStatSent');
  var elSkip = document.getElementById('browseStatSkipped');
  var elFail = document.getElementById('browseStatFailed');
  if (elSent) elSent.textContent = String(sent);
  if (elSkip) elSkip.textContent = String(skipped);
  if (elFail) elFail.textContent = String(failed);
  var tagEl = document.getElementById('browseCurrentTag');
  if (tagEl) {
    if (tag === '当前页面') {
      tagEl.textContent = '扫描当前页面卡片…';
    } else {
      tagEl.textContent = tag ? ('当前：' + tag) : '扫描岗位卡片中…';
    }
  }
  var sessionQuota = document.getElementById('browseSessionQuota');
  if (sessionQuota) {
    sessionQuota.textContent = sessionLimit > 0
      ? ('本次 ' + sessionSent + ' / ' + sessionLimit)
      : ('本次 ' + sessionSent);
  }
  var dailyQuota = document.getElementById('browseDailyQuota');
  if (dailyQuota) {
    if (typeof dailyTotal === 'number') {
      dailyQuota.textContent = '今日累计 ' + dailyTotal;
      var dailyDisplay = document.getElementById('browseDailyCountDisplay');
      if (dailyDisplay) dailyDisplay.textContent = String(dailyTotal);
    } else {
      window.refreshBrowseDailyCount();
    }
  }
  var txt = document.getElementById('browseProgressText');
  var sub = document.getElementById('browseProgressSub');
  var fill = document.getElementById('browseProgressFill');
  if (txt) {
    if (sessionLimit > 0 && sessionSent >= sessionLimit) {
      txt.textContent = '已达到本次投递上限（' + sessionLimit + '）';
    } else {
      txt.textContent = sent > 0 ? ('已成功投递 ' + sent + ' 个岗位') : '正在浏览岗位…';
    }
  }
  if (sub) sub.textContent = '已扫描 ' + processed + ' 张卡片 · 跳过 ' + skipped + (failed ? (' · 未成功 ' + failed) : '');
  if (fill) {
    if (sessionLimit > 0) {
      fill.classList.remove('indeterminate');
      fill.style.width = Math.min(8 + Math.round(sessionSent / sessionLimit * 84), 92) + '%';
    } else if (processed > 0) {
      fill.classList.remove('indeterminate');
      fill.style.width = Math.min(15 + processed * 2, 92) + '%';
    } else {
      fill.classList.add('indeterminate');
    }
  }
};

window.showBrowseDone = function (stats, reason) {
  stats = stats || {};
  var section = document.getElementById('browseDoneSection');
  var statsEl = document.getElementById('browseDoneStats');
  var stopBtn = document.getElementById('btnStopBrowse');
  var tagEl = document.getElementById('browseCurrentTag');
  if (stopBtn) stopBtn.classList.add('hidden');
  if (tagEl) tagEl.textContent = reason === 'sessionLimit' ? '已达本次上限' : '已完成';
  if (section) section.classList.remove('hidden');
  if (statsEl) {
    var limit = Store.get('browseSessionLimit') || 0;
    statsEl.innerHTML = '成功投递 <strong>' + (stats.sent || 0) + '</strong> 个'
      + (limit > 0 ? ('（本次上限 ' + limit + '）') : '') + '<br>'
      + '跳过 ' + (stats.skipped || 0) + ' 个（已沟通 / 排除 / 从聊天页返回）<br>'
      + (stats.failed ? ('未出现成功弹窗 ' + stats.failed + ' 个<br>') : '')
      + '成功标准：弹窗「已向BOSS发送消息」并点击「留在此页」。';
  }
  var txt = document.getElementById('browseProgressText');
  if (txt) {
    txt.textContent = reason === 'sessionLimit' ? '本次投递已达上限，已自动停止' : '浏览投递已完成';
  }
  window.refreshBrowseDailyCount();
};

window.buildBrowseParams = function () {
  var state = Store.get();
  var sessionLimit = typeof normalizeBrowseSessionLimit === 'function'
    ? normalizeBrowseSessionLimit(state.browseSessionLimit)
    : (parseInt(state.browseSessionLimit, 10) || 0);
  return {
    titleExcludeKeywords: state.titleExcludeKeywords || '',
    companyExcludeKeywords: state.companyExcludeKeywords || '',
    hrActiveFilter: state.hrActiveFilter || '不限',
    browseScope: state.browseScope || 'current',
    sessionLimit: sessionLimit,
    sourceTabId: state.browseSourceTabId || null,
    sourceTabUrl: state.browseSourceTabUrl || '',
  };
};

window.captureBrowseSourceTab = function (cb) {
  if (typeof chrome === 'undefined' || !chrome.tabs) {
    if (cb) cb(null);
    return;
  }
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, function (tabs) {
    var t = tabs && tabs[0];
    if (t && t.id) {
      Store.set('browseSourceTabId', t.id);
      Store.set('browseSourceTabUrl', t.url || '');
    }
    if (cb) cb(t || null);
  });
};

window.initEventsBrowse = function () {
  if (window._eventsBrowseInitialized) return;
  window._eventsBrowseInitialized = true;

  var modeBar = document.getElementById('workModeBar');
  if (modeBar) {
    modeBar.addEventListener('click', function (e) {
      var btn = e.target.closest('.work-mode-btn');
      if (!btn) return;
      var mode = btn.dataset.workMode;
      if (!mode || mode === Store.get('workMode')) return;
      Store.set('workMode', mode);
      window.applyWorkModeUI();
      try { persistFilterState(); } catch (_) {}
    });
  }

  var scopeChips = document.getElementById('browseScopeChips');
  if (scopeChips) {
    scopeChips.addEventListener('click', function (e) {
      var chip = e.target.closest('[data-browse-scope]');
      if (!chip) return;
      var scope = chip.dataset.browseScope;
      if (!scope || scope === Store.get('browseScope')) return;
      Store.set('browseScope', scope);
      window.syncBrowseSettingsUI();
      try { persistFilterState(); } catch (_) {}
    });
  }

  var sessionLimitEl = document.getElementById('browseSessionLimit');
  if (sessionLimitEl) {
    sessionLimitEl.addEventListener('change', function () {
      var v = typeof normalizeBrowseSessionLimit === 'function'
        ? normalizeBrowseSessionLimit(sessionLimitEl.value)
        : (parseInt(sessionLimitEl.value, 10) || 0);
      Store.set('browseSessionLimit', v);
      sessionLimitEl.value = String(v);
      try { persistFilterState(); } catch (_) {}
    });
  }

  var btnBrowse = document.getElementById('btnBrowse');
  if (btnBrowse) {
    btnBrowse.addEventListener('click', function () {
      if (typeof window.toBrowse === 'function') window.toBrowse();
    });
  }

  var btnStopBrowse = document.getElementById('btnStopBrowse');
  if (btnStopBrowse) {
    btnStopBrowse.addEventListener('click', function () {
      chrome.runtime.sendMessage({ type: MSG.STOP_BROWSE }, function () {
        Store.set('browsing', false);
        btnStopBrowse.textContent = '正在停止…';
        btnStopBrowse.disabled = true;
      });
    });
  }

  var btnBrowseBack = document.getElementById('btnBrowseBack');
  if (btnBrowseBack) {
    btnBrowseBack.addEventListener('click', function () {
      if (typeof window.toSettings === 'function') window.toSettings();
    });
  }

  window.syncBrowseSettingsUI();
  if (typeof window.captureBrowseSourceTab === 'function') {
    window.captureBrowseSourceTab();
  }
};
