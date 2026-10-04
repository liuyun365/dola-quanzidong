const DEBUGGER_VERSION = "1.3";
const DOUBAO_SKILL_PACK_URL_PART = "doubao.com/samantha/skill/pack";
const DOLA_SKILL_PACK_URL_PART = "dola.com/samantha/skill/pack";
const DOUBAO_ACTION_BAR_CONF_URL_PART = "doubao.com/alice/slot/action_bar_v3/get_item_conf";
const DOLA_ACTION_BAR_CONF_URL_PART = "dola.com/alice/slot/action_bar_v3/get_item_conf";
const DOUBAO_CHAIN_SINGLE_URL_PART = "doubao.com/im/chain/single";
const DOLA_CHAIN_SINGLE_URL_PART = "dola.com/im/chain/single";
const QIANWEN_MESSAGE_LIST_URL_PART = "chat2.qianwen.com/api/v1/session/msg/list";
const QIANWEN_API_MESSAGE_LIST_URL_PART = "chat2-api.qianwen.com/api/v1/session/msg/list";
const YUNQUE_THREAD_FILE_URL_PART = "xyq.jianying.com/*list_thread_file";
const YUNQUE_PACKAGE_INFO_URL_PART = "xyq.jianying.com/api/biz/v1/editor/get_package_info";
const SOURCE_HOSTS = Object.freeze({
  doubao: "doubao.com",
  dola: "dola.com",
  qianwen: "qianwen.com",
  yunque: "jianying.com"
});
// 【v1.3.2 修复】原 FALLBACK_API_ROOT_HOSTS 域名白名单已移除。
// 主程序 LocalVideoResolver.BuildRequestUri 只校验「是合法 http/https 绝对 URL」，**没有任何域名限制**；
// 插件却把 doubao 限死在 doubao.com / byteintlapi.com、dola 限死在 dola.com / byteintlapi.com，
// 平台一旦把 fallback_api 指向其它域（CDN 等），URL 会在 addFallbackApi 里被**静默丢弃**，
// 表现就是「面板一直显示 未提取到资源」。
// 同时原实现强制 https，而主程序允许 http + https —— 这里一并放开，与主程序保持一致。
const MAX_FALLBACK_API_COUNT = 8;
const FALLBACK_API_TIMEOUT_MS = 8000;
const FALLBACK_VIDEO_CACHE_TTL_MS = 10 * 60 * 1000;
const FALLBACK_VIDEO_CACHE_MAX = 200;
const QAAB_SALT_HEX = "4dd4c2e6b83162090e52b3c7a6733ba4"
  + "1cb2462b829ab58a196b39db57177524"
  + "f49baf7f08e8d68d26a72e37c1a95a2f"
  + "1f05a51892aef2949732b62a38aadd58";

const fetchPatterns = [
  { urlPattern: `*${DOUBAO_SKILL_PACK_URL_PART}*`, requestStage: "Request" },
  { urlPattern: `*${DOLA_SKILL_PACK_URL_PART}*`, requestStage: "Request" },
  { urlPattern: `*${DOUBAO_ACTION_BAR_CONF_URL_PART}*`, requestStage: "Response" },
  { urlPattern: `*${DOLA_ACTION_BAR_CONF_URL_PART}*`, requestStage: "Response" },
  { urlPattern: `*${DOUBAO_CHAIN_SINGLE_URL_PART}*`, requestStage: "Response" },
  { urlPattern: `*${DOLA_CHAIN_SINGLE_URL_PART}*`, requestStage: "Response" },
  { urlPattern: `*${QIANWEN_MESSAGE_LIST_URL_PART}*`, requestStage: "Response" },
  { urlPattern: `*${QIANWEN_API_MESSAGE_LIST_URL_PART}*`, requestStage: "Response" },
  { urlPattern: `*${YUNQUE_THREAD_FILE_URL_PART}*`, requestStage: "Response" },
  { urlPattern: `*${YUNQUE_PACKAGE_INFO_URL_PART}*`, requestStage: "Response" }
];

const attachedTabs = new Set();
const responseFileBodyPromises = new Map();
const tabNavigationGenerations = new Map();
const panelInitializationByTab = new Map();
const debuggerAttachmentByTab = new Map();
const fallbackVideoCache = new Map();
const AUTO_DEBUGGER_SNIFF_KEY = "intl_doubao_auto_debugger_sniff_v1";

