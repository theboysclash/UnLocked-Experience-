export function createSidebar(root, api) {
  const expanded = new Set([""]);
  const cache = new Map();
  root.innerHTML = `
    <div class="side-head">
      <span class="side-title">Explorer</span>
      <div class="side-actions">
        <button type="button" data-act="file" title="New file">File</button>
        <button type="button" data-act="dir" title="New folder">Dir</button>
        <button type="button" data-act="refresh" title="Refresh">Refresh</button>
        <button type="button" data-act="delete" title="Delete active file">Delete</button>
      </div>
    </div>
    <label class="search-line">
      <input type="search" placeholder="Filter files or search text" spellcheck="false" />
    </label>
    <div class="tree" role="tree"></div>
    <div class="search-hits hidden"></div>
  `;
  const tree = root.querySelector(".tree");
  const hits = root.querySelector(".search-hits");
  const search = root.querySelector("input");

  root.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-act]");
    if (!button) return;
    if (button.dataset.act === "file") api.createFile();
    if (button.dataset.act === "dir") api.createDirectory();
    if (button.dataset.act === "refresh") refresh();
    if (button.dataset.act === "delete") api.deleteActive();
  });

  search.addEventListener("input", () => {
    hits.classList.add("hidden");
    render();
  });
  search.addEventListener("keydown", async (event) => {
    if (event.key !== "Enter") return;
    const query = search.value.trim();
    if (!query) return;
    hits.classList.remove("hidden");
    hits.textContent = "Searching…";
    const text = await api.searchText(query);
    hits.replaceChildren();
    for (const line of text.split("\n").filter(Boolean)) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "hit";
      button.textContent = line;
      const match = line.match(/^(.+?):(\d+):/);
      if (match) button.addEventListener("click", () => api.openFile(match[1]));
      hits.append(button);
    }
  });

  async function render() {
    if (!api.connected()) {
      tree.innerHTML = `<p class="empty-copy">Open a folder or start a virtual project.</p>`;
      return;
    }
    tree.replaceChildren();
    await renderDir("", tree, 0);
  }

  async function renderDir(path, parent, depth) {
    let entries = cache.get(path);
    if (!entries) {
      entries = await api.list(path);
      cache.set(path, entries);
    }
    const query = search.value.trim().toLowerCase();
    for (const entry of entries) {
      const child = path ? `${path}/${entry.name}` : entry.name;
      if (query && entry.kind === "file" && !child.toLowerCase().includes(query)) continue;
      const row = document.createElement("button");
      row.type = "button";
      row.className = `tree-row${api.activePath() === child ? " active" : ""}`;
      row.style.paddingLeft = `${10 + depth * 14}px`;
      row.setAttribute("role", "treeitem");
      const mark = entry.kind === "dir" ? (expanded.has(child) ? "▾" : "▸") : "·";
      row.innerHTML = `<span class="twisty">${mark}</span><span class="tname"></span>`;
      row.querySelector(".tname").textContent = entry.name;
      row.addEventListener("click", async () => {
        if (entry.kind === "dir") {
          if (expanded.has(child)) expanded.delete(child);
          else expanded.add(child);
          await render();
        } else await api.openFile(child);
      });
      parent.append(row);
      if (entry.kind === "dir" && expanded.has(child)) await renderDir(child, parent, depth + 1);
    }
  }

  async function refresh() {
    cache.clear();
    hits.classList.add("hidden");
    await render();
  }

  function reveal(path) {
    const parts = String(path || "").split("/").filter(Boolean);
    parts.pop();
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      expanded.add(current);
    }
  }

  return {
  refresh,
  reveal,
  invalidate() {
    cache.clear();
  },
};
}
