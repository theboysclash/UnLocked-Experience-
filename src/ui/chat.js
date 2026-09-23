import { markdownToHtml } from "../ai/text.js";
import { MODEL_SUGGESTIONS } from "../config.js";

export function createChat(root, api) {
  root.innerHTML = `
    <header class="chat-head">
      <div>
        <strong>Agent</strong>
        <p class="hint" data-status>Ready</p>
      </div>
      <div class="chat-tools">
        <button type="button" data-act="history">History</button>
        <button type="button" data-act="new">New</button>
      </div>
    </header>
    <label class="model-line">
      <span>Model</span>
      <input type="text" spellcheck="false" aria-label="Model" />
    </label>
    <div class="transcript" role="log"></div>
    <form class="composer">
      <textarea rows="3" placeholder="Ask the agent to read or edit the workspace. Enter sends, Shift+Enter adds a line."></textarea>
      <div class="composer-bar">
        <span class="hint" data-key></span>
        <button type="submit" class="btn primary">Send</button>
        <button type="button" class="btn hidden" data-stop>Stop</button>
      </div>
    </form>
    <div class="history hidden"></div>
  `;
  const transcript = root.querySelector(".transcript");
  const form = root.querySelector("form");
  const textarea = root.querySelector("textarea");
  const status = root.querySelector("[data-status]");
  const keyHint = root.querySelector("[data-key]");
  const model = root.querySelector(".model-line input");
  const stop = root.querySelector("[data-stop]");
  const history = root.querySelector(".history");
  let assistantNode = null;
  let assistantText = "";
  let frame = 0;

  const listId = "lumen-models";
  let dataList = document.getElementById(listId);
  if (!dataList) {
    dataList = document.createElement("datalist");
    dataList.id = listId;
    document.body.append(dataList);
  }
  model.setAttribute("list", listId);

  function syncModel() {
    const provider = api.config.activeProvider;
    model.value = api.config.providers[provider].defaultModel;
    dataList.replaceChildren();
    for (const item of MODEL_SUGGESTIONS[provider] || []) {
      const option = document.createElement("option");
      option.value = item;
      dataList.append(option);
    }
    const hasKey = provider === "ollama" || Boolean(api.getKey(provider));
    keyHint.textContent = hasKey ? "" : "Add an API key in Settings";
  }

  model.addEventListener("change", () => {
    api.config.providers[api.config.activeProvider].defaultModel = model.value.trim();
    api.persist();
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = textarea.value;
    if (api.send(text)) textarea.value = "";
  });
  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  stop.addEventListener("click", () => api.stop());
  root.querySelector("[data-act=new]").addEventListener("click", () => api.newChat());
  root.querySelector("[data-act=history]").addEventListener("click", async () => {
    history.classList.toggle("hidden");
    if (history.classList.contains("hidden")) return;
    const sessions = await api.listChats();
    history.replaceChildren();
    if (!sessions.length) {
      history.textContent = "No saved chats in this browser.";
      return;
    }
    for (const session of sessions) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "hit";
      button.textContent = session.title;
      button.addEventListener("click", () => {
        history.classList.add("hidden");
        api.openChat(session.id);
      });
      history.append(button);
    }
  });

  transcript.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-copy]");
    if (!button) return;
    const code = button.closest(".codeblock")?.querySelector("code")?.textContent || "";
    try {
      await navigator.clipboard.writeText(code);
      button.textContent = "Copied";
    } catch {
      button.textContent = "Copy failed";
    }
  });

  function addBubble(role, html, extraClass = "") {
    const article = document.createElement("article");
    article.className = `msg msg-${role} ${extraClass}`.trim();
    article.innerHTML = html;
    transcript.append(article);
    transcript.scrollTop = transcript.scrollHeight;
    return article;
  }

  return {
    syncModel,
    setBusy(busy) {
      stop.classList.toggle("hidden", !busy);
      form.querySelector("[type=submit]").disabled = busy;
      status.textContent = busy ? "Working" : "Ready";
    },
    notice(text) {
      status.textContent = text;
    },
    clear() {
      transcript.replaceChildren();
      assistantNode = null;
      assistantText = "";
    },
    load(messages) {
      this.clear();
      for (const message of messages) {
        if (message.role === "user") addBubble("user", `<p></p>`).querySelector("p").textContent = message.content;
        else if (message.role === "assistant") {
          const node = addBubble("assistant", markdownToHtml(message.content || ""));
          for (const call of message.toolCalls || []) node.append(toolChip(call));
        } else if (message.role === "tool") addBubble("tool", "", "tool-result").append(toolResult(message));
      }
    },
    addUser(text) {
      const node = addBubble("user", "<p></p>");
      node.querySelector("p").textContent = text;
      assistantNode = null;
    },
    handle(event) {
      if (event.type === "iteration") status.textContent = `Step ${event.index + 1}`;
      if (event.type === "text") {
        if (!assistantNode) {
          assistantText = "";
          assistantNode = addBubble("assistant", "");
        }
        assistantText += event.text;
        if (!frame) {
          frame = requestAnimationFrame(() => {
            frame = 0;
            if (assistantNode) assistantNode.innerHTML = markdownToHtml(assistantText);
            transcript.scrollTop = transcript.scrollHeight;
          });
        }
      }
      if (event.type === "assistant_done") {
        if (!assistantNode) assistantNode = addBubble("assistant", "");
        assistantNode.innerHTML = markdownToHtml(event.message.content || "");
        for (const call of event.message.toolCalls || []) assistantNode.append(toolChip(call));
        if (!event.message.content && !(event.message.toolCalls || []).length && assistantNode) {
          assistantNode.textContent = "No response.";
        }
        assistantNode = null;
        assistantText = "";
      }
      if (event.type === "tool_start") status.textContent = `Running ${event.call.name}`;
      if (event.type === "tool_result") addBubble("tool", "").append(toolResult(event.message));
      if (event.type === "notice") status.textContent = event.text;
    },
  };
}

function toolChip(call) {
  const chip = document.createElement("div");
  chip.className = "tool-chip";
  chip.textContent = call.name;
  return chip;
}

function toolResult(message) {
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = message.name || "tool";
  const pre = document.createElement("pre");
  pre.textContent = message.content || "";
  details.append(summary, pre);
  return details;
}
