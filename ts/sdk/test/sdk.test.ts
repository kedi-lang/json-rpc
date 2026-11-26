import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe as suite, test } from "node:test";
import { fileURLToPath } from "node:url";
// The internal modules, not index.ts: the entry module sends stdout to stderr, and the test
// runner reports over stdout.
import { checkHandshake } from "../src/handshake.ts";
import { cachedPreflight, fingerprint, preflight } from "../src/preflight.ts";
import { describe } from "../src/report.ts";
import { bypassing, minimal } from "./bridges/minimal.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const HANDSHAKES = JSON.parse(readFileSync(join(HERE, "../../../fixtures/handshake/v1.json"), "utf8")) as {
  cases: { name: string; handshake: Parameters<typeof checkHandshake>[0]; refuses: string | null }[];
};

suite("handshake", () => {
  for (const handshake of HANDSHAKES.cases) {
    test(`${handshake.name}: ${handshake.refuses ?? "accepted"}, as Kedi does`, () => {
      const codes = checkHandshake(handshake.handshake).map((diagnostic) => diagnostic.code);
      assert.deepEqual(codes, handshake.refuses ? [handshake.refuses] : []);
    });
  }

  test("a misspelled capability is reported", () => {
    const found = checkHandshake({ backend: { name: "x" }, kind: "agent-harness", capabilities: { liveinput: true } as never });
    assert.equal(found[0]?.code, "KB008");
  });
});

suite("preflight", () => {
  test("a bridge that routes its model requests through the SDK passes what it declares", async () => {
    const report = await preflight(minimal({ testModel: true, governed: true, usage: true, tools: true }, { onInput: true }));
    assert.deepEqual(report.diagnostics, [], describe(report));
    assert.ok(report.passed.includes("governed-admits-each-request"));
    assert.ok(report.passed.includes("usage"));
    assert.deepEqual(report.skipped.map((skip) => skip.name), [
      "events", "history-processing", "interrupt-session", "interrupt-transcript", "interrupt",
      "live-input", "media-input", "model-fallback", "structured", "transcript",
    ]);
  });

  test("declared live input that never reaches the model is an error, with the fix", async () => {
    const report = await preflight(minimal({ testModel: true, governed: true, subagents: true, liveInput: true, tools: true }));
    const live = report.diagnostics.find((diagnostic) => diagnostic.code === "KB106");
    assert.ok(live, describe(report));
    // What went wrong (the SDK's own usage error), and how to fix it.
    assert.match(live.detail!.join("\n"), /KB201: live input arrived, but the run has no run\.onInput handler/);
    assert.match(live.help!, /register run\.onInput/);
    assert.equal(report.diagnostics.length, 1, describe(report));
  });

  test("a bridge that calls its model around the SDK fails governance and the test model", async () => {
    const report = await preflight(bypassing({ testModel: true, governed: true, tools: true }));
    const codes = report.diagnostics.map((diagnostic) => diagnostic.code);
    assert.ok(codes.includes("KB100"), describe(report));
    assert.ok(codes.includes("KB104"), describe(report));
  });

  test("a handshake that breaks a rule is reported without running fixtures", async () => {
    const report = await preflight(minimal({ testModel: true, liveInput: true }));
    assert.deepEqual(report.diagnostics.map((diagnostic) => diagnostic.code), ["KB002"]);
    assert.deepEqual(report.passed, []);
  });

  test("without a test model, the fixtures are skipped with a warning, not passed", async () => {
    const report = await preflight(minimal({}));
    assert.deepEqual(report.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.severity]), [["KB090", "warning"]]);
    assert.deepEqual(report.passed, []);
  });
});

suite("package", () => {
  test("the version constant matches package.json", async () => {
    const { SDK_VERSION } = await import("../src/version.ts");
    assert.equal(SDK_VERSION, JSON.parse(readFileSync(join(HERE, "../package.json"), "utf8")).version);
  });
});

