// ════════════════════════════════════════════════════════════
// 即投 — 统一常量（单一真相源）
// ════════════════════════════════════════════════════════════

// ── 消息类型常量（popup ↔ background ↔ content） ──
const MSG = {
  // Popup → SW
  GET_STATE: 'GET_STATE',
  SAVE_MUTABLE_STATE: 'SAVE_MUTABLE_STATE',
  START_COLLECT: 'START_COLLECT',
  STOP_COLLECT: 'STOP_COLLECT',
  START_SEND: 'START_SEND',
  STOP_SEND: 'STOP_SEND',
  START_BROWSE: 'START_BROWSE',         // Popup -> SW: 浏览模式投递（首页推荐流逐卡片）
  STOP_BROWSE: 'STOP_BROWSE',           // Popup -> SW: 停止浏览投递
  REGENERATE_GREETING: 'REGENERATE_GREETING',
  INVALIDATE_RESUME_CACHE: 'INVALIDATE_RESUME_CACHE',
  UPDATE_GREETING: 'UPDATE_GREETING',
  REWRITE_GREETING: 'REWRITE_GREETING',
  GET_API_KEY: 'GET_API_KEY',
  SAVE_API_KEY: 'SAVE_API_KEY',
  REPAIR_MISSED: 'REPAIR_MISSED',   // A1：review 页「一键补发」漏发岗位（popup→SW 专用，CS 不用，无需镜像 selectors.js）

  // SW → Popup
  STATE_UPDATE: 'STATE_UPDATE',
  ERROR: 'ERROR',

  // Content → SW
  JOBS_COLLECTED: 'JOBS_COLLECTED',
  COLLECT_PROGRESS: 'COLLECT_PROGRESS',
  COLLECT_CITY_PROGRESS: 'COLLECT_CITY_PROGRESS',
  COLLECT_URL_PLAN: 'COLLECT_URL_PLAN',   // SW -> Popup: 采集 URL 计划（透明展示用）
  COLLECT_STOPPED: 'COLLECT_STOPPED',     // SW -> Popup: 用户停止采集（partial=是否已有岗位）
  SEND_PROGRESS: 'SEND_PROGRESS',
  SEND_ITEM_RESULT: 'SEND_ITEM_RESULT',
  SEND_COMPLETE: 'SEND_COMPLETE',
  BROWSE_PROGRESS: 'BROWSE_PROGRESS',   // CS -> SW -> Popup: 浏览投递进度
  BROWSE_ITEM_RESULT: 'BROWSE_ITEM_RESULT', // CS -> SW: 单岗浏览投递结果
  BROWSE_COMPLETE: 'BROWSE_COMPLETE',   // CS -> SW: 浏览投递完成
  CHAT_DETECTED: 'CHAT_DETECTED',
  AUTO_REPLY_SENT: 'AUTO_REPLY_SENT',
  JD_FETCHED: 'JD_FETCHED',
  PONG: 'PONG',

  // SW → Content
  DO_COLLECT: 'DO_COLLECT',
  DO_SEND: 'DO_SEND',
  DO_STOP: 'DO_STOP',
  DO_BROWSE: 'DO_BROWSE',               // SW -> CS(搜索页): 执行浏览投递循环
  PING: 'PING',

  // v5 发送架构
  DO_START_CHAT: 'DO_START_CHAT',       // v5: SW -> CS(搜索页): 启动聊天流程
  DO_SEND_CHAT: 'DO_SEND_CHAT',         // v5: SW -> CS(聊天页): 发送消息
  CS_READY: 'CS_READY',                 // CS -> SW: CS 注入完成，就绪信号

  // v6 发送架构
  WORKER_ACTIVATE: 'WORKER_ACTIVATE',
  QUEUE_EMPTY: 'QUEUE_EMPTY',
  DO_BATCH_EXTRACT: 'DO_BATCH_EXTRACT',
  DO_SINGLE_EXTRACT: 'DO_SINGLE_EXTRACT', // SW -> CS(详情页): 单岗提取 HR + 点立即沟通
  EXTRACT_PROGRESS: 'EXTRACT_PROGRESS',
  EXTRACT_COMPLETE: 'EXTRACT_COMPLETE',
  WORKER_SEND: 'WORKER_SEND',
  WORKER_RESULT: 'WORKER_RESULT',
  WORKER_REPAIR: 'WORKER_REPAIR',       // SW -> 补发 tab: 重进对话核对历史、缺啥补啥

  // #39 阶段1跳转恢复：同 HR 新岗位点立即沟通后 BOSS 整页跳 /web/geek/chat，确认弹窗弹在消息页
  CONFIRM_CHANGE_JOB_DIALOG: 'CONFIRM_CHANGE_JOB_DIALOG', // SW -> 消息页 CS: 点「沟通新职位」确认钮，响应 {clicked, reason}（🔴 必须镜像 selectors.js）

  // CAPTCHA
  CAPTCHA_DETECTED: 'CAPTCHA_DETECTED',

  // 招呼语开关 pre-flight（陷阱 #31 / 双发修复）：投递前关闭 BOSS 自动招呼，仅发扩展 AI 定制语
  CHECK_GREETING_SETTING: 'CHECK_GREETING_SETTING',   // SW -> CS(搜索页): 读 getGreetingList，返回 {success, enabled, templateId}（🔴 必须镜像 selectors.js）
  ENABLE_GREETING_SETTING: 'ENABLE_GREETING_SETTING', // SW -> CS(搜索页): 写开+复读自检，返回 {ok, enabled}（🔴 必须镜像 selectors.js）
  DISABLE_GREETING_SETTING: 'DISABLE_GREETING_SETTING', // SW -> CS(搜索页): 写关 status=0（🔴 必须镜像 selectors.js）
  GREETING_AUTO_ENABLED: 'GREETING_AUTO_ENABLED',     // SW -> Popup: 已自动开启打招呼开关的非阻断提示（CS 不用，无需镜像 selectors.js）
  GREETING_DISABLED_FOR_SEND: 'GREETING_DISABLED_FOR_SEND', // SW -> Popup: 投递前已关闭 BOSS 自动招呼语（仅发 AI 定制语）
  GET_DAILY_SEND_COUNT: 'GET_DAILY_SEND_COUNT',       // Popup -> SW: 读当天（本地自然日）已成功投递岗位数，投递前 gate 用（CS 不用，无需镜像 selectors.js）
  GET_BROWSE_DAILY_COUNT: 'GET_BROWSE_DAILY_COUNT', // Popup -> SW: 浏览模式今日累计成功投递数
};

