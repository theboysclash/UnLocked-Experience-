import { eventsFromResponse } from "./sse.js";

const PROVIDER_LABELS = {
  openrouter: "OpenRouter",
  openai: "OpenAI",
  anthropic: "Anthropic",
  ollama: "Ollama",
};

export function providerLabel(name) {
  return PROVIDER_LABELS[name] || name;
}

export function toOpenAIMessages(messages) {
  return messages.map((message) => {
    if (message.role === "tool") {
      return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      return {
        role: "assistant",
        content: message.content || null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments || "{}" },
        })),
      };
    }
    return { role: message.role, content: message.content ?? "" };
  });
}

export function toAnthropicPayload(messages) {
  const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
  const out = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "user") {
      out.push({ role: "user", content: message.content ?? "" });
    } else if (message.role === "assistant") {
      const content = [];
      if (message.content) content.push({ type: "text", text: message.content });
      for (const call of message.toolCalls || []) {
        content.push({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: parseObject(call.arguments),
        });
      }
      out.push({ role: "assistant", content: content.length ? content : "" });
    } else if (message.role === "tool") {
      const block = { type: "tool_result", tool_use_id: message.toolCallId, content: message.content ?? "" };
      const previous = out.at(-1);
      if (previous?.role === "user" && Array.isArray(previous.content)) previous.content.push(block);
      else out.push({ role: "user", content: [block] });
    }
  }
  return { system, messages: out };
}

function parseObject(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function trimError(text) {
  return String(text || "").replace(/\s+/g, " ").slice(0, 500);
}

function endpoint(baseUrl, path) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  return `${base}${path}`;
}

export function createProvider(config, apiKey) {
  const name = config.activeProvider;
  const spec = config.providers[name];
  if (!spec) throw new Error("Choose a provider in Settings");
  if (name === "anthropic") return new AnthropicProvider(spec, apiKey);
  return new OpenAICompatibleProvider(name, spec, apiKey);
}

class OpenAICompatibleProvider {
  constructor(name, spec, apiKey) {
    this.name = name;
    this.spec = spec;
    this.apiKey = apiKey;
    this.model = spec.defaultModel;
  }

  async *chat(messages, tools, { signal, maxTokens }) {
    if (this.name !== "ollama" && !this.apiKey) throw new Error(`Add a ${providerLabel(this.name)} API key in Settings`);
    const headers = { "Content-Type": "application/json" };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    if (this.name === "openrouter") {
      headers["HTTP-Referer"] = globalThis.location?.origin && globalThis.location.origin !== "null"
        ? globalThis.location.origin
        : "https://lumen.local";
      headers["X-Title"] = "Lumen IDE";
    }
    const response = await fetch(endpoint(this.spec.baseUrl, "/chat/completions"), {
      method: "POST",
      headers,
      signal,
      referrerPolicy: "no-referrer",
      body: JSON.stringify({
        model: this.model,
        messages: toOpenAIMessages(messages),
        tools: tools.length ? tools : undefined,
        stream: true,
        max_tokens: maxTokens,
      }),
    });
    if (!response.ok) throw new Error(await errorFrom(response, this.name));
    yield* eventsFromResponse(response, "openai");
  }
}

class AnthropicProvider {
  constructor(spec, apiKey) {
    this.name = "anthropic";
    this.spec = spec;
    this.apiKey = apiKey;
    this.model = spec.defaultModel;
  }

  async *chat(messages, tools, { signal, maxTokens }) {
    if (!this.apiKey) throw new Error("Add an Anthropic API key in Settings");
    const payload = toAnthropicPayload(messages);
    const response = await fetch(endpoint(this.spec.baseUrl, "/v1/messages"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      signal,
      referrerPolicy: "no-referrer",
      body: JSON.stringify({
        model: this.model,
        max_tokens: maxTokens,
        stream: true,
        system: payload.system,
        messages: payload.messages,
        tools: tools.map((tool) => ({
          name: tool.function.name,
          description: tool.function.description,
          input_schema: tool.function.parameters,
        })),
      }),
    });
    if (!response.ok) throw new Error(await errorFrom(response, "anthropic"));
    yield* eventsFromResponse(response, "anthropic");
  }
}

async function errorFrom(response, name) {
  const body = trimError(await response.text());
  if (response.status === 401) return `${providerLabel(name)} rejected the API key`;
  if (name === "anthropic" && (response.status === 400 || response.status === 0)) {
    return body || "Anthropic refused the browser request. OpenRouter is the reliable browser path.";
  }
  return body || `${providerLabel(name)} request failed (${response.status})`;
}

export async function testProvider(config, apiKey) {
  const provider = createProvider(config, apiKey);
  const messages = [{ role: "user", content: "Reply with the single word ok." }];
  let text = "";
  for await (const event of provider.chat(messages, [], { maxTokens: 16, signal: AbortSignal.timeout(20000) })) {
    if (event.type === "text") text += event.text;
  }
  return text.trim().slice(0, 80) || "Connected";
}
