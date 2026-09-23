import { assertPublicHttpUrl, combineSignals } from "./net.js";

export function applySearchReplace(content, oldString, newString, replaceAll = false) {
  const current = String(content ?? "");
  const next = String(newString ?? "");
  const previous = String(oldString ?? "");
  if (!previous) {
    if (current.trim()) throw new Error("old_string is empty. Use write_file to create or replace a whole file.");
    return next;
  }
  const count = current.split(previous).length - 1;
  if (count === 0) throw new Error("old_string was not found. Read the file and copy an exact snippet.");
  if (count > 1 && !replaceAll) throw new Error(`old_string matched ${count} times. Include more context or set replace_all.`);
  return replaceAll ? current.split(previous).join(next) : current.replace(previous, next);
}

export function toolDefinitions({ allowWebFetch, allowJavaScript }) {
  const tools = [
    fn("list_dir", "List one directory in the workspace. path is relative and may be empty for the root.", {
      path: { type: "string", description: "Relative directory path. Empty lists the workspace root." },
    }, []),
    fn("read_file", "Read a text file. Lines are prefixed with N| for reference. Those prefixes are not part of the file.", {
      path: { type: "string" },
      offset: { type: "integer", description: "1-based starting line. Defaults to 1." },
      limit: { type: "integer", description: "Maximum lines. Defaults to 400." },
    }, ["path"]),
    fn("search_text", "Search workspace text files. Skips dependency and VCS folders.", {
      query: { type: "string" },
      path: { type: "string", description: "Optional directory to search under." },
    }, ["query"]),
    fn("edit_file", "Replace an exact snippet in an existing file. old_string and new_string are raw file text, without line-number prefixes.", {
      path: { type: "string" },
      old_string: { type: "string" },
      new_string: { type: "string" },
      replace_all: { type: "boolean" },
    }, ["path", "old_string", "new_string"]),
    fn("write_file", "Create a file or replace its entire contents.", {
      path: { type: "string" },
      content: { type: "string" },
    }, ["path", "content"]),
    fn("load_skill", "Load the full instructions for a named skill.", {
      name: { type: "string" },
    }, ["name"]),
  ];
  if (allowWebFetch) {
    tools.push(fn("web_fetch", "Fetch a public http(s) URL from the browser. Private addresses are blocked. Cross-origin targets may fail.", {
      url: { type: "string" },
    }, ["url"]));
  }
  if (allowJavaScript) {
    tools.push(fn("run_javascript", "Run JavaScript in a sandbox with no page, file, or network access. Return a JSON-friendly value or use console.log.", {
      code: { type: "string" },
    }, ["code"]));
  }
  return tools;
}

function fn(name, description, properties, required) {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object", properties, required, additionalProperties: false },
    },
  };
}

export function parseToolArguments(value) {
  if (value && typeof value === "object") return value;
  try {
    const parsed = JSON.parse(value || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("bad");
    return parsed;
  } catch {
    throw new Error("Tool arguments were not valid JSON");
  }
}

export async function executeTool(call, ctx) {
  const args = parseToolArguments(call.arguments);
  switch (call.name) {
    case "list_dir":
      return ctx.listDir(args.path || "");
    case "read_file":
      return formatRead(await ctx.readFile(args.path), args.offset, args.limit);
    case "search_text":
      return ctx.searchText(args.query, args.path || "");
    case "edit_file": {
      const before = await ctx.readFile(args.path);
      const after = applySearchReplace(before, args.old_string, args.new_string, Boolean(args.replace_all));
      if (before === after) return "No changes.";
      if (!ctx.autoApprove) {
        const approved = await ctx.requestApproval({ path: args.path, before, after, title: `Edit ${args.path}` });
        if (!approved) return "The user rejected this edit.";
      }
      await ctx.writeFile(args.path, after);
      return `Updated ${args.path}`;
    }
    case "write_file": {
      let before = "";
      try {
        before = await ctx.readFile(args.path);
      } catch {
        before = "";
      }
      const after = String(args.content ?? "");
      if (before === after) return "No changes.";
      if (!ctx.autoApprove) {
        const approved = await ctx.requestApproval({
          path: args.path,
          before,
          after,
          title: before ? `Replace ${args.path}` : `Create ${args.path}`,
        });
        if (!approved) return "The user rejected this write.";
      }
      await ctx.writeFile(args.path, after);
      return before ? `Replaced ${args.path}` : `Created ${args.path}`;
    }
    case "load_skill":
      return ctx.loadSkill(args.name);
    case "web_fetch":
      if (!ctx.allowWebFetch) return "web_fetch is disabled in Settings.";
      return fetchPublic(args.url, ctx.signal);
    case "run_javascript":
      if (!ctx.allowJavaScript) return "run_javascript is disabled in Settings.";
      return ctx.runJavaScript(args.code);
    default:
      return `Unknown tool: ${call.name}`;
  }
}

function formatRead(text, offset, limit) {
  const lines = String(text).split("\n");
  const start = Math.max(1, Number(offset) || 1);
  const count = Math.min(800, Math.max(1, Number(limit) || 400));
  const slice = lines.slice(start - 1, start - 1 + count);
  const body = slice.map((line, index) => `${start + index}|${line}`).join("\n");
  const omitted = lines.length - (start - 1 + slice.length);
  return omitted > 0 ? `${body}\n… ${omitted} more lines` : body;
}

async function fetchPublic(input, signal) {
  const url = assertPublicHttpUrl(input);
  const response = await fetch(url, {
    signal: combineSignals([signal], 20000),
    redirect: "follow",
    referrerPolicy: "no-referrer",
  });
  if (!response.ok) return `Fetch failed (${response.status}) for ${url.origin}${url.pathname}`;
  const type = response.headers.get("content-type") || "";
  if (type && !/text|json|xml|javascript|svg|yaml/.test(type)) return `Non-text response (${type || "unknown"})`;
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  while (text.length < 100_000) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  reader.cancel().catch(() => {});
  if (text.length >= 100_000) text = `${text.slice(0, 100_000)}\n… truncated`;
  return text;
}
