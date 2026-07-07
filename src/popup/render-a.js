// ════════════════════════════════════════════════════════════
// 即投 — A 页（筛选页）渲染
// ════════════════════════════════════════════════════════════
// Depends on: E, Store, $/$$/esc (global globals)
// Depends on: TAG_DATA (from tag-data.js)

// ── Data access (TAG_DATA wrappers, also used by events-a) ──
function allPos(){
  var r=[],cats=TAG_DATA.positionTree&&TAG_DATA.positionTree.categories;
  if(!cats)return r;
  for(var ci=0;ci<cats.length;ci++){
    var c=cats[ci],l2s=c.children||[];
    for(var li=0;li<l2s.length;li++){
      var l2=l2s[li],l3s=l2.children||[];
      for(var ti=0;ti<l3s.length;ti++){var l3=l3s[ti];r.push({name:l3.name,l2:l2.name,l1:c.name})}
    }
  }
  return r;
}
function allInd(){
  var r=[],cats=TAG_DATA.industryCategories||[];
  for(var gi=0;gi<cats.length;gi++){var g=cats[gi];for(var ii=0;ii<(g.items||[]).length;ii++)r.push({name:g.items[ii],category:g.category})}
  return r;
}
// 某个城市的工作区域候选（含「不限」）；无 districtCodes 的城市/全国 只给「不限」
function getCityAreas(cityCode){
  if(!cityCode)return ['不限'];
  return ['不限'].concat(Object.keys((TAG_DATA.districtCodes||{})[cityCode]||{}));
}
// code→城市名 映射（含全国）
function cityNameMap(){
  var all=[{name:'全国',code:'000000'}].concat(TAG_DATA.cities||[]);
  var m={};for(var i=0;i<all.length;i++)m[all[i].code]=all[i].name;return m;
}
function getPositionCodes(names){
  var codes=[],cats=TAG_DATA.positionTree&&TAG_DATA.positionTree.categories;
  if(!cats)return codes;
  for(var ci=0;ci<cats.length;ci++){
    var l2s=cats[ci].children||[];
    for(var li=0;li<l2s.length;li++){
      var l3s=l2s[li].children||[];
      for(var ti=0;ti<l3s.length;ti++){
        var l3=l3s[ti];
        if(names.indexOf(l3.name)>=0&&codes.indexOf(l3.code)<0)codes.push(l3.code);
      }
    }
  }
  return codes;
}

// ── Shared thumbnail HTML (A page, B page, custom settings) ──
window.renderResumeThumbnailsHTML=function(){
  var images=Store.get('resumeImages')||[];
  var html='';
  for(var ii=0;ii<images.length;ii++){
    html+='<div class="univ-thumb" style="position:relative">'
      +'<img src="'+images[ii].src+'" alt="简历缩略图" data-gimg="'+ii+'">'
      +'<span class="thumb-remove" data-gimg="'+ii+'">&#x2715;</span>'
      +'</div>';
  }
  html+='<div class="univ-thumb-add" data-gact="addImg">+</div>';
  return html;
};

// ── Resume images ──
window.renderResumeImages=function(){
  E.resumeThumbArea.innerHTML=window.renderResumeThumbnailsHTML();
};