// ── Storage key 白名单（sw:/ui: 前缀隔离） ──
const STORAGE_KEYS = {
  // Service Worker 持久化（sw: 前缀）
  SW: {
    STATE: 'sw:state',
    API_KEY: 'sw:apiKey',
    TEXT_RESUME: 'sw:textResume',
    PHASE: 'sw:phase',
    JOBS: 'sw:jobs',
    GREETINGS: 'sw:greetings',
    SEND_PROGRESS: 'sw:sendProgress',
    SENT_JOB_IDS: 'sw:sentJobIds',
    APPLIED_JOB_IDS: 'sw:appliedJobIds',   // 已成功投递/已沟通过的岗位 id（跨批次持久化，采集时跳过）
    SEND_RESULTS: 'sw:sendResults',
    SEND_DURATION: 'sw:sendDuration',
    SEARCH_URL: 'sw:searchUrl',
    PENDING_GREETING: 'sw:pendingGreeting',
    PENDING_JOB_ID: 'sw:pendingJobId',
    SEND_QUEUE_V6: 'sw:sendQueueV6',
    SEND_QUEUE_INDEX: 'sw:sendQueueIndex',
    SEND_PHASE: 'sw:sendPhase',
    SELECTED_POSITIONS: 'sw:selectedPositions',
    CUSTOM_POSITIONS: 'sw:customPositions',
    MISSED_JOBS: 'sw:missedJobs',
    DAILY_SEND_COUNT: 'sw:dailySendCount',  // 投递数量闸门：{date:'YYYY-MM-DD', count:N}，本地自然日成功投递岗位数，跨日归零
    BROWSE_DAILY_COUNT: 'sw:browseDailyCount', // 浏览模式今日累计成功投递：{date, count}，跨日归零，停止不清零
    LAST_SNAPSHOT: 'sw:lastSnapshot',       // 诊断旁路：每次 persistState 落盘的内存态快照摘要（脱敏），SW 卸载后导出仍有基本完整快照
  },
  // 诊断滚动持久化（diag: 前缀）—— 与 SW 内存态解耦，新任务清内存也不丢
  DIAG: {
    RECENT_RUNS: 'diag:recentRuns',         // ring buffer：最近 5 次投递任务结束时的完整诊断摘要（含时间戳/sendResults/snapshot）
  },
  // UI / Popup 持久化（ui: 前缀）
  UI: {
    LAST_CITY: 'ui:lastCity',
    FILTER_STATE: 'ui:filterState',
    GROUP_EXPANDED: 'ui:groupExpanded',
    JOB_CUSTOM: 'ui:jobCustom',
  },
};

