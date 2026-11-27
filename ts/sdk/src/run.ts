// A run in progress: its params, its abort signal, and the steps Kedi decides.

import { ErrorCode, type Json, type JsonObject, type Peer, RpcError } from "./peer.ts";
import type { Capabilities } from "./handshake.ts";
import type {
  HookEvent,
  ModelCall,
  RunParams,
  TokenCounts,
  ToolOrigin,
  ToolOutcome,
  ToolRisk,
  TranscriptMessage,
  Usage,
} from "./types.ts";

/** Why a run stopped: Kedi cancelled it, or interrupted its attempt. */
export class RunStopped extends Error {
  readonly kind: "cancel" | "interrupt";

  constructor(kind: "cancel" | "interrupt") {
    super(kind === "cancel" ? "the run was cancelled" : "the run was interrupted");
    this.name = "RunStopped";
    this.kind = kind;
  }
}

/** Kedi denied a step: the run ends with Kedi's error. */
export class StepDenied extends RpcError {
  constructor(reason: string, data?: Json) {
    super(ErrorCode.runFailed, reason, data);
    this.name = "StepDenied";
  }
}

/** The bridge used the SDK in a way the protocol does not allow. */
export class BridgeUsageError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "BridgeUsageError";
    this.code = code;
  }
}

/** One model request, as the bridge's backend makes it. */
export interface ModelRequest<Reply> {
  /** Sends the request to the backend's model; the run's signal stops it. */
  send(model: string | null, signal: AbortSignal): Promise<Reply>;
  /** The request in Kedi's transcript schema: test mode sends it as `model/complete`. */
  describe(): ModelCall;
  /** Kedi's test-model message as the backend's reply, with the counts its model reports. */
  reply(message: TranscriptMessage, usage?: TokenCounts): Reply;
  /**
   * `compaction` for the summary request of native compaction: admitted and counted like any
   * request, but no turn of the run, so it hands over no live input and confirms none.
   */
  purpose?: "turn" | "compaction";
  /** The reply's token counts, for `run/usage`. */
  usage?(reply: Reply): Usage | undefined;
  /**
   * The conversation the request sends, for history processing: `get` it in Kedi's schema,
   * `set` what the program's processor kept. Needed when the run's `processHistory` is true.
   */
  history?: { get(): TranscriptMessage[]; set(messages: TranscriptMessage[]): void | Promise<void> };
}

export interface NativeToolCall {
  callId: string;
  name: string;
  arguments: JsonObject;
  origin?: ToolOrigin;
  /** The call's risk; a function is asked again for arguments a hook or approval edited. */
  risk?: ToolRisk | ((args: JsonObject) => ToolRisk);
  description?: string | null;
  inputSchema?: JsonObject;
}

const RISK_ORDER: Record<ToolRisk, number> = { read_only: 0, mutating: 1, sensitive: 2 };

interface PendingInput {
  id: string;
  text: string;
  answer: (delivered: boolean) => void;
}

export class Run {
  readonly params: RunParams;
  readonly testMode: boolean;
  readonly #peer: Peer;
  readonly #capabilities: Capabilities;
  readonly #controller = new AbortController();
  #queued: PendingInput[] = [];
  #handed: PendingInput[] = [];
  #onInput: ((texts: string[]) => void) | undefined;
  #onArrival = false;
  #snapshot: (() => JsonObject) | undefined;

  constructor(peer: Peer, params: RunParams, capabilities: Capabilities, testMode: boolean) {
    this.#peer = peer;
    this.params = params;
    this.#capabilities = capabilities;
    this.testMode = testMode;
  }

  get id(): string {
    return this.params.runId;
  }