chrome.runtime.onInstalled.addListener(attachExistingTabs);
chrome.runtime.onStartup.addListener(attachExistingTabs);
attachExistingTabs().catch((error) => {
  console.warn("initial tab activation failed:", error.message || error);
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await safeGetTab(tabId);
  if (tab && shouldAttachToTab(tab.url)) {
    activateTab(tabId);
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    const generation = (tabNavigationGenerations.get(tabId) || 0) + 1;
    tabNavigationGenerations.set(tabId, generation);
    const source = getSourceFromUrl(changeInfo.url);
    if (source) {
      sendToTab(tabId, {
        type: "MEDIA_RESET",
        sourceKey: `${source}:${generation}`
      });
    }
  }
  const url = changeInfo.url || tab.url;
  if (shouldAttachToTab(url)) {
    activateTab(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabs.delete(tabId);
  tabNavigationGenerations.delete(tabId);
  panelInitializationByTab.delete(tabId);
  debuggerAttachmentByTab.delete(tabId);
});

chrome.action.onClicked.addListener((tab) => {
  if (tab && tab.id && shouldAttachToTab(tab.url)) {
    // 面板始终可用；点击图标额外启用方悦式 debugger 嗅探（用户主动 opt-in，降低风控面）。
    activateTab(tab.id)
      .then(() => ensureAttached(tab.id))
      .catch((error) => {
        console.warn("debugger sniff on action click failed:", error.message || error);
      });
  }
});

chrome.debugger?.onDetach?.addListener((source) => {
  if (source.tabId) {
    attachedTabs.delete(source.tabId);
    debuggerAttachmentByTab.delete(source.tabId);
    setBadge(source.tabId, "");
  }
});

chrome.debugger?.onEvent?.addListener((source, method, params) => {
  if (method === "Fetch.requestPaused" && source.tabId && params) {
    handlePausedRequest(source.tabId, params);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) {
    return;
  }

  if (message.type === "ENABLE_DEBUGGER_SNIFF" && sender.tab?.id) {
    ensureAttached(sender.tab.id).then(() => {
      sendResponse({ ok: true });
    }).catch((error) => {
      sendResponse({ ok: false, error: error.message || String(error) });
    });
    return true;
  }

  if (message.type === "SET_AUTO_DEBUGGER_SNIFF" && typeof message.enabled === "boolean") {
    chrome.storage.local.set({ [AUTO_DEBUGGER_SNIFF_KEY]: message.enabled ? "1" : "0" }).then(() => {
      sendResponse({ ok: true });
    }).catch((error) => {
      sendResponse({ ok: false, error: error.message || String(error) });
    });
    return true;
  }

  if (message.type === "GET_AUTO_DEBUGGER_SNIFF") {
    readAutoDebuggerSniffEnabled().then((enabled) => {
      sendResponse({ ok: true, enabled });
    }).catch((error) => {
      sendResponse({ ok: false, enabled: false, error: error.message || String(error) });
    });
    return true;
  }

  if (message.type === "RESOLVE_FALLBACK_APIS" && sender.tab?.id && Array.isArray(message.urls)) {
    resolveFallbackApisForTab(sender.tab.id, sender.tab.url || "", message.urls).then((count) => {
      sendResponse({ ok: true, count });
    }).catch(async (error) => {
      console.warn("passive media resolve failed:", error.message || error);
      await sendToTab(sender.tab.id, {
        type: "MEDIA_STATUS",
        sourceKey: `${getSourceFromUrl(sender.tab.url || "") || "dola"}:${tabNavigationGenerations.get(sender.tab.id) || 0}`,
        text: "无水印资源解析失败"
      }).catch(() => {});
      sendResponse({ ok: false, error: error.message || String(error) });
    });
    // Manifest V3 必须保持消息通道，避免 Service Worker 在异步解析完成前被挂起。
    return true;
  }

  if (message.type !== "DOWNLOAD_MEDIA" || !isHttpUrl(message.url)) return;

  chrome.downloads.download({
    url: message.url,
    filename: buildDownloadFilename("", message.mediaType),
    conflictAction: "uniquify",
    saveAs: false
  }).catch((error) => {
    console.warn("download failed:", error);
  });
});

async function resolveFallbackApisForTab(tabId, tabUrl, candidates) {
  const source = getSourceFromUrl(tabUrl) || "dola";
  const generation = tabNavigationGenerations.get(tabId) || 0;
  const sourceKey = `${source}:${generation}`;
  const urls = Array.from(new Set(candidates.filter(isAllowedFallbackApiUrl))).slice(0, MAX_FALLBACK_API_COUNT);
  const resolved = await Promise.all(urls.map((url) => getCachedUnwatermarkedVideoUrl(url, source)));
  const items = [];
  const seenUrls = new Set();
  for (const url of resolved) addItem(items, seenUrls, "video", url);
  await sendMediaResult(tabId, sourceKey, items);
  return items.length;
}

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  try {
    const filename = item.filename || "";
    const mime = (item.mime || "").toLowerCase();
    const url = (item.url || "").toLowerCase();

    // 本扩展发起的下载始终使用完整的品牌文件名和媒体扩展名。
    // byExtensionId 可避免误改用户在网页上正常下载的其它文件。
    if (item.byExtensionId === chrome.runtime.id) {
      const mediaType = mime.startsWith("image/") ? "image" : "video";
      suggest({
        filename: buildDownloadFilename("", mediaType, mime),
        conflictAction: "uniquify"
      });
      return;
    }

    const match = filename.match(/\.([a-zA-Z0-9]{2,5})$/);
    const currentExt = match ? match[1].toLowerCase() : "";
    const validVideoExts = ["mp4", "m4v", "mov", "webm", "mkv", "avi"];
    const validImageExts = ["png", "jpg", "jpeg", "webp", "gif", "avif", "bmp"];
    const hasValidExt = validVideoExts.includes(currentExt) || validImageExts.includes(currentExt);

    if (!hasValidExt || !currentExt) {
      let isVideo = false;
      let targetExt = ".mp4";

      if (mime.startsWith("video/") || validVideoExts.some((e) => url.includes("." + e)) || url.includes("video") || (item.fileSize && item.fileSize > 1.5 * 1024 * 1024)) {
        isVideo = true;
        targetExt = ".mp4";
        if (mime.includes("webm") || url.includes(".webm")) targetExt = ".webm";
        else if (mime.includes("quicktime") || url.includes(".mov")) targetExt = ".mov";
      } else if (mime.startsWith("image/") || validImageExts.some((e) => url.includes("." + e)) || url.includes("image")) {
        isVideo = false;
        targetExt = ".jpg";
        if (mime.includes("png") || url.includes(".png")) targetExt = ".png";
        else if (mime.includes("webp") || url.includes(".webp")) targetExt = ".webp";
      } else {
        isVideo = true;
        targetExt = ".mp4";
      }

      const now = new Date();
      const pad = (n) => String(n).padStart(2, "0");
      const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

      let base = filename.replace(/\.[a-zA-Z0-9]{2,5}$/, "").replace(/[<>:\"/\\|?*\x00-\x1F]/g, "_").trim();
      if (!base || base === "download" || base === "videoplayback" || base.startsWith("blob")) {
        base = `哆啦助手${isVideo ? "视频" : "图片"}_${stamp}`;
      } else if (!base.includes("哆啦助手") && !base.includes("Dola")) {
        base = `哆啦助手_${base}_${stamp}`;
      }

      suggest({ filename: `${base}${targetExt}`, conflictAction: "uniquify" });
      return;
    }
  } catch (err) {
    console.warn("[哆啦助手] onDeterminingFilename error:", err);
  }
  suggest();
});

async function attachExistingTabs() {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id && shouldAttachToTab(tab.url)) {
      activateTab(tab.id);
    }
  }
}

async function readAutoDebuggerSniffEnabled() {
  try {
    const stored = await chrome.storage.local.get(AUTO_DEBUGGER_SNIFF_KEY);
    return stored[AUTO_DEBUGGER_SNIFF_KEY] === "1";
  } catch {
    return false;
  }
}

async function activateTab(tabId) {
  await ensurePanel(tabId);
  if (await readAutoDebuggerSniffEnabled()) {
    try {
      await ensureAttached(tabId);
    } catch (error) {
      console.warn("auto debugger sniff failed:", error.message || error);
    }
  }
}

