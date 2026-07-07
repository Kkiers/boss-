// ════════════════════════════════════════════════════════════
// 即投 — Popup 入口（路由 + 消息监听）
// ════════════════════════════════════════════════════════════
// Depends on: constants.js, tag-data.js, helpers.js, state.js
// Depends on: render-a.js, render-b.js, render-review.js
// Depends on: events-a.js, events-b.js

// ── 数组 → Data URL 转换（兼容 options 页上传的 data 格式） ──
window.arrayBufferToDataUrl=function(arr,mimeType){
  try{
    if(!arr||!arr.length)return null;
    var bytes=new Uint8Array(arr);
    // Chunked conversion avoids O(n^2) string concatenation
    var chunkSize=8192,chunks=[];
    for(var i=0;i<bytes.length;i+=chunkSize){
      chunks.push(String.fromCharCode.apply(null,bytes.subarray(i,i+chunkSize)));
    }
    return 'data:'+mimeType+';base64,'+btoa(chunks.join(''));
  }catch(e){return null}
};

// ── DOM References ──
var E={};
var _debounceJobsTimer=null;
let p1dPollHandle = null;
function initDomRefs(){
  E.headerLeft=$('#headerLeft');E.hdrTitle=$('#hdrTitle');E.btnBack=$('#btnBack');
  E.settingsPanel=$('#settingsPanel');E.resultsPanel=$('#resultsPanel');
  E.cityInput=$('#cityInput');E.cityChipContainer=$('#cityChipContainer');E.citySelectedArea=$('#citySelectedArea');
  E.posSearch=$('#posSearch');E.posSearchClear=$('#posSearchClear');E.posBrowseArea=$('#posBrowseArea');
  E.indSearch=$('#indSearch');E.indSearchClear=$('#indSearchClear');E.indArea=$('#indArea');
  E.expandIndustries=$('#expandIndustries');
  E.workAreaChips=$('#workAreaChips');E.jobTypeChips=$('#jobTypeChips');
  E.salaryChips=$('#salaryChips');E.expChips=$('#expChips');E.eduChips=$('#eduChips');
  E.sizeChips=$('#sizeChips');E.stageChips=$('#stageChips');
  E.bottomSettings=$('#bottomSettings');E.bottomResults=$('#bottomResults');
  E.btnReset=$('#btnReset');E.btnCollect=$('#btnCollect');E.btnSend=$('#btnSend');
  E.resultCountNum=$('#resultCountNum');E.resultCountTotal=$('#resultCountTotal');
  E.hiddenFileInput=$('#hiddenFileInput');E.hiddenFileInputB=$('#hiddenFileInputB');E.resumeThumbArea=$('#resumeThumbArea');
  E.progressSection=$('#progressSection');E.progressFill=$('#progressFill');
  E.progressText=$('#progressText');E.progressSub=$('#progressSub');
  E.btnStopCollect=$('#btnStopCollect');
  E.resultsContent=$('#resultsContent');E.groupedContent=$('#groupedContent');
  E.gearBtn=$('#gearBtn');E.settingsOverlay=$('#settingsOverlay');
  E.settingsClose=$('#settingsClose');
  E.workModeBar=$('#workModeBar');E.browsePanel=$('#browsePanel');
  E.browseSettingsPanel=$('#browseSettingsPanel');
  E.btnBrowse=$('#btnBrowse');
}

// ════════════════════════════════════════════════════════════
// ROUTE FUNCTIONS
// ════════════════════════════════════════════════════════════

function toSettings(){
  if(Store.get('browsing')||Store.get('mode')==='browse'){
    try{chrome.runtime.sendMessage({type:MSG.STOP_BROWSE})}catch(_){}
  }
  Store.set('mode','settings');Store.set('progressDone',false);
  Store.set('collecting',false);Store.set('sending',false);
  Store.set('browsing',false);Store.set('testMode',false);
  // 回 A 页＝放弃上一轮采集结果：清 Store + 渲染 DOM，否则重新筛选进 B 页会残留上次岗位/计数
  Store.set('jobs',[]);Store.set('groups',[]);Store.set('groupExpanded',{});
  if(E.groupedContent)E.groupedContent.innerHTML='';
  E.hdrTitle.classList.remove('hidden');E.btnBack.classList.add('hidden');
  E.settingsPanel.classList.remove('hidden');E.resultsPanel.classList.add('hidden');
  if(E.browsePanel)E.browsePanel.classList.add('hidden');
  if(E.workModeBar)E.workModeBar.classList.remove('hidden');
  E.resultsContent.classList.add('hidden');E.progressSection.classList.remove('hidden');
  E.bottomSettings.classList.remove('hidden');E.bottomResults.classList.add('hidden');
  E.progressFill.style.width='0%';E.progressText.textContent='正在搜索匹配岗位...';
  E.progressSub.textContent='';
  if(typeof window.hideCollectUrlPanel==='function')window.hideCollectUrlPanel();
  if(typeof window.resetStopCollectBtn==='function')window.resetStopCollectBtn();
  // 清掉 review 面板内容（不只是隐藏）——否则上一批 review DOM 残留，A 页下滑可见、且会被重渲染盖上来
  var rp=document.getElementById('reviewPanel');
  if(rp){rp.style.display='none';rp.innerHTML='';rp._expandWired=false;}
  if(typeof window.showTestModeBanner==='function')window.showTestModeBanner(false);
  if(typeof window.applyWorkModeUI==='function')window.applyWorkModeUI();
  window.renderSettings();
}

