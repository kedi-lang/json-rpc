// Transcript mode: Kedi holds the conversation; the pi bridge loads it and hands the turn back.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonObject } from "../../sdk/src/peer.ts";
import { exchange } from "./harness.ts";

const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
const say = (role: string, text: string, id: string): JsonObject => ({ id, role, parts: [{ type: "text", text }] });
const HISTORY = [say("user", "My name is Ada.", "m1"), say("assistant", "Hello, Ada.", "m2")];
const texts = (messages: JsonObject[]) =>
  messages.map((message) => `${message.role}: ${(message.parts as JsonObject[]).map((part) => part.text ?? `[${part.type}]`).join("")}`);

test("Kedi's transcript reaches pi, and the turn comes back in Kedi's schema", async () => {
  const { seen, result } = await exchange({
    model: () => ({ parts: [{ type: "text", text: "Ada." }] }),
    run: { user: "What is my name?", history: HISTORY },
  });
  assert.deepEqual(texts(seen[0]!.messages as JsonObject[]), ["user: My name is Ada.", "assistant: Hello, Ada.", "user: What is my name?"]);
  const messages = result!.messages as JsonObject[];
  assert.deepEqual(texts(messages), ["user: What is my name?", "assistant: Ada."]);
  // pi's own message rides along, so the next turn restores it exactly.
  assert.equal((messages[1]!.providerData as JsonObject).role, "assistant");
});

test("a message pi wrote returns as pi wrote it; one Kedi changed is rebuilt from its parts", async () => {
  const given = { role: "assistant", content: [{ type: "text", text: "Hello, Ada." }], api: "x", provider: "p", model: "m", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 1, responseId: "kept" };
  const unchanged = { ...HISTORY[1]!, providerData: given };
  const edited = { ...say("assistant", "Hi, Ada (edited).", "m2"), providerData: given };
  for (const [message, expected] of [[unchanged, "Hello, Ada."], [edited, "Hi, Ada (edited)."]] as const) {
    const { seen } = await exchange({
      model: () => ({ parts: [{ type: "text", text: "ok" }] }),
      run: { user: "Again.", history: [HISTORY[0], message] },
    });
    assert.equal(texts(seen[0]!.messages as JsonObject[])[1], `assistant: ${expected}`);
  }
});

test("media of earlier turns come from Kedi by ref", async () => {
  const history: JsonObject[] = [{ id: "m1", role: "user", parts: [{ type: "text", text: "Look: " }, { type: "media", ref: "photo" }] }, HISTORY[1]!];
  const asked: string[] = [];
  const { seen } = await exchange({
    model: () => ({ parts: [{ type: "text", text: "ok" }] }),
    run: { user: "And now?", history },
    answers: { "media/get": (params) => (asked.push(String(params.ref)), { kind: "image", mediaType: "image/png", data: PIXEL }) },
  });
  assert.deepEqual(asked, ["photo"]);
  const parts = (seen[0]!.messages as JsonObject[])[0]!.parts as JsonObject[];
  assert.equal(parts[1]!.data, PIXEL);
});

test("the program's history processor decides what each request carries", async () => {
  const processed: JsonObject[][] = [];
  const { seen, result } = await exchange({
    model: () => ({ parts: [{ type: "text", text: "Ada." }] }),
    run: { user: "What is my name?", history: HISTORY, processHistory: true },
    // The processor keeps the newest message only.
    answers: { "history/process": (params) => (processed.push(params.messages as JsonObject[]), { messages: (params.messages as JsonObject[]).slice(-1) as never }) },
  });
  assert.deepEqual(texts(processed[0]!), ["user: My name is Ada.", "assistant: Hello, Ada.", "user: What is my name?"]);
  assert.deepEqual(texts(seen[0]!.messages as JsonObject[]), ["user: What is my name?"]);
  // A processed run hands back the whole conversation as Kedi's processor kept it.
  assert.deepEqual(texts(result!.transcript as JsonObject[]), ["user: What is my name?", "assistant: Ada."]);
  assert.equal(result!.messages, undefined);
});
