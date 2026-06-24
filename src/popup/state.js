// ════════════════════════════════════════════════════════════
// 即投 — 全局状态 Store
// API: get / set / getSnapshot / restore
// ════════════════════════════════════════════════════════════

(function () {
  var _state = {
    mode: 'settings',
    city: { name: '', code: '' },
    selectedCities: [],
    resumeImages: [],
    selectedPositions: [],
    customPositions: [],
    hrActiveFilter: '不限',
    welfareFilter: '不限',
    restDayFilter: '不限',
    titleExcludeKeywords: '',
    companyExcludeKeywords: '',
    posSearchQuery: '',
    selectedIndustries: [],
    indSearchQuery: '',
    showAllIndustries: false,
    workAreasByCity: {}, // {cityCode:[区名]}，每城独立工作区域；缺省视作 ['不限']
    jobTypes: ['不限'],
    salaryRanges: ['不限'],
    experience: ['不限'],
    education: ['不限'],
    companySizes: ['不限'],
    fundingStages: ['不限'],
    prioritySortEnabled: true,
    priorityRules: null,
    cityOpen: false,
    progressDone: false,
    collecting: false,
    jobs: [],
    sending: false,
    groups: [],
    greetings: {},
    jobCustom: {},
    groupExpanded: {},
    testMode: false,
    testJobsPerPosition: 1,
  };

  // Backward-compatible alias (existing code uses S.xxx directly)
  window.S = _state;

  window.Store = {
    /** 读单个或全部（无参返回全部） */
    get: function (key) {
      return key === undefined ? _state : _state[key];
    },

    /** 写（开发模式有 schema 校验） */
    set: function (key, value) {
      _state[key] = value;
      // 自动持久化 ui: 前缀的状态
      persistUIState();
    },

    /** 深克隆，用于 SW 同步 */
    getSnapshot: function () {
      return JSON.parse(JSON.stringify(_state));
    },

    /** 恢复（popup 重开用），完全替换内部状态 */
    restore: function (snapshot) {
      // 清空所有现有 key
      var keys = Object.keys(_state);
      for (var i = 0; i < keys.length; i++) {
        delete _state[keys[i]];
      }
      // 从快照复制
      var copy = JSON.parse(JSON.stringify(snapshot));
      var ckeys = Object.keys(copy);
      for (var i = 0; i < ckeys.length; i++) {
        _state[ckeys[i]] = copy[ckeys[i]];
      }
    },
  };
})();

// UI 状态自动持久化（Store.set 触发，300ms 防抖）
var _persistTimer = null;
function persistUIState() {
  if (typeof chrome === 'undefined' || !chrome.storage) return;
  if (typeof STORAGE_KEYS === 'undefined') return;
  clearTimeout(_persistTimer);
  _persistTimer = setTimeout(function () {
    try {
      var state = window.S || {};
      var save = {};
      if (state.groupExpanded) {
        save[STORAGE_KEYS.UI.GROUP_EXPANDED] = state.groupExpanded;
      }
      if (state.jobCustom) {
        save[STORAGE_KEYS.UI.JOB_CUSTOM] = state.jobCustom;
      }
      chrome.storage.local.set(save);
    } catch (e) {}
  }, 300);
}
