// A bridge for OpenAI-compatible chat endpoints, written with the SDK.
//
//   node examples/chat.ts --base-url http://127.0.0.1:8080/v1        serve
//   node examples/chat.ts --check                                  preflight only
//
// It keeps the conversation in Kedi's transcript schema and converts it to chat messages
// only to send a request, so test mode, history and sessions need no other conversion.

import { type Json, type JsonObject, type ModelCall, type ModelRequest, type Run, type RunAnswer, RpcError, serve, type TranscriptMessage, type TranscriptPart, type Usage } from "../src/index.ts";

const flag = (name: string) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};
const BASE_URL = flag("--base-url") ?? "http://127.0.0.1:8080/v1";

interface Reply {
  message: TranscriptMessage;
  usage?: Usage;
}

function text(message: TranscriptMessage): string {
  return message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

function chatMessages(system: string | null, messages: TranscriptMessage[]): JsonObject[] {
  const chat: JsonObject[] = system ? [{ role: "system", content: system }] : [];
  for (const message of messages) {
    if (message.role === "tool") {
      for (const part of message.parts) {
        if (part.type === "toolResult") chat.push({ role: "tool", tool_call_id: part.id, content: JSON.stringify(part.result) });
      }
      continue;
    }
    const calls = message.parts.flatMap((part) =>
      part.type === "toolCall" ? [{ id: part.id, type: "function", function: { name: part.name, arguments: JSON.stringify(part.arguments) } }] : [],
    );
    chat.push({ role: message.role, content: text(message), ...(calls.length ? { tool_calls: calls } : {}) });
  }
  return chat;
}

async function complete(call: ModelCall, model: string | null, signal: AbortSignal): Promise<Reply> {
  const body: JsonObject = { model, messages: chatMessages(call.system, call.messages) };
  if (call.tools.length) {
    body.tools = call.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description ?? "", parameters: tool.inputSchema ?? {} } }));
  }
  if (call.output) body.response_format = { type: "json_schema", json_schema: { name: call.output.toolName, schema: call.output.schema } };
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(process.env.OPENAI_API_KEY ? { authorization: `Bearer ${process.env.OPENAI_API_KEY}` } : {}) },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw new Error(`model ${model} answered ${response.status}: ${await response.text()}`);
  const answer = (await response.json()) as { choices: { message: { content?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };
  const chosen = answer.choices[0]!.message;
  const parts: TranscriptPart[] = [];
  if (chosen.content) parts.push({ type: "text", text: chosen.content });
  for (const tool of chosen.tool_calls ?? []) parts.push({ type: "toolCall", id: tool.id, name: tool.function.name, arguments: JSON.parse(tool.function.arguments || "{}") });
  const usage = answer.usage && { inputTokens: answer.usage.prompt_tokens ?? null, outputTokens: answer.usage.completion_tokens ?? null, totalTokens: answer.usage.total_tokens ?? null };
  return { message: { role: "assistant", parts }, ...(usage ? { usage } : {}) };
}

async function converse(run: Run): Promise<RunAnswer> {
  const params = run.params;
  const transcript = Array.isArray(params.history);
  let messages: TranscriptMessage[] = transcript
    ? [...params.history!]
    : (((params.session?.state as JsonObject | null)?.messages as unknown as TranscriptMessage[] | undefined) ?? []);
  const turnStart = messages.length;
  const userParts: TranscriptPart[] = (params.userContent ?? [{ type: "text", text: params.user }]).flatMap((part) =>
    part.type === "text" ? [part] : [{ type: "media", kind: part.kind, mediaType: part.mediaType ?? null, ...("data" in part ? { data: part.data } : { url: part.url }) } as TranscriptPart],
  );
  messages.push({ role: "user", parts: userParts });
  if (params.continuation) {
    const rejected = params.continuation.answer;
    const said = typeof rejected.text === "string" ? rejected.text : JSON.stringify(rejected.data ?? rejected);
    messages.push({ role: "assistant", parts: [{ type: "text", text: said }] });
    messages.push({ role: "user", parts: [{ type: "text", text: params.continuation.message }] });
  }
  const back = (): JsonObject =>
    params.processHistory
      ? { transcript: messages as unknown as Json }
      : transcript
        ? { messages: messages.slice(turnStart) as unknown as Json }
        : { state: { messages: messages as unknown as Json } };
  run.onInput((texts) => {
    for (const said of texts) messages.push({ role: "user", parts: [{ type: "text", text: said }] });
  });
  run.onInterrupt(back);

  const output = params.output && "schema" in params.output && params.output.schema && params.output.toolName ? { schema: params.output.schema, toolName: params.output.toolName } : null;
  const describe = (): ModelCall => ({
    system: params.system,
    messages,
    tools: params.tools.map((tool) => ({ name: tool.name, description: tool.description ?? null, inputSchema: tool.inputSchema })),
    output,
  });
  const request: ModelRequest<Reply> = {
    describe,
    send: (model, signal) => complete(describe(), model, signal),
    reply: (message) => ({ message }),
    usage: (reply) => reply.usage,
    history: { get: () => messages, set: (kept) => void (messages = [...kept]) },
  };
  for (;;) {
    const { message } = await run.modelRequest(request);
    messages.push(message);
    const calls = message.parts.filter((part) => part.type === "toolCall");
    if (!calls.length) {
      const said = text(message);
      if (!output) return { text: said, ...back() };
      try {
        return { data: JSON.parse(said) as Json, ...back() };
      } catch {
        throw new RpcError(-32002, `the model's answer is not JSON: ${said.slice(0, 200)}`);
      }
    }
    const results: TranscriptPart[] = [];
    for (const call of calls) {
      const outcome = await run.callTool(call.id, call.name, call.arguments as JsonObject);
      results.push({ type: "toolResult", id: call.id, result: (outcome.ok ? outcome.result : outcome.error) as Json, ...(outcome.ok ? {} : { isError: true }) });
    }
    messages.push({ role: "tool", parts: results });
  }
}

await serve({
  handshake: {
    backend: { name: "openai-chat-example", version: "0.1.0" },
    kind: "agent-framework",
    capabilities: {
      tools: true,
      structuredOutput: true,
      nativeStructuredOutput: true,
      nativeToolCalling: true,
      governed: true,
      subagents: true,
      liveInput: true,
      interrupt: true,
      usage: true,
      modelFallback: true,
      sessions: true,
      transcript: true,
      testModel: true,
    },
  },
  run: converse,
});