function toBrowse(){
  Store.set('mode','browse');
  Store.set('browsing',true);
  Store.set('testMode',false);
  E.hdrTitle.classList.add('hidden');E.btnBack.classList.remove('hidden');
  E.settingsPanel.classList.add('hidden');
  if(E.browseSettingsPanel)E.browseSettingsPanel.classList.add('hidden');
  E.resultsPanel.classList.add('hidden');
  if(E.browsePanel)E.browsePanel.classList.remove('hidden');
  if(E.workModeBar)E.workModeBar.classList.add('hidden');
  E.bottomSettings.classList.add('hidden');
  var doneSec=document.getElementById('browseDoneSection');
  var stopBtn=document.getElementById('btnStopBrowse');
  if(doneSec)doneSec.classList.add('hidden');
  if(stopBtn){stopBtn.classList.remove('hidden');stopBtn.disabled=false;stopBtn.textContent='停止浏览';}
  if(typeof window.updateBrowseProgress==='function')window.updateBrowseProgress({
    sent:0,skipped:0,failed:0,sessionSent:0,
    sessionLimit:typeof normalizeBrowseSessionLimit==='function'
      ?normalizeBrowseSessionLimit(Store.get('browseSessionLimit'))
      :(parseInt(Store.get('browseSessionLimit'),10)||0),
  });
  function startBrowseWithTab(sourceTab){
    var params=typeof window.buildBrowseParams==='function'?window.buildBrowseParams():{};
    if(sourceTab&&sourceTab.id){
      params.sourceTabId=sourceTab.id;
      params.sourceTabUrl=sourceTab.url||'';
    }
    chrome.runtime.sendMessage({type:MSG.START_BROWSE,params:params},function(resp){
      if(chrome.runtime.lastError||!resp||!resp.success){
        Store.set('browsing',false);
        alert((resp&&resp.error)||chrome.runtime.lastError?.message||'浏览投递启动失败，请确保已登录 BOSS 直聘');
        window.toSettings();
        return;
      }
      var txt=document.getElementById('browseProgressText');
      if(txt)txt.textContent='浏览投递已启动，请勿手动操作 BOSS 页面';
    });
  }
  if(typeof window.captureBrowseSourceTab==='function'){
    window.captureBrowseSourceTab(startBrowseWithTab);
  }else{
    startBrowseWithTab(null);
  }
}

function toResults(){
  Store.set('mode','results');Store.set('progressDone',false);Store.set('collecting',true);
  // 清上一轮结果，确保新一轮收集走 _processJobsUpdate 的「首次构建」分支重渲染
  Store.set('groups',[]);Store.set('jobs',[]);Store.set('groupExpanded',{});
  // B 页无缓存：清空后到本次采集数据到来前，不画任何旧广播，保持加载态（骨架屏）。
  Store.set('awaitingCollect',true);Store.set('groupExpanded',{});
  // B 页无缓存：标记「等待新一轮采集」，在 SW 确认新采集开始(phase='collecting')前，
  // handleStateUpdate 忽略上一轮残留 state，杜绝旧结果回填造成混淆。
  Store.set('awaitingCollect',true);
  // 重置投递按钮到初始态——杜绝上一批「已发送完成」(disabled+绿底)+sending=true 残留带进本批，
  // 否则进 B 页按钮显示「已发送完成」、首点命中停止分支(if sending)只重置文案、需点两次才开投。
  Store.set('sending',false);
  var isTest=!!Store.get('testMode');
  if(E.btnSend){
    E.btnSend.textContent=isTest?'测试投递':'一键发送';
    E.btnSend.classList.remove('sending');
    E.btnSend.disabled=false;
    E.btnSend.style.background='';
  }
  E.hdrTitle.classList.add('hidden');E.btnBack.classList.remove('hidden');
  E.settingsPanel.classList.add('hidden');E.resultsPanel.classList.remove('hidden');
  E.resultsContent.classList.add('hidden');E.progressSection.classList.remove('hidden');
  E.bottomSettings.classList.add('hidden');E.bottomResults.classList.add('hidden');
  E.progressFill.style.width='0%';
  if(isTest){
    var tj=typeof normalizeTestJobsPerPosition==='function'?normalizeTestJobsPerPosition(Store.get('testJobsPerPosition')):1;
    E.progressText.textContent='测试模式：正在各职位找 '+tj+' 个岗位...';
    E.progressSub.textContent='';
  }else{
    E.progressText.textContent='正在搜索匹配岗位...';
    E.progressSub.textContent='根据筛选条件智能匹配中';
  }
  E.progressSub.classList.remove('hidden');
  if(typeof window.showTestModeBanner==='function')window.showTestModeBanner(false);
  var rp=document.getElementById('reviewPanel');
  if(rp){rp.style.display='none';rp.innerHTML='';rp._expandWired=false;}
  var posCount=((Store.get('selectedPositions')||[]).concat(Store.get('customPositions')||[])).length||1;
  window.showSkeleton(posCount);
  if(typeof window.showStopCollectBtn==='function')window.showStopCollectBtn();
  try{
    var params=window.buildCollectParams();
    if(params.collectQuotas&&typeof window.renderCollectQuotaHint==='function'){
      window.renderCollectQuotaHint(params.collectQuotas);
      E.progressSub.textContent=window.formatCollectQuotaHint(params.collectQuotas);
    }
    if(params.collectPlan&&typeof window.renderCollectUrlPanel==='function'){
      window.renderCollectUrlPanel(params.collectPlan,0);
    }
    chrome.runtime.sendMessage({type:MSG.START_COLLECT,params:params},function(resp){
      if(chrome.runtime.lastError||!resp||!resp.success){
        Store.set('collecting',false);
        Store.set('awaitingCollect',false); // 启动失败：解除挡板，露出错误文案而非卡在骨架屏
        if(typeof window.resetStopCollectBtn==='function')window.resetStopCollectBtn();
        E.progressText.textContent='收集启动失败';
        E.progressSub.textContent=resp?.error||'请确保在BOSS直聘页面打开后重试';
      }
    });
  }catch(e){
    Store.set('collecting',false);
    if(typeof window.resetStopCollectBtn==='function')window.resetStopCollectBtn();
    E.progressText.textContent='收集启动失败';
    E.progressSub.textContent='请刷新页面后重试';
  }
  startBPagePollFallback();
}

