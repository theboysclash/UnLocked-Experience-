import { diffToHtml } from "./ai/diff.js";
import { runAgent } from "./ai/agent.js";
import { createProvider, providerLabel, testProvider } from "./ai/providers.js";
import { activePromptId, interpolate, loadPrompts, savePrompts, setActivePromptId } from "./ai/prompts.js";
import { collectWorkspaceSkills, parseSkill, skillsIndex, toRawSkillUrl } from "./ai/skills.js";
import { runInSandbox } from "./ai/sandbox.js";
import { toolDefinitions } from "./ai/tools.js";
import { downloadBlob } from "./ai/text.js";
import { createEditor } from "./editor/editor-instance.js";
import { createStore } from "./fs/idb.js";
import { languageFromPath, splitPath } from "./fs/paths.js";
import { Workspace } from "./fs/workspace.js";
import { unzipStore, zipStore } from "./fs/zip.js";
import { createChat } from "./ui/chat.js";
import { openSettings } from "./ui/settings.js";
import { createSidebar } from "./ui/sidebar.js";
import { getKey, loadConfig, loadSessionKeys, saveConfig, sessionKeyEnabled, setKey } from "./utils/storage.js";
import { askText, h, openModal, toast } from "./utils/dom.js";

const appEl = document.querySelector("#app");
const config = loadConfig();
loadSessionKeys();

const ui = {
  tabs: [],
  activePath: "",
  messages: [],
  chatId: "",
  skills: [],
  busy: false,
  cursor: { line: 1, column: 1 },
  editorKind: "loading",
};
let workspace;
let store;
let editor;
let sidebar;
let chat;
let abortController = null;

appEl.innerHTML = `
  <header class="titlebar">
    <div class="brand"><span class="mark" aria-hidden="true"></span><div><strong>Lumen</strong><small>Browser IDE</small></div></div>
    <nav class="title-actions">
      <button type="button" data-act="folder">Open folder</button>
      <button type="button" data-act="import">Import copy</button>
      <button type="button" data-act="file">Open file</button>
      <button type="button" data-act="project">New project</button>
      <button type="button" data-act="export">Export</button>
      <button type="button" data-act="prompt">Prompt</button>
      <button type="button" data-act="settings">Settings</button>
      <button type="button" data-act="sidebar" aria-label="Toggle explorer">Explorer</button>
      <button type="button" data-act="chat" aria-label="Toggle agent">Agent</button>
    </nav>
  </header>
  <aside class="sidebar"></aside>
  <div class="resizer side" role="separator" aria-orientation="vertical" aria-label="Resize explorer"></div>
  <main class="stage">
    <div class="tabbar" role="tablist"></div>
    <div class="editor-host"></div>
    <section class="welcome">
      <div class="welcome-card">
        <p class="eyebrow">No install</p>
        <h1>Edit local files with an agent in the browser.</h1>
        <p>Open a live folder in Chrome or Edge, or keep a virtual project in this browser and export it when you want a copy.</p>
        <div class="welcome-actions"></div>
        <p class="hint" data-secure></p>
      </div>
    </section>
  </main>
  <div class="resizer chat" role="separator" aria-orientation="vertical" aria-label="Resize agent"></div>
  <aside class="chat-panel"></aside>
  <footer class="statusbar">
    <span data-folder>No folder</span>
    <span data-mode></span>
    <span data-provider></span>
    <span data-cursor>Ln 1, Col 1</span>
    <span data-editor></span>
  </footer>
  <input id="file-input" type="file" hidden />
  <input id="dir-input" type="file" webkitdirectory directory multiple hidden />
  <input id="json-input" type="file" accept="application/json,.json,.zip" hidden />
`;

const welcome = appEl.querySelector(".welcome");
const welcomeActions = appEl.querySelector(".welcome-actions");
for (const [act, label] of [["folder", "Open folder"], ["import", "Import a copy"], ["project", "New virtual project"], ["resume", "Resume virtual project"], ["reconnect", "Reconnect last folder"]]) {
  welcomeActions.append(h("button", { type: "button", class: act === "folder" ? "btn primary" : "btn", "data-act": act }, label));
}

