// pi's own tools take Kedi's steps in the protocol's order. The conformance fixtures cannot
// check this: they do not know a bridge's own tools.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
// Internal modules, not index.ts: the entry module redirects stdout, which the test runner reports on.
import { connect } from "../../sdk/src/connection.ts";
import { type JsonObject, Peer, RpcError } from "../../sdk/src/peer.ts";
import { piBridge } from "../pi.ts";

type Answers = Partial<Record<"approval/request" | "budget/admit" | "hook/invoke" | "artifact/admit", (params: JsonObject) => JsonObject>>;

/** Runs one prompt on the pi bridge: the model reads note.txt, then answers with what it saw. */
async function readNote(answers: Answers, run: JsonObject = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "kedi-pi-test-"));
  writeFileSync(join(cwd, "note.txt"), "The secret word is kedi.\n");
  const toBridge = new PassThrough();
  const fromBridge = new PassThrough();
  const connection = connect(piBridge({ cwd }), toBridge, { write: (frame: string) => fromBridge.write(frame) });
  const kedi = new Peer(fromBridge, { write: (frame: string) => toBridge.write(frame) });
  const steps: string[] = [];
  const seen: JsonObject[] = [];
  kedi.onRequest("model/complete", async (params) => {
    seen.push(params);
    steps.push("model");
    if (seen.length === 1) return { message: { role: "assistant", parts: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "note.txt" } }] } };
    const result = JSON.stringify(params.messages).match(/"toolResult","id":"t1","result":"((?:[^"\\]|\\.)*)"/)?.[1] ?? "";
    return { message: { role: "assistant", parts: [{ type: "text", text: `saw: ${result}` }] } };
  });
  for (const method of ["approval/request", "budget/admit", "hook/invoke", "artifact/admit"] as const) {
    kedi.onRequest(method, async (params) => {
      steps.push(method === "hook/invoke" ? String(params.event) : method === "budget/admit" ? `admit ${params.dimension}` : method);
      const answer = answers[method];
      if (answer) return answer(params);
      if (method === "approval/request") return { decision: "allow" };
      if (method === "budget/admit") return { admitted: true };
      if (method === "artifact/admit") return { result: params.result as never };
      return params.event === "pre_tool_use" ? { decision: "continue" } : {};
    });
  }
  await kedi.request("initialize", { protocolVersion: 1, client: { name: "test" }, testModel: true });
  const params = {
    runId: "r", callKind: "invoke", promptKind: "raw", model: "test", system: null, instructionParts: [], user: "Read note.txt.",
    userContent: null, output: null, tools: [], continuation: null, session: null, subagent: null, ...run,
  };
  try {
    return { result: await kedi.request("run", params as JsonObject), steps, seen };
  } catch (error) {
    return { error: error as RpcError, steps, seen };
  } finally {
    toBridge.end();
    fromBridge.end();
    await connection.closed;
  }
}

test("a pi tool call takes the hooks, approval, admission and artifact admission in order", async () => {
  const approvals: JsonObject[] = [];
  const { result, steps } = await readNote(
    {
      "approval/request": (params) => (approvals.push(params), { decision: "allow" }),
      "artifact/admit": () => ({ result: "artifact ref-1" }),
    },
    { hooks: ["pre_tool_use", "post_tool_use"], admitResults: true },
  );
  assert.deepEqual(steps, [
    "admit request", "model",
    "pre_tool_use", "approval/request", "admit toolAttempt", "post_tool_use", "artifact/admit",
    "admit request", "model",
  ]);
  assert.equal(approvals[0]!.risk, "read_only");
  assert.equal(approvals[0]!.origin, "adapter_native");
  // The model reads Kedi's artifact reference, not the file.
  assert.equal(result?.text, "saw: artifact ref-1");
});

test("a denied pi tool never runs, and the model reads Kedi's reason", async () => {
  const { result, steps } = await readNote({ "approval/request": () => ({ decision: "deny", reason: "not today" }) });
  assert.ok(!steps.includes("admit toolAttempt"), steps.join(", "));
  assert.match(String(result?.text), /not today/);
});

test("an edit runs the edited arguments", async () => {
  const cwd = "other.txt";
  const { result } = await readNote({ "approval/request": () => ({ decision: "edit", arguments: { path: cwd }, reason: "read the other one" }) });
  // other.txt does not exist: pi's read reports it, which shows the edited path ran.
  assert.match(String(result?.text), /other\.txt/);
});

test("a tool attempt Kedi does not admit ends the run with Kedi's error", async () => {
  const { error, steps } = await readNote({
    "budget/admit": (params): JsonObject =>
      params.dimension === "toolAttempt" ? { admitted: false, dimension: "toolAttempt", reason: "tool budget exhausted" } : { admitted: true },
  });
  assert.ok(error instanceof RpcError, "the run should fail");
  assert.equal(error.code, -32002);
  assert.match(error.message, /tool budget exhausted/);
  assert.equal(steps.filter((step) => step === "model").length, 1, steps.join(", "));
});
