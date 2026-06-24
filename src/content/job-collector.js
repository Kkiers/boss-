// 岗位收集模块 — DOM 解析 + 无限滚动 + 标签聚类 + URL 筛选
const JobCollector = {
  collected: new Map(), // id → job
  stopped: false,
  scrollDelay: 1500,
  maxPages: 20, // 最多翻20页
  _excludeSet: null,

  _bindExcludeSet: function (params) {
    var arr = (params && params.excludeJobIds) || [];
    this._excludeSet = new Set(Array.isArray(arr) ? arr : []);
  },

  _isExcluded: function (jobId) {
    return !!(jobId && this._excludeSet && this._excludeSet.has(jobId));
  },

  _eligibleCount: function () {
    if (!this._excludeSet || !this._excludeSet.size) return this.collected.size;
    var n = 0;
    for (var job of this.collected.values()) {
      if (!this._isExcluded(job.id)) n++;
    }
    return n;
  },

  // ── 福利数据关联：读 welfare-collector（MAIN world）写的 DOM 属性 ──
  // welfare-collector hook joblist.json 拿到 encryptJobId → welfareList，
  // 写 data-jitou-welfare-map。这里按 job.id（= encryptJobId）关联。
  // 拿不到属性/对应键缺失 → 返回 null，由消费方 fail-open（不误杀）。
  readWelfareMap() {
    try {
      const raw = document.documentElement.getAttribute('data-jitou-welfare-map');
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  },

  // joblist.json 拦截数据（welfare-collector MAIN world 写入）
  readApiJobMap() {
    try {
      const raw = document.documentElement.getAttribute('data-jitou-joblist-map');
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  },

  clearApiJobMap() {
    try {
      document.documentElement.removeAttribute('data-jitou-joblist-map');
    } catch (e) {}
  },

  detectLoginWall() {
    const cardCount = queryAllJobCards(document).nodes.length;
    if (cardCount > 0) return false;
    const t = (document.body && document.body.innerText) || '';
    return /登录\/注册|登录状态已失效|当前登录状态|请登录|扫码登录/.test(t);
  },

  mergeApiJobsIntoCollected(maxCollect) {
    var limit = (maxCollect > 0) ? maxCollect : Infinity;
    const apiMap = this.readApiJobMap();
    if (!apiMap || typeof apiMap !== 'object') return 0;
    let added = 0;
    for (const id of Object.keys(apiMap)) {
      if (this.collected.size >= limit) break;
      const job = apiMap[id];
      if (!job || !job.id) continue;
      const welfareMap = this.readWelfareMap();
      if (welfareMap && Array.isArray(welfareMap[job.id])) job.welfareList = welfareMap[job.id];
      if (!job.restDay) job.restDay = this.classifyRestDay(job.name);
      if (!this.collected.has(job.id)) {
        this.collected.set(job.id, job);
        added++;
      }
    }
    this._trimToLimit(limit);
    return added;
  },

  // ── 双休标题打标 ──
  // BOSS 网页端工作制信息只活在 jobName 标题文本里，零结构化字段（四重印证锁死，
  // 见 需求收集/双休筛选-HANDOFF.md 0′ 节）。故双休唯一可落地方案 = 标题关键词打标，
  // 数据源 = 已采集的 jobName，零额外请求、零新增风控面。
  // 返回 'double'（命中双休白名单）| 'no'（命中非双休黑名单）| 'unknown'（都不命中）。
  // 黑名单优先于白名单：标题同时出现"双休"和"大小周/单休"时判 no（更保守，宁可不标也不误标）。
  classifyRestDay(jobName) {
    const t = String(jobName || '');
    if (!t) return 'unknown';
    // 黑名单：即便含"休"字也不算稳定双休（单双休=有时单休，排除）
    const NO = ['大小周', '单休', '做六休一', '单双周', '单双休'];
    for (let i = 0; i < NO.length; i++) {
      if (t.indexOf(NO[i]) !== -1) return 'no';
    }
    // 白名单：标题明写稳定双休
    const YES = ['双休', '周末双休', '做五休二', '五天工作制', '五天双休', '五天八小时'];
    for (let j = 0; j < YES.length; j++) {
      if (t.indexOf(YES[j]) !== -1) return 'double';
    }
    return 'unknown';
  },

  // ── 卡片解析 ──
  parseCard(card, welfareMap) {
    const nameEl = queryInCard(card, SELECTORS.jobs.jobName, SELECTORS.jobs.jobNameFallbacks);
    const salaryEl = queryInCard(card, SELECTORS.jobs.jobSalary, SELECTORS.jobs.jobSalaryFallbacks);
    const companyEl = queryInCard(card, SELECTORS.jobs.company, SELECTORS.jobs.companyFallbacks);
    let tagEls = card.querySelectorAll(SELECTORS.jobs.tagList);
    if (!tagEls.length && SELECTORS.jobs.tagListFallbacks) {
      for (const alt of SELECTORS.jobs.tagListFallbacks) {
        tagEls = card.querySelectorAll(alt);
        if (tagEls.length) break;
      }
    }
    const tags = [...tagEls].map((t) => t.textContent.trim());
    const link = card.querySelector('a')?.href || '';
    const id = link.match(/job_detail\/([^.]+)\.html/)?.[1] || link;

    // welfareList：从 MAIN world 拦截器数据按 id 关联；拿不到则 null（fail-open）
    const welfareList = (welfareMap && Array.isArray(welfareMap[id])) ? welfareMap[id] : null;

    const name = nameEl?.textContent.trim() || '';

    return {
      id,
      name,
      salary: decodeSalary(salaryEl?.textContent || ''),
      company: companyEl?.textContent.trim() || '',
      tags,
      link,
      welfareList,
      restDay: this.classifyRestDay(name), // 双休标题打标：'double'|'no'|'unknown'
    };
  },

  _lastCardSelector: '',

  // ── 解析当前页所有卡片 ──
  parseCurrentPage() {
    const found = queryAllJobCards(document);
    const cards = found.nodes;
    if (found.selector) this._lastCardSelector = found.selector;
    const welfareMap = this.readWelfareMap();
    let newCount = 0;
    cards.forEach((card) => {
      const job = this.parseCard(card, welfareMap);
      if (job.id && !this.collected.has(job.id)) {
        this.collected.set(job.id, job);
        newCount++;
      } else if (job.id && job.welfareList && this.collected.has(job.id)) {
        // 回填：旧记录此前未拿到 welfareList（DOM 先于 joblist.json 解析时），现补上
        const prev = this.collected.get(job.id);
        if (!prev.welfareList) prev.welfareList = job.welfareList;
      }
    });
    return newCount;
  },

  // ── 获取当前筛选标签 ──
  getActiveTags() {
    const tags = [];
    const synthesis = document.querySelector(SELECTORS.jobs.synthesis);
    if (synthesis) tags.push({ type: 'recommend', name: synthesis.textContent.trim() });

    document.querySelectorAll(SELECTORS.jobs.expectItemText).forEach((el) => {
      tags.push({ type: 'expect', name: el.textContent.trim() });
    });
    return tags;
  },

  // ── 无限滚动 ──
  async scrollToLoad(progressCb, maxCollect) {
    this.stopped = false;
    var limit = (maxCollect > 0) ? maxCollect : Infinity;

    // 等首批卡片渲染（页面刚跳转 AJAX 未回时，避免立即 break 退出）
    const waitStart = Date.now();
    // 等 DOM 卡片或 joblist.json 拦截数据（后台 tab 可能 DOM 慢但 API 先到）
    while (Date.now() - waitStart < 20000) {
      if (queryAllJobCards(document).nodes.length > 0) break;
      const apiMap = this.readApiJobMap();
      if (apiMap && Object.keys(apiMap).length > 0) break;
      await sleep(500);
    }

    let page = 0;
    let prevEligible = 0;

    while (!this.stopped && page < this.maxPages) {
      this.parseCurrentPage();
      this.mergeApiJobsIntoCollected(0);
      if (this._eligibleCount() >= limit) break;
      const currentEligible = this._eligibleCount();
      if (currentEligible !== prevEligible) {
        progressCb({ collected: currentEligible });
        prevEligible = currentEligible;
      }

      // 滚动到底
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(this.scrollDelay);

      // 检测是否有新内容加载
      const newCards = queryAllJobCards(document).nodes;
      if (newCards.length <= this.collected.size + 1) {
        // 可能没有更多了
        await sleep(1000);
        this.parseCurrentPage();
        this.mergeApiJobsIntoCollected(0);
        if (this._eligibleCount() === currentEligible) break;
      }
      page++;
    }

    // 最终解析 + 截断到配额
    this.parseCurrentPage();
    this.mergeApiJobsIntoCollected(0);
    this._trimToLimit(limit);
  },

  _trimToLimit(limit) {
    if (!(limit > 0)) return;
    var kept;
    if (this._excludeSet && this._excludeSet.size) {
      kept = Array.from(this.collected.values()).filter(function (j) { return !this._isExcluded(j.id); }.bind(this)).slice(0, limit);
    } else {
      kept = Array.from(this.collected.values()).slice(0, limit);
    }
    this.collected.clear();
    for (var i = 0; i < kept.length; i++) this.collected.set(kept[i].id, kept[i]);
  },

  // ── 按标签聚类 ──
  clusterByTag() {
    const clusters = {};
    for (const job of this.collected.values()) {
      const primaryTag = job.tags[0] || '其他';
      if (!clusters[primaryTag]) clusters[primaryTag] = [];
      clusters[primaryTag].push(job);
    }
    return clusters;
  },

  // ── 取每类代表性 JD ──
  sampleJDs(clusters, perCluster = 5) {
    const samples = {};
    for (const [tag, jobs] of Object.entries(clusters)) {
      samples[tag] = jobs.slice(0, perCluster).map((j) => ({
        title: j.name,
        tags: j.tags,
        desc: j.name, // JD 详情需额外抓取
      }));
    }
    return samples;
  },

  // ── 福利精筛（fail-open，绝不误杀） ──
  // requireWelfare：需要包含的福利关键词数组（如 ['五险一金']）。
  // 规则：① 关闭/空条件 → 原样返回；② 某岗 welfareList 缺失(null/非数组) →
  // 视为「数据未知」一律保留（fail-open）；③ 仅当 welfareList 已知且不含全部
  // 要求关键词时才滤掉。语义对齐「福利打标·标记无误杀」。
  // 返回 { kept, dropped, unknown }：kept=保留岗位，dropped=明确不满足被滤，
  // unknown=因数据缺失而 fail-open 放行的岗位数（供上层提示/统计）。
  filterByWelfare(jobs, requireWelfare) {
    const need = Array.isArray(requireWelfare) ? requireWelfare.filter(Boolean) : [];
    if (need.length === 0) {
      return { kept: jobs, dropped: [], unknown: 0 };
    }
    const kept = [];
    const dropped = [];
    let unknown = 0;
    for (const job of jobs) {
      const wl = job && job.welfareList;
      if (!Array.isArray(wl)) {
        // 数据未知 → fail-open 保留
        unknown++;
        kept.push(job);
        continue;
      }
      const ok = need.every((kw) => wl.some((w) => String(w).indexOf(kw) !== -1));
      if (ok) kept.push(job);
      else dropped.push(job);
    }
    return { kept, dropped, unknown };
  },

  // ── 双休精筛（fail-open，绝不误杀 + 命中置顶） ──
  // restDayFilter：'双休' 时启用，其余/空 → 不筛原样返回。
  // 规则：① 标题命中双休白名单（restDay==='double'）→ 保留并置顶；② 标题命中非双休
  // 黑名单（restDay==='no'，如大小周/单休）→ 明确滤掉；③ restDay==='unknown'（标题
  // 没写工作制）→ fail-open 一律保留（HR 未在标题写明 ≠ 非双休，绝不误杀）。
  // kept 顺序 = 双休命中岗在前（置顶），unknown 岗在后，保持各自原相对顺序。
  // 返回 { kept, dropped, unknown }：unknown=因标题无工作制信息而 fail-open 放行的岗位数。
  filterByRestDay(jobs, restDayFilter) {
    const list = Array.isArray(jobs) ? jobs : [];
    if (restDayFilter !== '双休') {
      return { kept: list, dropped: [], unknown: 0 };
    }
    const hit = [];     // restDay==='double'，置顶
    const failOpen = []; // restDay==='unknown'，fail-open 保留在后
    const dropped = [];  // restDay==='no'，明确非双休
    for (const job of list) {
      const rd = (job && job.restDay) || JobCollector.classifyRestDay(job && job.name);
      if (rd === 'double') hit.push(job);
      else if (rd === 'no') dropped.push(job);
      else failOpen.push(job);
    }
    return { kept: hit.concat(failOpen), dropped, unknown: failOpen.length };
  },

  // ── 按标签分组顺序发送计划 ──
  buildSendPlan(clusters, greetings) {
    const plan = [];
    for (const [tag, jobs] of Object.entries(clusters)) {
      for (const job of jobs) {
        plan.push({
          jobId: job.id,
          category: tag,
          greeting: greetings[tag] || '',
        });
      }
    }
    return plan;
  },
};

// ── 收集入口 ──
// 注意：导航逻辑已移至 service worker，避免页面重载销毁 content script 执行上下文
async function runCollection(params, progressCb) {
  JobCollector.stopped = false;
  JobCollector.collected.clear();
  JobCollector.clearApiJobMap();
  JobCollector._bindExcludeSet(params);
  var maxCollect = (params && params.maxCollect > 0) ? params.maxCollect : 0;
  var isFast = !!(params && params.testMode);

  if (isFast) {
    // 测试模式：滚动直到凑够 N 个「未投递过」的岗位（跳过 excludeJobIds）
    var waitStart = Date.now();
    while (Date.now() - waitStart < 12000) {
      JobCollector.parseCurrentPage();
      JobCollector.mergeApiJobsIntoCollected(0);
      if (JobCollector._eligibleCount() >= maxCollect) break;
      if (queryAllJobCards(document).nodes.length > 0) break;
      var apiMap = JobCollector.readApiJobMap();
      if (apiMap && Object.keys(apiMap).length > 0) break;
      await sleep(400);
    }
    var maxRounds = Math.max(4, Math.min(20, Math.ceil((maxCollect || 1) / 3) + (JobCollector._excludeSet.size ? 8 : 0)));
    for (var round = 0; round < maxRounds && JobCollector._eligibleCount() < maxCollect; round++) {
      JobCollector.parseCurrentPage();
      JobCollector.mergeApiJobsIntoCollected(0);
      if (JobCollector._eligibleCount() >= maxCollect) break;
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(900);
    }
    JobCollector._trimToLimit(maxCollect);
    if (progressCb) progressCb({ collected: JobCollector._eligibleCount() });
  } else {
    await JobCollector.scrollToLoad(progressCb, maxCollect);
    JobCollector.mergeApiJobsIntoCollected(0);
    if (maxCollect > 0) JobCollector._trimToLimit(maxCollect);
  }

  const domCardCount = queryAllJobCards(document).nodes.length;
  const apiJobCount = Object.keys(JobCollector.readApiJobMap() || {}).length;
  const loginRequired = JobCollector.detectLoginWall();
  const clusters = JobCollector.clusterByTag();

  return {
    jobs: [...JobCollector.collected.values()],
    clusters,
    count: JobCollector.collected.size,
    jdSamples: JobCollector.sampleJDs(clusters),
    collectDiag: {
      loginRequired,
      domCardCount,
      apiJobCount,
      cardSelector: JobCollector._lastCardSelector || '',
      maxCollect: maxCollect || 0,
      url: location.href,
    },
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
