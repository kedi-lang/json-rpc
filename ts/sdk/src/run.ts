// A run in progress: its params, its abort signal, and the steps Kedi decides.

import { ErrorCode, type Json, type JsonObject, type Peer, RpcError } from "./peer.ts";
import type { Capabilities } from "./handshake.ts";
import type {
  HookEvent,
  ModelCall,
  RunParams,
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
  /** Kedi's test-model message as the backend's reply. */
  reply(message: TranscriptMessage): Reply;
  /** The reply's token counts, for `run/usage`. */
  usage?(reply: Reply): Usage | undefined;
  /**
   * The conversation the request sends, for history processing: `get` it in Kedi's schema,
   * `set` what the program's processor kept. Needed when the run's `processHistory` is true.
   */
  history?: { get(): TranscriptMessage[]; set(messages: TranscriptMessage[]): void };
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
   * the next `modelRequest` builds its request, so that request carries it.
   */
  onInput(handler: (texts: string[]) => void): void {
    this.#onInput = handler;
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
    if (this.#queued.length) {
      // Input not handed over stays queued, and the run's end answers it undelivered.
      if (!this.#onInput) {
        throw new BridgeUsageError("KB201", "live input arrived, but the run has no run.onInput handler");
      }
      const carried = this.#queued.splice(0);
      this.#handed.push(...carried);
      this.#onInput(carried.map((input) => input.text));
    }
    if (this.params.processHistory) {
      if (!request.history) {
        throw new BridgeUsageError("KB202", "the run asks for history processing; the request has no history");
      }
      const kept = await this.#ask("history/process", { runId: this.id, messages: request.history.get() as unknown as Json });
      request.history.set(kept.messages as unknown as TranscriptMessage[]);
    }
    const models = [this.params.model, ...(this.#capabilities.modelFallback ? (this.params.fallbackModels ?? []) : [])];
    let failure: unknown;
    for (const model of models) {
      if (this.#capabilities.governed) await this.admit("request");
      for (const input of this.#handed.splice(0)) input.answer(true);
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
    if (!this.#capabilities.nativeTools) {
      throw new BridgeUsageError("KB203", `${call.name} is the bridge's own tool, but the bridge does not declare nativeTools`);
    }
    const hooks = new Set<HookEvent>(this.params.hooks ?? []);
    const base = { runId: this.id, callId: call.callId, tool: call.name, origin: call.origin ?? "adapter_native" };
    const riskOf = (args: JsonObject): ToolRisk =>
      typeof call.risk === "function" ? call.risk(args) : (call.risk ?? "mutating");
    let args = call.arguments;
    if (hooks.has("pre_tool_use")) {
      const pre = await this.#ask("hook/invoke", {
        ...base,
        event: "pre_tool_use",
        arguments: args,
        ...(call.inputSchema ? { inputSchema: call.inputSchema } : {}),
      });
      if (pre.decision === "deny") return { ok: false, error: String(pre.reason ?? "denied") };
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
      if (approval.decision === "deny") return { ok: false, error: String(approval.reason ?? "denied") };
      approved = RISK_ORDER[risk];
      if (approval.decision === "edit") args = approval.arguments as JsonObject;
    }
    if (this.#capabilities.governed) await this.admit("toolAttempt");
    let result: Json;
    try {
      result = await this.#race(execute(args, this.signal));
    } catch (error) {
      if (this.signal.aborted) throw this.signal.reason;
      const message = String((error as Error)?.message ?? error);
      if (hooks.has("post_tool_use_failure")) {
        const failure = { type: (error as Error)?.name ?? "Error", message };
        await this.#ask("hook/invoke", { ...base, event: "post_tool_use_failure", arguments: args, error: failure });
      }
      return { ok: false, error: message };
    }
    if (hooks.has("post_tool_use")) {
      await this.#ask("hook/invoke", { ...base, event: "post_tool_use", arguments: args, result });
    }
    if (this.params.admitResults) result = (await this.#ask("artifact/admit", { ...base, result })).result as Json;
    return { ok: true, result };
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

  async #testReply<Reply>(request: ModelRequest<Reply>, model: string | null): Promise<Reply> {
    const call = request.describe();
    const answer = await this.#ask("model/complete", { runId: this.id, model, ...(call as unknown as JsonObject) });
    return request.reply(answer.message as unknown as TranscriptMessage);
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