// ── 全局配置参数 ──
const CONFIG = {
  // 每组分组的最大岗位数
  MAX_JOBS_PER_GROUP: 6,
  // AI 招呼语生成超时（ms）
  GREETING_TIMEOUT_MS: 8000,
  // AI 招呼语并发数
  GREETING_CONCURRENCY: 3,
  // 采集/发送批处理大小
  BATCH_SIZE: 50,
  // 发送间隔下限（ms）
  SEND_INTERVAL_MIN_MS: 2000,
  // 发送间隔上限（ms）
  SEND_INTERVAL_MAX_MS: 4000,
  // 批次间休息时间（ms）
  BATCH_REST_MS: 90000,
  // 最大采集标签页数
  MAX_COLLECT_TABS: 2,
  // 简历图片最大数量
  RESUME_MAX_COUNT: 10,
  // 简历缩略图宽度（px）
  RESUME_THUMB_WIDTH: 200,
  // v6 并行发送架构
  MAX_SEND_WORKERS: 3, // 并行发送 worker 数（每个 worker 跑在独立后台窗口，避免 hidden tab WS 风暴）
  EXTRACT_CARD_DELAY_MS: 1500,
  CONVERSATION_POLL_MS: 500,
  CONVERSATION_TIMEOUT_MS: 6000,
  POST_EXTRACT_DELAY_MS: 3000,
  // 后台 tab 节流下的填字/确认等待（>=600ms 给 BOSS Vue 重渲染 btn-send 状态）
  FILL_SETTLE_MS: 700,
  // 图片上传 XHR 超时（loadend 不到时兜底）
  IMG_UPLOAD_TIMEOUT_MS: 15000,
  // SW → worker tab keepalive 心跳间隔（chrome.alarms 最低 30s）
  KEEPALIVE_PERIOD_MIN: 0.5,
  // 投递数量闸门
  DAILY_SEND_LIMIT: 150,   // 日累积上限（本地自然日）：当天成功投递岗位数超过即硬拦
  SOFT_BATCH_LIMIT: 75,    // 单批软提示阈值：单批选中 > 75 时提示但允许继续
  // BOSS 日沟通上限（用户反馈约 350；采集前按期望职位数均分，避免一次采上千条）
  BOSS_COMM_DAILY_CAP: 350,
  // 投递模式：platform=BOSS 平台自动招呼（快速）；custom=扩展定制招呼语+简历图
  DEFAULT_SEND_MODE: 'platform',
  SEND_MODE_PLATFORM: 'platform',
  SEND_MODE_CUSTOM: 'custom',
  // 工作模式：search=搜索采集+批量投递；browse=首页推荐流逐卡片投递
  WORK_MODE_SEARCH: 'search',
  WORK_MODE_BROWSE: 'browse',
  DEFAULT_WORK_MODE: 'search',
  // 本地模式：跳过商业化门禁与云端 AI（COS/CloudBase），使用固定招呼语
  LOCAL_MODE: true,
  // 全局默认固定招呼语（未在 FIXED_GREETINGS_BY_CATEGORY 中单独配置的期望职位使用此文案）
  FIXED_GREETING_TEXT: '您好，我对贵司的招聘岗位很感兴趣，有相关领域的工作经验，相信能够胜任该岗位。期待有机会进一步沟通，以下是我的简历',
  // 按期望职位配置不同固定招呼语（key 须与 A 页「已选岗位 / 自定义职位」名称一致，区分大小写不敏感）
  // 示例：把下面 key 改成你实际选的职位名，value 改成对应招呼语
  FIXED_GREETINGS_BY_CATEGORY: {
    '测试开发': '您好，我有IOT测试开发经验，负责自动化测试、测试Agent及缺陷根因分析，希望进一步了解贵司测试开发岗位。',
    '测试工程师':'您好，我有IoT安防及车载语音测试经验，擅长测试设计、缺陷分析和质量保障，期待了解岗位情况。',
    'AI Agent': '您好，我有Agent应用开发经验，熟悉LangGraph、RAG、多Agent协作及工具调用,做过企业知识库与自动化流程Agent，关注AI落地与业务价值转化，希望交流贵司相关方向。',
    'fde':'您好，我具备测试开发和Agent开发背景，擅长需求拆解、业务理解与方案落地，希望了解贵司FDE岗位。',
  },
};

