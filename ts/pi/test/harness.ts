// A fake Kedi for the pi bridge's tests: one run, its model scripted, every step recorded.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
// Internal modules, not index.ts: the entry module redirects stdout, which the test runner reports on.
import { connect } from "../../sdk/src/connection.ts";
import { type JsonObject, Peer, RpcError } from "../../sdk/src/peer.ts";
import { piBridge } from "../pi.ts";

export type Answers = Partial<
  Record<
    "approval/request" | "budget/admit" | "hook/invoke" | "artifact/admit" | "history/process" | "media/get" | "tool/call",
    (params: JsonObject) => JsonObject
  >
>;

export interface Exchange {
  result?: JsonObject;
  error?: RpcError;
  /** Kedi's steps in order: "model", "admit request", hook events, approval, … */
  steps: string[];
  /** The model requests, as model/complete params. */
  seen: JsonObject[];
  /** The run/event notifications. */
  events: JsonObject[];
}

/** Runs one run on the pi bridge, in a workspace holding note.txt. */
export async function exchange(options: {
  model: (seen: JsonObject[]) => JsonObject;
  run?: JsonObject;
  answers?: Answers;
  /** false: pi's real providers answer, as named by the run's model. */
  testModel?: boolean;
}): Promise<Exchange> {
  const cwd = mkdtempSync(join(tmpdir(), "kedi-pi-test-"));
  writeFileSync(join(cwd, "note.txt"), "The secret word is kedi.\n");
  const toBridge = new PassThrough();
  const fromBridge = new PassThrough();
  const connection = connect(piBridge({ cwd }), toBridge, { write: (frame: string) => fromBridge.write(frame) });
  const kedi = new Peer(fromBridge, { write: (frame: string) => toBridge.write(frame) });
  const outcome: Exchange = { steps: [], seen: [], events: [] };
  kedi.onNotification("run/event", (params) => outcome.events.push(params));
  kedi.onRequest("model/complete", async (params) => {
    outcome.seen.push(params);
    outcome.steps.push(params.purpose === "compaction" ? `summary ${params.model}` : `model ${params.model}`);
    const { usage, ...reply } = options.model(outcome.seen);
    return { message: { role: "assistant", ...reply }, ...(usage ? { usage } : {}) };
  });
  for (const method of ["approval/request", "budget/admit", "hook/invoke", "artifact/admit", "history/process", "media/get", "tool/call"] as const) {
    kedi.onRequest(method, async (params) => {
      outcome.steps.push(
        method === "hook/invoke" ? String(params.event)
        : method === "budget/admit" ? `admit ${params.dimension}`
        : method === "tool/call" ? `tool/call ${params.name}`
        : method,
      );
      const answer = options.answers?.[method];
      if (answer) return answer(params);
      if (method === "approval/request") return { decision: "allow" };
      if (method === "budget/admit") return { admitted: true };
      if (method === "artifact/admit") return { result: params.result as never };
      if (method === "history/process") return { messages: params.messages as never };
      if (method === "media/get") throw new RpcError(-32602, `no media ${params.ref}`);
      if (method === "tool/call") return { ok: false, error: `no tool ${params.name}` };
      return params.event === "pre_tool_use" ? { decision: "continue" } : {};
    });
  }
  await kedi.request("initialize", { protocolVersion: 1, client: { name: "test" }, testModel: options.testModel ?? true });
  const params = {
    runId: "r", callKind: "invoke", promptKind: "raw", model: "test", system: null, instructionParts: [], user: "Read note.txt.",
    userContent: null, output: null, tools: [], continuation: null, session: null, subagent: null, ...options.run,
  };
  try {
    outcome.result = await kedi.request("run", params as JsonObject);
  } catch (error) {
    if (!(error instanceof RpcError)) throw error;
    outcome.error = error;
  } finally {
    toBridge.end();
    fromBridge.end();
    await connection.closed;
  }
  return outcome;
}

/** A model that reads note.txt with pi's read tool, then answers with what it saw. */
export function readsTheNote(seen: JsonObject[]): JsonObject {
  if (seen.length === 1) return { parts: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "note.txt" } }] };
  const result = JSON.stringify(seen.at(-1)!.messages).match(/"toolResult","id":"t1","result":"((?:[^"\\]|\\.)*)"/)?.[1] ?? "";
  return { parts: [{ type: "text", text: `saw: ${result}` }] };
}