function completeCollection(){
  if(p1dPollHandle){clearInterval(p1dPollHandle);p1dPollHandle=null;}
  Store.set('progressDone',true);Store.set('collecting',false);
  E.progressSection.classList.add('hidden');
  if(typeof window.hideCollectUrlPanel==='function')window.hideCollectUrlPanel();
  if(typeof window.resetStopCollectBtn==='function')window.resetStopCollectBtn();
  E.resultsContent.classList.remove('hidden');
  E.bottomResults.classList.remove('hidden');
  window.updResCnt();
  if(typeof window.showTestModeBanner==='function')window.showTestModeBanner(!!Store.get('testMode'));
  if(typeof window.updateSendButtonLabel==='function')window.updateSendButtonLabel();
  window.syncResumeFileNames&&window.syncResumeFileNames();
}

function updateGreetingProgress(progress){
  var el=document.getElementById('greetingProgress');
  if(!el){
    el=document.createElement('div');
    el.id='greetingProgress';
    el.style.cssText='font-size:11px;color:var(--text-weak);padding:8px 16px 16px;text-align:center';
    if(E.groupedContent)E.groupedContent.insertBefore(el,E.groupedContent.firstChild);
  }
  if(!progress||progress.total===0){el.style.display='none';return}
  el.style.display='';
  if(progress.done>=progress.total){
    el.textContent='招呼语已全部生成';
    el.style.color='var(--green)';
  }else{
    el.textContent='招呼语生成中 ('+progress.done+'/'+progress.total+')...';
    el.style.color='var(--text-weak)';
  }
}

// ════════════════════════════════════════════════════════════
// STATE UPDATE HANDLER
// ════════════════════════════════════════════════════════════

// Debounced jobs processing — only deep-clone when jobs actually change, skip if identical
function _processJobsUpdate(jobsData){
  console.log('[P1D-POPUP] _processJobsUpdate enter', { jobsLen: arguments[0] && arguments[0].length });
  _debounceJobsTimer=null;
  // Quick guard: skip heavy processing if jobs data hasn't changed, but still sync greetings
  var curJobs=Store.get('jobs');
  if(curJobs&&curJobs.length===jobsData.length){
    var same=true;
    for(var _i=0;_i<Math.min(curJobs.length,5);_i++){
      if(curJobs[_i].id!==jobsData[_i].id){same=false;break}
    }
    if(same){
      // Jobs unchanged, but greetings may have been updated (async generation completes)
      if(window.applyGreetingsToGroups())window.updateAllGreetings();
      return;
    }
  }
  var jobs=JSON.parse(JSON.stringify(jobsData));
  if(typeof window.applyAppliedFlagsToJobs==='function'){
    window.applyAppliedFlagsToJobs(jobs, _processJobsUpdateCore);
    return;
  }
  jobs.forEach(function(j){if(j.checked===undefined)j.checked=true});
  _processJobsUpdateCore(jobs);
}

function _processJobsUpdateCore(jobs){
  var _picker=Store.get('selectedPositions')||[];
  var _custom=Store.get('customPositions')||[];
  var _prefs=typeof window.getPriorityPrefs==='function'?window.getPriorityPrefs():{enabled:Store.get('prioritySortEnabled')!==false};
  if(typeof annotateJobsWithPriority==='function')annotateJobsWithPriority(jobs,_prefs,_picker,_custom);
  if(typeof sortJobsByPriority==='function')jobs=sortJobsByPriority(jobs,_prefs,_picker,_custom);
  Store.set('jobs',jobs);

  var existingGroups=Store.get('groups');
  if(existingGroups&&existingGroups.length>0){
    window.syncGroupsWithJobs();
    window.applyGreetingsToGroups();
    window.updateAllGreetings();
  }else{
    Store.set('groupExpanded',{});
    var selPos=_picker.concat(_custom);
    var groups;
    if(selPos.length){
      groups=window.prepareGroups(_picker,_custom,jobs);
      window.initJobCustom(false);
      Store.set('groups',groups);
      window.applyGreetingsToGroups();
      if(Store.get('progressDone')){window.updateAllGreetings();}
    }else if(Store.get('mode')==='results'){
      groups=[{position:'全部岗位',greeting:{text:'正在生成招呼语...',editing:false},fileName:'',jobs:jobs,images:window.defaultGroupImages()}];
      window.initJobCustom(false);
      Store.set('groups',groups);
      window.applyGreetingsToGroups();
      if(Store.get('progressDone')){window.updateAllGreetings();}
    }
    if(Store.get('mode')==='results'){
      window.renderGroupsStable();
    }
  }
}

function startBPagePollFallback(){
  if(p1dPollHandle)return;
  p1dPollHandle=setInterval(function(){
    try{
      chrome.runtime.sendMessage({type:MSG.GET_STATE},function(resp){
        if(chrome.runtime.lastError)return;
        if(resp&&resp.success&&resp.state){
          handleStateUpdate(resp.state);
          if(resp.state.phase==='ready'){
            clearInterval(p1dPollHandle);
            p1dPollHandle=null;
          }
        }
      });
    }catch(e){}
  },500);
}

