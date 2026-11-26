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
  createMcpExtension,
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
  getAttributionHeaders,
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

/** The bridge's version, as packages/pi/package.kedi and package.json carry it. */
export const VERSION = "0.1.0";

/**
 * Who the bridge's model requests say they come from: kedi-pi, in place of pi, with pi's own
 * rules for the providers that take an attribution (OpenRouter, NVIDIA NIM, OpenCode).
 */
export function identityHeaders(target: Pick<Model<any>, "provider" | "baseUrl">): Record<string, string> {
  return {
    "User-Agent": `kedi-pi/${VERSION}`,
    ...getAttributionHeaders(target as Model<any>, { attribution: { name: "kedi-pi", url: "https://kedi-lang.org" } }),
  };
}

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

/** pi's MCP resource tools, which read from Kedi's servers. */
const MCP_RESOURCE_TOOLS = new Set(["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]);

/** A Kedi `> mcp:` server as pi's MCP configuration; its tools are declared to the model directly. */
function mcpConfig(server: NonNullable<Run["params"]["mcpServers"]>[number]): JsonObject {
  if (server.transport === "stdio") {
    return { command: server.command ?? "", args: server.args ?? [], env: server.env ?? {}, exposure: "direct" };
  }
  return { url: server.url ?? "", headers: server.headers ?? {}, exposure: "direct" };
}

/** In test mode pi needs a model and a credential, though no request leaves the bridge. */
const TEST_MODEL: Model<"openai-completions"> = {
  id: "kedi-test-model",
  name: "Kedi test model",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "http://127.0.0.1:9/v1",
  reasoning: false,
  // Kedi's test model takes what a run sends; pi would strip images for a text-only model.
  input: ["text", "image"],
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

/** A pi message in Kedi's transcript schema, carrying the pi message itself as providerData. */
function toKediMessage(message: Message): TranscriptMessage | undefined {
  const kedi = toKedi(message);
  return kedi && { ...kedi, providerData: message as unknown as Json };
}

function sameParts(left: TranscriptMessage, right: TranscriptMessage | undefined): boolean {
  return right !== undefined && left.role === right.role && JSON.stringify(left.parts) === JSON.stringify(right.parts);
}

/**
 * Kedi's transcript as pi messages. A message Kedi did not change is its pi message as given
 * (providerData keeps pi's own fields, such as thinking signatures); a changed one, or one pi
 * never saw, is built from its parts. Media named by ref come from Kedi (media/get).
 */
async function piMessages(transcript: TranscriptMessage[], run: Run, model: Model<any>): Promise<Message[]> {
  const names = new Map<string, string>();
  const messages: Message[] = [];
  for (const message of transcript) {
    for (const part of message.parts) if (part.type === "toolCall") names.set(part.id, part.name);
    const given = message.providerData as unknown as Message | undefined;
    if (given && typeof given === "object" && "role" in given && sameParts(message, toKedi(given))) {
      messages.push(given);
      continue;
    }
    if (message.role === "assistant") {
      messages.push(fromKedi(message, model));
    } else if (message.role === "tool") {
      for (const part of message.parts) {
        if (part.type !== "toolResult") continue;
        const said = typeof part.result === "string" ? part.result : JSON.stringify(part.result);
        messages.push({
          role: "toolResult",
          toolCallId: part.id,
          toolName: names.get(part.id) ?? "tool",
          content: [{ type: "text", text: said }],
          isError: part.isError === true,
          timestamp: Date.now(),
        } as Message);
      }
    } else {
      const content: (TextContent | ImageContent)[] = [];
      for (const part of message.parts) {
        if (part.type === "text") content.push({ type: "text", text: part.text });
        else if (part.type === "media") content.push(await image(part, run));
      }
      messages.push({ role: "user", content, timestamp: Date.now() });
    }
  }
  return messages;
}

/** A transcript media part as pi's base64 image: inline, by URL, or by ref from Kedi. */
async function image(part: Extract<TranscriptPart, { type: "media" }>, run: Run): Promise<ImageContent> {
  const media = part.data !== undefined || part.url !== undefined ? part : ((await run.media(part.ref!)) as typeof part);
  if (media.data !== undefined) return { type: "image", data: media.data, mimeType: media.mediaType ?? "image/png" };
  const response = await fetch(media.url!, { signal: run.signal });
  if (!response.ok) throw new Error(`could not fetch ${part.ref ?? media.url}: ${response.status}`);
  const mimeType = media.mediaType ?? response.headers.get("content-type") ?? "image/png";
  return { type: "image", data: Buffer.from(await response.arrayBuffer()).toString("base64"), mimeType };
}

/** The user turn in Kedi's schema: its text, and its media by name, where Kedi put them. */
function kediTurn(params: Run["params"]): TranscriptMessage {
  const parts: TranscriptPart[] = params.userContent
    ? params.userContent.map((part) => (part.type === "text" ? { type: "text", text: part.text } : { type: "media", ref: part.name }))
    : [{ type: "text", text: params.user }];
  return { role: "user", parts };
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
  // Kedi's > mcp: servers, named s1, s2, … in order: pi names their tools mcp__s1__<tool>.
  const servers = (params.mcpServers ?? []).map((server, index) => [`s${index + 1}`, mcpConfig(server)] as const);
  const kedi = (pi: ExtensionAPI) => {
    for (const [name, config] of servers) pi.registerMcpServer(name, config as never);
    // Cache warming sends requests of its own, past the stream function Kedi admits; governed
    // promises that every model request is admitted, so pi does not warm.
    pi.on("cache_warming_decision", () => ({ action: "stop" as const }));
    if (Array.isArray(turn)) {
      // pi sends a user turn as its text, then its images as pi prepared them (converted, or
      // resized to the model's limits), with a note for each it had to omit. Kedi put each
      // image where its label is: every request carries Kedi's text in Kedi's order, with
      // pi's images, and a turn whose image pi omitted fails rather than reaching the model
      // without it.
      const flattened = turn.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
      const wanted = turn.filter((part) => part.type === "image").length;
      pi.on("context", async (event) => {
        let restored = false;
        const messages = event.messages.map((message) => {
          if (restored || message.role !== "user" || !Array.isArray(message.content)) return message;
          const said = message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
          if (said !== flattened && !said.startsWith(`${flattened}\n\n`)) return message;
          restored = true;
          const images = message.content.filter((part): part is ImageContent => part.type === "image");
          if (images.length < wanted) {
            failure ??= new Error(`pi could not send the turn's images: ${said.slice(flattened.length).trim()}`);
            return message;
          }
          return { ...message, content: turn.map((part) => (part.type === "image" ? images.shift()! : part)) };
        });
        return restored ? { messages } : undefined;
      });
    }
    pi.on("before_agent_start", async (event) => {
      // Kedi's system text follows pi's own prompt.
      if (params.system) return { systemPrompt: `${event.systemPrompt}\n\n${params.system}` };
      return undefined;
    });
    const calls = new Map<string, { args: JsonObject; name: string; origin: "adapter_native" | "mcp" }>();
    /** A pi tool Kedi gates: its name for Kedi, origin and risk; Kedi's own tools are not. */
    const gated = (toolName: string): { name: string; origin: "adapter_native" | "mcp"; risk: "read_only" | "mutating" | "sensitive" } | undefined => {
      const native = NATIVE_TOOLS[toolName];
      if (native) return { name: toolName, origin: "adapter_native", risk: native };
      if (MCP_RESOURCE_TOOLS.has(toolName)) return { name: toolName, origin: "mcp", risk: "read_only" };
      const mcp = toolName.match(/^mcp__[A-Za-z0-9_]+?__(.+)$/);
      if (!mcp) return undefined;
      // The server's own hints decide the risk: read-only, destructive, or neither.
      const hints = pi.getAllTools().find((tool) => tool.name === toolName)?.annotations;
      const risk = hints?.readOnlyHint ? "read_only" : hints?.destructiveHint ? "sensitive" : "mutating";
      return { name: mcp[1]!, origin: "mcp", risk };
    };
    pi.on("tool_call", async (event) => {
      const tool = gated(event.toolName);
      if (!tool) return undefined; // Kedi's tools are Kedi's to gate; the output tool needs none.
      try {
        const before = await run.beforeNativeTool({ callId: event.toolCallId, name: tool.name, origin: tool.origin, arguments: event.input as JsonObject, risk: tool.risk });
        if (!before.run) return { block: true, reason: before.reason };
        const args = structuredClone(before.arguments);
        if (before.arguments !== event.input) {
          // An edit replaces the arguments in place: pi runs what event.input holds.
          const input = event.input as Record<string, unknown>;
          for (const key of Object.keys(input)) delete input[key];
          Object.assign(input, args);
        }
        calls.set(event.toolCallId, { args, name: tool.name, origin: tool.origin });
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
          { callId: event.toolCallId, name: call.name, origin: call.origin, arguments: call.args },
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
    // No install report, and no attribution to pi: requests say they come from kedi-pi.
    enableInstallTelemetry: false,
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
    extensionFactories: [
      { name: "kedi", factory: kedi },
      // pi's MCP client, with no configuration of its own: no mcp.json of this machine loads.
      ...(servers.length ? [createMcpExtension({ loadConfig: () => ({ servers: [], errors: [], autoEnableCodemode: false }) })] : []),
    ] as never,
  });
  await resourceLoader.reload();
  const entries = ((params.session?.state as JsonObject | null)?.entries ?? undefined) as never;
  const sessionManager = SessionManager.inMemory(cwd, undefined, entries);
  // Transcript mode: Kedi holds the conversation and hands it over each turn.
  const transcriptMode = Array.isArray(params.history);
  const loaded = transcriptMode ? await piMessages(params.history!, run, model) : [];
  for (const message of loaded) sessionManager.appendMessage(message);
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

  // session_start connects the MCP servers; the first prompt waits for their direct tools.
  if (servers.length) await session.bindExtensions({});
  const real = session.agent.streamFunction;
  const sampling = streamSettings(params.settings);
  let replies = 0;
  // History processing: Kedi's processed conversation so far, and how many of pi's messages it
  // covers; later messages join it before the next request.
  let processed: TranscriptMessage[] = params.history ?? [];
  let covered = loaded.length;
  /** pi's conversation in Kedi's schema; the turn's user message in Kedi's own layout. */
  const asKedi = (messages: Message[], offset: number): TranscriptMessage[] =>
    messages.flatMap((message, index) => {
      if (offset + index === loaded.length) return [kediTurn(params)];
      const kedi = toKediMessage(message);
      return kedi ? [kedi] : [];
    });
  session.agent.streamFunction = (requestModel, context, options) => {
    // Once Kedi stopped the run, pi makes no further request: it gets the stop as its answer.
    if (failure !== undefined) return replay(failed(requestModel, failure, true));
    const system = context.messages.filter((message) => message.role === "system");
    const conversation = context.messages.filter((message) => message.role !== "system");
    let sent = context;
    const answered = run
      .modelRequest<AssistantMessage>({
        async send(name, signal) {
          // A fallback model is pi's to resolve, and its provider's credentials with it.
          const fallback = name !== null && name !== params.model;
          const target = fallback ? catalogModel(runtime, name) : requestModel;
          const { apiKey: _key, headers: _headers, ...unauthenticated } = options ?? {};
          const given = fallback ? unauthenticated : options;
          const stream = await real(target, sent, {
            ...given,
            headers: { ...identityHeaders(target), ...(fallback ? {} : options?.headers) },
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
        describe: () => describe(sent),
        ...(params.processHistory
          ? {
              history: {
                get: () => [...processed, ...asKedi(conversation.slice(covered), covered)],
                set: async (kept: TranscriptMessage[]) => {
                  processed = kept;
                  covered = conversation.length;
                  sent = { ...context, messages: [...system, ...(await piMessages(kept, run, requestModel))] };
                },
              },
            }
          : {}),
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

  const back = (): JsonObject => {
    const messages = session.messages.filter((message): message is Message => ["user", "assistant", "toolResult"].includes(message.role));
    if (params.processHistory) return { transcript: [...processed, ...asKedi(messages.slice(covered), covered)] as unknown as Json };
    if (transcriptMode) return { messages: asKedi(messages.slice(loaded.length), loaded.length) as unknown as Json };
    if (params.session) return { state: { entries: sessionManager.getEntries() as unknown as Json } };
    return {};
  };
  // Kedi's text reaches pi as written: no command dispatch or template expansion.
  run.onInput(
    (texts) => texts.forEach((said) => void session.sendUserMessage(said, { deliverAs: "steer", expandPromptTemplates: false })),
    { on: "arrival" },
  );
  run.onInterrupt(back);
  const stop = () => void session.abort();
  run.signal.addEventListener("abort", stop, { once: true });
  try {
    await session.sendUserMessage(turn, { expandPromptTemplates: false });
    if (run.signal.aborted) throw run.signal.reason;
    if (failure) throw failure;
    const last = session.messages.filter((message): message is AssistantMessage => message.role === "assistant").at(-1);
    if (last?.stopReason === "error") throw new Error(last.errorMessage ?? "pi's model request failed");
    const said = text(last);
    const handed = back();
    if (!output) return { text: said, ...handed };
    if (data) return { data: data.value, ...handed };
    try {
      return { data: JSON.parse(said) as Json, ...handed };
    } catch (error) {
      return { invalid: said, error: String(error), ...handed };
    }
  } finally {
    run.signal.removeEventListener("abort", stop);
    if (run.signal.aborted) {
      // An interrupted attempt's snapshot is read after the run ends: take it while it is open.
      const taken = back();
      run.onInterrupt(() => taken);
    }
    await close(session);
  }
}

/**
 * Ends a session however its run ended: session_shutdown first, as pi's own runtime does, so
 * extensions close what they opened, such as MCP servers, then the session itself.
 */
async function close(session: Awaited<ReturnType<typeof createAgentSession>>["session"]): Promise<void> {
  await session.abort();
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" } as never);
  session.dispose();
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
    // pi converts and resizes images with photon's WebAssembly module, which a bundle carries
    // beside bridge.mjs.
    files: ["photon_rs_bg.wasm"],
    handshake: {
      backend: { name: "pi", version: "1.5.2" },
      kind: "agent-harness",
      mediaKinds: ["image"],
      settings: ["temperature", "max_tokens"],
      // pi connects stdio and streamable HTTP servers; it refuses SSE.
      mcp: { transports: ["stdio", "http"] },
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
        transcript: true,
        events: true,
        mediaInput: true,
        testModel: true,
      },
    },
    run: (run) => converse(run, options.cwd),
  };
}
