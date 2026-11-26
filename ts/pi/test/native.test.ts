// pi's own tools take Kedi's steps in the protocol's order. The conformance fixtures cannot
// check this: they do not know a bridge's own tools.

import assert from "node:assert/strict";
import { test } from "node:test";
import { type JsonObject, RpcError } from "../../sdk/src/peer.ts";
import { type Answers, exchange, readsTheNote } from "./harness.ts";

/** Runs one prompt on the pi bridge: the model reads note.txt, then answers with what it saw. */
async function readNote(answers: Answers, run: JsonObject = {}) {
  return exchange({ model: readsTheNote, answers, run });
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