function handleStateUpdate(state){
  console.log('[P1D-POPUP] handleStateUpdate', { phase: state && state.phase, jobsLen: state && state.jobs && state.jobs.length, greetingsLen: state && state.greetings && Object.keys(state.greetings||{}).length, mode: (window.Store && window.Store.get && window.Store.get('mode')) });
  var mode=Store.get('mode');

  // B 页无缓存：刚进 B 页(awaitingCollect)时本次采集还没开始，SW 可能仍在广播上一次已完成的
  // 采集结果。在见到本次采集的 'collecting' 信号前一律不渲染——保持骨架加载态，杜绝旧数据回填。
  // startCollect 会同步 phase='collecting'+pushState，故 popup 必先收到 'collecting' 再收到新 'ready'。
  if(Store.get('awaitingCollect')){
    if(state.phase==='collecting'){Store.set('awaitingCollect',false);}
    else{return;}
  }

  // Phase recovery (popup reopened mid-flow)
  // 排除 'review'：投完的旧批 state 不该把用户从 A 页拽回 B 页（review 由下方专门分支处理）
  if(mode==='settings'&&state.phase&&state.phase!=='idle'&&state.phase!=='review'){
    Store.set('mode','results');
    Store.set('collecting',state.phase==='collecting');
    if(state.phase==='collecting'&&Store.get('mode')==='results'&&!Store.get('progressDone')){
      if(typeof window.showStopCollectBtn==='function')window.showStopCollectBtn();
    }
    E.hdrTitle.classList.add('hidden');E.btnBack.classList.remove('hidden');
    E.settingsPanel.classList.add('hidden');E.resultsPanel.classList.remove('hidden');
    E.resultsContent.classList.add('hidden');E.progressSection.classList.remove('hidden');
    E.bottomSettings.classList.add('hidden');E.bottomResults.classList.add('hidden');
    E.progressFill.style.width='0%';
  }

  // Update Store from incoming state
  if(state.testMode!==undefined)Store.set('testMode',!!state.testMode);
  if(state.sendMode)Store.set('sendMode',state.sendMode);
  if(typeof window.syncSendModeUI==='function')window.syncSendModeUI();
  if(state.browseStats&&typeof window.updateBrowseProgress==='function'){
    window.updateBrowseProgress(state.browseStats);
  }
  if(state.phase==='browse_done'&&Store.get('mode')==='browse'){
    if(typeof window.showBrowseDone==='function')window.showBrowseDone(state.browseStats||{});
    Store.set('browsing',false);
  }
  if(mode==='settings'&&state.phase==='browsing'){
    Store.set('mode','browse');
    E.hdrTitle.classList.add('hidden');E.btnBack.classList.remove('hidden');
    E.settingsPanel.classList.add('hidden');
    if(E.browsePanel)E.browsePanel.classList.remove('hidden');
    if(E.workModeBar)E.workModeBar.classList.add('hidden');
    E.bottomSettings.classList.add('hidden');
  }
  if(state.selectedPositions&&state.selectedPositions.length)Store.set('selectedPositions',state.selectedPositions);
  if(state.customPositions)Store.set('customPositions',state.customPositions);
  if(state.greetings)Store.set('greetings',state.greetings);

  // 排除 'review'：投完的旧批 state.jobs 不该重渲 B 页岗位列表/底部计数（这是 18→3 残留的根）
  if(state.jobs&&state.jobs.length&&state.phase!=='review'){
    console.log('[P1D-POPUP] branch:jobs-nonzero hit');
    // 首次加载（groups 不存在）立即渲染，跳过 debounce。后续采集期间的增量更新才 debounce。
    var existingGroups=Store.get('groups');
    if(!existingGroups||!existingGroups.length){
      _processJobsUpdate(state.jobs);
    }else{
      if(_debounceJobsTimer)clearTimeout(_debounceJobsTimer);
      _debounceJobsTimer=setTimeout(function(){_processJobsUpdate(state.jobs)},300);
    }
  }else if(state.greetings&&Store.get('groups')&&Store.get('groups').length&&Store.get('mode')==='results'){
    if(window.applyGreetingsToGroups())window.updateAllGreetings();
  }

  if(state.phase==='ready'&&Store.get('mode')==='results'&&!Store.get('progressDone')){console.log('[P1D-POPUP] branch:phase-ready hit');completeCollection()}

  // Empty 兜底：phase=ready 但 jobs=[] → 替换 skeleton 为空态文案，隐藏投递按钮
  if(state.phase==='ready'&&Array.isArray(state.jobs)&&state.jobs.length===0&&Store.get('mode')==='results'){
    if(E.groupedContent)E.groupedContent.innerHTML='<div class="empty-positions">没有符合筛选条件的未投岗位</div>';
    if(E.bottomResults)E.bottomResults.classList.add('hidden');
    if(state.collectUrlPlan&&typeof window.renderCollectUrlPanel==='function'){
      window.renderCollectUrlPanel(state.collectUrlPlan,-1,{
        collectRawCount:state.collectRawCount,
        collectBeforeFilter:state.collectBeforeFilter
      });
      E.progressSection.classList.remove('hidden');
    }
  }

  // Restore sending progress (popup reopened during send)
  if(state.phase==='sending'){
    Store.set('sending',true);
    E.bottomResults.classList.remove('hidden');
    E.btnSend.textContent='停止发送';E.btnSend.classList.add('sending');E.btnSend.disabled=false;
    if(state.sendProgress){
      var sp=state.sendProgress;
      E.progressText.textContent='正在投递 ('+sp.sent+'/'+sp.total+')...';
      E.progressSub.textContent='';
      E.progressFill.style.width=sp.total>0?Math.min(Math.round(sp.sent/sp.total*100),100)+'%':'0%';
    }
  }

  // CAPTCHA 暂停发送
  if(state.phase==='captcha_paused'){
    Store.set('sending',false);
    E.btnSend.textContent='一键发送';
    E.btnSend.classList.remove('sending');
    E.btnSend.disabled=false;
    E.btnSend.style.background='';
    if(E.bottomResults){E.bottomResults.classList.remove('hidden')}
    showCaptchaWarning();
  }

  // Show review page (popup reopened after send complete, or STATE_UPDATE arrives)
  // 已点「再投一批」后 reviewDismissed=true → 不再自动弹上一批 review，避免盖在新一批 B 页上。
  // 新一批点「一键发送」时清掉该 flag（events-b.js），新一批投完仍正常显示 review。
  if(state.phase==='review'&&!Store.get('reviewDismissed')){
    console.log('[REVIEW-DIAG] line291 trigger', {phase:state.phase, sendResultsLen:(state.sendResults||[]).length, reviewDismissed:Store.get('reviewDismissed'), mode:Store.get('mode'), awaitingCollect:Store.get('awaitingCollect'), sending:Store.get('sending')});
    renderReview(state.sendResults||[],state.sendDuration||0,(state._v6MissedJobs||[]).length);
    E.resultsContent.classList.add('hidden');
    E.progressSection.classList.add('hidden');
    E.bottomResults.classList.add('hidden');
    var rp=document.getElementById('reviewPanel');
    if(rp)rp.style.display='';
  }
}