// ── City chips ──
// 一二线城市名单（排序优先）
var TIER1_2_CITIES=['北京','上海','广州','深圳','杭州','成都','武汉','南京','苏州','西安','重庆','长沙','天津','郑州','东莞','青岛','厦门','合肥','佛山','宁波','昆明','福州','无锡','济南','大连'];
window.renderCityChips=function(q){
  var selected=Store.get('selectedCities')||[];
  q=(q||'').trim().toLowerCase();
  var cts=[{name:'全国',code:'000000'}].concat(TAG_DATA.cities||[]);
  if(q)cts=cts.filter(function(c){return c.name.toLowerCase().indexOf(q)>=0});
  if(!cts.length){E.cityChipContainer.innerHTML='<div class="city-empty">未匹配到城市</div>';return}
  // 非搜索模式：一二线城市排前面，其余排后面
  if(!q){
    var ordered=[];
    for(var ci=0;ci<cts.length;ci++){if(cts[ci].code==='000000'){ordered.push(cts.splice(ci,1)[0]);break}}
    for(var pi=0;pi<TIER1_2_CITIES.length;pi++){
      for(var ci=0;ci<cts.length;ci++){
        if(cts[ci].name===TIER1_2_CITIES[pi]){ordered.push(cts.splice(ci,1)[0]);break}
      }
    }
    ordered=ordered.concat(cts);
    cts=ordered;
  }
  var isSearch=!!q;
  var wasExpanded=Store.get('cityExpanded')||false;
  E.cityChipContainer.innerHTML=cts.map(function(c){
    var sel=selected.indexOf(c.code)>=0;
    return'<span class="city-chip'+(sel?' selected':'')+'" data-code="'+c.code+'">'+esc(c.name)+'</span>'
  }).join('');
  E.cityChipContainer.classList.remove('city-search-mode','city-expanded');
  if(isSearch)E.cityChipContainer.classList.add('city-search-mode');
  else if(wasExpanded)E.cityChipContainer.classList.add('city-expanded');
  // 管理展开按钮（放在容器外，不受 overflow:hidden 影响）
  var oldBtn=E.cityChipContainer.parentNode.querySelector('.city-expand-btn');
  if(oldBtn)oldBtn.parentNode.removeChild(oldBtn);
  if(!isSearch){
    var expBtn=document.createElement('button');
    expBtn.className='expand-btn city-expand-btn';
    expBtn.textContent=wasExpanded?'收起':'展开更多';
    expBtn.addEventListener('click',function(){
      var nowExpanded=E.cityChipContainer.classList.contains('city-expanded');
      E.cityChipContainer.classList.toggle('city-expanded');
      Store.set('cityExpanded',!nowExpanded);
      expBtn.textContent=nowExpanded?'展开更多':'收起';
    });
    E.cityChipContainer.parentNode.insertBefore(expBtn, E.cityChipContainer.nextSibling);
  }
  window.renderCitySelected();
};

// ── City selected area（复刻「期望职位」已选区）──
window.renderCitySelected=function(){
  if(!E.citySelectedArea)return;
  var selected=Store.get('selectedCities')||[];
  var all=[{name:'全国',code:'000000'}].concat(TAG_DATA.cities||[]);
  var codeName={};
  for(var ci=0;ci<all.length;ci++)codeName[all[ci].code]=all[ci].name;
  if(!selected.length){E.citySelectedArea.innerHTML='';return}
  var html='<div class="selected-area" style="margin-top:14px"><div class="section-subtitle">已选城市</div><div class="selected-tags">';
  html+=selected.map(function(code){
    var nm=codeName[code]||code;
    return'<div class="selected-tag" data-code="'+esc(code)+'">'+esc(nm)+'<span class="tag-remove">&#x2715;</span></div>';
  }).join('');
  html+='</div></div>';
  E.citySelectedArea.innerHTML=html;
};

// ── Position browse ──
window.renderPosBrowse=function(){
  var state=Store.get();
  var raw=(state.posSearchQuery||'').trim();
  var q=raw.toLowerCase();
  var sel=state.selectedPositions||[];
  var custom=state.customPositions||[];
  // 已选区：picker 选中 + 自定义词并排，自定义带 data-custompos + 虚线边框区分
  function selectedAreaHtml(attr){
    if(!sel.length&&!custom.length)return'';
    var h='<div class="selected-area"'+(attr||'')+'><div class="section-subtitle">已选岗位</div><div class="selected-tags">';
    h+=sel.map(function(p){return'<div class="selected-tag" data-pos="'+esc(p)+'">'+esc(p)+'<span class="tag-remove">&#x2715;</span></div>'}).join('');
    h+=custom.map(function(p){return'<div class="selected-tag" data-custompos="'+esc(p)+'" style="border:1px dashed var(--accent)">'+esc(p)+'<span class="tag-remove">&#x2715;</span></div>'}).join('');
    h+='</div></div>';
    return h;
  }
  var html='';
  if(q){
    var all=allPos();var matched=all.filter(function(p){return p.name.toLowerCase().indexOf(q)>=0});
    if(matched.length){
      var groups={};
      for(var i=0;i<matched.length;i++){var p=matched[i];var key=p.l1+'/'+p.l2;if(!groups[key])groups[key]={l1:p.l1,l2:p.l2,items:[]};groups[key].items.push(p.name)}
      html+='<div class="search-results">';var keys=Object.keys(groups);
      for(var ki=0;ki<keys.length;ki++){var g=groups[keys[ki]];html+='<div class="search-result-group"><div class="result-l2-label">'+esc(g.l2)+'<span class="result-l1-label"> '+esc(g.l1)+'</span></div><div class="result-chips">';for(var ii=0;ii<g.items.length;ii++){var sp=sel.indexOf(g.items[ii])>=0;html+='<span class="chip'+(sp?' active':'')+'" data-pos="'+esc(g.items[ii])+'">'+esc(g.items[ii])+'</span>'}html+='</div></div>'}html+='</div>'
    }else{
      html+='<div class="search-results"><div class="empty-positions">未匹配到岗位</div>';
      if(raw)html+='<div style="text-align:center;margin-top:10px"><span class="add-custom-pos" data-addcustom="'+esc(raw)+'" style="padding:8px 14px;display:inline-block;border:1px dashed var(--accent);border-radius:16px;color:var(--accent);cursor:pointer;font-size:13px">+ 添加「'+esc(raw)+'」</span></div>';
      html+='</div>'
    }
    html+=selectedAreaHtml();
  }else{
    html+=selectedAreaHtml(' style="margin-top:0;border-top:none"');
  }
  E.posBrowseArea.innerHTML=html;
  E.posBrowseArea.style.minHeight=html?'20px':'0'
};