async function ensurePanel(tabId) {
  if (panelInitializationByTab.has(tabId)) {
    return panelInitializationByTab.get(tabId);
  }

  const initialization = initializePanel(tabId).finally(() => {
    panelInitializationByTab.delete(tabId);
  });
  panelInitializationByTab.set(tabId, initialization);
  return initialization;
}

async function initializePanel(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "PANEL_PING" });
    if (response?.ready) {
      return;
    }
  } catch {
    // The content script is absent, stale after an extension reload, or not ready yet.
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        delete globalThis.__watermarkFreeMediaPanelActive;
      }
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content-panel.js"]
    });
    const response = await chrome.tabs.sendMessage(tabId, { type: "PANEL_PING" });
    if (!response?.ready) {
      throw new Error("content panel did not acknowledge initialization");
    }
  } catch (error) {
    console.warn("panel injection failed:", error.message || error);
  }
}

async function safeGetTab(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}

function shouldAttachToTab(url) {
  return Boolean(getSourceFromUrl(url));
}

function getSourceFromUrl(rawUrl) {
  if (typeof rawUrl !== "string") {
    return "";
  }

  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "";
    }

    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
    for (const [source, rootHost] of Object.entries(SOURCE_HOSTS)) {
      if (hostname === rootHost || hostname.endsWith(`.${rootHost}`)) {
        return source;
      }
    }
  } catch {
    return "";
  }

  return "";
}

function isSourcePathUrl(rawUrl, source, pathPrefix) {
  if (getSourceFromUrl(rawUrl) !== source) {
    return false;
  }

  try {
    const pathname = new URL(rawUrl).pathname;
    return pathname === pathPrefix || pathname.startsWith(`${pathPrefix}/`);
  } catch {
    return false;
  }
}

function isQianwenMessageListUrl(rawUrl) {
  if (getSourceFromUrl(rawUrl) !== "qianwen") {
    return false;
  }

  try {
    const parsed = new URL(rawUrl);
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
    return (hostname === "chat2-api.qianwen.com" || hostname === "chat2.qianwen.com")
      && parsed.pathname.replace(/\/$/, "") === "/api/v1/session/msg/list";
  } catch {
    return false;
  }
}

function isYunqueThreadFileUrl(rawUrl) {
  if (getSourceFromUrl(rawUrl) !== "yunque") {
    return false;
  }

  try {
    const parsed = new URL(rawUrl);
    return parsed.hostname.toLowerCase().replace(/\.$/, "") === "xyq.jianying.com"
      && parsed.pathname.toLowerCase().includes("list_thread_file");
  } catch {
    return false;
  }
}

function isYunquePackageInfoUrl(rawUrl) {
  if (getSourceFromUrl(rawUrl) !== "yunque") {
    return false;
  }

  try {
    const parsed = new URL(rawUrl);
    return parsed.hostname.toLowerCase().replace(/\.$/, "") === "xyq.jianying.com"
      && parsed.pathname.replace(/\/$/, "").toLowerCase()
        === "/api/biz/v1/editor/get_package_info";
  } catch {
    return false;
  }
}

async function ensureAttached(tabId) {
  if (attachedTabs.has(tabId)) {
    return;
  }

  if (debuggerAttachmentByTab.has(tabId)) {
    return debuggerAttachmentByTab.get(tabId);
  }

  const attachment = attachToTab(tabId).finally(() => {
    debuggerAttachmentByTab.delete(tabId);
  });
  debuggerAttachmentByTab.set(tabId, attachment);
  return attachment;
}

async function attachToTab(tabId) {

  try {
    await attachDebugger(tabId);
  } catch (error) {
    console.warn("debugger attach failed:", error.message || error);
  }

  try {
    await sendCommand(tabId, "Fetch.enable", { patterns: fetchPatterns });
    attachedTabs.add(tabId);
    setBadge(tabId, "ON");
  } catch (error) {
    console.warn("Fetch.enable failed:", error.message || error);
    setBadge(tabId, "");
  }
}

function attachDebugger(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, DEBUGGER_VERSION, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}

function sendCommand(tabId, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(result);
    });
  });
}

async function handlePausedRequest(tabId, event) {
  const requestId = event.requestId;
  const request = event.request || {};
  const url = request.url || "";

  try {
    if (isSourcePathUrl(url, "doubao", "/samantha/skill/pack")) {
      await fulfillJsonFile(tabId, requestId, request.method, "doubao-skill-pack-response.json");
      return;
    }

    if (isSourcePathUrl(url, "dola", "/samantha/skill/pack")) {
      await fulfillJsonFile(tabId, requestId, request.method, "dola-skill-pack-response.json");
      return;
    }

    if (
      isSourcePathUrl(url, "doubao", "/alice/slot/action_bar_v3/get_item_conf") ||
      isSourcePathUrl(url, "dola", "/alice/slot/action_bar_v3/get_item_conf")
    ) {
      await rewriteActionBarConfigResponse(tabId, event);
      return;
    }

    if (isSourcePathUrl(url, "doubao", "/im/chain/single")) {
      await inspectChainSingleResponse(tabId, event, "doubao");
      return;
    }

    if (isSourcePathUrl(url, "dola", "/im/chain/single")) {
      await inspectChainSingleResponse(tabId, event, "dola");
      return;
    }

    if (isQianwenMessageListUrl(url)) {
      await inspectMediaResponse(tabId, event, "qianwen", extractQianwenItems);
      return;
    }

    if (isYunqueThreadFileUrl(url)) {
      await inspectMediaResponse(tabId, event, "yunque", extractYunqueThreadItems);
      return;
    }

    if (isYunquePackageInfoUrl(url)) {
      await inspectMediaResponse(tabId, event, "yunque", extractYunquePackageItems);
      return;
    }

    await continueRequest(tabId, requestId);
  } catch (error) {
    console.warn("request handling failed:", error.message || error);
    await continueRequest(tabId, requestId).catch(() => {});
  }
}

async function fulfillJsonFile(tabId, requestId, method, fileName) {
  if ((method || "").toUpperCase() === "OPTIONS") {
    await sendCommand(tabId, "Fetch.fulfillRequest", {
      requestId,
      responseCode: 204,
      responsePhrase: "No Content",
      responseHeaders: corsHeaders()
    });
    return;
  }

  const body = await getResponseFileBody(fileName);
  await sendCommand(tabId, "Fetch.fulfillRequest", {
    requestId,
    responseCode: 200,
    responsePhrase: "OK",
    responseHeaders: responseHeadersForTextBody(corsHeaders(), body),
    body: toBase64Utf8(body)
  });
}

