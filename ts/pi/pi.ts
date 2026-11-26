// A Kedi bridge for the pi coding agent (https://pi.dev), on pi's TypeScript SDK.
//
// Every model request pi makes, retries and compaction included, goes through one wrapped
// stream function, so Kedi admits it, counts its usage, and scripts it in test mode. pi's own
// tools (read, bash, edit, write) take Kedi's hooks, approval and budgets through an inline
// extension; Kedi's tools are pi custom tools that call back into Kedi.

import type { Bridge, Json, JsonObject, ModelCall, Run, RunAnswer, TranscriptMessage, TranscriptPart } from "../sdk/src/index.ts";
import { RpcError } from "../sdk/src/peer.ts";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  type AssistantMessage,
  type ImageContent,
  type TextContent,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  type Message,
  type Model,
} from "@earendil-works/pi-ai";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface PiBridgeOptions {
  /** The workspace pi's tools work in. */
  cwd: string;
}

/** Where pi would look for global resources; the bridge loads none of them. */
const AGENT_DIR = mkdtempSync(join(tmpdir(), "kedi-pi-"));

/** pi's own tools and their risk for Kedi's approval. */
const NATIVE_TOOLS: Record<string, "read_only" | "mutating" | "sensitive"> = {
  read: "read_only",
  grep: "read_only",
  find: "read_only",
  ls: "read_only",
  edit: "mutating",
  write: "mutating",
  bash: "sensitive",
};

/** In test mode pi needs a model and a credential, though no request leaves the bridge. */
const TEST_MODEL: Model<"openai-completions"> = {
  id: "kedi-test-model",
  name: "Kedi test model",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "http://127.0.0.1:9/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8_192,
};

let realRuntime: Promise<ModelRuntime> | undefined;

/** A model of pi's catalog named provider/model, as Kedi's > model: and > fallback: name them. */
function catalogModel(runtime: ModelRuntime, name: string): Model<any> {
  const slash = name.indexOf("/");
  const model = slash > 0 ? runtime.getModel(name.slice(0, slash), name.slice(slash + 1)) : undefined;
  if (!model) {
    throw new RpcError(-32002, `pi has no model ${JSON.stringify(name)}: name one as provider/model, such as google/gemini-2.5-flash`);
  }
  return model;
}

async function modelFor(run: Run): Promise<{ runtime: ModelRuntime; model: Model<any> }> {
  if (run.testMode) {
    const runtime = await ModelRuntime.create({ authPath: join(AGENT_DIR, "auth.json"), modelsPath: null, allowModelNetwork: false });
    await runtime.setRuntimeApiKey("openai", "kedi-test-mode");
    return { runtime, model: TEST_MODEL };
  }
  // pi's own credentials and model catalog: ~/.pi/agent, and the providers' environment variables.
  realRuntime ??= ModelRuntime.create();
  const runtime = await realRuntime;
  return { runtime, model: catalogModel(runtime, run.params.model ?? "") };
}

// pi's transcript to Kedi's, and an assistant message back.

function toKedi(message: Message): TranscriptMessage | undefined {
  switch (message.role) {
    case "user": {
      const content = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
      return {
        role: "user",
        parts: content.map((part) =>
          part.type === "text" ? { type: "text", text: part.text } : { type: "media", kind: "image", mediaType: part.mimeType, data: part.data },
        ),
      };
    }
    case "assistant":
      return {
        role: "assistant",
        parts: message.content.map((part): TranscriptPart => {
          if (part.type === "text") return { type: "text", text: part.text };
          if (part.type === "thinking") return { type: "reasoning", text: part.thinking };
          return { type: "toolCall", id: part.id, name: part.name, arguments: part.arguments as Json };
        }),
      };
    case "toolResult":
      return {
        role: "tool",
        parts: [
          {
            type: "toolResult",
            id: message.toolCallId,
            result: message.content.map((part) => (part.type === "text" ? part.text : `[${part.mimeType} image]`)).join(""),
            ...(message.isError ? { isError: true } : {}),
          },
        ],
      };
    default:
      return undefined;
  }
}

function describe(context: { messages: Message[] }): ModelCall {
  return {
    system: getCurrentSystemPrompt(context.messages),
    messages: context.messages.map(toKedi).filter((message): message is TranscriptMessage => message !== undefined),
    tools: getCurrentTools(context.messages).map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters as unknown as JsonObject })),
    output: null,
  };
}

