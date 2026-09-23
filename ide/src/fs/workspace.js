import { SKIP_DIRS, splitPath } from "./paths.js";

const TEXT_LIMIT = 2_000_000;

async function ensurePermission(handle) {
  const options = { mode: "readwrite" };
  if (handle.queryPermission) {
    const current = await handle.queryPermission(options);
    if (current === "granted") return;
  }
  if (handle.requestPermission) {
    const next = await handle.requestPermission(options);
    if (next !== "granted") throw new Error("Folder permission was not granted");
  }
}

function isBinary(text) {
  return text.includes("\0");
}

export class Workspace {
  constructor(store) {
    this.store = store;
    this.mode = "none";
    this.root = null;
    this.name = "No folder";
    this.files = new Map();
  }

  get connected() {
    return this.mode === "directory" || this.mode === "virtual";
  }

  async virtualCount() {
    const rows = await this.store.all("files");
    return rows.length;
  }

  async savedDirectoryName() {
    const handle = await this.store.get("kv", "dirHandle");
    return handle?.name || "";
  }

  async beginVirtual(name = "Virtual project", { seed = true } = {}) {
    await this.store.clear("files");
    this.files.clear();
    this.root = null;
    this.mode = "virtual";
    this.name = name;
    await this.store.put("kv", name, "virtualName");
    if (!seed) return;
    await this.write("README.md", `# ${name}\n\nFiles in this project stay in the browser until you export them.\n`);
    await this.write("src/main.js", "export function hello(name) {\n  return `Hello, ${name}`;\n}\n");
  }

  async newVirtual(name = "Virtual project") {
    await this.beginVirtual(name, { seed: true });
  }

  async resumeVirtual() {
    const rows = await this.store.all("files");
    this.files.clear();
    for (const row of rows) {
      if (row && typeof row.path === "string") this.files.set(row.path, row.content ?? "");
    }
    this.root = null;
    this.mode = "virtual";
    this.name = (await this.store.get("kv", "virtualName")) || "Virtual project";
    return this.files.size;
  }

  async openDirectory() {
    if (typeof window.showDirectoryPicker !== "function") {
      throw new Error("This browser cannot grant live folder access. Import a copy instead.");
    }
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    await ensurePermission(handle);
    this.root = handle;
    this.mode = "directory";
    this.name = handle.name;
    this.files.clear();
    await this.store.put("kv", handle, "dirHandle");
  }

  async reconnectDirectory() {
    const handle = await this.store.get("kv", "dirHandle");
    if (!handle) return false;
    await ensurePermission(handle);
    this.root = handle;
    this.mode = "directory";
    this.name = handle.name;
    this.files.clear();
    return true;
  }

  async list(path = "") {
    const parts = splitPath(path || "");
    if (this.mode === "virtual") return this.#listVirtual(parts);
    if (this.mode !== "directory") return [];
    const dir = await this.#directoryHandle(parts);
    const entries = [];
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === "directory" && SKIP_DIRS.has(name)) continue;
      if (name === ".keep") continue;
      entries.push({ name, kind: handle.kind === "directory" ? "dir" : "file" });
    }
    entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return entries;
  }

  async read(path) {
    const parts = splitPath(path);
    if (!parts.length) throw new Error("Choose a file path");
    if (this.mode === "virtual") {
      const key = parts.join("/");
      if (!this.files.has(key)) throw new Error(`File not found: ${key}`);
      return this.files.get(key);
    }
    if (this.mode !== "directory") throw new Error("Open a folder first");
    const handle = await this.#fileHandle(parts, false);
    const file = await handle.getFile();
    if (file.size > TEXT_LIMIT) throw new Error("File is too large to open here");
    const text = await file.text();
    if (isBinary(text)) throw new Error("Binary files are not supported");
    return text;
  }

  async write(path, content) {
    const parts = splitPath(path);
    if (!parts.length) throw new Error("Choose a file path");
    const text = String(content);
    if (text.includes("\0")) throw new Error("Binary files are not supported");
    if (this.mode === "virtual") {
      const key = parts.join("/");
      this.files.set(key, text);
      await this.store.put("files", { path: key, content: text }, key);
      return;
    }
    if (this.mode !== "directory") throw new Error("Open a folder first");
    const handle = await this.#fileHandle(parts, true);
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
  }

  async makeDir(path) {
    const parts = splitPath(path);
    if (!parts.length) throw new Error("Choose a folder name");
    if (this.mode === "virtual") {
      await this.write(`${parts.join("/")}/.keep`, "");
      return;
    }
    if (this.mode !== "directory") throw new Error("Open a folder first");
    let current = this.root;
    for (const part of parts) current = await current.getDirectoryHandle(part, { create: true });
  }

  async remove(path) {
    const parts = splitPath(path);
    if (!parts.length) throw new Error("Choose a path");
    if (this.mode === "virtual") {
      const key = parts.join("/");
      const prefix = `${key}/`;
      for (const name of [...this.files.keys()]) {
        if (name === key || name.startsWith(prefix)) {
          this.files.delete(name);
          await this.store.delete("files", name);
        }
      }
      return;
    }
    const parent = await this.#directoryHandle(parts.slice(0, -1));
    await parent.removeEntry(parts[parts.length - 1], { recursive: true });
  }

  async filesForExport() {
    if (this.mode === "virtual") {
      return [...this.files.entries()].map(([name, content]) => ({ name, content }));
    }
    if (this.mode !== "directory") return [];
    const files = [];
    await this.#walk("", files, 0);
    return files;
  }

  #listVirtual(parts) {
    const prefix = parts.join("/");
    const children = new Map();
    for (const filePath of this.files.keys()) {
      if (prefix && filePath !== prefix && !filePath.startsWith(`${prefix}/`)) continue;
      if (filePath === prefix) continue;
      const rest = prefix ? filePath.slice(prefix.length + 1) : filePath;
      const [name, ...more] = rest.split("/");
      if (!name || name === ".keep" || SKIP_DIRS.has(name)) continue;
      const kind = more.length ? "dir" : "file";
      const previous = children.get(name);
      if (!previous || kind === "dir") children.set(name, kind);
    }
    return [...children.entries()]
      .map(([name, kind]) => ({ name, kind }))
      .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
  }

  async #walk(path, files, depth) {
    if (depth > 8 || files.length >= 2000) return;
    const entries = await this.list(path);
    for (const entry of entries) {
      const child = path ? `${path}/${entry.name}` : entry.name;
      if (entry.kind === "dir") await this.#walk(child, files, depth + 1);
      else {
        try {
          const content = await this.read(child);
          if (content.length <= 200_000) files.push({ name: child, content });
        } catch {
          // Skip unreadable files during export and search.
        }
      }
    }
  }

  async #directoryHandle(parts) {
    let current = this.root;
    for (const part of parts) current = await current.getDirectoryHandle(part);
    return current;
  }

  async #fileHandle(parts, create) {
    const dirParts = parts.slice(0, -1);
    let current = this.root;
    for (const part of dirParts) {
      current = await current.getDirectoryHandle(part, { create });
    }
    return current.getFileHandle(parts[parts.length - 1], { create });
  }
}
