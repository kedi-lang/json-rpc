// A minimal MCP server over stdio for the tests: shout (read-only) and wipe (destructive).
import { createInterface } from "node:readline";

const tools = [
  { name: "shout", description: "Shout a text.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, annotations: { readOnlyHint: true } },
  { name: "wipe", description: "Wipe everything.", inputSchema: { type: "object", properties: {} }, annotations: { destructiveHint: true } },
];
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  if (message.method === "initialize") {
    send({ id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "test-tools", version: "1" } } });
  } else if (message.method === "tools/list") {
    send({ id: message.id, result: { tools } });
  } else if (message.method === "tools/call") {
    const { name, arguments: args } = message.params;
    const text = name === "shout" ? String(args.text).toUpperCase() : "wiped";
    send({ id: message.id, result: { content: [{ type: "text", text }] } });
  } else {
    send({ id: message.id, error: { code: -32601, message: `no method ${message.method}` } });
  }
}