// ── CAPTCHA 暂停提示 ──
function showCaptchaWarning(){
  var existing=document.getElementById('captchaWarning');
  if(existing)return;
  var warning=document.createElement('div');
  warning.id='captchaWarning';
  warning.className='captcha-warning fade-in';
  warning.innerHTML=
    '<div class="captcha-warning-icon">!</div>'+
    '<div class="captcha-warning-title">检测到验证码，发送已暂停</div>'+
    '<div class="captcha-warning-sub">请在 BOSS 直聘页面手动完成验证后，点击继续发送</div>'+
    '<button class="btn btn-primary" id="resumeSendBtn">继续发送</button>';
  var ps=E.progressSection;
  if(ps&&ps.parentNode){
    ps.parentNode.insertBefore(warning,ps.nextSibling);
  }else{
    E.resultsPanel.appendChild(warning);
  }
  document.getElementById('resumeSendBtn').addEventListener('click',function(){
    var jobs=Store.get('jobs')||[];
    var jobIds=typeof window.getSortedCheckedJobIds==='function'?window.getSortedCheckedJobIds():jobs.filter(function(j){return j.checked}).map(function(j){return j.id});
    try{
      chrome.runtime.sendMessage({type:MSG.START_SEND,jobIds:jobIds,sendMode:Store.get('sendMode')||'platform',sendResumeImage:!!Store.get('sendResumeImage')},function(resp){
        var w=document.getElementById('captchaWarning');
        if(resp&&resp.success){
          if(w)w.remove();
          Store.set('sending',true);
          E.btnSend.textContent='停止发送';
          E.btnSend.classList.add('sending');
          E.btnSend.disabled=false;
          E.progressText.textContent='正在继续投递...';
          E.progressSub.textContent='';
        }else{
          E.progressText.textContent='继续投递失败';
          E.progressSub.textContent=(resp&&resp.error)||'请确保BOSS直聘聊天页已打开';
        }
      });
    }catch(e){
      E.progressText.textContent='继续投递失败';
      E.progressSub.textContent='扩展上下文异常，请刷新页面重试';
    }
  });
}

// ════════════════════════════════════════════════════════════
// INIT
// ════════════════════════════════════════════════════════════