function continueRequest(tabId, requestId) {
  return sendCommand(tabId, "Fetch.continueRequest", { requestId });
}

async function rewriteActionBarConfigResponse(tabId, event) {
  const response = await getPausedResponseBody(tabId, event.requestId);
  const patchedBody = patchActionBarDuration(response.body);

  await sendCommand(tabId, "Fetch.fulfillRequest", {
    requestId: event.requestId,
    responseCode: event.responseStatusCode || 200,
    responsePhrase: event.responseStatusText || "OK",
    responseHeaders: responseHeadersForTextBody(event.responseHeaders || [], patchedBody),
    body: toBase64Utf8(patchedBody)
  });
}

async function inspectChainSingleResponse(tabId, event, source) {
  const navigationGeneration = tabNavigationGenerations.get(tabId) || 0;
  const sourceKey = `${source}:${navigationGeneration}`;
  const response = await getPausedResponseBody(tabId, event.requestId);

  await sendCommand(tabId, "Fetch.fulfillRequest", {
    requestId: event.requestId,
    responseCode: event.responseStatusCode || 200,
    responsePhrase: event.responseStatusText || "OK",
    responseHeaders: responseHeadersForTextBody(event.responseHeaders || [], response.body),
    body: toBase64Utf8(response.body)
  });

  // 【修复】JSON.parse 失败不再阻断资源提取。
  // 豆包的 /im/chain/single 响应约 857KB，并非单个合法 JSON（多段拼接/外层包装），
  // 原实现把 JSON.parse 与 extractUnwatermarkedItems 写在同一个 try 里，
  // 一旦 parse 抛异常就整段跳到 catch —— 连 extractUnwatermarkedItems 内部的
  // rawBody 正则兜底都没机会执行，于是豆包页面永远显示"未提取到资源"。
  // 现改为：解析失败 → json = null → 依然执行提取（图片/视频都靠正则兜底）。
  // Dola 的响应是单个合法 JSON，行为不受影响。
  let json = null;
  try {
    json = JSON.parse(response.body);
  } catch (error) {
    console.warn(`${source} chain body is not a single valid JSON, fallback to regex scan:`, error.message || error);
  }

  let items = [];
  try {
    items = await extractUnwatermarkedItems(json, response.body, source);
  } catch (error) {
    console.warn(`${source} chain extract failed:`, error.message || error);
  }

  const currentTab = await safeGetTab(tabId);
  if (
    (tabNavigationGenerations.get(tabId) || 0) !== navigationGeneration ||
    !currentTab ||
    getSourceFromUrl(currentTab.url) !== source
  ) {
    return;
  }

  await sendMediaResult(tabId, sourceKey, items);
}

async function inspectMediaResponse(tabId, event, source, extractor) {
  const navigationGeneration = tabNavigationGenerations.get(tabId) || 0;
  const sourceKey = `${source}:${navigationGeneration}`;
  const response = await getPausedResponseBody(tabId, event.requestId);

  await sendCommand(tabId, "Fetch.fulfillRequest", {
    requestId: event.requestId,
    responseCode: event.responseStatusCode || 200,
    responsePhrase: event.responseStatusText || "OK",
    responseHeaders: responseHeadersForTextBody(event.responseHeaders || [], response.body),
    body: toBase64Utf8(response.body)
  });

  let items = [];
  try {
    items = extractor(response.body);
  } catch (error) {
    console.warn(`${source} media parse failed:`, error.message || error);
  }

  const currentTab = await safeGetTab(tabId);
  if (
    (tabNavigationGenerations.get(tabId) || 0) !== navigationGeneration ||
    !currentTab ||
    getSourceFromUrl(currentTab.url) !== source
  ) {
    return;
  }

  await sendMediaResult(tabId, sourceKey, items);
}

async function sendMediaResult(tabId, sourceKey, items) {
  if (items.length) {
    await sendToTab(tabId, {
      type: "MEDIA_FOUND",
      sourceKey,
      items
    });
  } else {
    await sendToTab(tabId, {
      type: "MEDIA_STATUS",
      sourceKey,
      text: "未提取到资源"
    });
  }
}

async function getPausedResponseBody(tabId, requestId) {
  const response = await sendCommand(tabId, "Fetch.getResponseBody", { requestId });
  return {
    body: response.base64Encoded ? fromBase64Utf8(response.body) : response.body
  };
}

async function extractUnwatermarkedItems(json, rawBody, source) {
  const items = [];
  const seenUrls = new Set();

  // 图片：json 可用时走结构化遍历；同时对原始 body 做正则兜底。
  // 豆包的 chain 响应不是单个合法 JSON（json 为 null），此时只能靠正则捞 image_ori_raw.url。
  const imageUrlsFromJson = findImageOriRawUrls(json);
  const imageUrlsFromBody = findImageOriRawUrlsFromBody(rawBody);
  for (const url of imageUrlsFromJson) {
    addItem(items, seenUrls, "image", url);
  }
  for (const url of imageUrlsFromBody) {
    addItem(items, seenUrls, "image", url);
  }

  // 【v1.3.2 诊断】统计 fallback_api 在原始 body 里出现的次数（未经任何过滤），
  // 用来区分「平台根本没给 fallback_api」和「给了但被丢弃/解析失败」。
  const rawFallbackHits = (rawBody.match(/fallback_api/g) || []).length;
  const fallbackApis = findFallbackApis(json, rawBody, source).slice(0, MAX_FALLBACK_API_COUNT);
  const videoUrls = await Promise.all(
    fallbackApis.map((fallbackApi) => getCachedUnwatermarkedVideoUrl(fallbackApi, source))
  );
  let videoCount = 0;
  for (const videoUrl of videoUrls) {
    if (addItem(items, seenUrls, "video", videoUrl)) {
      videoCount += 1;
    }
  }

  // 【v1.3.2 诊断】一次性输出全链路计数，便于定位"未提取到资源"到底卡在哪一步。
  let firstHost = "";
  if (fallbackApis.length) {
    try {
      firstHost = new URL(fallbackApis[0]).hostname;
    } catch {
      firstHost = "(无法解析)";
    }
  }
  console.warn(
    `[哆啦助手] ${source} 提取诊断: body=${rawBody.length}B`
      + ` | image(json)=${imageUrlsFromJson.length}`
      + ` image(regex)=${imageUrlsFromBody.length}`
      + ` | fallback_api出现=${rawFallbackHits}`
      + ` 候选=${fallbackApis.length}`
      + ` 首个主机=${firstHost || "(无)"}`
      + ` | 视频成功=${videoCount}`
      + ` | items=${items.length}`
  );

  return items;
}

