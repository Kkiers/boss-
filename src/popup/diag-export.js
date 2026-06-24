// ════════════════════════════════════════════════════════════
// 即投 — 诊断包导出（popup 设置抽屉「问题反馈」区）— 纯新增模块
// 主入口：复制诊断信息（精简文本进剪贴板，微信可直接粘贴）
// 次入口：下载完整诊断文件（全量 JSON，复杂 case 用）
// 脱敏红线：不含简历内容/图片、招呼语全文(截断≤20字)、手机号、cookie/token、API key
// ════════════════════════════════════════════════════════════
(function () {
  'use strict';

  var ERRORLOG_KEY = 'extension:errorLog';
  var SENDRESULTS_KEY = 'sw:sendResults';
  var LASTSNAPSHOT_KEY = 'sw:lastSnapshot';
  var RECENTRUNS_KEY = 'diag:recentRuns';

  // ── 输出级脱敏（最后一道闸，整段文本统一过一遍）──
  function sanitizeText(s) {
    s = String(s == null ? '' : s);
    s = s.replace(/sk-[A-Za-z0-9]{16,}/g, 'sk-[已脱敏]');
    s = s.replace(/(^|[^\d])1[3-9]\d{9}(?!\d)/g, '$11**********');
    // Bearer token / cookie 形态兜底
    s = s.replace(/Bearer\s+[A-Za-z0-9._\-]{12,}/g, 'Bearer [已脱敏]');
    return s;
  }

  function truncate(s, n) {
    s = String(s == null ? '' : s);
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  function fmtTime(ts) {
    try {
      var d = new Date(ts);
      function p(x) { return (x < 10 ? '0' : '') + x; }
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
        p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    } catch (e) { return String(ts); }
  }

  function getStorage(keys) {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get(keys, function (r) {
          resolve(chrome.runtime.lastError ? {} : (r || {}));
        });
      } catch (e) { resolve({}); }
    });
  }

  // SW 状态快照（2s 超时兜底：SW 没响应也能出包）
  function getSwState() {
    return new Promise(function (resolve) {
      var done = false;
      var timer = setTimeout(function () { if (!done) { done = true; resolve(null); } }, 2000);
      try {
        chrome.runtime.sendMessage({ type: MSG.GET_STATE }, function (resp) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve((!chrome.runtime.lastError && resp && resp.success && resp.state) ? resp.state : null);
        });
      } catch (e) {
        if (!done) { done = true; clearTimeout(timer); resolve(null); }
      }
    });
  }

  function getDiagLogs() {
    return new Promise(function (resolve) {
      try {
        if (typeof DiagLogger === 'undefined') { resolve([]); return; }
        DiagLogger.flush();
        DiagLogger.getAll(function (entries) { resolve(entries || []); });
      } catch (e) { resolve([]); }
    });
  }

  // ── 状态快照（脱敏：招呼语只留前 20 字；绝不 dump apiKey/简历） ──
  function buildSnapshot(swState, storageData) {
    var snap = {};
    if (swState) {
      snap.phase = swState.phase;
      snap.sendPhase = swState.sendPhase || '';
      snap.jobs = (swState.jobs || []).length;
      snap.sendQueueV6 = (swState.sendQueueV6 || []).length;
      snap.sendQueueV6Index = swState.sendQueueV6Index || 0;
      snap.sendProgress = swState.sendProgress || {};
      snap.greetingProgress = swState.greetingProgress || {};
      snap.selectedPositions = swState.selectedPositions || [];
      snap.customPositions = swState.customPositions || [];
      snap.hrActiveFilter = swState.hrActiveFilter || '不限';
      snap.workerTabs = (swState._v6WorkerTabIds || []).length;
      var g = swState.greetings || {};
      snap.greetings = {};
      for (var k in g) {
        if (Object.prototype.hasOwnProperty.call(g, k)) {
          snap.greetings[k] = truncate(g[k], 20) + ' (len=' + String(g[k] || '').length + ')';
        }
      }
    } else {
      snap.swUnreachable = true; // SW 无响应本身就是关键诊断信号
      // SW 卸载回退：优先读 persistState 旁路落盘的脱敏快照摘要（含 jobs/queue/greetings），
      // 拿不到再退回零散 phase key。sw:lastSnapshot 已在 SW 侧脱敏，此处原样带出。
      var ls = storageData[LASTSNAPSHOT_KEY];
      if (ls && typeof ls === 'object') {
        snap.fromLastSnapshot = true;
        snap.lastSnapshotTime = ls.ts ? fmtTime(ls.ts) : '';
        snap.phase = ls.phase;
        snap.sendPhase = ls.sendPhase || '';
        snap.jobs = ls.jobs || 0;
        snap.sendQueueV6 = ls.sendQueueV6 || 0;
        snap.sendQueueV6Index = ls.sendQueueV6Index || 0;
        snap.sendProgress = ls.sendProgress || {};
        snap.greetingProgress = ls.greetingProgress || {};
        snap.selectedPositions = ls.selectedPositions || [];
        snap.customPositions = ls.customPositions || [];
        snap.hrActiveFilter = ls.hrActiveFilter || '不限';
        snap.workerTabs = ls.workerTabs || 0;
        snap.greetings = ls.greetings || {};
      } else {
        snap.phaseFromStorage = storageData['sw:phase'] || '';
        snap.sendPhaseFromStorage = storageData['sw:sendPhase'] || '';
      }
    }
    // 诊断包：当天投递计数器（LimitGate 真相，直读 storage；脱敏：仅数值+日期）
    try {
      var dsc = storageData['sw:dailySendCount'];
      if (dsc && typeof dsc === 'object') {
        snap.dailySendCount = { date: dsc.date || '', count: (typeof dsc.count === 'number' ? dsc.count : '') };
      } else {
        snap.dailySendCount = dsc != null ? dsc : null;
      }
    } catch (e) {}
    return snap;
  }

  function summarizeSendResults(results) {
    results = Array.isArray(results) ? results : [];
    var ok = 0, fail = 0, skip = 0, failures = [];
    for (var i = 0; i < results.length; i++) {
      var r = results[i] || {};
      if (r.success) ok++;
      else { if (r.skipped) skip++; else fail++; }
      if (!r.success) {
        failures.push({
          position: truncate(r.positionName, 30),
          company: truncate(r.companyName, 30),
          error: truncate(r.error, 120),
          time: r.time ? fmtTime(r.time) : '',
        });
      }
    }
    return { total: results.length, ok: ok, fail: fail, skip: skip, failures: failures };
  }

  // ── 收集全部素材 ──
  function collectBundle() {
    return Promise.all([
      getSwState(),
      getStorage([ERRORLOG_KEY, SENDRESULTS_KEY, LASTSNAPSHOT_KEY, RECENTRUNS_KEY, 'sw:phase', 'sw:sendPhase', 'sw:dailySendCount']),
      getDiagLogs(),
    ]).then(function (arr) {
      var swState = arr[0], storageData = arr[1], diagLogs = arr[2];
      var manifest = {};
      try { manifest = chrome.runtime.getManifest(); } catch (e) {}
      return {
        env: {
          extension: (manifest.name || '即投') + ' v' + (manifest.version || '?'),
          ua: (typeof navigator !== 'undefined' ? navigator.userAgent : ''),
          time: fmtTime(Date.now()),
        },
        snapshot: buildSnapshot(swState, storageData),
        diagLogs: diagLogs,
        errorLog: storageData[ERRORLOG_KEY] || [],
        sendSummary: summarizeSendResults(storageData[SENDRESULTS_KEY]),
        sendResultsFull: storageData[SENDRESULTS_KEY] || [],
        recentRuns: Array.isArray(storageData[RECENTRUNS_KEY]) ? storageData[RECENTRUNS_KEY] : [],
      };
    });
  }

  // ── 精简文本（人能扫读 / AI 能解析） ──
  function buildText(b) {
    var L = [];
    L.push('═══ 即投诊断信息 ═══');
    L.push('');
    L.push('【环境】');
    L.push('扩展: ' + b.env.extension);
    L.push('UA: ' + b.env.ua);
    L.push('导出时间: ' + b.env.time);
    L.push('');
    L.push('【状态快照】');
    L.push(JSON.stringify(b.snapshot, null, 1));
    L.push('');

    var userEvents = [], errors = [], normals = [];
    for (var i = 0; i < b.diagLogs.length; i++) {
      var e = b.diagLogs[i];
      if (!e) continue;
      var line = fmtTime(e.ts) + ' [' + e.ctx + '/' + e.module + '] ' + e.msg;
      if (e.level === 'USER_EVENT') userEvents.push(line);
      else if (e.level === 'ERROR') errors.push('ERROR ' + line);
      else normals.push((e.level || 'INFO') + ' ' + line);
    }

    L.push('【用户事件 USER_EVENT】（区分程序bug vs 用户操作打断的关键）');
    var ue = userEvents.slice(-100);
    L.push(ue.length ? ue.join('\n') : '（无）');
    L.push('');

    L.push('【错误 ERROR】');
    var errLines = errors.slice(-50);
    var legacy = (b.errorLog || []).slice(0, 30); // errorLog 最新在前
    for (var j = 0; j < legacy.length; j++) {
      var le = legacy[j] || {};
      errLines.push('ERRLOG ' + fmtTime(le.timestamp) + ' [' + truncate(le.context, 40) + '] ' + truncate(le.message, 200));
    }
    L.push(errLines.length ? errLines.join('\n') : '（无）');
    L.push('');

    L.push('【最近日志】（最近 50 条）');
    var nl = normals.slice(-50);
    L.push(nl.length ? nl.join('\n') : '（无）');
    L.push('');

    L.push('【最近一次投递结果】');
    L.push('总计=' + b.sendSummary.total + ' 成功=' + b.sendSummary.ok + ' 失败=' + b.sendSummary.fail + ' 跳过=' + b.sendSummary.skip);
    var fs = b.sendSummary.failures.slice(0, 30);
    for (var f = 0; f < fs.length; f++) {
      L.push('✗ ' + fs[f].position + ' @' + fs[f].company + ' — ' + fs[f].error + (fs[f].time ? ' (' + fs[f].time + ')' : ''));
    }
    if (b.sendSummary.failures.length > 30) L.push('…另有 ' + (b.sendSummary.failures.length - 30) + ' 条失败略');
    L.push('');

    // ── 最近 5 次投递滚动诊断（每份带醒目时间窗标签，便于按用户口述的大概时间定位）──
    L.push('【最近投递记录】（最近 ' + (b.recentRuns || []).length + ' 次，按时间窗定位）');
    var runs = (b.recentRuns || []).slice().reverse(); // 最新在前
    if (!runs.length) {
      L.push('（无历史投递记录）');
    } else {
      for (var ri = 0; ri < runs.length; ri++) {
        var run = runs[ri] || {};
        var s = run.sendSummary || {};
        L.push('━━━ 投递时间 ' + (run.endTs ? fmtTime(run.endTs) : '?') + ' ┃ 结束原因=' + (run.reason || '?') + ' ━━━');
        L.push('  总计=' + (s.total || 0) + ' 成功=' + (s.ok || 0) + ' 失败=' + (s.fail || 0) + ' 跳过=' + (s.skip || 0));
        var rf = (run.failures || []).slice(0, 15);
        for (var rfi = 0; rfi < rf.length; rfi++) {
          L.push('  ✗ ' + (rf[rfi].position || '') + ' @' + (rf[rfi].company || '') + ' — ' + (rf[rfi].error || '') + (rf[rfi].time ? ' (' + fmtTime(rf[rfi].time) + ')' : ''));
        }
        if ((run.failures || []).length > 15) L.push('  …另有 ' + (run.failures.length - 15) + ' 条失败略');
      }
    }
    L.push('');
    L.push('═══ END ═══');
    return sanitizeText(L.join('\n'));
  }

  // ── 完整 JSON（次入口下载用） ──
  function buildFullJson(b) {
    var full = {
      env: b.env,
      snapshot: b.snapshot,
      diagLogs: b.diagLogs,
      errorLog: b.errorLog,
      sendResults: b.sendResultsFull,
      recentRuns: b.recentRuns || [],   // 最近 5 次投递滚动诊断（含时间窗+脱敏 snapshot+sendResults 摘要）
    };
    // 整段 JSON 字符串统一过脱敏闸
    return sanitizeText(JSON.stringify(full, null, 2));
  }

  function copyToClipboard(text) {
    return new Promise(function (resolve) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function () { resolve(true); }, function () {
            resolve(fallbackCopy(text));
          });
          return;
        }
      } catch (e) {}
      resolve(fallbackCopy(text));
    });
  }

  function fallbackCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return !!ok;
    } catch (e) { return false; }
  }

  function flashBtn(btn, text, originText) {
    btn.textContent = text;
    btn.disabled = true;
    setTimeout(function () { btn.textContent = originText; btn.disabled = false; }, 1600);
  }

  function wire() {
    var btnDl = document.getElementById('btnDiagDownload');
    if (btnDl) {
      btnDl.addEventListener('click', function (ev) {
        ev.preventDefault();
        try { if (typeof DiagLogger !== 'undefined') DiagLogger.userEvent('popup', '用户点击「下载完整诊断文件」'); } catch (_) {}
        collectBundle().then(function (b) {
          var json = buildFullJson(b);
          var blob = new Blob([json], { type: 'application/json' });
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a');
          var d = new Date();
          function p(x) { return (x < 10 ? '0' : '') + x; }
          a.href = url;
          a.download = 'jitou-diag-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + '.json';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
        }).catch(function () {});
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
})();
