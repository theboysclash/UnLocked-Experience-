export function splitPath(input) {
  if (typeof input !== "string") throw new Error("Path must be a string");
  const cleaned = input.replaceAll("\\", "/").trim();
  if (!cleaned || cleaned === "." || cleaned === "/") return [];
  if (cleaned.startsWith("/")) throw new Error("Absolute paths are not allowed");
  const parts = [];
  for (const part of cleaned.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") throw new Error("Path traversal is not allowed");
    if (part.includes("\0")) throw new Error("Invalid path");
    parts.push(part);
  }
  return parts;
}

export function toPath(input) {
  return splitPath(input).join("/");
}

export function parentPath(path) {
  const parts = splitPath(path);
  parts.pop();
  return parts.join("/");
}

export function baseName(path) {
  const parts = splitPath(path);
  return parts[parts.length - 1] || "";
}

export function languageFromPath(path) {
  const name = baseName(path).toLowerCase();
  const ext = name.includes(".") ? name.split(".").pop() : "";
  const map = {
    js: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    jsx: "javascript",
    ts: "typescript",
    tsx: "typescript",
    json: "json",
    md: "markdown",
    css: "css",
    html: "html",
    htm: "html",
    py: "python",
    go: "go",
    rs: "rust",
    rb: "ruby",
    java: "java",
    c: "c",
    h: "c",
    cpp: "cpp",
    cc: "cpp",
    yml: "yaml",
    yaml: "yaml",
    sh: "shell",
    bash: "shell",
    xml: "xml",
    svg: "xml",
    sql: "sql",
    toml: "ini",
    txt: "plaintext",
  };
  return map[ext] || "plaintext";
}

export const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".next", "coverage", ".cache"]);
