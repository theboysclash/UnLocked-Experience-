export function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key === "dataset") Object.assign(el.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) el.setAttribute(key, "");
    else el.setAttribute(key, String(value));
  }
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child == null || child === false) continue;
    el.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function clear(node) {
  node.replaceChildren();
}

export function toast(message, tone = "info") {
  let root = document.getElementById("toast-root");
  if (!root) {
    root = document.createElement("div");
    root.id = "toast-root";
    document.body.append(root);
  }
  const item = document.createElement("div");
  item.className = `toast toast-${tone}`;
  item.textContent = message;
  root.append(item);
  setTimeout(() => item.remove(), 4200);
}

export function openModal({ title, body, actions = [], wide = false, onClose } = {}) {
  const root = document.getElementById("modal-root");
  const backdrop = h("div", { class: "modal-backdrop" });
  const dialog = h("div", {
    class: `modal${wide ? " modal-wide" : ""}`,
    role: "dialog",
    "aria-modal": "true",
    "aria-label": title,
  });
  const header = h("header", { class: "modal-header" }, [
    h("h2", {}, title),
    h("button", { type: "button", class: "icon-btn", "aria-label": "Close", onClick: close }, "×"),
  ]);
  const content = h("div", { class: "modal-body" });
  if (typeof body === "string") content.textContent = body;
  else content.append(body);
  const footer = h("footer", { class: "modal-footer" });
  for (const action of actions) {
    footer.append(
      h(
        "button",
        {
          type: "button",
          class: action.primary ? "btn primary" : "btn",
          onClick: () => action.onClick?.({ close }),
        },
        action.label,
      ),
    );
  }
  dialog.append(header, content, footer);
  backdrop.append(dialog);
  root.append(backdrop);
  const previous = document.activeElement;
  dialog.querySelector("button, input, textarea, select")?.focus();

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    backdrop.remove();
    document.removeEventListener("keydown", onKey);
    if (previous && previous.focus) previous.focus();
    onClose?.();
  }

  function onKey(event) {
    if (event.key === "Escape") close();
  }
  document.addEventListener("keydown", onKey);
  backdrop.addEventListener("mousedown", (event) => {
    if (event.target === backdrop) close();
  });
  return { close, content, dialog };
}

export function askText({ title, label, value = "", confirm = "Save" }) {
  return new Promise((resolve) => {
    let settled = false;
    const input = h("input", { class: "field", value, spellcheck: "false" });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const modal = openModal({
      title,
      body: h("label", { class: "field-label" }, [label, input]),
      onClose: () => finish(null),
      actions: [
        { label: "Cancel", onClick: () => { finish(null); modal.close(); } },
        {
          label: confirm,
          primary: true,
          onClick: () => {
            finish(input.value.trim());
            modal.close();
          },
        },
      ],
    });
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      finish(input.value.trim());
      modal.close();
    });
    setTimeout(() => input.focus(), 0);
  });
}
