// Serves a bridge on one connection: the handshake, runs and their control messages.

import type { Readable } from "node:stream";
import { ErrorCode, type Json, type JsonObject, Peer, PROTOCOL_VERSION, RpcError } from "./peer.ts";
import type { Handshake } from "./handshake.ts";
import { BridgeUsageError, Run, RunStopped } from "./run.ts";
import type { RunAnswer, RunParams } from "./types.ts";

export interface Bridge {
  handshake: Handshake;
  /**
   * Files the bridge loads at run time beside its entry, such as a WebAssembly module a bundle
   * cannot carry, relative to the entry's directory. The preflight's cached result covers them.
   */
  files?: string[];
  /** Runs one `run` request; `run.signal` aborts when Kedi cancels or interrupts it. */
  run(run: Run): Promise<RunAnswer>;
}

export interface Connection {
  peer: Peer;
  /** Resolves when Kedi sends `shutdown` or closes the connection. */
  closed: Promise<void>;
}

/** Serves `bridge` on `input` and `output`, refusing at `initialize` if `refusal` is set. */
export function connect(bridge: Bridge, input: Readable, output: { write(frame: string): unknown }, refusal?: RpcError): Connection {
  const peer = new Peer(input, output);
  const runs = new Map<string, Run>();
  const capabilities = bridge.handshake.capabilities;
  let testMode = false;
  let ready = false;
  let close!: () => void;
  const closed = new Promise<void>((resolve) => (close = resolve));
  peer.onClose(() => {
    for (const run of runs.values()) run.stop("cancel");
    close();
  });

  peer.onRequest("initialize", async (params) => {
    if (refusal) throw refusal;
    if (params.protocolVersion !== PROTOCOL_VERSION) {
      throw new RpcError(ErrorCode.unsupported, `this bridge speaks protocol version ${PROTOCOL_VERSION}, not ${params.protocolVersion}`);
    }
    if (params.testModel && !capabilities.testModel) {
      throw new RpcError(ErrorCode.unsupported, "Kedi asked for the test model; this bridge does not declare testModel");
    }
    testMode = Boolean(params.testModel);
    ready = true;
    return { protocolVersion: PROTOCOL_VERSION, ...(bridge.handshake as unknown as JsonObject) };
  });

  peer.onRequest("run", async (params) => {
    if (!ready) throw new RpcError(ErrorCode.invalidRequest, "run before initialize");
    const run = new Run(peer, params as unknown as RunParams, capabilities, testMode);
    if (runs.has(run.id)) throw new RpcError(ErrorCode.invalidParams, `run ${run.id} is already in progress`);
    runs.set(run.id, run);
    try {
      const answer = await bridge.run(run);
      checkAnswer(run, answer);
      return answer as unknown as JsonObject;
    } catch (error) {
      throw stopped(run, error);
    } finally {
      runs.delete(run.id);
      run.finish();
    }
  });

  peer.onRequest("run/input", async (params) => {
    if (!capabilities.liveInput) throw new RpcError(ErrorCode.unsupported, "this bridge does not declare liveInput");
    const run = runs.get(String(params.runId));
    if (!run) throw new RpcError(ErrorCode.unknownRun, `no run ${params.runId} is in progress`);
    return { delivered: await run.input(params.items as { id: string; text: string }[]) };
  });

  peer.onNotification("run/cancel", (params) => runs.get(String(params.runId))?.stop("cancel"));
  peer.onNotification("run/interrupt", (params) => {
    if (capabilities.interrupt) runs.get(String(params.runId))?.stop("interrupt");
  });

  peer.onRequest("shutdown", async () => {
    for (const run of runs.values()) run.stop("cancel");
    setImmediate(close);
    return {};
  });

  return { peer, closed };
}

/** A run's failure as the error Kedi expects: a stop's code, Kedi's denial, the harness's error. */
function stopped(run: Run, error: unknown): unknown {
  const reason = run.signal.aborted ? run.signal.reason : error;
  if (reason instanceof RunStopped) {
    if (reason.kind === "cancel") return new RpcError(ErrorCode.cancelled, "the run was cancelled");
    return new RpcError(ErrorCode.interrupted, "the run was interrupted", (run.snapshot() ?? null) as Json);
  }
  return error;
}

/** The answer has the one result its run asks for, and what the run's mode needs back. */
function checkAnswer(run: Run, answer: RunAnswer): void {
  const kinds = ["text", "data", "content", "invalid"].filter((key) => key in answer);
  if (kinds.length !== 1) {
    throw new BridgeUsageError("KB210", `a run answers with one of text, data, content or invalid; this one has ${kinds.join(", ") || "none"}`);
  }
  if ("invalid" in answer) return;
  if (run.params.output && !run.params.output.media && !("data" in answer)) {
    throw new BridgeUsageError("KB211", "the run has an output schema: answer with data");
  }
  if (Array.isArray(run.params.history)) {
    const key = run.params.processHistory ? "transcript" : "messages";
    if (!Array.isArray(answer[key])) {
      throw new BridgeUsageError("KB212", `a transcript run answers with ${key}: ${key === "messages" ? "the turn's new messages, the user turn included" : "the whole conversation after the turn"}`);
    }
  }
}