document.documentElement.dataset.theme = config.theme;
applyWidths();
installResize(appEl.querySelector(".resizer.side"), "--sidebar-w", 1);
installResize(appEl.querySelector(".resizer.chat"), "--chat-w", -1);

const secure = window.isSecureContext && location.protocol !== "file:";
appEl.querySelector("[data-secure]").textContent = secure
  ? "Live folder access needs a Chromium browser on localhost or https."
  : "This page is not a secure context, so live folder access is unavailable. Virtual projects and imports still work.";

appEl.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-act]");
  if (!button || button.closest(".sidebar") || button.closest(".chat-panel")) return;
  if (!workspace) return;
  const act = button.dataset.act;
  if (act === "folder") openFolder();
  if (act === "import") appEl.querySelector("#dir-input").click();
  if (act === "file") openSingleFile();
  if (act === "project") newProject();
  if (act === "export") exportMenu();
  if (act === "prompt") openSettings(settingsApi(), "prompts");
  if (act === "settings") openSettings(settingsApi(), "providers");
  if (act === "sidebar") togglePanel("sidebar");
  if (act === "chat") togglePanel("chat");
  if (act === "resume") resumeVirtual();
  if (act === "reconnect") reconnectFolder();
});

document.addEventListener("keydown", (event) => {
  const meta = event.metaKey || event.ctrlKey;
  if (meta && event.key.toLowerCase() === "s") {
    event.preventDefault();
    saveActive();
  } else if (meta && event.key === ",") {
    event.preventDefault();
    openSettings(settingsApi(), "providers");
  } else if (meta && event.key.toLowerCase() === "b") {
    event.preventDefault();
    togglePanel("sidebar");
  } else if (meta && event.key.toLowerCase() === "j") {
    event.preventDefault();
    togglePanel("chat");
    appEl.querySelector(".composer textarea")?.focus();
  }
});

window.addEventListener("beforeunload", (event) => {
  if (ui.tabs.some((tab) => tab.dirty)) {
    event.preventDefault();
    event.returnValue = "";
  }
});

appEl.querySelector("#dir-input").addEventListener("change", (event) => importFileList(event.target.files));
appEl.querySelector("#json-input").addEventListener("change", (event) => importBundle(event.target.files?.[0]));
appEl.addEventListener("dragover", (event) => event.preventDefault());
appEl.addEventListener("drop", (event) => {
  event.preventDefault();
  importDataTransfer(event.dataTransfer);
});

if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

boot();

async function boot() {
  store = await createStore();
  workspace = new Workspace(store);
  sidebar = createSidebar(appEl.querySelector(".sidebar"), {
    connected: () => workspace.connected,
    activePath: () => ui.activePath,
    list: (path) => workspace.list(path),
    openFile: (path) => activate(path),
    createFile: () => createPath("file"),
    createDirectory: () => createPath("dir"),
    searchText: (query) => searchText(query, ""),
    deleteActive,
  });
  chat = createChat(appEl.querySelector(".chat-panel"), {
    config,
    getKey,
    persist,
    send,
    stop,
    newChat,
    listChats,
    openChat,
  });
  editor = await createEditor(appEl.querySelector(".editor-host"), {
    theme: config.theme,
    fontSize: config.fontSize,
    onChange: onEditorChange,
    onCursor: (position) => {
      ui.cursor = position;
      paintStatus();
    },
  });
  ui.editorKind = editor.kind === "monaco" ? "Monaco" : "Plain editor";
  await refreshSkills();
  await paintWelcomeExtras();
  chat.syncModel();
  paintStatus();
  sidebar.refresh();
  appEl.dataset.ready = "true";
}

async function paintWelcomeExtras() {
  const count = await workspace.virtualCount();
  const saved = await workspace.savedDirectoryName();
  welcomeActions.querySelector("[data-act=resume]").hidden = count === 0;
  welcomeActions.querySelector("[data-act=reconnect]").hidden = !saved;
}

function onEditorChange(value) {
  const tab = currentTab();
  if (!tab) return;
  tab.buffer = value;
  tab.dirty = value !== tab.saved;
  renderTabs();
}

