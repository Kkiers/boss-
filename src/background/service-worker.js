// Service Worker — 消息中枢 + 阿里云百炼 Qwen API 代理
importScripts('/src/shared/constants.js');
importScripts('/src/shared/error-logger.js');
importScripts('/src/shared/diag-logger.js');
importScripts('/src/shared/device-id.js');  // 商业化：device_id（self.DeviceId.get），招呼语/门禁/扣额度均用
// 诊断包：SW 启动事件（冷启动/被消息唤醒都会走到这里）。
// 纯内存 push + 异步节流落盘，不阻塞 boot-restore 链路（#33/#36 竞态红线）。
try { DiagLogger.userEvent('sw.lifecycle', 'SW started (cold start or wake)'); } catch (_) {}
// Key 存储于 chrome.storage.local（apiKey），首次启动自动预置默认 Key，用户可在 Options 页更换
// 默认 API Key（阿里云百炼），首次启动自动写入 storage
const DEFAULT_API_KEY = 'sk-886decf071954c0593d2ba70ab694a83';

// SW 启动时检查 storage，为空则写入默认 Key（开箱即用）
async function ensureApiKey() {
  const result = await chrome.storage.local.get('apiKey');
  if (!result.apiKey) {
    await chrome.storage.local.set({ apiKey: DEFAULT_API_KEY });
  }
}

const QWEN_CONFIG = {
  endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  model: 'qwen3.6-plus',
  maxTokens: 4096,
  temperature: 0.3
};

const QWEN_VL_CONFIG = {
  endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  model: 'qwen-vl-plus',
  maxTokens: 4096,
  temperature: 0.3
};

// ════════════════════════════════════════════════════════════════
// 商业化后端：招呼语生成（藏 Key）+ 投递门禁 + 免费额度消耗
// 基域与 popup/account.js 一致。device_id 用 self.DeviceId.get()。
// 🔴 容错铁律：门禁查询失败/超时一律放行投递（不误伤付费用户）。
// ════════════════════════════════════════════════════════════════
const BACKEND_BASE = 'https://cloudbase-d7gpznxde64f324c6-1428092559.ap-shanghai.app.tcloudbase.com';

function isLocalMode() {
  return !!(CONFIG && CONFIG.LOCAL_MODE);
}

// LOCAL_MODE 固定招呼语优先级：① constants 按职位映射 ② 设置页全局 fixedGreetingText ③ constants 全局默认
async function getLocalFixedGreeting(category) {
  if (typeof lookupFixedGreetingByCategory === 'function') {
    var byPos = lookupFixedGreetingByCategory(category);
    if (byPos) return byPos;
  } else if (typeof getFixedGreeting === 'function') {
    var fromCode = getFixedGreeting(category);
    if (fromCode && fromCode !== (CONFIG.FIXED_GREETING_TEXT || '')) return fromCode;
  }
  try {
    var stored = await chrome.storage.local.get(['fixedGreetingText']);
    var custom = (stored && stored.fixedGreetingText || '').trim();
    if (custom) return custom;
  } catch (e) {}
  return typeof getFixedGreeting === 'function' ? getFixedGreeting(category) : (CONFIG.FIXED_GREETING_TEXT || '');
}

function getDeviceIdSafe() {
  try {
    if (typeof self !== 'undefined' && self.DeviceId && self.DeviceId.get) return self.DeviceId.get();
  } catch (e) {}
  return Promise.resolve('');
}

// 简历图「原图直传 COS」：绕开 CloudBase 网关 ~100KB body 死限,不再压缩(整页压成 640px 糊图
// → 模型 OCR 失真 → 杜撰公司/学历,是招呼语幻觉根因)。改为把用户上传的原图(保原分辨率)直传到
// 腾讯云 COS,后端只发临时上传凭证、记录 fileID,/greeting 拿 fileID 取 COS URL 喂模型。
//
// 两步:① POST 后端 /upload-token {device_id, slot} 拿 {fileID, upload:{url,authorization,token,
//   cosFileId,key}};② 裸 fetch FormData POST 原图 blob 到 upload.url(字段 Signature/x-cos-
//   security-token/x-cos-meta-fileid/key/file)。COS 成功返空串,失败返 XML <Error>(必须判这个,
//   不能只看 HTTP 状态)。收集每张 fileID,整批只传一次,N 个岗位类目复用同一组 fileID。
// 失败不阻断:尽力而为,拿不到 fileID 时 /greeting 仍会生成(只是少图)。整批生成前调一次即可。
let _uploadedFileIds = null;     // 上批成功上传的 fileID 数组(整批复用)
let _uploadedSig = null;         // 防同批重传的签名(deviceId + 图字节签名)

function invalidateResumeImageCache() {
  _cachedResumeImages = null;
  _uploadedFileIds = null;
  _uploadedSig = null;
}

// 取上传凭证:POST /upload-token,走现有后端基域(JSON,非 COS 域)。
async function fetchUploadToken(deviceId, slot, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${BACKEND_BASE}/upload-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: deviceId, slot }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data || data.code !== 200 || !data.fileID || !data.upload || !data.upload.url) {
      throw new Error('upload-token 异常 HTTP ' + resp.status);
    }
    return data; // { code, fileID, upload:{ url, authorization, token, cosFileId, key } }
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

// 裸 FormData POST 原图 blob 到 COS。成功 COS 返空串;失败返 XML <Error>(必须判,HTTP 200 也可能错)。
async function putBlobToCos(upload, blob, timeoutMs = 30000) {
  const fd = new FormData();
  // 字段顺序与名称为 COS Post Object 协议精确要求(cos-spike 实证),file 必须最后 append。
  fd.append('key', upload.key);
  fd.append('Signature', upload.authorization);
  fd.append('x-cos-security-token', upload.token);
  fd.append('x-cos-meta-fileid', upload.cosFileId);
  fd.append('file', blob);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(upload.url, { method: 'POST', body: fd, signal: controller.signal });
    clearTimeout(timeoutId);
    const text = await resp.text().catch(() => '');
    // COS 成功:HTTP 204 + body 空串。失败:返 XML <Error>...(实测失败可能仍是 HTTP 200,
    // 故不能只看状态码,要看 body)。判据:HTTP 2xx 且 body 空 = 成功;否则(非空/含 <Error)失败。
    if (resp.ok && !text) return true;
    throw new Error(`COS 上传失败 HTTP ${resp.status} ${(text || '').slice(0, 160)}`);
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

// 把原图(最多 2 张,不压缩)直传 COS,返回 fileID 数组。整批只传一次(签名缓存)。
// 任一张失败不阻断:跳过该张,返回已成功的 fileID(尽力而为)。
async function uploadResumeImagesToCos(resumeImages, timeoutMs = 30000) {
  const imgs = (resumeImages || []).slice(0, 2);
  if (!imgs.length) return [];
  const deviceId = await getDeviceIdSafe();
  if (!deviceId) return [];
  // 同一批(同设备+同图集)只传一次。签名用原图字节长度(原图不变即不重传)。
  const sig = deviceId + '|' + imgs.map(i => (i.size || 0)).join(',') + '|' + imgs.length;
  if (_uploadedSig === sig && Array.isArray(_uploadedFileIds)) return _uploadedFileIds;

  const fileIds = [];
  for (let slot = 0; slot < imgs.length; slot++) {
    const img = imgs[slot];
    try {
      const tok = await fetchUploadToken(deviceId, slot, 15000);
      await putBlobToCos(tok.upload, img.blob, timeoutMs);
      fileIds.push(tok.fileID);
      console.log(`[即投] COS 上传成功 slot=${slot} fileID=${tok.fileID} size=${((img.size || 0) / 1024).toFixed(1)}KB`);
    } catch (err) {
      console.warn(`[即投] COS 上传失败 slot=${slot}:`, err.message);
      ErrorLogger.logError(err.message || String(err), err?.stack, 'uploadResumeImagesToCos');
    }
  }
  _uploadedFileIds = fileIds;
  _uploadedSig = sig;
  return fileIds;
}

// 招呼语：POST /greeting（后端代理 Qwen，藏 Key）。成功返回 greeting 文本。
// 简历图原图已直传 COS,本请求 body 带 file_ids(COS fileID 数组),后端用 fileID 取 COS URL 喂模型。
// 不再 body 带 base64 图(避免 413)。无权益(402)/失败(500) 抛错，由上层 fallback 占位串路径处理。
async function backendGenerateGreeting(category, fileIds, timeoutMs = 120000) {
  const deviceId = await getDeviceIdSafe();
  const body = JSON.stringify({
    device_id: deviceId,
    category: category,
    file_ids: Array.isArray(fileIds) ? fileIds : [],
  });
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${BACKEND_BASE}/greeting`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    const data = await resp.json().catch(() => ({}));
    if (resp.status === 402) {
      throw new Error((data && data.message) || '免费额度已用完，请开通会员');
    }
    if (!resp.ok || !data || data.code !== 200 || !data.greeting) {
      throw new Error('招呼语生成失败 HTTP ' + resp.status);
    }
    if (typeof isGreetingPlaceholder === 'function' && isGreetingPlaceholder(data.greeting)) {
      throw new Error('简历图片未识别，请确认已上传清晰简历后重试');
    }
    return data.greeting;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') throw new Error(`招呼语生成超时（${timeoutMs / 1000}秒）`);
    throw err;
  }
}

// 投递门禁：GET /entitlement?device_id → { active, free_available }。
// 返回 { allow:bool, reason }。🔴 网络异常/超时/后端不可达 → allow:true（容错放行）。
async function checkSendEntitlement(timeoutMs = 8000) {
  if (isLocalMode()) return { allow: true, reason: 'local-mode', free: false };
  const deviceId = await getDeviceIdSafe();
  if (!deviceId) return { allow: true, reason: 'no-device-id', free: false };
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${BACKEND_BASE}/entitlement?device_id=${encodeURIComponent(deviceId)}`, {
      method: 'GET',
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data || data.code !== 200) {
      // 后端异常响应 → 容错放行
      return { allow: true, reason: 'backend-error', free: false };
    }
    const active = !!data.active;
    const free = !!data.free_available;
    return { allow: active || free, reason: active ? 'member' : (free ? 'free' : 'no-quota'), free: free && !active };
  } catch (err) {
    clearTimeout(timeoutId);
    // 网络异常/超时/不可达 → 容错放行
    return { allow: true, reason: 'network-error', free: false };
  }
}

// 招呼语重写：POST /rewrite（后端代理 Qwen，藏 Key，复用 /greeting 计费闸口）。成功返回 greeting 文本。
// 无权益(402)/失败(500) 抛错，由上层 fallback 处理（与原 callQwen 失败对齐）。
async function backendRewriteGreeting(originalGreeting, instruction, timeoutMs = 60000) {
  const deviceId = await getDeviceIdSafe();
  const body = JSON.stringify({
    device_id: deviceId,
    original_greeting: originalGreeting,
    instruction: instruction,
  });
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${BACKEND_BASE}/rewrite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    const data = await resp.json().catch(() => ({}));
    if (resp.status === 402) {
      throw new Error((data && data.message) || '免费额度已用完，请开通会员');
    }
    if (!resp.ok || !data || data.code !== 200 || !data.greeting) {
      throw new Error('招呼语重写失败 HTTP ' + resp.status);
    }
    return data.greeting;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') throw new Error(`招呼语重写超时（${timeoutMs / 1000}秒）`);
    throw err;
  }
}

// 免费批成功后扣额度：POST /consume-free { device_id }（幂等）。失败静默，不影响主流程。
async function consumeFreeQuota(timeoutMs = 8000) {
  if (isLocalMode()) return;
  const deviceId = await getDeviceIdSafe();
  if (!deviceId) return;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(`${BACKEND_BASE}/consume-free`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: deviceId }),
      signal: controller.signal,
    });
  } catch (e) {
    ErrorLogger.logError(e.message || String(e), e?.stack, 'consumeFreeQuota');
  } finally {
    clearTimeout(timeoutId);
  }
}