// ── Industry browse ──
window.renderInd=function(){
  var state=Store.get();
  var q=(state.indSearchQuery||'').trim().toLowerCase();
  if(q){window.renderIndSearch(q);return}
  var cats=state.showAllIndustries?TAG_DATA.industryCategories||[]:(TAG_DATA.industryCategories||[]).filter(function(c,i){return [0,1,2,3,4].indexOf(i)>=0});
  var selInd=state.selectedIndustries||[];
  var html='';
  if(selInd.length){html+='<div class="selected-tags" style="margin-bottom:10px">';html+=selInd.map(function(p){return'<div class="selected-tag" data-ind="'+esc(p)+'">'+esc(p)+'<span class="tag-remove">&#x2715;</span></div>'}).join('');html+='</div>'}
  for(var ci=0;ci<cats.length;ci++){var g=cats[ci];html+='<div class="industry-group collapsed" data-cat="'+esc(g.category)+'"><div class="industry-header" data-toggle="ind"><svg class="industry-chevron" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 4.5l3 3 3-3"/></svg><span>'+esc(g.category)+'</span></div><div class="industry-chips">';for(var ii=0;ii<g.items.length;ii++){var item=g.items[ii];var sel=selInd.indexOf(item)>=0;html+='<span class="chip'+(sel?' active':'')+'" data-ind="'+esc(item)+'">'+esc(item)+'</span>'}html+='</div></div>'}
  E.indArea.innerHTML=html;
  var totalInd=(TAG_DATA.industryCategories||[]).length;
  var selIndCount=(state.selectedIndustries||[]).length;
  E.expandIndustries.innerHTML='<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 4.5l3 3 3-3"/></svg> '+(state.showAllIndustries?'收起':'展开全部行业（已选 '+selIndCount+'/'+totalInd+'）');
  if(state.showAllIndustries)E.expandIndustries.classList.add('expanded');else E.expandIndustries.classList.remove('expanded');
  // 行业分类全折叠（不再默认展开前 2 个）
};
window.renderIndSearch=function(q){
  var state=Store.get();
  var selInd=state.selectedIndustries||[];
  var all=allInd();var matched=all.filter(function(p){return p.name.toLowerCase().indexOf(q)>=0||p.category.toLowerCase().indexOf(q)>=0});var html='';
  if(matched.length){html+='<div class="search-results">';var groups={};for(var i=0;i<matched.length;i++){var p=matched[i];if(!groups[p.category])groups[p.category]=[];groups[p.category].push(p.name)}var keys=Object.keys(groups);for(var ki=0;ki<keys.length;ki++){html+='<div class="search-result-group"><div class="result-l2-label">'+esc(keys[ki])+'</div><div class="result-chips">';var items=groups[keys[ki]];for(var ii=0;ii<items.length;ii++){var sel=selInd.indexOf(items[ii])>=0;html+='<span class="chip'+(sel?' active':'')+'" data-ind="'+esc(items[ii])+'">'+esc(items[ii])+'</span>'}html+='</div></div>'}html+='</div>'}else{html+='<div class="search-results"><div class="empty-positions">未匹配到行业</div></div>'}
  if(selInd.length){html+='<div class="selected-tags" style="margin-top:10px;margin-bottom:10px;padding-top:10px;border-top:1px solid var(--border-light)">';html+=selInd.map(function(p){return'<div class="selected-tag" data-ind="'+esc(p)+'">'+esc(p)+'<span class="tag-remove">&#x2715;</span></div>'}).join('');html+='</div>'}
  var cats=state.showAllIndustries?TAG_DATA.industryCategories||[]:(TAG_DATA.industryCategories||[]).filter(function(c,i){return[0,1,2,3,4].indexOf(i)>=0});
  if(cats.length){html+='<div class="ind-default-list" style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border-light)">';for(var ci=0;ci<cats.length;ci++){var g=cats[ci];html+='<div class="industry-group collapsed" data-cat="'+esc(g.category)+'"><div class="industry-header" data-toggle="ind"><svg class="industry-chevron" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 4.5l3 3 3-3"/></svg><span>'+esc(g.category)+'</span></div><div class="industry-chips">';for(var ii=0;ii<g.items.length;ii++){var itm=g.items[ii];var sel=selInd.indexOf(itm)>=0;html+='<span class="chip'+(sel?' active':'')+'" data-ind="'+esc(itm)+'">'+esc(itm)+'</span>'}html+='</div></div>'}html+='</div>'}
  E.indArea.innerHTML=html
};