function init(){
  if(typeof TAG_DATA==='undefined'){
    console.warn('TAG_DATA not loaded, attempting dynamic load...');
    var appEl=document.getElementById('app');
    if(!appEl)return;
    appEl.innerHTML='<div style="padding:40px;text-align:center;color:#666"><p>正在加载标签数据...</p></div>';
    var script=document.createElement('script');
    script.src='../content/tag-data.js';
    script.onload=function(){
      if(typeof TAG_DATA!=='undefined'){init()}
      else{appEl.innerHTML='<div style="padding:40px;text-align:center"><p style="color:#e74c3c;font-size:14px">标签数据加载失败，请刷新重试</p></div>'}
    };
    script.onerror=function(){appEl.innerHTML='<div style="padding:40px;text-align:center"><p style="color:#e74c3c;font-size:14px">标签数据加载失败，请刷新重试</p></div>'};
    document.head.appendChild(script);
    return;
  }

  initDomRefs();

  // 诊断包：popup 打开事件（USER_EVENT）
  try{if(typeof DiagLogger!=='undefined')DiagLogger.userEvent('popup','popup/侧边栏打开')}catch(_){}

  // A page initial render
  window.renderCityChips('');
  window.renderSettings();
  window.renderResumeImages();

  // Restore resume images + filter state from storage (merged single call)
  try{chrome.storage.local.get(['resumeImages',STORAGE_KEYS.UI.FILTER_STATE],function(r){
    // Resume images
    var stored=r.resumeImages||[];
    stored.forEach(function(it){
      var thumbSrc=it.thumb||(it.data?arrayBufferToDataUrl(it.data,it.type||'image/jpeg'):null);
      if(!it.data&&!thumbSrc)return;
      var images=Store.get('resumeImages')||[];
      var entry={src:thumbSrc||it.data,name:it.name,id:it.id||Date.now()+'_'+Math.random().toString(36).slice(2,6)};
      if(it.fullSrc)entry.fullSrc=it.fullSrc;
      else if(it.data)entry.fullSrc=arrayBufferToDataUrl(it.data,it.type||'image/jpeg');
      images.push(entry);
      Store.set('resumeImages',images);
    });
    if(stored.length)window.refreshBImages();
    // Filter state
    var filterState=r[STORAGE_KEYS.UI.FILTER_STATE];
    if(filterState){
      if(filterState.selectedCities&&filterState.selectedCities.length)Store.set('selectedCities',filterState.selectedCities);
      if(filterState.selectedPositions)Store.set('selectedPositions',filterState.selectedPositions);
      if(filterState.customPositions)Store.set('customPositions',filterState.customPositions);
      if(filterState.hrActiveFilter)Store.set('hrActiveFilter',filterState.hrActiveFilter);
      if(filterState.welfareFilter)Store.set('welfareFilter',filterState.welfareFilter);
      if(filterState.restDayFilter)Store.set('restDayFilter',filterState.restDayFilter);
      if(filterState.titleExcludeKeywords!=null)Store.set('titleExcludeKeywords',filterState.titleExcludeKeywords);
      if(filterState.companyExcludeKeywords!=null)Store.set('companyExcludeKeywords',filterState.companyExcludeKeywords);
      if(filterState.selectedIndustries)Store.set('selectedIndustries',filterState.selectedIndustries);
      if(filterState.workAreasByCity)Store.set('workAreasByCity',filterState.workAreasByCity);
      else if(filterState.workAreas&&filterState.selectedCities&&filterState.selectedCities.length===1){
        // 旧版 flat workAreas 迁移：单城用户绑到其唯一城市
        var _m={};_m[filterState.selectedCities[0]]=filterState.workAreas;Store.set('workAreasByCity',_m);
      }
      if(filterState.jobTypes)Store.set('jobTypes',filterState.jobTypes);
      if(filterState.salaryRanges)Store.set('salaryRanges',filterState.salaryRanges);
      if(filterState.experience)Store.set('experience',filterState.experience);
      if(filterState.education)Store.set('education',filterState.education);
      if(filterState.sendMode)Store.set('sendMode',filterState.sendMode);
      if(filterState.sendResumeImage!=null)Store.set('sendResumeImage',!!filterState.sendResumeImage);
      if(typeof window.syncSendModeUI==='function')window.syncSendModeUI();
      if(filterState.companySizes)Store.set('companySizes',filterState.companySizes);
      if(filterState.fundingStages)Store.set('fundingStages',filterState.fundingStages);
      if(filterState.prioritySortEnabled!==undefined)Store.set('prioritySortEnabled',filterState.prioritySortEnabled);
      if(filterState.priorityRules)Store.set('priorityRules',filterState.priorityRules);
      else if(typeof window.ensurePriorityRules==='function')window.ensurePriorityRules();
      if(filterState.testJobsPerPosition!=null&&typeof normalizeTestJobsPerPosition==='function'){
        Store.set('testJobsPerPosition',normalizeTestJobsPerPosition(filterState.testJobsPerPosition));
      }
      if(filterState.workMode)Store.set('workMode',filterState.workMode);
      if(filterState.browseScope)Store.set('browseScope',filterState.browseScope);
      if(filterState.browseSessionLimit!=null&&typeof normalizeBrowseSessionLimit==='function'){
        Store.set('browseSessionLimit',normalizeBrowseSessionLimit(filterState.browseSessionLimit));
      }
      var testJobsEl=document.getElementById('testJobsPerPosition');
      if(testJobsEl)testJobsEl.value=Store.get('testJobsPerPosition')||1;
      window.renderCityChips('');
      window.renderChipSecs();
      window.renderSettings();
      if(typeof window.applyWorkModeUI==='function')window.applyWorkModeUI();
    }
  })}catch(e){}

  // Load state from background
  try{
    chrome.runtime.sendMessage({type:MSG.GET_STATE},function(resp){
      console.log('[P1D-POPUP] GET_STATE resp', { success: resp && resp.success, phase: resp && resp.state && resp.state.phase, jobsLen: resp && resp.state && resp.state.jobs && resp.state.jobs.length });
      if(resp&&resp.success&&resp.state)handleStateUpdate(resp.state);
    });
  }catch(e){}

  // Init event delegation
  window.initEventsA();
  window.initEventsB();
  if(typeof window.initEventsBrowse==='function')window.initEventsBrowse();
  if(typeof window.applyWorkModeUI==='function')window.applyWorkModeUI();
  if(typeof window.captureBrowseSourceTab==='function')window.captureBrowseSourceTab();

  // ── Settings overlay events ──
  function showSettings(){E.settingsOverlay.classList.remove('hidden')}
  function hideSettings(){E.settingsOverlay.classList.add('hidden')}
  E.gearBtn.addEventListener('click',showSettings);
  E.settingsClose.addEventListener('click',hideSettings);
  E.settingsOverlay.addEventListener('click',function(e){
    if(e.target===E.settingsOverlay)hideSettings();
  });

  // ── Chrome message listener ──
  if(typeof chrome!=='undefined'&&chrome.runtime&&chrome.runtime.onMessage){
    chrome.runtime.onMessage.addListener(function(msg){
      console.log('[P1D-POPUP] onMessage', msg && msg.type);
      if(msg.type===MSG.COLLECT_STOPPED){
        Store.set('collecting',false);
        Store.set('awaitingCollect',false);
        if(typeof window.resetStopCollectBtn==='function')window.resetStopCollectBtn();
        if(!msg.partial){
          E.progressText.textContent='采集已停止';
          E.progressSub.textContent='可返回修改筛选后重新开始';
        }
      }
      if(msg.type===MSG.COLLECT_URL_PLAN&&msg.plan){
        if(typeof window.renderCollectUrlPanel==='function')window.renderCollectUrlPanel(msg.plan,0);
      }
      if(msg.type===MSG.COLLECT_CITY_PROGRESS&&msg.progress){
        var p=msg.progress;
        E.progressText.textContent='搜索进度 '+p.completed+'/'+p.total;
        if(p.quotas&&typeof window.renderCollectQuotaHint==='function')window.renderCollectQuotaHint(p.quotas);
        E.progressSub.textContent=p.skipped
          ? (p.skipReason||'已跳过')
          : (p.error
            ? ('⚠️ ' + p.error)
            : ('已采集 '+p.jobsCollected+' 条（去重后）'+(p.quotas?' · 日上限约 '+p.quotas.dailyCap:'')));
        E.progressSub.classList.remove('hidden');
        var plan=msg.plan||(Store.get('_collectUrlPlan')||null);
        if(msg.plan)Store.set('_collectUrlPlan',msg.plan);
        if(!plan&&typeof buildCollectUrlPlan==='function'){
          try{plan=buildCollectUrlPlan(window.buildCollectParams());}catch(_){}
        }
        if(typeof window.renderCollectUrlPanel==='function'&&plan){
          window.renderCollectUrlPanel(plan,p.currentIndex!=null?p.currentIndex:Math.max(0,p.completed-1),{
            rawCollected:p.rawCollected,
            jobsCollected:p.jobsCollected,
            domCardCount:p.domCardCount,
            apiJobCount:p.apiJobCount,
            loginRequired:p.loginRequired,
          cardSelector:p.cardSelector,
          maxCollect:p.maxCollect,
          error:p.error
        });
        }
      }
      if(msg.type===MSG.COLLECT_PROGRESS){
        window.updateProgress(msg.collected||0,msg.total||0,msg.statusText,msg.statusSub);
      }
      if(msg.type===MSG.EXTRACT_PROGRESS){
        // 方案 B：投递进行中时，批次进度只走 SEND_PROGRESS 的 batchSub，避免与主进度条打架
        if(Store.get('sending')) return;
        var done=msg.done!=null?msg.done:(msg.extracted!=null?msg.extracted:0);
        var total=msg.total||((Store.get('jobs')||[]).length);
        if(window.updateProgress){
          var label=Store.get('sendMode')==='custom'?'定制投递':'快速投递';
          window.updateProgress(
            done,total,
            msg.status||(label+' ('+done+'/'+total+')'),
            msg.jobName?('当前：'+msg.jobName):(msg.sub||'请勿操作 BOSS 弹窗')
          );
        }
      }
      if(msg.type===MSG.STATE_UPDATE&&msg.state){
        handleStateUpdate(msg.state);
        if(msg.state.greetingProgress)updateGreetingProgress(msg.state.greetingProgress);
      }
      if(msg.type===MSG.SEND_PROGRESS){
        var sent=(msg.progress&&msg.progress.sent!=null)?msg.progress.sent:msg.sent;
        var total2=(msg.progress&&msg.progress.total!=null)?msg.progress.total:msg.total;
        if(sent!=null&&total2!=null){
          E.progressFill.classList.remove('indeterminate');
          var label2=Store.get('sendMode')==='custom'?'定制投递':'快速投递';
          E.progressText.textContent=msg.status||(label2+' ('+sent+'/'+total2+')');
          var batchLine=msg.batchSub||msg.sub||'';
          E.progressSub.textContent=batchLine||(msg.jobName?('当前：'+msg.jobName):'请勿操作 BOSS 页面');
          E.progressSub.classList.toggle('hidden',!batchLine&&!msg.jobName);
          E.progressFill.style.width=total2>0?Math.min(Math.round(sent/total2*100),100)+'%':'0%';
          window._syncProgressTip&&window._syncProgressTip();
        }
      }
      if(msg.type===MSG.SEND_COMPLETE){
        console.log('[REVIEW-DIAG] SEND_COMPLETE msg arrived', {sending:Store.get('sending'), resultsLen:(msg.results||[]).length, mode:Store.get('mode'), awaitingCollect:Store.get('awaitingCollect')});
        if(Store.get('sending')){
          Store.set('sending',false);
          E.btnSend.textContent='已发送完成';
          E.btnSend.classList.remove('sending');
          E.btnSend.disabled=true;
          E.btnSend.style.background='var(--green)';
          window.renderReview(msg.results||[],msg.duration,msg.missedCount||0);
        }
      }
      if(msg.type===MSG.GREETING_DISABLED_FOR_SEND){
        if(!document.getElementById('greetingAutoNotice')){
          var gn=document.createElement('div');
          gn.id='greetingAutoNotice';
          gn.className='fade-in';
          gn.style.cssText='margin:8px 0;padding:8px 12px;background:#f0f9f4;color:#1a7f4b;border-radius:8px;font-size:12px;line-height:1.5;';
          gn.textContent='已临时关闭 BOSS 平台自动招呼语，本次仅发送 AI 定制招呼语+简历';
          if(E.progressSection&&E.progressSection.parentNode){
            E.progressSection.parentNode.insertBefore(gn,E.progressSection);
          }
        }
      }
      if(msg.type===MSG.BROWSE_PROGRESS){
        if(typeof window.updateBrowseProgress==='function'){
          window.updateBrowseProgress({
            sent:msg.sent,skipped:msg.skipped,failed:msg.failed,
            processed:msg.processed,currentTag:msg.currentTag,
            sessionSent:msg.sessionSent,sessionLimit:msg.sessionLimit,
            dailyTotal:msg.dailyTotal,
          });
        }
      }
      if(msg.type===MSG.BROWSE_ITEM_RESULT){
        if(msg.success&&typeof window.refreshBrowseDailyCount==='function'){
          window.refreshBrowseDailyCount();
        }
      }
      if(msg.type===MSG.BROWSE_COMPLETE){
        Store.set('browsing',false);
        if(typeof window.showBrowseDone==='function'){
          window.showBrowseDone({sent:msg.sent,skipped:msg.skipped,failed:msg.failed},msg.reason);
        }
      }
      if(msg.type===MSG.GREETING_AUTO_ENABLED){
        if(!document.getElementById('greetingAutoNotice')){
          var gn2=document.createElement('div');
          gn2.id='greetingAutoNotice';
          gn2.className='fade-in';
          gn2.style.cssText='margin:8px 0;padding:8px 12px;background:#f0f9f4;color:#1a7f4b;border-radius:8px;font-size:12px;line-height:1.5;';
          gn2.textContent='已自动开启 BOSS 平台自动招呼语，本次使用平台模板快速投递';
          if(E.progressSection&&E.progressSection.parentNode){
            E.progressSection.parentNode.insertBefore(gn2,E.progressSection);
          }
        }
      }
      if(msg.type===MSG.ERROR){
        // SW 的 ERROR 消息字段键不统一：收集类用 message，发送类(phase:'sending')用 error。
        // 统一兜底读 message||error，避免真错误被吞成「请重试」。
        var _errText=msg.message||msg.error;
        if(msg.collectPlan&&typeof window.renderCollectUrlPanel==='function'){
          window.renderCollectUrlPanel(msg.collectPlan,-1,{
            collectRawCount:msg.collectRawCount,
            collectBeforeFilter:msg.collectBeforeFilter,
            loginRequired:msg.loginRequired,
            domCardCount:msg.collectDiag&&msg.collectDiag.domCardCount,
            apiJobCount:msg.collectDiag&&msg.collectDiag.apiJobCount
          });
        }
        if(Store.get('mode')==='results'&&!Store.get('progressDone')){
          E.progressText.textContent='收集未找到匹配岗位';
          E.progressSub.textContent=_errText||'请重试';
          E.progressSub.classList.remove('hidden');
          if(typeof window.resetStopCollectBtn==='function')window.resetStopCollectBtn();
        }
        if(Store.get('sending')){
          Store.set('sending',false);
          E.btnSend.textContent='一键发送';
          E.btnSend.classList.remove('sending');
          E.btnSend.disabled=false;
          E.btnSend.style.background='';
          E.progressText.textContent='发送失败';
          E.progressSub.textContent=_errText||'请重试';
        }
        if(Store.get('mode')==='browse'||Store.get('browsing')){
          Store.set('browsing',false);
          var btxt=document.getElementById('browseProgressText');
          if(btxt)btxt.textContent='浏览投递失败';
          var bsub=document.getElementById('browseProgressSub');
          if(bsub){bsub.textContent=_errText||'请重试';bsub.classList.remove('hidden');}
        }
      }
    });
  }
}

