import assert from "node:assert/strict";
import test from "node:test";
import { runAgent } from "../src/ai/agent.js";
import { diffLines } from "../src/ai/diff.js";
import { assertPublicHttpUrl } from "../src/ai/net.js";
import { interpolate } from "../src/ai/prompts.js";
import { toAnthropicPayload, toOpenAIMessages } from "../src/ai/providers.js";
import { eventsFromResponse } from "../src/ai/sse.js";
import { parseSkill, skillsIndex, toRawSkillUrl } from "../src/ai/skills.js";
import { markdownToHtml, segments } from "../src/ai/text.js";
import { applySearchReplace } from "../src/ai/tools.js";
import { sanitizeConfig } from "../src/config.js";
import { splitPath } from "../src/fs/paths.js";
import { crc32, unzipStore, zipStore } from "../src/fs/zip.js";

test("paths reject traversal and absolutes", () => {
  assert.deepEqual(splitPath("src/main.js"), ["src", "main.js"]);
  assert.deepEqual(splitPath(""), []);
  assert.throws(() => splitPath("../etc/passwd"), /traversal/);
  assert.throws(() => splitPath("/etc/passwd"), /Absolute/);
});

test("zip store round-trips text and a known crc", async () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  const zipped = zipStore([{ name: "src/a.js", data: "export const n = 1;\n" }]);
  const files = await unzipStore(zipped);
  assert.equal(files.length, 1);
  assert.equal(files[0].name, "src/a.js");
  assert.equal(new TextDecoder().decode(files[0].data), "export const n = 1;\n");
});

test("search replace is exact and refuses ambiguous matches", () => {
  assert.equal(applySearchReplace("one two", "two", "three", false), "one three");
  assert.equal(applySearchReplace("one two two", "two", "three", true), "one three three");
  assert.throws(() => applySearchReplace("one two two", "two", "three", false), /matched 2/);
  assert.throws(() => applySearchReplace("alpha", "missing", "x"), /not found/);
});

test("diff marks an inserted line", () => {
  const diff = diffLines("a\nb", "a\nB\nb");
  assert.deepEqual(diff.filter((row) => row.type !== "eq"), [{ type: "add", text: "B" }]);
});

test("prompt variables and config stay free of secrets", () => {
  assert.equal(interpolate("in {{workspace_name}}", { workspace_name: "demo" }), "in demo");
  assert.equal(interpolate("{{unknown}}", {}), "{{unknown}}");
  const config = sanitizeConfig({
    activeProvider: "openai",
    fontSize: 99,
    providers: { openrouter: { key: "sk-secret", defaultModel: "custom/model" } },
    agent: { maxIterations: 3, autoApprove: true },
  });
  assert.equal(config.providers.openrouter.key, undefined);
  assert.equal(config.providers.openrouter.defaultModel, "custom/model");
  assert.equal(config.fontSize, 24);
  assert.equal(config.agent.maxIterations, 3);
  assert.equal(config.agent.autoApprove, true);
  assert.equal(config.activeProvider, "openai");
});

test("skills parse front matter and github blob urls", () => {
  const skill = parseSkill("---\nname: react-testing\ndescription: Test React\n---\nUse the runner.\n", ".skills/react-testing/SKILL.md");
  assert.equal(skill.name, "react-testing");
  assert.equal(skill.description, "Test React");
  assert.match(skill.body, /runner/);
  assert.equal(
    toRawSkillUrl("https://github.com/acme/ide/blob/main/.skills/react-testing/SKILL.md"),
    "https://raw.githubusercontent.com/acme/ide/main/.skills/react-testing/SKILL.md",
  );
  assert.match(skillsIndex([skill]), /react-testing/);
});

test("web fetch blocks private targets", () => {
  assert.equal(assertPublicHttpUrl("https://example.com/a").hostname, "example.com");
  for (const url of ["http://127.0.0.1/", "http://localhost/x", "https://192.168.1.1/", "https://10.0.0.5/", "http://user:pw@example.com"]) {
    assert.throws(() => assertPublicHttpUrl(url), Error, url);
  }
});

test("markdown escapes html and keeps fences", () => {
  const html = markdownToHtml("See `x`\n\n```js\n<script>alert(1)</script>\n```");
  assert.equal(html.includes("<script>alert"), false);
  assert.match(html, /&lt;script&gt;/);
  assert.equal(segments("```js\nlet a = 1").at(-1).type, "code");
});

test("openai stream assembles text and tool calls", async () => {
  const sse = [
    'data: {"choices":[{"delta":{"content":"Hi"}}]}',
    "",
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{\\"path\\":"}}]}}]}',
    "",
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.js\\"}"}}]}}]}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const response = new Response(streamOf(sse), { headers: { "content-type": "text/event-stream" } });
  const events = [];
  for await (const event of eventsFromResponse(response, "openai")) events.push(event);
  assert.equal(events.find((event) => event.type === "text").text, "Hi");
  const call = events.find((event) => event.type === "tool_calls").calls[0];
  assert.equal(call.name, "read_file");
  assert.equal(call.arguments, '{"path":"a.js"}');
});

test("anthropic stream and message conversion", async () => {
  const sse = [
    "event: content_block_delta",
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}',
    "",
    "event: content_block_start",
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"list_dir","input":{}}}',
    "",
    "event: content_block_delta",
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{}"}}',
    "",
  ].join("\n");
  const response = new Response(streamOf(sse), { headers: { "content-type": "text/event-stream" } });
  const events = [];
  for await (const event of eventsFromResponse(response, "anthropic")) events.push(event);
  assert.equal(events[0].text, "Hi");
  assert.equal(events.at(-1).calls[0].name, "list_dir");

  const payload = toAnthropicPayload([
    { role: "system", content: "be brief" },
    { role: "user", content: "go" },
    { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "list_dir", arguments: "{\"path\":\"\"}" }] },
    { role: "tool", toolCallId: "t1", content: "file a.js" },
  ]);
  assert.equal(payload.system, "be brief");
  assert.equal(payload.messages.at(-1).content[0].type, "tool_result");
  const openAI = toOpenAIMessages([{ role: "assistant", content: "", toolCalls: [{ id: "t1", name: "list_dir", arguments: "{}" }] }]);
  assert.equal(openAI[0].tool_calls[0].function.name, "list_dir");
});

test("agent asks before writing and stops after the answer", async () => {
  const messages = [{ role: "user", content: "change it" }];
  const seen = [];
  let writes = 0;
  let step = 0;
  const provider = {
    async *chat(history) {
      seen.push(history.map((message) => message.role).join(","));
      step += 1;
      if (step === 1) {
        yield { type: "tool_calls", calls: [{ id: "1", name: "edit_file", arguments: JSON.stringify({ path: "a.js", old_string: "a", new_string: "b" }) }] };
      } else {
        yield { type: "text", text: "left it" };
      }
    },
  };
  await runAgent({
    messages,
    provider,
    tools: [],
    maxIterations: 4,
    context: {
      autoApprove: false,
      maxTokens: 100,
      async readFile() { return "a"; },
      async writeFile() { writes += 1; },
      async requestApproval() { return false; },
    },
    onEvent() {},
  });
  assert.equal(seen[0], "user");
  assert.equal(writes, 0);
  assert.match(messages.find((message) => message.role === "tool").content, /rejected/);
  assert.equal(messages.at(-1).content, "left it");
});

function streamOf(text) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}