function currentTab() {
  return ui.tabs.find((tab) => tab.path === ui.activePath);
}

function stash() {
  const tab = currentTab();
  if (!tab || !editor) return;
  tab.buffer = editor.getValue();
  tab.view = editor.saveViewState();
  tab.dirty = tab.buffer !== tab.saved;
}

async function activate(path) {
  try {
    stash();
    let tab = ui.tabs.find((item) => item.path === path);
    if (!tab) {
      const text = await workspace.read(path);
      tab = { path, buffer: text, saved: text, dirty: false, view: null };
      ui.tabs.push(tab);
    }
    ui.activePath = path;
    editor.setValue(tab.buffer, languageFromPath(path));
    editor.restoreViewState(tab.view);
    welcome.hidden = true;
    renderTabs();
    paintStatus();
    sidebar.reveal(path);
    sidebar.refresh();
    editor.focus();
  } catch (error) {
    toast(error.message, "warn");
  }
}

function renderTabs() {
  const bar = appEl.querySelector(".tabbar");
  bar.replaceChildren();
  for (const tab of ui.tabs) {
    const button = h("button", {
      type: "button",
      class: `tab${tab.path === ui.activePath ? " on" : ""}`,
      role: "tab",
      "aria-selected": tab.path === ui.activePath ? "true" : "false",
      onClick: () => activate(tab.path),
    }, [tab.dirty ? "● " : "", tab.path.split("/").at(-1)]);
    const close = h("span", {
      class: "tab-x",
      role: "button",
      "aria-label": `Close ${tab.path}`,
      onClick: (event) => {
        event.stopPropagation();
        closeTab(tab.path);
      },
    }, "×");
    button.append(close);
    bar.append(button);
  }
  const spacer = h("div", { class: "tab-spacer" });
  const prompt = h("button", { type: "button", class: "tab ghost", onClick: () => openSettings(settingsApi(), "prompts") }, "Prompt");
  bar.append(spacer, prompt);
}

async function closeTab(path) {
  const tab = ui.tabs.find((item) => item.path === path);
  if (tab?.dirty) {
    const ok = await confirmAction("Close without saving?", `${path} has unsaved edits.`);
    if (!ok) return;
  }
  ui.tabs = ui.tabs.filter((item) => item.path !== path);
  if (ui.activePath === path) {
    ui.activePath = "";
    editor.setValue("");
    const next = ui.tabs.at(-1);
    if (next) return activate(next.path);
    welcome.hidden = false;
  }
  renderTabs();
  paintStatus();
  sidebar.refresh();
}

async function saveActive() {
  const tab = currentTab();
  if (!tab) return;
  if (!workspace.connected) return toast("Open a project before saving", "warn");
  try {
    const value = editor.getValue();
    await workspace.write(tab.path, value);
    tab.saved = value;
    tab.buffer = value;
    tab.dirty = false;
    renderTabs();
    toast("Saved");
  } catch (error) {
    toast(error.message, "warn");
  }
}

async function openFolder() {
  try {
    await workspace.openDirectory();
    resetBuffers();
    await afterWorkspaceChange();
    toast(`Opened ${workspace.name}`);
  } catch (error) {
    if (error.name !== "AbortError") toast(error.message, "warn");
  }
}

async function reconnectFolder() {
  try {
    const ok = await workspace.reconnectDirectory();
    if (!ok) return toast("No saved folder", "warn");
    resetBuffers();
    await afterWorkspaceChange();
  } catch (error) {
    toast(error.message, "warn");
  }
}

async function resumeVirtual() {
  await workspace.resumeVirtual();
  resetBuffers();
  await afterWorkspaceChange();
}

async function newProject() {
  const name = await askText({ title: "New virtual project", label: "Project name", value: "Virtual project", confirm: "Create" });
  if (!name) return;
  await workspace.newVirtual(name);
  resetBuffers();
  await afterWorkspaceChange();
  await activate("src/main.js");
}

