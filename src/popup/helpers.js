// ════════════════════════════════════════════════════════════
// 即投 — DOM 工具函数
// ════════════════════════════════════════════════════════════

window.$ = function $(sel, ctx) {
  return (ctx || document).querySelector(sel);
};

window.$$ = function $$(sel, ctx) {
  return [].slice.call((ctx || document).querySelectorAll(sel));
};

// ── 原子化 chrome.storage resumeImages 操作 ──
// 避免 upload / remove 之间的 get-then-set 竞态
// 用 Promise 链串行化所有读写，确保一次只执行一个 get-then-set 周期
var _resumeImagesChain = Promise.resolve();

function atomicUpdateResumeImages(transformFn) {
  _resumeImagesChain = _resumeImagesChain.then(function() {
    return new Promise(function(resolve) {
      chrome.storage.local.get('resumeImages', function(r) {
        try {
          var arr = transformFn(r.resumeImages || []);
          chrome.storage.local.set({resumeImages: arr}, resolve);
        } catch (e) {
          resolve(); // 不因异常打断链
        }
      });
    });
  });
  return _resumeImagesChain;
}

window.esc = function esc(str) {
  var d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
};

window.tog = function tog(arr, v) {
  var i = arr.indexOf(v);
  if (i >= 0) { arr.splice(i, 1); return false; }
  arr.push(v);
  return true;
};

window.togD = function togD(arr, v, h) {
  if (v === '不限' && h) { arr.length = 0; arr.push('不限'); return; }
  if (h) { var i = arr.indexOf('不限'); if (i >= 0) arr.splice(i, 1); }
  var i = arr.indexOf(v);
  if (i >= 0) arr.splice(i, 1);
  else arr.push(v);
  if (h && arr.length === 0) arr.push('不限');
};

// ── 采集 URL 透明面板：展示 buildCollectUrlPlan 生成的每条 BOSS 搜索链接 ──
window.renderCollectUrlPanel = function (plan, currentIndex, stats) {
  var panel = document.getElementById('collectUrlPanel');
  if (!panel) return;
  if (!plan || !plan.length) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');
  var countEl = document.getElementById('collectUrlCount');
  if (countEl) countEl.textContent = String(plan.length);
  var names = (typeof cityNameMap === 'function') ? cityNameMap() : {};
  var list = document.getElementById('collectUrlList');
  var html = '';
  for (var i = 0; i < plan.length; i++) {
    var p = plan[i];
    var cityLabel = names[p.cityCode] || p.cityCode || '城市';
    var label = cityLabel + ' · ' + (p.position || '（无关键词）');
    var active = (currentIndex >= 0 && i === currentIndex) ? ' collect-url-active' : '';
    html += '<div class="collect-url-row' + active + '">'
      + '<span class="collect-url-label">' + esc(label) + '</span>'
      + '<a class="collect-url-link" href="' + esc(p.url) + '" target="_blank" rel="noopener">' + esc(p.url) + '</a>'
      + '</div>';
  }
  if (list) list.innerHTML = html;
  var cur = document.getElementById('collectUrlCurrent');
  var idx = (currentIndex >= 0 && currentIndex < plan.length) ? currentIndex : 0;
  if (cur && plan[idx]) {
    cur.textContent = '正在采集 (' + (idx + 1) + '/' + plan.length + ')：' + plan[idx].url;
  }
  var stat = document.getElementById('collectUrlStat');
  if (stat && stats) {
    var parts = [];
    if (stats.loginRequired) parts.push('⚠️ 检测到 BOSS 登录页');
    if (stats.error) parts.push('⚠️ ' + stats.error);
    if (stats.domCardCount != null) parts.push('DOM 卡片 ' + stats.domCardCount + ' 个');
    if (stats.apiJobCount != null) parts.push('API 拦截 ' + stats.apiJobCount + ' 条');
    if (stats.cardSelector) parts.push('选择器 ' + stats.cardSelector);
    if (stats.rawCollected != null) parts.push('BOSS 页原始采集 ' + stats.rawCollected + ' 条');
    if (stats.maxCollect != null) parts.push('本页上限 ' + stats.maxCollect + ' 条');
    if (stats.jobsCollected != null) parts.push('去重后累计 ' + stats.jobsCollected + ' 条');
    if (stats.collectBeforeFilter != null) parts.push('过滤前 ' + stats.collectBeforeFilter + ' 条');
    if (stats.collectRawCount != null && stats.collectBeforeFilter == null) parts.push('原始 ' + stats.collectRawCount + ' 条');
    stat.textContent = parts.join(' · ');
  }
};

window.hideCollectUrlPanel = function () {
  var panel = document.getElementById('collectUrlPanel');
  if (panel) panel.classList.add('hidden');
};

window.loadAppliedJobIdSet=function(cb){
  if(typeof chrome==='undefined'||!chrome.storage||typeof STORAGE_KEYS==='undefined'){cb(new Set());return;}
  chrome.storage.local.get(STORAGE_KEYS.SW.APPLIED_JOB_IDS,function(r){
    cb(new Set(r[STORAGE_KEYS.SW.APPLIED_JOB_IDS]||[]));
  });
};