document.addEventListener('DOMContentLoaded',init);

// ═══ 调试桥：主对话通过 postMessage 操控 popup ═══
// 注意：popup HTML 中没有 tab 按钮，页面切换通过 toSettings / toResults / renderReview 函数实现
(function(){
  // 辅助：判断当前可见页面
  function getCurrentPage(){
    var sp=document.getElementById('settingsPanel');
    var rp=document.getElementById('resultsPanel');
    var rv=document.getElementById('reviewPanel');
    if(rv&&rv.style.display!=='none'&&rv.innerHTML.trim())return'Review';
    if(rp&&!rp.classList.contains('hidden'))return'B';
    if(sp&&!sp.classList.contains('hidden'))return'A';
    return'unknown';
  }

  window.addEventListener('message',function(event){
    if(!event.data||!event.data.type)return;
    var cmd=event.data.type;
    var result={};

    try{
      switch(cmd){
        case 'POPUP_SWITCH_TAB':{
          var tab=event.data.tab;
          if(tab==='A'&&typeof window.toSettings==='function'){
            window.toSettings();
            result={currentTab:'A',switched:true};
          }else if(tab==='B'&&typeof window.toResults==='function'){
            window.toResults();
            result={currentTab:'B',switched:true};
          }else if(tab==='Review'){
            var rv=document.getElementById('reviewPanel');
            if(rv&&rv.innerHTML.trim()){
              E.resultsContent.classList.add('hidden');
              E.bottomResults.classList.add('hidden');
              E.progressSection.classList.add('hidden');
              rv.style.display='';
              result={currentTab:'Review',switched:true};
            }else{
              result={error:'Review page has no content (send not completed)'};
            }
          }else{
            result={error:'Unknown tab: '+tab};
          }
          // 写入 data-popup-state 供主对话读取
          document.documentElement.setAttribute('data-popup-state',JSON.stringify({
            currentTab:getCurrentPage(),
            rendered:true
          }));
          break;
        }

        case 'POPUP_GET_STATE':{
          result={
            currentTab:getCurrentPage(),
            mode:Store.get('mode'),
            collecting:Store.get('collecting'),
            sending:Store.get('sending'),
            progressDone:Store.get('progressDone'),
            jobsCount:(Store.get('jobs')||[]).length,
            groupsCount:(Store.get('groups')||[]).length,
            selectedCities:(Store.get('selectedCities')||[]).length,
            selectedPositions:Store.get('selectedPositions')||[],
            progressText:E.progressText?E.progressText.textContent:'',
            progressSub:E.progressSub?E.progressSub.textContent:'',
            bodyHTML:document.body?document.body.innerHTML.substring(0,500):''
          };
          // 检测验证码暂停
          if(document.getElementById('captchaWarning'))result.warning='captcha';
          document.documentElement.setAttribute('data-popup-state',JSON.stringify(result));
          break;
        }

        case 'POPUP_TRIGGER_ACTION':{
          var action=event.data.action;
          if(action==='START_COLLECT'){
            var btn=document.getElementById('btnCollect');
            if(btn){btn.click();result={action:'START_COLLECT',triggered:true}}
            else result={action:'START_COLLECT',triggered:false,error:'Button #btnCollect not found'};
          }else if(action==='START_SEND'){
            var btn=document.getElementById('btnSend');
            if(btn){btn.click();result={action:'START_SEND',triggered:true}}
            else result={action:'START_SEND',triggered:false,error:'Button #btnSend not found'};
          }else if(action==='STOP_COLLECT'){
            try{
              chrome.runtime.sendMessage({type:MSG.STOP_COLLECT});
              result={action:'STOP_COLLECT',triggered:true};
            }catch(e){result={action:'STOP_COLLECT',triggered:false,error:e.message}};
          }else if(action==='STOP_SEND'){
            var btn=document.getElementById('btnSend');
            if(btn&&btn.classList.contains('sending')){
              btn.click();
              result={action:'STOP_SEND',triggered:true};
            }else if(btn){
              result={action:'STOP_SEND',triggered:false,error:'Not currently sending (btnSend has no .sending class)'};
            }else{
              result={action:'STOP_SEND',triggered:false,error:'Button #btnSend not found'};
            }
          }else{
            result={error:'Unknown action: '+action};
          }
          // 立即写一个中间结果
          document.documentElement.setAttribute('data-action-result',JSON.stringify(result));
          // 延迟 1 秒后读取 storage 并写入最终结果
          var act=action;
          setTimeout(function(){
            try{
              chrome.storage.local.get(null,function(items){
                var sr;
                try{sr=items[STORAGE_KEYS.SW.STATE]?JSON.parse(items[STORAGE_KEYS.SW.STATE]):null}catch(ex){}
                document.documentElement.setAttribute('data-action-result',JSON.stringify({
                  action:act,
                  triggered:result.triggered,
                  swPhase:items[STORAGE_KEYS.SW.PHASE]||null,
                  swState:sr,
                  mode:Store.get('mode'),
                  collecting:Store.get('collecting'),
                  sending:Store.get('sending'),
                  progressDone:Store.get('progressDone')
                }));
              });
            }catch(e){
              document.documentElement.setAttribute('data-action-result',JSON.stringify({error:e.message}));
            }
          },1000);
          // POPUP_TRIGGER_ACTION 不落到通用的 data-popup-result 写入
          return;
        }

        default:
          result={error:'Unknown command: '+cmd};
      }
    }catch(e){
      result={error:e.message};
    }

    document.documentElement.setAttribute('data-popup-result',JSON.stringify(result));
  });
})();
