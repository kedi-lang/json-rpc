// Code mode: pi's codemode tool is the model's way to Kedi's tools, and each call a script
// makes takes Kedi's steps.

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { JsonObject } from "../../sdk/src/peer.ts";
import { exchange } from "./harness.ts";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "mcp-server.mjs");

const LOOKUP = {
  name: "lookup", description: "A city's country.", outputSchema: null, requiredBeforeOutput: false,
  inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
};

/** A model that looks the city up from a codemode script, then answers with what it saw. */
function scripted(seen: JsonObject[]): JsonObject {
  if (seen.length === 1) {
    const code = "const country = await tools.lookup({ city: 'Lyon' }); text(country);";
    return { parts: [{ type: "toolCall", id: "c1", name: "codemode", arguments: { code } }] };
  }
  const said = JSON.stringify(seen.at(-1)!.messages).includes("France") ? "Lyon is in France." : "no result";
  return { parts: [{ type: "text", text: said }] };
}

const names = (request: JsonObject | undefined) => ((request?.tools ?? []) as { name: string }[]).map((tool) => tool.name);
const described = (request: JsonObject | undefined) =>
  String(((request?.tools ?? []) as { name: string; description?: string }[]).find((tool) => tool.name === "codemode")?.description);

test("code mode offers codemode, and a script's call of a Kedi tool goes through tool/call", async () => {
  const { result, steps, seen } = await exchange({
    model: scripted,
    run: { tools: [LOOKUP], codemode: true },
    answers: { "tool/call": () => ({ ok: true, result: "France" }) },
  });
  assert.equal(result?.text, "Lyon is in France.", steps.join(", "));
  assert.ok(names(seen[0]).includes("codemode"), names(seen[0]).join(", "));
  assert.ok(!names(seen[0]).includes("lookup"), names(seen[0]).join(", "));
  assert.deepEqual(steps.filter((step) => step.startsWith("tool/call")), ["tool/call lookup"]);
  assert.equal(steps.filter((step) => step === "admit request").length, 2, steps.join(", "));
});

test("a script's call of one of pi's own tools takes Kedi's approval", async () => {
  const reads = (seen: JsonObject[]): JsonObject =>
    seen.length === 1
      ? { parts: [{ type: "toolCall", id: "c1", name: "codemode", arguments: { code: "const note = await tools.read({ path: 'note.txt' }); text(note);" } }] }
      : { parts: [{ type: "text", text: JSON.stringify(seen.at(-1)!.messages).includes("not today") ? "refused" : "read it" }] };
  const { result, steps } = await exchange({
    model: reads,
    run: { tools: [LOOKUP], codemode: true },
    answers: { "approval/request": () => ({ decision: "deny", reason: "not today" }) },
  });
  assert.ok(steps.includes("approval/request"), steps.join(", "));
  assert.ok(!steps.includes("admit toolAttempt"), steps.join(", "));
  assert.equal(result?.text, "refused");
});

test("with code mode off, pi's codemode stays off and Kedi's tools are declared", async () => {
  const { seen } = await exchange({ model: () => ({ parts: [{ type: "text", text: "Ready." }] }), run: { tools: [LOOKUP] } });
  assert.ok(names(seen[0]).includes("lookup"));
  assert.ok(!names(seen[0]).includes("codemode"));
});

test("code mode lists every tool up front, an MCP server's too, and its calls take Kedi's steps", async () => {
  const shouts = (seen: JsonObject[]): JsonObject =>
    seen.length === 1
      ? { parts: [{ type: "toolCall", id: "c1", name: "codemode", arguments: { code: "text(await tools.mcp__s1__shout({ text: 'hi' }));" } }] }
      : { parts: [{ type: "text", text: JSON.stringify(seen.at(-1)!.messages).includes("HI") ? "shouted" : "silent" }] };
  const approvals: JsonObject[] = [];
  const { result, steps, seen } = await exchange({
    model: shouts,
    run: { tools: [LOOKUP], codemode: true, mcpServers: [{ transport: "stdio", command: process.execPath, args: [SERVER] }] },
    answers: { "approval/request": (params) => (approvals.push(params), { decision: "allow" }) },
  });
  assert.deepEqual(names(seen[0]).filter((name) => name === "lookup" || name.startsWith("mcp__")), []);
  // Nothing waits behind searchTools(): Kedi's tool and the server's are in the description.
  assert.match(described(seen[0]), /lookup/);
  assert.match(described(seen[0]), /shout/);
  assert.deepEqual([approvals[0]!.tool, approvals[0]!.origin], ["shout", "mcp"]);
  assert.ok(steps.includes("admit toolAttempt"), steps.join(", "));
  assert.equal(result?.text, "shouted");
});
