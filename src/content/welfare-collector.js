// ═══════════════════════════════════════════════════════════════════
// 福利采集器 — MAIN world + document_start，在 BOSS 发起 joblist.json 前 hook
// 捕获列表接口 zpData.jobList 每个岗位的 welfareList，按 encryptJobId 建索引，
// 写 data-jitou-welfare-map（DOM 属性，跨 world 可读）供 ISOLATED world 的
// job-collector 关联进 job 对象。纯只读，不改 BOSS 行为。
//
// 关联键说明：DOM 卡片 link = /job_detail/<encryptJobId>.html，job-collector
// 解析出的 job.id = encryptJobId；joblist.json 的 jobList[i].encryptJobId 同值，
// 二者即关联键。
// ═══════════════════════════════════════════════════════════════════
(function () {
  if (window.__ztWelfareCollector) return;
  window.__ztWelfareCollector = true;

  // encryptJobId → welfareList（累积，跨翻页保留）
  var welfareMap = {};
  // encryptJobId → 岗位对象（joblist.json 拦截，DOM 采不到时的主数据源）
  var jobListMap = {};

  function flush() {
    try {
      document.documentElement.setAttribute('data-jitou-welfare-map', JSON.stringify(welfareMap));
    } catch (e) {}
  }

  function flushJobs() {
    try {
      document.documentElement.setAttribute('data-jitou-joblist-map', JSON.stringify(jobListMap));
    } catch (e) {}
  }

  function jobFromApiItem(j) {
    var key = j && j.encryptJobId;
    if (!key) return null;
    var skills = j.skills || j.jobLabels || [];
    var tags = Array.isArray(skills) ? skills.map(function (s) { return String(s); }) : [];
    return {
      id: key,
      name: j.jobName || '',
      salary: j.salaryDesc || '',
      company: j.brandName || '',
      tags: tags,
      link: 'https://www.zhipin.com/job_detail/' + key + '.html',
      welfareList: Array.isArray(j.welfareList) ? j.welfareList : null,
    };
  }

  function ingest(jsonText) {
    try {
      var obj = JSON.parse(jsonText);
      var list = obj && obj.zpData && obj.zpData.jobList;
      if (!Array.isArray(list)) return;
      var changed = false;
      var jobsChanged = false;
      for (var i = 0; i < list.length; i++) {
        var j = list[i] || {};
        var key = j.encryptJobId;
        if (!key) continue;
        var parsed = jobFromApiItem(j);
        if (parsed) {
          jobListMap[key] = parsed;
          jobsChanged = true;
        }
        // welfareList 是字符串数组；只在拿到非空数组时写入（fail-open 由消费方保证）
        if (Array.isArray(j.welfareList)) {
          welfareMap[key] = j.welfareList;
          changed = true;
        }
      }
      if (changed) flush();
      if (jobsChanged) flushJobs();
    } catch (e) {}
  }

  function isJobListUrl(url) {
    return /joblist\.json|\/search\/joblist|zpgeek\/search\/joblist/i.test(String(url || ''));
  }

  // ── hook fetch ──
  var oFetch = window.fetch;
  if (oFetch) {
    window.fetch = function () {
      var url = '';
      try { url = String(arguments[0] && (arguments[0].url || arguments[0])); } catch (e) {}
      var p = oFetch.apply(this, arguments);
      if (isJobListUrl(url)) {
        p.then(function (resp) {
          try { resp.clone().text().then(ingest); } catch (e) {}
        }).catch(function () {});
      }
      return p;
    };
  }

  // ── hook XHR ──
  var OXHR = window.XMLHttpRequest;
  if (OXHR) {
    var oOpen = OXHR.prototype.open;
    var oSend = OXHR.prototype.send;
    OXHR.prototype.open = function (method, url) {
      try { this.__ztUrl = String(url); } catch (e) {}
      return oOpen.apply(this, arguments);
    };
    OXHR.prototype.send = function () {
      var self = this;
      try {
        if (isJobListUrl(self.__ztUrl)) {
          self.addEventListener('load', function () {
            try { ingest(self.responseText); } catch (e) {}
          });
        }
      } catch (e) {}
      return oSend.apply(this, arguments);
    };
  }
})();