// LOCAL_MODE 下取固定招呼语：先查 FIXED_GREETINGS_BY_CATEGORY，再回退 FIXED_GREETING_TEXT
function lookupFixedGreetingByCategory(category) {
  var byCat = CONFIG.FIXED_GREETINGS_BY_CATEGORY;
  if (!byCat || !category) return '';
  if (byCat[category]) return byCat[category];
  var keys = Object.keys(byCat);
  var catLc = String(category).toLowerCase();
  for (var i = 0; i < keys.length; i++) {
    if (keys[i].toLowerCase() === catLc) return byCat[keys[i]];
  }
  return '';
}

function getFixedGreeting(category) {
  var specific = lookupFixedGreetingByCategory(category);
  if (specific) return specific;
  return CONFIG.FIXED_GREETING_TEXT || '';
}

// 采集配额：日上限均分到每个期望职位，再均分到每个目标城市（每城每条搜索 URL 的上限）
function calcCollectQuotas(params) {
  var positions = allExpectedPositionsFromParams(params || {});
  var nPos = Math.max(1, positions.length);
  var cities = (params && params.selectedCities) || [];
  var nCity = Math.max(1, cities.length || 1);
  var cap = (typeof CONFIG !== 'undefined' && CONFIG.BOSS_COMM_DAILY_CAP) || 350;
  var perPosition = Math.max(1, Math.floor(cap / nPos));
  var perCityPerPosition = Math.max(1, Math.floor(perPosition / nCity));
  return {
    dailyCap: cap,
    perPosition: perPosition,
    perCityPerPosition: perCityPerPosition,
    positionCount: nPos,
    cityCount: nCity,
  };
}

// 测试投递：仅用第一个目标城市，每个期望职位各采 N 个岗位（N 由 testJobsPerPosition 配置）
function buildTestCollectUrlPlan(params) {
  var p = params || {};
  var cities = (p.selectedCities && p.selectedCities.length)
    ? [p.selectedCities[0]]
    : (p.urlParams && p.urlParams.city ? [p.urlParams.city] : ['']);
  return buildCollectUrlPlan(Object.assign({}, p, { selectedCities: cities }));
}

function normalizeTestJobsPerPosition(n) {
  var v = parseInt(n, 10);
  if (isNaN(v) || v < 1) return 1;
  if (v > 50) return 50;
  return v;
}

function normalizeBrowseSessionLimit(n) {
  var v = parseInt(n, 10);
  if (isNaN(v) || v < 0) return 0;
  if (v > 500) return 500;
  return v;
}

function calcTestCollectQuotas(params) {
  var positions = allExpectedPositionsFromParams(params || {});
  var nPos = Math.max(1, positions.length);
  var perPos = normalizeTestJobsPerPosition(params && params.testJobsPerPosition);
  return {
    dailyCap: nPos * perPos,
    perPosition: perPos,
    perCityPerPosition: perPos,
    positionCount: nPos,
    cityCount: 1,
    testMode: true,
    testJobsPerPosition: perPos,
  };
}

// 招呼语占位/失败文案（后端读不到简历图时也会返回其中某些串）
var GREETING_PLACEHOLDERS = ['生成失败，请刷新', '请重新上传清晰的简历图片'];
function isGreetingPlaceholder(text) {
  var t = (text || '').trim();
  if (!t) return true;
  if (GREETING_PLACEHOLDERS.indexOf(t) >= 0) return true;
  if (t.indexOf('请重新上传') >= 0 && t.indexOf('简历') >= 0) return true;
  if (t.indexOf('生成失败') >= 0) return true;
  return false;
}

// 岗位标题排除：名称包含任一关键词则剔除（不纳入采集结果）
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

function filterJobsByExcludeTitle(jobs, excludeText) {
  if (!excludeText || !parsePriorityList(excludeText).length) return jobs || [];
  return (jobs || []).filter(function (j) { return !jobMatchesExcludeTitle(j, excludeText); });
}