function fromKedi(message: TranscriptMessage, model: Model<any>): AssistantMessage {
  const content: AssistantMessage["content"] = [];
  for (const part of message.parts) {
    if (part.type === "text") content.push({ type: "text", text: part.text });
    else if (part.type === "reasoning") content.push({ type: "thinking", thinking: part.text ?? "" });
    else if (part.type === "toolCall") content.push({ type: "toolCall", id: part.id, name: part.name, arguments: (part.arguments ?? {}) as never });
  }
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop",
    timestamp: Date.now(),
  };
}

/** A finished message as the stream pi expects from a provider. */
function replay(message: AssistantMessage): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      stream.push({ type: "error", reason: message.stopReason, error: message });
      return;
    }
    stream.push({ type: "start", partial: { ...message, content: [] } });
    message.content.forEach((part, contentIndex) => {
      const partial = message;
      if (part.type === "text") {
        stream.push({ type: "text_start", contentIndex, partial });
        stream.push({ type: "text_delta", contentIndex, delta: part.text, partial });
        stream.push({ type: "text_end", contentIndex, content: part.text, partial });
      } else if (part.type === "thinking") {
        stream.push({ type: "thinking_start", contentIndex, partial });
        stream.push({ type: "thinking_delta", contentIndex, delta: part.thinking, partial });
        stream.push({ type: "thinking_end", contentIndex, content: part.thinking, partial });
      } else {
        stream.push({ type: "toolcall_start", contentIndex, partial });
        stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(part.arguments), partial });
        stream.push({ type: "toolcall_end", contentIndex, toolCall: part, partial });
      }
    });
    stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse" | "length", message });
  });
  return stream;
}

function failed(model: Model<any>, error: unknown, aborted: boolean): AssistantMessage {
  return { ...fromKedi({ role: "assistant", parts: [] }, model), stopReason: aborted ? "aborted" : "error", errorMessage: String((error as Error)?.message ?? error) };
}

