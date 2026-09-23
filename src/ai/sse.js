export function parseSseRecord(raw) {
  let event = "message";
  const data = [];
  for (const line of String(raw).split("\n")) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  if (!data.length) return null;
  return { event, data: data.join("\n") };
}

export function splitSse(buffer) {
  const normalized = buffer.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const records = [];
  let rest = normalized;
  let index = rest.indexOf("\n\n");
  while (index >= 0) {
    const record = parseSseRecord(rest.slice(0, index));
    if (record) records.push(record);
    rest = rest.slice(index + 2);
    index = rest.indexOf("\n\n");
  }
  return { records, rest };
}

export function createOpenAIAccumulator() {
  const calls = new Map();
  return {
    consume(json) {
      const events = [];
      if (json?.error) {
        events.push({ type: "error", message: json.error.message || "Provider returned an error" });
        return events;
      }
      const choice = json?.choices?.[0];
      if (!choice) return events;
      const delta = choice.delta || {};
      const message = choice.message || {};
      const text = delta.content ?? (!choice.delta ? message.content : "") ?? "";
      if (typeof text === "string" && text) events.push({ type: "text", text });
      const toolDeltas = delta.tool_calls || (!choice.delta ? message.tool_calls : []) || [];
      toolDeltas.forEach((toolCall, position) => {
        const index = toolCall.index ?? position;
        const current = calls.get(index) || { id: "", name: "", arguments: "" };
        if (toolCall.id) current.id = toolCall.id;
        const name = toolCall.function?.name || "";
        const args = toolCall.function?.arguments || "";
        if (name) current.name += name;
        if (args) current.arguments += args;
        calls.set(index, current);
      });
      return events;
    },
    finish() {
      const callsList = [...calls.entries()]
        .sort((left, right) => left[0] - right[0])
        .map(([, call], index) => ({
          id: call.id || `call_${index}`,
          name: call.name,
          arguments: call.arguments || "{}",
        }))
        .filter((call) => call.name);
      return callsList.length ? [{ type: "tool_calls", calls: callsList }] : [];
    },
  };
}

export function createAnthropicAccumulator() {
  const blocks = [];
  return {
    consume(record) {
      const events = [];
      let json;
      try {
        json = JSON.parse(record.data);
      } catch {
        return events;
      }
      if (json.type === "error" || json.error) {
        events.push({ type: "error", message: json.error?.message || "Anthropic returned an error" });
        return events;
      }
      if (json.type === "content_block_start") {
        const block = json.content_block || {};
        blocks[json.index ?? blocks.length] = {
          type: block.type,
          id: block.id || "",
          name: block.name || "",
          arguments: "",
        };
      }
      if (json.type === "content_block_delta") {
        const block = blocks[json.index ?? 0] || { type: "text", arguments: "", name: "", id: "" };
        const delta = json.delta || {};
        if (delta.type === "text_delta" && delta.text) events.push({ type: "text", text: delta.text });
        if (delta.type === "input_json_delta" && delta.partial_json) block.arguments += delta.partial_json;
        blocks[json.index ?? 0] = block;
      }
      if (Array.isArray(json.content)) {
        for (const block of json.content) {
          if (block.type === "text" && block.text) events.push({ type: "text", text: block.text });
          if (block.type === "tool_use") {
            blocks.push({
              type: "tool_use",
              id: block.id,
              name: block.name,
              arguments: JSON.stringify(block.input ?? {}),
            });
          }
        }
      }
      return events;
    },
    finish() {
      const calls = blocks
        .filter((block) => block?.type === "tool_use" && block.name)
        .map((block, index) => ({
          id: block.id || `call_${index}`,
          name: block.name,
          arguments: block.arguments || "{}",
        }));
      return calls.length ? [{ type: "tool_calls", calls }] : [];
    },
  };
}

export async function* eventsFromResponse(response, kind) {
  const accumulator = kind === "anthropic" ? createAnthropicAccumulator() : createOpenAIAccumulator();
  const contentType = response.headers.get("content-type") || "";
  if (!response.body) throw new Error("The provider returned an empty body");
  if (contentType.includes("application/json") && !contentType.includes("text/event-stream")) {
    const json = await response.json();
    yield* take(kind === "anthropic" ? accumulator.consume({ event: "message", data: JSON.stringify(json) }) : accumulator.consume(json));
    yield* accumulator.finish();
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const split = splitSse(buffer);
    buffer = split.rest;
    for (const record of split.records) yield* consumeRecord(kind, accumulator, record);
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    const record = parseSseRecord(buffer);
    if (record) yield* consumeRecord(kind, accumulator, record);
  }
  yield* accumulator.finish();
}

function* consumeRecord(kind, accumulator, record) {
  if (record.data === "[DONE]") return;
  const events = kind === "anthropic" ? accumulator.consume(record) : consumeOpenAI(accumulator, record);
  yield* take(events);
}

function consumeOpenAI(accumulator, record) {
  try {
    return accumulator.consume(JSON.parse(record.data));
  } catch {
    return [];
  }
}

function* take(events) {
  for (const event of events) {
    if (event.type === "error") throw new Error(event.message);
    yield event;
  }
}