function extractQianwenItems(rawBody) {
  const items = [];
  const seenUrls = new Set();

  for (const url of findRegexUrls(
    rawBody,
    /\bsrc\s*=\s*\\?"(https?:\/\/.+?)\\?"\s*poster\b/gi
  )) {
    addItem(items, seenUrls, "video", url);
  }

  for (const url of findRegexUrls(
    rawBody,
    /\\?"thumbnail_url\\?"\s*:\s*\\?"(.+?)\\?"/gi
  )) {
    addItem(items, seenUrls, "image", url);
  }

  const json = parseJsonString(rawBody);
  if (json !== null) {
    for (const value of findValuesByKey(json, "thumbnail_url")) {
      addItem(items, seenUrls, "image", normalizeExtractedUrl(value));
    }
  }

  return items;
}

function extractYunqueThreadItems(rawBody) {
  const items = [];
  const seenUrls = new Set();

  for (const url of findRegexUrls(
    rawBody,
    /\\?"origin_url\\?"\s*:\s*\\?"(.+?)\\?"/gi
  )) {
    addItem(items, seenUrls, "video", url);
  }

  for (const url of findRegexUrls(
    rawBody,
    /\\?"url\\?"\s*:\s*\\?"(.+?)\\?"/gi
  )) {
    if (url.startsWith("https://") && url.toLowerCase().includes("origin_aigc")) {
      addItem(items, seenUrls, "image", url);
    }
  }

  const json = parseJsonString(rawBody);
  if (json !== null) {
    for (const value of findValuesByKey(json, "origin_url")) {
      addItem(items, seenUrls, "video", normalizeExtractedUrl(value));
    }
    for (const value of findValuesByKey(json, "url")) {
      const url = normalizeExtractedUrl(value);
      if (url.startsWith("https://") && url.toLowerCase().includes("origin_aigc")) {
        addItem(items, seenUrls, "image", url);
      }
    }
  }

  return items;
}

function extractYunquePackageItems(rawBody) {
  const items = [];
  const seenUrls = new Set();

  for (const url of findRegexUrls(
    rawBody,
    /\\?"url\\?"\s*:\s*\\?"(https:\/\/.+?)\\?"/gi
  )) {
    addItem(items, seenUrls, "video", url);
  }

  const json = parseJsonString(rawBody);
  if (json !== null) {
    for (const value of findValuesByKey(json, "url")) {
      const url = normalizeExtractedUrl(value);
      if (url.startsWith("https://")) {
        addItem(items, seenUrls, "video", url);
      }
    }
  }

  return items;
}

function findRegexUrls(text, pattern) {
  const urls = [];
  pattern.lastIndex = 0;
  let match = pattern.exec(text);
  while (match) {
    const url = normalizeExtractedUrl(match[1]);
    if (url) {
      urls.push(url);
    }
    match = pattern.exec(text);
  }
  return urls;
}

function normalizeExtractedUrl(value) {
  return typeof value === "string" ? decodeJsonEscapedFragment(value).trim() : "";
}

function findFallbackApis(json, rawBody, source) {
  const apis = new Set();

  for (const value of findValuesByKey(json, "fallback_api")) {
    addFallbackApi(apis, value, source);
  }

  // 【v1.3.2】主程序 FallbackApiStreamScanner 用 3 条正则覆盖「0/1/2 层 JSON 转义」，
  // 插件原先只有 0 层 + 1 层两条，遇到两层转义的响应（豆包 chain 会把 JSON 再套一层字符串）
  // 就完全匹配不到 → fallback_api 漏掉 → 视频提取为 0（面板显示"未提取到资源"）。
  // 这里改成一条通用正则，\\* 吃掉任意层数的转义反斜杠，覆盖 0/1/2/N 层。
  const patterns = [
    /fallback_api\\*"\s*:\s*\\*"(.+?)\\*"/g,
    /"fallback_api"\s*:\s*"([^"]+)"/g
  ];

  for (const pattern of patterns) {
    let match = pattern.exec(rawBody);
    while (match) {
      addFallbackApi(apis, decodeJsonEscapedFragment(match[1]), source);
      match = pattern.exec(rawBody);
    }
  }

  return Array.from(apis);
}

function addFallbackApi(apis, value, source) {
  if (typeof value !== "string" || !value) {
    return;
  }

  const url = decodeJsonEscapedFragment(value);
  if (isAllowedFallbackApiUrl(url)) {
    apis.add(url);
  }
}