// ── Chips ──
window.renderChips=function(cont,items,sel){
  cont.innerHTML=items.map(function(v){var s=sel.indexOf(v)>=0;return'<span class="chip'+(s?' active':'')+'" data-val="'+esc(v)+'">'+esc(v)+'</span>'}).join('');
};
window.renderHrActiveChips=function(){
  var cont=document.getElementById('hrActiveChips'); if(!cont)return;
  var vals=['不限','只投在线','3日内活跃','本周内活跃','本月内活跃'];
  var cur=Store.get('hrActiveFilter')||'不限';
  cont.innerHTML=vals.map(function(v){return'<span class="chip'+(v===cur?' active':'')+'" data-hract="'+esc(v)+'">'+esc(v)+'</span>'}).join('');
};
// 福利精筛（同 HR 活跃度单选模式）：'不限'=不筛 / '五险一金'=只留含五险一金的岗（fail-open）
window.renderWelfareChips=function(){
  var cont=document.getElementById('welfareChips'); if(!cont)return;
  var vals=['不限','五险一金'];
  var cur=Store.get('welfareFilter')||'不限';
  cont.innerHTML=vals.map(function(v){return'<span class="chip'+(v===cur?' active':'')+'" data-welfare="'+esc(v)+'">'+esc(v)+'</span>'}).join('');
};
// 双休精筛（同 HR 活跃度单选模式）：'不限'=不筛 / '双休'=标题命中双休置顶、明确非双休滤掉、未写明 fail-open 保留
window.renderRestDayChips=function(){
  var cont=document.getElementById('restDayChips'); if(!cont)return;
  var vals=['不限','双休'];
  var cur=Store.get('restDayFilter')||'不限';
  cont.innerHTML=vals.map(function(v){return'<span class="chip'+(v===cur?' active':'')+'" data-restday="'+esc(v)+'">'+esc(v)+'</span>'}).join('');
};
window.renderPriorityChips=function(){
  var cont=document.getElementById('priorityChips'); if(!cont)return;
  var enabled=Store.get('prioritySortEnabled')!==false;
  cont.innerHTML=['<span class="chip'+(enabled?' active':'')+'" data-priority="on">启用</span>',
    '<span class="chip'+(!enabled?' active':'')+'" data-priority="off">关闭</span>'].join('');
  var panel=document.getElementById('priorityRulesPanel');
  if(panel)panel.classList.toggle('hidden',!enabled);
};
window.ensurePriorityRules=function(){
  var rules=Store.get('priorityRules');
  if(!rules||!rules._initialized){
    if(typeof defaultPriorityRulesText==='function'){
      Store.set('priorityRules',defaultPriorityRulesText());
    }
  }
};
window.renderPriorityRules=function(){
  window.ensurePriorityRules();
  var rules=Store.get('priorityRules')||{};
  var elCo=document.getElementById('priorityCompanies');
  var elKw=document.getElementById('priorityKeywords');
  var elPos=document.getElementById('priorityPositionKeywords');
  var elTag=document.getElementById('priorityLargeTags');
  var elTh=document.getElementById('priorityThreshold');
  if(elCo&&document.activeElement!==elCo)elCo.value=rules.companies||'';
  if(elKw&&document.activeElement!==elKw)elKw.value=rules.keywords||'';
  if(elPos&&document.activeElement!==elPos)elPos.value=rules.positionKeywords||'';
  if(elTag&&document.activeElement!==elTag)elTag.value=rules.largeCompanyTags||'';
  if(elTh&&document.activeElement!==elTh)elTh.value=rules.threshold||'25';
  window.renderPriorityChips();
};
window.readPriorityRulesFromDom=function(){
  return{
    _initialized:true,
    companies:(document.getElementById('priorityCompanies')||{}).value||'',
    keywords:(document.getElementById('priorityKeywords')||{}).value||'',
    positionKeywords:(document.getElementById('priorityPositionKeywords')||{}).value||'',
    largeCompanyTags:(document.getElementById('priorityLargeTags')||{}).value||'',
    threshold:(document.getElementById('priorityThreshold')||{}).value||'25',
  };
};
// 工作区域：每个目标城市各渲一组 chip（多城时带城市名小标题），各城独立选区
window.renderWorkAreaGroups=function(){
  var cont=E.workAreaChips; if(!cont)return;
  var cities=Store.get('selectedCities')||[];
  var byCity=Store.get('workAreasByCity')||{};
  var codes=cities.length?cities:['']; // 未选城市 → 单组只「不限」
  var multi=codes.length>1;
  var names=cityNameMap();
  function chipsHtml(code){
    var areas=getCityAreas(code);
    var sel=byCity[code]||['不限'];
    return areas.map(function(v){
      var s=sel.indexOf(v)>=0;
      return '<span class="chip'+(s?' active':'')+'" data-city="'+esc(code)+'" data-val="'+esc(v)+'">'+esc(v)+'</span>';
    }).join('');
  }
  cont.className='chips-wrap'+(multi?' wa-grouped':'');
  if(multi){
    cont.innerHTML=codes.map(function(code){
      return '<div class="wa-city-group"><div class="section-subtitle">'+esc(names[code]||code)+'</div><div class="chips-wrap">'+chipsHtml(code)+'</div></div>';
    }).join('');
  }else{
    cont.innerHTML=chipsHtml(codes[0]);
  }
};
window.renderChipSecs=function(){
  var state=Store.get();
  window.renderWorkAreaGroups();
  window.renderChips(E.jobTypeChips,TAG_DATA.jobTypes||['不限','全职','兼职'],state.jobTypes||[]);
  window.renderChips(E.salaryChips,TAG_DATA.salaryRanges||['不限','3K以下','3-5K','5-10K','10-20K','20-50K','50K以上'],state.salaryRanges||[]);
  window.renderChips(E.expChips,TAG_DATA.experience||['不限','在校生(实习)','应届生(校招)','经验不限','1年以内','1-3年','3-5年','5-10年','10年以上'],state.experience||[]);
  window.renderChips(E.eduChips,TAG_DATA.education||['不限','初中及以下','中专/中技','高中','大专','本科','硕士','博士'],state.education||[]);
  window.renderChips(E.sizeChips,TAG_DATA.companySizes||['不限','0-20人','20-99人','100-499人','500-999人','1000-9999人','10000人以上'],state.companySizes||[]);
  window.renderChips(E.stageChips,TAG_DATA.fundingStages||['不限','未融资','天使轮','A轮','B轮','C轮','D轮及以上','已上市','不需要融资'],state.fundingStages||[]);
  window.renderHrActiveChips();
  window.renderWelfareChips();
  window.renderRestDayChips();
  window.renderTitleExcludeField();
  window.renderCompanyExcludeField();
  window.renderPriorityRules();
};
window.renderTitleExcludeField=function(){
  var el=document.getElementById('titleExcludeKeywords');
  if(!el||document.activeElement===el)return;
  el.value=Store.get('titleExcludeKeywords')||'';
};
window.renderCompanyExcludeField=function(){
  var el=document.getElementById('companyExcludeKeywords');
  if(!el||document.activeElement===el)return;
  el.value=Store.get('companyExcludeKeywords')||'';
};
window.renderSettings=function(){window.renderPosBrowse();window.renderInd();window.renderChipSecs()};

// ── Misc helpers ──
