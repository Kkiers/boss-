// 岗位过滤纯函数 — content script 侧复用（与 constants.js 同源，避免加载整包 constants 与 selectors.js 的 MSG 冲突）
function parsePriorityList(text) {
  if (text == null || text === '') return [];
  return String(text).split(/[,，、;\n\r]+/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function jobMatchesExcludeTitle(job, excludeText) {
  var kws = parsePriorityList(excludeText);
  if (!kws.length) return false;
  var nameLc = ((job && job.name) || '').toLowerCase();
  for (var i = 0; i < kws.length; i++) {
    var kw = (kws[i] || '').toLowerCase();
    if (kw && nameLc.indexOf(kw) >= 0) return true;
  }
  return false;
}

function jobMatchesExcludeCompany(job, excludeText) {
  var kws = parsePriorityList(excludeText);
  if (!kws.length) return false;
  var companyLc = ((job && job.company) || '').toLowerCase();
  for (var i = 0; i < kws.length; i++) {
    var kw = (kws[i] || '').toLowerCase();
    if (kw && companyLc.indexOf(kw) >= 0) return true;
  }
  return false;
}

function matchJobToExpected(job, picker, custom) {
  var pickerArr = Array.isArray(picker) ? picker : [];
  var customArr = Array.isArray(custom) ? custom : [];
  if (!pickerArr.length && !customArr.length) return '其他';
  var jobNameLc = ((job && job.name) || '').toLowerCase();
  var tags = (job && job.tags) || [];
  var bestPos = '其他', bestScore = 0;

  function scoreTagsStrict(posLc) {
    var s = 0;
    for (var t = 0; t < tags.length; t++) {
      var tLc = (tags[t] || '').toLowerCase();
      if (tLc === posLc) s += 8;
      else if (tLc.indexOf(posLc) >= 0) s += 3;
    }
    return s;
  }

  for (var i = 0; i < pickerArr.length; i++) {
    var pos = pickerArr[i];
    var posLc = (pos || '').toLowerCase();
    var score = 0;
    if (jobNameLc === posLc) score += 10;
    else {
      var tokens = posLc.split(/[\s·/&]+/).filter(Boolean);
      if (tokens.length && tokens.every(function (k) { return jobNameLc.indexOf(k) >= 0; })) score += 5;
    }
    score += scoreTagsStrict(posLc);
    if (score > bestScore) { bestScore = score; bestPos = pos; }
  }

  for (var ci = 0; ci < customArr.length; ci++) {
    var cpos = customArr[ci];
    var cposLc = (cpos || '').toLowerCase();
    var cscore = 0;
    if (jobNameLc === cposLc) cscore += 10;
    else if (cposLc.length >= 2 && jobNameLc.indexOf(cposLc) >= 0) cscore += 5;
    else {
      var latinSegs = (cposLc.match(/[a-z0-9]+/g) || []).filter(function (s) { return s.length >= 2; });
      if (latinSegs.length && latinSegs.some(function (s) { return jobNameLc.indexOf(s) >= 0; })) cscore += 3;
    }
    cscore += scoreTagsStrict(cposLc);
    if (cscore > bestScore) { bestScore = cscore; bestPos = cpos; }
  }

  return (bestPos !== '其他' && bestScore >= 3) ? bestPos : '其他';
}