function text(message: AssistantMessage | undefined): string {
  return (message?.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

async function converse(run: Run, cwd: string): Promise<RunAnswer> {
  const params = run.params;
  const { runtime, model } = await modelFor(run);
  // The first error a Kedi step raised inside pi: pi turns errors into messages, the run fails with it.
  let failure: unknown;
  let data: { value: Json } | undefined;

  const kediTools: ToolDefinition[] = params.tools.map((tool) => ({
    name: tool.name,
    label: tool.name,
    description: tool.description ?? "",
    parameters: (tool.inputSchema ?? { type: "object", properties: {} }) as never,
    async execute(toolCallId, args) {
      const outcome = await run.callTool(toolCallId, tool.name, args as JsonObject);
      const said = outcome.ok ? (typeof outcome.result === "string" ? outcome.result : JSON.stringify(outcome.result)) : outcome.error;
      return { content: [{ type: "text", text: said }], details: {}, ...(outcome.ok ? {} : { isError: true }) };
    },
  }));
  const output = params.output && "schema" in params.output && params.output.schema && params.output.toolName ? params.output : null;
  if (output) {
    // The model answers by calling the output tool; its arguments are the run's data.
    kediTools.push({
      name: output.toolName!,
      label: output.toolName!,
      description: "Give your final answer by calling this tool with it.",
      parameters: output.schema as never,
      async execute(_id, args) {
        data = { value: args as Json };
        return { content: [{ type: "text", text: "Answer recorded." }], details: {}, terminate: true };
      },
    });
  }

  const turn = params.continuation ? params.continuation.message : await userTurn(params, run.signal);
  const kedi = (pi: ExtensionAPI) => {
    // Cache warming sends requests of its own, past the stream function Kedi admits; governed
    // promises that every model request is admitted, so pi does not warm.
    pi.on("cache_warming_decision", () => ({ action: "stop" as const }));
    if (Array.isArray(turn)) {
      // pi sends a user turn as its text, then its images; Kedi put each image where its
      // label is. Every request of the run carries the turn in Kedi's order.
      const flattened = turn.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
      pi.on("context", async (event) => {
        let restored = false;
        const messages = event.messages.map((message) => {
          if (restored || message.role !== "user" || !Array.isArray(message.content)) return message;
          const said = message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
          if (said !== flattened) return message;
          restored = true;
          return { ...message, content: turn };
        });
        return restored ? { messages } : undefined;
      });
    }
    pi.on("before_agent_start", async (event) => {
      // Kedi's system text follows pi's own prompt.
      if (params.system) return { systemPrompt: `${event.systemPrompt}\n\n${params.system}` };
      return undefined;
    });
    const calls = new Map<string, { args: JsonObject }>();
    pi.on("tool_call", async (event) => {
      const risk = NATIVE_TOOLS[event.toolName];
      if (!risk) return undefined; // Kedi's tools are Kedi's to gate; the output tool needs none.
      try {
        const before = await run.beforeNativeTool({ callId: event.toolCallId, name: event.toolName, arguments: event.input as JsonObject, risk });
        if (!before.run) return { block: true, reason: before.reason };
        const args = structuredClone(before.arguments);
        if (before.arguments !== event.input) {
          // An edit replaces the arguments in place: pi runs what event.input holds.
          const input = event.input as Record<string, unknown>;
          for (const key of Object.keys(input)) delete input[key];
          Object.assign(input, args);
        }
        calls.set(event.toolCallId, { args });
        return undefined;
      } catch (error) {
        failure ??= error;
        void session.abort();
        return { block: true, reason: String((error as Error).message ?? error), terminate: true };
      }
    });
    pi.on("tool_result", async (event) => {
      const call = calls.get(event.toolCallId);
      if (!call) return undefined;
      calls.delete(event.toolCallId);
      const said = event.content.map((part) => (part.type === "text" ? part.text : "")).join("");
      try {
        const outcome = await run.afterNativeTool(
          { callId: event.toolCallId, name: event.toolName, arguments: call.args },
          call.args,
          event.isError ? { error: new Error(said) } : { result: said },
        );
        if (!outcome.ok || outcome.result === said) return undefined;
        const replaced = typeof outcome.result === "string" ? outcome.result : JSON.stringify(outcome.result);
        return { content: [{ type: "text", text: replaced }] };
      } catch (error) {
        failure ??= error;
        void session.abort();
        return undefined;
      }
    });
  };

  const settingsManager = SettingsManager.inMemory({
    // Kedi owns retries and history: pi neither retries nor compacts on its own.
    retry: { enabled: false, provider: { maxRetries: 0 } },
    compaction: { enabled: false },
  } as never);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: AGENT_DIR,
    settingsManager,
    // Kedi renders the model-visible text: no discovered extensions, skills, prompt templates
    // or context files (AGENTS.md), only Kedi's extension.
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [{ name: "kedi", factory: kedi }] as never,
  });
  await resourceLoader.reload();
  const entries = ((params.session?.state as JsonObject | null)?.entries ?? undefined) as never;
  const sessionManager = SessionManager.inMemory(cwd, undefined, entries);
  if (params.continuation) {
    // The rejected answer as pi's last turn; Kedi's correction is then the prompt.
    sessionManager.appendMessage({ role: "user", content: params.user, timestamp: Date.now() });
    const rejected = params.continuation.answer;
    const said = typeof rejected.text === "string" ? rejected.text : JSON.stringify(rejected.data ?? rejected);
    sessionManager.appendMessage(fromKedi({ role: "assistant", parts: [{ type: "text", text: said }] }, model));
  }
  const { session } = await createAgentSession({
    cwd,
    agentDir: AGENT_DIR,
    modelRuntime: runtime,
    model,
    sessionManager,
    settingsManager,
    resourceLoader,
    customTools: kediTools,
    // Kedi's > effort: is pi's thinking level, clamped to what the model supports.
    ...(params.effort ? { thinkingLevel: params.effort } : {}),
  });

  const real = session.agent.streamFunction;
  const sampling = streamSettings(params.settings);
  let replies = 0;
  session.agent.streamFunction = (requestModel, context, options) => {
    // Once Kedi stopped the run, pi makes no further request: it gets the stop as its answer.
    if (failure !== undefined) return replay(failed(requestModel, failure, true));
    const answered = run
      .modelRequest<AssistantMessage>({
        async send(name, signal) {
          // A fallback model is pi's to resolve, and its provider's credentials with it.
          const fallback = name !== null && name !== params.model;
          const target = fallback ? catalogModel(runtime, name) : requestModel;
          const { apiKey: _key, headers: _headers, ...unauthenticated } = options ?? {};
          const stream = await real(target, context, {
            ...(fallback ? unauthenticated : options),
            ...sampling,
            signal: AbortSignal.any([signal, ...(options?.signal ? [options.signal] : [])]),
          });
          // The model's text as it streams, for Kedi's event observers.
          const messageId = `${run.id}-${replies + 1}`;
          for await (const event of stream) {
            if (event.type === "text_delta") run.event("message.delta", { messageId, text: event.delta });
          }
          const message = await stream.result();
          // pi reports a failed request as a message; it fails here so the next model is tried.
          if (message.stopReason === "error") throw new Error(message.errorMessage ?? `${target.provider}/${target.id} failed`);
          return message;
        },
        describe: () => describe(context),
        reply: (message) => fromKedi(message, requestModel),
        usage: (message) => ({
          inputTokens: message.usage.input,
          outputTokens: message.usage.output,
          totalTokens: message.usage.totalTokens,
          cacheReadTokens: message.usage.cacheRead,
          cacheWriteTokens: message.usage.cacheWrite,
        }),
      })
      .then((message) => {
        replies += 1;
        const said = text(message);
        if (said) {
          // Text beside tool calls is commentary; a reply without them is the answer.
          const phase = message.content.some((part) => part.type === "toolCall") ? "commentary" : "final";
          run.event("message.completed", { messageId: `${run.id}-${replies}`, text: said, phase });
        }
        return message;
      })
      .catch((error: unknown) => {
        failure ??= error;
        return failed(requestModel, error, run.signal.aborted);
      });
    return answered.then(replay);
  };

  const state = (): JsonObject => ({ state: { entries: sessionManager.getEntries() as unknown as Json } });
  // Kedi's text reaches pi as written: no command dispatch or template expansion.
  run.onInput(
    (texts) => texts.forEach((said) => void session.sendUserMessage(said, { deliverAs: "steer", expandPromptTemplates: false })),
    { on: "arrival" },
  );
  run.onInterrupt(state);
  const stop = () => void session.abort();
  run.signal.addEventListener("abort", stop, { once: true });
  try {
    await session.sendUserMessage(turn, { expandPromptTemplates: false });
  } finally {
    run.signal.removeEventListener("abort", stop);
  }
  if (run.signal.aborted) throw run.signal.reason;
  if (failure) throw failure;
  const last = session.messages.filter((message): message is AssistantMessage => message.role === "assistant").at(-1);
  if (last?.stopReason === "error") throw new Error(last.errorMessage ?? "pi's model request failed");
  const said = text(last);
  const back = params.session ? state() : {};
  session.dispose();
  if (!output) return { text: said, ...back };
  if (data) return { data: data.value, ...back };
  try {
    return { data: JSON.parse(said) as Json, ...back };
  } catch (error) {
    return { invalid: said, error: String(error), ...back };
  }
}

