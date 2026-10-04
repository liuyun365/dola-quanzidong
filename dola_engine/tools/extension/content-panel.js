(function () {
  const PANEL_ID = "watermark-free-media-panel";
  const INSTANCE_KEY = "__watermarkFreeMediaPanelActive";
  const DURATION_KEY = "intl_doubao_enable_30s_v1";
  const TARGET_DURATION_KEY = "intl_doubao_target_duration_v1";
  const DURATION_STATE_ATTRIBUTE = "data-watermark-free-duration-30";
  const DURATION_STATE_EVENT = "watermark-free-duration-30-change";
  const MEDIA_APIS_ATTRIBUTE = "data-dola-media-fallback-apis";
  const MEDIA_APIS_EVENT = "dola-media-fallback-apis";
  const MINIMIZED_KEY = "intl_doubao_media_panel_minimized_v1";
  const PANEL_POS_KEY = "intl_doubao_media_panel_pos_v1";
  const EXPANDED_PANEL_RIGHT_PX = 16;
  const EXPANDED_PANEL_BOTTOM_PX = 160;
  const PARSE_PANEL_KEY = "intl_doubao_media_panel_parse_v1";
  const PROMPT_GUARD_INJECT_KEY = "intl_doubao_prompt_guard_inject_v1";
  const items = new Map();

  if (globalThis[INSTANCE_KEY]) {
    return;
  }
  globalThis[INSTANCE_KEY] = true;

  const existingHost = document.getElementById(PANEL_ID);
  existingHost?.remove();

  const host = document.createElement("div");
  host.id = PANEL_ID;
  forceHostVisible();
  mountHost();

  const shadow = host.attachShadow({ mode: "open" });
  const LOGO_URL = chrome.runtime.getURL("icons/logo96.png");
  shadow.innerHTML = `
    <style>
      :host {
        all: initial;
        position: fixed;
        top: auto;
        right: 16px;
        bottom: 160px;
        z-index: 2147483647;
        font-family: "Microsoft YaHei UI", "Microsoft YaHei", Arial, sans-serif;
      }

      .panel {
        width: 200px;
        max-height: 420px;
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        color: #34304B;
        background: #FFFFFF;
        border: 1px solid rgba(122, 92, 240, 0.16);
        border-radius: 14px;
        box-shadow: 0 16px 44px rgba(122, 92, 240, 0.28);
        overflow: hidden;
      }

      /* ===== 品牌头部：哆啦助手渐变 ===== */
      .header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 10px 8px 12px;
        background: linear-gradient(100deg, #7A5CF0 0%, #B46FE0 55%, #5AA9F0 100%);
        cursor: grab;
        touch-action: none;
        user-select: none;
      }

      .header:active {
        cursor: grabbing;
      }

      .logo {
        width: 22px;
        height: 22px;
        min-width: 22px;
        border-radius: 6px;
        object-fit: contain;
        display: block;
      }

      .title {
        flex: 1;
        min-width: 0;
        color: #fff;
        font-size: 13px;
        line-height: 20px;
        font-weight: 700;
        letter-spacing: 0.2px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .panel-toggle {
        width: 26px;
        min-width: 26px;
        height: 26px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        border: 0;
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.22);
        color: #fff;
        font-size: 16px;
        line-height: 1;
        cursor: pointer;
        transition: background 0.15s ease;
      }

      .panel-toggle:hover {
        background: rgba(255, 255, 255, 0.38);
      }

      .panel-toggle-icon {
        display: block;
        line-height: 16px;
      }

      /* ===== 开关行：左横向开关，右文字 ===== */
      .switch-rows,
      .parse-block {
        padding: 8px 12px;
        background: #F8F5FE;
        border-bottom: 1px solid #EFE8FB;
      }

      .switch-rows {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }

      .switch-row {
        display: flex;
        flex-direction: row;
        align-items: center;
        gap: 10px;
        min-height: 32px;
      }

      .switch-label {
        flex: 1;
        min-width: 0;
        font-size: 12px;
        line-height: 16px;
        font-weight: 600;
        color: #6E6A88;
        user-select: none;
      }

      .switch-label.on {
        color: #2E9E5B;
      }

      .switch {
        position: relative;
        display: inline-block;
        flex-shrink: 0;
        width: 38px;
        height: 22px;
        min-width: 38px;
        cursor: pointer;
        -webkit-user-select: none;
        user-select: none;
      }

      .switch input {
        position: absolute;
        width: 0;
        height: 0;
        opacity: 0;
        margin: 0;
      }

      .switch .track {
        position: absolute;
        inset: 0;
        border-radius: 999px;
        background: #D8D2E8;
        transition: background 0.18s ease;
      }

      .switch .thumb {
        position: absolute;
        top: 2px;
        left: 2px;
        width: 18px;
        height: 18px;
        border-radius: 50%;
        background: #fff;
        box-shadow: 0 1px 3px rgba(52, 48, 75, 0.3);
        transition: transform 0.18s ease;
      }

      .switch input:checked + .track {
        background: linear-gradient(100deg, #3FBF7F, #2FBF71);
      }

      .switch input:checked + .track .thumb {
        transform: translateX(16px);
      }

      .parse-block {
        padding-top: 6px;
        padding-bottom: 8px;
      }

      .list-panel {
        display: none;
        flex-direction: column;
        background: #fff;
      }

      .list-panel[data-open="1"] {
        display: flex;
      }

      .list-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 8px 12px 6px;
        border-bottom: 1px solid #EFE8FB;
        background: #FAFAFE;
      }

      .list-head-title {
        font-size: 12px;
        font-weight: 700;
        color: #6A4BD8;
      }

      .list-count {
        min-width: 22px;
        height: 22px;
        padding: 0 8px;
        border-radius: 999px;
        background: linear-gradient(100deg, #7A5CF0, #9A7BF4);
        color: #fff;
        font-size: 12px;
        line-height: 22px;
        font-weight: 700;
        text-align: center;
        font-variant-numeric: tabular-nums;
      }

      /* ===== 资源列表 ===== */
      .list {
        min-height: 72px;
        max-height: 280px;
        overflow: auto;
        padding: 8px;
        background: #FFFFFF;
      }

      .empty {
        padding: 20px 10px;
        color: #A79FBE;
        font-size: 13px;
        line-height: 20px;
        text-align: center;
      }

      .item {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 8px;
        align-items: center;
        padding: 7px 8px;
        border: 1px solid #EAE3F7;
        border-radius: 10px;
        background: #FFFFFF;
      }

      .item + .item {
        margin-top: 6px;
      }

      .label {
        min-width: 0;
        color: #34304B;
        font-size: 13px;
        line-height: 18px;
        font-weight: 600;
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .label .index {
        color: #B3AACB;
        font-size: 11px;
        font-weight: 400;
        font-variant-numeric: tabular-nums;
      }

      .tag {
        display: inline-block;
        min-width: 32px;
        padding: 1px 6px;
        border-radius: 999px;
        color: #fff;
        font-size: 11px;
        font-weight: 700;
        line-height: 16px;
        text-align: center;
      }

      .tag.video {
        background: linear-gradient(100deg, #7A5CF0, #9A7BF4);
      }

      .tag.image {
        background: linear-gradient(100deg, #14B8A6, #2BB3A3);
      }

      button.dl {
        height: 28px;
        padding: 0 14px;
        border: 0;
        border-radius: 8px;
        background: linear-gradient(100deg, #7A5CF0, #9A7BF4);
        color: #fff;
        font-size: 12px;
        font-weight: 600;
        line-height: 28px;
        cursor: pointer;
        transition: filter 0.15s ease;
      }

      button.dl:hover {
        filter: brightness(1.08);
      }

      /* ===== 收起：默认小圆圈，点击展开，收起时 50% 透明度 ===== */
      :host([data-minimized="1"]) .panel {
        width: 44px;
        height: 44px;
        min-width: 44px;
        border-radius: 50%;
        border: none;
        background: linear-gradient(100deg, #7A5CF0 0%, #B46FE0 55%, #5AA9F0 100%);
        box-shadow: 0 8px 20px rgba(122, 92, 240, 0.35);
        justify-content: center;
        align-items: center;
        overflow: hidden;
        opacity: 0.5;
        transition: opacity 0.18s ease, border-radius 0.18s ease;
      }
      :host([data-minimized="1"]) .panel:hover {
        opacity: 0.8;
      }
      :host([data-minimized="1"]) .header {
        background: transparent;
        justify-content: center;
        align-items: center;
        padding: 0;
        gap: 0;
        width: 100%;
        height: 100%;
      }
      :host([data-minimized="1"]) .title,
      :host([data-minimized="1"]) .panel-toggle,
      :host([data-minimized="1"]) .switch-rows,
      :host([data-minimized="1"]) .parse-block,
      :host([data-minimized="1"]) .list-panel {
        display: none;
      }
      :host([data-minimized="1"]) .logo {
        width: 26px;
        height: 26px;
        min-width: 26px;
        border-radius: 8px;
      }
    </style>
    <section class="panel" aria-label="哆啦助手 无水印资源面板">
      <div class="header">
        <div class="title">哆啦助手 · 无水印助手</div>
        <button class="panel-toggle" type="button" aria-label="最小化资源面板" title="最小化资源面板">
          <span class="panel-toggle-icon" aria-hidden="true">−</span>
        </button>
      </div>
      <div class="switch-rows">
        <div class="switch-row">
          <label class="switch" title="Seedance 2.5 + 30 秒">
            <input class="duration-toggle" type="checkbox">
            <span class="track"><span class="thumb"></span></span>
          </label>
          <span class="switch-label switch-label-duration">Seedance 2.5 + 30 秒</span>
        </div>
        <div class="switch-row">
          <label class="switch" title="开启 Debugger 深度嗅探">
            <input class="sniff-deep-toggle" type="checkbox">
            <span class="track"><span class="thumb"></span></span>
          </label>
          <span class="switch-label switch-label-deep">深度嗅探</span>
        </div>
        <div class="switch-row">
          <label class="switch" title="自动 Debugger 嗅探">
            <input class="sniff-auto" type="checkbox">
            <span class="track"><span class="thumb"></span></span>
          </label>
          <span class="switch-label switch-label-auto">自动嗅探</span>
        </div>
        <div class="switch-row">
          <label class="switch" title="发送时在正文前注入【直接生成控制】等指令（关闭则仅保留秒数换算，不附加控制段）">
            <input class="prompt-guard-toggle" type="checkbox">
            <span class="track"><span class="thumb"></span></span>
          </label>
          <span class="switch-label switch-label-guard">控制指令</span>
        </div>
      </div>
      <div class="parse-block">
        <div class="switch-row">
          <label class="switch" title="展开资源解析列表">
            <input class="parse-panel-toggle" type="checkbox">
            <span class="track"><span class="thumb"></span></span>
          </label>
          <span class="switch-label switch-label-parse">解析列表</span>
        </div>
      </div>
      <div class="list-panel" data-open="0">
        <div class="list-head">
          <span class="list-head-title">资源</span>
          <span class="list-count">0</span>
        </div>
        <div class="list">
          <div class="empty">等待捕获资源…</div>
        </div>
      </div>
    </section>
  `;

  const list = shadow.querySelector(".list");
  const listCount = shadow.querySelector(".list-count");
  const listPanel = shadow.querySelector(".list-panel");
  const parsePanelToggle = shadow.querySelector(".parse-panel-toggle");
  const parseLabel = shadow.querySelector(".switch-label-parse");
  const durationToggle = shadow.querySelector(".duration-toggle");
  const durationLabel = shadow.querySelector(".switch-label-duration");
  const switchRows = shadow.querySelector(".switch-rows");
  const parseBlock = shadow.querySelector(".parse-block");
  const sniffDeepToggle = shadow.querySelector(".sniff-deep-toggle");
  const sniffAuto = shadow.querySelector(".sniff-auto");
  const sniffDeepLabel = shadow.querySelector(".switch-label-deep");
  const sniffAutoLabel = shadow.querySelector(".switch-label-auto");
  const promptGuardToggle = shadow.querySelector(".prompt-guard-toggle");
  const promptGuardLabel = shadow.querySelector(".switch-label-guard");
  const panelToggle = shadow.querySelector(".panel-toggle");
  const panelToggleIcon = shadow.querySelector(".panel-toggle-icon");
  const durationControlSupported = /(^|\.)(doubao|dola)\.com$/i.test(location.hostname);
  const sniffControlSupported = durationControlSupported;
  let currentSourceKey = "";
  let statusText = "等待捕获资源";
  let minimized = false;

  function readMinimizedState() {
    try {
      return localStorage.getItem(MINIMIZED_KEY) === "1";
    } catch {
      return false;
    }
  }

  function setMinimizedState(nextValue, persist = true) {
    minimized = Boolean(nextValue);
    if (minimized) {
      host.setAttribute("data-minimized", "1");
    } else {
      host.removeAttribute("data-minimized");
    }
    if (persist) {
      try {
        localStorage.setItem(MINIMIZED_KEY, minimized ? "1" : "0");
      } catch {
        // Keep the current visual state when storage is unavailable.
      }
    }
    const label = minimized ? "展开资源面板" : "最小化资源面板";
    panelToggle.setAttribute("aria-label", label);
    panelToggle.setAttribute("title", label);
    panelToggleIcon.textContent = minimized ? "＋" : "−";
  }

  try {
    const stored = localStorage.getItem(MINIMIZED_KEY);
    setMinimizedState(stored === null ? true : stored === "1", false);
  } catch {
    setMinimizedState(true, false);
  }
  panelToggle.addEventListener("click", (event) => {
    event.stopPropagation();
    setMinimizedState(!minimized);
  });
  // 收起成小圆圈时：点击圆圈整体展开
  host.addEventListener("click", () => {
    if (minimized) {
      setMinimizedState(false);
    }
  });

  const panelHeader = shadow.querySelector(".header");
  let dragSession = null;

  function readPanelOffset() {
    const right = parseFloat(host.style.getPropertyValue("right"));
    const bottom = parseFloat(host.style.getPropertyValue("bottom"));
    return {
      right: Number.isFinite(right) ? right : EXPANDED_PANEL_RIGHT_PX,
      bottom: Number.isFinite(bottom) ? bottom : EXPANDED_PANEL_BOTTOM_PX
    };
  }

  function applyPanelOffset(right, bottom) {
    const clampedRight = Math.max(8, Math.min(window.innerWidth - 48, right));
    const clampedBottom = Math.max(8, Math.min(window.innerHeight - 48, bottom));
    host.style.setProperty("right", `${clampedRight}px`, "important");
    host.style.setProperty("bottom", `${clampedBottom}px`, "important");
    host.style.setProperty("left", "auto", "important");
    host.style.setProperty("top", "auto", "important");
    return { right: clampedRight, bottom: clampedBottom };
  }

  function restorePanelOffset() {
    try {
      const raw = localStorage.getItem(PANEL_POS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (typeof parsed?.right === "number" && typeof parsed?.bottom === "number") {
        applyPanelOffset(parsed.right, parsed.bottom);
      }
    } catch {
      // ignore
    }
  }

  function persistPanelOffset() {
    const { right, bottom } = readPanelOffset();
    try {
      localStorage.setItem(PANEL_POS_KEY, JSON.stringify({ right, bottom }));
    } catch {
      // ignore
    }
  }

  restorePanelOffset();

  panelHeader?.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest(".panel-toggle")) {
      return;
    }
    const offset = readPanelOffset();
    dragSession = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startRight: offset.right,
      startBottom: offset.bottom
    };
    panelHeader.setPointerCapture(event.pointerId);
    event.preventDefault();
  });

  panelHeader?.addEventListener("pointermove", (event) => {
    if (!dragSession || event.pointerId !== dragSession.pointerId) {
      return;
    }
    const dx = event.clientX - dragSession.startX;
    const dy = event.clientY - dragSession.startY;
    applyPanelOffset(dragSession.startRight - dx, dragSession.startBottom - dy);
  });

  function finishDrag(event) {
    if (!dragSession || event.pointerId !== dragSession.pointerId) {
      return;
    }
    dragSession = null;
    try {
      panelHeader.releasePointerCapture(event.pointerId);
    } catch {
      // ignore
    }
    persistPanelOffset();
  }

  panelHeader?.addEventListener("pointerup", finishDrag);
  panelHeader?.addEventListener("pointercancel", finishDrag);

  function readParsePanelState() {
    try {
      const v = localStorage.getItem(PARSE_PANEL_KEY);
      if (v === null || v === "") return false;
      return v === "1";
    } catch {
      return false;
    }
  }

  function setParsePanelOpen(open, persist = true) {
    const on = Boolean(open);
    if (parsePanelToggle) parsePanelToggle.checked = on;
    if (listPanel) listPanel.setAttribute("data-open", on ? "1" : "0");
    if (parseLabel) parseLabel.classList.toggle("on", on);
    if (persist) {
      try {
        localStorage.setItem(PARSE_PANEL_KEY, on ? "1" : "0");
      } catch {
        // ignore
      }
    }
    if (on) render();
  }

  setParsePanelOpen(readParsePanelState(), false);
  parsePanelToggle?.addEventListener("change", () => {
    setParsePanelOpen(!!parsePanelToggle.checked);
  });

  if (durationControlSupported) {
    syncDurationControl();
    durationToggle.addEventListener("change", () => {
      setDuration30Enabled(durationToggle.checked);
    });
    document.addEventListener(DURATION_STATE_EVENT, syncDurationControl);
  } else if (switchRows) {
    switchRows.remove();
  }

  if (sniffControlSupported) {
    chrome.runtime.sendMessage({ type: "GET_AUTO_DEBUGGER_SNIFF" }, (response) => {
      if (!chrome.runtime.lastError && response?.ok && sniffAuto) {
        sniffAuto.checked = !!response.enabled;
        syncSniffAutoLabel();
      }
    });
    sniffDeepToggle?.addEventListener("change", () => {
      if (!sniffDeepToggle.checked) {
        syncSniffDeepLabel();
        return;
      }
      sniffDeepToggle.disabled = true;
      chrome.runtime.sendMessage({ type: "ENABLE_DEBUGGER_SNIFF" }, (response) => {
        sniffDeepToggle.disabled = false;
        if (!response?.ok) {
          sniffDeepToggle.checked = false;
        }
        syncSniffDeepLabel();
      });
    });
    sniffAuto?.addEventListener("change", () => {
      chrome.runtime.sendMessage({
        type: "SET_AUTO_DEBUGGER_SNIFF",
        enabled: !!sniffAuto.checked
      });
      syncSniffAutoLabel();
    });
    syncSniffDeepLabel();
    syncSniffAutoLabel();
  } else if (switchRows && !durationControlSupported) {
    switchRows.remove();
  }

  function readPromptGuardInjectState() {
    try {
      return localStorage.getItem(PROMPT_GUARD_INJECT_KEY) === "1";
    } catch {
      return false;
    }
  }

  function setPromptGuardInject(enabled, persist = true) {
    const on = Boolean(enabled);
    if (promptGuardToggle) promptGuardToggle.checked = on;
    if (promptGuardLabel) promptGuardLabel.classList.toggle("on", on);
    if (persist) {
      try {
        localStorage.setItem(PROMPT_GUARD_INJECT_KEY, on ? "1" : "0");
      } catch {
        // ignore
      }
    }
  }

  if (durationControlSupported && promptGuardToggle) {
    setPromptGuardInject(readPromptGuardInjectState(), false);
    promptGuardToggle.addEventListener("change", () => {
      setPromptGuardInject(!!promptGuardToggle.checked);
    });
  }

  function syncSniffDeepLabel() {
    if (!sniffDeepLabel || !sniffDeepToggle) return;
    sniffDeepLabel.classList.toggle("on", sniffDeepToggle.checked);
  }

  function syncSniffAutoLabel() {
    if (!sniffAutoLabel || !sniffAuto) return;
    sniffAutoLabel.classList.toggle("on", sniffAuto.checked);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message) {
      return;
    }

    if (message.type === "PANEL_PING") {
      sendResponse({ ready: true });
      return;
    }

    if (message.type === "MEDIA_STATUS" && typeof message.text === "string") {
      resetForSource(message.sourceKey);
      if (!items.size) {
        statusText = message.text;
      }
      render();
      return;
    }

    if (message.type === "MEDIA_FOUND" && Array.isArray(message.items)) {
      resetForSource(message.sourceKey);
      addItems(message.items);
      statusText = items.size ? "" : "未提取到资源";
      render();
      return;
    }

    if (message.type === "MEDIA_RESET") {
      currentSourceKey = typeof message.sourceKey === "string" ? message.sourceKey : "";
      items.clear();
      statusText = "";
      render();
      return;
    }

  });

  function consumeFallbackApis() {
    if (listPanel?.getAttribute("data-open") !== "1") return;
    const raw = document.documentElement?.getAttribute(MEDIA_APIS_ATTRIBUTE) || "";
    if (!raw) return;
    document.documentElement?.removeAttribute(MEDIA_APIS_ATTRIBUTE);
    try {
      const urls = JSON.parse(raw);
      if (!Array.isArray(urls) || !urls.length) return;
      statusText = "正在解析无水印资源…";
      render();
      const requestStartedAt = Date.now();
      chrome.runtime.sendMessage({ type: "RESOLVE_FALLBACK_APIS", urls }, (response) => {
        if (chrome.runtime.lastError) {
          if (!items.size) {
            statusText = "后台解析未完成，请切换会话后重试";
            render();
          }
          return;
        }
        if (response?.ok === false && !items.size) {
          statusText = "无水印资源解析失败";
          render();
        }
      });
      setTimeout(() => {
        if (!items.size && statusText === "正在解析无水印资源…" && Date.now() - requestStartedAt >= 12000) {
          statusText = "本次未解析到资源，请切换会话后重试";
          render();
        }
      }, 12000);
    } catch {
      // Ignore malformed cross-world payloads.
    }
  }

  document.addEventListener(MEDIA_APIS_EVENT, consumeFallbackApis);
  consumeFallbackApis();

  function resetForSource(sourceKey) {
    if (typeof sourceKey !== "string" || !sourceKey) {
      return;
    }

    if (sourceKey !== currentSourceKey) {
      currentSourceKey = sourceKey;
      items.clear();
      statusText = "";
    }
  }

  function duration30Enabled() {
    try {
      return localStorage.getItem(DURATION_KEY) === "1";
    } catch {
      return false;
    }
  }

  function setDuration30Enabled(enabled) {
    try {
      localStorage.setItem(DURATION_KEY, enabled ? "1" : "0");
      localStorage.setItem(TARGET_DURATION_KEY, enabled ? "30" : "15");
    } catch {
      return;
    }
    document.documentElement?.setAttribute(DURATION_STATE_ATTRIBUTE, enabled ? "1" : "0");
    document.dispatchEvent(new Event(DURATION_STATE_EVENT));
    syncDurationControl();
  }

  function syncDurationControl() {
    let selected = duration30Enabled() ? 30 : 15;
    try {
      const explicit = Number(localStorage.getItem(TARGET_DURATION_KEY));
      if (explicit === 15 || explicit === 30) selected = explicit;
    } catch {
      // Keep the legacy switch value.
    }
    const enabled = selected === 30;
    durationToggle.checked = enabled;
    if (durationLabel) {
      durationLabel.textContent = "Seedance 2.5 + 30 秒";
      durationLabel.classList.toggle("on", enabled);
      durationLabel.title = enabled ? `2.5 · ${selected}s 已开启` : `当前 ${selected}s，开启为 2.5 · 30s`;
    }
    const durSwitch = durationToggle.closest(".switch");
    if (durSwitch) {
      durSwitch.title = enabled ? `Seedance 2.5 · ${selected}s` : "开启 Seedance 2.5 · 30s";
    }
  }

  function render() {
    if (!listPanel || listPanel.getAttribute("data-open") !== "1") {
      return;
    }
    if (listCount) listCount.textContent = String(items.size);
    list.textContent = "";

    if (!items.size) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = statusText || "等待捕获资源…";
      list.appendChild(empty);
      return;
    }

    Array.from(items.values()).forEach((item, index) => {
      const row = document.createElement("div");
      row.className = "item";

      const label = document.createElement("div");
      label.className = "label";
      label.title = item.url;

      const tag = document.createElement("span");
      tag.className = `tag ${item.type}`;
      tag.textContent = item.type === "image" ? "图片" : "视频";

      const indexText = document.createElement("span");
      indexText.className = "index";
      indexText.textContent = String(index + 1);

      label.append(tag, indexText);

      const button = document.createElement("button");
      button.type = "button";
      button.className = "dl";
      button.textContent = "下载";
      button.addEventListener("click", () => {
        chrome.runtime.sendMessage({ type: "DOWNLOAD_MEDIA", url: item.url, mediaType: item.type });
      });

      row.append(label, button);
      list.appendChild(row);
    });
  }

  function addItems(nextItems) {
    for (const item of nextItems) {
      if (!item || typeof item.url !== "string" || !isHttpUrl(item.url)) {
        continue;
      }
      const type = item.type === "image" ? "image" : "video";
      const fingerprint = mediaFingerprint(item.url);
      items.set(`${type}:${fingerprint}`, {
        type,
        url: item.url
      });
    }
  }

  function isHttpUrl(url) {
    return /^https?:\/\//i.test(url);
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

  function forceHostVisible() {
    const properties = {
      all: "initial",
      display: "block",
      position: "fixed",
      width: "auto",
      height: "auto",
      visibility: "visible",
      opacity: "1",
      "pointer-events": "auto",
      "z-index": "2147483647",
      top: "auto",
      right: `${EXPANDED_PANEL_RIGHT_PX}px`,
      bottom: `${EXPANDED_PANEL_BOTTOM_PX}px`,
      left: "auto"
    };
    for (const [name, value] of Object.entries(properties)) {
      host.style.setProperty(name, value, "important");
    }
  }

  function mountHost() {
    if (!host.isConnected && document.documentElement) {
      document.documentElement.appendChild(host);
    }
  }

  const hostObserver = new MutationObserver(() => {
    const currentHost = document.getElementById(PANEL_ID);
    if (currentHost && currentHost !== host) {
      hostObserver.disconnect();
      return;
    }
    mountHost();
  });
  hostObserver.observe(document.documentElement, { childList: true });
})();