// 公司名称排除：公司名包含任一关键词则剔除（不纳入采集结果）
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

function filterJobsByExcludeCompany(jobs, excludeText) {
  if (!excludeText || !parsePriorityList(excludeText).length) return jobs || [];
  return (jobs || []).filter(function (j) { return !jobMatchesExcludeCompany(j, excludeText); });
}

// 剔除已投递过的岗位（appliedIds 为 Set 或数组）
function filterJobsByApplied(jobs, appliedIds) {
  if (!appliedIds) return jobs || [];
  var set = appliedIds instanceof Set ? appliedIds : new Set(appliedIds || []);
  if (!set.size) return jobs || [];
  return (jobs || []).filter(function (j) {
    var id = j && (j.id || j.jobId);
    return !id || !set.has(id);
  });
}

// ── 岗位归类：单一真相源（分来源打分） ──
// 一个 job 该归到哪个期望词组的唯一判定。SW（采集过滤 / 发送分组 / cluster）
// 与 popup（B 页 prepareGroups）都调它，保证「编辑 key === 发送 key」、归组结果一致。
// 病根修复：历史上三套不同打分（采集 50% / 发送 60% / 分组无重叠分支）导致编辑组≠发送组、落「其他」。
//
// 两类来源都走严格匹配（不用字符重叠，避免「游戏运营」靠 运/营 重叠误纳「电商运营」、
// 「AI产品经理」靠重叠把纯产品经理岗都带进来）：
//   picker 词：name===pos +10 / 分词(/[\s·/&]+/)后每 token 都 includes 岗位名 +5
//   custom 词：name===pos +10 / name 完整含 pos(>=2) +5 / else 英文段精确命中 +3
//   两类都：tag===pos +8 / tag 完整含 pos +3（严格，无反向）
// 返回最佳期望词（bestScore>=3）；0 匹配的极端 fallback 才返回 '其他'。
function matchJobToExpected(job, picker, custom) {
  var pickerArr = Array.isArray(picker) ? picker : [];
  var customArr = Array.isArray(custom) ? custom : [];
  if (!pickerArr.length && !customArr.length) return '其他';
  // BOSS 返回 name/tags 大小写不可控，比较前两侧 toLowerCase，但返回值用 original pos 保 key 一致
  var jobNameLc = ((job && job.name) || '').toLowerCase();
  var tags = (job && job.tags) || [];
  var bestPos = '其他', bestScore = 0;

  // tag 打分（严格，picker 与 custom 共用）：仅 tag===pos(+8) 或 tag 完整含 pos(+3)。
  // 不给 pos 含 tag 片段的反向分 —— 否则「AI产品经理」会因 tag『产品』被纯产品经理岗误纳。
  function scoreTagsStrict(posLc) {
    var s = 0;
    for (var t = 0; t < tags.length; t++) {
      var tLc = (tags[t] || '').toLowerCase();
      if (tLc === posLc) s += 8;
      else if (tLc.indexOf(posLc) >= 0) s += 3;
    }
    return s;
  }

  // picker：严格，不用字符重叠。复用 filterJobsByExpected 原 picker 逻辑（分词全命中）
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

  // custom：严格（与 picker 同款 scoreTagsStrict）。仅 name 完整含词条 / 英文段精确命中，无字符重叠
  for (var ci = 0; ci < customArr.length; ci++) {
    var cpos = customArr[ci];
    var cposLc = (cpos || '').toLowerCase();
    var cscore = 0;
    if (jobNameLc === cposLc) cscore += 10;
    else if (cposLc.length >= 2 && jobNameLc.indexOf(cposLc) >= 0) cscore += 5;
    else {
      // 英文段精确命中（如 flutter / flutter工程师）：英文是区分词，要求至少一个长度>=2 的
      // 英文段是岗位名子串 +3。否则「后端工程师」会靠通用中文后缀「工程师」蹭进「flutter工程师」组，
      // 纯英文「flutter」也会靠单字母 l/u/t/e/r 重叠误纳无关英文岗位。
      // 纯中文不再做字符重叠兜底：自创词条退回与 picker 同款严格 —— 只认 name 完整含词条（上方
      // 连续子串 +5）或下方 scoreTagsStrict。避免「游戏运营」靠 运/营 字符重叠误纳「电商运营」。
      var latinSegs = (cposLc.match(/[a-z0-9]+/g) || []).filter(function (s) { return s.length >= 2; });
      if (latinSegs.length && latinSegs.some(function (s) { return jobNameLc.indexOf(s) >= 0; })) cscore += 3;
    }
    cscore += scoreTagsStrict(cposLc);
    if (cscore > bestScore) { bestScore = cscore; bestPos = cpos; }
  }

  return (bestPos !== '其他' && bestScore >= 3) ? bestPos : '其他';
}

