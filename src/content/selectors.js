// BOSS 直聘 DOM 选择器集中管理 — 2026-05-13 实测 + 2026-06 多版本 fallback
const SELECTORS = {
  // ── 岗位搜索页 /web/geek/jobs ──
  jobs: {
    jobCard: 'li.job-card-box',
    // 新版列表常见 .job-list-box > .job-card-wrapper；旧版 li.job-card-box
    jobCardFallbacks: [
      'li.job-card-box',
      '.job-list-box .job-card-wrapper',
      '.job-card-wrapper',
      '.job-list-box > li',
      '.rec-job-list .job-card-wrapper',
    ],
    jobName: '.job-name',
    jobNameFallbacks: ['.job-title'],
    jobSalary: '.job-salary',
    jobSalaryFallbacks: ['.salary'],
    tagList: '.tag-list li',
    tagListFallbacks: ['.job-info .tag-list li', '.info-desc li'],
    company: '.job-card-footer .boss-info',
    companyFallbacks: ['.company-name', '.boss-info', '.company-info .name'],
    expectSelect: 'div.c-expect-select',
    synthesis: 'a.synthesis',
    expectItem: 'a.expect-item',
    expectItemText: 'a.expect-item span.text-content',
    filterCondition: 'div.filter-condition div.c-filter-condition',
    // Vue 下拉强制打开
    industryDropdown: '.condition-industry-select .filter-select-dropdown',
    // 立即沟通按钮（搜索页右侧详情面板），href=javascript:;
    immediateChatBtn: 'a.op-btn-chat',
  },

  // ── 聊天列表页 /web/geek/chat ──
  chatList: {
    userList: '.user-list-content li',
    unreadLabel: '.label-name',
    friendContent: '.friend-content',
  },

  // ── 聊天详情页 ──
  chatDetail: {
    chatInput: 'div#chat-input.chat-input',
    btnSend: 'button.btn-send',
    hrMessage: '.message-item.item-friend',
    systemMessage: '.message-item.item-system',
    // 自己发出的消息气泡（发送成功确认判据之一）
    messageSent: '.item-myself',
    imageUpload: '.btn-sendimg input[type=file]',
    resumeBtn: '.toolbar-btn',
    // 发简历弹窗
    resumeDialog: '.dialog-container',
    resumeItem: '.list-item',
    resumeConfirm: '.btn-confirm',
  },

  // ── JD 详情页 /job_detail/{id}.html ──
  jobDetail: {
    jobDetail: '.job-detail',
    jobSecText: '.job-sec-text',
  },
};

// 按 fallback 链查卡片列表（返回 NodeList；全未命中则空 NodeList）
function queryAllJobCards(ctx) {
  var root = ctx || document;
  var sels = (SELECTORS.jobs.jobCardFallbacks || [SELECTORS.jobs.jobCard]);
  for (var i = 0; i < sels.length; i++) {
    var nodes = root.querySelectorAll(sels[i]);
    if (nodes && nodes.length) return { nodes: nodes, selector: sels[i] };
  }
  return { nodes: root.querySelectorAll('.__zt_no_match__'), selector: '' };
}

function queryInCard(card, primary, fallbacks) {
  if (!card) return null;
  var el = card.querySelector(primary);
  if (el) return el;
  var alts = fallbacks || [];
  for (var i = 0; i < alts.length; i++) {
    el = card.querySelector(alts[i]);
    if (el) return el;
  }
  return null;
}

// ── 消息类型常量（popup ↔ background ↔ content） ──
// 必须与 src/shared/constants.js 的 MSG 完全一致：content script 不加载 constants.js，此处为镜像
const MSG = {
  // Popup → SW
  GET_STATE: 'GET_STATE',
  SAVE_MUTABLE_STATE: 'SAVE_MUTABLE_STATE',
  START_COLLECT: 'START_COLLECT',
  STOP_COLLECT: 'STOP_COLLECT',
  START_SEND: 'START_SEND',
  STOP_SEND: 'STOP_SEND',
  REGENERATE_GREETING: 'REGENERATE_GREETING',
  UPDATE_GREETING: 'UPDATE_GREETING',
  REWRITE_GREETING: 'REWRITE_GREETING',
  GET_API_KEY: 'GET_API_KEY',
  SAVE_API_KEY: 'SAVE_API_KEY',

  // SW → Popup
  STATE_UPDATE: 'STATE_UPDATE',
  ERROR: 'ERROR',

  // Content → SW
  JOBS_COLLECTED: 'JOBS_COLLECTED',
  COLLECT_PROGRESS: 'COLLECT_PROGRESS',
  COLLECT_CITY_PROGRESS: 'COLLECT_CITY_PROGRESS',
  SEND_PROGRESS: 'SEND_PROGRESS',
  SEND_ITEM_RESULT: 'SEND_ITEM_RESULT',
  SEND_COMPLETE: 'SEND_COMPLETE',
  CHAT_DETECTED: 'CHAT_DETECTED',
  AUTO_REPLY_SENT: 'AUTO_REPLY_SENT',
  JD_FETCHED: 'JD_FETCHED',
  PONG: 'PONG',

  // SW → Content
  DO_COLLECT: 'DO_COLLECT',
  DO_SEND: 'DO_SEND',
  DO_STOP: 'DO_STOP',
  PING: 'PING',

  // v5 发送架构
  DO_START_CHAT: 'DO_START_CHAT',
  DO_SEND_CHAT: 'DO_SEND_CHAT',
  CS_READY: 'CS_READY',

  // v6 发送架构
  WORKER_ACTIVATE: 'WORKER_ACTIVATE',
  QUEUE_EMPTY: 'QUEUE_EMPTY',
  DO_BATCH_EXTRACT: 'DO_BATCH_EXTRACT',
  DO_SINGLE_EXTRACT: 'DO_SINGLE_EXTRACT',
  EXTRACT_PROGRESS: 'EXTRACT_PROGRESS',
  EXTRACT_COMPLETE: 'EXTRACT_COMPLETE',
  WORKER_SEND: 'WORKER_SEND',
  WORKER_RESULT: 'WORKER_RESULT',
  WORKER_REPAIR: 'WORKER_REPAIR',       // 补发：SW -> 补发tab 重进对话核对、缺啥补啥（必须与 constants.js 同步）

  // #39 阶段1跳转恢复：SW -> 消息页 CS 点「沟通新职位」确认钮（必须与 constants.js 同步）
  CONFIRM_CHANGE_JOB_DIALOG: 'CONFIRM_CHANGE_JOB_DIALOG',

  // CAPTCHA
  CAPTCHA_DETECTED: 'CAPTCHA_DETECTED',

  // 招呼语开关 pre-flight（必须与 constants.js 同步）
  CHECK_GREETING_SETTING: 'CHECK_GREETING_SETTING',   // SW -> CS(搜索页): 读 getGreetingList
  ENABLE_GREETING_SETTING: 'ENABLE_GREETING_SETTING', // SW -> CS(搜索页): 写开关+复读自检
  DISABLE_GREETING_SETTING: 'DISABLE_GREETING_SETTING', // SW -> CS(搜索页): 写关 status=0
};

// ── URL 参数映射 ──
const URL_PARAMS = {
  city: '101280600', // 深圳
  experience: { '1-3年': '104', '3-5年': '105', '5-10年': '106' },
  degree: { 本科: '203', 硕士: '204', 博士: '205' },
  jobType: { 全职: '1' },
  position: null, // 三级岗位 code，从 API 获取
};

// ── 岗位分类 API ──
const POSITION_API =
  '/wapi/zpgeek/common/data/expectposition.json?cityCode={code}&version=1';
