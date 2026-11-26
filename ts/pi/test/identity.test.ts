// The bridge's model requests say they come from kedi-pi; pi's install report and attribution are off.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { identityHeaders, VERSION } from "../pi.ts";
import { exchange } from "./harness.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

test("the version the requests carry is the package's", () => {
  assert.equal(VERSION, JSON.parse(readFileSync(join(HERE, "../package.json"), "utf8")).version);
  assert.match(readFileSync(join(HERE, "../../../packages/pi/package.kedi"), "utf8"), new RegExp(`version: ${VERSION.replaceAll(".", "\\.")}\n`));
});

test("kedi-pi, by pi's rules for the providers that take an attribution", () => {
  assert.deepEqual(identityHeaders({ provider: "google", baseUrl: "https://generativelanguage.googleapis.com" }), {
    "User-Agent": `kedi-pi/${VERSION}`,
  });
  assert.deepEqual(identityHeaders({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" }), {
    "User-Agent": `kedi-pi/${VERSION}`,
    "HTTP-Referer": "https://kedi-lang.org",
    "X-OpenRouter-Title": "kedi-pi",
  });
});

test("a real request carries kedi-pi and nothing of pi's own identity", async () => {
  const seen: { path: string; headers: IncomingHttpHeaders }[] = [];
  const server = createServer((request, response) => {
    seen.push({ path: request.url ?? "", headers: request.headers });
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: object, finish: string | null) =>
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      response.end(`${chunk({ role: "assistant", content: "hi" }, null)}${chunk({}, "stop")}data: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  // pi's own configuration for this process: a local provider, and OpenRouter routed here.
  const agentDir = mkdtempSync(join(tmpdir(), "kedi-pi-agent-"));
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        local: { baseUrl: `http://127.0.0.1:${port}/local/v1`, api: "openai-completions", apiKey: "local", models: [{ id: "m" }] },
        openrouter: { baseUrl: `http://127.0.0.1:${port}/openrouter/v1` },
      },
    }),
  );
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.OPENROUTER_API_KEY = "test";
  try {
    for (const model of ["local/m", "openrouter/openai/gpt-4o-mini"]) {
      await exchange({ testModel: false, model: () => ({}), run: { model, user: "Say hi." } });
    }
  } finally {
    server.close();
  }
  const local = seen.find((request) => request.path.startsWith("/local/"));
  const openrouter = seen.find((request) => request.path.startsWith("/openrouter/"));
  assert.equal(local?.headers["user-agent"], `kedi-pi/${VERSION}`);
  assert.equal(local?.headers["x-openrouter-title"], undefined);
  assert.equal(openrouter?.headers["user-agent"], `kedi-pi/${VERSION}`);
  assert.equal(openrouter?.headers["x-openrouter-title"], "kedi-pi");
  assert.equal(openrouter?.headers["http-referer"], "https://kedi-lang.org");
  assert.equal(openrouter?.headers["x-openrouter-categories"], undefined);
});
