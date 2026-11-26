// Kedi's > mcp: servers connect through pi's MCP client; their calls take Kedi's steps.

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { JsonObject } from "../../sdk/src/peer.ts";
import { exchange } from "./harness.ts";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "mcp-server.mjs");
const MCP = { mcpServers: [{ transport: "stdio", command: process.execPath, args: [SERVER] }] };

function calls(name: string, args: JsonObject) {
  return (seen: JsonObject[]): JsonObject => {
    if (seen.length === 1) return { parts: [{ type: "toolCall", id: "t1", name, arguments: args }] };
    const result = JSON.stringify(seen.at(-1)!.messages).match(/"toolResult","id":"t1","result":"((?:[^"\\]|\\.)*)"/)?.[1] ?? "";
    return { parts: [{ type: "text", text: `got: ${result}` }] };
  };
}

test("an MCP tool is declared to the model and its call takes Kedi's steps, as an MCP call", async () => {
  const approvals: JsonObject[] = [];
  const hooks: JsonObject[] = [];
  const { seen, result, steps } = await exchange({
    model: calls("mcp__s1__shout", { text: "hi" }),
    run: { ...MCP, hooks: ["pre_tool_use", "post_tool_use"] },
    answers: {
      "approval/request": (params) => (approvals.push(params), { decision: "allow" }),
      "hook/invoke": (params): JsonObject => (hooks.push(params), params.event === "pre_tool_use" ? { decision: "continue" } : {}),
    },
  });
  assert.ok((seen[0]!.tools as JsonObject[]).some((tool) => tool.name === "mcp__s1__shout"));
  assert.deepEqual(steps.slice(2, 5), ["pre_tool_use", "approval/request", "admit toolAttempt"]);
  // Kedi sees the server's own tool name, its origin, and the risk the server declares.
  assert.deepEqual([approvals[0]!.tool, approvals[0]!.origin, approvals[0]!.risk], ["shout", "mcp", "read_only"]);
  assert.deepEqual(hooks.map((hook) => [hook.event, hook.tool, hook.origin]), [["pre_tool_use", "shout", "mcp"], ["post_tool_use", "shout", "mcp"]]);
  assert.equal(result?.text, "got: HI");
});

test("a destructive MCP tool asks approval as sensitive, and a denied one never runs", async () => {
  const approvals: JsonObject[] = [];
  const { result } = await exchange({
    model: calls("mcp__s1__wipe", {}),
    run: MCP,
    answers: { "approval/request": (params) => (approvals.push(params), { decision: "deny", reason: "not here" }) },
  });
  assert.equal(approvals[0]!.risk, "sensitive");
  assert.match(String(result?.text), /not here/);
  assert.doesNotMatch(String(result?.text), /wiped/);
});
