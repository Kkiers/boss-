// ════════════════════════════════════════════════════════════
// 即投 — Review 页（投递完成汇总）渲染
// ════════════════════════════════════════════════════════════
// Depends on: E, Store, $/esc (global)

window.renderReview=function(sendResults,duration,missedCount){
  var reviewPanel=document.getElementById('reviewPanel');
  if(!reviewPanel)return;

  var missed=missedCount||0; // A1 漏发清单条数（SW finalizeTask 计算：已建联但未发 AI 招呼语+图）
  var results=sendResults||[];
  var successCount=0,failCount=0;
  results.forEach(function(r){
    if(r.success)successCount++;else failCount++;
  });

  var total=successCount+failCount;
  // 根据成功率动态显示标题
  var titleText='投递完成';
  var iconColor='var(--green)';
  var iconBg='rgba(5,150,105,.1)';
  if(total>0&&failCount===total){
    titleText='投递失败';
    iconColor='var(--red)';
    iconBg='rgba(220,38,38,.1)';
  }else if(failCount>0){
    titleText='部分成功';
    iconColor='var(--accent)';
    iconBg='rgba(217,119,6,.1)';
  }

  var html='<div class="review-wrapper">'

    // Summary header
    +'<div class="review-summary">'
    +'<div class="review-icon"><svg width="40" height="40" viewBox="0 0 40 40" fill="none"><circle cx="20" cy="20" r="18" fill="'+iconBg+'" stroke="'+iconColor+'" stroke-width="1.5"/><path d="M12 20l6 6 10-10" stroke="'+iconColor+'" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div>'
    +'<div class="review-title">'+titleText+'</div>'
    +'<div class="review-stats">'
    +'投递 <span class="review-stat-num">'+total+'</span> 个岗位：'
    +'成功 <span class="review-stat-num" style="color:#22c55e">'+successCount+'</span> ｜'
    +'失败 <span class="review-stat-num" style="color:#ef4444">'+failCount+'</span>'
    +'</div>'
    +'</div>'

    // A1 漏发提示行：已建联（停止/中断前点过「立即沟通」）但未发 AI 招呼语+简历图的岗位 → 一键补发
    +(missed>0
      ?'<div class="review-missed-hint" style="margin:0 16px 12px;padding:10px 12px;background:rgba(217,119,6,.08);border:1px solid rgba(217,119,6,.25);border-radius:8px;font-size:12px;color:var(--accent);display:flex;align-items:center;gap:8px;">'
        +'<span style="flex:1;line-height:1.5">⚠️ '+missed+' 个岗位已建立沟通但未发送 AI 招呼语+简历图</span>'
        +'<button class="btn btn-primary" id="btnRepairMissed" style="flex:none;padding:5px 12px;font-size:12px;">一键补发</button>'
      +'</div>'
      :'')

    // Group detail cards
    +'<div class="review-groups">';

  // Group by position name
  var groupMap={};
  results.forEach(function(r){
    var pos=r.positionName||'其他';
    if(!groupMap[pos])groupMap[pos]={position:pos,items:[]};
    groupMap[pos].items.push(r);
  });

  var posKeys=Object.keys(groupMap);
  for(var pi=0;pi<posKeys.length;pi++){
    var gg=groupMap[posKeys[pi]];
    var gSuccess=gg.items.filter(function(i){return i.success}).length;
    var gFail=gg.items.filter(function(i){return !i.success}).length;
    html+='<div class="review-group-card">'
      +'<div class="review-group-header">'
      +'<span class="review-group-title">'+esc(gg.position)+'</span>'
      +'<span class="review-group-stat">'
      +(gSuccess>0?'<span class="review-success">✓</span> ':'')
      +(gFail>0?'<span class="review-fail">✗</span>':'')
      +'</span>'
      +'</div>'
      +'<div class="review-group-items'+(gg.items.length>5?' collapsed':'')+'">';
    for(var ii=0;ii<gg.items.length;ii++){
      var item=gg.items[ii];
      // alreadyChatted=true 视觉勾 + 「已沟通过，跳过」灰色文本（避免与「真成功」视觉相同导致误导）
      var _note=item.alreadyChatted?'已同HR沟通过，跳过':(item.error||'');
      html+='<div class="review-item'+(item.success?' review-item-success':(item.skipped?'':' review-item-fail'))+'">'
        +'<span class="review-item-icon">'+(item.success?'&#10003;':(item.skipped?'&#8211;':'&#10007;'))+'</span>'
        +'<span class="review-item-name">'+esc(item.companyName||'')+'</span>'
        +(_note?'<span class="review-item-error"'+((item.alreadyChatted||item.skipped)?' style="color:#94a3b8"':'')+'>'+esc(_note)+'</span>':'')
        +'</div>';
    }
    html+='</div>';
    if(gg.items.length>5){
      html+='<div class="review-expand-toggle" data-total="'+gg.items.length+'">展开全部 '+gg.items.length+' 个</div>';
    }
    html+='</div>';
  }

  html+='</div>' // review-groups

    // Retry button — 统一终态：「重新投递」用已存的 A 页筛选直接重收集，不回 A 页
    +'<div class="review-actions">'
    +'<button class="btn btn-primary" id="btnRetryBatch">重新投递</button>'
    +'</div>'

    +'</div>'; // review-wrapper

  reviewPanel.innerHTML=html;

  // Show review panel, hide results
  E.resultsContent.classList.add('hidden');
  E.bottomResults.classList.add('hidden');
  reviewPanel.style.display='';

  // Wire review group items expand/collapse via delegation.
  // 只绑定一次：renderReview 可能因 STATE_UPDATE 多次调用，
  // 重复 addEventListener 会让监听堆叠，偶数次时点击 toggle 互相抵消 → 按钮看似无反应。
  if(!reviewPanel._expandWired){
    reviewPanel._expandWired=true;
    reviewPanel.addEventListener('click',function(e){
      var expand=e.target.closest('.review-expand-toggle');
      if(expand){
        var card=expand.closest('.review-group-card');
        var items=card?card.querySelector('.review-group-items'):null;
        if(items){
          items.classList.toggle('collapsed');
          expand.textContent=items.classList.contains('collapsed')
            ?'展开全部 '+expand.dataset.total+' 个'
            :'收起';
        }
      }
    });
  }

  // Wire 「重新投递」→ 全 reset + 用已存的 A 页筛选直接重新收集（不回 A 页配置），落 results 结果页。
  // toResults() 内部：清 jobs/groups、重置投递按钮、用 buildCollectParams()(读已存筛选) 发 START_COLLECT。
  // SW 侧 startCollect 会重置发送相关 state；新一批点投递时 startSendV6 又会清 sendAborted/队列/worker。
  var retryBtn=document.getElementById('btnRetryBatch');
  if(retryBtn){
    retryBtn.addEventListener('click',function(){
      Store.set('reviewDismissed',true); // 标记已离开本批 review，handleStateUpdate 不再自动弹回
      Store.set('testMode',false);
      reviewPanel.style.display='none';
      reviewPanel.innerHTML='';
      reviewPanel._expandWired=false;
      window.toResults(); // 跳过 A 页，直接用已存筛选重新收集 → 落结果页
    });
  }

  // Wire 「一键补发」→ SW 把漏发清单入 _v6RepairQueue、startRepairMissed 启动 runRepairV6 单 tab 补发。
  // 进度/结果复用现有机制：SW phase=sending→review，STATE_UPDATE / SEND_COMPLETE 自动重渲 review（补发后 missed=0 提示行消失）。
  var repairBtn=document.getElementById('btnRepairMissed');
  if(repairBtn){
    repairBtn.addEventListener('click',function(){
      repairBtn.disabled=true;repairBtn.textContent='补发中…';
      try{
        chrome.runtime.sendMessage({type:MSG.REPAIR_MISSED},function(resp){
          if(chrome.runtime.lastError||!resp||!resp.success){
            repairBtn.disabled=false;
            repairBtn.textContent='补发失败，点击重试';
            repairBtn.title=(resp&&resp.error)||(chrome.runtime.lastError&&chrome.runtime.lastError.message)||'';
          }
        });
      }catch(e){
        repairBtn.disabled=false;repairBtn.textContent='补发失败，点击重试';
      }
    });
  }
};
