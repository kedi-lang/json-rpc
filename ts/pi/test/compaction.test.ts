// pi compacts its session natively under the program's policy; its summary request is Kedi's to admit.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonObject } from "../../sdk/src/peer.ts";
import { compactionSettings } from "../pi.ts";
import { exchange } from "./harness.ts";

const SUMMARY = "SUMMARY: the user asked to read the note.";
const NATIVE = { compaction: { mode: "native", threshold: 1 } };
const session = (state: unknown = null): JsonObject => ({ session: { id: "s1", turn: 0, state } as JsonObject });

/** A turn that reads the note, then answers; summary requests get the summary. */
function scripted(final: string) {
  return (seen: JsonObject[]): JsonObject => {
    const last = seen.at(-1)!;
    if (last.purpose === "compaction") return { parts: [{ type: "text", text: SUMMARY }], usage: { inputTokens: 900, outputTokens: 20 } };
    const turns = seen.filter((call) => call.purpose !== "compaction").length;
    if (turns === 1) return { parts: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "note.txt" } }], usage: { inputTokens: 5000, outputTokens: 10 } };
    return { parts: [{ type: "text", text: final }], usage: { inputTokens: 6000, outputTokens: 10 } };
  };
}

test("past its threshold, the session is compacted: the summary is admitted, reports no event, and lands in the state", async () => {
  const { result, steps, events, seen } = await exchange({ model: scripted("It says kedi."), run: { ...session(), ...NATIVE, hooks: [] } });
  assert.equal(result?.text, "It says kedi.");
  // At a threshold of one token, pi compacts after each of the turn's replies: each summary is admitted.
  const summaries = steps.flatMap((step, index) => (step.startsWith("summary") ? [index] : []));
  assert.ok(summaries.length >= 1, `no summary request in ${steps.join(", ")}`);
  for (const index of summaries) assert.equal(steps[index - 1], "admit request");
  assert.ok(!events.some((event) => String(event.text ?? "").includes("SUMMARY")));
  const entries = ((result!.state as JsonObject).entries as JsonObject[]).map((entry) => entry.type);
  assert.ok(entries.includes("compaction"), `state entries: ${entries.join(", ")}`);
  assert.equal(seen.filter((call) => call.purpose === "compaction").length, summaries.length);
});

test("the next turn resumes from the compacted session and sees the summary", async () => {
  const first = await exchange({ model: scripted("It says kedi."), run: { ...session(), ...NATIVE } });
  const second = await exchange({
    model: () => ({ parts: [{ type: "text", text: "Still kedi." }] }),
    run: { ...session(first.result!.state), user: "And again?" },
  });
  const request = JSON.stringify(second.seen[0]!.messages);
  assert.match(request, /SUMMARY: the user asked to read the note\./);
  assert.equal(second.result?.text, "Still kedi.");
});

test("without the program's policy pi never compacts, however large the context", async () => {
  const { steps, result } = await exchange({ model: scripted("It says kedi."), run: session() });
  assert.equal(result?.text, "It says kedi.");
  assert.ok(!steps.some((step) => step.startsWith("summary")), steps.join(", "));
});

test("the policy as pi's settings: off unless native; a threshold below the context window", () => {
  const model = { id: "m", contextWindow: 200_000 };
  assert.deepEqual(compactionSettings(undefined, model), { enabled: false });
  assert.deepEqual(compactionSettings({ mode: "disabled", threshold: null }, model), { enabled: false });
  assert.deepEqual(compactionSettings({ mode: "native", threshold: null }, model), { enabled: true });
  assert.deepEqual(compactionSettings({ mode: "native", threshold: 100_000 }, model), { enabled: true, reserveTokens: 100_000, keepRecentTokens: 20_000 });
  assert.throws(() => compactionSettings({ mode: "native", threshold: 200_000 }, model), /not below m's context window/);
});