suite("cache", () => {
  const entry = () => {
    const directory = mkdtempSync(join(tmpdir(), "kedi-bridge-"));
    writeFileSync(join(directory, "package.json"), "{}");
    writeFileSync(join(directory, "bridge.ts"), "// v1\n");
    return join(directory, "bridge.ts");
  };

  test("an unchanged bridge replays its result; a changed one is checked again", async () => {
    const cache = mkdtempSync(join(tmpdir(), "kedi-cache-"));
    const file = entry();
    const bridge = minimal({ testModel: true });
    const first = await cachedPreflight(bridge, file, cache);
    const second = await cachedPreflight(bridge, file, cache);
    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
    assert.deepEqual(second.passed, first.passed);
    writeFileSync(file, "// v2\n");
    assert.equal((await cachedPreflight(bridge, file, cache)).cached, false);
  });

  test("a failed check replays the same diagnostics without checking again", async () => {
    const cache = mkdtempSync(join(tmpdir(), "kedi-cache-"));
    const file = entry();
    const bridge = minimal({ testModel: true, governed: true, subagents: true, liveInput: true, tools: true });
    const first = await cachedPreflight(bridge, file, cache);
    const replayed = await cachedPreflight(bridge, file, cache);
    assert.ok(first.diagnostics.length > 0);
    assert.equal(replayed.cached, true);
    assert.deepEqual(replayed.diagnostics, first.diagnostics);
    assert.match(describe(replayed), /cached: the bridge is unchanged/);
  });

  test("the fingerprint never reaches above the bridge's own directory", () => {
    // An installed bridge below a home directory that happens to hold a package.json.
    const home = mkdtempSync(join(tmpdir(), "kedi-home-"));
    writeFileSync(join(home, "package.json"), "{}");
    writeFileSync(join(home, "notes.txt"), "v1");
    const installed = join(home, "registry", "pi");
    mkdirSync(installed, { recursive: true });
    writeFileSync(join(installed, "bridge.mjs"), "// bridge\n");
    const bridge = minimal({ testModel: true });
    const before = fingerprint(bridge, join(installed, "bridge.mjs"));
    writeFileSync(join(home, "notes.txt"), "v2");
    assert.equal(fingerprint(bridge, join(installed, "bridge.mjs")), before);
  });

  test("the fingerprint covers the handshake", () => {
    const file = entry();
    assert.notEqual(fingerprint(minimal({ testModel: true }), file), fingerprint(minimal({ testModel: true, usage: true }), file));
  });
});

/** Starts a test bridge, sends frames, and collects what it writes until it exits: Kedi closes stdin once `answers` frames arrived. */
function exchange(bridge: string, frames: object[], answers = frames.length): Promise<{ stdout: string[]; stderr: string; code: number | null }> {
  const child = spawn(process.execPath, [join(HERE, "bridges", bridge)], {
    env: { ...process.env, KEDI_BRIDGE_PREFLIGHT: "always" },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (stdout.split("\n").filter(Boolean).length >= answers) child.stdin.end();
  });
  child.stderr.on("data", (chunk) => (stderr += chunk));
  for (const frame of frames) child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...frame })}\n`);
  return new Promise((resolve) => child.on("close", (code) => resolve({ stdout: stdout.split("\n").filter(Boolean), stderr, code })));
}

const INITIALIZE = { id: 1, method: "initialize", params: { protocolVersion: 1, client: { name: "test" } } };

suite("serve", () => {
  test("a bridge that fails its preflight refuses initialize with the diagnostics", async () => {
    const { stdout, stderr, code } = await exchange("refused.ts", [INITIALIZE]);
    const answer = JSON.parse(stdout[0]!);
    assert.equal(answer.error.code, -32603);
    assert.match(answer.error.message, /KB002 liveInput is declared without subagents/);
    assert.match(answer.error.message, /--check/);
    assert.equal(answer.error.data.diagnostics[0].code, "KB002");
    assert.match(stderr, /error\[KB002\]: liveInput is declared without subagents/);
    assert.equal(code, 1);
  });

  test("whatever the harness prints goes to stderr; stdout carries only frames", async () => {
    const run = { id: 2, method: "run", params: { runId: "r", user: "Hi.", system: null, tools: [], output: null } };
    const { stdout, stderr } = await exchange("noisy.ts", [INITIALIZE, run]);
    for (const line of stdout) assert.doesNotThrow(() => JSON.parse(line), `not a frame: ${line}`);
    assert.match(stderr, /harness banner on stdout/);
    assert.match(stderr, /raw stdout write/);
    assert.match(stderr, /harness log during a run/);
    assert.deepEqual(JSON.parse(stdout[1]!).result, { text: "real model" });
  });
});
