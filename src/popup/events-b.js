// ════════════════════════════════════════════════════════════
// 即投 — B 页（结果页）事件委托
// ════════════════════════════════════════════════════════════
// Depends on: E, Store, $/$$/esc (global)
// Depends on: MSG (from constants.js)
// Depends on: render-b.js (window.* functions)

window.initEventsB=function(){
  if(window._eventsBInitialized)return;
  window._eventsBInitialized=true;

  // ── Grouped content delegation ──
  E.groupedContent.addEventListener('click',function(e){
    try{
      // Per-job custom image upload
      var jact=e.target.closest('[data-gact="addJobImg"]');
      if(jact){
        var jobId=jact.dataset.jobId;
        var fileInput=document.getElementById('jobFile_'+jobId);
        if(fileInput)fileInput.click();
        return
      }
      // Per-job custom image remove
      var jrem=e.target.closest('.thumb-remove[data-job-img]');
      if(jrem){
        var jid=jrem.dataset.jobImg;
        var idx=parseInt(jrem.dataset.idx);
        var jc=Store.get('jobCustom')||{};
        var entry=jc[jid];
        if(entry&&entry.images&&idx>=0&&idx<entry.images.length){
          entry.images.splice(idx,1);
          Store.set('jobCustom',jc);
          // Re-render this job's thumb area
          var thumbArea=jrem.closest('.univ-thumb-area');
          if(thumbArea)thumbArea.innerHTML=window.renderJobThumbnailsHTML(jid);
        }
        return
      }

      // Greeting actions (rewrite)
      var gact=e.target.closest('[data-gact]');
      if(gact){
        if(gact.dataset.gact==='addImg'){
          // B 页组级添加：入口带组标识 data-ggi，上传只写该组 g.images（无 ggi 时兜底走 A 页全局入口）
          var addGgi=gact.dataset.ggi;
          if(addGgi!==undefined&&E.hiddenFileInputB){
            E.hiddenFileInputB.dataset.ggi=addGgi;
            E.hiddenFileInputB.click();
          }else{
            E.hiddenFileInput.click();
          }
          return
        }
        if(gact.dataset.gact==='addJobImg')return; // handled above
        var gi=parseInt(gact.dataset.g);
        if(isNaN(gi))return;
        var groups=Store.get('groups')||[];
        var g=groups[gi];
        if(!g)return;
        if(gact.dataset.gact==='rewrite'){
          gact.classList.add('spinning');
          var jdSamples=g.jobs.slice(0,5).map(function(j){
            return{title:j.name,tags:j.tags,desc:j.name};
          });
          chrome.runtime.sendMessage({type:MSG.REGENERATE_GREETING,category:g.position,jdSamples:jdSamples},function(resp){
            if(resp&&resp.success&&resp.greeting){
              g.greeting.text=resp.greeting;
              g.greeting.editing=false;
              Store.set('groups',groups);
              window.syncGroupGreeting(gi);
            }else if(resp&&!resp.success){
              alert(resp.error||'招呼语生成失败，请确认已上传清晰简历');
            }
            // Targeted update: refresh greeting display only
            window.updateGroupGreeting(gi);
            gact.classList.remove('spinning');
          });
        }
        return
      }

      // Expand group
      var exp=e.target.closest('.expand-more-jobs');
      if(exp){
        var egi=parseInt(exp.dataset.gi);
        if(!isNaN(egi))window.expandGroup(egi);
        return
      }

      // Click greet-text to edit
      var gt=e.target.closest('.greet-text[data-g]');
      if(gt){
        window.showGreetingEditor(parseInt(gt.dataset.g));
        return
      }

      // Image remove (B page) — 按组删除：只动该组 g.images，不再碰全局 resumeImages/storage
      var rem=e.target.closest('.thumb-remove[data-ggi]');
      if(rem){
        var rgi=parseInt(rem.dataset.ggi);
        var idx=parseInt(rem.dataset.idx);
        if(!isNaN(rgi)&&!isNaN(idx)&&idx>=0){
          var rGroups=Store.get('groups')||[];
          var rg=rGroups[rgi];
          if(rg&&rg.images&&idx<rg.images.length){
            rg.images.splice(idx,1);
            Store.set('groups',rGroups);
            window.refreshGroupImages(rgi);
          }
        }
        return
      }

      // Image lightbox (B page thumbnails) — 组级缩略图用该组 g.images 的 fullSrc
      var thumbImg=e.target.closest('.univ-thumb img');
      if(thumbImg){
        var src=thumbImg.src;
        if(thumbImg.dataset.ggi!==undefined){
          var lGroups=Store.get('groups')||[];
          var lg=lGroups[parseInt(thumbImg.dataset.ggi)];
          var lImg=lg&&lg.images&&lg.images[parseInt(thumbImg.dataset.idx)];
          if(lImg&&lImg.fullSrc)src=lImg.fullSrc;
        }else{
          var gimg=thumbImg.dataset.gimg;
          var images=Store.get('resumeImages')||[];
          var imgData=images[parseInt(gimg)];
          if(imgData&&imgData.fullSrc)src=imgData.fullSrc;
        }
        showImageLightbox(src);
        return
      }

      // Job custom toggle (lazy create)
      var toggle=e.target.closest('.job-custom-toggle');
      if(toggle){
        var id=toggle.dataset.jobId;
        window.toggleJobCustom(id);
        return
      }

      // Help tip: click ? to open full-size help image in new tab
      var helpTip=e.target.closest('.help-tip');
      if(helpTip){
        var imgUrl=chrome.runtime.getURL('src/popup/auto-reply-help.png');
        var html='<html><head><meta charset="utf-8"><title>自动回复简历说明</title><style>body{margin:0;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;background:#f0f0f0;font-family:-apple-system,BlinkMacSystemFont,sans-serif}img{max-width:800px;width:90%;border-radius:8px;box-shadow:0 2px 12px rgba(0,0,0,.12)}p{color:#555;font-size:14px;margin-top:16px}</style></head><body><img src="'+imgUrl+'" alt="自动回复说明"><p>帮助您识别 HR 消息中的关键词，进行自动回复附件简历。</p></body></html>';
        var b64=btoa(unescape(encodeURIComponent(html)));
        chrome.tabs.create({ url: 'data:text/html;charset=utf-8;base64,'+b64 });
        return
      }

      // Master checkbox: tri-state toggle for all jobs in group
      var master=e.target.closest('.job-master-checkbox');
      if(master){
        window.toggleGroupMaster(parseInt(master.dataset.masterGi));
        return
      }

      // Job checkbox toggle (skip if click inside custom settings panel)
      var it=e.target.closest('.job-item');
      if(it){
        if(e.target.closest('.job-custom-settings')) return;
        var id=it.dataset.jobId;
        window.toggleJobCheck(id);
      }
    }catch(ex){console.error('groupedContent click:',ex)}
  });

  // Greeting textarea: Enter exits editing
  E.groupedContent.addEventListener('keydown',function(e){
    var ta=e.target.closest('.greet-textarea[data-g]');
    if(ta&&e.key==='Enter'&&!e.shiftKey){
      e.preventDefault();
      window.saveAndHideGreetingEditor(parseInt(ta.dataset.g));
    }
  });
  E.groupedContent.addEventListener('focusout',function(e){
    var ta=e.target.closest('.greet-textarea[data-g]');
    if(ta)window.saveAndHideGreetingEditor(parseInt(ta.dataset.g));
  });

  // Greeting & file name input (live sync)
  E.groupedContent.addEventListener('input',function(e){
    var ta=e.target.closest('.greet-textarea[data-g]');
    if(ta){
      var gi=parseInt(ta.dataset.g);
      var groups=Store.get('groups')||[];
      var g=groups[gi];
      if(g)g.greeting.text=ta.value;
      Store.set('groups',groups);
      return
    }
    var fn=e.target.closest('.att-name-input[data-g]');
    if(fn){
      var gi=parseInt(fn.dataset.g);
      var groups=Store.get('groups')||[];
      var g=groups[gi];
      if(g)g.fileName=fn.value;
      Store.set('groups',groups);
      syncResumeFileNames();
      return
    }
    var inp=e.target.closest('.custom-ta');
    if(inp){
      var id=inp.dataset.jobId;
      var setting=inp.dataset.cs;
      var jc=Store.get('jobCustom')||{};
      var entry=jc[id];
      if(!entry)return;
      if(setting==='greeting')entry.customGreeting=inp.value;
      Store.set('jobCustom',jc);
    }
  });

  // Per-job custom image upload (change event on dynamically created file inputs)
  E.groupedContent.addEventListener('change',function(e){
    var fileInput=e.target.closest('input[type="file"][id^="jobFile_"]');
    if(!fileInput)return;
    var files=fileInput.files;
    if(!files||!files.length)return;
    var jobId=fileInput.id.replace('jobFile_','');
    var jc=Store.get('jobCustom')||{};
    if(!jc[jobId])jc[jobId]={expanded:false,customGreeting:'',customFileName:'',images:[]};
    if(!jc[jobId].images)jc[jobId].images=[];
    // 组图片下沉副本（_fromGroup）不算用户 per-job 自定义：用户手动加图时先清掉，避免混发
    jc[jobId].images=jc[jobId].images.filter(function(im){return !im._fromGroup});
    var maxNew=10-(jc[jobId].images.length);
    var todo=[];
    for(var fi=0;fi<files.length&&todo.length<maxNew;fi++)todo.push(files[fi]);
    var done=0;
    var thatDiv=fileInput.closest('.univ-thumb-area');
    for(var ti=0;ti<todo.length;ti++)(function(f){
      var reader=new FileReader();
      reader.onload=function(ev){
        var ab=ev.target.result;
        var u8=new Uint8Array(ab);
        var img=new Image();
        img.onload=function(){
          var cv=document.createElement('canvas');
          var w=img.width,h=img.height;
          if(w>120){h=h*120/w;w=120}
          if(h>160){w=w*160/h;h=160}
          cv.width=Math.round(w);
          cv.height=Math.round(h);
          cv.getContext('2d').drawImage(img,0,0,cv.width,cv.height);
          var thumb=cv.toDataURL('image/jpeg',0.7);
          var cvLb=document.createElement('canvas');
          var lbW=img.width,lbH=img.height;
          if(lbW>800){lbH=lbH*800/lbW;lbW=800}
          if(lbH>1000){lbW=lbW*1000/lbH;lbH=1000}
          cvLb.width=Math.round(lbW);
          cvLb.height=Math.round(lbH);
          cvLb.getContext('2d').drawImage(img,0,0,cvLb.width,cvLb.height);
          var lightboxSrc=cvLb.toDataURL('image/jpeg',0.85);
          jc[jobId].images.push({src:thumb,fullSrc:lightboxSrc,name:f.name});
          URL.revokeObjectURL(img.src);
          done++;
          if(done===todo.length){
            fileInput.value='';
            Store.set('jobCustom',jc);
            if(thatDiv)thatDiv.innerHTML=window.renderJobThumbnailsHTML(jobId);
          }
        };
        img.src=URL.createObjectURL(new Blob([ab],{type:f.type}));
      };
      reader.readAsArrayBuffer(f);
    })(todo[ti]);
  });

  // ── B 页按组图片上传（hiddenFileInputB.dataset.ggi 标识目标组，只写该组 g.images）──
  E.hiddenFileInputB&&E.hiddenFileInputB.addEventListener('change',function(e){
    var gi=parseInt(E.hiddenFileInputB.dataset.ggi);
    var files=e.target.files;
    if(!files||!files.length||isNaN(gi))return;
    var groups=Store.get('groups')||[];
    var g=groups[gi];
    if(!g)return;
    if(!g.images)g.images=[];
    var maxNew=10-g.images.length;
    var todo=[];
    for(var fi=0;fi<files.length&&todo.length<maxNew;fi++)todo.push(files[fi]);
    if(!todo.length){e.target.value='';return}
    var done=0;
    for(var ti=0;ti<todo.length;ti++)(function(f){
      var reader=new FileReader();
      reader.onload=function(ev){
        var ab=ev.target.result;
        var img=new Image();
        img.onload=function(){
          var cv=document.createElement('canvas');
          var w=img.width,h=img.height;
          if(w>120){h=h*120/w;w=120}
          if(h>160){w=w*160/h;h=160}
          cv.width=Math.round(w);
          cv.height=Math.round(h);
          cv.getContext('2d').drawImage(img,0,0,cv.width,cv.height);
          var thumb=cv.toDataURL('image/jpeg',0.7);
          var cvLb=document.createElement('canvas');
          var lbW=img.width,lbH=img.height;
          if(lbW>800){lbH=lbH*800/lbW;lbW=800}
          if(lbH>1000){lbW=lbW*1000/lbH;lbH=1000}
          cvLb.width=Math.round(lbW);
          cvLb.height=Math.round(lbH);
          cvLb.getContext('2d').drawImage(img,0,0,cvLb.width,cvLb.height);
          var lightboxSrc=cvLb.toDataURL('image/jpeg',0.85);
          g.images.push({src:thumb,fullSrc:lightboxSrc,name:f.name,id:Date.now()+'_'+Math.random().toString(36).slice(2,6)});
          URL.revokeObjectURL(img.src);
          done++;
          if(done===todo.length){
            e.target.value='';
            Store.set('groups',groups);
            window.refreshGroupImages(gi);
          }
        };
        img.src=URL.createObjectURL(new Blob([ab],{type:f.type}));
      };
      reader.readAsArrayBuffer(f);
    })(todo[ti]);
  });

  // ── 停止采集 ──
  if(E.btnStopCollect){
    E.btnStopCollect.addEventListener('click',function(){
      if(!Store.get('collecting'))return;
      try{if(typeof DiagLogger!=='undefined')DiagLogger.userEvent('popup','用户点击「停止采集」按钮')}catch(_){}
      E.btnStopCollect.textContent='正在停止...';
      E.btnStopCollect.disabled=true;
      E.progressText.textContent='正在停止采集...';
      E.progressSub.textContent='请稍候';
      Store.set('collecting',false);
      Store.set('awaitingCollect',false);
      try{
        chrome.runtime.sendMessage({type:MSG.STOP_COLLECT},function(resp){
          if(chrome.runtime.lastError){
            E.progressText.textContent='采集已停止';
            E.progressSub.textContent='扩展后台未响应，已重置界面';
            if(typeof window.resetStopCollectBtn==='function')window.resetStopCollectBtn();
            window.toSettings&&window.toSettings();
            return;
          }
        });
      }catch(ex){
        E.progressText.textContent='采集已停止';
        E.progressSub.textContent='';
        if(typeof window.resetStopCollectBtn==='function')window.resetStopCollectBtn();
        window.toSettings&&window.toSettings();
      }
      setTimeout(function(){
        if(E.progressText&&E.progressText.textContent==='正在停止采集...'){
          E.progressText.textContent='采集已停止';
          E.progressSub.textContent='';
          if(typeof window.resetStopCollectBtn==='function')window.resetStopCollectBtn();
        }
      },3000);
    });
  }

  // ── Send button ──
  E.btnSend.addEventListener('click',function(){
    var sending=Store.get('sending');
    if(sending){
      // 停止＝硬中止 + 统一终态：不在本地把 sending 置 false（否则后续 SEND_COMPLETE 的
      // `if(sending)` 守卫为假 → review 不渲染）。保持 sending=true，让 SW 的 stopSend→
      // finalizeTask→SEND_COMPLETE 回来时正常落 review（底部按钮变「重新投递」）。
      // 诊断包：用户点停止（popup 侧打点；即使 STOP_SEND 没送达 SW 也有记录）
      try{if(typeof DiagLogger!=='undefined')DiagLogger.userEvent('popup','用户点击「停止发送」按钮')}catch(_){}
      E.btnSend.textContent='正在停止...';
      E.btnSend.disabled=true;
      E.progressText.textContent='正在停止...';
      E.progressSub.textContent='正在收尾，请稍候';
      try{chrome.runtime.sendMessage({type:MSG.STOP_SEND})}catch(ex){}
      return
    }
    var jobs=Store.get('jobs')||[];
    var jobIds=typeof window.getSortedCheckedJobIds==='function'?window.getSortedCheckedJobIds():jobs.filter(function(j){return j.checked}).map(function(j){return j.id});
    // 防御：Store 无勾选岗位（如 UI 勾选与 Store 脱节的幽灵卡场景）→ 不发 START_SEND，给用户可见提示
    if(jobIds.length===0){
      alert('当前没有已勾选的岗位，请重新勾选岗位后再投递');
      return
    }
    // ── 投递数量闸门（gate）：在投递入口前置，向 SW 读当天已成功投递数后决策 ──
    // 规则：日上限 150（本地自然日）。remaining=150-当天已投，本批 N=jobIds.length。
    //   ① N+已投 > 150（超日上限）→ 硬拦：只投前 remaining 个，弹窗提示官方限制。
    //   ② 75 < N ≤ 150 且不触发日上限 → 软提示（confirm，允许继续）。
    //   ③ N ≤ 75 且不触发日上限 → 正常投，无提示。
    // 读取失败（SW 异常）放行（count=0），不阻断核心发送链。
    var DAILY_LIMIT=150, SOFT_LIMIT=75;
    chrome.runtime.sendMessage({type:MSG.GET_DAILY_SEND_COUNT},function(gateResp){
      var alreadyToday=0;
      var gateCountOk=!chrome.runtime.lastError&&gateResp&&gateResp.success&&typeof gateResp.count==='number';
      if(gateCountOk)alreadyToday=gateResp.count;
      if(gateResp&&typeof gateResp.limit==='number')DAILY_LIMIT=gateResp.limit;
      var remaining=Math.max(0,DAILY_LIMIT-alreadyToday);
      var N=jobIds.length;
      // 诊断包：读计数失败 → SW 异常放行（count=0），记一条 warn
      try{if(!gateCountOk&&typeof DiagLogger!=='undefined')DiagLogger.warn('popup.limitGate','读当天投递计数失败，放行(count=0) lastError='+(chrome.runtime.lastError?String(chrome.runtime.lastError.message||chrome.runtime.lastError):'none')+' N='+N)}catch(_){}
      // 诊断包：gate 决策分支记录（脱敏，只记数值+分支名+slice后数量）
      var gateBranch=(N+alreadyToday>DAILY_LIMIT)?(remaining<=0?'硬拦-额度已满':'硬拦-截断'):(N>SOFT_LIMIT?'软提示':'正常');

      if(N+alreadyToday>DAILY_LIMIT){
        // ① 硬拦：今日已投 alreadyToday，剩余可投 remaining；超出部分不投
        if(remaining<=0){
          try{if(typeof DiagLogger!=='undefined')DiagLogger.userEvent('popup.limitGate','gate分支='+gateBranch+' 今日已投='+alreadyToday+' 本批N='+N+' 上限='+DAILY_LIMIT+' slice后='+jobIds.length)}catch(_){}
          alert('Boss 官方不支持一天沟通数量大于 150 个，不建议超额投递');
          return; // 今日额度已满，整批拦下
        }
        alert('Boss 官方不支持一天沟通数量大于 150 个，不建议超额投递');
        jobIds=jobIds.slice(0,remaining); // 只投前 remaining 个
      }else if(N>SOFT_LIMIT){
        // ② 软提示：允许继续（取消则不投）
        if(!confirm('单批投递数量太大容易引起卡顿，建议控制岗位数小于等于 75 个'))return;
      }
      // ③ N ≤ 75 且不触发日上限：直接走
      try{if(typeof DiagLogger!=='undefined')DiagLogger.userEvent('popup.limitGate','gate分支='+gateBranch+' 今日已投='+alreadyToday+' 本批N='+N+' 上限='+DAILY_LIMIT+' slice后='+jobIds.length)}catch(_){}

      startSendAfterGate(jobIds);
    });
    return; // 实际启动在 gate 回调里
  });

  // ── gate 通过后的真正投递启动（原 Send 逻辑整体下沉，核心发送链零改动）──
  function startSendAfterGate(jobIds){
    // 诊断包：用户点一键发送（任务启动 USER_EVENT，popup 侧）
    try{if(typeof DiagLogger!=='undefined')DiagLogger.userEvent('popup','用户点击「一键发送」 jobs='+jobIds.length)}catch(_){}
    // 组图片下沉到组内岗位的 jobCustom.images，发送链路（job-sender 读 ui:jobCustom）才能按组生效
    window.syncGroupImagesToJobCustom&&window.syncGroupImagesToJobCustom();
    // per-job 自定义招呼语：强制把最新 jobCustom 落盘（绕过 persistUIState 300ms 防抖），
    // 保证 SW buildSendQueueV6 灌入时读到的是用户刚输入的 customGreeting，而非陈旧值。
    try{
      if(typeof STORAGE_KEYS!=='undefined'&&typeof chrome!=='undefined'&&chrome.storage){
        var _jc=Store.get('jobCustom')||{};
        var _save={};_save[STORAGE_KEYS.UI.JOB_CUSTOM]=_jc;
        chrome.storage.local.set(_save);
      }
    }catch(_e){}
    Store.set('sending',true);
    Store.set('progressDone',false);
    Store.set('reviewDismissed',false); // 新一批开投 → 解除抑制，本批投完正常弹 review
    E.progressSection.classList.remove('hidden');
    try{E.progressSection.scrollIntoView({behavior:'smooth',block:'start'})}catch(ex){}
    E.btnSend.textContent='停止发送';
    E.btnSend.classList.add('sending');
    E.btnSend.disabled=false;
    E.progressText.textContent='正在启动投递...';
    E.progressSub.textContent='请稍候';
    E.progressFill.style.width='0%';
    try{
      chrome.runtime.sendMessage({type:MSG.START_SEND,jobIds:jobIds,hrActiveFilter:Store.get('hrActiveFilter')||'不限'},function(resp){
        if(chrome.runtime.lastError||!resp||!resp.success){
          Store.set('sending',false);
          E.btnSend.textContent='一键发送';
          E.btnSend.classList.remove('sending');
          E.btnSend.disabled=false;
          E.btnSend.style.background='';
          if(resp&&resp.errorCode==='NO_QUOTA'){
            // 无免费额度：不报"启动失败"（非故障），换成额度提示 + 内联购买入口
            E.progressText.textContent='免费额度已用完';
            E.progressSub.textContent='';
            E.progressSub.classList.add('hidden');
            showNoQuotaBuy(true);
          }else{
            showNoQuotaBuy(false);
            E.progressText.textContent='投递启动失败';
            E.progressSub.classList.remove('hidden');
            E.progressSub.textContent=(resp&&resp.error)||'请确保BOSS直聘聊天页已打开';
          }
        }else{
          showNoQuotaBuy(false);
          E.progressText.textContent='正在投递...';
          E.progressSub.classList.remove('hidden');
          E.progressSub.textContent='共 '+jobIds.length+' 个岗位';
        }
      });
    }catch(ex){
      Store.set('sending',false);
      E.btnSend.textContent='一键发送';
      E.btnSend.classList.remove('sending');
      E.btnSend.disabled=false;
      E.btnSend.style.background='';
      showNoQuotaBuy(false);
      E.progressText.textContent='投递启动失败';
      E.progressSub.classList.remove('hidden');
      E.progressSub.textContent='扩展上下文异常，请刷新页面重试';
    }
  }

  // ── 无免费额度内联购买入口：显隐 + 复用 account.js 的购买跳转（window.JitouBuy）──
  function showNoQuotaBuy(show){
    var box=document.getElementById('noQuotaBuy');
    if(!box)return;
    if(show)box.classList.remove('hidden');
    else box.classList.add('hidden');
  }
  (function wireNoQuotaBuy(){
    var b7=document.getElementById('noQuotaBuy7');
    var b30=document.getElementById('noQuotaBuy30');
    if(b7)b7.addEventListener('click',function(){if(window.JitouBuy&&window.JitouBuy.buy7)window.JitouBuy.buy7();});
    if(b30)b30.addEventListener('click',function(){if(window.JitouBuy&&window.JitouBuy.buy30)window.JitouBuy.buy30();});
  })();
};