// 【v1.3.2】与主程序 LocalVideoResolver.BuildRequestUri 对齐：只要求「绝对 URL + http/https + 有主机名」，
// 不再限制域名，也不再强制 https。平台换 CDN 域时不会再被静默丢弃。
function isAllowedFallbackApiUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return false;
    }
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
    if (!hostname || hostname === "localhost" || hostname.endsWith(".local")) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function decodeJsonEscapedFragment(value) {
  let text = value;
  for (let index = 0; index < 3; index += 1) {
    try {
      const decoded = JSON.parse(`"${text.replace(/"/g, '\\"')}"`);
      if (decoded === text) {
        break;
      }
      text = decoded;
    } catch {
      break;
    }
  }
  // 【v1.3.2】补 \u003d → "=" 的还原（与主程序 FallbackApiStreamScanner.DecodeJsonStringLiteral 对齐）
  return text
    .replace(/\\u0026/gi, "&")
    .replace(/\\u003d/gi, "=")
    .replace(/\\\//g, "/");
}

async function getUnwatermarkedVideoUrlFromFallbackApi(fallbackApi, source) {
  if (!isAllowedFallbackApiUrl(fallbackApi)) {
    return "";
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FALLBACK_API_TIMEOUT_MS);
  try {
    const url = replaceQueryParams(fallbackApi, {
      channel: "no",
      codec_type: "8",
      logo_type: "unwatermarked"
    });
    const response = await fetch(url, {
      method: "GET",
      credentials: "omit",
      signal: controller.signal,
      headers: {
        "accept": "application/json,text/plain,*/*"
      }
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    if (response.url && !isAllowedFallbackApiUrl(response.url)) {
      throw new Error("redirected to an unsupported host");
    }
    const payload = await response.json();
    const data = getVideoData(payload);
    const token = pickMainUrlToken(data);
    if (!token) {
      // 【v1.3.2】原实现静默返回，无法区分"接口通了但没 main_url"
      console.warn(`${source} fallback_api 响应里没有 main_url / play_url`);
      return "";
    }
    const responseKeySeed = findKeySeedDeep(payload);
    const urlKeySeed = getQueryParam(url, "key_seed");
    const keySeed = responseKeySeed || urlKeySeed;
    if (token.startsWith("qAAB") && !keySeed) {
      console.warn(`${source} qAAB decode skipped: key_seed was not found`);
      return "";
    }
    const decodedUrl = await decodeMainUrl(token, keySeed);
    if (!decodedUrl) {
      // 【v1.3.2】原实现静默返回，无法区分"解码失败"
      console.warn(`${source} main_url 解码失败，token 前缀=${token.slice(0, 8)} (长度 ${token.length})`);
    }
    return decodedUrl;
  } catch (error) {
    console.warn(`${source} fallback_api failed:`, error.message || error);
    return "";
  } finally {
    clearTimeout(timeoutId);
  }
}

function getCachedUnwatermarkedVideoUrl(fallbackApi, source) {
  const key = mediaFingerprint(fallbackApi);
  const now = Date.now();
  const cached = fallbackVideoCache.get(key);
  if (cached && now - cached.createdAt < FALLBACK_VIDEO_CACHE_TTL_MS) {
    return cached.promise;
  }
  if (cached) {
    fallbackVideoCache.delete(key);
  }

  const promise = getUnwatermarkedVideoUrlFromFallbackApi(fallbackApi, source);
  fallbackVideoCache.set(key, { createdAt: now, promise });
  promise.then((url) => {
    // 未生成完成或解析失败不能长时间缓存，否则会错过后续真正完成的结果。
    if (!url && fallbackVideoCache.get(key)?.promise === promise) {
      fallbackVideoCache.delete(key);
    }
  }, () => {
    if (fallbackVideoCache.get(key)?.promise === promise) {
      fallbackVideoCache.delete(key);
    }
  });

  while (fallbackVideoCache.size > FALLBACK_VIDEO_CACHE_MAX) {
    fallbackVideoCache.delete(fallbackVideoCache.keys().next().value);
  }
  return promise;
}

function replaceQueryParams(url, params) {
  const parsedUrl = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    parsedUrl.searchParams.set(key, value);
  }
  return parsedUrl.toString();
}

function getQueryParam(url, name) {
  try {
    return new URL(url).searchParams.get(name)?.trim() || "";
  } catch {
    return "";
  }
}

function getVideoData(payload) {
  const videoInfo = payload?.video_info || payload?.data?.video_info || payload;
  const data = videoInfo?.data || videoInfo;
  return data && typeof data === "object" ? data : {};
}

function pickMainUrlToken(data) {
  const videoList = data?.video_list;
  const entries = videoList && typeof videoList === "object" && Object.keys(videoList).length
    ? Object.values(videoList)
    : [data];
  let best = null;

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const token = entry.main_url || entry.play_url || "";
    if (typeof token !== "string" || !token.trim()) {
      continue;
    }
    const score = Number(entry.bitrate || entry.real_bitrate || 0)
      + Number(entry.vwidth || entry.width || 0) * Number(entry.vheight || entry.height || 0);
    if (!best || score > best.score) {
      best = { token: token.trim(), score };
    }
  }

  return best ? best.token : "";
}

function findKeySeedDeep(value, depth = 0) {
  if (depth > 10 || value == null) {
    return "";
  }

  if (typeof value === "string") {
    let match = value.match(/(?:^|[?&])key_seed=([^&"'<>\\\s]+)/i);
    if (match) {
      return decodeURIComponent(match[1]);
    }
    match = value.match(/["']key_seed["']\s*:\s*["']([^"']+)/i);
    return match ? decodeURIComponent(match[1]) : "";
  }

  if (typeof value !== "object") {
    return "";
  }

  if (typeof value.key_seed === "string" && value.key_seed.trim()) {
    return value.key_seed.trim();
  }

  for (const item of Object.values(value)) {
    const hit = findKeySeedDeep(item, depth + 1);
    if (hit) {
      return hit;
    }
  }

  return "";
}

async function decodeMainUrl(token, keySeed = "") {
  if (isHttpUrl(token)) {
    return token;
  }

  const plainUrl = tryDecodeBase64Url(token);
  if (plainUrl) {
    return plainUrl;
  }

  if (token.startsWith("qAAB") && keySeed) {
    return await decodeQaabToken(token, keySeed);
  }

  return "";
}

function tryDecodeBase64Url(token) {
  const bytes = base64DecodeLoose(token);
  if (!bytes) {
    return "";
  }
  const text = asciiUrlFromBytes(bytes);
  return isHttpUrl(text) ? text : "";
}

function base64DecodeLoose(text) {
  const input = String(text || "").trim();
  const variants = [
    input,
    input.replace(/[$@#]/g, (char) => ({ "$": "_", "@": "/", "#": "." }[char])),
    input.replace(/[$@#]/g, (char) => ({ "$": "+", "@": "/", "#": "=" }[char]))
  ];
  const seen = new Set();

  for (const candidate of variants) {
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    try {
      const normalized = padBase64(candidate).replace(/-/g, "+").replace(/_/g, "/");
      const binary = atob(normalized);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      return bytes;
    } catch {
      // Try the next variant.
    }
  }

  return null;
}

function padBase64(text) {
  const pad = (4 - (text.length % 4)) % 4;
  return text + "=".repeat(pad);
}

function asciiUrlFromBytes(bytes) {
  if (!bytes || !bytes.length) {
    return "";
  }
  for (const byte of bytes) {
    if (byte !== 9 && byte !== 10 && byte !== 13 && (byte < 32 || byte > 126)) {
      return "";
    }
  }
  return new TextDecoder().decode(bytes);
}

async function decodeQaabToken(token, keySeed) {
  const data = base64DecodeLoose(token);
  const seed = base64DecodeLoose(keySeed);
  if (!data || !seed) {
    return "";
  }

  const digest1 = await crypto.subtle.digest("SHA-512", seed.slice(0, 32));
  const salt = hexToBytes(QAAB_SALT_HEX);
  const digest2Input = concatBytes(new Uint8Array(digest1), salt);
  const digest2 = new Uint8Array(await crypto.subtle.digest("SHA-512", digest2Input));
  const key = digest2.slice(0, 16);
  const iv = digest2.slice(16, 32);
  const attempts = [];

  if (data.length >= 4 && data[0] === 0xa8 && data[1] === 0x00 && data[2] === 0x01 && data[3] === 0x00) {
    attempts.push({ payload: data.slice(4), key, iv });
    attempts.push({ payload: data.slice(4), key: iv, iv: key });
    if (data.length > 36) {
      attempts.push({ payload: data.slice(36), key, iv: data.slice(20, 36) });
      attempts.push({ payload: data.slice(36), key, iv });
    }
  } else {
    attempts.push({ payload: data, key, iv });
  }

  for (const attempt of attempts) {
    const url = await decryptAesCbcUrl(attempt.payload, attempt.key, attempt.iv);
    if (url) {
      return url;
    }
  }

  return "";
}

async function decryptAesCbcUrl(payload, keyBytes, ivBytes) {
  if (!payload.length || payload.length % 16 !== 0) {
    return "";
  }

  try {
    const key = await crypto.subtle.importKey("raw", keyBytes, "AES-CBC", false, ["decrypt"]);
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv: ivBytes }, key, payload));
    const direct = asciiUrlFromBytes(plain);
    if (isHttpUrl(direct)) {
      return direct;
    }
    const stripped = stripPkcs7(plain);
    const url = asciiUrlFromBytes(stripped);
    return isHttpUrl(url) ? url : "";
  } catch {
    return "";
  }
}

function stripPkcs7(bytes) {
  if (!bytes || !bytes.length) {
    return new Uint8Array();
  }
  const pad = bytes[bytes.length - 1];
  if (pad < 1 || pad > 16 || pad > bytes.length) {
    return bytes;
  }
  for (let index = bytes.length - pad; index < bytes.length; index += 1) {
    if (bytes[index] !== pad) {
      return bytes;
    }
  }
  return bytes.slice(0, bytes.length - pad);
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function concatBytes(first, second) {
  const bytes = new Uint8Array(first.length + second.length);
  bytes.set(first, 0);
  bytes.set(second, first.length);
  return bytes;
}

function patchActionBarDuration(body) {
  try {
    const json = JSON.parse(body);
    const changed = patchNestedJsonStrings(json);
    return changed ? JSON.stringify(json) : body;
  } catch (error) {
    console.warn("patch action bar duration failed:", error.message || error);
    return body;
  }
}

function patchNestedJsonStrings(value, seen = new Set()) {
  if (value == null || typeof value !== "object" || seen.has(value)) {
    return false;
  }

  seen.add(value);
  let changed = false;

  if (Array.isArray(value)) {
    for (const item of value) {
      changed = patchNestedJsonStrings(item, seen) || changed;
    }
    return changed;
  }

  for (const key of Object.keys(value)) {
    const child = value[key];
    if (typeof child === "string") {
      const patchedString = patchJsonStringDuration(child);
      if (patchedString !== child) {
        value[key] = patchedString;
        changed = true;
      }
    } else {
      changed = patchNestedJsonStrings(child, seen) || changed;
    }
  }

  return changed;
}

function patchJsonStringDuration(text) {
  if (!text || (!text.includes("时长") && !text.includes("鏃堕暱"))) {
    return text;
  }

  try {
    const json = JSON.parse(text);
    const changed = patchDurationSelector(json);
    return changed ? JSON.stringify(json) : text;
  } catch {
    return text;
  }
}

function patchDurationSelector(value, seen = new Set()) {
  if (value == null || typeof value !== "object" || seen.has(value)) {
    return false;
  }

  seen.add(value);
  let changed = false;

  if (Array.isArray(value)) {
    for (const item of value) {
      changed = patchDurationSelector(item, seen) || changed;
    }
    return changed;
  }

  if ((value.label === "时长" || value.label === "鏃堕暱") && Array.isArray(value.option_list)) {
    const has15s = value.option_list.some((option) => option && option.option_key === "15");
    if (!has15s) {
      const tenSecondIndex = value.option_list.findIndex((option) => option && option.option_key === "10");
      const insertIndex = tenSecondIndex >= 0 ? tenSecondIndex + 1 : value.option_list.length;
      value.option_list.splice(insertIndex, 0, createFifteenSecondOption(value.option_list));
      changed = true;
    }
    const has30s = value.option_list.some((option) => option && option.option_key === "30");
    if (!has30s) {
      value.option_list.push(createThirtySecondOption(value.option_list));
      changed = true;
    }
  }

  for (const key of Object.keys(value)) {
    const child = value[key];
    if (typeof child === "string") {
      const patchedString = patchJsonStringDuration(child);
      if (patchedString !== child) {
        value[key] = patchedString;
        changed = true;
      }
    } else {
      changed = patchDurationSelector(child, seen) || changed;
    }
  }

  return changed;
}

function createFifteenSecondOption(optionList) {
  const maxId = optionList.reduce((maxValue, option) => {
    const id = Number(option?.id);
    return Number.isFinite(id) ? Math.max(maxValue, id) : maxValue;
  }, 0);

  return {
    id: maxId + 1,
    display_text: "15s",
    message_text: "",
    option_key: "15"
  };
}

function createThirtySecondOption(optionList) {
  const maxId = optionList.reduce((maxValue, option) => {
    const id = Number(option?.id);
    return Number.isFinite(id) ? Math.max(maxValue, id) : maxValue;
  }, 0);

  return {
    id: maxId + 1,
    display_text: "30s",
    message_text: "",
    option_key: "30"
  };
}

function findImageOriRawUrls(value) {
  const urls = [];
  walkJsonAndStrings(value, (node) => {
    if (node && typeof node === "object" && !Array.isArray(node)) {
      const image = node.image_ori_raw;
      if (image && typeof image === "object" && isHttpUrl(image.url)) {
        urls.push(image.url);
      }
    }
  });
  return urls;
}

// 【修复】从原始响应文本里用正则捞 image_ori_raw.url，不依赖整段 JSON 可解析。
// 背景：豆包的 /im/chain/single 响应不是单个合法 JSON（多段拼接/外层包装），
// 结构化遍历拿不到任何节点，只能靠正则。
// 覆盖两种转义层级：普通 JSON（"image_ori_raw":{"url":...}）与
// JSON-in-JSON（\"image_ori_raw\":{\"url\":...}）。
function findImageOriRawUrlsFromBody(rawBody) {
  const urls = [];
  if (typeof rawBody !== "string" || !rawBody) {
    return urls;
  }

  const patterns = [
    /"image_ori_raw"\s*:\s*\{[\s\S]{0,600}?"url"\s*:\s*"([^"]+)"/g,
    /\\"image_ori_raw\\"\s*:\s*\{[\s\S]{0,600}?\\"url\\"\s*:\s*\\"([^"\\]+)\\"/g
  ];

  for (const pattern of patterns) {
    for (const url of findRegexUrls(rawBody, pattern)) {
      if (isHttpUrl(url)) {
        urls.push(url);
      }
    }
  }
  return urls;
}

function findValuesByKey(value, targetKey) {
  const values = [];
  walkJsonAndStrings(value, (node) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      return;
    }
    if (Object.prototype.hasOwnProperty.call(node, targetKey)) {
      values.push(node[targetKey]);
    }
  });
  return values;
}

function walkJsonAndStrings(value, visitor, seen = new Set()) {
  if (value == null) {
    return;
  }

  if (typeof value === "string") {
    const parsed = parseJsonString(value);
    if (parsed !== null) {
      walkJsonAndStrings(parsed, visitor, seen);
    }
    return;
  }

  if (typeof value !== "object" || seen.has(value)) {
    return;
  }

  seen.add(value);
  visitor(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      walkJsonAndStrings(item, visitor, seen);
    }
    return;
  }

  for (const key of Object.keys(value)) {
    walkJsonAndStrings(value[key], visitor, seen);
  }
}

function parseJsonString(text) {
  const trimmed = text.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function addItem(items, seenUrls, type, url) {
  const fingerprint = mediaFingerprint(url);
  const key = `${type}:${fingerprint}`;
  if (!isHttpUrl(url) || seenUrls.has(key)) {
    return false;
  }
  seenUrls.add(key);
  items.push({ type, url });
  return true;
}

function mediaFingerprint(rawUrl) {
  try {
    const url = new URL(rawUrl);
    url.hash = "";
    for (const key of Array.from(url.searchParams.keys())) {
      if (isVolatileMediaQueryKey(key)) {
        url.searchParams.delete(key);
      }
    }
    url.searchParams.sort();
    return url.toString();
  } catch {
    return String(rawUrl || "").split("#", 1)[0];
  }
}

function isVolatileMediaQueryKey(key) {
  const normalized = String(key || "").toLowerCase();
  return /^(?:x-amz-|x-oss-|x-cos-|x-qn-)/.test(normalized) ||
    /^(?:sign|signature|token|access_token|auth|auth_key|authorization|expires?|expire_at|timestamp|ts|wssecret|wstime|policy|key-pair-id)$/.test(normalized);
}

function buildDownloadFilename(rawUrl, mediaType, mimeType = "") {
  const isVideo = mediaType !== "image";
  const fallbackExtension = isVideo ? ".mp4" : ".jpg";
  let extension = fallbackExtension;
  let baseName = "";
  const mime = String(mimeType || "").toLowerCase();
  const mimeExtensions = isVideo
    ? { "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov" }
    : { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif", "image/avif": ".avif" };
  if (mimeExtensions[mime]) extension = mimeExtensions[mime];
  try {
    const urlObj = new URL(rawUrl);
    baseName = decodeURIComponent(urlObj.pathname.split("/").pop() || "");
    const match = baseName.match(/\.([a-zA-Z0-9]{2,5})$/);
    if (match) {
      const ext = match[1].toLowerCase();
      const valid = isVideo ? ["mp4", "m4v", "mov", "webm", "mkv"] : ["png", "jpg", "jpeg", "webp", "gif", "avif"];
      if (valid.includes(ext) && !mimeExtensions[mime]) {
        extension = `.${ext === "jpeg" ? "jpg" : ext}`;
      }
    }
  } catch {
    baseName = "";
  }
  baseName = baseName.replace(/\.[a-zA-Z0-9]{2,5}$/, "").replace(/[<>:\"/\\|?*\x00-\x1F]/g, "_").replace(/[. ]+$/, "").slice(0, 100);

  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

  if (!baseName || baseName === "download" || baseName === "videoplayback" || baseName.startsWith("blob")) {
    baseName = `哆啦助手${isVideo ? "视频" : "图片"}_${stamp}`;
  } else if (!baseName.includes("哆啦助手") && !baseName.includes("Dola")) {
    baseName = `哆啦助手_${baseName}_${stamp}`;
  }
  return `${baseName}${extension}`;
}

function responseHeadersForTextBody(headers, body) {
  const contentLength = String(new TextEncoder().encode(body).length);
  const nextHeaders = [];
  let hasContentType = false;
  let hasContentLength = false;

  for (const header of headers) {
    const name = header.name || "";
    const lowerName = name.toLowerCase();
    if (lowerName === "content-encoding") {
      continue;
    }

    if (lowerName === "content-type") {
      hasContentType = true;
      nextHeaders.push({ name, value: "application/json; charset=utf-8" });
      continue;
    }

    if (lowerName === "content-length") {
      hasContentLength = true;
      nextHeaders.push({ name, value: contentLength });
      continue;
    }

    nextHeaders.push(header);
  }

  if (!hasContentType) {
    nextHeaders.push({ name: "content-type", value: "application/json; charset=utf-8" });
  }

  if (!hasContentLength) {
    nextHeaders.push({ name: "content-length", value: contentLength });
  }

  return nextHeaders;
}

function getResponseFileBody(fileName) {
  if (!responseFileBodyPromises.has(fileName)) {
    responseFileBodyPromises.set(fileName, fetch(chrome.runtime.getURL(fileName)).then((response) => response.text()));
  }
  return responseFileBodyPromises.get(fileName);
}

function corsHeaders() {
  return [
    { name: "access-control-allow-origin", value: "*" },
    { name: "access-control-allow-credentials", value: "true" },
    { name: "access-control-allow-methods", value: "GET, POST, OPTIONS" },
    { name: "access-control-allow-headers", value: "*" }
  ];
}

function toBase64Utf8(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function fromBase64Utf8(base64Text) {
  const binary = atob(base64Text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
}

function isHttpUrl(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

async function sendToTab(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    console.warn("send panel message failed:", error.message || error);
  }
}

function setBadge(tabId, text) {
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#166534" }).catch(() => {});
}