async function openSingleFile() {
  if (typeof window.showOpenFilePicker === "function" && window.isSecureContext) {
    try {
      const [handle] = await window.showOpenFilePicker();
      const file = await handle.getFile();
      if (!workspace.connected) await workspace.beginVirtual(file.name, { seed: false });
      await workspace.write(file.name, await file.text());
      await afterWorkspaceChange();
      await activate(file.name);
      return;
    } catch (error) {
      if (error.name === "AbortError") return;
      toast(error.message, "warn");
      return;
    }
  }
  appEl.querySelector("#file-input").onchange = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!workspace.connected) await workspace.beginVirtual("Imported files", { seed: false });
    await workspace.write(file.name, await file.text());
    await afterWorkspaceChange();
    await activate(file.name);
  };
  appEl.querySelector("#file-input").click();
}

async function importFileList(fileList) {
  const files = [...fileList || []];
  if (!files.length) return;
  if (workspace.mode !== "directory") await workspace.beginVirtual("Imported files", { seed: false });
  let count = 0;
  for (const file of files) {
    if (file.size > 1_000_000) continue;
    const path = file.webkitRelativePath || file.name;
    try {
      const text = await file.text();
      if (text.includes("\0")) continue;
      await workspace.write(path, text);
      count += 1;
    } catch {
      // Skip files the workspace refuses.
    }
  }
  await afterWorkspaceChange();
  toast(`Imported ${count} files`);
}

