import { MODEL_SUGGESTIONS, PROVIDERS } from "../config.js";
import { estimateTokens } from "../ai/text.js";
import { promptVariables } from "../ai/prompts.js";
import { providerLabel } from "../ai/providers.js";
import { h, openModal } from "../utils/dom.js";

export function openSettings(api, initialTab = "providers") {
  const body = h("div", { class: "settings" });
  const tabs = h("div", { class: "tabs-mini", role: "tablist" });
  const panel = h("div", { class: "settings-panel" });
  body.append(tabs, panel);
  const names = [
    ["providers", "Providers"],
    ["models", "Models"],
    ["skills", "Skills"],
    ["prompts", "Prompts"],
    ["agent", "Agent"],
  ];
  let current = initialTab;
  const modal = openModal({ title: "Settings", body, wide: true, actions: [{ label: "Done", primary: true, onClick: ({ close }) => close() }] });

  function drawTabs() {
    tabs.replaceChildren();
    for (const [id, label] of names) {
      tabs.append(h("button", {
        type: "button",
        class: id === current ? "tab on" : "tab",
        role: "tab",
        "aria-selected": id === current ? "true" : "false",
        onClick: () => {
          current = id;
          drawTabs();
          drawPanel();
        },
      }, label));
    }
  }

  function drawPanel() {
    panel.replaceChildren();
    if (current === "providers") panel.append(providersPanel());
    if (current === "models") panel.append(modelsPanel());
    if (current === "skills") panel.append(skillsPanel());
    if (current === "prompts") panel.append(promptsPanel());
    if (current === "agent") panel.append(agentPanel());
  }

  function providersPanel() {
    const wrap = h("div", { class: "stack" });
    wrap.append(h("p", { class: "hint" }, "Keys stay in memory for this page. Opt in to keep a key for this browser tab only. They are not written to localStorage."));
    const select = h("select", { class: "field" });
    for (const name of PROVIDERS) {
      const option = h("option", { value: name }, providerLabel(name));
      if (name === api.config.activeProvider) option.selected = true;
      select.append(option);
    }
    select.addEventListener("change", () => {
      api.config.activeProvider = select.value;
      api.persist();
      drawPanel();
    });
    wrap.append(field("Active provider", select));
    for (const name of PROVIDERS) {
      const spec = api.config.providers[name];
      const key = h("input", { class: "field", type: "password", autocomplete: "off", spellcheck: "false", value: api.getKey(name) });
      const remember = h("input", { type: "checkbox" });
      remember.checked = api.sessionKeyEnabled(name);
      const base = h("input", { class: "field", spellcheck: "false", value: spec.baseUrl });
      const card = h("section", { class: "card" }, [
        h("h3", {}, providerLabel(name)),
        field("API key", key),
        h("label", { class: "check" }, [remember, " Remember in this tab"]),
        name === "ollama" ? h("p", { class: "hint" }, "Ollama must allow browser requests. Serve this IDE from http://localhost, not https.") : null,
        name === "anthropic" ? h("p", { class: "hint" }, "Anthropic often blocks browser calls. OpenRouter is the dependable path.") : null,
        field("Base URL", base),
        h("button", {
          type: "button",
          class: "btn",
          onClick: async (event) => {
            api.setKey(name, key.value, { persistSession: remember.checked });
            spec.baseUrl = base.value.trim() || spec.baseUrl;
            api.persist();
            event.target.textContent = "Testing…";
            const previous = api.config.activeProvider;
            api.config.activeProvider = name;
            try {
              event.target.textContent = await api.testConnection();
            } catch (error) {
              event.target.textContent = error.message;
            } finally {
              api.config.activeProvider = previous;
            }
          },
        }, "Test connection"),
      ]);
      key.addEventListener("change", () => api.setKey(name, key.value, { persistSession: remember.checked }));
      remember.addEventListener("change", () => api.setKey(name, key.value, { persistSession: remember.checked }));
      base.addEventListener("change", () => {
        spec.baseUrl = base.value.trim();
        api.persist();
      });
      wrap.append(card);
    }
    return wrap;
  }

  function modelsPanel() {
    const wrap = h("div", { class: "stack" });
    for (const name of PROVIDERS) {
      const spec = api.config.providers[name];
      const input = h("input", { class: "field", list: `models-${name}`, value: spec.defaultModel, spellcheck: "false" });
      const list = h("datalist", { id: `models-${name}` });
      for (const model of MODEL_SUGGESTIONS[name]) list.append(h("option", { value: model }));
      input.addEventListener("change", () => {
        spec.defaultModel = input.value.trim() || spec.defaultModel;
        api.persist();
      });
      wrap.append(field(`${providerLabel(name)} model`, input), list);
    }
    return wrap;
  }

  function skillsPanel() {
    const wrap = h("div", { class: "stack" });
    wrap.append(h("p", { class: "hint" }, "Skills are markdown instructions. A workspace .skills folder is picked up automatically. You can also paste a GitHub file URL."));
    const list = h("div", { class: "stack" });
    for (const skill of api.skills()) {
      list.append(h("div", { class: "skill-row" }, [
        h("div", {}, [h("strong", {}, skill.name), h("p", { class: "hint" }, skill.description)]),
        skill.source === "saved" ? h("button", { type: "button", class: "btn", onClick: () => { api.removeSkill(skill.id); drawPanel(); } }, "Remove") : h("span", { class: "hint" }, skill.source),
      ]));
    }
    if (!api.skills().length) list.append(h("p", { class: "hint" }, "No skills loaded."));
    const url = h("input", { class: "field", placeholder: "https://github.com/org/repo/blob/main/.skills/demo/SKILL.md", spellcheck: "false" });
    const manual = h("textarea", { class: "field area", placeholder: "---\nname: example\ndescription: What this skill is for\n---\nInstructions…" });
    wrap.append(
      list,
      field("Import from URL", url),
      h("button", {
        type: "button",
        class: "btn",
        onClick: async (event) => {
          event.target.disabled = true;
          try {
            await api.importSkillUrl(url.value);
            url.value = "";
            drawPanel();
          } catch (error) {
            event.target.textContent = error.message;
          } finally {
            event.target.disabled = false;
          }
        },
      }, "Fetch skill"),
      field("Or paste SKILL.md", manual),
      h("button", {
        type: "button",
        class: "btn primary",
        onClick: async () => {
          if (!manual.value.trim()) return;
          await api.addSkillText(manual.value);
          manual.value = "";
          drawPanel();
        },
      }, "Save skill"),
    );
    return wrap;
  }

  function promptsPanel() {
    const prompts = api.prompts();
    const wrap = h("div", { class: "stack" });
    const select = h("select", { class: "field" });
    for (const prompt of prompts) {
      const option = h("option", { value: prompt.id }, prompt.name);
      if (prompt.id === api.activePromptId()) option.selected = true;
      select.append(option);
    }
    const active = () => prompts.find((prompt) => prompt.id === select.value) || prompts[0];
    const name = h("input", { class: "field", value: active()?.name || "" });
    const editor = h("textarea", { class: "field area tall", spellcheck: "false" }, active()?.body || "");
    const counter = h("p", { class: "hint" });
    const updateCount = () => {
      counter.textContent = `About ${estimateTokens(editor.value)} tokens. Variables: ${promptVariables().map((item) => `{{${item}}}`).join(", ")}`;
    };
    updateCount();
    select.addEventListener("change", () => {
      name.value = active().name;
      editor.value = active().body;
      api.setActivePrompt(select.value);
      updateCount();
    });
    editor.addEventListener("input", updateCount);
    wrap.append(
      field("Prompt", select),
      field("Name", name),
      field("Instructions", editor),
      counter,
      h("div", { class: "row-actions" }, [
        h("button", {
          type: "button",
          class: "btn primary",
          onClick: () => {
            const prompt = active();
            prompt.name = name.value.trim() || prompt.name;
            prompt.body = editor.value;
            api.savePrompts(prompts);
            api.setActivePrompt(prompt.id);
            drawPanel();
          },
        }, "Save prompt"),
        h("button", {
          type: "button",
          class: "btn",
          onClick: () => {
            api.setActivePrompt(select.value);
            api.persist();
          },
        }, "Use this prompt"),
        h("button", {
          type: "button",
          class: "btn",
          onClick: () => {
            const id = `prompt-${Date.now()}`;
            prompts.push({ id, name: "New prompt", body: "You are editing {{workspace_name}}.\n\n{{skills_index}}" });
            api.savePrompts(prompts);
            api.setActivePrompt(id);
            drawPanel();
          },
        }, "New"),
      ]),
    );
    return wrap;
  }

  function agentPanel() {
    const agent = api.config.agent;
    const wrap = h("div", { class: "stack" });
    wrap.append(
      numberField("Max steps", agent.maxIterations, 1, 25, (value) => { agent.maxIterations = value; api.persist(); }),
      numberField("Max tokens", agent.maxTokens, 256, 32000, (value) => { agent.maxTokens = value; api.persist(); }),
      checkField("Apply file edits without asking", agent.autoApprove, (value) => { agent.autoApprove = value; api.persist(); }),
      checkField("Allow web_fetch", agent.allowWebFetch, (value) => { agent.allowWebFetch = value; api.persist(); }),
      checkField("Allow sandboxed JavaScript", agent.allowJavaScript, (value) => { agent.allowJavaScript = value; api.persist(); }),
      h("p", { class: "hint" }, "Sandboxed JavaScript cannot read the page, your keys, or the network. Leave it off unless you want the agent to compute something."),
      field("Font size", numberInput(api.config.fontSize, 11, 24, (value) => { api.config.fontSize = value; api.persist(); })),
      field("Theme", themeSelect()),
    );
    return wrap;
  }

  function themeSelect() {
    const select = h("select", { class: "field" });
    for (const theme of ["dark", "light"]) {
      const option = h("option", { value: theme }, theme);
      if (theme === api.config.theme) option.selected = true;
      select.append(option);
    }
    select.addEventListener("change", () => {
      api.config.theme = select.value;
      api.persist();
    });
    return select;
  }

  drawTabs();
  drawPanel();
  return modal;
}

function field(label, control) {
  return h("label", { class: "field-label" }, [label, control]);
}

function numberInput(value, min, max, onChange) {
  const input = h("input", { class: "field", type: "number", min: String(min), max: String(max), value: String(value) });
  input.addEventListener("change", () => onChange(Math.min(max, Math.max(min, Number(input.value) || value))));
  return input;
}

function numberField(label, value, min, max, onChange) {
  return field(label, numberInput(value, min, max, onChange));
}

function checkField(label, checked, onChange) {
  const input = h("input", { type: "checkbox" });
  input.checked = checked;
  input.addEventListener("change", () => onChange(input.checked));
  return h("label", { class: "check" }, [input, ` ${label}`]);
}