// ── BOSS 搜索 URL 构建（popup / SW 共用，单一真相源）──
function buildJobUrl(params) {
  const base = 'https://www.zhipin.com/web/geek/jobs';
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v != null && v !== '') qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? base + '?' + s : base;
}

function allExpectedPositionsFromParams(params) {
  const sp = Array.isArray(params && params.selectedPositions) ? params.selectedPositions : [];
  const cp = Array.isArray(params && params.customPositions) ? params.customPositions : [];
  return sp.concat(cp);
}

// 每个「城市 × 期望职位」一条独立搜索 URL（禁止 comma 拼 query，BOSS 不支持）
function buildCollectUrlPlan(params) {
  const base = Object.assign({}, (params && params.urlParams) || {});
  delete base.query;
  let cities = (params && params.selectedCities && params.selectedCities.length)
    ? params.selectedCities.slice()
    : (base.city ? [base.city] : ['']);
  const positions = allExpectedPositionsFromParams(params);
  if (!positions.length) positions.push('');
  const plan = [];
  for (let ci = 0; ci < cities.length; ci++) {
    const cityCode = cities[ci];
    const urlParams = Object.assign({}, base, { city: cityCode || base.city || '' });
    const dbc = params && params.districtByCity && params.districtByCity[cityCode];
    if (dbc) urlParams.multiBusinessDistrict = dbc;
    else delete urlParams.multiBusinessDistrict;
    for (let pi = 0; pi < positions.length; pi++) {
      const pos = positions[pi];
      const up = Object.assign({}, urlParams);
      if (pos) up.query = pos;
      plan.push({
        cityCode: cityCode || '',
        position: pos || '',
        urlParams: up,
        url: buildJobUrl(up),
      });
    }
  }
  return plan;
}

function dedupeJobsById(jobs) {
  const seen = new Map();
  const out = [];
  for (const job of (jobs || [])) {
    const id = (job && (job.id || job.jobId)) || '';
    if (!id) { out.push(job); continue; }
    if (!seen.has(id)) { seen.set(id, true); out.push(job); }
  }
  return out;
}

// ── 投递优先级：按公司名 + 岗位名规则打分（不依赖大模型，零延迟）──
// 名企（网易/滴滴等）+ 方向词（AI/机器人等）+ 规模标签 → 综合排序，优先投递高分岗位
var DEFAULT_PRIORITY_PREFS = {
  enabled: true,
  priorityThreshold: 25,
  preferredCompanies: [
    '网易', '滴滴', '腾讯', '阿里巴巴', '阿里', '蚂蚁', '字节', '抖音', '百度', '华为',
    '美团', '京东', '小米', '拼多多', '快手', '哔哩哔哩', 'B站', '携程', '小红书',
    '理想', '蔚来', '小鹏', '微软', 'Microsoft', 'Google', '谷歌', '苹果', 'Apple',
    'IBM', 'SAP', '甲骨文', 'Oracle', '顺丰', 'Shein', '米哈游', '大疆',
  ],
  preferredKeywords: [
    'ai', '人工智能', 'aigc', '大模型', 'llm', 'agent', '机器人', '具身智能',
    '自动驾驶', '智能驾驶', '智能硬件', '机器学习', '深度学习',
  ],
  positionKeywords: {
    '测试开发': ['ai', '人工智能', 'aigc', '大模型', 'llm', '机器人', '具身智能', 'agent', '自动驾驶', '智能'],
    '测试': ['ai', '人工智能', '机器人', '智能', '自动化'],
    'ai agent': ['agent', '大模型', 'llm', 'aigc', '智能体'],
    'fde': ['大厂', '头部', '标杆'],
  },
  largeCompanyTags: ['10000人以上', '已上市', '上市公司', '1000-9999人', 'D轮及以上'],
};

