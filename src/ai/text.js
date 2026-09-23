export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

export function segments(src) {
  const text = String(src ?? "");
  const out = [];
  const fence = /```([^\n`]*)\n([\s\S]*?)```/g;
  let last = 0;
  for (const match of text.matchAll(fence)) {
    if (match.index > last) out.push({ type: "text", text: text.slice(last, match.index) });
    out.push({ type: "code", lang: match[1].trim(), text: match[2].replace(/\n$/, "") });
    last = match.index + match[0].length;
  }
  const rest = text.slice(last);
  const open = rest.match(/```([^\n`]*)\n([\s\S]*)$/);
  if (open) {
    const before = rest.slice(0, open.index);
    if (before) out.push({ type: "text", text: before });
    out.push({ type: "code", lang: open[1].trim(), text: open[2] });
  } else if (rest) out.push({ type: "text", text: rest });
  return out;
}

export function markdownToHtml(src) {
  return segments(src)
    .map((part) => {
      if (part.type === "code") {
        return `<div class="codeblock"><div class="codebar"><span>${escapeHtml(part.lang || "text")}</span><button type="button" data-copy>Copy</button></div><pre><code>${escapeHtml(part.text)}</code></pre></div>`;
      }
      return textToHtml(part.text);
    })
    .join("");
}

function textToHtml(text) {
  const escaped = escapeHtml(text).replace(/`([^`]+)`/g, "<code class=\"inline\">$1</code>");
  const linked = escaped.replace(/https:\/\/[^\s<]+/g, (url) => `<a href="${url}" target="_blank" rel="noreferrer">${url}</a>`);
  return linked
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${paragraph.replaceAll("\n", "<br>")}</p>`)
    .join("");
}

export function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text || "").length / 4));
}

export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