async function importDataTransfer(transfer) {
  const entries = [...transfer.items].map((item) => item.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return importFileList(transfer.files);
  const files = [];
  for (const entry of entries) await readEntry(entry, "", files);
  if (workspace.mode !== "directory") await workspace.beginVirtual("Dropped files", { seed: false });
  for (const file of files) await workspace.write(file.path, file.text);
  await afterWorkspaceChange();
  toast(`Imported ${files.length} files`);
}

function readEntry(entry, prefix, files) {
  return new Promise((resolve) => {
    if (entry.isFile) {
      entry.file(async (file) => {
        if (file.size <= 1_000_000) {
          const text = await file.text();
          if (!text.includes("\0")) files.push({ path: `${prefix}${entry.name}`, text });
        }
        resolve();
      }, () => resolve());
      return;
    }
    if (!entry.isDirectory) return resolve();
    const reader = entry.createReader();
    const all = [];
    const readBatch = () => {
      reader.readEntries(async (batch) => {
        if (!batch.length) {
          for (const child of all) await readEntry(child, `${prefix}${entry.name}/`, files);
          resolve();
          return;
        }
        all.push(...batch);
        readBatch();
      }, () => resolve());
    };
    readBatch();
  });
}

async function importBundle(file) {
  if (!file) return;
  try {
    if (file.name.endsWith(".zip")) {
      const entries = await unzipStore(new Uint8Array(await file.arrayBuffer()));
      await workspace.beginVirtual(file.name.replace(/\.zip$/, ""), { seed: false });
      for (const entry of entries) await workspace.write(entry.name, new TextDecoder().decode(entry.data));
    } else {
      const data = JSON.parse(await file.text());
      const files = data.files && typeof data.files === "object" ? data.files : null;
      if (!files) throw new Error("JSON must contain a files object");
      await workspace.beginVirtual(data.name || "Imported project", { seed: false });
      for (const [path, content] of Object.entries(files)) await workspace.write(path, String(content));
    }
    resetBuffers();
    await afterWorkspaceChange();
    toast("Project imported");
  } catch (error) {
    toast(error.message, "warn");
  }
}

function exportMenu() {
  const body = h("div", { class: "stack" }, [
    h("p", { class: "hint" }, "ZIP is the easiest copy to keep. JSON can be imported back into Lumen."),
  ]);
  openModal({
    title: "Export project",
    body,
    actions: [
      { label: "Download ZIP", primary: true, onClick: ({ close }) => { close(); downloadZip(); } },
      { label: "Download JSON", onClick: ({ close }) => { close(); downloadJson(); } },
      { label: "Import…", onClick: ({ close }) => { close(); appEl.querySelector("#json-input").click(); } },
    ],
  });
}

async function downloadZip() {
  const files = await workspace.filesForExport();
  if (!files.length) return toast("Nothing to export", "warn");
  const bytes = zipStore(files.map((file) => ({ name: file.name, data: new TextEncoder().encode(file.content) })));
  downloadBlob(`${safeName(workspace.name)}.zip`, new Blob([bytes], { type: "application/zip" }));
}

async function downloadJson() {
  const files = await workspace.filesForExport();
  const payload = { type: "lumen-project", version: 1, name: workspace.name, files: Object.fromEntries(files.map((file) => [file.name, file.content])) };
  downloadBlob(`${safeName(workspace.name)}.json`, new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
}

async function createPath(kind) {
  if (!workspace.connected) return toast("Open a project first", "warn");
  const value = await askText({
    title: kind === "dir" ? "New folder" : "New file",
    label: "Path inside the workspace",
    value: kind === "dir" ? "src" : "src/untitled.js",
    confirm: "Create",
  });
  if (!value) return;
  try {
    if (kind === "dir") await workspace.makeDir(value);
    else {
      await workspace.write(value, "");
      await activate(value);
    }
    sidebar.invalidate();
    await sidebar.refresh();
  } catch (error) {
    toast(error.message, "warn");
  }
}

function resetBuffers() {
  ui.tabs = [];
  ui.activePath = "";
  editor?.setValue("");
  welcome.hidden = false;
  renderTabs();
}

async function afterWorkspaceChange() {
  sidebar.invalidate();
  await sidebar.refresh();
  await refreshSkills();
  await paintWelcomeExtras();
  welcome.hidden = ui.tabs.length > 0;
  paintStatus();
}

async function refreshSkills() {
  const saved = (await store.all("skills")).map((skill) => ({ ...skill, source: skill.source || "saved" }));
  let fromWorkspace = [];
  if (workspace.connected) fromWorkspace = await collectWorkspaceSkills(workspace);
  const byName = new Map();
  for (const skill of [...saved, ...fromWorkspace]) byName.set(skill.name.toLowerCase(), skill);
  ui.skills = [...byName.values()];
}

function bufferFor(path) {
  if (path === ui.activePath && editor) return editor.getValue();
  return ui.tabs.find((tab) => tab.path === path)?.buffer ?? null;
}

async function readFile(path) {
  splitPath(path);
  const buffered = bufferFor(path);
  if (buffered != null) return buffered;
  return workspace.read(path);
}

async function writeFile(path, content) {
  await workspace.write(path, content);
  const existing = ui.tabs.find((tab) => tab.path === path);
  if (existing) {
    existing.buffer = content;
    existing.saved = content;
    existing.dirty = false;
    if (ui.activePath === path) editor.setValue(content, languageFromPath(path));
  }
  sidebar.invalidate();
  await sidebar.refresh();
  renderTabs();
}

async function searchText(query, path) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return "Provide a query.";
  const root = String(path || "").replace(/^\/+|\/+$/g, "");
  const files = await workspace.filesForExport();
  const hits = [];
  for (const file of files) {
    if (root && file.name !== root && !file.name.startsWith(`${root}/`)) continue;
    file.content.split("\n").forEach((line, index) => {
      if (hits.length < 40 && line.toLowerCase().includes(needle)) {
        hits.push(`${file.name}:${index + 1}: ${line.trim().slice(0, 180)}`);
      }
    });
  }
  return hits.length ? hits.join("\n") : "No matches.";
}

function loadSkill(name) {
  const skill = ui.skills.find((item) => item.name.toLowerCase() === String(name || "").toLowerCase() || item.id === name);
  if (!skill) return `Skill not found. Known skills: ${ui.skills.map((item) => item.name).join(", ") || "none"}`;
  return `# ${skill.name}\n${skill.description}\n\n${skill.body}`;
}

function requestApproval({ title, path, before, after }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const view = document.createElement("div");
    view.className = "diff-view";
    view.innerHTML = diffToHtml(before, after);
    const body = h("div", { class: "stack" }, [h("p", { class: "hint" }, path), view]);
    const modal = openModal({
      title,
      body,
      wide: true,
      onClose: () => finish(false),
      actions: [
        { label: "Reject", onClick: () => { finish(false); modal.close(); } },
        { label: "Apply", primary: true, onClick: () => { finish(true); modal.close(); } },
      ],
    });
  });
}

