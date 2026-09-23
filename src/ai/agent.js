import { executeTool } from "./tools.js";

export async function runAgent({ messages, provider, tools, context, maxIterations, signal, onEvent }) {
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    if (signal?.aborted) throw abortError();
    onEvent({ type: "iteration", index: iteration });
    const assistant = { role: "assistant", content: "", toolCalls: [] };
    try {
      for await (const event of provider.chat(messages, tools, { signal, maxTokens: context.maxTokens })) {
        if (signal?.aborted) throw abortError();
        if (event.type === "text") {
          assistant.content += event.text;
          onEvent({ type: "text", text: event.text });
        } else if (event.type === "tool_calls") {
          assistant.toolCalls = event.calls;
        }
      }
    } catch (error) {
      if (assistant.content || assistant.toolCalls.length) messages.push(assistant);
      throw error;
    }
    messages.push(assistant);
    onEvent({ type: "assistant_done", message: assistant });
    if (!assistant.toolCalls.length) return assistant;
    for (const call of assistant.toolCalls) {
      if (signal?.aborted) throw abortError();
      onEvent({ type: "tool_start", call });
      let content;
      try {
        content = await executeTool(call, context);
      } catch (error) {
        content = `Error: ${error.message || error}`;
      }
      const toolMessage = { role: "tool", name: call.name, toolCallId: call.id, content: String(content).slice(0, 100_000) };
      messages.push(toolMessage);
      onEvent({ type: "tool_result", message: toolMessage });
    }
  }
  onEvent({ type: "notice", text: `Stopped after ${maxIterations} steps.` });
  return null;
}

function abortError() {
  const error = new Error("Stopped");
  error.name = "AbortError";
  return error;
}
