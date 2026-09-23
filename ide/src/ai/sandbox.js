const SRCDOC = `<!DOCTYPE html>
<html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'">
</head><body><script>
function stringify(value) {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  try { return JSON.stringify(value); } catch { return String(value); }
}
const logs = [];
const consoleProxy = {
  log(...args) { logs.push(args.map(stringify).join(" ")); },
  info(...args) { logs.push(args.map(stringify).join(" ")); },
  warn(...args) { logs.push(args.map(stringify).join(" ")); },
  error(...args) { logs.push(args.map(stringify).join(" ")); }
};
window.addEventListener("message", async (event) => {
  const data = event.data;
  if (!data || data.type !== "run") return;
  try {
    const fn = new Function("console", '"use strict";\\n' + String(data.code || ""));
    const value = await fn(consoleProxy);
    parent.postMessage({ type: "result", id: data.id, ok: true, value: stringify(value), logs }, "*");
  } catch (error) {
    parent.postMessage({ type: "result", id: data.id, ok: false, error: String(error && error.message || error), logs }, "*");
  }
});
parent.postMessage({ type: "ready" }, "*");
</script></body></html>`;

export function runInSandbox(code, { timeoutMs = 2000 } = {}) {
  if (typeof document === "undefined") return Promise.reject(new Error("JavaScript sandbox is only available in the browser"));
  const source = String(code ?? "");
  if (source.length > 20_000) return Promise.reject(new Error("Code is too long for the sandbox"));
  return new Promise((resolve, reject) => {
    const iframe = document.createElement("iframe");
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.setAttribute("title", "JavaScript sandbox");
    iframe.style.display = "none";
    const id = globalThis.crypto?.randomUUID?.() || String(Math.random());
    let settled = false;
    const timer = setTimeout(() => finish(() => reject(new Error("Sandbox timed out"))), timeoutMs);

    function finish(callback) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      iframe.remove();
      callback();
    }

    function onMessage(event) {
      if (event.source !== iframe.contentWindow) return;
      const data = event.data || {};
      if (data.type === "ready") {
        iframe.contentWindow.postMessage({ type: "run", id, code: source }, "*");
        return;
      }
      if (data.type !== "result" || data.id !== id) return;
      const logs = Array.isArray(data.logs) ? data.logs.join("\n") : "";
      if (!data.ok) {
        finish(() => reject(new Error([data.error || "Sandbox error", logs].filter(Boolean).join("\n"))));
        return;
      }
      finish(() => resolve([data.value === "undefined" ? "" : data.value, logs].filter(Boolean).join("\n") || "undefined"));
    }

    window.addEventListener("message", onMessage);
    document.body.append(iframe);
    iframe.srcdoc = SRCDOC;
  });
}