function currentSystemPrompt() {
  const prompts = loadPrompts();
  const prompt = prompts.find((item) => item.id === activePromptId()) || prompts[0];
  const text = interpolate(prompt.body, {
    os: navigator.userAgentData?.platform || navigator.platform || "browser",
    workspace_name: workspace?.name || "untitled",
    language: ui.activePath ? languageFromPath(ui.activePath) : "plaintext",
    skills_index: skillsIndex(ui.skills),
  });
  if (!config.agent.allowJavaScript) return text;
  return `${text}\n\nrun_javascript is available for isolated computation. It cannot read files or the network.`;
}

function send(text) {
  const content = text.trim();
  if (!content || ui.busy) return false;
  if (config.activeProvider !== "ollama" && !getKey(config.activeProvider)) {
    toast("Add an API key in Settings", "warn");
    openSettings(settingsApi(), "providers");
    return false;
  }
  void deliver(content);
  return true;
}

async function deliver(content) {
  ui.messages.push({ role: "user", content });
  chat.addUser(content);
  ui.busy = true;
  chat.setBusy(true);
  abortController = new AbortController();
  const signal = abortController.signal;
  try {
    const provider = createProvider(config, getKey(config.activeProvider));
    const system = { role: "system", content: currentSystemPrompt() };
    const wrapped = {
      chat: (messages, tools, options) => provider.chat([system, ...messages], tools, options),
    };
    await runAgent({
      messages: ui.messages,
      provider: wrapped,
      tools: toolDefinitions(config.agent),
      maxIterations: config.agent.maxIterations,
      signal,
      context: {
        signal,
        autoApprove: config.agent.autoApprove,
        allowWebFetch: config.agent.allowWebFetch,
        allowJavaScript: config.agent.allowJavaScript,
        maxTokens: config.agent.maxTokens,
        listDir: async (path) => {
          const entries = await workspace.list(path || "");
          if (!entries.length) return "(empty)";
          return entries.map((entry) => `${entry.kind === "dir" ? "dir " : "file"} ${entry.name}`).join("\n");
        },
        readFile,
        writeFile,
        searchText,
        loadSkill,
        requestApproval,
        runJavaScript: (code) => runInSandbox(code),
      },
      onEvent: (event) => chat.handle(event),
    });
    await persistChat();
  } catch (error) {
    if (error.name !== "AbortError") {
      chat.notice(error.message);
      toast(error.message, "warn");
    } else chat.notice("Stopped");
  } finally {
    ui.busy = false;
    chat.setBusy(false);
    abortController = null;
  }
}

function stop() {
  abortController?.abort();
}

function newChat() {
  ui.messages = [];
  ui.chatId = "";
  chat.clear();
  chat.notice("Ready");
}

async function listChats() {
  const rows = await store.all("chats");
  return rows.sort((a, b) => (b.updated || 0) - (a.updated || 0)).slice(0, 30);
}

async function openChat(id) {
  const session = await store.get("chats", id);
  if (!session) return;
  ui.chatId = session.id;
  ui.messages = session.messages || [];
  chat.load(ui.messages);
}

async function persistChat() {
  if (!ui.chatId) ui.chatId = crypto.randomUUID();
  const title = ui.messages.find((message) => message.role === "user")?.content.slice(0, 72) || "Chat";
  await store.put("chats", { id: ui.chatId, title, messages: ui.messages, updated: Date.now() }, ui.chatId);
}

function persist() {
  saveConfig(config);
  document.documentElement.dataset.theme = config.theme;
  editor?.setTheme(config.theme);
  editor?.setFontSize(config.fontSize);
  chat?.syncModel();
  paintStatus();
}

