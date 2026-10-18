"use strict";

(() => {
  const byId = (id) => document.getElementById(id);
  const ui = {
    status: byId("connection-status"), statusLabel: byId("connection-label"),
    pageMessage: byId("page-message"), configForm: byId("config-form"),
    configFields: byId("config-fields"), fishKey: byId("fish-api-key"),
    keyStatus: byId("key-status"), model: byId("model"),
    voices: byId("voice-rows"), addVoice: byId("add-voice"),
    defaultVoice: byId("default-voice"), saveButton: byId("save-button"),
    saveNote: byId("save-note"), previewForm: byId("preview-form"),
    previewFields: byId("preview-fields"), previewText: byId("preview-text"),
    previewVoice: byId("preview-voice"), previewSpeed: byId("preview-speed"),
    speedValue: byId("speed-value"), textCount: byId("text-count"),
    previewButton: byId("preview-button"), previewMessage: byId("preview-message"),
    audioResult: byId("audio-result"), audio: byId("preview-audio"),
    download: byId("download-audio"), relayEndpoint: byId("relay-endpoint"),
    lanEndpoint: byId("lan-endpoint"), lanEndpointField: byId("lan-endpoint-field"),
    relayKey: byId("relay-key"), relayModel: byId("relay-model"),
    relayVoices: byId("relay-voices"), toggleKey: byId("toggle-relay-key"),
    provider: byId("provider"), webSettings: byId("web-settings"), apiSettings: byId("api-settings"),
    browserBookmark: byId("browser-bookmark"), browserStatus: byId("browser-status"),
    browserDetail: byId("browser-detail"), checkBrowser: byId("check-browser"), billingNote: byId("billing-note")
  };
  let config = null;
  let audioUrl = null;
  let saving = false;
  let previewing = false;
  let dirty = false;
  let nextRowId = 0;
  let browserState = null;
  let checkingBrowser = false;

  function ready() { return config?.provider === "web" ? Boolean(browserState?.connected) : Boolean(config?.fishKeyConfigured); }
  function updateConnection() {
    ui.webSettings.hidden = ui.provider.value !== "web";
    ui.apiSettings.hidden = ui.provider.value === "web";
    ui.status.className = `status-pill ${ready() ? "ready" : "warning"}`;
    ui.statusLabel.textContent = ready() ? "中转已就绪" : config?.provider === "web" ? "等待连接 Fish 网页" : "等待配置 KEY";
    ui.previewFields.disabled = !ready() || previewing;
    ui.browserStatus.textContent = browserState?.connected ? "已连接" : "未连接";
    ui.checkBrowser.disabled = !browserState?.connected || checkingBrowser;
    const snapshot = browserState?.lastStats?.after || browserState?.lastStats?.before;
    ui.browserDetail.textContent = browserState?.lastError || (snapshot
      ? `${snapshot.plan || "套餐"} · 剩余额度 ${snapshot.balance ?? "—"} / ${snapshot.total ?? "—"} · API 余额 ${snapshot.apiCredit ?? "—"}${browserState.generating ? " · 正在生成" : ""}${browserState.queued ? ` · 排队 ${browserState.queued}` : ""}`
      : "连接后可读取套餐额度。网页刷新后，请重新点击连接书签。");
    ui.billingNote.textContent = config?.provider === "web" ? "试听使用网页订阅额度；每次最多 1000 字" : "试听使用 Fish API 余额";
  }

  function setMessage(element, message, kind = "success") {
    element.textContent = message;
    element.className = `message${element === ui.previewMessage ? " compact-message" : ""}${kind === "success" ? "" : ` ${kind}`}`;
    element.hidden = !message;
  }

  function markDirty() {
    if (!config) return;
    dirty = true;
    ui.saveNote.textContent = "有未保存的修改";
  }

  function readVoices() {
    return Array.from(ui.voices.children).map((row) => ({
      name: row.querySelector(".voice-name").value.trim(),
      referenceId: row.querySelector(".voice-reference").value.trim()
    }));
  }

  function fillSelect(select, voices, selected) {
    select.replaceChildren();
    for (const voice of voices) {
      if (!voice.name) continue;
      const option = document.createElement("option");
      option.value = voice.name;
      option.textContent = voice.referenceId ? voice.name : `${voice.name} · 默认随机`;
      select.append(option);
    }
    if (voices.some((voice) => voice.name === selected)) select.value = selected;
  }

  function updateDefaultOptions() {
    fillSelect(ui.defaultVoice, readVoices(), ui.defaultVoice.value);
  }

  function addVoiceRow(voice = { name: "", referenceId: "" }) {
    const id = ++nextRowId;
    const row = document.createElement("div");
    row.className = "voice-row";
    const name = document.createElement("input");
    name.className = "voice-name";
    name.id = `voice-name-${id}`;
    name.type = "text";
    name.value = voice.name;
    name.placeholder = "例如 narrator";
    name.required = true;
    name.maxLength = 64;
    name.pattern = "[A-Za-z0-9_\\-]+";
    name.title = "音色别名仅使用字母、数字、下划线或连字符";
    name.autocomplete = "off";
    name.spellcheck = false;
    name.setAttribute("aria-label", `音色 ${id} 的别名`);
    const reference = document.createElement("input");
    reference.className = "voice-reference";
    reference.id = `voice-reference-${id}`;
    reference.type = "text";
    reference.value = voice.referenceId;
    reference.placeholder = "留空使用默认随机音色";
    reference.autocomplete = "off";
    reference.spellcheck = false;
    reference.setAttribute("aria-label", `音色 ${id} 的 Reference ID`);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "voice-remove";
    remove.textContent = "×";
    remove.title = "删除此音色";
    remove.setAttribute("aria-label", `删除音色 ${id}`);
    name.addEventListener("input", () => {
      ui.voices.querySelectorAll(".voice-name").forEach((input) => input.setCustomValidity(""));
      updateDefaultOptions();
      markDirty();
    });
    reference.addEventListener("input", () => { updateDefaultOptions(); markDirty(); });
    remove.addEventListener("click", () => {
      if (ui.voices.children.length === 1) {
        setMessage(ui.pageMessage, "至少保留一个音色；Reference ID 可以留空。", "info");
        return;
      }
      row.remove();
      updateDefaultOptions();
      markDirty();
    });
    row.append(name, reference, remove);
    ui.voices.append(row);
    return name;
  }

  function updateTextCount() {
    const length = ui.previewText.value.length;
    const maximum = Number(config && config.maxTextLength);
    ui.textCount.textContent = maximum > 0 ? `${length} / ${maximum} 字` : `${length} 字`;
  }

  function applyConfig(value) {
    config = value;
    ui.provider.value = value.provider || "api";
    browserState = value.browser;
    ui.browserBookmark.href = value.browserBookmark || "#";
    ui.model.value = value.model || "s2.1-pro";
    ui.fishKey.value = "";
    ui.fishKey.placeholder = value.fishKeyConfigured ? "已配置；留空保留，输入可替换" : "输入 Fish Audio API Key";
    ui.keyStatus.textContent = value.fishKeyConfigured ? "已配置" : "尚未配置";
    ui.keyStatus.classList.toggle("configured", Boolean(value.fishKeyConfigured));
    const voices = Array.isArray(value.voices) && value.voices.length ? value.voices : [{ name: "default", referenceId: "" }];
    ui.voices.replaceChildren();
    voices.forEach(addVoiceRow);
    fillSelect(ui.defaultVoice, voices, value.defaultVoice);
    fillSelect(ui.previewVoice, voices, value.defaultVoice);
    ui.relayEndpoint.value = value.endpoint ? new URL(value.endpoint).origin : "";
    ui.lanEndpoint.value = value.lanEndpoint ? new URL(value.lanEndpoint).origin : "";
    ui.lanEndpointField.hidden = !value.lanEndpoint;
    ui.relayKey.value = value.relayKey || "";
    ui.relayModel.value = value.model || "s2.1-pro";
    ui.relayVoices.value = voices.find((voice) => voice.name === value.defaultVoice)?.referenceId || "";
    const maximum = Number(value.maxTextLength);
    if (Number.isInteger(maximum) && maximum > 0) ui.previewText.maxLength = maximum;
    else ui.previewText.removeAttribute("maxlength");
    ui.configFields.disabled = false;
    document.querySelectorAll("[data-copy]").forEach((button) => { button.disabled = !byId(button.dataset.copy).value; });
    ui.toggleKey.disabled = !value.relayKey;
    ui.saveNote.textContent = "配置已保存在本机";
    dirty = false;
    updateTextCount();
    updateConnection();
  }

  async function responseError(response) {
    try {
      const body = await response.json();
      if (body.error && typeof body.error.message === "string") return body.error.message;
      if (typeof body.error === "string") return body.error;
      if (typeof body.message === "string") return body.message;
    } catch (_) { /* The server may return an empty or non-JSON error response. */ }
    return `请求失败（HTTP ${response.status}），请检查本机服务。`;
  }

  async function loadConfig() {
    try {
      const response = await fetch("/api/config", { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) throw new Error(await responseError(response));
      applyConfig(await response.json());
    } catch (error) {
      ui.status.className = "status-pill error";
      ui.statusLabel.textContent = "连接失败";
      setMessage(ui.pageMessage, `无法读取配置：${error.message} 请确认服务正在运行，然后刷新页面。`, "error");
    }
  }

  ui.addVoice.addEventListener("click", () => {
    const used = new Set(readVoices().map((voice) => voice.name));
    let number = 1;
    while (used.has(`voice_${number}`)) number++;
    const input = addVoiceRow({ name: `voice_${number}`, referenceId: "" });
    updateDefaultOptions();
    markDirty();
    input.focus();
    input.select();
  });
  ui.fishKey.addEventListener("input", markDirty);
  ui.provider.addEventListener("change", () => { markDirty(); updateConnection(); });
  ui.browserBookmark.addEventListener("click", event => {
    event.preventDefault();
    setMessage(ui.pageMessage, "请把“连接 Fish 订阅”拖到 Chrome 书签栏，再到已登录的 Fish 页面点击该书签。", "info");
  });
  ui.checkBrowser.addEventListener("click", async () => {
    if (!config || checkingBrowser) return;
    checkingBrowser = true; updateConnection();
    try {
      const response = await fetch("/api/browser/check", { method: "POST", headers: { "X-CSRF-Token": config.csrfToken } });
      if (!response.ok) throw new Error(await responseError(response));
      setMessage(ui.pageMessage, "已读取当前空间的订阅额度。");
    } catch (error) { setMessage(ui.pageMessage, error.message, "error"); }
    finally { checkingBrowser = false; await refreshBrowser(); }
  });
  ui.model.addEventListener("input", markDirty);
  ui.defaultVoice.addEventListener("change", markDirty);
  ui.previewText.addEventListener("input", updateTextCount);
  ui.previewSpeed.addEventListener("input", () => { ui.speedValue.textContent = `${Number(ui.previewSpeed.value).toFixed(2)}×`; });

  ui.configForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (saving || !config) return;
    const voices = readVoices();
    const names = new Set();
    for (let index = 0; index < voices.length; index++) {
      const nameInput = ui.voices.children[index].querySelector(".voice-name");
      nameInput.setCustomValidity("");
      if (names.has(voices[index].name)) {
        nameInput.setCustomValidity("每个音色别名必须唯一");
        nameInput.reportValidity();
        return;
      }
      names.add(voices[index].name);
    }
    if (!ui.configForm.reportValidity()) return;
    const body = { model: ui.model.value.trim(), voices, defaultVoice: ui.defaultVoice.value, provider: ui.provider.value };
    if (!body.model) {
      ui.model.focus();
      setMessage(ui.pageMessage, "请输入默认模型。", "error");
      return;
    }
    if (ui.fishKey.value.trim()) body.fishApiKey = ui.fishKey.value.trim();
    saving = true;
    ui.configFields.disabled = true;
    ui.saveButton.textContent = "正在保存…";
    setMessage(ui.pageMessage, "");
    try {
      const response = await fetch("/api/config", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": config.csrfToken },
        body: JSON.stringify(body)
      });
      if (!response.ok) throw new Error(await responseError(response));
      applyConfig(await response.json());
      setMessage(ui.pageMessage, "配置已保存，下面的接入参数已更新。");
    } catch (error) {
      setMessage(ui.pageMessage, `保存失败：${error.message}`, "error");
    } finally {
      saving = false;
      ui.configFields.disabled = false;
      ui.saveButton.textContent = "保存配置";
    }
  });

  ui.previewForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (previewing || !ready()) return;
    const input = ui.previewText.value.trim();
    if (!input) {
      setMessage(ui.previewMessage, "请输入试听文本。", "error");
      ui.previewText.focus();
      return;
    }
    if (!ui.previewForm.reportValidity()) return;
    previewing = true;
    ui.previewFields.disabled = true;
    ui.previewButton.textContent = "正在生成…";
    setMessage(ui.previewMessage, dirty ? "正在生成，使用上次保存的模型与音色配置…" : "正在生成试听，请稍候…", "info");
    try {
      const response = await fetch("/api/preview", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": config.csrfToken },
        body: JSON.stringify({ input, voice: ui.previewVoice.value, speed: Number(ui.previewSpeed.value) })
      });
      if (!response.ok) throw new Error(await responseError(response));
      if ((response.headers.get("content-type") || "").includes("application/json")) throw new Error(await responseError(response));
      const audio = await response.blob();
      if (!audio.size) throw new Error("返回的音频为空，请重试。");
      ui.audio.pause();
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      audioUrl = URL.createObjectURL(audio);
      ui.audio.src = audioUrl;
      ui.download.href = audioUrl;
      ui.audioResult.hidden = false;
      setMessage(ui.previewMessage, "试听已生成，可播放或下载。");
      try { await ui.audio.play(); } catch (_) { /* Playback is also available through the native player. */ }
    } catch (error) {
      setMessage(ui.previewMessage, `试听失败：${error.message}`, "error");
    } finally {
      previewing = false;
      ui.previewFields.disabled = !ready();
      ui.previewButton.replaceChildren();
      const play = document.createElement("span");
      play.textContent = "▶";
      play.setAttribute("aria-hidden", "true");
      ui.previewButton.append(play, " 生成试听");
    }
  });

  ui.toggleKey.addEventListener("click", () => {
    const show = ui.relayKey.type === "password";
    ui.relayKey.type = show ? "text" : "password";
    ui.toggleKey.textContent = show ? "隐藏" : "显示";
    ui.toggleKey.setAttribute("aria-pressed", String(show));
  });

  async function copyText(input) {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(input.value);
      return;
    }
    const temporary = document.createElement("textarea");
    temporary.className = "clipboard-fallback";
    temporary.value = input.value;
    temporary.setAttribute("aria-hidden", "true");
    temporary.setAttribute("tabindex", "-1");
    document.body.append(temporary);
    temporary.select();
    const copied = document.execCommand("copy");
    temporary.remove();
    if (!copied) throw new Error("复制不可用");
  }

  document.querySelectorAll("[data-copy]").forEach((button) => {
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await copyText(byId(button.dataset.copy));
        button.textContent = "已复制";
        setTimeout(() => { button.textContent = "复制"; }, 1600);
      } catch (_) {
        setMessage(ui.pageMessage, "复制失败，请选择对应字段的内容并手动复制。", "error");
        byId(button.dataset.copy).focus();
      } finally {
        button.disabled = false;
      }
    });
  });

  window.addEventListener("pagehide", () => { if (audioUrl) URL.revokeObjectURL(audioUrl); });
  async function refreshBrowser() {
    if (!config) return;
    try {
      const response = await fetch("/api/browser/status", { cache: "no-store" });
      if (!response.ok) throw new Error();
      browserState = await response.json();
    } catch { browserState = { connected: false, lastError: "无法连接本机服务，请确认服务仍在运行。" }; }
    updateConnection();
  }
  async function pollBrowser() { await refreshBrowser(); setTimeout(pollBrowser, 3000); }
  updateTextCount();
  loadConfig();
  pollBrowser();
})();