/** The run's `> settings:` as pi's request options: the ones every pi provider applies alike. */
export function streamSettings(settings: JsonObject | undefined): { temperature?: number; maxTokens?: number } {
  const options: { temperature?: number; maxTokens?: number } = {};
  if (typeof settings?.temperature === "number") options.temperature = settings.temperature;
  if (typeof settings?.max_tokens === "number") options.maxTokens = settings.max_tokens;
  return options;
}

/** The user turn with its images where Kedi put them; pi takes images as base64. */
async function userTurn(params: Run["params"], signal: AbortSignal): Promise<string | (TextContent | ImageContent)[]> {
  if (!params.userContent) return params.user;
  const parts: (TextContent | ImageContent)[] = [];
  for (const part of params.userContent) {
    if (part.type === "text") {
      parts.push({ type: "text", text: part.text });
      continue;
    }
    if ("data" in part && part.data !== undefined) {
      parts.push({ type: "image", data: part.data, mimeType: part.mediaType ?? "image/png" });
      continue;
    }
    const response = await fetch(part.url!, { signal });
    if (!response.ok) throw new Error(`could not fetch ${part.name} from ${part.url}: ${response.status}`);
    const mimeType = part.mediaType ?? response.headers.get("content-type") ?? "image/png";
    parts.push({ type: "image", data: Buffer.from(await response.arrayBuffer()).toString("base64"), mimeType });
  }
  return parts;
}

/** The pi bridge: its handshake, and a run on a fresh pi session in `cwd`. */
export function piBridge(options: PiBridgeOptions): Bridge {
  return {
    handshake: {
      backend: { name: "pi", version: "1.5.2" },
      kind: "agent-harness",
      mediaKinds: ["image"],
      settings: ["temperature", "max_tokens"],
      effort: ["minimal", "low", "medium", "high", "xhigh", "max"],
      capabilities: {
        tools: true,
        structuredOutput: true,
        nativeToolCalling: true,
        nativeStructuredOutput: true,
        nativeTools: true,
        governed: true,
        subagents: true,
        liveInput: true,
        interrupt: true,
        usage: true,
        modelFallback: true,
        sessions: true,
        events: true,
        mediaInput: true,
        testModel: true,
      },
    },
    run: (run) => converse(run, options.cwd),
  };
}