  /** Aborts when Kedi cancels or interrupts the run; pass it to every wait. */
  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  /**
   * Live input (`run/input`): `handler` gets each input's text as a user turn, right before
   * the next `modelRequest` builds its request. With `{ on: "arrival" }` it gets them as they
   * arrive, for a harness that queues input itself (steering). Either way an input is answered
   * delivered once a request's `describe()` carries its text.
   */
  onInput(handler: (texts: string[]) => void, options: { on?: "request" | "arrival" } = {}): void {
    this.#onInput = handler;
    this.#onArrival = options.on === "arrival";
    if (this.#onArrival) this.#hand();
  }

  /** What an interrupted attempt hands back: `{state}`, `{messages}` or `{transcript}`. */
  onInterrupt(snapshot: () => JsonObject): void {
    this.#snapshot = snapshot;
  }

  /**
   * One model request, with every step Kedi decides around it: live input, history
   * processing, admission per model tried (fallbacks included), the test model, usage.
   */
  async modelRequest<Reply>(request: ModelRequest<Reply>): Promise<Reply> {
    this.#throwIfStopped();
    const turn = request.purpose !== "compaction";
    if (turn && this.#queued.length) {
      // Input not handed over stays queued, and the run's end answers it undelivered.
      if (!this.#onInput) {
        throw new BridgeUsageError("KB201", "live input arrived, but the run has no run.onInput handler");
      }
      this.#hand();
    }
    if (turn && this.params.processHistory) {
      if (!request.history) {
        throw new BridgeUsageError("KB202", "the run asks for history processing; the request has no history");
      }
      const kept = await this.#ask("history/process", { runId: this.id, messages: request.history.get() as unknown as Json });
      await request.history.set(kept.messages as unknown as TranscriptMessage[]);
    }
    const models = [this.params.model, ...(this.#capabilities.modelFallback ? (this.params.fallbackModels ?? []) : [])];
    let failure: unknown;
    for (const model of models) {
      if (this.#capabilities.governed) await this.admit("request");
      if (turn) this.#confirmCarried(request);
      try {
        const reply = this.testMode ? await this.#testReply(request, model) : await this.#race(request.send(model, this.signal));
        // With usage, every model request is reported; counts the reply lacks stay unknown.
        if (this.#capabilities.usage) this.reportUsage(request.usage?.(reply) ?? {});
        return reply;
      } catch (error) {
        if (this.signal.aborted) throw this.signal.reason;
        failure = error;
      }
    }
    throw failure;
  }

  /**
   * A call of one of the bridge's own tools, through every step Kedi decides: the
   * `pre_tool_use` hook, approval, admission, the call, the post hooks, artifact admission.
   * Returns what the model should read.
   */
  async nativeTool(call: NativeToolCall, execute: (args: JsonObject, signal: AbortSignal) => Promise<Json>): Promise<ToolOutcome> {
    const before = await this.beforeNativeTool(call);
    if (!before.run) return { ok: false, error: before.reason };
    let result: Json;
    try {
      result = await this.#race(execute(before.arguments, this.signal));
    } catch (error) {
      if (this.signal.aborted) throw this.signal.reason;
      return this.afterNativeTool(call, before.arguments, { error });
    }
    return this.afterNativeTool(call, before.arguments, { result });
  }

  /**
   * The steps before a call of one of the bridge's own tools, for a harness that runs its
   * tools itself: the `pre_tool_use` hook, approval (asked again when edited arguments are
   * riskier), and admission. Returns the arguments to run, or why not to run it.
   */
  async beforeNativeTool(call: NativeToolCall): Promise<{ run: true; arguments: JsonObject } | { run: false; reason: string }> {
    if (!this.#capabilities.nativeTools) {
      throw new BridgeUsageError("KB203", `${call.name} is the bridge's own tool, but the bridge does not declare nativeTools`);
    }
    const base = this.#toolBase(call);
    const riskOf = (args: JsonObject): ToolRisk =>
      typeof call.risk === "function" ? call.risk(args) : (call.risk ?? "mutating");
    let args = call.arguments;
    if (this.#hooks().has("pre_tool_use")) {
      const pre = await this.#ask("hook/invoke", {
        ...base,
        event: "pre_tool_use",
        arguments: args,
        ...(call.inputSchema ? { inputSchema: call.inputSchema } : {}),
      });
      if (pre.decision === "deny") return { run: false, reason: String(pre.reason ?? "denied") };
      if (pre.decision === "edit") args = pre.arguments as JsonObject;
    }
    let approved = -1;
    while (approved < RISK_ORDER[riskOf(args)]) {
      const risk = riskOf(args);
      const approval = await this.#ask("approval/request", {
        ...base,
        arguments: args,
        risk,
        ...(call.description ? { description: call.description } : {}),
      });
      if (approval.decision === "deny") return { run: false, reason: String(approval.reason ?? "denied") };
      approved = RISK_ORDER[risk];
      if (approval.decision === "edit") args = approval.arguments as JsonObject;
    }
    if (this.#capabilities.governed) await this.admit("toolAttempt");
    return { run: true, arguments: args };
  }

  /**
   * The steps after a call of one of the bridge's own tools: `post_tool_use` or
   * `post_tool_use_failure`, then artifact admission. Returns what the model should read.
   */
  async afterNativeTool(call: NativeToolCall, args: JsonObject, outcome: { result: Json } | { error: unknown }): Promise<ToolOutcome> {
    const base = this.#toolBase(call);
    const hooks = this.#hooks();
    if ("error" in outcome) {
      const error = outcome.error as Error | undefined;
      const message = String(error?.message ?? outcome.error);
      if (hooks.has("post_tool_use_failure")) {
        const failure = { type: error?.name ?? "Error", message };
        await this.#ask("hook/invoke", { ...base, event: "post_tool_use_failure", arguments: args, error: failure });
      }
      return { ok: false, error: message };
    }
    let result = outcome.result;
    if (hooks.has("post_tool_use")) {
      await this.#ask("hook/invoke", { ...base, event: "post_tool_use", arguments: args, result });
    }
    if (this.params.admitResults) result = (await this.#ask("artifact/admit", { ...base, result })).result as Json;
    return { ok: true, result };
  }

  #toolBase(call: NativeToolCall): JsonObject {
    return { runId: this.id, callId: call.callId, tool: call.name, origin: call.origin ?? "adapter_native" };
  }

  #hooks(): Set<HookEvent> {
    return new Set<HookEvent>(this.params.hooks ?? []);
  }

  /** Calls one of Kedi's tools; Kedi applies the program's hooks, approval and budgets. */
  async callTool(callId: string, name: string, args: JsonObject): Promise<ToolOutcome> {
    const answer = await this.#ask("tool/call", { runId: this.id, callId, name, arguments: args });
    return answer.ok ? { ok: true, result: answer.result as Json } : { ok: false, error: String(answer.error) };
  }

  /** Asks Kedi to admit a step; throws `StepDenied` if it does not. `modelRequest` and `nativeTool` do this. */
  async admit(dimension: "request" | "toolAttempt"): Promise<void> {
    const answer = await this.#ask("budget/admit", { runId: this.id, dimension });
    if (!answer.admitted) throw new StepDenied(String(answer.reason ?? `${dimension} denied`));
  }

  /** The bytes of a conversation's media, by its `ref`. */
  async media(ref: string): Promise<JsonObject> {
    return this.#ask("media/get", { runId: this.id, ref });
  }

  /** Reports one model request's token counts; `modelRequest` does this. */
  reportUsage(usage: Usage): void {
    this.#peer.notify("run/usage", { runId: this.id, ...(usage as JsonObject) });
  }

  /** A `run/event`, with the `events` capability. */
  event(type: "message.delta" | "message.completed" | "tool.boundary", fields: JsonObject = {}): void {
    if (this.#capabilities.events) this.#peer.notify("run/event", { runId: this.id, type, ...fields });
  }

  // The connection's side.

  input(items: { id: string; text: string }[]): Promise<boolean> {
    return new Promise((answer) => {
      // Kedi waits for one answer for the request's items.
      let left = items.length;
      let delivered = true;
      for (const item of items) {
        this.#queued.push({
          ...item,
          answer: (value) => {
            delivered &&= value;
            if (--left === 0) answer(delivered);
          },
        });
      }
      if (this.#onArrival) this.#hand();
    });
  }

  stop(kind: "cancel" | "interrupt"): void {
    if (!this.signal.aborted) this.#controller.abort(new RunStopped(kind));
  }

  snapshot(): JsonObject | undefined {
    return this.#snapshot?.();
  }

  finish(): void {
    for (const input of [...this.#queued.splice(0), ...this.#handed.splice(0)]) input.answer(false);
    if (!this.signal.aborted) this.#controller.abort(new RunStopped("cancel"));
  }

  /** Hands queued input to the run's `onInput` handler. */
  #hand(): void {
    if (!this.#onInput || !this.#queued.length) return;
    const handed = this.#queued.splice(0);
    this.#handed.push(...handed);
    this.#onInput(handed.map((input) => input.text));
  }

  /** Answers delivered the handed input whose text the request carries. */
  #confirmCarried<Reply>(request: ModelRequest<Reply>): void {
    if (!this.#handed.length) return;
    const carried = strings(request.describe());
    this.#handed = this.#handed.filter((input) => {
      if (!carried.some((text) => text.includes(input.text))) return true;
      input.answer(true);
      return false;
    });
  }

  async #testReply<Reply>(request: ModelRequest<Reply>, model: string | null): Promise<Reply> {
    const call = request.describe();
    const params: JsonObject = { runId: this.id, model, ...(call as unknown as JsonObject) };
    if (request.purpose) params.purpose = request.purpose;
    const answer = await this.#ask("model/complete", params);
    return request.reply(answer.message as unknown as TranscriptMessage, answer.usage as TokenCounts | undefined);
  }

  #ask(method: string, params: JsonObject): Promise<JsonObject> {
    return this.#race(this.#peer.request(method, params));
  }

  /** Waits for `promise` unless the run stops first: then rejects with the reason. */
  #race<T>(promise: Promise<T>): Promise<T> {
    const signal = this.signal;
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<T>((resolve, reject) => {
      const stop = () => reject(signal.reason);
      signal.addEventListener("abort", stop, { once: true });
      promise.then(
        (value) => {
          signal.removeEventListener("abort", stop);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener("abort", stop);
          reject(error);
        },
      );
    });
  }

  #throwIfStopped(): void {
    if (this.signal.aborted) throw this.signal.reason;
  }
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}