// ── Qwen API ──
async function callQwen(apiKey, messages, maxTokens = 2000, timeoutMs = 12000, model = QWEN_CONFIG.model, label = '') {
  const tag = label ? `[TIMING][${label}]` : '[TIMING]';
  const t0 = Date.now();
  const bodyStr = JSON.stringify({
    model: model,
    messages,
    max_tokens: maxTokens,
    temperature: QWEN_CONFIG.temperature,
    enable_thinking: false
  });
  const tBodyReady = Date.now();
  const bodyKB = (bodyStr.length / 1024).toFixed(1);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  let tFetchStart, tFetchEnd, tParseEnd;
  try {
    tFetchStart = Date.now();
    console.log(`[即投]${tag} start bodyPrep=${tBodyReady - t0}ms bodySize=${bodyKB}KB timeout=${timeoutMs}ms`);
    const resp = await fetch(`${QWEN_CONFIG.endpoint}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: bodyStr,
      signal: controller.signal,
    });
    tFetchEnd = Date.now();
    clearTimeout(timeoutId);
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '未知错误');
      console.error(`[即投]${tag} HTTP ${resp.status} after fetch=${tFetchEnd - tFetchStart}ms`);
      throw new Error(`API 错误 ${resp.status}: ${errText.substring(0, 200)}`);
    }
    const data = await resp.json();
    tParseEnd = Date.now();
    console.log(`[即投]${tag} OK fetch=${tFetchEnd - tFetchStart}ms parse=${tParseEnd - tFetchEnd}ms TOTAL=${tParseEnd - t0}ms`);
    if (!data.choices || !data.choices.length) throw new Error('API 返回空结果');
    return data.choices[0].message.content;
  } catch (err) {
    clearTimeout(timeoutId);
    const tErr = Date.now();
    const phase = tFetchEnd ? 'parse' : (tFetchStart ? 'fetch' : 'pre');
    const fetchElapsed = tFetchStart ? ((tFetchEnd || tErr) - tFetchStart) : 0;
    const msg = `${tag} ${err.name} phase=${phase} fetchElapsed=${fetchElapsed}ms TOTAL=${tErr - t0}ms timeoutBudget=${timeoutMs}ms msg=${err.message}`;
    console.error(`[即投]${msg}`);
    ErrorLogger.logError(msg, err.stack, 'callQwen');
    if (err.name === 'AbortError') throw new Error(`请求超时（${timeoutMs/1000}秒），请检查网络`);
    throw err;
  }
}

async function generateGreeting(apiKey, resumeImages, jdSamples, category) {
  if (isLocalMode()) {
    return getLocalFixedGreeting(category);
  }
  const imgs = resumeImages || [];
  if (!imgs.length) {
    throw new Error('请先上传简历图片（A 页「图片版简历」）');
  }
  const fileIds = await uploadResumeImagesToCos(imgs, 30000);
  if (!fileIds.length) {
    throw new Error('简历图片上传失败，请检查网络后重试');
  }
  return backendGenerateGreeting(category, fileIds, 120000);
}

// ── Resume image cache (原图 Blob，reused across batch calls) ──
// B 方案后不再压缩(压缩=幻觉根因)。loadResumeImages 返回原图 Blob 数组,直传 COS。
let _cachedResumeImages = null;

async function loadResumeImages(forceRefresh) {
  if (!forceRefresh && _cachedResumeImages !== null) return _cachedResumeImages;

  try {
    const { resumeImages: stored } = await chrome.storage.local.get('resumeImages');
    if (!stored || !Array.isArray(stored) || stored.length === 0) {
      _cachedResumeImages = [];
      return [];
    }

    // 最多 2 张简历图。B 方案「原图直传 COS」:不压缩,storage 里 data 是原图字节数组
    // (options.js 存 Array.from(Uint8Array(arrayBuffer)))→ 转回原图 Blob 直传,保原分辨率。
    const toProcess = stored.slice(0, 2);
    const results = []; // [{ type, blob, size }]，blob 为原图二进制

    for (const s of toProcess) {
      try {
        const bytes = new Uint8Array(s.data);
        const mimeType = s.type || 'image/png';
        const blob = new Blob([bytes], { type: mimeType });
        results.push({ type: mimeType, blob, size: blob.size });
        console.log('[即投] resume image loaded (原图) size=' + (blob.size / 1024).toFixed(1) + 'KB type=' + mimeType);
      } catch (e) {
        // 单张转 Blob 失败:跳过这张(宁可少一张也不阻断招呼语)。
        console.warn('[即投] resume image to-blob failed, skip:', e.message);
        ErrorLogger.logError(e.message || String(e), e?.stack, 'loadResumeImages to-blob');
      }
    }

    _cachedResumeImages = results;
    return results;
  } catch (e) {
    console.warn('[即投] Failed to load resume images:', e);
    ErrorLogger.logError(e.message || String(e), e?.stack, 'loadResumeImages');
    _cachedResumeImages = [];
    return [];
  }
}

// 商业化：重写迁移到后端 /rewrite（藏 Key，复用 /greeting 计费闸口，堵白嫖漏）。
// apiKey 参数保留仅为兼容调用方签名（doRewriteGreeting 仍传入），后端不再用客户端 Key。
async function rewriteGreeting(apiKey, originalGreeting, instruction) {
  if (isLocalMode()) return originalGreeting || await getLocalFixedGreeting('');
  return backendRewriteGreeting(originalGreeting, instruction);
}

// ── 状态管理 ──
let state = {
  phase: 'idle',
  jobs: [],
  greetings: {},
  jobCustom: {},            // per-job 自定义（来自 ui:jobCustom）：{[jobId]:{customGreeting,images,...}}，发送前从 storage 灌入；buildSendQueueV6 按 jobId 取 customGreeting 覆盖组级招呼语
  greetingProgress: { done: 0, total: 0 },
  sendProgress: { sent: 0, total: 0 },
  autoReplyCount: 0,
  sendResults: [],
  sendDuration: 0,
  searchUrlParams: null,    // 原始搜索 URL 参数，发送阶段导航回正确搜索结果页
  chatTabId: null,
  sendQueue: [],        // [{jobId, positionName, companyName, jobLink, greeting}]
  sendIndex: 0,
  searchTabId: null,
  sendPhase: '',            // '' | 'stage1' | 'stage2'
  sendQueueV6: [],          // [{jobId, hrName, hrCompany, greeting, positionName, companyName}]
  sendQueueV6Index: 0,
  _v6WorkerTabIds: [],      // worker tab id 数组
  _v6WorkerWindowIds: [],   // worker tab 所在的独立后台窗口 id 数组
  _v6SearchReady: false,    // 搜索 tab CS 就绪标记
  _v6WorkerTabsReady: new Set(),  // 已就绪的 worker tab id 集合
  _v6RepairQueue: [],       // 发送阶段「对话已找到但内容漏发」的岗位，补发阶段单连接逐个补
  _v6MissedJobs: [],        // A1 漏发清单：已建联(hrName非空)但无任何投递结果的岗位（终态时由 finalizeTask 计算，供 review「一键补发」）
  originalMainWindowId: null,
  welfareFilter: '不限',        // 福利精筛：'不限'（不筛）| '五险一金'（只留含五险一金的岗，fail-open）
  welfareUnknownCount: 0,       // 因 welfareList 缺失而 fail-open 放行的岗位数（供 popup 提示）
  restDayFilter: '不限',        // 双休精筛：'不限'（不筛）| '双休'（标题命中双休置顶、明确非双休滤掉、未写明 fail-open 保留）
  restDayUnknownCount: 0,       // 因标题未写工作制而 fail-open 放行的岗位数（供 popup 提示）
  titleExcludeKeywords: '',     // 岗位标题排除词（逗号/换行分隔，命中则不采集）
  companyExcludeKeywords: '',   // 公司名称排除词（逗号/换行分隔，命中则不采集）
  testMode: false,              // 测试投递：每期望职位各 N 岗（testJobsPerPosition），供预览招呼语与试投
  sendMode: 'platform',         // platform=BOSS 平台自动招呼（快速）；custom=扩展定制招呼语+简历图
  sendResumeImage: false,       // 快速投递时是否同时发送简历图片
  workMode: 'search',           // search=搜索采集；browse=首页浏览投递
  browsing: false,
  browseTabId: null,
  browseStats: { sent: 0, skipped: 0, failed: 0, processed: 0, currentTag: '', sessionSent: 0, sessionLimit: 0, dailyTotal: 0 },
  browseResults: [],
};

// 中断恢复用：发送过的 jobId 集合（本批次进度）
const sentJobIds = new Set();
// 跨批次持久化：已成功投递 / 已沟通过的岗位（采集时跳过，避免重复试投）
const appliedJobIds = new Set();
let _appliedJobIdsLoaded = false;

async function ensureAppliedJobIdsLoaded() {
  if (_appliedJobIdsLoaded) return;
  try {
    var r = await chrome.storage.local.get(STORAGE_KEYS.SW.APPLIED_JOB_IDS);
    appliedJobIds.clear();
    (r[STORAGE_KEYS.SW.APPLIED_JOB_IDS] || []).forEach(function (id) { appliedJobIds.add(id); });
  } catch (e) { /* 静默 */ }
  _appliedJobIdsLoaded = true;
}

function persistAppliedJobIds() {
  chrome.storage.local.set({ [STORAGE_KEYS.SW.APPLIED_JOB_IDS]: Array.from(appliedJobIds) }).catch(function () {});
}

function markJobApplied(jobId) {
  if (!jobId) return;
  appliedJobIds.add(jobId);
  persistAppliedJobIds();
}

function isPlatformSendMode() {
  var mode = state.sendMode || (CONFIG.DEFAULT_SEND_MODE || 'platform');
  return mode === (CONFIG.SEND_MODE_PLATFORM || 'platform');
}

function getSendSpeedProfile() {
  var n = (state.sendQueueV6 && state.sendQueueV6.length) || 0;
  var platform = isPlatformSendMode();
  // 与 jitou-resource 一致：大批量搜索页批量投递不用 fastMode（fastMode 会导致 .job-boss-info 未渲染就提取 → 全员失败）
  var batchFast = !!(state.testMode || n <= 5);
  return {
    fast: !!(state.testMode || n <= 5 || platform),
    batchFastMode: batchFast,
    postExtractMs: platform ? 400 : (batchFast ? 600 : (CONFIG.POST_EXTRACT_DELAY_MS || 3000)),
    navSettleMs: platform ? 600 : (batchFast ? 700 : 2000),
    workerCount: batchFast ? 1 : Math.min(CONFIG.MAX_SEND_WORKERS || 3, n),
    repairSettleMs: batchFast ? 800 : 3000,
  };
}

function countStage1Linked() {
  return (state.sendQueueV6 || []).filter(function (i) { return i && i.hrName; }).length;
}

function countStage1SuccessDisplay() {
  var fromResults = (state.sendResults || []).filter(function (r) { return r && r.success; }).length;
  var fromHr = countStage1Linked();
  return Math.max(fromResults, fromHr);
}

function getSendDisplayTotal() {
  if (state._sendDisplayTotal != null) return state._sendDisplayTotal;
  return state.sendProgress.total || 0;
}

function getSendDisplaySent() {
  var fromResults = (state.sendResults || []).filter(function (r) { return r && r.success; }).length;
  var s = Math.max(fromResults, state.sendProgress.sent || 0, state._sendDisplaySentMax || 0);
  state._sendDisplaySentMax = s;
  return s;
}

function formatStage1BatchSub(msg) {
  var parts = [];
  if (_stage1TabProgress.total > 0) {
    parts.push('第 ' + _stage1TabProgress.index + '/' + _stage1TabProgress.total + ' 个搜索页');
  }
  if (msg && msg.done != null && msg.total != null) {
    parts.push('本页 ' + msg.done + '/' + msg.total);
  }
  var jobName = (msg && (msg.jobName || msg.sub)) || '';
  if (jobName) parts.push('当前：' + jobName);
  return parts.join(' · ');
}

function pushSendProgressDisplay(opts) {
  opts = opts || {};
  var total = getSendDisplayTotal();
  var sent = opts.sent != null ? opts.sent : getSendDisplaySent();
  if (sent > (state._sendDisplaySentMax || 0)) state._sendDisplaySentMax = sent;
  else sent = state._sendDisplaySentMax || sent;
  var label = isPlatformSendMode() ? '快速投递' : (state.sendPhase === 'stage2' ? '正在投递' : '正在建联');
  var status = opts.status || (label + ' (' + sent + '/' + total + ')');
  var batchSub = opts.batchSub != null ? opts.batchSub : (opts.sub || '');
  state.sendProgress = { sent: sent, total: total };
  var payload = {
    type: MSG.SEND_PROGRESS,
    sent: sent,
    total: total,
    status: status,
    sub: batchSub,
    batchSub: batchSub,
    jobName: opts.jobName || '',
    progress: { sent: sent, total: total, status: status },
  };
  chrome.runtime.sendMessage(payload).catch(function () {});
}

// 发送批次开始时间（计算总耗时用，不持久化）
let sendStartTime = 0;

// 硬中止：stopSend 触发后立即了结 runStage1 的 pending promise（不等 120s 超时）
// abortStage1 在 runStage1 期间被设为可触发的函数；stopSend 调用它让 stage1 立刻 settle。
let abortStage1 = null;
// 全局停止标记：startSendV6/runWorkerLoop 在各阶段边界检查，停了立即 bail
let sendAborted = false;
let collectAborted = false;

// ── #39 阶段1跳转恢复环（纯内存，SW 若死整个任务走既有 resume 路径） ──
// 现象：同 HR 新岗位点「立即沟通」→ BOSS 把搜索页整页跳 /web/geek/chat，确认弹窗弹在
// 消息页，搜索页 CS 死亡，EXTRACT_COMPLETE 永远不来 → stage1 卡到超时。
// 恢复：消息页 CS 点确认弹窗 → 该岗按建联成功落账 → goBack 回搜索页 → 重发剩余队列。
let _stage1SentQueue = null;       // runStage1 首次 doSend 发出的原始队列（恢复重发不重置，基准恒定）
let _stage1DoneJobIds = new Set(); // 本轮 stage1 已处理过的 jobId（itemDone 即 done，无论成败）——重发切片按它过滤，不依赖下标
let _stage1RecoveryActive = false; // 恢复序列进行中防重入
let _stage1RecoveryCount = 0;      // 单次 runStage1 内恢复次数（上限 STAGE1_RECOVERY_MAX）
let _stage1ResendQueue = null;     // runStage1 闭包暴露：重发剩余队列切片 + 重置总超时
let _stage1ForceSettle = null;     // runStage1 闭包暴露：恢复不能续时强制 settle，汇入现有终态路径
let _stage1PerJobWaiter = null;    // per-job 模式：#39 恢复完成后 resolve 单岗等待
const STAGE1_RECOVERY_MAX = 30;
// jitou 对齐：多城市采集/投递时为每条 collectUrl 自动开的搜索 tab（采集 tab 保留；投递临时 tab 在 cleanup 关闭）
let _collectOwnedTabIds = [];
let _sendAutoTabIds = [];
// 方案 B 双轨进度：主进度条 total 锁定；副标题展示 Stage1 批次（搜索页/本页）
let _stage1TabProgress = { index: 0, total: 0 };

function claimNextJob(state) {
  if (state.sendQueueV6Index >= state.sendQueueV6.length) return null;
  var job = state.sendQueueV6[state.sendQueueV6Index];
  state.sendQueueV6Index++;
  return job;
}

function buildSendQueueV6(state, jobIds) {
  // 用「期望岗位名」作为 greeting key，与 B 页 / clusterJobs 完全一致
  // （旧实现用 job.tags[0]=BOSS卡片标签当 key，与生成时的岗位名 key 错配 → greeting 取空）
  var picker = Array.isArray(state.selectedPositions) ? state.selectedPositions : [];
  var custom = Array.isArray(state.customPositions) ? state.customPositions : [];
  return jobIds
    .filter(function(id) { return !sentJobIds.has(id); })
    .map(function(id) {
      var job = state.jobs.find(function(j) { return (j.jobId || j.id) === id; });
      if (!job) { console.warn('[即投] buildSendQueueV6: 未找到 job id=' + id); }
      var category = job ? matchJobToPosition(job, picker, custom) : '其他';
      var greeting = state.greetings[category] || '';
      // per-job 自定义招呼语优先：该岗设了非空 customGreeting → 覆盖组级招呼语；为空/未设则保持组级 fallback（行为不变）
      var jcEntry = state.jobCustom && state.jobCustom[id];
      var jcGreeting = jcEntry && typeof jcEntry.customGreeting === 'string' ? jcEntry.customGreeting.trim() : '';
      if (jcGreeting) {
        greeting = jcGreeting;
        try { DiagLogger.info('sw.send', 'buildSendQueueV6：jobId=' + id + ' 用 per-job 自定义招呼语 len=' + jcGreeting.length); } catch (_) {}
      }
      return {
        jobId: id,
        hrName: '',
        hrCompany: '',
        greeting: greeting,
        positionName: job ? (job.name || job.positionName || '') : '',
        companyName: job ? (job.company || job.companyName || '') : '',
        jobLink: job ? (job.link || job.jobLink || 'https://www.zhipin.com/job_detail/' + (job.id || job.jobId) + '.html') : '',
        searchUrl: job ? resolveJobSearchUrl(job) : getJobsPageUrl(),
      };
    });
}

// ── per-job 自定义招呼语：从 ui:jobCustom 灌入 state.jobCustom ──
// buildSendQueueV6 是同步函数，无法自己 await storage；故在每次建队前（startSendV6 / 恢复路径）先异步灌好。
// popup 发送前会强制落盘 ui:jobCustom（绕过 300ms 防抖），保证这里读到的是最新自定义招呼语。
async function loadJobCustomIntoState() {
  try {
    const r = await chrome.storage.local.get(STORAGE_KEYS.UI.JOB_CUSTOM);
    state.jobCustom = r[STORAGE_KEYS.UI.JOB_CUSTOM] || {};
  } catch (_) {
    state.jobCustom = state.jobCustom || {};
  }
}

// ── 空/占位招呼语保险丝 ──
// greeting 为空或等于生成失败占位串的岗位发出去就是空消息（且 repair 阶段无从核对），
// 一律不入队，记一条失败 sendResults（结构对齐 stage1 提取失败的 skipped 记录）。
function isGreetingMissing(g) {
  return typeof isGreetingPlaceholder === 'function' ? isGreetingPlaceholder(g) : !(g || '').trim();
}
function dropMissingGreetingJobs() {
  var dropped = state.sendQueueV6.filter(function(item) { return isGreetingMissing(item.greeting); });
  if (!dropped.length) return;
  state.sendQueueV6 = state.sendQueueV6.filter(function(item) { return !isGreetingMissing(item.greeting); });
  for (var i = 0; i < dropped.length; i++) {
    var d = dropped[i];
    if (sentJobIds.has(d.jobId)) continue; // 已有结果的不重复记
    sentJobIds.add(d.jobId);
    state.sendProgress.sent++;
    state.sendResults.push({
      jobId: d.jobId,
      positionName: d.positionName,
      companyName: d.companyName,
      success: false, skipped: true,
      error: 'AI招呼语缺失，未投递（请刷新重新采集）',
      time: Date.now(),
    });
  }
  console.warn('[即投] 空招呼语保险丝：剔除', dropped.length, '个岗位不入队');
  pushState();
}

// ── 状态持久化：确保 SW 重启后 popup 能恢复 B 页 ──
let persistTimer = null;

// 诊断旁路：从当前内存态抽取脱敏快照摘要（与 diag-export.js buildSnapshot 同口径：
// 招呼语只留长度+前 20 字，绝不 dump apiKey/简历/手机号）。SW 卸载后导出 fallback 读它。
function buildSnapshotSummary() {
  try {
    var snap = {
      ts: Date.now(),
      phase: state.phase,
      sendPhase: state.sendPhase || '',
      jobs: (state.jobs || []).length,
      sendQueueV6: (state.sendQueueV6 || []).length,
      sendQueueV6Index: state.sendQueueV6Index || 0,
      sendProgress: state.sendProgress || {},
      greetingProgress: state.greetingProgress || {},
      selectedPositions: state.selectedPositions || [],
      customPositions: state.customPositions || [],
      hrActiveFilter: state.hrActiveFilter || '不限',
      workerTabs: (state._v6WorkerTabIds || []).length,
      missedJobs: (state._v6MissedJobs || []).length,
      sendResultsCount: (state.sendResults || []).length,
    };
    var g = state.greetings || {};
    snap.greetings = {};
    for (var k in g) {
      if (Object.prototype.hasOwnProperty.call(g, k)) {
        var gv = String(g[k] == null ? '' : g[k]);
        snap.greetings[k] = (gv.length > 20 ? gv.slice(0, 20) + '…' : gv) + ' (len=' + gv.length + ')';
      }
    }
    return snap;
  } catch (e) { return { ts: Date.now(), _snapshotError: String(e && e.message || e) }; }
}

function persistState() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const toSave = {
      [STORAGE_KEYS.SW.PHASE]: state.phase,
      [STORAGE_KEYS.SW.JOBS]: state.jobs,
      [STORAGE_KEYS.SW.GREETINGS]: state.greetings,
      [STORAGE_KEYS.SW.SEND_PROGRESS]: state.sendProgress,
      [STORAGE_KEYS.SW.SENT_JOB_IDS]: Array.from(sentJobIds),
      [STORAGE_KEYS.SW.SEND_RESULTS]: state.sendResults,
      [STORAGE_KEYS.SW.SEND_DURATION]: state.sendDuration,
      [STORAGE_KEYS.SW.SEARCH_URL]: state.searchUrlParams,
      [STORAGE_KEYS.SW.SEND_QUEUE_V6]: state.sendQueueV6,
      [STORAGE_KEYS.SW.SEND_QUEUE_INDEX]: state.sendQueueV6Index,
      [STORAGE_KEYS.SW.SEND_PHASE]: state.sendPhase,
      [STORAGE_KEYS.SW.SELECTED_POSITIONS]: state.selectedPositions || [],
      [STORAGE_KEYS.SW.CUSTOM_POSITIONS]: state.customPositions || [],
      [STORAGE_KEYS.SW.MISSED_JOBS]: state._v6MissedJobs || [],
      sw_sendMode: state.sendMode || CONFIG.DEFAULT_SEND_MODE || 'platform',
      sw_collectUrlPlan: state.collectUrlPlan || [],
      // 诊断旁路：脱敏内存快照摘要，SW 卸载后 diag-export 回退读它（保留 jobs/queue/greetings 摘要）
      [STORAGE_KEYS.SW.LAST_SNAPSHOT]: buildSnapshotSummary(),
    };
    chrome.storage.local.set(toSave).catch(() => {});
  }, 500);
}

// ── 全局错误捕获 ──
self.addEventListener('error', (event) => {
  ErrorLogger.logError(event.message, event.filename + ':' + event.lineno, 'SW global error');
  try { DiagLogger.error('sw.global', event.message + ' at ' + event.filename + ':' + event.lineno); } catch (_) {}
  console.error('[即投] SW global error:', event.message, 'at', event.filename + ':' + event.lineno);
});
self.addEventListener('unhandledrejection', (event) => {
  ErrorLogger.logError(event.reason?.message || String(event.reason), event.reason?.stack, 'SW unhandled rejection');
  try { DiagLogger.error('sw.global', 'unhandledrejection: ' + (event.reason?.message || String(event.reason))); } catch (_) {}
  console.error('[即投] SW unhandled rejection:', event.reason?.message || String(event.reason));
});

// SW 启动时还原持久化状态，并确保 API Key 已预置
ensureApiKey();

// ── 全自动开发重载（零抢屏）──
// content.js RELOAD_EXTENSION 在 reload 前置 __pending_tab_reload flag。扩展重载后 SW top-level 重新求值，
// 在此读 flag：若有则原地 chrome.tabs.reload 所有 BOSS tab。页面 reload 触发 Chrome 按 manifest 注入【新版】CS，
// 既不开新 tab、也不切焦点 → 绕开「runtime.reload 后已有 tab 不重注入 CS、必须开新 tab 才注入」的死局。
chrome.storage.local.get('__pending_tab_reload', (r) => {
  if (!r || !r.__pending_tab_reload) return;
  chrome.storage.local.remove('__pending_tab_reload');
  chrome.tabs.query({ url: '*://*.zhipin.com/*' }, (tabs) => {
    (tabs || []).forEach((t) => {
      try { chrome.tabs.reload(t.id, { bypassCache: true }); } catch (e) {}
    });
  });
});

// 点击工具栏图标打开侧边栏（不自动关闭），而不是弹窗
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// SW 冷启动竞态防护：消息唤醒冷 SW 时，下面这个异步 restore 回调可能晚于
// 消息处理执行，用 storage 旧值覆盖刚建好的内存状态（实测致投递 0/0/0）。
// 所有会改写发送/采集状态的入口必须先 await bootRestored。
let _bootRestoreResolve;
const bootRestored = new Promise((resolve) => { _bootRestoreResolve = resolve; });

chrome.storage.local.get([
  STORAGE_KEYS.SW.PHASE,
  STORAGE_KEYS.SW.JOBS,
  STORAGE_KEYS.SW.GREETINGS,
  STORAGE_KEYS.SW.SEND_PROGRESS,
  STORAGE_KEYS.SW.SENT_JOB_IDS,
  STORAGE_KEYS.SW.APPLIED_JOB_IDS,
  STORAGE_KEYS.SW.SEND_RESULTS,
  STORAGE_KEYS.SW.SEND_DURATION,
  STORAGE_KEYS.SW.SEARCH_URL,
  STORAGE_KEYS.SW.SEND_QUEUE_V6,
  STORAGE_KEYS.SW.SEND_QUEUE_INDEX,
  STORAGE_KEYS.SW.SEND_PHASE,
  STORAGE_KEYS.SW.SELECTED_POSITIONS,
  STORAGE_KEYS.SW.CUSTOM_POSITIONS,
  STORAGE_KEYS.SW.MISSED_JOBS,
  'sw_sendMode',
  'sw_collectUrlPlan',
], (result) => {
  // searchUrlParams 无论 phase 是什么都要恢复，否则发送时 getJobsPageUrl() 返回裸 URL
  if (result[STORAGE_KEYS.SW.SEARCH_URL]) state.searchUrlParams = result[STORAGE_KEYS.SW.SEARCH_URL];

  if (result[STORAGE_KEYS.SW.PHASE] && result[STORAGE_KEYS.SW.PHASE] !== 'idle') {
    // 采集中 SW 被系统回收后无法恢复半途中断的 tab 导航循环，避免永久卡在 collecting
    if (result[STORAGE_KEYS.SW.PHASE] === 'collecting') {
      state.phase = 'idle';
    } else {
    state.phase = result[STORAGE_KEYS.SW.PHASE];
    if (result[STORAGE_KEYS.SW.JOBS]) state.jobs = result[STORAGE_KEYS.SW.JOBS];
    if (result[STORAGE_KEYS.SW.GREETINGS]) state.greetings = result[STORAGE_KEYS.SW.GREETINGS];
    // 期望岗位词恢复：丢了会让 buildSendQueueV6 类目匹配落空 → greeting 取空串
    if (result[STORAGE_KEYS.SW.SELECTED_POSITIONS]) state.selectedPositions = result[STORAGE_KEYS.SW.SELECTED_POSITIONS];
    if (result[STORAGE_KEYS.SW.CUSTOM_POSITIONS]) state.customPositions = result[STORAGE_KEYS.SW.CUSTOM_POSITIONS];
    if (result[STORAGE_KEYS.SW.SEND_PROGRESS]) state.sendProgress = result[STORAGE_KEYS.SW.SEND_PROGRESS];
    if (result[STORAGE_KEYS.SW.SEND_RESULTS]) state.sendResults = result[STORAGE_KEYS.SW.SEND_RESULTS];
    if (result[STORAGE_KEYS.SW.SEND_DURATION]) state.sendDuration = result[STORAGE_KEYS.SW.SEND_DURATION];
    // 从数组恢复 sentJobIds Set
    if (result[STORAGE_KEYS.SW.SENT_JOB_IDS] && Array.isArray(result[STORAGE_KEYS.SW.SENT_JOB_IDS])) {
      result[STORAGE_KEYS.SW.SENT_JOB_IDS].forEach(id => sentJobIds.add(id));
    }
    if (result[STORAGE_KEYS.SW.APPLIED_JOB_IDS] && Array.isArray(result[STORAGE_KEYS.SW.APPLIED_JOB_IDS])) {
      result[STORAGE_KEYS.SW.APPLIED_JOB_IDS].forEach(function (id) { appliedJobIds.add(id); });
      _appliedJobIdsLoaded = true;
    }

    // v6 字段恢复
    if (Array.isArray(result[STORAGE_KEYS.SW.MISSED_JOBS])) state._v6MissedJobs = result[STORAGE_KEYS.SW.MISSED_JOBS];
    if (result[STORAGE_KEYS.SW.SEND_QUEUE_V6]) state.sendQueueV6 = result[STORAGE_KEYS.SW.SEND_QUEUE_V6];
    if (result[STORAGE_KEYS.SW.SEND_QUEUE_INDEX]) state.sendQueueV6Index = result[STORAGE_KEYS.SW.SEND_QUEUE_INDEX];
    if (result[STORAGE_KEYS.SW.SEND_PHASE]) state.sendPhase = result[STORAGE_KEYS.SW.SEND_PHASE];
    if (result.sw_sendMode) state.sendMode = result.sw_sendMode;
    if (Array.isArray(result.sw_collectUrlPlan) && result.sw_collectUrlPlan.length) {
      state.collectUrlPlan = result.sw_collectUrlPlan;
    }

    // v6 发送状态恢复：如果 phase 是 sending 且 sendPhase 有值
    if (state.phase === 'sending' && state.sendPhase) {
      resumeSendV6();
    } else if (state.phase === 'sending') {
      // v5 遗留数据：清空旧状态重置为 idle
      state.phase = 'idle';
      state.sendQueue = [];
      state.sendIndex = 0;
    }
    // 恢复后推送给已打开的 popup
    pushState();
    }
  }
  _bootRestoreResolve();
});

// 诊断包：phase 状态机转换单点打点（pushState 是所有 phase 变化的汇聚点）
let _diagLastPhase = 'idle';
function pushState() {
  try {
    if (state.phase !== _diagLastPhase) {
      DiagLogger.info('sw.phase', 'phase: ' + _diagLastPhase + ' → ' + state.phase + (state.sendPhase ? ' (sendPhase=' + state.sendPhase + ')' : ''));
      _diagLastPhase = state.phase;
    }
  } catch (_) {}
  console.log('[P1D-SW] pushState', { phase: state.phase, jobsLen: state.jobs && state.jobs.length });
  chrome.runtime.sendMessage({ type: 'STATE_UPDATE', state }).catch(() => {});
  persistState();
}

// ── 消息路由 ──
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // CS 调试桥：把 content script 关键步骤同步到 SW console
  if (msg && msg.type === 'CS_DBG') {
    var tabId = sender && sender.tab ? sender.tab.id : '?';
    console.log('[即投][CS_DBG][tab=' + tabId + '] ' + msg.stage, msg.info || {});
    return;
  }
  // 客户端全局错误桥：popup/sidepanel/content 捕获后转 SW 入库 extension:errorLog
  if (msg && msg.type === 'EXT_ERROR') {
    var locInfo = msg.file ? (msg.file + ':' + (msg.line || '?') + ':' + (msg.col || '?')) : '';
    ErrorLogger.logError(String(msg.msg || ''), msg.stack || locInfo, (msg.src || 'client') + ' global error');
    try { DiagLogger.error((msg.src || 'client') + '.global', String(msg.msg || '') + (locInfo ? ' @' + locInfo : '')); } catch (_) {}
    return;
  }
  // 测试桥：全自动开发重载。content script 无 chrome.runtime.reload 特权（CS 的 runtime 仅子集），
  // 故由 CS 发此消息、SW 代为执行。置 __pending_tab_reload flag 后 reload；扩展重启后 SW top-level
  // 读 flag 原地 chrome.tabs.reload 所有 BOSS tab 重注入新 CS（零抢屏）。产品流程永不发此消息。
  if (msg && msg.type === 'RELOAD_EXT_SELF') {
    chrome.storage.local.set({ __pending_tab_reload: true }, () => {
      chrome.runtime.reload();
    });
    return;
  }
  switch (msg.type) {
    case 'GET_STATE':
      sendResponse({ success: true, state });
      break;

    case 'START_COLLECT':
      startCollect(msg.params)
        .then(function () {
          try { DiagLogger.info('sw.collect', '采集任务正常结束'); } catch (_) {}
        })
        .catch(function (e) {
          ErrorLogger.logError(e.message, e.stack, 'START_COLLECT failed');
          chrome.runtime.sendMessage({ type: 'ERROR', message: e.message || '采集失败' }).catch(function () {});
        });
      sendResponse({ success: true, started: true });
      break;

    case 'STOP_COLLECT':
      stopCollect().then(() => sendResponse({ success: true })).catch((e) => sendResponse({ success: false, error: e.message }));
      return true;

    case MSG.START_BROWSE:
      startBrowse(msg.params || {})
        .then(function () { sendResponse({ success: true, started: true }); })
        .catch(function (e) {
          ErrorLogger.logError(e.message, e.stack, 'START_BROWSE failed');
          chrome.runtime.sendMessage({ type: 'ERROR', message: e.message || '浏览投递启动失败' }).catch(function () {});
          sendResponse({ success: false, error: e.message });
        });
      return true;

    case MSG.STOP_BROWSE:
      stopBrowse().then(function () { sendResponse({ success: true }); }).catch(function (e) { sendResponse({ success: false, error: e.message }); });
      return true;

    case MSG.BROWSE_PROGRESS:
      if (msg.sent != null) {
        state.browseStats.sent = msg.sent;
        state.browseStats.sessionSent = msg.sent;
      }
      if (msg.skipped != null) state.browseStats.skipped = msg.skipped;
      if (msg.failed != null) state.browseStats.failed = msg.failed;
      if (msg.processed != null) state.browseStats.processed = msg.processed;
      if (msg.currentTag != null) state.browseStats.currentTag = msg.currentTag;
      if (msg.sessionLimit != null) state.browseStats.sessionLimit = msg.sessionLimit;
      pushState();
      chrome.runtime.sendMessage(msg).catch(function () {});
      sendResponse({ success: true });
      break;

    case MSG.BROWSE_ITEM_RESULT:
      if (msg.job) {
        var _br = {
          jobId: msg.job.id,
          positionName: msg.job.name,
          companyName: msg.job.company,
          success: !!msg.success,
          skipped: !!msg.skipped,
          skipReason: msg.skipReason || '',
          error: msg.error || '',
          time: Date.now(),
        };
        state.browseResults.push(_br);
        if (msg.success && msg.job.id) {
          markJobApplied(msg.job.id);
          incrementDailySendCount(msg.job.id);
          incrementBrowseDailyCount(msg.job.id).then(function (count) {
            state.browseStats.dailyTotal = count;
            pushState();
          }).catch(function () {});
        }
      }
      pushState();
      chrome.runtime.sendMessage(msg).catch(function () {});
      sendResponse({ success: true });
      break;

    case MSG.BROWSE_COMPLETE:
      state.browsing = false;
      state.phase = 'browse_done';
      state.browseTabId = null;
      if (msg.sent != null) {
        state.browseStats.sent = msg.sent;
        state.browseStats.sessionSent = msg.sent;
      }
      if (msg.skipped != null) state.browseStats.skipped = msg.skipped;
      if (msg.failed != null) state.browseStats.failed = msg.failed;
      try { DiagLogger.info('sw.browse', '浏览投递完成 sent=' + state.browseStats.sent + ' skipped=' + state.browseStats.skipped); } catch (_) {}
      pushState();
      chrome.runtime.sendMessage(msg).catch(function () {});
      sendResponse({ success: true });
      break;

    case 'JOBS_COLLECTED':
      if (state._multiCityCollect) { sendResponse({ success: true }); break; }
      // 单城市路径：BOSS 模糊匹配脏数据由 service-worker 再过滤一遍，clusters 重算以反映过滤后集合
      {
        const _expectedJobs = filterJobsByExpected(msg.jobs || [], state.selectedPositions, state.customPositions);
        const _welfareJobs = filterJobsByWelfare(_expectedJobs, state.welfareFilter);
        const _restDayJobs = filterJobsByRestDay(_welfareJobs, state.restDayFilter);
        const _titleFiltered = filterJobsByExcludeTitle(_restDayJobs, state.titleExcludeKeywords);
        const _filteredJobs = filterJobsByExcludeCompany(_titleFiltered, state.companyExcludeKeywords);
        state.jobs = _filteredJobs;
        const _allPos394 = allExpectedPositions(state);
        state.clusters = _allPos394.length
          ? clusterJobs(_filteredJobs, state.selectedPositions, state.customPositions)
          : (msg.clusters || {});
      }
      state.jdSamples = msg.jdSamples;
      state.phase = 'ready';
      console.log('[P1D-SW] JOBS_COLLECTED handler', { jobsLen: msg && msg.jobs && msg.jobs.length });
      pushState();
      if (!state.jobs || state.jobs.length === 0) {
        chrome.runtime.sendMessage({ type: 'ERROR', message: '未找到匹配岗位，请调整筛选条件' }).catch(() => {});
        sendResponse({ success: true }); break;
      }
      // 异步并发生成招呼语（两步法：先 VL 提取简历文字，再纯文字并发 5 路生成），与popup渲染完全并行
      if (!greetingPromise) {
        greetingPromise = generateAllGreetingsConcurrent();
      }
      sendResponse({ success: true });
      break;

    case 'COLLECT_PROGRESS':
      chrome.runtime.sendMessage(msg).catch(() => {});
      sendResponse({ success: true });
      break;

    case 'START_SEND':
      // sender.tab 在 side panel 场景下为 undefined，fallback 到 lastFocused 窗口
      if (sender && sender.tab && sender.tab.windowId) {
        state.originalMainWindowId = sender.tab.windowId;
      } else {
        chrome.windows.getLastFocused().then(win => {
          if (win && win.id) state.originalMainWindowId = win.id;
        }).catch(() => {});
      }
      state.hrActiveFilter = msg.hrActiveFilter || '不限';
      if (msg.sendMode === CONFIG.SEND_MODE_CUSTOM || msg.sendMode === CONFIG.SEND_MODE_PLATFORM) {
        state.sendMode = msg.sendMode;
      } else if (!state.sendMode) {
        state.sendMode = CONFIG.DEFAULT_SEND_MODE || 'platform';
      }
      // 快速投递时是否同时发送简历图片
      state.sendResumeImage = !!msg.sendResumeImage;
      startSendV6(msg.jobIds).then(() => {
        sendResponse({ success: true });
      }).catch((e) => {
        ErrorLogger.logError(e.message, e.stack, 'START_SEND failed');
        chrome.runtime.sendMessage({ type: 'ERROR', message: e.message }).catch(() => {});
        sendResponse({ success: false, error: e.message, errorCode: e.errorCode || null });
      });
      return true;

    case 'STOP_SEND':
      stopSend().then(() => sendResponse({ success: true })).catch((e) => sendResponse({ success: false, error: e.message }));
      return true;

    case MSG.GET_DAILY_SEND_COUNT:
      // 投递数量闸门：popup 投递前读当天已成功投递岗位数（本地自然日，跨日自动归零）
      getDailySendCount().then((count) => sendResponse({ success: true, count: count, limit: CONFIG.DAILY_SEND_LIMIT }))
        .catch(() => sendResponse({ success: true, count: 0, limit: CONFIG.DAILY_SEND_LIMIT }));
      return true;

    case MSG.GET_BROWSE_DAILY_COUNT:
      getBrowseDailyCount().then(function (count) {
        sendResponse({ success: true, count: count, date: localDateKey() });
      }).catch(function () {
        sendResponse({ success: true, count: 0, date: localDateKey() });
      });
      return true;

    case MSG.REPAIR_MISSED:
      // A1：review 页「一键补发」漏发岗位（已建联但未发 AI 招呼语+图）
      startRepairMissed().then(() => sendResponse({ success: true })).catch((e) => {
        ErrorLogger.logError(e.message, e.stack, 'REPAIR_MISSED failed');
        sendResponse({ success: false, error: e.message });
      });
      return true;

    case 'SEND_PROGRESS':
      state.sendProgress = msg.progress;
      chrome.runtime.sendMessage(msg).catch(() => {});
      sendResponse({ success: true });
      break;

    case 'SEND_ITEM_RESULT':
      // v5 发送流程中，结果已由 recordV5Success/recordV5Failure 处理，防止重复计数
      if (state.phase === 'sending') {
        if (msg.payload?.jobId && sentJobIds.has(msg.payload.jobId)) {
          sendResponse({ success: true });
          break;
        }
      }
      // 累积发送结果，用于 Review 页
      state.sendResults.push(msg.payload);
      // 更新 sentJobIds（中断恢复用）
      if (msg.payload.success || msg.payload.error === 'partial') {
        sentJobIds.add(msg.payload.jobId);
      }
      // 按累积结果更新进度
      state.sendProgress.sent = state.sendResults.length;
      // 增量持久化（500ms 防抖，中断恢复不会丢失进度）
      persistState();
      // 转发给 popup（Review 页实时更新）
      chrome.runtime.sendMessage(msg).catch(() => {});
      sendResponse({ success: true });
      break;

    case 'SEND_COMPLETE':
      // SW 驱动的逐条导航发送：忽略 content script 的单条 SEND_COMPLETE
      if (state.phase === 'sending') { sendResponse({ success: true }); break; }
      // CAPTCHA 中断发送，不切换到 review
      if (state.phase === 'captcha_paused') break;
      // 全部发送失败，回退到 ready（不展示 review）
      if (state.sendResults.length > 0 && state.sendResults.every(r => !r.success)) {
        state.phase = 'ready';
        state.sendProgress = { sent: 0, total: 0 };
        pushState();
        break;
      }
      state.phase = 'review';
      state.sendDuration = Date.now() - sendStartTime;
      state.sendProgress = { sent: msg.total, total: msg.total };
      pushState();
      // 转发给 popup：扩展 results[] + duration
      chrome.runtime.sendMessage({
        type: MSG.SEND_COMPLETE,
        results: state.sendResults,
        duration: state.sendDuration,
      }).catch(() => {});
      sendResponse({ success: true });
      break;

    case 'CHAT_DETECTED':
      state.autoReplyCount++;
      pushState();
      sendResponse({ success: true });
      break;

    case 'CAPTCHA_DETECTED':
      try { DiagLogger.warn('sw.captcha', 'CAPTCHA detected, send paused (tab=' + (sender && sender.tab ? sender.tab.id : '?') + ')'); } catch (_) {}
      state.phase = 'captcha_paused';
      state.captchaError = true;
      pushState();
      // 通知所有 content script 停止发送
      chrome.tabs.query({ url: '*://*.zhipin.com/*' }).then((tabs) => {
        tabs.forEach((t) => chrome.tabs.sendMessage(t.id, { type: 'DO_STOP' }).catch(() => {}));
      });
      sendResponse({ success: true });
      break;

    case MSG.CS_READY:
      var role = msg.role;
      if (role === 'search') {
        state._v6SearchReady = true;
        state.searchTabId = sender.tab.id;
      } else if (role === 'worker') {
        state._v6WorkerTabsReady.add(sender.tab.id);
      } else if (state.phase === 'sending') {
        // 兼容旧 v5 逻辑
        if (sender.tab.id === state.chatTabId) {
          state._v5ChatReady = true;
        }
      }
      sendResponse({ success: true });
      break;

    case 'AUTO_REPLY_SENT':
      chrome.runtime.sendMessage(msg).catch(() => {});
      sendResponse({ success: true });
      break;

    case 'REGENERATE_GREETING':
      regenerateGreeting(msg.category, msg.jdSamples)
        .then((greeting) => sendResponse({ success: true, greeting }))
        .catch((e) => {
          ErrorLogger.logError(e.message, e.stack, 'REGENERATE_GREETING failed');
          sendResponse({ success: false, error: e.message });
        });
      return true;

    case 'INVALIDATE_RESUME_CACHE':
      invalidateResumeImageCache();
      sendResponse({ success: true });
      break;

    case 'REWRITE_GREETING':
      doRewriteGreeting(msg.greeting, msg.instruction)
        .then((newGreeting) => sendResponse({ success: true, greeting: newGreeting }))
        .catch((e) => {
          ErrorLogger.logError(e.message, e.stack, 'REWRITE_GREETING failed');
          sendResponse({ success: false, error: e.message });
        });
      return true;

    case 'UPDATE_GREETING':
      state.greetings[msg.category] = msg.greeting;
      pushState();
      sendResponse({ success: true });
      break;

    case 'GET_API_KEY':
      chrome.storage.local.get('apiKey', (r) => sendResponse({ success: true, apiKey: r.apiKey || '' }));
      return true;

    case 'SAVE_API_KEY':
      chrome.storage.local.set({ apiKey: msg.apiKey }, () => sendResponse({ success: true }));
      return true;

    case 'CLEAR_SENT_JOB_IDS':
      sentJobIds.clear();
      appliedJobIds.clear();
      _appliedJobIdsLoaded = true;
      persistAppliedJobIds();
      persistState();
      sendResponse({ success: true });
      break;

    case '__TEST_OPEN_POPUP__': {
      if (chrome.runtime.getManifest().update_url) {
        sendResponse({ success: false, error: 'test API disabled in production' });
        return false;
      }
      chrome.tabs.create({
        url: chrome.runtime.getURL('src/popup/popup.html'),
        active: false
      }, (tab) => {
        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ success: true, tabId: tab.id });
        }
      });
      return true;
    }
    case '__TEST_OPEN_TAB__': {
      if (chrome.runtime.getManifest().update_url) {
        sendResponse({ success: false, error: 'test API disabled in production' });
        return false;
      }
      // 只允许开 zhipin.com 测试页（不抢屏：active:false）
      const _u = String(msg.url || '');
      if (!/^https?:\/\/([^/]+\.)?zhipin\.com\//.test(_u)) {
        sendResponse({ success: false, error: 'url not allowed' });
        return false;
      }
      chrome.tabs.create({ url: _u, active: false }, (tab) => {
        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ success: true, tabId: tab.id });
        }
      });
      return true;
    }
    case '__TEST_CLOSE_POPUP__': {
      if (chrome.runtime.getManifest().update_url) {
        sendResponse({ success: false, error: 'test API disabled in production' });
        return false;
      }
      chrome.tabs.remove(msg.tabId, () => {
        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ success: true });
        }
      });
      return true;
    }

    default:
      sendResponse({ success: false, error: 'Unknown message type' });
  }
});

// ── 辅助：构建 BOSS 直聘搜索 URL（实现见 constants.js buildJobUrl）──

// ── 获取带搜索参数的岗位页面 URL（无参数时 fallback 到裸 URL）──
function getJobsPageUrl() {
  if (state.searchUrlParams) {
    return buildJobUrl(state.searchUrlParams);
  }
  return 'https://www.zhipin.com/web/geek/jobs';
}

// 投递 stage1 需在采集时的 BOSS 搜索页上找卡片（多期望职位/多城市各有独立 URL）
function resolveJobSearchUrl(job) {
  if (!job) return getJobsPageUrl();
  if (job.collectUrl) return job.collectUrl;
  if (job.collectUrlParams && typeof buildJobUrl === 'function') return buildJobUrl(job.collectUrlParams);
  var plan = state.collectUrlPlan || [];
  if (plan.length) {
    var pos = matchJobToPosition(job, state.selectedPositions || [], state.customPositions || []);
    for (var i = 0; i < plan.length; i++) {
      if (plan[i].position === pos && plan[i].url) return plan[i].url;
    }
    if (plan[0].url) return plan[0].url;
  }
  return getJobsPageUrl();
}

function normalizeSearchUrl(u) {
  try {
    var p = new URL(String(u || ''));
    var keys = ['city', 'query', 'jobType', 'salary', 'industry', 'multiBusinessDistrict'];
    var parts = [];
    for (var ki = 0; ki < keys.length; ki++) {
      var v = p.searchParams.get(keys[ki]);
      if (v == null || v === '') continue;
      if (keys[ki] === 'query') {
        try { v = decodeURIComponent(v.replace(/\+/g, ' ')).trim().toLowerCase(); } catch (_) {
          v = String(v).replace(/\+/g, ' ').trim().toLowerCase();
        }
      }
      parts.push(keys[ki] + '=' + v);
    }
    return p.pathname + '?' + parts.join('&');
  } catch (e) {
    return String(u || '');
  }
}

function getStage1QueueSlice() {
  return state.sendQueueV6.filter(function (item) {
    if (item.hrName) return false;
    // platform 模式对齐 jitou：在当前搜索页上发全量 pending 队列，不按 searchUrl 切片
    if (isPlatformSendMode() || !state._stage1SearchUrlFilter) return true;
    var u = item.searchUrl || getJobsPageUrl();
    return normalizeSearchUrl(u) === normalizeSearchUrl(state._stage1SearchUrlFilter);
  });
}

function collectPendingSearchUrls() {
  var urls = [];
  var seen = {};
  function add(u) {
    var norm = normalizeSearchUrl(u);
    if (!norm || seen[norm]) return;
    seen[norm] = true;
    urls.push(u);
  }
  (state.sendQueueV6 || []).forEach(function (item) {
    if (!item || item.hrName) return;
    add(item.searchUrl || getJobsPageUrl());
  });
  (state.collectUrlPlan || []).forEach(function (p) {
    if (p && p.url) add(p.url);
  });
  return urls;
}

function markStage1PageFailures(searchUrl, reason) {
  var norm = normalizeSearchUrl(searchUrl);
  state.sendQueueV6.forEach(function (item) {
    if (item.hrName) return;
    if (normalizeSearchUrl(item.searchUrl) !== norm) return;
    if (!item.extractError) item.extractError = reason || '未能在搜索页找到该岗位卡片';
  });
}

function enrichSendQueueSearchUrls() {
  if (!state.sendQueueV6 || !state.sendQueueV6.length) return;
  state.sendQueueV6.forEach(function (item) {
    if (item.searchUrl) return;
    var job = state.jobs.find(function (j) { return (j.jobId || j.id) === item.jobId; });
    item.searchUrl = job ? resolveJobSearchUrl(job) : getJobsPageUrl();
  });
}

function normalizeJobDetailUrl(item) {
  if (item.jobLink && item.jobLink.indexOf('job_detail') >= 0) return item.jobLink;
  var id = item.jobId;
  if (!id) return item.jobLink || getJobsPageUrl();
  return 'https://www.zhipin.com/job_detail/' + id + '.html';
}

function isPortClosedError(err) {
  var m = (err && err.message) || String(err || '');
  return m.indexOf('back/forward cache') >= 0 || m.indexOf('message channel') >= 0
    || m.indexOf('port') >= 0 || m.indexOf('Receiving end does not exist') >= 0;
}

async function sendTabMessageWithBFCacheRetry(tabId, message, maxRetries) {
  maxRetries = maxRetries || 3;
  var lastErr = null;
  for (var i = 0; i < maxRetries; i++) {
    try {
      await chrome.tabs.update(tabId, { active: true });
      await sleep(300);
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (e) {
      lastErr = e;
      if (isPortClosedError(e) && i < maxRetries - 1) {
        try {
          await chrome.tabs.reload(tabId, { bypassCache: true });
          await waitForTabLoad(tabId, 15000);
        } catch (reloadErr) {}
        await waitForContentScript(tabId, 3000, 5);
        await sleep(500);
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error('sendMessage failed');
}

function getStage1PendingItems() {
  return state.sendQueueV6.filter(function (item) {
    return item && !item.hrName;
  });
}

function clearStage1TransientErrors() {
  state.sendQueueV6.forEach(function (item) {
    if (item && !item.hrName && item.extractError) delete item.extractError;
  });
}

function recordStage1SkipItem(item, activeDesc) {
  var _idx = state.sendQueueV6.findIndex(function (q) { return q.jobId === item.jobId; });
  var _qit = _idx >= 0 ? state.sendQueueV6[_idx] : item;
  sentJobIds.add(item.jobId);
  state.sendProgress.sent++;
  state.sendResults.push({
    jobId: item.jobId,
    positionName: _qit.positionName || '',
    companyName: _qit.companyName || '',
    success: false,
    skipped: true,
    error: '未投递：HR活跃不符' + (activeDesc ? '（' + activeDesc + '）' : ''),
    time: Date.now(),
  });
  if (_idx >= 0) state.sendQueueV6.splice(_idx, 1);
  item.extractError = 'HR活跃不符已跳过';
  pushState();
}

function applySingleExtractResult(item, resp) {
  if (!resp || item.hrName) return;
  var r = resp.result || resp;
  if (r.success && r.hrName) {
    item.hrName = r.hrName;
    item.hrCompany = r.hrCompany || '';
    item.alreadyChatted = !!r.alreadyChatted;
    pushState();
    return;
  }
  if (r.skipped) {
    recordStage1SkipItem(item, r.activeDesc);
    return;
  }
  if (r.stopped) return;
  if (!item.hrName && !item.extractError) {
    item.extractError = r.error || resp.error || '详情页提取失败';
    pushState();
  }
}

async function ensureStage1Tab() {
  if (state.searchTabId) {
    try {
      await chrome.tabs.get(state.searchTabId);
      return state.searchTabId;
    } catch (e) {}
  }
  var bossTabs = await chrome.tabs.query({ url: '*://*.zhipin.com/*' });
  if (bossTabs.length) {
    state.searchTabId = bossTabs[0].id;
    return state.searchTabId;
  }
  var tab = await chrome.tabs.create({ url: getJobsPageUrl(), active: true });
  state.searchTabId = tab.id;
  return tab.id;
}

async function runStage1SingleJob(item, idx, total) {
  var tabId = state.searchTabId;
  var jobLink = normalizeJobDetailUrl(item);
  state._stage1ReturnUrl = jobLink;
  state._stage1InFlight = null;

  console.log('[即投] v6 stage1: 详情页提取', idx + '/' + total, item.positionName, jobLink);
  await chrome.tabs.update(tabId, { url: jobLink, active: true });
  try {
    await waitForTabLoad(tabId, 20000);
  } catch (loadErr) {
    console.warn('[即投] v6 stage1: 详情页加载超时，继续尝试', loadErr.message);
  }
  await waitForContentScript(tabId, 5000, 5);
  await sleep(getSendSpeedProfile().navSettleMs || 400);

  var progressHandler = function (msg, sender) {
    if (!sender.tab || sender.tab.id !== tabId) return;
    if (msg.type !== MSG.EXTRACT_PROGRESS) return;
    if (msg.stage === 'beforeClick' && msg.jobId === item.jobId) {
      state._stage1InFlight = {
        index: msg.index,
        jobId: msg.jobId,
        jobName: msg.jobName,
        hrName: msg.hrName,
        hrCompany: msg.hrCompany,
        ts: Date.now(),
      };
    } else if (msg.stage === 'itemDone' && msg.jobId === item.jobId) {
      _stage1DoneJobIds.add(msg.jobId);
      if (msg.success) {
        item.hrName = msg.hrName || item.hrName;
        item.hrCompany = msg.hrCompany || item.hrCompany;
        item.alreadyChatted = !!msg.alreadyChatted;
      }
      if (state._stage1InFlight && state._stage1InFlight.jobId === msg.jobId) {
        state._stage1InFlight = null;
      }
    }
  };
  chrome.runtime.onMessage.addListener(progressHandler);

  try {
    await new Promise(function (resolve) {
      var settled = false;
      var finish = function () {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        _stage1PerJobWaiter = null;
        resolve();
      };
      _stage1PerJobWaiter = { resolve: finish, item: item };
      var timer = setTimeout(function () {
        if (!item.hrName && !item.extractError) item.extractError = '详情页提取超时';
        finish();
      }, isPlatformSendMode() ? 18000 : 45000);

      sendTabMessageWithBFCacheRetry(tabId, {
        type: MSG.DO_SINGLE_EXTRACT,
        item: {
          jobId: item.jobId,
          jobLink: item.jobLink,
          positionName: item.positionName,
          companyName: item.companyName,
        },
        hrActiveFilter: state.hrActiveFilter || '不限',
        fastMode: false,
        platformGreeting: isPlatformSendMode(),
        sendResumeImage: !!state.sendResumeImage,
      }, 3).then(function (resp) {
        applySingleExtractResult(item, resp);
        if (isPlatformSendMode() && item.hrName && !sentJobIds.has(item.jobId)) {
          recordV6Success(item);
        }
        finish();
      }).catch(function (err) {
        if (isPortClosedError(err) && (state._stage1InFlight || _stage1RecoveryActive)) {
          return;
        }
        if (!item.hrName && !item.extractError) {
          item.extractError = err.message || '详情页提取失败';
        }
        finish();
      });
    });
  } finally {
    chrome.runtime.onMessage.removeListener(progressHandler);
  }

  var extracted = countStage1Linked();
  pushSendProgressDisplay({
    batchSub: '详情页模式 ' + idx + '/' + total + (item.positionName ? ' · 当前：' + item.positionName : ''),
  });
}

async function runStage1PerJobDetail() {
  state._stage1PerJobMode = true;
  state._stage1InFlight = null;
  _stage1DoneJobIds.clear();
  _stage1SentQueue = null;
  _stage1RecoveryCount = 0;
  _stage1RecoveryActive = false;
  _stage1PerJobWaiter = null;

  await ensureStage1Tab();
  var initialTotal = getStage1PendingItems().length;
  console.log('[即投] v6 stage1: 详情页逐岗模式，待提取', initialTotal, '岗');
  var done = 0;

  while (true) {
    if (sendAborted) {
      console.log('[即投] v6 stage1: 已停止，中止');
      break;
    }
    var pending = getStage1PendingItems();
    if (!pending.length) break;
    done++;
    await runStage1SingleJob(pending[0], done, initialTotal);
  }

  state._stage1PerJobMode = false;
  state._stage1InFlight = null;
  _stage1PerJobWaiter = null;
  console.log('[即投] v6 stage1: 详情页逐岗完成，累计已提取:',
    state.sendQueueV6.filter(function (item) { return item.hrName; }).length);
}

async function ensureSearchTabsForPlan() {
  var urls = collectPendingSearchUrls();
  if (!urls.length) urls = [getJobsPageUrl()];

  var existing = await chrome.tabs.query({ url: '*://*.zhipin.com/web/geek/jobs*' });
  var byNorm = {};
  for (var i = 0; i < existing.length; i++) {
    var t = existing[i];
    if (t && t.url) byNorm[normalizeSearchUrl(t.url)] = t;
  }

  var tabs = [];
  for (var u = 0; u < urls.length; u++) {
    if (sendAborted) break;
    var url = urls[u];
    var norm = normalizeSearchUrl(url);
    var tab = byNorm[norm];
    if (!tab) {
      pushSendProgressDisplay({
        batchSub: '正在打开搜索页 (' + (u + 1) + '/' + urls.length + ')',
      });
      try {
        var created = await chrome.tabs.create({ url: url, active: false });
        tab = created;
        _sendAutoTabIds.push(created.id);
        byNorm[norm] = created;
        try {
          await waitForTabLoad(created.id, 25000);
        } catch (loadErr) {
          console.warn('[即投] ensureSearchTabsForPlan: 加载超时', url, loadErr.message);
        }
        await waitForContentScript(created.id, 8000, 8);
        await sleep(1500);
      } catch (createErr) {
        console.error('[即投] ensureSearchTabsForPlan: 创建 tab 失败', url, createErr.message);
        continue;
      }
    }
    tabs.push({ id: tab.id, url: url, owned: _sendAutoTabIds.indexOf(tab.id) >= 0 });
  }
  return tabs;
}

async function resolveSearchTabsForStage1() {
  var tabs = [];
  var seen = {};
  function addTab(t) {
    if (!t || !t.id || seen[t.id]) return;
    if (!t.url || t.url.indexOf('/web/geek/jobs') < 0) return;
    seen[t.id] = true;
    tabs.push(t);
  }
  for (var ci = 0; ci < _collectOwnedTabIds.length; ci++) {
    try { addTab(await chrome.tabs.get(_collectOwnedTabIds[ci])); } catch (_) {}
  }
  var openJobs = await chrome.tabs.query({ url: '*://*.zhipin.com/web/geek/jobs*' });
  for (var oi = 0; oi < openJobs.length; oi++) addTab(openJobs[oi]);
  var planned = await ensureSearchTabsForPlan();
  for (var pi = 0; pi < planned.length; pi++) {
    try { addTab(await chrome.tabs.get(planned[pi].id)); } catch (_) {}
  }
  return tabs;
}

async function runStage1DetailFallback() {
  var pending = getStage1PendingItems();
  if (!pending.length || sendAborted) return;
  console.log('[即投] v6 stage1: 详情页兜底，剩余', pending.length, '岗');
  pushSendProgressDisplay({
    batchSub: '搜索页未命中，详情页兜底 ' + pending.length + ' 岗',
  });
  state._stage1PerJobMode = true;
  state._stage1InFlight = null;
  await ensureStage1Tab();
  var initialTotal = pending.length;
  var done = 0;
  while (true) {
    if (sendAborted) break;
    pending = getStage1PendingItems();
    if (!pending.length) break;
    var item = pending[0];
    if (item.extractError) delete item.extractError;
    done++;
    await runStage1SingleJob(item, done, initialTotal);
    if (isPlatformSendMode() && item.hrName && !sentJobIds.has(item.jobId)) {
      recordV6Success(item);
    }
  }
  state._stage1PerJobMode = false;
  state._stage1InFlight = null;
  _stage1PerJobWaiter = null;
}

async function runStage1OnSearchTabs() {
  enrichSendQueueSearchUrls();
  clearStage1TransientErrors();
  _sendAutoTabIds = [];
  state._stage1PerJobMode = false;

  pushSendProgressDisplay({
    batchSub: '正在准备搜索页... · 优先使用采集时打开的 BOSS 搜索 tab',
  });

  var searchTabs = await resolveSearchTabsForStage1();
  console.log('[即投] v6 stage1: 搜索 tab 数', searchTabs.length, '待处理岗位', getStage1PendingItems().length);

  for (var ti = 0; ti < searchTabs.length; ti++) {
    if (sendAborted || !getStage1PendingItems().length) break;
    var tab = searchTabs[ti];
    state.searchTabId = tab.id;
    state._stage1SearchUrlFilter = null;
    _stage1TabProgress = { index: ti + 1, total: searchTabs.length };
    console.log('[即投] v6 stage1: 激活搜索 tab', (ti + 1) + '/' + searchTabs.length, 'tabId=' + tab.id);
    pushSendProgressDisplay({
      batchSub: '第 ' + (ti + 1) + '/' + searchTabs.length + ' 个搜索页 · 剩余 ' + getStage1PendingItems().length + ' 个岗位',
    });
    await chrome.tabs.update(tab.id, { active: true });
    await sleep(2000);
    try {
      await runStage1();
    } catch (e) {
      console.error('[即投] v6 stage1: tab', tab.id, '失败', e.message);
    }
    clearStage1TransientErrors();
  }
  state._stage1SearchUrlFilter = null;

  var remain = getStage1PendingItems().length;
  if (remain) {
    console.log('[即投] v6 stage1: 搜索 tab 批量后剩余', remain, '岗，进入详情页兜底');
    await runStage1DetailFallback();
  }
}

async function runStage1AcrossSearchUrls() {
  if (isPlatformSendMode()) {
    await runStage1OnSearchTabs();
    return;
  }
  await runStage1PerJobDetail();
}

// ── 辅助：等待标签页加载完成（超时兜底） ──
function urlCollectKey(u) {
  try {
    var p = new URL(u);
    return p.pathname + '|' + (p.searchParams.get('city') || '') + '|' + (p.searchParams.get('query') || '');
  } catch (e) {
    return String(u || '');
  }
}

function navigateTabForCollect(tabId, url, timeoutMs) {
  return new Promise(function(resolve, reject) {
    var done = false;
    var targetKey = urlCollectKey(url);
    var timeout = setTimeout(function() {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('页面加载超时'));
    }, timeoutMs);

    function finish(tab) {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(tab);
    }

    function listener(updatedTabId, changeInfo) {
      if (done || updatedTabId !== tabId || changeInfo.status !== 'complete') return;
      chrome.tabs.get(tabId).then(function(tab) {
        if (done || !tab) return;
        if (urlCollectKey(tab.url || '') === targetKey) finish(tab);
      }).catch(function() {});
    }

    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then(function(tab) {
      if (done) return;
      if (tab && urlCollectKey(tab.url || '') === targetKey && tab.status === 'complete') {
        finish(tab);
        return;
      }
      chrome.tabs.update(tabId, { url: url, active: true }).catch(function(err) {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        reject(err);
      });
    }).catch(function(err) {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      reject(err);
    });
  });
}

function waitForTabLoad(tabId, timeoutMs = 10000) {
  return new Promise(function(resolve, reject) {
    chrome.tabs.get(tabId).then(function(tab) {
      if (tab && tab.status === 'complete') {
        resolve();
        return;
      }
      var timeout = setTimeout(function() {
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error('页面加载超时'));
      }, timeoutMs);

      function listener(updatedTabId, changeInfo) {
        if (updatedTabId === tabId && changeInfo.status === 'complete') {
          clearTimeout(timeout);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      }

      chrome.tabs.onUpdated.addListener(listener);
    }).catch(reject);
  });
}

async function waitForContentScriptOnUrl(tabId, url, timeoutMs = 4000, maxRetries = 8) {
  var targetKey = urlCollectKey(url);
  for (var attempt = 0; attempt < maxRetries; attempt++) {
    try {
      var response = await sendMessageToTab(tabId, { type: MSG.PING }, timeoutMs);
      if (response && response.type === MSG.PONG) {
        var gotKey = urlCollectKey(response.url || '');
        if (!gotKey || gotKey === targetKey) {
          console.log('[即投] Content script ready attempt', attempt + 1, gotKey);
          return true;
        }
        console.warn('[即投] PING URL mismatch want=' + targetKey + ' got=' + gotKey);
      }
    } catch (err) {
      console.warn('[即投] PING attempt ' + (attempt + 1) + '/' + maxRetries + ' failed:', err.message);
      if (attempt === Math.floor(maxRetries / 2)) {
        try {
          await chrome.tabs.reload(tabId);
          await sleep(1500);
        } catch (e) {}
      }
    }
    if (attempt < maxRetries - 1) await sleep(400);
  }
  throw new Error('内容脚本未就绪，请刷新 BOSS 搜索页后重试');
}

// ── PING/PONG 握手：确认 content script 已注入就绪 ──
async function waitForContentScript(tabId, timeoutMs = 3000, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('PING timeout')), timeoutMs);
        chrome.tabs.sendMessage(tabId, { type: 'PING' }).then((resp) => {
          clearTimeout(timer);
          resolve(resp);
        }).catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
      });

      if (response && response.type === 'PONG') {
        console.log('[即投] Content script ready after PING attempt', attempt + 1);
        return true;
      }
    } catch (err) {
      console.warn(`[即投] PING attempt ${attempt + 1}/${maxRetries} failed:`, err.message);
      ErrorLogger.logError(err.message, err.stack, `PING attempt ${attempt + 1}/${maxRetries}`);
      if (attempt < maxRetries - 1) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }
  throw new Error('内容脚本未就绪（已重试 ' + maxRetries + ' 次），请刷新 BOSS 岗位页后重试');
}

// ── 通用辅助 ──
function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

async function sendMessageToTab(tabId, message, timeoutMs = 90000) {
  return Promise.race([
    chrome.tabs.sendMessage(tabId, message),
    new Promise(function(_, reject) {
      setTimeout(function() {
        reject(new Error('内容脚本响应超时（' + Math.round(timeoutMs / 1000) + '秒），请确认 BOSS 搜索页已打开且已登录'));
      }, timeoutMs);
    }),
  ]);
}

// 间隔随机化：[min,max] 闭区间均匀随机整数 ms（破等距节奏指纹）
function randBetween(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

// ═══════════════════════════════════════════════════════════════════
const _collectAlarmName = 'jitou:collect_keepalive';

function startCollectKeepalive() {
  if (!chrome.alarms) return;
  try {
    chrome.alarms.create(_collectAlarmName, { periodInMinutes: (CONFIG && CONFIG.KEEPALIVE_PERIOD_MIN) || 0.5 });
  } catch (e) {}
}

function stopCollectKeepalive() {
  if (!chrome.alarms) return;
  chrome.alarms.clear(_collectAlarmName).catch(function () {});
}
// 目的：防 BFCache 失活、防 service worker 30s 空闲休眠、防 tab discard
// 不切前台（不抢用户屏幕）— 仅靠消息往返让 chromium 认为 tab/SW 都活跃
// ═══════════════════════════════════════════════════════════════════
const _workerAlarmPrefix = 'zitou:worker_keepalive:';
const _activeWorkerKeepalives = new Set(); // tabId 集合

function _workerAlarmName(tabId) { return _workerAlarmPrefix + tabId; }

function startWorkerKeepalive(tabId) {
  if (_activeWorkerKeepalives.has(tabId)) return;
  _activeWorkerKeepalives.add(tabId);
  // periodInMinutes 最低 0.5 = 30s（chrome 强制下限）
  var period = (typeof CONFIG !== 'undefined' && CONFIG.KEEPALIVE_PERIOD_MIN) || 0.5;
  chrome.alarms.create(_workerAlarmName(tabId), {
    delayInMinutes: period,
    periodInMinutes: period,
  });
  console.log('[即投] keepalive: started for tab', tabId, 'period=', period, 'min');
}

function stopWorkerKeepalive(tabId) {
  if (!_activeWorkerKeepalives.has(tabId)) return;
  _activeWorkerKeepalives.delete(tabId);
  chrome.alarms.clear(_workerAlarmName(tabId)).catch(function(){});
  console.log('[即投] keepalive: stopped for tab', tabId);
}

// onAlarm 单点 dispatcher — 收到 ping alarm 就给对应 tab 发 PING
// CS 侧已有 PONG handler（content.js:401-403），无需新增
chrome.alarms.onAlarm.addListener(function(alarm) {
  if (!alarm || !alarm.name) return;
  if (alarm.name.indexOf(_workerAlarmPrefix) !== 0) return;
  var tabId = parseInt(alarm.name.slice(_workerAlarmPrefix.length), 10);
  if (!tabId || !_activeWorkerKeepalives.has(tabId)) {
    chrome.alarms.clear(alarm.name).catch(function(){});
    return;
  }
  // 异步发 PING，不 await（alarm 回调不需要保活）
  chrome.tabs.sendMessage(tabId, { type: MSG.PING }).catch(function(err) {
    // 失败可能是 tab 已关、CS 未注入、BFCache — 都不致命，下次 alarm 继续试
    console.warn('[即投] keepalive PING failed tab=' + tabId + ' err=' + err.message);
  });
});

// 清理：cleanupV6 时一并清掉所有残留 keepalive alarm
function stopAllWorkerKeepalives() {
  var tabs = Array.from(_activeWorkerKeepalives);
  for (var i = 0; i < tabs.length; i++) stopWorkerKeepalive(tabs[i]);
}

// ── 采集控制 ──
async function startCollect(params) {
  await bootRestored;         // 冷启动竞态防护，同 startSendV6
  if (_collectInFlight) {
    collectAborted = true;
    stopCollectKeepalive();
    await releaseCollectTab().catch(function () {});
    _collectInFlight = null;
  }
  collectAborted = false;
  _collectInFlight = _startCollectInner(params);
  try {
    return await _collectInFlight;
  } finally {
    _collectInFlight = null;
  }
}

async function _startCollectInner(params) {
  try { DiagLogger.userEvent('sw.collect', '任务启动：开始采集 cities=' + ((params && params.selectedCities && params.selectedCities.length) || 0) + ' positions=' + (allExpectedPositions({ selectedPositions: params && params.selectedPositions, customPositions: params && params.customPositions }).length)); } catch (_) {}
  console.log('[P1D-SW] startCollect enter');
  await ensureAppliedJobIdsLoaded();
  collectAborted = false;
  state.phase = 'collecting';
  state.jobs = [];
  state.greetings = {};
  // 新批次采集：清本批 sendResults，但保留 appliedJobIds（跨批次已投递去重）
  sentJobIds.clear();
  state.sendResults = [];
  state._v6MissedJobs = []; // 上一批漏发清单随新批作废（重新投递会重建联+重发）
  state.sendDuration = 0;
  state.sendProgress = { sent: 0, total: 0 };
  if(params&&params.selectedPositions) state.selectedPositions = params.selectedPositions;
  state.customPositions = (params && Array.isArray(params.customPositions)) ? params.customPositions : (state.customPositions||[]);
  if(params && typeof params.welfareFilter === 'string') state.welfareFilter = params.welfareFilter;
  if(params && typeof params.restDayFilter === 'string') state.restDayFilter = params.restDayFilter;
  if(params && typeof params.titleExcludeKeywords === 'string') state.titleExcludeKeywords = params.titleExcludeKeywords;
  if(params && typeof params.companyExcludeKeywords === 'string') state.companyExcludeKeywords = params.companyExcludeKeywords;
  if(params && params.urlParams) state.searchUrlParams = params.urlParams;
  else state.searchUrlParams = null;
  state.testMode = !!(params && params.testMode);
  pushState();
  // 即时预热招呼语：不等岗位采集，A 点击"开始收集"瞬即并发生成 N 条（N=期望岗位数）
  // 5-6s 采集期间复用为招呼语生成时间窗，B 页打开即有结果
  if (!greetingPromise && allExpectedPositions(state).length) {
    greetingPromise = generateAllGreetingsConcurrent();
  }
  try {
    const plan = (params && params.testMode && typeof buildTestCollectUrlPlan === 'function')
      ? buildTestCollectUrlPlan(params)
      : buildCollectUrlPlan(params);
    if (!plan.length) throw new Error('请至少选择目标城市和期望职位');

    state.collectUrlPlan = plan.map(function (p) {
      return { cityCode: p.cityCode, position: p.position, url: p.url };
    });
    state.searchUrlParams = plan[0].urlParams;
    pushState();

    chrome.runtime.sendMessage({
      type: MSG.COLLECT_URL_PLAN,
      plan: state.collectUrlPlan,
    }).catch(function () {});

    state._multiCityCollect = true;
    _collectOwnedTabIds = [];
    let allJobs = [];
    let rawCount = 0;
    let earlyGreetingStarted = false;
    let loginHits = 0;
    let lastDiag = null;
    const quotas = (params && params.testMode && typeof calcTestCollectQuotas === 'function')
      ? calcTestCollectQuotas(params)
      : calcCollectQuotas(params);
    state.collectQuotas = quotas;
    const positionCounts = {};
    const globalSeen = new Set();

    const excludeText = (params && params.titleExcludeKeywords) || state.titleExcludeKeywords || '';
    const companyExcludeText = (params && params.companyExcludeKeywords) || state.companyExcludeKeywords || '';
    const excludeJobIds = Array.from(appliedJobIds);

    try {
    startCollectKeepalive();
    for (let i = 0; i < plan.length; i++) {
      if (collectAborted) break;
      const item = plan[i];
      const posKey = item.position || '';
      const posTotal = positionCounts[posKey] || 0;
      if (posKey && posTotal >= quotas.perPosition) {
        chrome.runtime.sendMessage({
          type: 'COLLECT_CITY_PROGRESS',
          progress: {
            completed: i + 1,
            total: plan.length,
            jobsCollected: allJobs.length,
            skipped: true,
            skipReason: '职位「' + posKey + '」已达采集上限 ' + quotas.perPosition,
            quotas: quotas,
          },
        }).catch(function () {});
        continue;
      }
      const maxCollect = posKey
        ? Math.min(quotas.perCityPerPosition, quotas.perPosition - posTotal)
        : quotas.perCityPerPosition;

      chrome.runtime.sendMessage({
        type: 'COLLECT_CITY_PROGRESS',
        progress: {
          completed: i,
          total: plan.length,
          jobsCollected: allJobs.length,
          currentUrl: item.url,
          currentIndex: i,
          position: item.position,
          cityCode: item.cityCode,
          maxCollect: maxCollect,
          quotas: quotas,
        },
      }).catch(function () {});

      try {
        const result = await collectOnTab(item.cityCode, Object.assign({}, params, {
          urlParams: item.urlParams,
          maxCollect: maxCollect,
          excludeJobIds: excludeJobIds,
          collectUrl: item.url,
          openDedicatedTab: true,
        }));
        const jobs = (result && result.jobs) || [];
        if (result && result.collectDiag) {
          lastDiag = result.collectDiag;
          if (result.collectDiag.loginRequired) loginHits++;
        }
        if (Array.isArray(jobs)) {
          rawCount += jobs.length;
          let addedForPos = 0;
          for (let ji = 0; ji < jobs.length; ji++) {
            const j = jobs[ji];
            if (excludeText && typeof jobMatchesExcludeTitle === 'function' && jobMatchesExcludeTitle(j, excludeText)) continue;
            if (companyExcludeText && typeof jobMatchesExcludeCompany === 'function' && jobMatchesExcludeCompany(j, companyExcludeText)) continue;
            const jid = j && (j.id || j.jobId);
            if (!jid || globalSeen.has(jid)) continue;
            if (appliedJobIds.has(jid)) continue;
            globalSeen.add(jid);
            j.collectUrl = item.url;
            j.collectUrlParams = Object.assign({}, item.urlParams);
            allJobs.push(j);
            addedForPos++;
          }
          if (posKey) positionCounts[posKey] = posTotal + addedForPos;
        }
      } catch (e) {
        console.warn('[即投] collectOnTab 失败:', item.url, e.message);
        try { DiagLogger.warn('sw.collect', '采集失败 url=' + item.url + ' err=' + e.message); } catch (_) {}
        lastDiag = Object.assign({}, lastDiag || {}, { error: e.message, url: item.url });
      }

      if (i === 0 && allJobs.length > 0 && !earlyGreetingStarted) {
        earlyGreetingStarted = true;
        if ((!state.selectedPositions || !state.selectedPositions.length) || (!state.customPositions || !state.customPositions.length)) {
          try {
            const { [STORAGE_KEYS.UI.FILTER_STATE]: fs } = await chrome.storage.local.get(STORAGE_KEYS.UI.FILTER_STATE);
            if (fs) {
              if ((!state.selectedPositions || !state.selectedPositions.length) && Array.isArray(fs.selectedPositions) && fs.selectedPositions.length) state.selectedPositions = fs.selectedPositions;
              if ((!state.customPositions || !state.customPositions.length) && Array.isArray(fs.customPositions) && fs.customPositions.length) state.customPositions = fs.customPositions;
            }
          } catch (e) { /* 静默 */ }
        }
        const partialClusters = clusterJobs(filterJobsByExpected(allJobs, state.selectedPositions, state.customPositions), state.selectedPositions, state.customPositions);
        state.jdSamples = sampleJDs(partialClusters, 5);
        greetingPromise = generateAllGreetingsConcurrent();
      }

      chrome.runtime.sendMessage({
        type: 'COLLECT_CITY_PROGRESS',
        progress: {
          completed: i + 1,
          total: plan.length,
          jobsCollected: allJobs.length,
          rawCollected: rawCount,
          currentUrl: item.url,
          currentIndex: i,
          position: item.position,
          cityCode: item.cityCode,
          domCardCount: lastDiag && lastDiag.domCardCount,
          apiJobCount: lastDiag && lastDiag.apiJobCount,
          loginRequired: lastDiag && lastDiag.loginRequired,
          cardSelector: lastDiag && lastDiag.cardSelector,
          maxCollect: maxCollect,
          quotas: quotas,
          error: lastDiag && lastDiag.error,
        },
      }).catch(function () {});
    }

    } finally {
      stopCollectKeepalive();
      await releaseCollectTab();
    }

    delete state._multiCityCollect;

    if (collectAborted) {
      allJobs = dedupeJobsById(allJobs);
      if (allJobs.length > quotas.dailyCap) allJobs = allJobs.slice(0, quotas.dailyCap);
      const stoppedBeforeFilter = allJobs.length;
      allJobs = filterJobsByExpected(allJobs, state.selectedPositions, state.customPositions);
      allJobs = filterJobsByWelfare(allJobs, state.welfareFilter);
      allJobs = filterJobsByRestDay(allJobs, state.restDayFilter);
      allJobs = filterJobsByExcludeTitle(allJobs, state.titleExcludeKeywords);
      allJobs = filterJobsByExcludeCompany(allJobs, state.companyExcludeKeywords);
      if (typeof filterJobsByApplied === 'function') allJobs = filterJobsByApplied(allJobs, appliedJobIds);
      var _prioPrefsAb = (params && params.priorityPrefs) || { enabled: true };
      if (typeof annotateJobsWithPriority === 'function') annotateJobsWithPriority(allJobs, _prioPrefsAb, state.selectedPositions, state.customPositions);
      if (typeof sortJobsByPriority === 'function') allJobs = sortJobsByPriority(allJobs, _prioPrefsAb, state.selectedPositions, state.customPositions);
      state.collectRawCount = rawCount;
      state.collectBeforeFilter = stoppedBeforeFilter;
      state.collectLastDiag = lastDiag;
      if (allJobs.length > 0) {
        state.jobs = allJobs;
        state.clusters = clusterJobs(allJobs, state.selectedPositions, state.customPositions);
        state.jdSamples = sampleJDs(state.clusters, 5);
        state.phase = 'ready';
        pushState();
        if (!greetingPromise) greetingPromise = generateAllGreetingsConcurrent();
        chrome.runtime.sendMessage({ type: MSG.COLLECT_STOPPED, partial: true, count: allJobs.length }).catch(function () {});
      } else {
        state.jobs = [];
        state.phase = 'idle';
        pushState();
        chrome.runtime.sendMessage({ type: MSG.COLLECT_STOPPED, partial: false }).catch(function () {});
      }
      return;
    }

    if ((!state.selectedPositions || !state.selectedPositions.length) || (!state.customPositions || !state.customPositions.length)) {
      try {
        const { [STORAGE_KEYS.UI.FILTER_STATE]: fs } = await chrome.storage.local.get(STORAGE_KEYS.UI.FILTER_STATE);
        if (fs) {
          if ((!state.selectedPositions || !state.selectedPositions.length) && Array.isArray(fs.selectedPositions) && fs.selectedPositions.length) state.selectedPositions = fs.selectedPositions;
          if ((!state.customPositions || !state.customPositions.length) && Array.isArray(fs.customPositions) && fs.customPositions.length) state.customPositions = fs.customPositions;
        }
      } catch (e) { /* 静默 */ }
    }

    allJobs = dedupeJobsById(allJobs);
    if (allJobs.length > quotas.dailyCap) allJobs = allJobs.slice(0, quotas.dailyCap);
    const beforeFilter = allJobs.length;
    allJobs = filterJobsByExpected(allJobs, state.selectedPositions, state.customPositions);
    allJobs = filterJobsByWelfare(allJobs, state.welfareFilter);
    allJobs = filterJobsByRestDay(allJobs, state.restDayFilter);
    allJobs = filterJobsByExcludeTitle(allJobs, state.titleExcludeKeywords);
    allJobs = filterJobsByExcludeCompany(allJobs, state.companyExcludeKeywords);
    if (typeof filterJobsByApplied === 'function') allJobs = filterJobsByApplied(allJobs, appliedJobIds);
    var _prioPrefs = (params && params.priorityPrefs) || { enabled: true };
    if (typeof annotateJobsWithPriority === 'function') {
      annotateJobsWithPriority(allJobs, _prioPrefs, state.selectedPositions, state.customPositions);
    }
    if (typeof sortJobsByPriority === 'function') {
      allJobs = sortJobsByPriority(allJobs, _prioPrefs, state.selectedPositions, state.customPositions);
    }
    state.jobs = allJobs;
    state.clusters = clusterJobs(allJobs, state.selectedPositions, state.customPositions);
    state.jdSamples = sampleJDs(state.clusters, 5);
    state.phase = 'ready';
    state.collectRawCount = rawCount;
    state.collectBeforeFilter = beforeFilter;
    state.collectLastDiag = lastDiag;
    pushState();

    if (allJobs.length === 0) {
      var errMsg;
      if (loginHits > 0) {
        errMsg = 'BOSS 未登录或登录已失效（' + loginHits + '/' + plan.length + ' 次检测到登录页）。请先在浏览器打开 BOSS 直聘并完成登录，再点「开始收集」';
      } else if (rawCount === 0) {
        errMsg = 'BOSS 搜索页未采集到岗位（共 ' + plan.length + ' 条链接）。请点开下方链接核对：若页面有岗位但扩展为 0，请反馈；若页面也无岗位，请放宽筛选条件';
      } else if (appliedJobIds.size > 0) {
        errMsg = '当前搜索结果中的岗位均已投递过（已跳过 ' + appliedJobIds.size + ' 个历史记录）。请放宽筛选、换搜索条件，或点 A 页「重置」清空已投递记录后再试';
      } else {
        errMsg = 'BOSS 采集到 ' + rawCount + ' 条，过滤后 0 条（期望职位匹配过严，可放宽自定义词）';
      }
      chrome.runtime.sendMessage({
        type: 'ERROR',
        message: errMsg,
        collectRawCount: rawCount,
        collectBeforeFilter: beforeFilter,
        collectPlan: state.collectUrlPlan,
        collectDiag: lastDiag,
        loginRequired: loginHits > 0,
      }).catch(function () {});
      return;
    }

    if (earlyGreetingStarted) {
      try { await greetingPromise; } catch (_) {}
      const apiKey = isLocalMode() ? 'local' : await getApiKey();
      if ((isLocalMode() || apiKey) && state.jdSamples) {
        let resumeImages = isLocalMode() ? [] : await loadResumeImages();
        for (const [cat, samples] of Object.entries(state.jdSamples)) {
          if (!state.greetings[cat]) {
            try {
              state.greetings[cat] = await generateGreeting(apiKey, resumeImages, samples, cat);
              pushState();
            } catch (e) {
              state.greetings[cat] = '生成失败，请刷新';
              ErrorLogger.logError(e.message || String(e), e?.stack, 'Late greeting gen: ' + cat);
              pushState();
            }
          }
        }
      }
      greetingPromise = null;
      pushState();
    } else {
      greetingPromise = generateAllGreetingsConcurrent();
    }

  } catch (e) {
    delete state._multiCityCollect;
    state.phase = 'idle';
    pushState();
    throw e;
  }
}

// Original single-city tab collection logic
async function singleCityCollect(params) {
  const hasUrlParams = params?.urlParams && Object.keys(params.urlParams).length > 0;

  if (hasUrlParams) {
    const url = buildJobUrl(params.urlParams);

    let tabId;
    try {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (activeTab && activeTab.url && activeTab.url.includes('zhipin.com') && activeTab.id) {
        tabId = activeTab.id;
        await chrome.tabs.update(tabId, { url });
      } else {
        const tab = await chrome.tabs.create({ url, active: false });
        tabId = tab.id;
      }
    } catch (_) {
      const tab = await chrome.tabs.create({ url, active: false });
      tabId = tab.id;
    }

    await waitForTabLoad(tabId);
    await waitForContentScript(tabId);
    await chrome.tabs.sendMessage(tabId, { type: 'DO_COLLECT', params });
  } else {
    const tabs = await chrome.tabs.query({ url: '*://*.zhipin.com/web/geek/jobs*' });
    if (!tabs.length) throw new Error('请先打开 BOSS 直聘岗位搜索页');
    await chrome.tabs.sendMessage(tabs[0].id, { type: 'DO_COLLECT', params });
  }
}

// Multi-city / multi-position: 复用已登录 BOSS tab 顺序采集（避免后台新 tab 未登录/被限流）
let _collectTabId = null;
let _collectTabOwned = false;

async function acquireCollectTab(firstUrl) {
  if (_collectTabId) {
    try {
      await chrome.tabs.get(_collectTabId);
      return _collectTabId;
    } catch (_) {
      _collectTabId = null;
    }
  }
  const zhipinTabs = await chrome.tabs.query({ url: '*://*.zhipin.com/*' });
  const jobsTab = zhipinTabs.find(function (t) { return t.url && t.url.indexOf('/web/geek/jobs') >= 0; });
  if (jobsTab) {
    _collectTabId = jobsTab.id;
    _collectTabOwned = false;
    return _collectTabId;
  }
  if (zhipinTabs.length) {
    _collectTabId = zhipinTabs[0].id;
    _collectTabOwned = false;
    return _collectTabId;
  }
  const tab = await chrome.tabs.create({ url: firstUrl || 'https://www.zhipin.com/web/geek/jobs', active: true });
  _collectTabId = tab.id;
  _collectTabOwned = true;
  return _collectTabId;
}

async function releaseCollectTab() {
  if (_collectTabId && _collectTabOwned && _collectOwnedTabIds.indexOf(_collectTabId) < 0) {
    try { await chrome.tabs.remove(_collectTabId); } catch (_) {}
  }
  _collectTabId = null;
  _collectTabOwned = false;
}

let _collectInFlight = null;

async function collectViaScripting(tabId, maxCollect) {
  var limit = maxCollect > 0 ? maxCollect : 1;
  var results = await chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: function(maxN) {
      function selAll() {
        var sels = ['li.job-card-box', '.job-card-wrapper', '.job-list-box li', '[class*="job-card"]'];
        for (var i = 0; i < sels.length; i++) {
          var nodes = document.querySelectorAll(sels[i]);
          if (nodes && nodes.length) return nodes;
        }
        return document.querySelectorAll('.__zt_no_match__');
      }
      var jobs = [];
      var seen = {};
      var apiRaw = '';
      try { apiRaw = document.documentElement.getAttribute('data-jitou-joblist-map') || ''; } catch (e) {}
      if (apiRaw) {
        try {
          var apiMap = JSON.parse(apiRaw);
          for (var k in apiMap) {
            if (jobs.length >= maxN) break;
            var j = apiMap[k];
            if (j && j.id && !seen[j.id]) { seen[j.id] = true; jobs.push(j); }
          }
        } catch (e2) {}
      }
      var cards = selAll();
      if (jobs.length < maxN) {
        for (var c = 0; c < cards.length && jobs.length < maxN; c++) {
          var card = cards[c];
          var nameEl = card.querySelector('.job-name') || card.querySelector('[class*="job-name"]');
          var companyEl = card.querySelector('.company-name') || card.querySelector('[class*="company-name"]');
          var linkEl = card.querySelector('a[href*="job_detail"]') || card.querySelector('a');
          var href = linkEl ? (linkEl.href || '') : '';
          var id = (href.match(/job_detail\/([^.]+)\.html/) || [])[1] || href;
          if (!id || seen[id]) continue;
          seen[id] = true;
          jobs.push({
            id: id,
            name: nameEl ? nameEl.textContent.trim() : '',
            company: companyEl ? companyEl.textContent.trim() : '',
            tags: [],
            link: href,
          });
        }
      }
      var bodyText = (document.body && document.body.innerText) || '';
      return {
        jobs: jobs,
        collectDiag: {
          loginRequired: jobs.length === 0 && /登录\/注册|登录状态已失效|请登录|扫码登录/.test(bodyText),
          domCardCount: cards.length,
          apiJobCount: apiRaw ? (function() { try { return Object.keys(JSON.parse(apiRaw)).length; } catch (e) { return 0; } })() : 0,
          cardSelector: 'scripting-fallback',
          maxCollect: maxN,
          url: location.href,
        },
      };
    },
    args: [limit],
  });
  return (results && results[0] && results[0].result) || { jobs: [], collectDiag: null };
}

async function collectOnTab(cityCode, params) {
  if (collectAborted) return { jobs: [], collectDiag: null };
  const urlParams = params.urlParams ? Object.assign({}, params.urlParams) : { city: cityCode };
  if (!urlParams.city && cityCode) urlParams.city = cityCode;
  const dbc = params.districtByCity && params.districtByCity[cityCode];
  if (dbc) urlParams.multiBusinessDistrict = dbc;
  else if (!params.urlParams || !params.urlParams.multiBusinessDistrict) delete urlParams.multiBusinessDistrict;
  const url = (params && params.collectUrl) || buildJobUrl(urlParams);
  const isTest = !!(params && params.testMode);
  const maxCollect = (params && params.maxCollect > 0) ? params.maxCollect : 0;
  console.log('[即投] collectOnTab:', url);
  var tabId;
  // jitou 对齐：多城市/多关键词采集时，每条 collectUrl 独立后台 tab，采完保留供投递复用
  if (params && params.openDedicatedTab && !isTest) {
    const tab = await chrome.tabs.create({ url: url, active: false });
    tabId = tab.id;
    _collectOwnedTabIds.push(tabId);
    await waitForTabLoad(tabId, isTest ? 20000 : 25000);
  } else {
    tabId = await acquireCollectTab(url);
    await navigateTabForCollect(tabId, url, isTest ? 20000 : 25000);
  }
  await sleep(isTest ? 600 : 1200);
  await waitForContentScriptOnUrl(tabId, url, isTest ? 3500 : 5000, isTest ? 10 : 6);
  await sleep(isTest ? 500 : 1000);

  var collectPayload = Object.assign({}, params, { urlParams: urlParams, maxCollect: maxCollect });
  var response = null;
  try {
    response = await sendMessageToTab(
      tabId,
      { type: 'DO_COLLECT', params: collectPayload },
      isTest ? 25000 : 60000
    );
  } catch (msgErr) {
    console.warn('[即投] DO_COLLECT 失败，尝试 scripting 兜底:', msgErr.message);
    try {
      var fb = await collectViaScripting(tabId, maxCollect || 1);
      return { jobs: fb.jobs || [], collectDiag: fb.collectDiag || null };
    } catch (scriptErr) {
      throw new Error(msgErr.message + '；scripting 兜底也失败: ' + scriptErr.message);
    }
  }

  if (response && response.success) {
    return {
      jobs: response.jobs || [],
      collectDiag: response.collectDiag || null,
    };
  }
  if (!response || !response.jobs || !response.jobs.length) {
    try {
      var fb2 = await collectViaScripting(tabId, maxCollect || 1);
      if (fb2.jobs && fb2.jobs.length) return { jobs: fb2.jobs, collectDiag: fb2.collectDiag || null };
    } catch (e) {}
  }
  return { jobs: (response && response.jobs) || [], collectDiag: response && response.collectDiag ? response.collectDiag : null };
}

// 客户端硬过滤：BOSS 模糊匹配返回脏数据，按"全词命中"剔除非期望岗位
// 规则：选中的任一期望岗位的所有关键词都出现在 job.name 里 → 留
// 期望岗位为空 → 不过滤（兜底）；过滤后 0 条 → 打 warn 但仍返回 0 条不阻塞
// picker(严格) + 自定义(字符重叠) 期望岗位合集，用于 cluster/招呼语/发送（filter 仍区分两类）
function allExpectedPositions(state) {
  const sp = Array.isArray(state.selectedPositions) ? state.selectedPositions : [];
  const cp = Array.isArray(state.customPositions) ? state.customPositions : [];
  return sp.concat(cp);
}
function filterJobsByExpected(jobs, selectedPositions, customPositions) {
  const picker = Array.isArray(selectedPositions) ? selectedPositions : [];
  const custom = Array.isArray(customPositions) ? customPositions : [];
  if (!picker.length && !custom.length) return jobs;
  // 采集过滤与分组/发送同源：能归进某期望词组（matchJobToExpected !== '其他'）即保留。
  // 这样「保留 ⟺ 可归组」，被采进来的岗位不会在 B 页落「其他」。
  const filtered = jobs.filter(job => {
    if (!String((job && job.name) || '')) return false;
    return matchJobToExpected(job, picker, custom) !== '其他';
  });
  if (filtered.length === 0) {
    console.warn('[filterJobsByExpected] 过滤后 0 条', { before: jobs.length, selectedPositions, customPositions });
  }
  return filtered;
}

// 福利精筛（fail-open，绝不误杀）。镜像 content 侧 JobCollector.filterByWelfare 纯逻辑
// （SW 跨 world 调不到 content 模块，故复制一份）。welfareFilter='不限' → 不筛。
// 规则：某岗 welfareList 缺失(null/非数组) → 视为「数据未知」一律保留（fail-open）；
// 仅当 welfareList 已知且不含要求关键词时才滤掉。返回保留数组；放行的未知数写 state.welfareUnknownCount。
function filterJobsByWelfare(jobs, welfareFilter) {
  state.welfareUnknownCount = 0;
  if (!welfareFilter || welfareFilter === '不限') return jobs;
  const kw = welfareFilter; // 当前只支持单关键词「五险一金」
  let unknown = 0;
  const kept = (Array.isArray(jobs) ? jobs : []).filter(job => {
    const wl = job && job.welfareList;
    if (!Array.isArray(wl)) { unknown++; return true; } // 数据未知 → fail-open 保留
    return wl.some(w => String(w).indexOf(kw) !== -1);
  });
  state.welfareUnknownCount = unknown;
  if (kept.length === 0) {
    console.warn('[filterJobsByWelfare] 过滤后 0 条', { before: (jobs || []).length, welfareFilter });
  }
  return kept;
}

// 双休标题判定（镜像 content 侧 JobCollector.classifyRestDay；SW 跨 world 调不到 content 模块）。
// BOSS 网页端工作制信息只活在 jobName 标题里（四重印证锁死），故按标题白/黑名单打标。
// 返回 'double'|'no'|'unknown'。黑名单优先（更保守，宁可不标也不误标）。
function classifyRestDay(jobName) {
  const t = String(jobName || '');
  if (!t) return 'unknown';
  const NO = ['大小周', '单休', '做六休一', '单双周', '单双休'];
  for (let i = 0; i < NO.length; i++) { if (t.indexOf(NO[i]) !== -1) return 'no'; }
  const YES = ['双休', '周末双休', '做五休二', '五天工作制', '五天双休', '五天八小时'];
  for (let j = 0; j < YES.length; j++) { if (t.indexOf(YES[j]) !== -1) return 'double'; }
  return 'unknown';
}

// 双休精筛（fail-open，绝不误杀 + 命中置顶）。镜像 content 侧 JobCollector.filterByRestDay。
// restDayFilter='不限' → 不筛。'双休' 时：标题命中双休白名单→保留并置顶；命中非双休黑名单
// （大小周/单休等）→ 明确滤掉；标题未写工作制（unknown）→ fail-open 一律保留（HR 未在标题
// 写明 ≠ 非双休）。返回数组：双休命中岗在前（置顶），fail-open 岗在后；放行未知数写 state.restDayUnknownCount。
function filterJobsByRestDay(jobs, restDayFilter) {
  state.restDayUnknownCount = 0;
  const list = Array.isArray(jobs) ? jobs : [];
  if (restDayFilter !== '双休') return list;
  const hit = [];
  const failOpen = [];
  for (const job of list) {
    const rd = (job && job.restDay) || classifyRestDay(job && job.name);
    if (rd === 'double') hit.push(job);
    else if (rd === 'no') { /* 明确非双休，滤掉 */ }
    else failOpen.push(job);
  }
  state.restDayUnknownCount = failOpen.length;
  const kept = hit.concat(failOpen);
  if (kept.length === 0) {
    console.warn('[filterJobsByRestDay] 过滤后 0 条', { before: list.length, restDayFilter });
  }
  return kept;
}

// 单个 job → 期望岗位名 的打分匹配。统一委托共享真相源 matchJobToExpected（constants.js），
// 与 popup prepareGroups 完全同源 → 编辑 key === 发送 key，归组一致。分来源：picker 严格 / custom 宽松。
function matchJobToPosition(job, picker, custom) {
  return matchJobToExpected(job, picker, custom);
}

// Cluster jobs by primary tag (matching content-side logic in JobCollector.clusterByTag)
function clusterJobs(jobs, picker, custom) {
  const clusters = {};
  const positions = (Array.isArray(picker) ? picker : []).concat(Array.isArray(custom) ? custom : []);
  if (positions.length) {
    // 按用户期望岗位聚类（镜像 popup prepareGroups 匹配逻辑），确保每个期望岗位独立生成招呼语
    for (const pos of positions) { clusters[pos] = []; }
    clusters['其他'] = [];
    for (const job of jobs) {
      const bestPos = matchJobToPosition(job, picker, custom);
      if (bestPos !== '其他') clusters[bestPos].push(job);
      else clusters['其他'].push(job);
    }
    if (clusters['其他'].length === 0) delete clusters['其他'];
    return clusters;
  }
  // Fallback: 按 BOSS tag 首项聚类
  for (const job of jobs) {
    const primaryTag = (job.tags && job.tags[0]) || '其他';
    if (!clusters[primaryTag]) clusters[primaryTag] = [];
    clusters[primaryTag].push(job);
  }
  return clusters;
}

function sampleJDs(clusters, perCluster = 5) {
  const samples = {};
  for (const [tag, tagJobs] of Object.entries(clusters)) {
    samples[tag] = tagJobs.slice(0, perCluster).map(j => ({
      title: j.name || j.title,
      tags: j.tags,
      desc: j.name || j.title,
    }));
  }
  return samples;
}

async function stopCollect() {
  if (state.phase !== 'collecting') {
    state.phase = 'idle';
    collectAborted = true;
    stopCollectKeepalive();
    await releaseCollectTab().catch(function () {});
    chrome.runtime.sendMessage({ type: MSG.COLLECT_STOPPED, partial: false }).catch(function () {});
    pushState();
    return;
  }
  collectAborted = true;
  stopCollectKeepalive();
  try { DiagLogger.userEvent('sw.collect', '用户停止采集 (STOP_COLLECT)'); } catch (_) {}
  await releaseCollectTab();
  const tabs = await chrome.tabs.query({ url: '*://*.zhipin.com/*' });
  tabs.forEach(function (t) { chrome.tabs.sendMessage(t.id, { type: 'DO_STOP' }).catch(function () {}); });
}

// ── 浏览模式投递（当前页面 / 推荐标签逐卡片）──
function isZhipinJobsPageUrl(url) {
  if (!url || url.indexOf('zhipin.com') < 0) return false;
  try {
    return new URL(url).pathname.indexOf('/web/geek/jobs') === 0;
  } catch (_) {
    return url.indexOf('/web/geek/jobs') >= 0;
  }
}

async function activateBrowseTab(tabId) {
  await chrome.tabs.update(tabId, { active: true });
  await waitForTabLoad(tabId);
  var fresh = await chrome.tabs.get(tabId);
  return { tabId: fresh.id, url: fresh.url || '' };
}

async function acquireBrowseTab(params) {
  params = params || {};
  var jobsUrl = 'https://www.zhipin.com/web/geek/jobs';
  var scope = params.browseScope || params.scope || 'current';

  // 1. Popup 打开扩展时捕获的源 tab（最可靠：用户正在看的页）
  if (params.sourceTabId) {
    try {
      var srcTab = await chrome.tabs.get(params.sourceTabId);
      if (srcTab && isZhipinJobsPageUrl(srcTab.url)) {
        try { DiagLogger.info('sw.browse', 'acquireBrowseTab: 使用 popup 源 tab=' + srcTab.id + ' url=' + (srcTab.url || '').slice(0, 120)); } catch (_) {}
        return activateBrowseTab(srcTab.id);
      }
      if (scope === 'current') {
        throw new Error('请先在 BOSS 岗位搜索页打开扩展（当前标签页不是岗位列表），筛选好后再点开始浏览投递');
      }
    } catch (e) {
      if (e && e.message && e.message.indexOf('请先在 BOSS') === 0) throw e;
    }
  }

  // 2. 用户最后聚焦窗口的 active tab
  try {
    var lfwTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (lfwTabs.length && lfwTabs[0].id && isZhipinJobsPageUrl(lfwTabs[0].url)) {
      try { DiagLogger.info('sw.browse', 'acquireBrowseTab: 使用 lastFocusedWindow tab=' + lfwTabs[0].id); } catch (_) {}
      return activateBrowseTab(lfwTabs[0].id);
    }
  } catch (_) {}

  // 3. 已打开的岗位页：优先带 query 的（更可能是用户筛过的），不修改 URL
  var tabs = await chrome.tabs.query({ url: '*://*.zhipin.com/web/geek/jobs*' });
  if (tabs.length) {
    var withQuery = tabs.filter(function (t) { return t.url && t.url.indexOf('?') >= 0; });
    var pool = withQuery.length ? withQuery : tabs;
    pool.sort(function (a, b) { return (b.url || '').length - (a.url || '').length; });
    var activePick = pool.find(function (t) { return t.active; });
    var pick = activePick || pool[0];
    try { DiagLogger.info('sw.browse', 'acquireBrowseTab: 使用已有 jobs tab=' + pick.id + ' url=' + (pick.url || '').slice(0, 120)); } catch (_) {}
    return activateBrowseTab(pick.id);
  }

  if (scope === 'current') {
    throw new Error('未找到 BOSS 岗位搜索页，请先在浏览器打开并筛选好岗位列表，再点开始浏览投递');
  }

  // 4. 兜底（仅 recommend 模式）：新开默认首页，不劫持其他 BOSS 页
  try { DiagLogger.info('sw.browse', 'acquireBrowseTab: 无 jobs 页，新建默认首页'); } catch (_) {}
  var newTab = await chrome.tabs.create({ url: jobsUrl, active: true });
  await waitForTabLoad(newTab.id);
  return { tabId: newTab.id, url: newTab.url || jobsUrl };
}

async function startBrowse(params) {
  if (state.browsing) throw new Error('浏览投递已在进行中');
  var dailyCount = await getDailySendCount();
  if (dailyCount >= (CONFIG.DAILY_SEND_LIMIT || 150)) {
    throw new Error('今日投递已达上限（' + (CONFIG.DAILY_SEND_LIMIT || 150) + ' 条）');
  }
  await ensureAppliedJobIdsLoaded();
  _browseDailyCountedJobIds = new Set();
  var browseDailyTotal = await getBrowseDailyCount();
  var sessionLimit = params.sessionLimit != null ? params.sessionLimit : 0;
  state.browsing = true;
  state.phase = 'browsing';
  state.browseStats = {
    sent: 0, skipped: 0, failed: 0, processed: 0, currentTag: '',
    sessionSent: 0, sessionLimit: sessionLimit, dailyTotal: browseDailyTotal,
  };
  state.browseResults = [];
  state.titleExcludeKeywords = params.titleExcludeKeywords != null ? params.titleExcludeKeywords : (state.titleExcludeKeywords || '');
  state.companyExcludeKeywords = params.companyExcludeKeywords != null ? params.companyExcludeKeywords : (state.companyExcludeKeywords || '');
  state.hrActiveFilter = params.hrActiveFilter || state.hrActiveFilter || '不限';
  pushState();

  var acquired = await acquireBrowseTab(params);
  var tabId = acquired.tabId;
  var tabUrl = acquired.url || '';
  state.browseTabId = tabId;
  // 浏览模式：只等 CS 就绪，不做 URL 键匹配（避免误判 reload 导致筛选丢失）
  await waitForContentScript(tabId, 5000, 8);
  var greetEnable = await ensureGreetingEnabled(tabId);
  if (greetEnable && greetEnable.autoEnabled) {
    chrome.runtime.sendMessage({ type: MSG.GREETING_AUTO_ENABLED }).catch(function () {});
  }
  if (greetEnable && greetEnable.ok === false && !greetEnable.unknown) {
    state.browsing = false;
    state.phase = 'idle';
    pushState();
    throw new Error('无法开启 BOSS 自动打招呼，浏览投递需要平台招呼语');
  }

  params.appliedJobIds = Array.from(appliedJobIds);
  chrome.tabs.sendMessage(tabId, { type: MSG.DO_BROWSE, params: params }).catch(function (e) {
    state.browsing = false;
    state.phase = 'idle';
    pushState();
    try { DiagLogger.error('sw.browse', 'DO_BROWSE 发送失败: ' + e.message); } catch (_) {}
  });
}

async function stopBrowse() {
  if (!state.browsing) {
    state.phase = 'idle';
    state.browseTabId = null;
    pushState();
    return;
  }
  state.browsing = false;
  state.browseTabId = null;
  try { DiagLogger.userEvent('sw.browse', '用户停止浏览投递'); } catch (_) {}
  var tabs = await chrome.tabs.query({ url: '*://*.zhipin.com/web/geek/jobs*' });
  tabs.forEach(function (t) { chrome.tabs.sendMessage(t.id, { type: MSG.DO_STOP }).catch(function () {}); });
  state.phase = 'browse_done';
  pushState();
}

// ── 发送完成（切换到 review 或 fallback）──
function finishSend() {
  try {
    var _dOk = 0, _dFail = 0, _dSkip = 0;
    for (var _di = 0; _di < state.sendResults.length; _di++) {
      var _dr = state.sendResults[_di];
      if (_dr && _dr.success) _dOk++; else if (_dr && _dr.skipped) _dSkip++; else _dFail++;
    }
    DiagLogger.info('sw.send', '阶段完成：finishSend ok=' + _dOk + ' fail=' + _dFail + ' skip=' + _dSkip + ' total=' + state.sendResults.length);
  } catch (_) {}
  state.phase = 'review';
  state.sendDuration = Date.now() - sendStartTime;
  state.sendProgress = { sent: state.sendProgress.sent, total: state.sendProgress.total };
  pushState();
  // ── 商业化：免费批成功率达标才扣额度 ──
  // 本批靠免费额度放行（非会员）→ 仅当成功率 ≥ 90% 才 POST /consume-free（幂等）。
  // 成功率 = 成功数 / (应投数 − HR跳过数)；HR跳过(skipped)从分母剔除，不计分子也不计分母。
  // 会员批不调；成功率 < 0.9（含 0 成功）不扣，可重试；分母为 0（全跳过）不扣，不除零。
  if (_batchIsFreeQuota) {
    var _qOk = 0, _qDenom = 0;  // 复用上方口径：success=成功，skipped=剔除，其余=失败(计分母)
    for (var _qi = 0; _qi < state.sendResults.length; _qi++) {
      var _qr = state.sendResults[_qi];
      if (_qr && _qr.success) { _qOk++; _qDenom++; }
      else if (_qr && _qr.skipped) { /* HR跳过：分子分母均不计 */ }
      else { _qDenom++; }
    }
    var _qRate = _qDenom > 0 ? (_qOk / _qDenom) : 0;
    if (_qDenom > 0 && _qRate >= 0.9) {
      consumeFreeQuota();
      try { DiagLogger.info('sw.send', '免费额度已消耗（成功率达标 rate=' + _qRate.toFixed(3) + ' ok=' + _qOk + ' denom=' + _qDenom + '）'); } catch (_) {}
    } else {
      try { DiagLogger.info('sw.send', '免费额度未消耗（成功率不足 rate=' + _qRate.toFixed(3) + ' ok=' + _qOk + ' denom=' + _qDenom + '）'); } catch (_) {}
    }
    _batchIsFreeQuota = false; // 单批一次性，置回防误扣
  }
  chrome.runtime.sendMessage({
    type: MSG.SEND_COMPLETE,
    results: state.sendResults,
    duration: state.sendDuration,
    missedCount: (state._v6MissedJobs || []).length, // A1：review 页据此显示「一键补发」提示行
  }).catch(() => {});
  restoreGreetingSettingAfterSend().catch(function () {});
}

// ── 诊断滚动归档（ring buffer，保留最近 5 次投递任务）──
// 每次任务终态写一份「本轮完整诊断摘要」（时间戳/sendResults 摘要+全量/脱敏 snapshot）到 diag:recentRuns。
// 即使用户开新任务清内存，历史 5 份仍在；导出时按时间窗定位是哪次投递。
function archiveRecentRun(reason) {
  return new Promise(function (resolve) {
    try {
      var results = (state.sendResults || []);
      var ok = 0, fail = 0, skip = 0, failures = [];
      for (var i = 0; i < results.length; i++) {
        var r = results[i] || {};
        if (r.success) ok++;
        else { if (r.skipped) skip++; else fail++; }
        if (!r.success) {
          failures.push({
            position: String(r.positionName || '').slice(0, 30),
            company: String(r.companyName || '').slice(0, 30),
            error: String(r.error || '').slice(0, 120),
            time: r.time || 0,
          });
        }
      }
      var run = {
        endTs: Date.now(),
        reason: reason,
        snapshot: buildSnapshotSummary(),  // 已脱敏
        sendSummary: { total: results.length, ok: ok, fail: fail, skip: skip },
        failures: failures.slice(0, 50),
        // sendResults 全量（脱敏：只留岗位/公司/状态/错误/时间，不含招呼语/简历）
        sendResults: results.map(function (x) {
          x = x || {};
          return {
            jobId: x.jobId,
            positionName: String(x.positionName || '').slice(0, 40),
            companyName: String(x.companyName || '').slice(0, 40),
            success: !!x.success,
            skipped: !!x.skipped,
            error: String(x.error || '').slice(0, 120),
            time: x.time || 0,
          };
        }),
      };
      chrome.storage.local.get(STORAGE_KEYS.DIAG.RECENT_RUNS, function (got) {
        var arr = (got && Array.isArray(got[STORAGE_KEYS.DIAG.RECENT_RUNS])) ? got[STORAGE_KEYS.DIAG.RECENT_RUNS] : [];
        arr.push(run);
        while (arr.length > 5) arr.shift();  // ring buffer：仅保留最近 5 次
        var put = {}; put[STORAGE_KEYS.DIAG.RECENT_RUNS] = arr;
        chrome.storage.local.set(put, function () { resolve(); });
      });
    } catch (e) { resolve(); }
  });
}

// ── 统一终态出口 ──
// 所有任务结束路径（成功完成 / 失败 / 用户停止 / stage1 超时）都汇到这里：
// 为「在队列里但从未产出结果」的岗位补一条中性灰「未投递」结果，再走 review。
// 永不再走 phase='idle'+ERROR 的死胡同（那会让 popup 死卡「正在投递」）。
async function finalizeTask(reason) {
  try { DiagLogger.info('sw.send', 'finalizeTask reason=' + reason + ' queueLeft=' + ((state.sendQueueV6 || []).length) + ' repairLeft=' + ((state._v6RepairQueue || []).length) + ' results=' + state.sendResults.length); } catch (_) {}
  // 把仍残留在发送队列/补发队列、却没有任何 sendResults 记录的岗位，记为「未投递」（中性灰）
  var recorded = {};
  for (var ri = 0; ri < state.sendResults.length; ri++) {
    if (state.sendResults[ri] && state.sendResults[ri].jobId != null) recorded[state.sendResults[ri].jobId] = true;
  }
  var leftovers = []
    .concat(state.sendQueueV6 || [])
    .concat(state._v6RepairQueue || []);
  // A1 漏发清单：已建联（stage1 点过「立即沟通」，hrName 非空）但没有任何投递结果记录的岗位。
  // 此处只计算并留存清单（保留 greeting/hrName 等队列项字段，补发要用），不发送任何内容——
  // 「停止 = 立即硬中止」语义零改动；补发仅由 review 页「一键补发」或恢复路径触发。
  // 排除：已有结果记录（成功/失败/跳过，在 recorded/sentJobIds）的、空/占位招呼语的（#36 保险丝语义，
  // 正常路径这类岗早被 dropMissingGreetingJobs 剔队并记失败，此处兜底不让其入补发清单）。
  var _missed = [], _missedSeen = {};
  for (var mi = 0; mi < leftovers.length; mi++) {
    var mt = leftovers[mi];
    if (!mt || mt.jobId == null || !mt.hrName) continue;
    if (recorded[mt.jobId] || sentJobIds.has(mt.jobId) || _missedSeen[mt.jobId]) continue;
    if (isGreetingMissing(mt.greeting)) continue;
    _missedSeen[mt.jobId] = true;
    _missed.push(mt);
    recorded[mt.jobId] = true;  // 标记已处理：归入待补发清单，下方循环不再把它当「未投递」重复记
  }
  state._v6MissedJobs = _missed;
  if (_missed.length) {
    try { DiagLogger.info('sw.send', 'A1 漏发清单：' + _missed.length + ' 个已建联未发岗位（reason=' + reason + '）'); } catch (_) {}
  }
  for (var li = 0; li < leftovers.length; li++) {
    var it = leftovers[li];
    if (!it || it.jobId == null || recorded[it.jobId]) continue;
    recorded[it.jobId] = true;
    state.sendResults.push({
      jobId: it.jobId,
      positionName: it.positionName || '',
      companyName: it.companyName || '',
      success: false,
      skipped: true,                       // 计入 failCount，renderReview 以中性灰呈现
      error: reason === 'stopped' ? '未投递：已停止' : '未投递',
      time: Date.now(),
    });
  }
  // total 反映本批所有已记录结果（已投 + skip + 未投递），review 据此展示
  state.sendProgress.total = state.sendResults.length;
  state.sendPhase = '';
  await persistState();
  // 诊断滚动归档：把本轮完整诊断摘要存进 diag:recentRuns（最近 5 次），开新任务清内存也不丢
  try { await archiveRecentRun(reason); } catch (_) {}
  finishSend();
}

// ════════════════════════════════════════════════════════════════
// v5 发送协调 — 双页面串行循环
// ════════════════════════════════════════════════════════════════

async function startSendV5(jobIds) {
  sendStartTime = Date.now();

  // 构建发送队列（过滤已发送）
  const filtered = [];
  for (const id of jobIds) {
    if (sentJobIds.has(id)) continue;
    const job = state.jobs.find(j => j.id === id);
    if (!job) continue;
    filtered.push({
      jobId: id,
      positionName: job.name || '',
      companyName: job.company || '',
      jobLink: job.link || '',
      greeting: state.greetings[job?.tags?.[0] || '其他'] || '',
    });
  }
  if (filtered.length === 0) throw new Error('所有岗位均已发送');

  state.phase = 'sending';
  state.sendQueue = filtered;
  state.sendIndex = 0;
  state.sendProgress = { sent: 0, total: filtered.length };
  state.searchTabId = null;
  pushState();

  // 找到搜索页 tab
  const jobTabs = await chrome.tabs.query({ url: '*://*.zhipin.com/web/geek/jobs*' });
  if (jobTabs.length === 0) throw new Error('搜索页面已关闭');
  state.searchTabId = jobTabs[0].id;
  await waitForContentScript(state.searchTabId);

  // 打开/复用聊天页 tab
  let chatTabId = state.chatTabId;
  if (chatTabId) {
    try {
      const existing = await chrome.tabs.get(chatTabId);
      if (!existing || !existing.url?.includes('/web/geek/chat')) chatTabId = null;
    } catch (_) { chatTabId = null; }
  }
  if (!chatTabId) {
    const ct = await chrome.tabs.create({
      url: 'https://www.zhipin.com/web/geek/chat',
      active: true,
    });
    chatTabId = ct.id;
    state.chatTabId = ct.id;
    await waitForTabLoad(ct.id);
  }
  pushState();
  await waitForContentScript(chatTabId);
  // 切回搜索 tab（后台 tab 节流修复）
  await chrome.tabs.update(state.searchTabId, { active: true });

  // 串行循环
  for (let i = 0; i < filtered.length && state.phase === 'sending'; i++) {
    const item = filtered[i];
    state.sendIndex = i;
    let hrName = '', hrCompany = '';

    // 搜索页：点立即沟通
    try {
      const startResp = await chrome.tabs.sendMessage(state.searchTabId, {
        type: MSG.DO_START_CHAT,
        jobLink: item.jobLink,
        positionName: item.positionName,
        companyName: item.companyName,
      });
      if (!startResp || !startResp.success) {
        if (startResp?.error && startResp.error.includes('captcha')) {
          state.phase = 'captcha_paused';
          pushState();
          break;
        }
        await recordV5Failure(item, startResp?.error || '启动聊天失败');
        continue;
      }
      hrName = startResp.hrName || '';
      hrCompany = startResp.hrCompany || '';
      // 等 BOSS 服务端创建会话 + 推送到聊天 tab
      await new Promise(r => setTimeout(r, 1500));
    } catch (err) {
      if (err.message?.includes('captcha')) {
        state.phase = 'captcha_paused';
        pushState();
        break;
      }
      await recordV5Failure(item, err.message);
      continue;
    }

    // 聊天页：发送招呼语+简历
    try {
      const sendResp = await chrome.tabs.sendMessage(chatTabId, {
        type: MSG.DO_SEND_CHAT,
        hrName: hrName,
        hrCompany: hrCompany,
        greeting: item.greeting,
        jobId: item.jobId,
      });
      if (!sendResp || !sendResp.success) {
        if (sendResp?.captchaDetected || sendResp?.error?.includes('captcha')) {
          state.phase = 'captcha_paused';
          pushState();
          break;
        }
        await recordV5Failure(item, sendResp?.error || '发送失败');
        continue;
      }
      await recordV5Success(item);
    } catch (err) {
      if (err.message?.includes('captcha')) {
        state.phase = 'captcha_paused';
        pushState();
        break;
      }
      await recordV5Failure(item, err.message);
      continue;
    }

    // 随机 2-4s 延迟（最后一个不等）
    if (i < filtered.length - 1 && state.phase === 'sending') {
      const delay = 333;
      await new Promise(r => setTimeout(r, delay));
    }
  }

  // 清理聊天 tab
  try { await chrome.tabs.remove(state.chatTabId); } catch (_) {}
  state.chatTabId = null;
  state.searchTabId = null;
  state.sendQueue = [];
  state.sendIndex = 0;
  pushState();

  if (state.phase === 'sending') finishSend();
}

async function recordV5Success(item) {
  sentJobIds.add(item.jobId);
  state.sendProgress.sent++;
  state.sendResults.push({
    jobId: item.jobId, success: true,
    positionName: item.positionName, companyName: item.companyName,
  });
  pushState();
  chrome.runtime.sendMessage({
    type: MSG.SEND_ITEM_RESULT,
    payload: { jobId: item.jobId, success: true, positionName: item.positionName },
  }).catch(() => {});
}

async function recordV5Failure(item, error) {
  sentJobIds.add(item.jobId);
  state.sendProgress.sent++;
  state.sendResults.push({
    jobId: item.jobId, success: false, error,
    positionName: item.positionName, companyName: item.companyName,
  });
  pushState();
  chrome.runtime.sendMessage({
    type: MSG.SEND_ITEM_RESULT,
    payload: { jobId: item.jobId, success: false, error, positionName: item.positionName },
  }).catch(() => {});
}

// ════════════════════════════════════════════════════════════
// 投递数量闸门 —— 日累积计数器（本地自然日，零点归零）
// 口径：当天「成功发起沟通」的岗位数。成功落账处 +1，幂等（同 jobId 不重复计）。
// 完全独立于发送批次状态：自带 storage key，跨 SW 重启读储存里的 {date,count} 复活；
// date 与今天不符即视为 0（跨日归零，不主动清旧 key）。绝不与核心 send state 耦合。
// ────────────────────────────────────────────────────────────
function localDateKey() {
  // 本地自然日 YYYY-MM-DD（避免 toISOString 的 UTC 偏移导致零点判定错位）
  var d = new Date();
  var y = d.getFullYear();
  var m = String(d.getMonth() + 1).padStart(2, '0');
  var day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

// 本批已计数的 jobId（幂等去重）：startSendV6 每批开始清空
let _dailyCountedJobIds = new Set();
// 浏览模式本批已计数的 jobId（幂等去重）：startBrowse 每批开始清空
let _browseDailyCountedJobIds = new Set();

async function getDailySendCount() {
  try {
    var r = await chrome.storage.local.get(STORAGE_KEYS.SW.DAILY_SEND_COUNT);
    var rec = r[STORAGE_KEYS.SW.DAILY_SEND_COUNT];
    if (rec && rec.date === localDateKey() && typeof rec.count === 'number') return rec.count;
  } catch (_) {}
  return 0; // 无记录 / 跨日 / 异常 → 视为今日 0
}

async function incrementDailySendCount(jobId) {
  // 幂等：同一 jobId 本批只 +1（worker 成功 + repair 翻成功可能对同岗调两次）
  if (jobId != null) {
    if (_dailyCountedJobIds.has(jobId)) return;
    _dailyCountedJobIds.add(jobId);
  }
  try {
    var today = localDateKey();
    var r = await chrome.storage.local.get(STORAGE_KEYS.SW.DAILY_SEND_COUNT);
    var rec = r[STORAGE_KEYS.SW.DAILY_SEND_COUNT];
    var count = (rec && rec.date === today && typeof rec.count === 'number') ? rec.count : 0;
    count += 1;
    await chrome.storage.local.set({ [STORAGE_KEYS.SW.DAILY_SEND_COUNT]: { date: today, count: count } });
  } catch (_) {}
}

async function getBrowseDailyCount() {
  try {
    var r = await chrome.storage.local.get(STORAGE_KEYS.SW.BROWSE_DAILY_COUNT);
    var rec = r[STORAGE_KEYS.SW.BROWSE_DAILY_COUNT];
    if (rec && rec.date === localDateKey() && typeof rec.count === 'number') return rec.count;
  } catch (_) {}
  return 0;
}

async function incrementBrowseDailyCount(jobId) {
  if (jobId != null) {
    if (_browseDailyCountedJobIds.has(jobId)) return getBrowseDailyCount();
    _browseDailyCountedJobIds.add(jobId);
  }
  try {
    var today = localDateKey();
    var r = await chrome.storage.local.get(STORAGE_KEYS.SW.BROWSE_DAILY_COUNT);
    var rec = r[STORAGE_KEYS.SW.BROWSE_DAILY_COUNT];
    var count = (rec && rec.date === today && typeof rec.count === 'number') ? rec.count : 0;
    count += 1;
    await chrome.storage.local.set({ [STORAGE_KEYS.SW.BROWSE_DAILY_COUNT]: { date: today, count: count } });
    return count;
  } catch (_) {}
  return getBrowseDailyCount();
}

// 投递错位止血 #3：调用契约——只有「确认发给了正确 HR」才可调本函数。
// 前置不变量（调用方保证）：① WORKER_ACTIVATE 返回 success（含 fallback 命中已通过身份断言）；
// ② WORKER_SEND 返回 success（内容确认送达）。任一不满足走 recordV6Failure + 补发，绝不标成功。
async function recordV6Success(item) {
  sentJobIds.add(item.jobId);
  markJobApplied(item.jobId);
  state.sendProgress.sent++;
  incrementDailySendCount(item.jobId); // 投递数量闸门：成功投递 +1（幂等、独立落盘）
  var _result = {
    jobId: item.jobId, positionName: item.positionName, companyName: item.companyName,
    success: true, hrName: item.hrName, time: Date.now()
  };
  if (isPlatformSendMode()) _result.platformGreeting = true;
  if (item.alreadyChatted) _result.alreadyChatted = true;
  state.sendResults.push(_result);
  pushState();
  chrome.runtime.sendMessage({
    type: MSG.SEND_ITEM_RESULT,
    payload: { jobId: item.jobId, positionName: item.positionName, companyName: item.companyName, success: true }
  }).catch(() => {});
}

function processStage1ExtractFailures() {
  var _extractFailed = state.sendQueueV6.filter(function(item) { return !item.hrName; });
  state.sendQueueV6 = state.sendQueueV6.filter(function(item) { return item.hrName; });
  for (var _fi = 0; _fi < _extractFailed.length; _fi++) {
    var _ft = _extractFailed[_fi];
    if (sentJobIds.has(_ft.jobId)) continue;
    sentJobIds.add(_ft.jobId);
    state.sendProgress.sent++;
    var _err = _ft.extractError || _ft._lastBatchError || '未能在搜索页找到该岗位卡片';
    state.sendResults.push({
      jobId: _ft.jobId,
      positionName: _ft.positionName,
      companyName: _ft.companyName,
      success: false, skipped: true,
      error: '未投递：' + _err,
      time: Date.now(),
    });
  }
  if (_extractFailed.length) {
    console.log('[即投] stage1: 记录', _extractFailed.length, '个提取失败岗位');
    pushState();
  }
}

function processStage1AlreadyChatted() {
  var _skippedAlready = state.sendQueueV6.filter(function(item) { return item.alreadyChatted; });
  state.sendQueueV6 = state.sendQueueV6.filter(function(item) { return !item.alreadyChatted; });
  for (var _si = 0; _si < _skippedAlready.length; _si++) {
    var _it = _skippedAlready[_si];
    if (sentJobIds.has(_it.jobId)) continue;
    sentJobIds.add(_it.jobId);
    markJobApplied(_it.jobId);
    incrementDailySendCount(_it.jobId);
    state.sendProgress.sent++;
    state.sendResults.push({
      jobId: _it.jobId,
      positionName: _it.positionName,
      companyName: _it.companyName,
      success: true,
      alreadyChatted: true,
      hrName: _it.hrName,
      platformGreeting: isPlatformSendMode(),
      time: Date.now(),
    });
  }
  if (_skippedAlready.length) {
    console.log('[即投] stage1: 跳过', _skippedAlready.length, '个已沟通过的岗位');
    pushState();
  }
}

async function finishPlatformSendAfterStage1() {
  var _items = state.sendQueueV6.slice();
  for (var i = 0; i < _items.length; i++) {
    if (sendAborted) break;
    var it = _items[i];
    if (!it || !it.hrName || sentJobIds.has(it.jobId)) continue;
    await recordV6Success(it);
  }
  state.sendQueueV6 = [];
  state.sendPhase = '';
  pushSendProgressDisplay({
    sent: state.sendResults.filter(function (r) { return r.success; }).length,
    total: getSendDisplayTotal(),
    batchSub: '投递完成',
    status: '快速投递完成',
  });
  await cleanupV6();
  await finalizeTask('done');
}

async function recordV6Failure(item, error, stage) {
  sentJobIds.add(item.jobId);
  state.sendProgress.sent++;
  state.sendResults.push({
    jobId: item.jobId, positionName: item.positionName, companyName: item.companyName,
    success: false, error: error, stage: stage || null, hrName: item.hrName, time: Date.now()
  });
  pushState();
  chrome.runtime.sendMessage({
    type: MSG.SEND_ITEM_RESULT,
    payload: { jobId: item.jobId, positionName: item.positionName, companyName: item.companyName, success: false, error: error }
  }).catch(() => {});
}

async function resumeSendV5() {
  console.log('[即投] Resuming v5 send');
  state.chatTabId = null;

  const jobTabs = await chrome.tabs.query({ url: '*://*.zhipin.com/web/geek/jobs*' });
  if (jobTabs.length === 0) {
    state.phase = 'idle';
    state.sendProgress = { sent: 0, total: 0 };
    pushState();
    chrome.runtime.sendMessage({ type: 'ERROR', message: '搜索页面已关闭，无法恢复发送' }).catch(() => {});
    return;
  }
  state.searchTabId = jobTabs[0].id;

  const unsentJobs = state.jobs.filter(j => !sentJobIds.has(j.id));
  state.sendQueue = unsentJobs.map(j => ({
    jobId: j.id,
    positionName: j.name || '',
    companyName: j.company || '',
    jobLink: j.link || '',
    greeting: state.greetings[j?.tags?.[0] || '其他'] || '',
  }));
  state.sendIndex = 0;
  state.sendProgress = { sent: sentJobIds.size, total: state.jobs.length };
  state.phase = 'sending';
  pushState();

  const ct = await chrome.tabs.create({
    url: 'https://www.zhipin.com/web/geek/chat',
    active: true,
  });
  state.chatTabId = ct.id;
  pushState();
  await waitForTabLoad(ct.id);
  await waitForContentScript(ct.id);
  // 切回搜索 tab（后台 tab 节流修复）
  await chrome.tabs.update(state.searchTabId, { active: true });

  try {
    await waitForContentScript(state.searchTabId);
  } catch (e) {
    for (const item of state.sendQueue) {
      await recordV5Failure(item, '搜索页未就绪(恢复)');
    }
    finishSend();
    return;
  }

  // 继续主循环——复用 startSendV5 的循环逻辑
  const filtered = state.sendQueue;
  const chatTabId = state.chatTabId;
  for (let i = 0; i < filtered.length && state.phase === 'sending'; i++) {
    const item = filtered[i];
    state.sendIndex = i;
    let hrName = '', hrCompany = '';

    try {
      const startResp = await chrome.tabs.sendMessage(state.searchTabId, {
        type: MSG.DO_START_CHAT,
        jobLink: item.jobLink,
        positionName: item.positionName,
        companyName: item.companyName,
      });
      if (!startResp || !startResp.success) {
        if (startResp?.error?.includes('captcha')) { state.phase = 'captcha_paused'; pushState(); break; }
        await recordV5Failure(item, startResp?.error || '启动聊天失败');
        continue;
      }
      hrName = startResp.hrName || '';
      hrCompany = startResp.hrCompany || '';
      // 等 BOSS 服务端创建会话 + 推送到聊天 tab
      await new Promise(r => setTimeout(r, 1500));
    } catch (err) {
      if (err.message?.includes('captcha')) { state.phase = 'captcha_paused'; pushState(); break; }
      await recordV5Failure(item, err.message);
      continue;
    }

    try {
      const sendResp = await chrome.tabs.sendMessage(chatTabId, {
        type: MSG.DO_SEND_CHAT,
        hrName, hrCompany,
        greeting: item.greeting,
        jobId: item.jobId,
      });
      if (!sendResp || !sendResp.success) {
        if (sendResp?.captchaDetected || sendResp?.error?.includes('captcha')) {
          state.phase = 'captcha_paused'; pushState(); break;
        }
        await recordV5Failure(item, sendResp?.error || '发送失败');
        continue;
      }
      await recordV5Success(item);
    } catch (err) {
      if (err.message?.includes('captcha')) { state.phase = 'captcha_paused'; pushState(); break; }
      await recordV5Failure(item, err.message);
      continue;
    }

    if (i < filtered.length - 1 && state.phase === 'sending') {
      await new Promise(r => setTimeout(r, 333));
    }
  }

  try { await chrome.tabs.remove(state.chatTabId); } catch (_) {}
  state.chatTabId = null;
  state.searchTabId = null;
  state.sendQueue = [];
  state.sendIndex = 0;
  pushState();
  if (state.phase === 'sending') finishSend();
}

// ════════════════════════════════════════════════════════════════
// v6 发送协调 — 搜索页批量提取 + 3 worker 并行发送
// ════════════════════════════════════════════════════════════════

async function resumeSendV6() {
  await bootRestored;         // 冷启动竞态防护：等 selectedPositions/greetings 等恢复完，防止 dropMissingGreetingJobs 误剔好岗位
  try { DiagLogger.info('sw.send', 'resumeSendV6：SW 重启后恢复发送任务 sendPhase=' + state.sendPhase + ' queueLen=' + ((state.sendQueueV6 || []).length)); } catch (_) {}
  try { _diagMarkSelfTabOps(); } catch (_) {} // 下面清理残留 worker tab 属扩展自身操作
  // 清理残留 worker：优先关独立后台窗口（连带关 tab），tab remove 作兜底
  for (var wi = 0; wi < (state._v6WorkerWindowIds || []).length; wi++) {
    try { await chrome.windows.remove(state._v6WorkerWindowIds[wi]); } catch (e) {}
  }
  state._v6WorkerWindowIds = [];
  for (var i = 0; i < state._v6WorkerTabIds.length; i++) {
    try { await chrome.tabs.remove(state._v6WorkerTabIds[i]); } catch(e) {}
  }
  state._v6WorkerTabIds = [];
  state._v6WorkerTabsReady.clear();

  // 找到搜索 tab
  var searchTabs = await chrome.tabs.query({ url: '*://*.zhipin.com/web/geek/jobs*' });
  if (!searchTabs.length) {
    state.phase = 'idle'; state.sendPhase = '';
    await persistState();
    chrome.runtime.sendMessage({ type: 'ERROR', phase: 'sending', error: '未找到搜索页面，请打开BOSS直聘搜索页后重试' }).catch(() => {});
    return;
  }
  state.searchTabId = searchTabs[0].id;

  // 构建 sendQueueV6（从持久化的队列，如果有，否则从 state.jobs 重建）
  if (!state.sendQueueV6.length) {
    await loadJobCustomIntoState(); // 恢复路径重建队列也需 per-job 自定义招呼语（持久化队列已含 greeting，无需重灌）
    state.sendQueueV6 = buildSendQueueV6(state, state.jobs.map(function(j) { return j.jobId || j.id; }));
  }
  if (!isPlatformSendMode()) {
    dropMissingGreetingJobs();
  }
  if (isPlatformSendMode()) {
    try {
      await runStage1AcrossSearchUrls();
    } catch (navErr) {
      state.phase = 'idle'; state.sendPhase = '';
      await persistState();
      chrome.runtime.sendMessage({ type: 'ERROR', phase: 'sending', error: navErr.message || '未找到搜索页面' }).catch(() => {});
      return;
    }
    await sleep(getSendSpeedProfile().postExtractMs);
    processStage1ExtractFailures();
    processStage1AlreadyChatted();
    await finishPlatformSendAfterStage1();
    return;
  }
  // A1 漏发补救（意外中断恢复）：已建联（hrName 非空）且无任何投递结果的岗位，不再重跑
  // stage1/stage2（重点「立即沟通」无意义、worker sendText 不核对历史有双发风险），
  // 先摘出来，stage2 之后并入 _v6RepairQueue 走 runRepairV6——repairSingle 先核对服务器
  // 历史再缺啥补啥，天然防双发。无需用户任何操作。
  var _resumeMissed = (state.sendQueueV6 || []).filter(function (it) {
    return it && it.jobId != null && it.hrName && !sentJobIds.has(it.jobId) && !isGreetingMissing(it.greeting);
  });
  if (_resumeMissed.length) {
    var _rmIds = {};
    _resumeMissed.forEach(function (it) { _rmIds[it.jobId] = true; });
    state.sendQueueV6 = state.sendQueueV6.filter(function (it) { return !it || !_rmIds[it.jobId]; });
    try { DiagLogger.info('sw.send', 'resume：' + _resumeMissed.length + ' 个已建联未发岗位转入补发队列（不重跑两阶段）'); } catch (_) {}
  }
  state.sendQueueV6Index = 0;
  state.sendPhase = 'stage1';
  enrichSendQueueSearchUrls();
  await persistState();

  // 从阶段1重跑（按各岗位采集时的搜索 URL 逐页导航）
  try {
    await runStage1AcrossSearchUrls();
  } catch (navErr) {
    state.phase = 'idle'; state.sendPhase = '';
    await persistState();
    chrome.runtime.sendMessage({ type: 'ERROR', phase: 'sending', error: navErr.message || '未找到搜索页面' }).catch(() => {});
    return;
  }
  await sleep(getSendSpeedProfile().postExtractMs);
  state.sendQueueV6 = state.sendQueueV6.filter(function(item) { return item.hrName; });
  try { DiagLogger.info('sw.send', '阶段转换(resume)：stage1 → stage2 queueLen=' + state.sendQueueV6.length); } catch (_) {}
  state.sendPhase = 'stage2';
  await persistState();
  await runStage2();
  // A1：恢复前已建联未发的岗位并入补发队列（runStage2 入口会清空 _v6RepairQueue，故必须在其后并入；按 jobId 去重）
  if (_resumeMissed.length) {
    var _inQ = {};
    (state._v6RepairQueue || []).forEach(function (it) { if (it) _inQ[it.jobId] = true; });
    _resumeMissed.forEach(function (it) { if (!_inQ[it.jobId]) state._v6RepairQueue.push(it); });
  }
  await teardownWorkerWindows();
  await sleep(getSendSpeedProfile().repairSettleMs);
  await runRepairV6();
  await cleanupV6();
  await finishSend();
}

// ════════════════════════════════════════════════════════════════
// pre-flight：投递前关闭 BOSS「自动打招呼」（修复双发）
// 根因：旧逻辑强制开启 BOSS 自动招呼 → 点「立即沟通」BOSS 先发平台模板语，
//       stage2 JobSender.sendText 再发 AI 招呼语 → HR 收到两条。
// 现逻辑：投递前 status=0 关开关，仅扩展发 AI 定制招呼语+简历图；批结束后恢复用户原设置。
// 链路：①读 getGreetingList 记原状态 → ②已关则放行 → ③API 写关+复读 → ④降级 DOM 关
//      ⑤仍关不掉 → 中止并提示用户手动关 BOSS 自动招呼语
// 读失败 = 未知 → 放行（宁可双发风险也不误拦整批）
// ════════════════════════════════════════════════════════════════
const GREETING_PREFLIGHT_TIMEOUT_MS = 20000;
let _greetingSavedBeforeSend = null;

async function ensureGreetingDisabledForSend(searchTabId) {
  _greetingSavedBeforeSend = null;
  try {
    var result = await Promise.race([
      _ensureGreetingDisabledImpl(searchTabId),
      new Promise(function (resolve) {
        setTimeout(function () { resolve({ ok: false, timeout: true }); }, GREETING_PREFLIGHT_TIMEOUT_MS);
      }),
    ]);
    return result || { ok: false };
  } catch (e) {
    try { DiagLogger.warn('sw.greeting', 'pre-flight 关开关异常：' + e.message); } catch (_) {}
    return { ok: false, error: e.message };
  }
}

async function _ensureGreetingDisabledImpl(searchTabId) {
  var read = null;
  try {
    await waitForContentScript(searchTabId);
    read = await chrome.tabs.sendMessage(searchTabId, { type: MSG.CHECK_GREETING_SETTING });
  } catch (e) {
    read = null;
  }
  if (!read || read.success !== true || typeof read.enabled !== 'boolean') {
    try { DiagLogger.warn('sw.greeting', 'pre-flight：开关状态读取失败，放行投递'); } catch (_) {}
    return { ok: true, unknown: true };
  }
  _greetingSavedBeforeSend = { enabled: read.enabled, templateId: read.templateId };
  if (!read.enabled) {
    try { DiagLogger.info('sw.greeting', 'pre-flight：BOSS 自动招呼已关闭，直接放行'); } catch (_) {}
    return { ok: true, alreadyDisabled: true };
  }

  try { DiagLogger.info('sw.greeting', 'pre-flight：关闭 BOSS 自动招呼（避免与 AI 招呼语双发）'); } catch (_) {}
  try {
    var dr = await chrome.tabs.sendMessage(searchTabId, { type: MSG.DISABLE_GREETING_SETTING });
    if (dr && dr.ok && dr.enabled === false) {
      try { DiagLogger.info('sw.greeting', 'pre-flight：API 关闭自动招呼成功'); } catch (_) {}
      return { ok: true, disabled: true };
    }
    try { DiagLogger.warn('sw.greeting', 'pre-flight：API 关闭未确认，走 DOM 降级'); } catch (_) {}
  } catch (e) {
    try { DiagLogger.warn('sw.greeting', 'pre-flight：API 关闭失败，走 DOM 降级 err=' + e.message); } catch (_) {}
  }

  var fb = await _disableGreetingViaSettingsPage(searchTabId);
  if (fb) {
    try { DiagLogger.info('sw.greeting', 'pre-flight：DOM 降级关闭自动招呼成功'); } catch (_) {}
    return { ok: true, disabled: true };
  }
  try { DiagLogger.warn('sw.greeting', 'pre-flight：无法关闭 BOSS 自动招呼，任务中止'); } catch (_) {}
  return { ok: false };
}

async function restoreGreetingSettingAfterSend() {
  if (isPlatformSendMode()) return;
  var saved = _greetingSavedBeforeSend;
  _greetingSavedBeforeSend = null;
  if (!saved || !saved.enabled) return;
  var tabs = await chrome.tabs.query({ url: '*://*.zhipin.com/web/geek/jobs*' });
  var searchTabId = (tabs && tabs[0] && tabs[0].id) || state.searchTabId;
  if (!searchTabId) return;
  try {
    await waitForContentScript(searchTabId);
    await chrome.tabs.sendMessage(searchTabId, {
      type: MSG.ENABLE_GREETING_SETTING,
      templateId: saved.templateId,
    });
    try { DiagLogger.info('sw.greeting', '投递结束：已恢复 BOSS 自动招呼开关'); } catch (_) {}
  } catch (e) {
    try { DiagLogger.warn('sw.greeting', '投递结束：恢复 BOSS 自动招呼失败 ' + e.message); } catch (_) {}
  }
}

async function _disableGreetingViaSettingsPage(searchTabId) {
  var tab = null;
  try {
    try { _diagMarkSelfTabOps(); } catch (_) {}
    tab = await chrome.tabs.create({ url: 'https://www.zhipin.com/web/geek/notify-set', active: false });
    var loaded = false;
    for (var i = 0; i < 32; i++) {
      var t = await chrome.tabs.get(tab.id);
      if (t && t.status === 'complete') { loaded = true; break; }
      await sleep(250);
    }
    if (!loaded) return false;
    var res = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async function () {
        function _slp(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
        async function poll(fn, timeoutMs) {
          var start = Date.now();
          while (Date.now() - start < timeoutMs) {
            var v = fn();
            if (v) return v;
            await _slp(300);
          }
          return null;
        }
        var nav = await poll(function () {
          var lis = document.querySelectorAll('li.nav-list');
          for (var i = 0; i < lis.length; i++) {
            if ((lis[i].textContent || '').indexOf('设置打招呼语') >= 0) return lis[i];
          }
          return null;
        }, 6000);
        if (!nav) return { ok: false, step: 'nav-not-found' };
        nav.click();
        var sw = await poll(function () {
          return document.querySelector('.greeting-header .ui-switch');
        }, 6000);
        if (!sw) return { ok: false, step: 'switch-not-found' };
        if (sw.classList.contains('ui-switch-checked')) sw.click();
        var unchecked = await poll(function () {
          var el = document.querySelector('.greeting-header .ui-switch');
          return el && !el.classList.contains('ui-switch-checked') ? el : null;
        }, 5000);
        return { ok: !!unchecked, step: unchecked ? 'done' : 'still-checked' };
      },
    });
    var r0 = res && res[0] && res[0].result;
    if (!r0 || !r0.ok) return false;
    try {
      var re = await chrome.tabs.sendMessage(searchTabId, { type: MSG.CHECK_GREETING_SETTING });
      return !!(re && re.success && re.enabled === false);
    } catch (_) {
      return true;
    }
  } catch (e) {
    return false;
  } finally {
    if (tab && tab.id) {
      try { chrome.tabs.remove(tab.id); } catch (_) {}
    }
  }
}

// 旧 ensureGreetingEnabled 已废弃（会导致 BOSS 平台招呼语 + AI 招呼语双发）
async function ensureGreetingEnabled(searchTabId) {
  try {
    var result = await Promise.race([
      _ensureGreetingEnabledImpl(searchTabId),
      new Promise(function (resolve) {
        setTimeout(function () { resolve({ ok: false, timeout: true }); }, GREETING_PREFLIGHT_TIMEOUT_MS);
      }),
    ]);
    return result || { ok: false };
  } catch (e) {
    try { DiagLogger.warn('sw.greeting', 'pre-flight 开开关异常：' + e.message); } catch (_) {}
    return { ok: false, error: e.message };
  }
}

async function _ensureGreetingEnabledImpl(searchTabId) {
  var read = null;
  try {
    await waitForContentScript(searchTabId);
    read = await chrome.tabs.sendMessage(searchTabId, { type: MSG.CHECK_GREETING_SETTING });
  } catch (e) {
    read = null;
  }
  if (!read || read.success !== true || typeof read.enabled !== 'boolean') {
    try { DiagLogger.warn('sw.greeting', 'pre-flight：开关状态读取失败，放行投递'); } catch (_) {}
    return { ok: true, unknown: true };
  }
  if (read.enabled) {
    try { DiagLogger.info('sw.greeting', 'pre-flight：打招呼开关已开启，直接放行'); } catch (_) {}
    return { ok: true };
  }

  try { DiagLogger.warn('sw.greeting', 'pre-flight：开关为关，尝试 API 自动开启 templateId=' + read.templateId); } catch (_) {}
  try {
    var wr = await chrome.tabs.sendMessage(searchTabId, {
      type: MSG.ENABLE_GREETING_SETTING,
      templateId: read.templateId,
    });
    if (wr && wr.ok && wr.enabled) {
      try { DiagLogger.info('sw.greeting', 'pre-flight：API 自动开启成功'); } catch (_) {}
      return { ok: true, autoEnabled: true };
    }
  } catch (e) {
    try { DiagLogger.warn('sw.greeting', 'pre-flight：API 开启失败，走降级 err=' + e.message); } catch (_) {}
  }

  var fb = await _enableGreetingViaSettingsPage(searchTabId);
  if (fb) {
    try { DiagLogger.info('sw.greeting', 'pre-flight：降级 DOM 自动开启成功'); } catch (_) {}
    return { ok: true, autoEnabled: true };
  }
  try { DiagLogger.warn('sw.greeting', 'pre-flight：无法开启 BOSS 自动招呼，任务中止'); } catch (_) {}
  return { ok: false };
}

// 降级路径：后台 tab 开 notify-set，executeScript 注入点击「设置打招呼语」面板 + ui-switch。
// notify-set 不在 content_scripts matches 内，只能 scripting.executeScript（权限已有）。
// 每步 poll 元素就绪（不固定 sleep）；成功判据 = DOM ui-switch-checked + getGreetingList 双确认。
async function _enableGreetingViaSettingsPage(searchTabId) {
  var tab = null;
  try {
    try { _diagMarkSelfTabOps(); } catch (_) {} // 扩展自己开/关设置页 tab，别记成用户误操作
    tab = await chrome.tabs.create({ url: 'https://www.zhipin.com/web/geek/notify-set', active: false });
    // 等页面加载完（poll status，最多 8s）
    var loaded = false;
    for (var i = 0; i < 32; i++) {
      var t = await chrome.tabs.get(tab.id);
      if (t && t.status === 'complete') { loaded = true; break; }
      await sleep(250);
    }
    if (!loaded) return false;
    var res = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async function () {
        function _slp(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
        async function poll(fn, timeoutMs) {
          var start = Date.now();
          while (Date.now() - start < timeoutMs) {
            var v = fn();
            if (v) return v;
            await _slp(300);
          }
          return null;
        }
        // ① 切到「设置打招呼语」面板
        var nav = await poll(function () {
          var lis = document.querySelectorAll('li.nav-list');
          for (var i = 0; i < lis.length; i++) {
            if ((lis[i].textContent || '').indexOf('设置打招呼语') >= 0) return lis[i];
          }
          return null;
        }, 6000);
        if (!nav) return { ok: false, step: 'nav-not-found' };
        nav.click();
        // ② 等开关元素出现
        var sw = await poll(function () {
          return document.querySelector('.greeting-header .ui-switch');
        }, 6000);
        if (!sw) return { ok: false, step: 'switch-not-found' };
        // 只在「未开」时点击（绝不把开着的关掉）
        if (!sw.classList.contains('ui-switch-checked')) sw.click();
        // ③ poll 到 checked class 出现（DOM 侧确认）
        var checked = await poll(function () {
          var el = document.querySelector('.greeting-header .ui-switch');
          return el && el.classList.contains('ui-switch-checked') ? el : null;
        }, 5000);
        return { ok: !!checked, step: checked ? 'done' : 'class-not-checked' };
      },
    });
    var r0 = res && res[0] && res[0].result;
    if (!r0 || !r0.ok) {
      try { DiagLogger.warn('sw.greeting', '降级 DOM 点击失败 step=' + ((r0 && r0.step) || '注入无结果')); } catch (_) {}
      return false;
    }
    // ④ getGreetingList 复读双确认（经搜索页 CS）
    try {
      var re = await chrome.tabs.sendMessage(searchTabId, { type: MSG.CHECK_GREETING_SETTING });
      return !!(re && re.success === true && re.enabled === true);
    } catch (e) {
      return false;
    }
  } catch (e) {
    try { DiagLogger.warn('sw.greeting', '降级路径异常：' + e.message); } catch (_) {}
    return false;
  } finally {
    if (tab) { try { await chrome.tabs.remove(tab.id); } catch (e) {} }
  }
}

// 本批是否「免费额度放行」（非会员）。批结束后若本批有成功投递，据此 POST /consume-free 扣额度。
let _batchIsFreeQuota = false;

async function startSendV6(jobIds) {
  await bootRestored;         // 冷启动竞态防护：等 boot-restore 完成再建队列，防止被旧值覆盖

  // ── 商业化付费墙：整批投递开始前查一次权益闸门 ──
  // active(会员) || free_available(免费额度未用完) 才放行整批；都 false 拦截整批。
  // 🔴 网络异常/后端不可达/超时 → checkSendEntitlement 内部已容错放行（不误伤付费用户）。
  const _ent = await checkSendEntitlement();
  try { DiagLogger.info('sw.send', '投递门禁：allow=' + _ent.allow + ' reason=' + _ent.reason); } catch (_) {}
  if (!_ent.allow) {
    try { DiagLogger.warn('sw.send', '任务中止：免费额度已用完且无会员（门禁拦截整批）'); } catch (_) {}
    // 走现有 ERROR 提示通道（START_SEND handler 还会 catch 此 throw 再广播一次，popup 统一展示）
    // 带 errorCode='NO_QUOTA' 标记，popup 据此特殊展示（购买入口），不靠字符串匹配。
    const _noQuotaErr = new Error('免费额度已用完，请到「账户/会员」开通会员后继续投递');
    _noQuotaErr.errorCode = 'NO_QUOTA';
    throw _noQuotaErr;
  }
  _batchIsFreeQuota = !!_ent.free;  // free=true 表示靠免费额度放行（非会员），批末扣额度

  try { DiagLogger.userEvent('sw.send', '任务启动：开始投递 jobs=' + ((jobIds && jobIds.length) || 0) + ' mode=' + (state.sendMode || 'platform') + ' hrActiveFilter=' + (state.hrActiveFilter || '不限')); } catch (_) {}
  sendAborted = false;
  sendStartTime = Date.now();
  await ensureAppliedJobIdsLoaded();
  jobIds = (jobIds || []).filter(function (id) { return id && !appliedJobIds.has(id); });
  if (!jobIds.length) {
    chrome.runtime.sendMessage({ type: 'ERROR', phase: 'sending', error: '所选岗位均已投递过，无需重复投递。如需重投请点 A 页「重置」清空已投递记录。' }).catch(function () {});
    return;
  }
  await loadJobCustomIntoState();
  state.sendQueueV6 = buildSendQueueV6(state, jobIds);
  state.sendQueueV6Index = 0;
  state.sendProgress = { sent: 0, total: jobIds.length };
  state._sendDisplayTotal = jobIds.length;
  state._sendDisplaySentMax = 0;
  _stage1TabProgress = { index: 0, total: 0 };
  state.sendResults = [];
  sentJobIds.clear();
  _dailyCountedJobIds.clear();
  state._v6MissedJobs = [];
  if (!isPlatformSendMode()) {
    dropMissingGreetingJobs();
  }
  enrichSendQueueSearchUrls();
  state.phase = 'sending';
  state.sendPhase = 'stage1';
  await persistState();

  var searchTabs = await chrome.tabs.query({ url: '*://*.zhipin.com/web/geek/jobs*' });
  if (!searchTabs.length) {
    state.phase = 'idle'; state.sendPhase = '';
    await persistState();
    chrome.runtime.sendMessage({ type: 'ERROR', phase: 'sending', error: '未找到BOSS直聘搜索页，请重新发送' }).catch(() => {});
    return;
  }

  if (isPlatformSendMode()) {
    var greetEnable = await ensureGreetingEnabled(searchTabs[0].id);
    if (!greetEnable.ok) {
      state.phase = 'idle'; state.sendPhase = '';
      await persistState();
      try { DiagLogger.warn('sw.greeting', '任务中止：打招呼开关未开启且自动开启失败'); } catch (_) {}
      throw new Error('⚠️ 你的 BOSS『自动打招呼』功能未开启且自动开启失败，请到 BOSS『消息通知→设置打招呼语』手动开启后重试');
    }
    if (greetEnable.autoEnabled) {
      chrome.runtime.sendMessage({ type: MSG.GREETING_AUTO_ENABLED }).catch(() => {});
      try { DiagLogger.userEvent('sw.greeting', '已自动开启 BOSS「自动打招呼」开关（快速投递 pre-flight）'); } catch (_) {}
    }
  } else {
    var greetPre = await ensureGreetingDisabledForSend(searchTabs[0].id);
    if (!greetPre.ok) {
      state.phase = 'idle'; state.sendPhase = '';
      await persistState();
      try { DiagLogger.warn('sw.greeting', '任务中止：无法关闭 BOSS 自动招呼语'); } catch (_) {}
      throw new Error('⚠️ 无法关闭 BOSS『自动打招呼』，会导致平台招呼语与 AI 招呼语重复发送。请到 BOSS「消息通知→设置打招呼语」手动关闭后重试');
    }
    if (greetPre.disabled) {
      chrome.runtime.sendMessage({ type: MSG.GREETING_DISABLED_FOR_SEND }).catch(() => {});
      try { DiagLogger.userEvent('sw.greeting', '投递前已关闭 BOSS 自动招呼（仅发 AI 定制语）'); } catch (_) {}
    }
  }
  if (sendAborted) { console.log('[即投] startSendV6: pre-flight 后检测到停止，退出'); return; }

  console.log('[即投] v6 stage1 开始，模式:', isPlatformSendMode() ? 'platform(快速)' : 'custom(定制)', '队列长度:', state.sendQueueV6.length);
  pushSendProgressDisplay({
    batchSub: '共 ' + getSendDisplayTotal() + ' 个岗位',
    status: isPlatformSendMode() ? '快速投递启动中...' : '定制投递启动中...',
  });

  try {
    await runStage1AcrossSearchUrls();
  } catch (navErr) {
    state.phase = 'idle'; state.sendPhase = '';
    await persistState();
    chrome.runtime.sendMessage({ type: 'ERROR', phase: 'sending', error: navErr.message || '未找到BOSS直聘搜索页，请重新发送' }).catch(() => {});
    return;
  }

  console.log('[即投] v6 stage1 全部完成，提取成功:', state.sendQueueV6.filter(function(item) { return item.hrName; }).length);

  // 硬中止：stage1 期间被停 → stopSend 已置终态并清场，这里直接退出，不再进 stage2
  if (sendAborted) { console.log('[即投] startSendV6: stage1 后检测到停止，退出'); return; }

  await sleep(getSendSpeedProfile().postExtractMs);

  processStage1ExtractFailures();
  processStage1AlreadyChatted();

  if (isPlatformSendMode()) {
    if (!state.sendQueueV6.length && !state.sendResults.some(function (r) { return r.success; })) {
      await finalizeTask('done');
      return;
    }
    if (sendAborted) { console.log('[即投] startSendV6: platform 模式收尾前检测到停止，退出'); return; }
    try { DiagLogger.info('sw.send', 'platform 模式：stage1 完成，跳过 stage2，成功建联 ' + state.sendQueueV6.length + ' 岗'); } catch (_) {}
    await finishPlatformSendAfterStage1();
    return;
  }

  if (!state.sendQueueV6.length) {
    await finalizeTask('done');
    return;
  }

  if (sendAborted) { console.log('[即投] startSendV6: 进 stage2 前检测到停止，退出'); return; }

  try { DiagLogger.info('sw.send', '阶段转换：stage1 → stage2 queueLen=' + state.sendQueueV6.length); } catch (_) {}
  state.sendPhase = 'stage2';
  pushSendProgressDisplay({ batchSub: 'Stage2：正在发送定制招呼语与简历图' });
  await persistState();
  await runStage2();
  if (sendAborted) { console.log('[即投] startSendV6: stage2 后检测到停止，退出'); return; }
  await teardownWorkerWindows();
  await sleep(getSendSpeedProfile().repairSettleMs);
  if (sendAborted) { console.log('[即投] startSendV6: 补发前检测到停止，退出'); return; }
  await runRepairV6();   // 补发阶段：全新单 tab、单 WS 连接，逐个核对并补漏
  await cleanupV6();
  await finishSend();
}

async function runStage1() {
  // 等待搜索 tab 就绪
  console.log('[即投] runStage1: waitForContentScript tabId=', state.searchTabId);
  await waitForContentScript(state.searchTabId);
  console.log('[即投] runStage1: 搜索 tab CS 就绪，发送 DO_BATCH_EXTRACT');

  // #39 跳转恢复：重置本轮恢复状态 + 记录搜索页 URL（goBack 失败时兜底直跳）
  state._stage1InFlight = null;
  _stage1DoneJobIds.clear();
  _stage1SentQueue = null;
  _stage1RecoveryCount = 0;
  _stage1RecoveryActive = false;
  try {
    var _sTab = await chrome.tabs.get(state.searchTabId);
    if (_sTab && _sTab.url) state._stage1SearchUrl = _sTab.url;
  } catch (eUrl) {
    try { DiagLogger.warn('sw.flow', '[#39恢复] 记录搜索页 URL 失败（goBack 兜底将不可用）: ' + eUrl.message); } catch (_) {}
  }

  return new Promise(function(resolve, reject) {
    var timedOut = false;
    var settled = false;
    // 超时保护：2 分钟（20 岗位 × ~2s + 余量）。#39：恢复环每次重发剩余队列后 re-arm，
    // 否则多段完成的长任务会被首段超时误杀。
    var timeout = null;
    var armTimeout = function() {
      clearTimeout(timeout);
      var pendingN = 20;
      try {
        var slice = getStage1QueueSlice();
        pendingN = (slice && slice.length) || (state.sendQueueV6 && state.sendQueueV6.length) || 20;
      } catch (_) {}
      var timeoutMs = isPlatformSendMode()
        ? Math.min(Math.max(pendingN * 4000 + 45000, CONFIG.CONVERSATION_TIMEOUT_MS * 20), 900000)
        : CONFIG.CONVERSATION_TIMEOUT_MS * 20;
      timeout = setTimeout(function() {
        timedOut = true;
        settled = true;
        abortStage1 = null;
        _stage1ResendQueue = null;
        _stage1ForceSettle = null;
        chrome.runtime.onMessage.removeListener(handler);
        reject(new Error('runStage1 超时：' + timeoutMs + 'ms 内未收到 EXTRACT_COMPLETE'));
      }, timeoutMs);
    };
    armTimeout();

    // #39 恢复环钩子①：重发剩余队列切片（恢复序列 e 步调用），同时重置总超时
    _stage1ResendQueue = function(slice) {
      if (settled || timedOut) return false;
      armTimeout();
      // 注意：不重置 _stage1SentQueue——基准恒为首次发出的原始队列，重发切片由 done 集合过滤得出
      chrome.tabs.sendMessage(state.searchTabId, {
        type: MSG.DO_BATCH_EXTRACT,
        queue: slice,
        hrActiveFilter: state.hrActiveFilter || '不限',
        fastMode: isPlatformSendMode() ? false : getSendSpeedProfile().batchFastMode,
        platformGreeting: isPlatformSendMode(),
        sendResumeImage: !!state.sendResumeImage,
      }).catch(function(err) {
        try { DiagLogger.warn('sw.flow', '[#39恢复] 重发 DO_BATCH_EXTRACT 失败: ' + err.message); } catch (_) {}
        if (typeof _stage1ForceSettle === 'function') _stage1ForceSettle('重发失败:' + err.message);
      });
      return true;
    };

    // #39 恢复环钩子②：恢复不能续时强制了结 stage1——resolve 让 startSendV6 继续走，
    // itemDone 已落账的岗保留 hrName 进 stage2，其余岗汇入现有 !hrName 失败记账/finalizeTask 终态。
    _stage1ForceSettle = function(reason) {
      if (settled) return;
      settled = true;
      timedOut = true; // 复用闸门，阻止 in-flight handler 再处理
      clearTimeout(timeout);
      abortStage1 = null;
      _stage1ResendQueue = null;
      _stage1ForceSettle = null;
      chrome.runtime.onMessage.removeListener(handler);
      try { DiagLogger.warn('sw.flow', '[#39恢复] 强制了结 stage1（汇入现有终态路径）reason=' + reason); } catch (_) {}
      resolve();
    };

    // 硬中止挂钩：stopSend 调用此函数即让 stage1 立刻 resolve 走终态（不等 120s 超时）
    abortStage1 = function() {
      if (settled) return;
      settled = true;
      timedOut = true; // 复用 timedOut 闸门，阻止 in-flight 的 handler 再处理
      clearTimeout(timeout);
      abortStage1 = null;
      _stage1ResendQueue = null;
      _stage1ForceSettle = null;
      chrome.runtime.onMessage.removeListener(handler);
      console.log('[即投] runStage1: 被 stopSend 中止，立即了结');
      resolve();
    };

    var handler = function(msg, sender) {
      if (msg.type === MSG.EXTRACT_COMPLETE && sender.tab && sender.tab.id === state.searchTabId) {
        if (timedOut) return;
        settled = true;
        abortStage1 = null;
        _stage1ResendQueue = null;
        _stage1ForceSettle = null;
        clearTimeout(timeout);
        chrome.runtime.onMessage.removeListener(handler);
        console.log('[即投] runStage1: 收到 EXTRACT_COMPLETE，results:', (msg.results || []).length);
        if (msg.success) {
          for (var i = 0; i < msg.results.length; i++) {
            var r = msg.results[i];
            _stage1DoneJobIds.add(r.jobId); // #39：兜底 itemDone 丢失（SW 冷启动竞态等）
            var item = state.sendQueueV6.find(function(q) { return q.jobId === r.jobId; });
            if (item) {
              item.hrName = r.hrName;
              item.hrCompany = r.hrCompany;
              item.alreadyChatted = !!r.alreadyChatted;
            }
          }
          // HR 活跃不符的跳过项：从发送队列剔除（不进 stage2）+ 记一条「未投递」结果
          var _skipped = msg.skipped || [];
          for (var sk = 0; sk < _skipped.length; sk++) {
            var _s = _skipped[sk];
            var _idx = state.sendQueueV6.findIndex(function(q) { return q.jobId === _s.jobId; });
            var _qit = _idx >= 0 ? state.sendQueueV6[_idx] : null;
            sentJobIds.add(_s.jobId);
            state.sendProgress.sent++;
            state.sendResults.push({
              jobId: _s.jobId,
              positionName: _qit ? _qit.positionName : '',
              companyName: _qit ? _qit.companyName : '',
              success: false, skipped: true,
              error: '未投递：HR活跃不符' + (_s.activeDesc ? '（' + _s.activeDesc + '）' : ''),
              time: Date.now()
            });
            if (_idx >= 0) state.sendQueueV6.splice(_idx, 1);
          }
          // 提取失败项：暂存本批原因供终态记账，但不写 extractError（多搜索 URL / 详情页降级还要重试）
          var _failed = msg.failed || [];
          for (var fl = 0; fl < _failed.length; fl++) {
            var _f = _failed[fl];
            var _fItem = state.sendQueueV6.find(function(q) { return q.jobId === _f.jobId; });
            if (_fItem && !_fItem.hrName) _fItem._lastBatchError = _f.error;
          }
          pushState();
        }
        resolve();
      } else if (msg.type === MSG.EXTRACT_PROGRESS && sender.tab && sender.tab.id === state.searchTabId) {
        // #39：带 stage 字段 = 跳转恢复专用进度（beforeClick/itemDone）；无 stage = 老用法进度展示。
        // 两种用法严格分流，互不影响。
        if (msg.stage === 'beforeClick') {
          // 点「立即沟通」前快照：BOSS 整页跳转摧毁 CS 时，恢复环据此把该岗记建联成功
          state._stage1InFlight = {
            index: msg.index, jobId: msg.jobId, jobName: msg.jobName,
            hrName: msg.hrName, hrCompany: msg.hrCompany, ts: Date.now()
          };
        } else if (msg.stage === 'itemDone') {
          _stage1DoneJobIds.add(msg.jobId);
          if (state._stage1InFlight && state._stage1InFlight.jobId === msg.jobId) state._stage1InFlight = null;
          var _pItem = state.sendQueueV6.find(function(q) { return q.jobId === msg.jobId; });
          if (msg.success && _pItem) {
            _pItem.hrName = msg.hrName || _pItem.hrName;
            _pItem.hrCompany = msg.hrCompany || _pItem.hrCompany;
            _pItem.alreadyChatted = !!msg.alreadyChatted;
            if (isPlatformSendMode() && _pItem.hrName && !sentJobIds.has(_pItem.jobId)) {
              recordV6Success(_pItem);
            }
            pushSendProgressDisplay({
              batchSub: formatStage1BatchSub({ jobName: _pItem.positionName || '' }),
            });
          }
        } else {
          // 老用法 {done,total,extracted}：只更新副标题批次进度，主进度条 sent/total 保持全局
          pushSendProgressDisplay({
            batchSub: formatStage1BatchSub({
              done: msg.done,
              total: msg.total,
              jobName: msg.jobName || '',
            }),
          });
        }
      }
    };
    chrome.runtime.onMessage.addListener(handler);

    var doSend = function(retryCount) {
      retryCount = retryCount || 0;
      var queueSlice = getStage1QueueSlice();
      if (!queueSlice.length) {
        if (!settled) {
          settled = true;
          abortStage1 = null;
          _stage1ResendQueue = null;
          _stage1ForceSettle = null;
          clearTimeout(timeout);
          chrome.runtime.onMessage.removeListener(handler);
          resolve();
        }
        return;
      }
      if (!_stage1SentQueue) _stage1SentQueue = queueSlice;
      chrome.tabs.sendMessage(state.searchTabId, {
        type: MSG.DO_BATCH_EXTRACT,
        queue: queueSlice,
        hrActiveFilter: state.hrActiveFilter || '不限',
        fastMode: isPlatformSendMode() ? false : getSendSpeedProfile().batchFastMode,
        platformGreeting: isPlatformSendMode(),
        sendResumeImage: !!state.sendResumeImage,
      }).catch(function(err) {
        if (timedOut || settled) return;
        var isBFCache = err.message.includes('back/forward cache') || err.message.includes('message channel') || err.message.includes('port') || err.message.includes('Receiving end does not exist');
        if (retryCount < 5 && isBFCache) {
          console.warn('[即投] runStage1: BFCache/port closed, 重试 ' + (retryCount + 1) + '/5, 重新激活 tab');
          chrome.tabs.update(state.searchTabId, { active: true }).then(function() {
            setTimeout(function() { doSend(retryCount + 1); }, 1500);
          }).catch(function() {
            setTimeout(function() { doSend(retryCount + 1); }, 1500);
          });
          return;
        }
        settled = true;
        abortStage1 = null;
        _stage1ResendQueue = null;
        _stage1ForceSettle = null;
        clearTimeout(timeout);
        chrome.runtime.onMessage.removeListener(handler);
        console.error('[即投] runStage1: sendMessage 最终失败', err.message);
        reject(new Error('无法向搜索页发送提取指令: ' + err.message));
      });
    };

    // 先尝试激活 tab（防止 BFCache），再发送
    chrome.tabs.update(state.searchTabId, { active: true }).then(function() {
      setTimeout(function() { doSend(0); }, 1500);
    }).catch(function() {
      setTimeout(function() { doSend(0); }, 500);
    });
  });
}

// ════════════════════════════════════════════════════════════════
// #39 阶段1跳转恢复环——跳转检测 + 恢复序列
// 状态机：搜索页被 BOSS 整页跳到 /web/geek/chat（仅阶段1活跃 + 主框架导航才触发）
//   → a.等消息页 CS 就绪 → b.点「沟通新职位」确认弹窗 → c.该岗按建联成功落账
//   → d.goBack 回搜索页等 CS 就绪 → e.重发剩余队列（runStage1 的 pending promise
//   全程不动，最终段 EXTRACT_COMPLETE 正常 resolve；恢复环可重复触发，上限 30 次）。
//   任何一步失败：该岗记失败（extractError，汇入现有 !hrName 失败记账），能续则续，
//   不能续 _stage1ForceSettle 强制了结 → startSendV6 继续走现有 finalizeTask 终态。绝不挂死。
// ════════════════════════════════════════════════════════════════
chrome.tabs.onUpdated.addListener(function (tabId, changeInfo) {
  try {
    if (!changeInfo || !changeInfo.url) return;                              // 只认主框架导航
    if (state.phase !== 'sending' || state.sendPhase !== 'stage1') return;   // 阶段1活跃前置守卫
    if (tabId !== state.searchTabId) return;
    if (changeInfo.url.indexOf('/web/geek/chat') < 0) return;
    if (_stage1RecoveryActive) {
      try { DiagLogger.info('sw.flow', '[#39恢复] 恢复进行中，忽略重复跳转事件 tab=' + tabId); } catch (_) {}
      return;
    }
    _stage1RecoveryActive = true;
    _runStage1Recovery(tabId).catch(function (e) {
      try { DiagLogger.warn('sw.flow', '[#39恢复] 恢复序列未捕获异常: ' + e.message); } catch (_) {}
      if (typeof _stage1ForceSettle === 'function') _stage1ForceSettle('未捕获异常:' + e.message);
    }).finally(function () { _stage1RecoveryActive = false; });
  } catch (_) {}
});

async function _runStage1Recovery(tabId) {
  var inFlight = state._stage1InFlight;
  var step = 'a';
  _stage1RecoveryCount++;
  try {
    DiagLogger.info('sw.flow', '[#39恢复] 检测到搜索页被跳转到消息页，触发恢复 #' + _stage1RecoveryCount
      + ' tab=' + tabId + ' inFlight=' + (inFlight ? (inFlight.jobId + '/' + (inFlight.jobName || '')) : '无'));
  } catch (_) {}

  // 该岗记失败：挂 extractError，由 startSendV6 现有 !hrName 过滤统一记入 sendResults（防双记账）
  function markInFlightFailed(reason) {
    if (!inFlight) {
      // beforeClick 丢失（如 SW 冷启动竞态）：无法定位触发岗，留痕后按 done 集合重发全部未完成项
      try { DiagLogger.warn('sw.flow', '[#39恢复] beforeClick缺失，无法定位触发岗，按done集合重发全部未完成项'); } catch (_) {}
      return;
    }
    var it = state.sendQueueV6.find(function (q) { return q.jobId === inFlight.jobId; });
    if (it && !it.hrName) it.extractError = reason;
    state._stage1InFlight = null;
  }

  if (_stage1RecoveryCount > STAGE1_RECOVERY_MAX) {
    try { DiagLogger.warn('sw.flow', '[#39恢复] 超过恢复次数上限 ' + STAGE1_RECOVERY_MAX + '，强制了结 stage1'); } catch (_) {}
    markInFlightFailed('[#39恢复] 超过恢复次数上限');
    if (typeof _stage1ForceSettle === 'function') _stage1ForceSettle('恢复次数超限(' + STAGE1_RECOVERY_MAX + ')');
    return;
  }

  // 停止语义：每步之间查 sendAborted——用户点停止时 stopSend 已调 abortStage1 走现有停止路径，恢复立即中断
  if (sendAborted) {
    try { DiagLogger.info('sw.flow', '[#39恢复] 检测到停止标记，中断恢复走现有停止路径'); } catch (_) {}
    return;
  }

  var confirmed = false;
  try {
    // ── a. 等消息页 CS 就绪（PING 握手 3s × 5 次 ≈ 15s 上限，复用 runStage1 同款探测） ──
    step = 'a';
    await waitForContentScript(tabId, 3000, 5);
    try { DiagLogger.info('sw.flow', '[#39恢复] a.消息页 CS 就绪'); } catch (_) {}
    if (sendAborted) { try { DiagLogger.info('sw.flow', '[#39恢复] a 后检测到停止，中断恢复'); } catch (_) {} return; }

    // ── b. 点「沟通新职位」确认弹窗（CS 内部轮询最多 8s，SW 侧 12s 兜底） ──
    step = 'b';
    await chrome.tabs.update(tabId, { active: true });
    await sleep(300);
    var resp = await Promise.race([
      sendTabMessageWithBFCacheRetry(tabId, { type: MSG.CONFIRM_CHANGE_JOB_DIALOG }, 3),
      new Promise(function (resolve) { setTimeout(function () { resolve({ clicked: false, reason: 'SW侧12s超时' }); }, 12000); })
    ]);
    if (resp && resp.clicked) {
      try { DiagLogger.info('sw.flow', '[#39恢复] b.确认弹窗已点击'); } catch (_) {}
    } else {
      // 弹窗可能已被用户手点/自己消失，warn 留痕后照常走 c
      try { DiagLogger.warn('sw.flow', '[#39恢复] b.确认弹窗未点到（继续走落账）reason=' + ((resp && resp.reason) || '无响应')); } catch (_) {}
    }
    confirmed = true;
  } catch (eAB) {
    try { DiagLogger.warn('sw.flow', '[#39恢复] 第' + step + '步失败: ' + eAB.message + '（该岗记失败，继续回搜索页续投）'); } catch (_) {}
    markInFlightFailed('[#39恢复] 第' + step + '步失败:' + eAB.message);
    if (state._stage1PerJobMode && typeof _stage1PerJobWaiter === 'object' && _stage1PerJobWaiter && typeof _stage1PerJobWaiter.resolve === 'function') {
      _stage1PerJobWaiter.resolve();
      _stage1PerJobWaiter = null;
    }
  }

  // ── c. 该岗按建联成功落账（与 EXTRACT_COMPLETE 成功路径同字段：hrName/hrCompany/alreadyChatted） ──
  if (confirmed && inFlight) {
    step = 'c';
    var item = state.sendQueueV6.find(function (q) { return q.jobId === inFlight.jobId; });
    if (item) {
      item.hrName = inFlight.hrName || item.hrName || '';
      item.hrCompany = inFlight.hrCompany || item.hrCompany || '';
      item.alreadyChatted = false;
      pushState();
      try { DiagLogger.info('sw.flow', '[#39恢复] c.岗位落账建联成功 jobId=' + inFlight.jobId + ' hr=' + (item.hrName || '?') + '（stage2 正常发消息）'); } catch (_) {}
    } else {
      try { DiagLogger.warn('sw.flow', '[#39恢复] c.队列中未找到 jobId=' + inFlight.jobId + '，跳过落账'); } catch (_) {}
    }
    state._stage1InFlight = null;
  } else if (!inFlight) {
    try { DiagLogger.warn('sw.flow', '[#39恢复] 无 inFlight 快照（跳转非点击引发？），跳过落账直接回搜索页'); } catch (_) {}
  }

  if (sendAborted) { try { DiagLogger.info('sw.flow', '[#39恢复] c 后检测到停止，中断恢复'); } catch (_) {} return; }

  // per-job 详情页模式：落账后直接放行单岗等待，SW 自行导航下一岗详情页
  if (state._stage1PerJobMode) {
    if (typeof _stage1PerJobWaiter === 'object' && _stage1PerJobWaiter && typeof _stage1PerJobWaiter.resolve === 'function') {
      try { DiagLogger.info('sw.flow', '[#39恢复] per-job模式恢复完成，继续下一岗'); } catch (_) {}
      _stage1PerJobWaiter.resolve();
      _stage1PerJobWaiter = null;
    }
    return;
  }

  try {
    // ── d. 回搜索页：goBack 优先，失败兜底直跳记录的搜索页 URL，再等 CS 就绪（≤15s） ──
    step = 'd';
    try {
      await chrome.tabs.goBack(tabId);
      try { DiagLogger.info('sw.flow', '[#39恢复] d.goBack 回搜索页'); } catch (_) {}
    } catch (eBack) {
      if (!state._stage1SearchUrl) throw new Error('goBack 失败且无记录的搜索页 URL: ' + eBack.message);
      try { DiagLogger.warn('sw.flow', '[#39恢复] d.goBack 失败(' + eBack.message + ')，改 tabs.update 直跳搜索页'); } catch (_) {}
      await chrome.tabs.update(tabId, { url: state._stage1SearchUrl });
    }
    try { await waitForTabLoad(tabId, 10000); } catch (eLoad) { /* BFCache 秒回可能不触发 complete，靠下方 PING 兜底 */ }
    await waitForContentScript(tabId, 3000, 5);
    try { DiagLogger.info('sw.flow', '[#39恢复] d.搜索页 CS 就绪'); } catch (_) {}

    if (sendAborted) { try { DiagLogger.info('sw.flow', '[#39恢复] d 后检测到停止，中断恢复'); } catch (_) {} return; }

    // ── e. 重发剩余队列：原始全段按 done 集合过滤（jobId 基准，免疫 splice/多段下标错位），恢复环对新段继续生效 ──
    // inFlight 那岗已在 c 步落账（成功或 extractError），排除；inFlight=null（beforeClick 丢失）时不排除——
    // 撞跳转那岗会被重发，回搜索页后按钮已变「继续沟通」，CS 侧 alreadyChatted 预判接住，安全。
    step = 'e';
    var _inFlightJobId = inFlight ? inFlight.jobId : null;
    var sentQ = _stage1SentQueue || state.sendQueueV6;
    var slice = sentQ.filter(function (it) {
      return it && !_stage1DoneJobIds.has(it.jobId) && it.jobId !== _inFlightJobId;
    });
    if (!slice.length) {
      // 队列已尽：本段没有 EXTRACT_COMPLETE 了，直接了结（itemDone/c 已逐岗落账，合并语义与单段一致）
      try { DiagLogger.info('sw.flow', '[#39恢复] e.剩余队列为空，stage1 多段聚合完成'); } catch (_) {}
      if (typeof _stage1ForceSettle === 'function') _stage1ForceSettle('恢复后剩余队列为空，正常完成');
      return;
    }
    if (typeof _stage1ResendQueue === 'function' && _stage1ResendQueue(slice)) {
      try { DiagLogger.info('sw.flow', '[#39恢复] e.重发剩余 ' + slice.length + ' 岗 DO_BATCH_EXTRACT（总超时已重置，恢复环继续生效）'); } catch (_) {}
    } else {
      try { DiagLogger.warn('sw.flow', '[#39恢复] e.stage1 已 settle（停止/超时），不再重发'); } catch (_) {}
    }
  } catch (eDE) {
    try { DiagLogger.warn('sw.flow', '[#39恢复] 第' + step + '步失败: ' + eDE.message + '，强制了结 stage1 走现有终态'); } catch (_) {}
    markInFlightFailed('[#39恢复] 第' + step + '步失败:' + eDE.message);
    if (typeof _stage1ForceSettle === 'function') _stage1ForceSettle('第' + step + '步失败:' + eDE.message);
  }
}

async function runStage2() {
  console.log('[即投] runStage2: 开始，队列长度=', state.sendQueueV6.length);
  if (!chrome.alarms) {
    console.error('[即投] runStage2: chrome.alarms 不可用！请在 manifest.json permissions 添加 "alarms"');
  }
  var workerCount = Math.min(getSendSpeedProfile().workerCount, state.sendQueueV6.length);
  console.log('[即投] runStage2: 创建', workerCount, '个 worker tab', getSendSpeedProfile().fast ? '(快速模式)' : '');
  // ② 0-WS 起步防泄漏：上一批若有未关干净的 worker/补发窗口（cleanup 失败或异常），
  //    先强关，避免本批叠加旧 WS 连接。正常路径下 cleanupV6 已关，这里只是兜底。
  if (state._v6WorkerWindowIds && state._v6WorkerWindowIds.length) {
    for (var lw = 0; lw < state._v6WorkerWindowIds.length; lw++) {
      try { await chrome.windows.remove(state._v6WorkerWindowIds[lw]); } catch (e) {}
    }
  }
  state._v6WorkerTabIds = [];
  state._v6WorkerWindowIds = [];
  state._v6WorkerTabsReady.clear();
  state._v6RepairQueue = [];

  // 创建 worker tab —— 每个放进独立的后台窗口
  // 根因：worker tab 处 hidden 状态时 BOSS WS 行为异常，多 hidden tab 同跑 → WS 重连风暴丢帧卡 loading。
  // 独立窗口的活跃 tab 即使窗口非焦点也保持 visibilityState='visible'、不被节流、WS 正常。
  // focused:false 不抢用户焦点；绝不能 minimized（minimized → hidden → WS 又坏），state 用 'normal'。
  for (var i = 0; i < workerCount; i++) {
    // 大尺寸（1280×800）减少被主窗遮挡致 visibilityState='hidden'→WS 风暴的概率
    // （wsProbe.dump 实证 worker 窗 2/3 为 hidden，是漏发主因）。focused:false 不抢焦点。
    var win = await chrome.windows.create({
      url: 'https://www.zhipin.com/web/geek/chat',
      focused: false,
      state: 'normal',
      width: 1280,
      height: 800,
    });
    if (win && win.id != null) state._v6WorkerWindowIds.push(win.id);
    var workerTab = win && win.tabs && win.tabs[0];
    if (workerTab && workerTab.id != null) state._v6WorkerTabIds.push(workerTab.id);
  }
  try { DiagLogger.info('sw.send', 'stage2 worker 窗口已创建 tabs=' + JSON.stringify(state._v6WorkerTabIds)); } catch (_) {}

  // 等所有 worker CS 就绪（超时 10s）
  await new Promise(function(resolve) {
    var check = function() {
      if (state._v6WorkerTabsReady.size >= workerCount) { resolve(); return; }
      if (state.phase !== 'sending') { resolve(); return; }
      setTimeout(check, 500);
    };
    setTimeout(function() { resolve(); }, 10000); // 超时保护
    setTimeout(check, 500);
  });

  if (state.phase !== 'sending') return;

  // 启动所有 worker loop
  var workers = state._v6WorkerTabIds.map(function(tabId) { return runWorkerLoop(tabId); });
  await Promise.allSettled(workers);
}

async function runWorkerLoop(tabId) {
  // 启动该 worker 的 keepalive 心跳（chrome.alarms 已在外层注册）
  startWorkerKeepalive(tabId);
  try {
    while (state.phase === 'sending' && state.sendPhase === 'stage2') {
      if (sendAborted) break; // 硬中止：停止后不再认领/处理任何岗位
      var job = claimNextJob(state);
      if (!job) {
        try { await chrome.tabs.sendMessage(tabId, { type: MSG.QUEUE_EMPTY }); } catch(e) {}
        break;
      }

      // ⏱️ 删：await chrome.tabs.update(tabId, { active: true }) — 抢前台破坏并行
      // ⏱️ 删：await sleep(800) — 配套 activate 的等待也删
      // 后台 tab 由 chrome.alarms keepalive + filling 时 textContent 直填保证可发

      try {
        if (sendAborted) break; // 认领后、发起前再查一次，停了立即 bail 不发任何消息
        // 步骤1: 找对话并点击（CS 内部 .click() 触发 Vue 2 导航）
        var findResp = await chrome.tabs.sendMessage(tabId, { type: MSG.WORKER_ACTIVATE, job: job });
        // 投递错位止血 #3：activate 失败（含兜底命中身份断言失败/无法核验）一律不发、不标成功，转补发。
        // findResp.success 已被 CS 端身份断言收口（fallback 未过即 success:false + identityAssertFailed），
        // 故 WORKER_SEND 不会发起、recordV6Success 不可能被触达 → 杜绝同名错投 + 误报成功。
        if (!findResp || !findResp.success) {
          await recordV6Failure(job, (findResp && findResp.error) || '未找到对话', findResp && findResp.identityAssertFailed ? 'identityAssert' : 'findConv');
          // 第一性校验：worker tab 未确认完整即入补发队列。storm 下 worker tab 的对话列表
          // 常加载失败（「对话列表容器未加载」），但进安静的补发 tab（单连接）往往能加载成功。
          // 补发 tab 仍找不到才真放弃（repairSingle 回 foundConv:false）。
          state._v6RepairQueue.push(job);
          continue;
        }

        // ⏱️ 保留：1500ms 给路由后 chat-input 渲染完成（后台 tab 节流余量）
        await sleep(1500);

        if (sendAborted) break; // 发文/发图前最后一道闸：停了不发任何消息
        // 步骤2: 发送招呼语+简历
        var sendResp = await chrome.tabs.sendMessage(tabId, { type: MSG.WORKER_SEND, job: job });
        if (sendResp && sendResp.success) {
          await recordV6Success(job);
        } else {
          // sendImage 失败被 CS 吞掉不报错，故 sendResp 失败几乎都来自 sendText/发送确认。
          // 用 skipped/error 区分 stage：skipped:'image' → sendImage 阶段，否则 sendText。
          var sendStage = (sendResp && sendResp.skipped === 'image') ? 'sendImage' : 'sendText';
          await recordV6Failure(job, (sendResp && sendResp.error) || '发送失败', sendStage);
          // 第一性校验：内容未确认送达 → 入补发队列，补发阶段单连接重试。
          state._v6RepairQueue.push(job);
        }
      } catch(e) {
        await recordV6Failure(job, 'Worker通信失败: ' + e.message, 'worker_comm');
        // 第一性校验：通信失败＝未确认完整 → 入补发队列。
        state._v6RepairQueue.push(job);
      }

      if (state.phase === 'captcha_paused') break;
      await sleep(randBetween(200, 900)); // ⏱️ 循环节流 + 随机化破等距节奏（下限=原200永不变快）
    }
  } finally {
    stopWorkerKeepalive(tabId);
  }

  // 不再自动关闭 worker tab，确保消息有充足时间发送完毕
}

// ── 补发阶段：用一个全新的沟通页（单 tab = 单 WS 连接，避开旧 worker tab 的滞后显示
//    与多连接风暴）逐个核对漏发的岗位，缺招呼语/图片就补。最多 2 轮收敛。──
async function runRepairV6() {
  if (state.phase !== 'sending') return;
  var queue = (state._v6RepairQueue || []).slice();
  if (!queue.length) {
    console.log('[即投] runRepairV6: 无待补发岗位，跳过');
    return;
  }
  console.log('[即投] runRepairV6: 待补发', queue.length, '个岗位');

  // 开一个全新的后台沟通页
  var repairTabId = null, repairWinId = null;
  try {
    // 大尺寸（1280×800）跟 worker 窗形态一致，让用户感知到「补发还在跑、不是结束了」。
    // 仍 focused:false 不抢焦点；state:'normal' 不全屏（避免 minimized→hidden 致 WS 坏的反向问题）。
    var win = await chrome.windows.create({
      url: 'https://www.zhipin.com/web/geek/chat',
      focused: false, state: 'normal', width: 1280, height: 800,
    });
    if (win && win.id != null) {
      repairWinId = win.id;
      // 纳入追踪：runRepairV6 自己会在结尾关掉它；万一中途抛错没关，cleanupV6/stopSend 兜底关，
      // 不让补发窗口的 WS 泄漏到下一批。
      if (state._v6WorkerWindowIds) state._v6WorkerWindowIds.push(win.id);
    }
    if (win && win.tabs && win.tabs[0] && win.tabs[0].id != null) repairTabId = win.tabs[0].id;
  } catch (e) {
    try { await ErrorLogger.logError('[repair] 开补发tab失败: ' + (e && e.message), '', 'repair.diag'); } catch (e2) {}
  }
  if (repairTabId == null) return;

  // 等补发 tab CS 就绪（它也发 CS_READY role=worker，加入 _v6WorkerTabsReady）
  await new Promise(function (resolve) {
    var deadline = Date.now() + 15000;
    var check = function () {
      if (state._v6WorkerTabsReady.has(repairTabId)) return resolve();
      if (state.phase !== 'sending' || Date.now() > deadline) return resolve();
      setTimeout(check, 300);
    };
    setTimeout(check, 500);
  });

  // 串行补发，最多 2 轮收敛
  for (var pass = 0; pass < 2 && queue.length; pass++) {
    var still = [];
    for (var i = 0; i < queue.length; i++) {
      if (state.phase !== 'sending') break;
      var job = queue[i];
      var resp = null;
      try {
        resp = await chrome.tabs.sendMessage(repairTabId, { type: MSG.WORKER_REPAIR, job: job });
        // resp===undefined ≠ 通信失败（那会 throw）。是补发 tab 的 CS 收到了消息但没回 response，
        // 几乎一定是补发 tab 跑旧版本 CS（MSG.WORKER_REPAIR 未定义→case 不命中→未 return true）。
        // 显式标注，避免下次又看到裸 {complete:false} 不知所以。
        if (resp === undefined) {
          resp = { complete: false, foundConv: false, error: '补发tab无响应(疑似CS旧版本/未注入WORKER_REPAIR)' };
        }
      } catch (e) {
        resp = { complete: false, error: 'repair通信失败: ' + (e && e.message) };
      }
      await applyRepairResult(job, resp, pass + 1);
      // foundConv=false（对话没建起来）→ 补不了，不再重试；其余未补全的进下一轮
      if (!(resp && resp.complete) && !(resp && resp.foundConv === false)) {
        still.push(job);
      }
      await sleep(800); // 串行节流
    }
    queue = still;
  }

  state._v6RepairQueue = [];
  // 关补发窗口，并从追踪数组移除（否则 cleanupV6 的 teardown 会对已关窗口空跑一次 1.5s）
  try { if (repairWinId != null) await chrome.windows.remove(repairWinId); } catch (e) {}
  try { if (repairTabId != null) await chrome.tabs.remove(repairTabId); } catch (e) {}
  if (repairWinId != null && state._v6WorkerWindowIds) {
    state._v6WorkerWindowIds = state._v6WorkerWindowIds.filter(function (id) { return id !== repairWinId; });
  }
  if (repairTabId != null) state._v6WorkerTabsReady.delete(repairTabId);
}

// 把补发结果回写到 sendResults：真补全了就把该岗位翻成成功（内容确实送达了，非显示规则改动）。
async function applyRepairResult(job, resp, pass) {
  var ok = !!(resp && resp.complete);
  var _found = false;
  for (var i = state.sendResults.length - 1; i >= 0; i--) {
    if (state.sendResults[i].jobId === job.jobId) {
      _found = true;
      sentJobIds.add(job.jobId); // 幂等：worker 失败路径本就已加；漏发补发路径靠这行防 SW 死后 resume 重建队列双发
      if (ok) {
        markJobApplied(job.jobId);
        incrementDailySendCount(job.jobId);
      }
      state.sendResults[i].success = ok;
      state.sendResults[i].repaired = true;
      if (ok) {
        state.sendResults[i].error = null;
        state.sendResults[i].stage = null;
      } else {
        state.sendResults[i].error = (resp && resp.error) || state.sendResults[i].error || 'repair未补全';
      }
      break;
    }
  }
  // A1：恢复路径直入补发队列的漏发岗没有先行 sendResults 记录 → 补一条，确保 review 可见、不再算漏发
  if (!_found) {
    sentJobIds.add(job.jobId);
    state.sendProgress.sent++;
    if (ok) {
      markJobApplied(job.jobId);
      incrementDailySendCount(job.jobId);
    }
    state.sendResults.push({
      jobId: job.jobId, positionName: job.positionName, companyName: job.companyName,
      success: ok, repaired: true, hrName: job.hrName,
      error: ok ? null : ((resp && resp.error) || 'repair未补全'),
      time: Date.now(),
    });
  }
  try {
    await ErrorLogger.logError('[repair:diag] ' + JSON.stringify({
      jobId: job.jobId, pass: pass, complete: ok,
      foundConv: resp && resp.foundConv, hadText: resp && resp.hadText, hadImage: resp && resp.hadImage,
      repairedText: resp && resp.repairedText, repairedImage: resp && resp.repairedImage,
      error: resp && resp.error,
    }), '', 'repair.diag');
  } catch (e) {}
  pushState();
}

// 关掉 stage2 的 3 个 worker 窗口（含关窗前 ws-probe 取证 + 在飞帧落地缓冲）。
// 抽出来在 runRepairV6 之前调用：补发阶段必须先关掉 worker 窗口，才是真正的
// 「单 tab = 单 WS 连接」安静环境；否则补发 tab 是第 4 个 WS、仍困在 storm 里（旧序补不动）。
// 幂等：worker 已关时直接返回，可被 cleanupV6 重复调用而无副作用。
async function teardownWorkerWindows() {
  var hasTabs = state._v6WorkerTabIds && state._v6WorkerTabIds.length;
  var hasWins = state._v6WorkerWindowIds && state._v6WorkerWindowIds.length;
  if (!hasTabs && !hasWins) return;
  try { _diagMarkSelfTabOps(); } catch (_) {} // 扩展自己关 worker tab，onRemoved 别记成用户误操作
  stopAllWorkerKeepalives();
  // ⚠️ 关窗缓冲：worker 跑完但最后一帧可能仍在 WS 上传途中，立刻关会掐断 → 漏最后一条。给 1.5s 落地。
  await sleep(1500);
  // 🔍 WS 真因取证：关 tab 前 dump 每个 worker tab 的 ws-probe（写在 documentElement 的 data-ws-probe）。
  //    tab 一关数据就没了，必须在 remove 前抓。下一轮 GET_ERROR_LOG 读 wsProbe.dump 看 close/send/recv 序列。
  for (var pi = 0; pi < state._v6WorkerTabIds.length; pi++) {
    var ptid = state._v6WorkerTabIds[pi];
    try {
      var pres = await chrome.scripting.executeScript({
        target: { tabId: ptid },
        func: function () { return document.documentElement.getAttribute('data-ws-probe') || ''; },
      });
      var probe = (pres && pres[0] && pres[0].result) || '';
      await ErrorLogger.logError('[wsProbe:dump] tab=' + ptid + ' ' + (probe || 'EMPTY'), '', 'wsProbe.dump');
    } catch (e) {
      try { await ErrorLogger.logError('[wsProbe:dump] tab=' + ptid + ' READ_FAIL ' + (e && e.message), '', 'wsProbe.dump'); } catch (e2) {}
    }
  }
  // 优先关掉独立后台窗口（关窗口连带关 tab），再用 tab remove 作兜底
  if (state._v6WorkerWindowIds) {
    for (var wi = 0; wi < state._v6WorkerWindowIds.length; wi++) {
      try { await chrome.windows.remove(state._v6WorkerWindowIds[wi]); } catch (e) {}
    }
  }
  state._v6WorkerWindowIds = [];
  for (var ti = 0; ti < state._v6WorkerTabIds.length; ti++) {
    try { await chrome.tabs.remove(state._v6WorkerTabIds[ti]); } catch (e) {}
  }
  state._v6WorkerTabIds = [];
  state._v6WorkerTabsReady.clear();
}

async function activateOriginalMainWindow() {
  if (!state.originalMainWindowId) return;
  try {
    await chrome.windows.update(state.originalMainWindowId, { focused: true, drawAttention: true });
  } catch (e) {
    // 主窗口可能已被用户关闭，忽略
  }
}

async function cleanupV6() {
  await teardownWorkerWindows(); // 幂等：runRepairV6 前已调过则此处 no-op，只兜底
  if (_sendAutoTabIds.length) {
    for (var st = 0; st < _sendAutoTabIds.length; st++) {
      try { await chrome.tabs.remove(_sendAutoTabIds[st]); } catch (_) {}
    }
    _sendAutoTabIds = [];
  }
  state._sendDisplayTotal = null;
  state._sendDisplaySentMax = 0;
  _stage1TabProgress = { index: 0, total: 0 };
  state._v6SearchReady = false;
  state.sendPhase = '';
  state.sendQueueV6 = [];
  state.sendQueueV6Index = 0;
  await persistState();
  await activateOriginalMainWindow();
}

async function stopSend() {
  try { DiagLogger.userEvent('sw.send', '用户点击「停止发送」(STOP_SEND) phase=' + state.phase + ' sendPhase=' + state.sendPhase + ' sent=' + (state.sendProgress && state.sendProgress.sent) + '/' + (state.sendProgress && state.sendProgress.total)); } catch (_) {}
  try { _diagMarkSelfTabOps(); } catch (_) {} // 下面要主动关 worker tab，别记成用户误操作
  // 硬中止：立即断一切，再统一进终态（review + 重新投递）。
  sendAborted = true; // ① 置全局停止标记：startSendV6/runWorkerLoop 各边界即刻 bail

  // ② 立即给搜索 tab + 所有 worker tab 发 DO_STOP，置 content 侧 stopped（停 click/发送/弹窗）
  const tabs = await chrome.tabs.query({ url: '*://*.zhipin.com/*' });
  tabs.forEach((t) => chrome.tabs.sendMessage(t.id, { type: 'DO_STOP' }).catch(() => {}));

  // ③ 立即了结 runStage1 的 pending promise（不等 120s 超时）
  if (typeof abortStage1 === 'function') { try { abortStage1(); } catch (e) {} }

  stopAllWorkerKeepalives(); // 强停时清心跳

  // ④ 立即关所有 worker tab/窗（优先关独立后台窗口，连带关 tab；tab remove 兜底）
  if (state._v6WorkerWindowIds) {
    state._v6WorkerWindowIds.forEach(function(wid) {
      try { chrome.windows.remove(wid).catch(function(){}); } catch (e) {}
    });
  }
  state._v6WorkerWindowIds = [];
  if (state._v6WorkerTabIds) {
    state._v6WorkerTabIds.forEach(function(tid) {
      try { chrome.tabs.remove(tid).catch(function(){}); } catch (e) {}
    });
  }
  state._v6WorkerTabIds = [];
  if (state._v6WorkerTabsReady) state._v6WorkerTabsReady.clear();
  state._v6SearchReady = false;

  // 清 v5 残留字段（v5 链路用）
  state.sendQueue = [];
  state.sendIndex = 0;
  state.searchTabId = null;
  state.chatTabId = null;

  // ⑤ 置统一终态：把未投出去的岗位记「未投递」中性灰，停在 review，底部按钮变「重新投递」。
  //    finalizeTask 内部会清 sendPhase、读 sendQueueV6/_v6RepairQueue 补记后再清空也无妨——
  //    故在 finalizeTask 之后再清队列。
  await finalizeTask('stopped');
  state.sendQueueV6 = [];
  state.sendQueueV6Index = 0;
  state._v6RepairQueue = [];
  await persistState();
  await activateOriginalMainWindow();
}

// ── A1 一键补发（仅用户在 review 页主动触发，停止语义零改动）──
// 把 finalizeTask 算出的漏发清单（已建联 hrName 非空、却没发出 AI 招呼语+图的岗位）入
// _v6RepairQueue，走 runRepairV6 单 tab 单 WS 安静补发。repairSingle 先核对服务器消息历史
// 再缺啥补啥，天然防双发。进度/终态复用现有 phase=sending → review 机制。
async function startRepairMissed() {
  await bootRestored;        // 冷启动竞态防护：等 _v6MissedJobs/sendResults 等恢复完
  if (state.phase === 'sending') throw new Error('正在投递中，请稍后再试');
  var _seen = {};
  var missed = (state._v6MissedJobs || []).filter(function (it) {
    if (!it || it.jobId == null || !it.hrName || isGreetingMissing(it.greeting)) return false; // #36 保险丝：空/占位招呼语不补发
    if (_seen[it.jobId]) return false; // 幂等：按 jobId 去重
    _seen[it.jobId] = true;
    return true;
  });
  if (!missed.length) throw new Error('没有需要补发的岗位');
  try { DiagLogger.userEvent('sw.send', '用户点击「一键补发」missed=' + missed.length); } catch (_) {}
  sendAborted = false;          // 补发是新一段任务，清上一轮停止标记
  sendStartTime = Date.now();
  state._v6RepairQueue = missed;
  state._v6MissedJobs = [];     // 消费即清：连点按钮/重开 popup 不会重复入队
  state.phase = 'sending';
  state.sendPhase = 'stage2';   // 复用现有值域（runRepairV6 只看 phase；非 '' 以便 SW 冷启可走恢复兜底）
  state.sendProgress = { sent: 0, total: missed.length };
  pushState();
  await persistState();
  await runRepairV6();          // 内部 phase!=='sending' 即中断，停止按钮仍即时生效
  if (sendAborted) return;      // 补发中被停止：stopSend 已 finalizeTask 进终态，不重复收尾
  state.sendProgress = { sent: state.sendResults.length, total: state.sendResults.length };
  await cleanupV6();
  await finishSend();
}

// ── 读取 API Key（从 storage 读取，首次启动由 ensureApiKey 预置） ──
async function getApiKey() {
  const { apiKey } = await chrome.storage.local.get('apiKey');
  return apiKey || '';
}

// ── 招呼语并发生成 ──
let greetingPromise = null;

async function generateAllGreetingsConcurrent() {
  // 即时预热：以用户期望岗位为锚生成 N 条招呼语，不依赖 jdSamples / 岗位采集结果
  // 兜底：从 chrome.storage 读权威 selectedPositions
  let pickerPositions = Array.isArray(state.selectedPositions) ? state.selectedPositions.slice() : [];
  let customPos = Array.isArray(state.customPositions) ? state.customPositions.slice() : [];
  if (!pickerPositions.length && !customPos.length) {
    try {
      const { [STORAGE_KEYS.UI.FILTER_STATE]: fs } = await chrome.storage.local.get(STORAGE_KEYS.UI.FILTER_STATE);
      if (fs) {
        if (Array.isArray(fs.selectedPositions) && fs.selectedPositions.length) {
          pickerPositions = fs.selectedPositions.slice();
          state.selectedPositions = pickerPositions;
        }
        if (Array.isArray(fs.customPositions) && fs.customPositions.length) {
          customPos = fs.customPositions.slice();
          state.customPositions = customPos;
        }
      }
    } catch (e) { /* 静默 */ }
  }
  const selectedPositions = pickerPositions.concat(customPos);
  if (!selectedPositions.length) return;
  // 刷新简历图片缓存（每批重新读原图）+ 重置 COS 上传去重(每批重新直传,防后端 TTL 过期取不到图)
  _cachedResumeImages = null;
  _uploadedFileIds = null;
  _uploadedSig = null;
  const apiKey = isLocalMode() ? 'local' : await getApiKey();
  if (!isLocalMode() && !apiKey) {
    chrome.runtime.sendMessage({ type: 'ERROR', message: '请先在设置页配置 AI API Key' }).catch(() => {});
    return;
  }

  // 加载简历图片（压缩缓存）— 本地模式仅用于投递发图，招呼语不依赖云端
  let resumeImages = isLocalMode() ? [] : await loadResumeImages();

  // 已生成成功的 category 跳过，避免重复 API 调用（多触发入口同时打进来时）
  const categories = selectedPositions
    .filter(p => !(state.greetings[p] && typeof isGreetingPlaceholder === 'function' && !isGreetingPlaceholder(state.greetings[p])))
    .map(p => [p, null]);
  const CONCURRENCY = CONFIG.GREETING_CONCURRENCY || 3;
  const TIMEOUT_MS = CONFIG.GREETING_TIMEOUT_MS || 120000;
  let doneCount = 0;
  const total = categories.length;

  state.greetingProgress = { done: 0, total };
  pushState();

  for (let i = 0; i < categories.length; i += CONCURRENCY) {
    const batch = categories.slice(i, i + CONCURRENCY);
    await Promise.allSettled(
      batch.map(([category, samples]) =>
        (async () => {
          for (let attempt = 1; attempt <= 2; attempt++) {
            const tRaceStart = Date.now();
            console.log(`[即投][RACE] ${category} attempt=${attempt} start budget=${TIMEOUT_MS}ms`);
            try {
              const greeting = await Promise.race([
                generateGreeting(apiKey, resumeImages, samples, category),
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS))
              ]);
              const tRaceEnd = Date.now();
              console.log(`[即投][RACE] ${category} attempt=${attempt} WIN ${tRaceEnd - tRaceStart}ms`);
              state.greetings[category] = greeting;
              return;
            } catch (err) {
              const tRaceEnd = Date.now();
              const raceElapsed = tRaceEnd - tRaceStart;
              const reason = err.message === 'timeout' ? `RACE_TIMEOUT@${raceElapsed}ms` : `ERR ${err.message}`;
              console.warn(`[即投][RACE] ${category} attempt=${attempt} LOSE ${raceElapsed}ms reason=${reason}`);
              ErrorLogger.logError(`RACE_LOSE ${category} attempt=${attempt} elapsed=${raceElapsed}ms ${reason}`, err.stack, 'greeting race');
              if (attempt < 2) {
                console.warn(`Greeting generation timeout, retrying (${attempt}/2):`, category, err.message);
                continue;
              }
              console.error('Greeting generation failed (after 2 attempts):', category, err);
              ErrorLogger.logError(err.message || String(err), err?.stack, `Greeting generation failed: ${category}`);
              state.greetings[category] = '生成失败，请刷新';
            }
          }
        })()
      )
    );

    doneCount += batch.length;
    state.greetingProgress.done = Math.min(doneCount, total);
    pushState();
  }

  state.greetingProgress = { done: total, total };
  // 检查是否全部生成失败
  let allFailed = true;
  for (const cat in state.greetings) {
    if (state.greetings[cat] && typeof isGreetingPlaceholder === 'function' && !isGreetingPlaceholder(state.greetings[cat])) {
      allFailed = false; break;
    }
  }
  if (allFailed && total > 0) {
    chrome.runtime.sendMessage({ type: 'ERROR', message: '招呼语生成失败，请检查 API Key 配置' }).catch(() => {});
  }
  greetingPromise = null;
  pushState();
}

async function regenerateGreeting(category, jdSamples) {
  var greeting;
  if (isLocalMode()) {
    greeting = await getLocalFixedGreeting(category);
  } else {
    const apiKey = await getApiKey();
    if (!apiKey) throw new Error('请先在设置中配置 API Key');
    invalidateResumeImageCache();
    const resumeImages = await loadResumeImages(true);
    const samples = jdSamples?.length ? jdSamples : (state.jdSamples?.[category] || []);
    greeting = await generateGreeting(apiKey, resumeImages, samples, category);
  }
  state.greetings[category] = greeting;
  pushState();
  return greeting;
}

async function doRewriteGreeting(originalGreeting, instruction) {
  if (isLocalMode()) return originalGreeting || await getLocalFixedGreeting('');
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error('请先在设置中配置 API Key');
  return rewriteGreeting(apiKey, originalGreeting, instruction);
}

// ════════════════════════════════════════════════════════════════
// 诊断包：用户行为事件监听（USER_EVENT，误操作判别关键）— 纯新增模块
// 见 handoff-diagnostic-bundle-01。只读 state，不改任何业务逻辑/状态。
// ════════════════════════════════════════════════════════════════

// 「扩展自己关 tab」窗口期标记：teardown/stopSend/resume 清理期间的 onRemoved
// 不算用户误操作。8s 后自动失效（关窗动作是异步的，给足余量）。
var _diagSelfTabOpsUntil = 0;
function _diagMarkSelfTabOps() { _diagSelfTabOpsUntil = Date.now() + 8000; }

// 判断 tabId 是否任务相关（worker / 搜索 / v5 聊天 tab）
function _diagTabRole(tabId) {
  if (state._v6WorkerTabIds && state._v6WorkerTabIds.indexOf(tabId) >= 0) return 'worker';
  if (tabId === state.searchTabId) return 'search';
  if (tabId === state.chatTabId) return 'chat';
  return '';
}

// ① worker/搜索 tab 被关闭
chrome.tabs.onRemoved.addListener(function (tabId, removeInfo) {
  try {
    var role = _diagTabRole(tabId);
    if (!role) return;
    var busy = state.phase === 'sending' || state.phase === 'collecting';
    if (Date.now() < _diagSelfTabOpsUntil) {
      DiagLogger.info('sw.tabs', role + ' tab 关闭（扩展自身清理）tab=' + tabId);
    } else {
      DiagLogger.userEvent('sw.tabs', role + ' tab 被关闭（用户/外部）tab=' + tabId + ' phase=' + state.phase + (busy ? ' ⚠️ 任务进行中被关闭' : ''));
    }
  } catch (_) {}
});

// ② worker/搜索 tab 被导航走（URL 变化）。zhipin 站内 SPA/页内跳转记 INFO，离开 zhipin 记 USER_EVENT。
chrome.tabs.onUpdated.addListener(function (tabId, changeInfo) {
  try {
    if (!changeInfo || !changeInfo.url) return;
    var role = _diagTabRole(tabId);
    if (!role) return;
    if (state.phase !== 'sending' && state.phase !== 'collecting') return;
    // 只保留 origin+path，去掉 query/hash（防泄漏搜索词等）
    var urlBrief = changeInfo.url;
    try { var u = new URL(changeInfo.url); urlBrief = u.origin + u.pathname; } catch (e2) {}
    if (changeInfo.url.indexOf('zhipin.com') < 0) {
      DiagLogger.userEvent('sw.tabs', role + ' tab 被导航离开 BOSS（疑似用户操作）tab=' + tabId + ' → ' + urlBrief + ' phase=' + state.phase);
    } else {
      DiagLogger.info('sw.tabs', role + ' tab URL 变化 tab=' + tabId + ' → ' + urlBrief);
    }
  } catch (_) {}
});

// ③ 扩展安装/更新/重载
try {
  chrome.runtime.onInstalled.addListener(function (details) {
    try {
      var v = '';
      try { v = chrome.runtime.getManifest().version; } catch (e2) {}
      DiagLogger.userEvent('sw.lifecycle', '扩展 ' + ((details && details.reason) || 'installed') + ' (v' + v + ')');
    } catch (_) {}
  });
} catch (_) {}

// 简历图 storage 变更时清 SW 缓存，避免上传后刷新仍读到空图
try {
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === 'local' && changes.resumeImages) {
      invalidateResumeImageCache();
    }
  });
} catch (_) {}
