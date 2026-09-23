export function diffLines(before, after) {
  const a = String(before ?? "").split("\n");
  const b = String(after ?? "").split("\n");
  if (a.length * b.length > 500_000) {
    return [
      { type: "del", text: `… ${a.length} lines replaced …` },
      { type: "add", text: `… ${b.length} new lines …` },
    ];
  }
  const dp = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ type: "eq", text: a[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: "del", text: a[i] });
      i += 1;
    } else {
      out.push({ type: "add", text: b[j] });
      j += 1;
    }
  }
  while (i < a.length) out.push({ type: "del", text: a[i++] });
  while (j < b.length) out.push({ type: "add", text: b[j++] });
  return out;
}

export function compactDiff(diff, context = 3) {
  const keep = new Set();
  diff.forEach((row, index) => {
    if (row.type === "eq") return;
    for (let i = Math.max(0, index - context); i <= Math.min(diff.length - 1, index + context); i += 1) {
      keep.add(i);
    }
  });
  const out = [];
  let skipping = false;
  diff.forEach((row, index) => {
    if (!keep.has(index)) {
      skipping = true;
      return;
    }
    if (skipping) {
      out.push({ type: "skip", text: "…" });
      skipping = false;
    }
    out.push(row);
  });
  return out.length ? out : diff.slice(0, 1);
}

export function diffToHtml(before, after) {
  return compactDiff(diffLines(before, after))
    .map((row) => {
      const sign = row.type === "add" ? "+" : row.type === "del" ? "-" : row.type === "skip" ? "" : " ";
      return `<div class="diff-line diff-${row.type}"><span>${sign}</span><code>${escape(row.text)}</code></div>`;
    })
    .join("");
}

function escape(value) {
  return String(value).replace(/[&<>]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[char]));
}
