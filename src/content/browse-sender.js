// 浏览模式投递 — BOSS 首页推荐标签 → 逐卡片「立即沟通」→ 仅弹窗「已向BOSS发送消息」算成功 → 点「留在此页」
var BrowseSender = {
  stopped: false,

  stop: function () {
    this.stopped = true;
    if (typeof JobCollector !== 'undefined') JobCollector.stopped = true;
  },

  _isStopped: function () {
    return this.stopped || (typeof JobCollector !== 'undefined' && JobCollector.stopped);
  },

  _sleep: function (ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  },

  _isJobsPage: function () {
    return location.pathname.indexOf('/web/geek/jobs') === 0;
  },

  _isChatPage: function () {
    return location.pathname.indexOf('/web/geek/chat') >= 0;
  },

  _report: function (payload) {
    try {
      chrome.runtime.sendMessage(Object.assign({ type: MSG.BROWSE_PROGRESS }, payload)).catch(function () {});
    } catch (_) {}
  },

  _reachedSessionLimit: function (params, stats) {
    var lim = params.sessionLimit || 0;
    return lim > 0 && stats.sent >= lim;
  },

  _reportItem: function (payload) {
    try {
      chrome.runtime.sendMessage(Object.assign({ type: MSG.BROWSE_ITEM_RESULT }, payload)).catch(function () {});
    } catch (_) {}
  },

  // 点击卡片前：岗位名/公司名排除 + 已投递去重（不依赖右侧 HR 面板）
  passFilter: function (job, params) {
    if (!job || !job.id) return { ok: false, reason: 'invalid' };
    var applied = params.appliedJobIds || [];
    if (applied.indexOf(job.id) >= 0) return { ok: false, reason: 'alreadyApplied' };
    if (typeof jobMatchesExcludeTitle === 'function' && jobMatchesExcludeTitle(job, params.titleExcludeKeywords)) {
      return { ok: false, reason: 'titleExcluded' };
    }
    if (typeof jobMatchesExcludeCompany === 'function' && jobMatchesExcludeCompany(job, params.companyExcludeKeywords)) {
      return { ok: false, reason: 'companyExcluded' };
    }
    return { ok: true };
  },

  // 误进聊天页 → 返回岗位列表继续
  _recoverFromChatPage: async function () {
    try {
      if (typeof DiagLogger !== 'undefined') DiagLogger.info('cs.browse', '检测到进入聊天页，history.back 返回');
    } catch (_) {}
    try { history.back(); } catch (_) {}
    for (var i = 0; i < 20; i++) {
      await this._sleep(300);
      if (this._isJobsPage()) return true;
    }
    return this._isJobsPage();
  },

  _findGreetSuccessDialog: function () {
    var candidates = document.querySelectorAll(
      '.greet-boss-dialog, .dialog-wrap .greet-boss-container, .dialog-wrap'
    );
    for (var d = 0; d < candidates.length; d++) {
      var dlg = candidates[d];
      if (dlg.offsetHeight <= 0) continue;
      var txt = (dlg.textContent || '').trim();
      // 成功弹窗：「已向BOSS发送消息」+「留在此页」
      if (txt.indexOf('已向BOSS发送消息') >= 0 || (txt.indexOf('留在此页') >= 0 && txt.indexOf('继续沟通') >= 0)) {
        var root = dlg.classList.contains('greet-boss-dialog') ? dlg : (dlg.querySelector('.greet-boss-dialog') || dlg);
        return root;
      }
    }
    return null;
  },

  // 等成功弹窗出现；若整页跳聊天则返回 chatNav
  _waitForGreetSuccessDialog: async function (timeoutMs) {
    var deadline = Date.now() + (timeoutMs || 8000);
    while (Date.now() < deadline) {
      if (this._isStopped()) return { type: 'stopped' };
      if (this._isChatPage()) return { type: 'chatNav' };
      var dlg = this._findGreetSuccessDialog();
      if (dlg) return { type: 'dialog', dlg: dlg };
      await this._sleep(200);
    }
    if (this._isChatPage()) return { type: 'chatNav' };
    return { type: 'none' };
  },

  _clickStayOnPageInDialog: async function (dlg) {
    var root = dlg || this._findGreetSuccessDialog();
    if (!root) return false;
    var scope = root.closest('.dialog-wrap') || root;
    var cancelBtns = scope.querySelectorAll('.greet-boss-footer a.cancel-btn, a.cancel-btn, .default-btn.cancel-btn');
    for (var c = 0; c < cancelBtns.length; c++) {
      var btn = cancelBtns[c];
      if (btn.offsetHeight <= 0) continue;
      var txt = (btn.textContent || '').trim();
      if (txt.indexOf('留在此页') >= 0) {
        btn.click();
        await this._sleep(500);
        try {
          if (typeof DiagLogger !== 'undefined') DiagLogger.info('cs.browse', '成功弹窗已点「留在此页」');
        } catch (_) {}
        return true;
      }
    }
    return false;
  },

  _processCard: async function (card, params, stats) {
    if (this._isStopped()) return false;
    if (!this._isJobsPage()) {
      await this._recoverFromChatPage();
      return false;
    }

    var welfareMap = typeof JobCollector !== 'undefined' && JobCollector.readWelfareMap
      ? JobCollector.readWelfareMap() : null;
    var job = JobCollector.parseCard(card, welfareMap);
    if (!job.id) return false;

    if (params.processedIds[job.id]) return false;
    params.processedIds[job.id] = true;

    // ① 点卡片前先排除岗位名/公司名
    var filterResult = this.passFilter(job, params);
    if (!filterResult.ok) {
      stats.skipped++;
      this._reportItem({ job: job, success: false, skipped: true, skipReason: filterResult.reason });
      return false;
    }

    if (typeof detectCaptcha === 'function' && detectCaptcha().detected) {
      stats.failed++;
      this._reportItem({ job: job, success: false, error: 'captcha' });
      return false;
    }

    card.scrollIntoView({ block: 'center', behavior: 'instant' });
    await this._sleep(300);
    if (this._isStopped()) return false;

    card.click();
    await this._sleep(700);

    // ② 点卡片后若整页进聊天（多半已沟通过）→ 返回，不算成功
    if (this._isChatPage()) {
      await this._recoverFromChatPage();
      stats.skipped++;
      this._reportItem({ job: job, success: false, skipped: true, skipReason: 'navigatedToChat', alreadyChatted: true });
      return false;
    }
    if (!this._isJobsPage()) {
      try { history.back(); await this._sleep(1200); } catch (_) {}
      stats.skipped++;
      this._reportItem({ job: job, success: false, skipped: true, skipReason: 'unexpectedNav' });
      return false;
    }

    var bossInfo = await waitForElement('.job-boss-info', 6000);
    if (!bossInfo) bossInfo = document.querySelector('.job-boss-info');
    if (!bossInfo) {
      stats.failed++;
      this._reportItem({ job: job, success: false, error: '无法打开岗位详情' });
      return false;
    }

    // ③ 右侧 HR 面板：活跃度筛选
    if (typeof passActivityFilter === 'function' && typeof parseHrActivity === 'function') {
      var _act = parseHrActivity(
        (bossInfo.querySelector('.boss-online-tag') || {}).textContent || '',
        (bossInfo.querySelector('.boss-active-time') || {}).textContent || ''
      );
      if (!passActivityFilter(params.hrActiveFilter, _act)) {
        stats.skipped++;
        this._reportItem({ job: job, success: false, skipped: true, skipReason: 'hrInactive', activeDesc: _act.desc });
        return false;
      }
    }

    var chatBtn = await waitForElement(SELECTORS.jobs.immediateChatBtn, 5000);
    if (!chatBtn) {
      stats.failed++;
      this._reportItem({ job: job, success: false, error: '未找到沟通按钮' });
      return false;
    }

    var chatBtnTxt = (chatBtn.textContent || '').trim();
    if (chatBtnTxt.indexOf('继续沟通') >= 0) {
      stats.skipped++;
      this._reportItem({ job: job, success: false, skipped: true, skipReason: 'alreadyChatted', alreadyChatted: true });
      return false;
    }

    if (this._isStopped()) return false;
    var _mOpts = { bubbles: true, cancelable: true, view: window, button: 0 };
    chatBtn.dispatchEvent(new MouseEvent('mousedown', _mOpts));
    chatBtn.dispatchEvent(new MouseEvent('mouseup', _mOpts));
    chatBtn.dispatchEvent(new MouseEvent('click', _mOpts));

    // ④ 仅当出现「已向BOSS发送消息」弹窗才算投递成功
    var waitResult = await this._waitForGreetSuccessDialog(8000);

    if (waitResult.type === 'chatNav') {
      await this._recoverFromChatPage();
      stats.skipped++;
      this._reportItem({ job: job, success: false, skipped: true, skipReason: 'navigatedToChatAfterChat', alreadyChatted: true });
      return false;
    }
    if (waitResult.type === 'stopped') return false;
    if (waitResult.type !== 'dialog') {
      stats.failed++;
      this._reportItem({ job: job, success: false, error: '未出现投递成功弹窗（已向BOSS发送消息）' });
      return false;
    }

    var stayed = await this._clickStayOnPageInDialog(waitResult.dlg);
    if (!stayed) {
      stats.failed++;
      this._reportItem({ job: job, success: false, error: '成功弹窗出现但未点到「留在此页」' });
      return false;
    }

    await this._sleep(400);
    if (!this._isJobsPage()) {
      await this._recoverFromChatPage();
    }

    stats.sent++;
    this._reportItem({ job: job, success: true, sent: true, greetDialog: true });
    if (this._reachedSessionLimit(params, stats)) {
      this.stop();
    }
    return true;
  },

  _processCurrentPage: async function (params, stats) {
    if (!this._isJobsPage()) {
      await this._recoverFromChatPage();
      return;
    }
    var cards = queryAllJobCards(document).nodes;
    for (var i = 0; i < cards.length; i++) {
      if (this._isStopped()) break;
      if (!this._isJobsPage()) {
        await this._recoverFromChatPage();
        continue;
      }
      await this._processCard(cards[i], params, stats);
      stats.processed++;
      this._report({
        sent: stats.sent,
        skipped: stats.skipped,
        failed: stats.failed,
        processed: stats.processed,
        currentTag: params.currentTag || '',
        sessionSent: stats.sent,
        sessionLimit: params.sessionLimit || 0,
      });
      if (this._reachedSessionLimit(params, stats)) break;
      var interval = 1500 + Math.floor(Math.random() * 1500);
      await this._sleep(interval);
    }
  },

  _collectTags: function () {
    var tags = [];
    var seen = {};
    var sels = (SELECTORS.jobs.expectItemFallbacks || []).concat([SELECTORS.jobs.expectItem]);
    for (var si = 0; si < sels.length; si++) {
      document.querySelectorAll(sels[si]).forEach(function (el) {
        var textEl = el.querySelector('span.text-content') || el.querySelector('.text-content') || el;
        var text = (textEl.textContent || '').trim();
        if (!text || seen[text]) return;
        seen[text] = true;
        tags.push({ el: el, text: text });
      });
      if (tags.length) break;
    }
    return tags;
  },

  run: async function (params) {
    this.stopped = false;
    if (typeof JobCollector !== 'undefined') JobCollector.stopped = false;
    params = params || {};
    params.processedIds = params.processedIds || {};
    var stats = { sent: 0, skipped: 0, failed: 0, processed: 0 };

    if (!this._isJobsPage()) {
      try {
        if (typeof DiagLogger !== 'undefined') DiagLogger.warn('cs.browse', '不在岗位页，中止 path=' + location.pathname);
      } catch (_) {}
      throw new Error('请先打开 BOSS 岗位首页 /web/geek/jobs');
    }

    var scope = params.browseScope || params.scope || 'current';
    var tagsToRun;
    if (scope === 'recommend') {
      tagsToRun = this._collectTags();
      if (tagsToRun.length === 0) {
        tagsToRun = [{ el: null, text: '当前列表', skipClick: true }];
      }
    } else {
      tagsToRun = [{ el: null, text: '当前页面', skipClick: true }];
    }
    try {
      if (typeof DiagLogger !== 'undefined') {
        DiagLogger.info('cs.browse', '浏览投递开始 scope=' + scope + ' 标签=' + tagsToRun.map(function (t) { return t.text; }).join(' | '));
      }
    } catch (_) {}

    for (var ti = 0; ti < tagsToRun.length; ti++) {
      if (this._isStopped()) break;
      if (this._reachedSessionLimit(params, stats)) break;
      if (!this._isJobsPage()) {
        var ok = await this._recoverFromChatPage();
        if (!ok) break;
      }
      var tag = tagsToRun[ti];
      params.currentTag = tag.text;
      this._report({
        phase: 'tag',
        currentTag: tag.text,
        tagIndex: ti,
        tagTotal: tagsToRun.length,
        sent: stats.sent,
        skipped: stats.skipped,
        failed: stats.failed,
        sessionSent: stats.sent,
        sessionLimit: params.sessionLimit || 0,
      });

      if (!tag.skipClick && tag.el) {
        try { tag.el.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'instant' }); } catch (_) {}
        await this._sleep(200);
        tag.el.click();
        await this._sleep(2000);
      }

      var scrollRounds = 0;
      var noNewRounds = 0;
      var prevSeen = Object.keys(params.processedIds).length;

      while (!this._isStopped() && scrollRounds < 25 && noNewRounds < 3) {
        if (this._reachedSessionLimit(params, stats)) break;
        if (!this._isJobsPage()) {
          await this._recoverFromChatPage();
        }
        await this._processCurrentPage(params, stats);
        var nowSeen = Object.keys(params.processedIds).length;
        if (nowSeen <= prevSeen) {
          noNewRounds++;
        } else {
          noNewRounds = 0;
          prevSeen = nowSeen;
        }
        window.scrollTo(0, document.body.scrollHeight);
        await this._sleep(1500);
        scrollRounds++;
      }
    }

    try {
      chrome.runtime.sendMessage({
        type: MSG.BROWSE_COMPLETE,
        sent: stats.sent,
        skipped: stats.skipped,
        failed: stats.failed,
        reason: this._reachedSessionLimit(params, stats) ? 'sessionLimit' : (this._isStopped() ? 'stopped' : 'done'),
      }).catch(function () {});
    } catch (_) {}

    try {
      if (typeof DiagLogger !== 'undefined') {
        DiagLogger.info('cs.browse', '浏览投递结束 sent=' + stats.sent + ' skipped=' + stats.skipped + ' failed=' + stats.failed);
      }
    } catch (_) {}

    return stats;
  },
};