function normalizePriorityPrefs(prefs) {
  var u = prefs || {};
  var enabled = u.enabled !== false && u.prioritySortEnabled !== false;
  var def = DEFAULT_PRIORITY_PREFS;
  if (u._resolved) {
    return {
      enabled: enabled,
      priorityThreshold: u.priorityThreshold || def.priorityThreshold,
      preferredCompanies: Array.isArray(u.preferredCompanies) ? u.preferredCompanies : def.preferredCompanies,
      preferredKeywords: Array.isArray(u.preferredKeywords) ? u.preferredKeywords : def.preferredKeywords,
      positionKeywords: u.positionKeywords || {},
      largeCompanyTags: Array.isArray(u.largeCompanyTags) ? u.largeCompanyTags : def.largeCompanyTags,
    };
  }
  return {
    enabled: enabled,
    priorityThreshold: u.priorityThreshold || def.priorityThreshold,
    preferredCompanies: (u.preferredCompanies && u.preferredCompanies.length) ? u.preferredCompanies : def.preferredCompanies,
    preferredKeywords: (u.preferredKeywords && u.preferredKeywords.length) ? u.preferredKeywords : def.preferredKeywords,
    positionKeywords: Object.assign({}, def.positionKeywords, u.positionKeywords || {}),
    largeCompanyTags: (u.largeCompanyTags && u.largeCompanyTags.length) ? u.largeCompanyTags : def.largeCompanyTags,
  };
}

function getPositionKeywordsForMatch(prefs, matchedPosition) {
  var posKey = matchedPosition || '';
  if (!posKey || posKey === '其他') return [];
  if (prefs.positionKeywords[posKey]) return prefs.positionKeywords[posKey];
  var keys = Object.keys(prefs.positionKeywords);
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    var kLc = k.toLowerCase();
    var pLc = posKey.toLowerCase();
    if (pLc.indexOf(kLc) >= 0 || kLc.indexOf(pLc) >= 0) return prefs.positionKeywords[k];
  }
  return [];
}

function scoreJobPriority(job, prefs, matchedPosition) {
  prefs = normalizePriorityPrefs(prefs);
  if (!prefs.enabled) return { score: 0, reasons: [], isPriority: false };
  var score = 0;
  var reasons = [];
  var nameLc = ((job && job.name) || '').toLowerCase();
  var companyLc = ((job && job.company) || '').toLowerCase();
  var tags = (job && job.tags) || [];
  var tagsText = tags.join(' ').toLowerCase();

  for (var ci = 0; ci < prefs.preferredCompanies.length; ci++) {
    var co = (prefs.preferredCompanies[ci] || '').toLowerCase();
    if (co.length >= 2 && companyLc.indexOf(co) >= 0) {
      score += 30;
      reasons.push('名企:' + prefs.preferredCompanies[ci]);
      break;
    }
  }

  for (var lt = 0; lt < prefs.largeCompanyTags.length; lt++) {
    var tag = prefs.largeCompanyTags[lt];
    if (tagsText.indexOf((tag || '').toLowerCase()) >= 0) {
      score += 12;
      reasons.push('规模:' + tag);
      break;
    }
  }

  var kwScore = 0;
  for (var ki = 0; ki < prefs.preferredKeywords.length; ki++) {
    var kw = (prefs.preferredKeywords[ki] || '').toLowerCase();
    if (kw.length >= 2 && nameLc.indexOf(kw) >= 0) {
      kwScore += 10;
      reasons.push('方向:' + prefs.preferredKeywords[ki]);
    }
  }
  score += Math.min(kwScore, 30);

  var posKws = getPositionKeywordsForMatch(prefs, matchedPosition);
  var posKwScore = 0;
  for (var pi = 0; pi < posKws.length; pi++) {
    var pkw = (posKws[pi] || '').toLowerCase();
    if (pkw.length >= 2 && nameLc.indexOf(pkw) >= 0) {
      posKwScore += 15;
      reasons.push('偏好:' + posKws[pi]);
    }
  }
  score += Math.min(posKwScore, 45);

  return {
    score: score,
    reasons: reasons,
    isPriority: score >= prefs.priorityThreshold,
  };
}

function annotateJobsWithPriority(jobs, prefs, picker, custom) {
  prefs = normalizePriorityPrefs(prefs);
  for (var i = 0; i < (jobs || []).length; i++) {
    var j = jobs[i];
    var matched = matchJobToExpected(j, picker, custom);
    var r = scoreJobPriority(j, prefs, matched);
    j.priorityScore = r.score;
    j.priorityReasons = r.reasons;
    j.isPriority = r.isPriority;
  }
  return jobs;
}