function settingsApi() {
  return {
    config,
    getKey,
    setKey,
    sessionKeyEnabled,
    persist,
    skills: () => ui.skills,
    prompts: loadPrompts,
    activePromptId,
    savePrompts,
    setActivePrompt: setActivePromptId,
    testConnection: () => testProvider(config, getKey(config.activeProvider)),
    removeSkill: async (id) => {
      await store.delete("skills", id);
      await refreshSkills();
    },
    addSkillText: async (text) => {
      const skill = parseSkill(text, "saved");
      skill.source = "saved";
      await store.put("skills", skill, skill.id);
      await refreshSkills();
    },
    importSkillUrl: async (url) => {
      const target = toRawSkillUrl(url);
      const response = await fetch(target, { referrerPolicy: "no-referrer" });
      if (!response.ok) throw new Error(`Could not fetch skill (${response.status})`);
      const skill = parseSkill(await response.text(), target);
      skill.source = "saved";
      await store.put("skills", skill, skill.id);
      await refreshSkills();
    },
  };
}

function paintStatus() {
  appEl.querySelector("[data-folder]").textContent = workspace?.name || "No folder";
  appEl.querySelector("[data-mode]").textContent = workspace?.mode === "directory" ? "Live folder" : workspace?.mode === "virtual" ? "Virtual" : "No files";
  appEl.querySelector("[data-provider]").textContent = `${providerLabel(config.activeProvider)} · ${config.providers[config.activeProvider].defaultModel}`;
  appEl.querySelector("[data-cursor]").textContent = `Ln ${ui.cursor.line}, Col ${ui.cursor.column}`;
  appEl.querySelector("[data-editor]").textContent = ui.editorKind;
}

async function deleteActive() {
  if (!ui.activePath) return toast("Open a file to delete", "warn");
  const path = ui.activePath;
  const ok = await confirmAction("Delete file?", path, "Delete");
  if (!ok) return;
  try {
    await workspace.remove(path);
    ui.tabs = ui.tabs.filter((tab) => tab.path !== path);
    ui.activePath = "";
    editor.setValue("");
    sidebar.invalidate();
    await sidebar.refresh();
    const next = ui.tabs.at(-1);
    if (next) await activate(next.path);
    else {
      welcome.hidden = false;
      renderTabs();
      paintStatus();
    }
  } catch (error) {
    toast(error.message, "warn");
  }
}

function confirmAction(title, message, confirm = "Close file") {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const modal = openModal({
      title,
      body: message,
      onClose: () => finish(false),
      actions: [
        { label: "Cancel", onClick: () => { finish(false); modal.close(); } },
        { label: confirm, primary: true, onClick: () => { finish(true); modal.close(); } },
      ],
    });
  });
}

function togglePanel(name) {
  const mobile = window.matchMedia("(max-width: 900px)").matches;
  if (!mobile) {
    appEl.classList.toggle(name === "sidebar" ? "hide-sidebar" : "hide-chat");
    return;
  }
  const shown = name === "sidebar" ? "show-sidebar" : "show-chat";
  const other = name === "sidebar" ? "show-chat" : "show-sidebar";
  appEl.classList.toggle(shown);
  if (appEl.classList.contains(shown)) appEl.classList.remove(other);
}

function installResize(handle, variable, direction) {
  handle.addEventListener("pointerdown", (event) => {
    if (window.matchMedia("(max-width: 900px)").matches) return;
    event.preventDefault();
    const startX = event.clientX;
    const start = Number.parseInt(getComputedStyle(document.documentElement).getPropertyValue(variable), 10) || 240;
    const move = (next) => {
      const width = Math.min(640, Math.max(200, start + direction * (next.clientX - startX)));
      document.documentElement.style.setProperty(variable, `${width}px`);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      localStorage.setItem(`lumen.${variable}`, document.documentElement.style.getPropertyValue(variable));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });
}

function applyWidths() {
  for (const variable of ["--sidebar-w", "--chat-w"]) {
    const saved = localStorage.getItem(`lumen.${variable}`);
    if (saved) document.documentElement.style.setProperty(variable, saved);
  }
}

function safeName(name) {
  return String(name || "lumen").replace(/[^\w.-]+/g, "-").replace(/^-|-$/g, "") || "lumen";
}
