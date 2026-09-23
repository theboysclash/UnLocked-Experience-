import { loadMonaco } from "./monaco-loader.js";

export async function createEditor(container, options) {
  try {
    const monaco = await Promise.race([
      loadMonaco(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Monaco timed out")), 7000)),
    ]);
    return new MonacoAdapter(monaco, container, options);
  } catch (error) {
    console.warn("Using the plain editor.", error);
    return new PlainAdapter(container, options);
  }
}

class MonacoAdapter {
  constructor(monaco, container, options) {
    this.kind = "monaco";
    this.monaco = monaco;
    this.suppress = false;
    this.editor = monaco.editor.create(container, {
      value: "",
      language: "plaintext",
      theme: options.theme === "light" ? "vs" : "vs-dark",
      fontSize: options.fontSize || 14,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      wordWrap: "on",
      padding: { top: 12, bottom: 12 },
      smoothScrolling: true,
      renderLineHighlight: "all",
    });
    this.editor.onDidChangeModelContent(() => {
      if (!this.suppress) options.onChange?.(this.getValue());
    });
    this.editor.onDidChangeCursorPosition(() => options.onCursor?.(this.position()));
  }

  setValue(value, language) {
    this.suppress = true;
    const model = this.editor.getModel();
    model.setValue(value ?? "");
    if (language) this.monaco.editor.setModelLanguage(model, language);
    this.suppress = false;
  }

  getValue() {
    return this.editor.getValue();
  }

  position() {
    const position = this.editor.getPosition();
    return { line: position?.lineNumber || 1, column: position?.column || 1 };
  }

  focus() {
    this.editor.focus();
  }

  layout() {
    this.editor.layout();
  }

  setFontSize(fontSize) {
    this.editor.updateOptions({ fontSize });
  }

  setTheme(theme) {
    this.monaco.editor.setTheme(theme === "light" ? "vs" : "vs-dark");
  }

  saveViewState() {
    return this.editor.saveViewState();
  }

  restoreViewState(state) {
    if (state) this.editor.restoreViewState(state);
  }
}

class PlainAdapter {
  constructor(container, options) {
    this.kind = "plain";
    this.options = options;
    container.classList.add("plain-editor");
    this.gutter = document.createElement("div");
    this.gutter.className = "plain-gutter";
    this.area = document.createElement("textarea");
    this.area.className = "plain-area";
    this.area.spellcheck = false;
    this.area.wrap = "off";
    this.area.setAttribute("aria-label", "Editor");
    container.append(this.gutter, this.area);
    this.area.style.fontSize = `${options.fontSize || 14}px`;
    this.area.addEventListener("input", () => {
      this.#numbers();
      options.onChange?.(this.getValue());
    });
    this.area.addEventListener("scroll", () => {
      this.gutter.scrollTop = this.area.scrollTop;
    });
    this.area.addEventListener("keyup", () => options.onCursor?.(this.position()));
    this.area.addEventListener("click", () => options.onCursor?.(this.position()));
    this.area.addEventListener("keydown", (event) => {
      if (event.key !== "Tab") return;
      event.preventDefault();
      const start = this.area.selectionStart;
      this.area.setRangeText("  ", start, this.area.selectionEnd, "end");
      this.area.dispatchEvent(new Event("input"));
    });
    this.#numbers();
  }

  setValue(value) {
    this.area.value = value ?? "";
    this.#numbers();
  }

  getValue() {
    return this.area.value;
  }

  position() {
    const before = this.area.value.slice(0, this.area.selectionStart);
    const lines = before.split("\n");
    return { line: lines.length, column: lines.at(-1).length + 1 };
  }

  focus() {
    this.area.focus();
  }

  layout() {}

  setFontSize(fontSize) {
    this.area.style.fontSize = `${fontSize}px`;
  }

  setTheme() {}

  saveViewState() {
    return { selectionStart: this.area.selectionStart, scrollTop: this.area.scrollTop };
  }

  restoreViewState(state) {
    if (!state) return;
    this.area.selectionStart = state.selectionStart;
    this.area.selectionEnd = state.selectionStart;
    this.area.scrollTop = state.scrollTop;
  }

  #numbers() {
    const count = this.area.value.split("\n").length;
    this.gutter.textContent = Array.from({ length: count }, (_, index) => index + 1).join("\n");
  }
}