function sortJobsByPriority(jobs, prefs, picker, custom) {
  prefs = normalizePriorityPrefs(prefs);
  if (!prefs.enabled) return jobs;
  return (jobs || []).slice().sort(function (a, b) {
    var sa = (a.priorityScore != null) ? a.priorityScore : scoreJobPriority(a, prefs, matchJobToExpected(a, picker, custom)).score;
    var sb = (b.priorityScore != null) ? b.priorityScore : scoreJobPriority(b, prefs, matchJobToExpected(b, picker, custom)).score;
    return sb - sa;
  });
}

function sortJobIdsByPriority(jobIds, jobs, prefs, picker, custom) {
  prefs = normalizePriorityPrefs(prefs);
  if (!prefs.enabled) return jobIds;
  var byId = {};
  for (var i = 0; i < (jobs || []).length; i++) byId[jobs[i].id] = jobs[i];
  return (jobIds || []).slice().sort(function (a, b) {
    var ja = byId[a];
    var jb = byId[b];
    var sa = ja && ja.priorityScore != null ? ja.priorityScore : scoreJobPriority(ja, prefs, matchJobToExpected(ja, picker, custom)).score;
    var sb = jb && jb.priorityScore != null ? jb.priorityScore : scoreJobPriority(jb, prefs, matchJobToExpected(jb, picker, custom)).score;
    return sb - sa;
  });
}

// 解析用户输入：逗号 / 中文逗号 / 顿号 / 换行
function parsePriorityList(text) {
  if (text == null || text === '') return [];
  return String(text).split(/[,，、;\n\r]+/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function formatPriorityList(arr) {
  return (arr || []).join(', ');
}

// 每行格式：期望职位: 关键词1, 关键词2
function parsePositionKeywords(text) {
  var out = {};
  if (!text) return out;
  var lines = String(text).split(/\n/);
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;
    var idx = line.indexOf(':');
    if (idx < 0) idx = line.indexOf('：');
    if (idx < 0) continue;
    var pos = line.slice(0, idx).trim();
    var kws = parsePriorityList(line.slice(idx + 1));
    if (pos && kws.length) out[pos] = kws;
  }
  return out;
}

function formatPositionKeywords(obj) {
  var lines = [];
  var keys = Object.keys(obj || {});
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    var arr = obj[k];
    if (arr && arr.length) lines.push(k + ': ' + arr.join(', '));
  }
  return lines.join('\n');
}

function defaultPriorityRulesText() {
  var def = DEFAULT_PRIORITY_PREFS;
  return {
    _initialized: true,
    companies: formatPriorityList(def.preferredCompanies),
    keywords: formatPriorityList(def.preferredKeywords),
    positionKeywords: formatPositionKeywords(def.positionKeywords),
    largeCompanyTags: formatPriorityList(def.largeCompanyTags),
    threshold: String(def.priorityThreshold),
  };
}

// 从 popup Store 构建完整优先级配置（用户可编辑规则 + 启用开关）
function buildPriorityPrefsFromStore(state) {
  var s = state || {};
  var rules = s.priorityRules;
  var def = DEFAULT_PRIORITY_PREFS;
  var useDefaults = !rules || !rules._initialized;
  var threshold = def.priorityThreshold;
  if (!useDefaults && rules.threshold != null && rules.threshold !== '') {
    var t = parseInt(rules.threshold, 10);
    if (!isNaN(t) && t > 0) threshold = t;
  }
  return {
    _resolved: true,
    enabled: s.prioritySortEnabled !== false,
    prioritySortEnabled: s.prioritySortEnabled,
    priorityThreshold: threshold,
    preferredCompanies: useDefaults ? def.preferredCompanies.slice() : parsePriorityList(rules.companies),
    preferredKeywords: useDefaults ? def.preferredKeywords.slice() : parsePriorityList(rules.keywords),
    positionKeywords: useDefaults ? Object.assign({}, def.positionKeywords) : parsePositionKeywords(rules.positionKeywords),
    largeCompanyTags: useDefaults ? def.largeCompanyTags.slice() : parsePriorityList(rules.largeCompanyTags),
  };
}
