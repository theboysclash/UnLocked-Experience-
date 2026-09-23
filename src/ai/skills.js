export function parseSkill(markdown, source = "custom") {
  let body = String(markdown ?? "");
  let name = "";
  let description = "";
  const front = body.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (front) {
    body = body.slice(front[0].length);
    for (const line of front[1].split(/\r?\n/)) {
      const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (!match) continue;
      if (match[1] === "name") name = match[2].trim();
      if (match[1] === "description") description = match[2].trim();
    }
  }
  if (!name) {
    const parts = String(source).split("/");
    name = parts.at(-2) && parts.at(-1) === "SKILL.md" ? parts.at(-2) : parts.at(-1) || "skill";
  }
  if (!description) description = body.trim().split(/\r?\n/).find(Boolean)?.slice(0, 160) || "Project skill";
  return { id: name.toLowerCase().replace(/\s+/g, "-"), name, description, body: body.trim(), source };
}

export function toRawSkillUrl(input) {
  const url = new URL(String(input).trim());
  if (url.protocol !== "https:") throw new Error("Use an https URL");
  if (url.hostname === "github.com") {
    const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/);
    if (!match) throw new Error("Paste a GitHub file URL, not a repository URL");
    return `https://raw.githubusercontent.com/${match[1]}/${match[2]}/${match[3]}/${match[4]}`;
  }
  return url.toString();
}

export async function collectWorkspaceSkills(workspace) {
  const found = [];
  async function walk(path, depth) {
    if (depth > 5) return;
    let entries = [];
    try {
      entries = await workspace.list(path);
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = path ? `${path}/${entry.name}` : entry.name;
      if (entry.kind === "dir") await walk(child, depth + 1);
      else if (entry.name === "SKILL.md") found.push(parseSkill(await workspace.read(child), child));
    }
  }
  await walk(".skills", 0);
  return found;
}

export function skillsIndex(skills) {
  if (!skills.length) return "(none loaded)";
  return skills.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n");
}