window.applyAppliedFlagsToJobs=function(jobs, cb){
  if(!jobs||!jobs.length){if(cb)cb(jobs);return jobs;}
  window.loadAppliedJobIdSet(function(applied){
    jobs.forEach(function(j){
      if(applied.has(j.id)){j.applied=true;j.checked=false;}
      else if(j.checked===undefined)j.checked=true;
    });
    if(cb)cb(jobs);
  });
  return jobs;
};

window.formatCollectQuotaHint=function(q){
  if(!q)return'';
  if(q.testMode&&typeof window.formatTestCollectQuotaHint==='function')return window.formatTestCollectQuotaHint(q);
  return '每个期望职位最多 '+q.perCityPerPosition+' 个/城（共 '+q.perPosition+' 个/职位，日沟通上限约 '+q.dailyCap+'）';
};

window.formatTestCollectQuotaHint=function(q){
  var n=(q&&q.positionCount)||1;
  var per=(q&&q.testJobsPerPosition)||(q&&q.perPosition)||1;
  return '测试模式：'+n+' 个期望职位，各 '+per+' 个岗位（仅用第一个目标城市）';
};

window.showTestModeBanner=function(show){
  var el=document.getElementById('testModeBanner');
  if(!el)return;
  if(!show){el.classList.add('hidden');el.textContent='';return;}
  var n=((Store.get('selectedPositions')||[]).concat(Store.get('customPositions')||[])).length||1;
  var per=typeof normalizeTestJobsPerPosition==='function'?normalizeTestJobsPerPosition(Store.get('testJobsPerPosition')):1;
  el.classList.remove('hidden');
  el.innerHTML='🧪 <strong>测试模式</strong>：已为 '+n+' 个期望职位各采集 '+per+' 个岗位。请核对每组招呼语，确认后再点「测试投递」，查看 BOSS 聊天中的实际发送内容。';
};

window.updateSendButtonLabel=function(){
  if(!E||!E.btnSend||Store.get('sending'))return;
  if(Store.get('testMode')){
    var c=(Store.get('jobs')||[]).filter(function(j){return j.checked}).length;
    E.btnSend.textContent=c>0?'测试投递 ('+c+')':'测试投递';
  }else{
    E.btnSend.textContent='一键发送';
  }
};

window.reapplyJobPriority=function(){
  var jobs=Store.get('jobs')||[];
  if(!jobs.length)return;
  var prefs=typeof window.getPriorityPrefs==='function'?window.getPriorityPrefs():{enabled:true};
  var picker=Store.get('selectedPositions')||[];
  var custom=Store.get('customPositions')||[];
  if(typeof annotateJobsWithPriority==='function')annotateJobsWithPriority(jobs,prefs,picker,custom);
  if(typeof sortJobsByPriority==='function')jobs=sortJobsByPriority(jobs,prefs,picker,custom);
  Store.set('jobs',jobs);
  var groups=Store.get('groups')||[];
  if(groups.length){
    groups.forEach(function(g){
      if(typeof sortJobsByPriority==='function')g.jobs=sortJobsByPriority(g.jobs||[],prefs,picker,custom);
    });
    Store.set('groups',groups);
    if(Store.get('mode')==='results'&&typeof window.renderGroupsStable==='function'){
      window.renderGroupsStable();
    }
  }
};
window.renderCollectQuotaHint=function(q){
  var el=document.getElementById('collectQuotaHint');
  if(!el)return;
  if(!q){el.classList.add('hidden');el.textContent='';return;}
  el.classList.remove('hidden');
  el.textContent=window.formatCollectQuotaHint(q);
};

window.getPriorityPrefs=function(){
  if(typeof buildPriorityPrefsFromStore==='function'){
    return buildPriorityPrefsFromStore(Store.get());
  }
  return{enabled:Store.get('prioritySortEnabled')!==false};
};

window.getSortedCheckedJobIds=function(){
  var jobs=Store.get('jobs')||[];
  var jobIds=jobs.filter(function(j){return j.checked}).map(function(j){return j.id});
  if(typeof sortJobIdsByPriority==='function'){
    var prefs=window.getPriorityPrefs();
    jobIds=sortJobIdsByPriority(jobIds,jobs,prefs,Store.get('selectedPositions')||[],Store.get('customPositions')||[]);
  }
  return jobIds;
};

window.showStopCollectBtn = function () {
  E.btnStopCollect.classList.remove('hidden');
  E.btnStopCollect.disabled = false;
  E.btnStopCollect.textContent = '停止采集';
};

window.resetStopCollectBtn = function () {
  if (!E.btnStopCollect) return;
  E.btnStopCollect.classList.add('hidden');
  E.btnStopCollect.disabled = false;
  E.btnStopCollect.textContent = '停止采集';
};

// 收集所有配置的附件简历名称，同步到 chrome.storage 供 ChatMonitor 读取
window.syncResumeFileNames = function syncResumeFileNames() {
  var names = [];
  var groups = Store.get('groups') || [];
  groups.forEach(function(g) {
    if (g.fileName && names.indexOf(g.fileName) < 0) names.push(g.fileName);
  });
  var jc = Store.get('jobCustom') || {};
  for (var id in jc) {
    var n = jc[id].customFileName;
    if (n && names.indexOf(n) < 0) names.push(n);
  }
  chrome.storage.local.set({ resumeFileNames: names });
};
