// The preflight: the handshake's checks, then the conformance fixtures run in-process
// against the bridge in test mode. A result is cached under the bridge's fingerprint.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { type Bridge, connect } from "./connection.ts";
import { type Diagnostic, docs } from "./diagnostics.ts";
import { checkHandshake } from "./handshake.ts";
import { FIXTURES } from "./fixtures.generated.ts";
import { type Json, type JsonObject, Peer, RpcError } from "./peer.ts";
import { SDK_VERSION } from "./version.ts";

/** The SDK's sources, when it runs from them; a bundled bridge carries them in its entry. */
const HERE = fileURLToPath(import.meta.url);
const SDK_SOURCES = basename(HERE) === "preflight.ts" ? dirname(HERE) : undefined;
const FIXTURE_TIMEOUT_MS = 10_000;

const RUN_DEFAULTS: JsonObject = {
  callKind: "invoke",
  promptKind: "raw",
  model: "test",
  fallbackModels: [],
  settings: {},
  effort: null,
  system: "You are being tested.",
  instructionParts: [],
  userContent: null,
  output: null,
  tools: [],
  continuation: null,
  session: null,
  subagent: null,
  hooks: [],
  mcpServers: [],
  admitResults: false,
};

interface Fixture {
  name: string;
  code: string;
  description: string;
  failure: string;
  help: string;
  spec: string;
  capabilities?: string[];
  run?: JsonObject;
  model?: JsonObject[];
  tools?: Record<string, { result?: Json; error?: string }>;
  budget?: Record<string, number>;
  failModels?: string[];
  historyProcess?: { keepLast?: number };
  onModelRequest?: Record<string, ({ send: string } & JsonObject)[]>;
  expect?: JsonObject;
}

export interface PreflightReport {
  diagnostics: Diagnostic[];
  passed: string[];
  skipped: { name: string; reason: string }[];
  /** Whether this report was replayed from the cache rather than checked now. */
  cached: boolean;
}

/** The conformance fixtures: the SDK's embedded copy of fixtures/v1, or those in `directory`. */
export function loadFixtures(directory?: string): Fixture[] {
  if (!directory) return structuredClone(FIXTURES) as unknown as Fixture[];
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(directory, name), "utf8")) as Fixture);
}

/** Checks `bridge` now: its handshake, then every fixture it declares the capabilities for. */
export async function preflight(bridge: Bridge, fixtures = loadFixtures()): Promise<PreflightReport> {
  const report: PreflightReport = { diagnostics: checkHandshake(bridge.handshake), passed: [], skipped: [], cached: false };
  if (report.diagnostics.some((diagnostic) => diagnostic.severity === "error")) return report;
  const declared = bridge.handshake.capabilities as Record<string, boolean | undefined>;
  if (!declared.testModel) {
    report.diagnostics.push({
      code: "KB090",
      severity: "warning",
      title: "the bridge has no test model, so its capabilities were not exercised",
      detail: [`${fixtures.length} conformance fixtures need testModel to run without a model endpoint`],
      help: "declare testModel and send model requests through run.modelRequest",
      docs: docs("10-test-model"),
    });
    return report;
  }
  for (const fixture of fixtures) {
    const missing = (fixture.capabilities ?? []).filter((name) => !declared[name]);
    if (missing.length) {
      report.skipped.push({ name: fixture.name, reason: `needs ${missing.join(", ")}` });
      continue;
    }
    const problems = await runFixture(bridge, fixture);
    if (problems.length === 0) {
      report.passed.push(fixture.name);
      continue;
    }
    report.diagnostics.push({
      code: fixture.code,
      severity: "error",
      title: fixture.failure,
      detail: [`fixture ${fixture.name}: ${fixture.description}`, ...problems],
      help: fixture.help,
      docs: docs(fixture.spec),
    });
  }
  return report;
}

/** The preflight, replayed from the cache when the bridge, the SDK and the fixtures are unchanged. */
export async function cachedPreflight(bridge: Bridge, entry: string, cacheDirectory = cacheDir()): Promise<PreflightReport> {
  const key = fingerprint(bridge, entry);
  const file = join(cacheDirectory, `${key}.json`);
  try {
    const stored = JSON.parse(readFileSync(file, "utf8")) as PreflightReport;
    return { ...stored, cached: true };
  } catch {
    // Not checked yet.
  }
  const report = await preflight(bridge);
  try {
    mkdirSync(cacheDirectory, { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(report));
    renameSync(temporary, file);
  } catch {
    // A read-only cache only means checking again next time.
  }
  return report;
}

export function cacheDir(): string {
  if (process.env.KEDI_BRIDGE_CACHE) return process.env.KEDI_BRIDGE_CACHE;
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "kedi", "bridge-checks");
}

/**
 * What the preflight's result depends on: the bridge's entry, the SDK's version, the fixtures
 * and the handshake; running from sources, also the SDK's sources and the bridge's package (its
 * files and lockfile) when the entry's own directory holds its package.json. A bundled bridge
 * carries the SDK and its dependencies in the entry, so the entry alone stands for them.
 */
export function fingerprint(bridge: Bridge, entry: string): string {
  const hash = createHash("sha256");
  hash.update(`sdk ${SDK_VERSION}\n`);
  hash.update(`fixtures ${JSON.stringify(FIXTURES)}\n`);
  hash.update(`handshake ${JSON.stringify(bridge.handshake)}\n`);
  const files = new Set<string>([resolve(entry)]);
  if (SDK_SOURCES) {
    // Never above the entry's directory: an installed bridge may sit below a home directory
    // whose package.json would otherwise make every file under it part of the bridge.
    const root = dirname(resolve(entry));
    const own = existsSync(join(root, "package.json")) ? root : undefined;
    for (const directory of [own, SDK_SOURCES]) {
      if (directory) for (const file of walk(directory)) files.add(file);
    }
    for (const name of ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"]) {
      if (own && existsSync(join(own, name))) files.add(join(own, name));
    }
  }
  for (const file of [...files].sort()) {
    hash.update(`${file}\n`);
    hash.update(readFileSync(file));
  }
  // A declared file that is missing counts as missing: it breaks the bridge as a changed one does.
  for (const name of bridge.files ?? []) {
    const file = resolve(dirname(resolve(entry)), name);
    hash.update(`declared ${name}\n`);
    hash.update(existsSync(file) ? readFileSync(file) : "missing");
  }
  return hash.digest("hex").slice(0, 32);
}

const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", "dist", "coverage"]);

function* walk(directory: string): Generator<string> {
  for (const name of readdirSync(directory).sort()) {
    if (SKIPPED_DIRECTORIES.has(name) || name.startsWith(".")) continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

interface Answer {
  result?: JsonObject;
  error?: { code: number; message: string; data?: Json };
}

/** Runs one fixture against a fresh connection to `bridge`; what did not hold, described. */
async function runFixture(bridge: Bridge, fixture: Fixture): Promise<string[]> {
  const toBridge = new PassThrough();
  const fromBridge = new PassThrough();
  const connection = connect(bridge, toBridge, { write: (frame: string) => fromBridge.write(frame) });
  const kedi = new Peer(fromBridge, { write: (frame: string) => toBridge.write(frame) });
  const sent: string[] = [];
  const seen: JsonObject[] = [];
  const events: JsonObject[] = [];
  const answers: Promise<{ method: string; answer: Answer }>[] = [];
  const script = [...(fixture.model ?? [])];
  const budget = { ...(fixture.budget ?? {}) };
  kedi.onMessage((message) => {
    if (typeof message.method === "string") sent.push(message.method);
    if (message.method === "run/event") events.push(message.params as JsonObject);
  });
  kedi.onRequest("model/complete", async (params) => {
    seen.push(params);
    for (const action of fixture.onModelRequest?.[String(seen.length)] ?? []) {
      const { send, ...rest } = action;
      const params = { runId: "run-1", ...rest } as JsonObject;
      if (send === "run/input") answers.push(settle(send, kedi.request(send, params)));
      else kedi.notify(send, params);
    }
    if (fixture.failModels?.includes(String(params.model))) throw new RpcError(-32002, `model ${params.model} is down`);
    const reply = script.shift() ?? { parts: [{ type: "text", text: "done" }] };
    return { message: { role: "assistant", ...reply } };
  });
  kedi.onRequest("budget/admit", async (params): Promise<JsonObject> => {
    const dimension = String(params.dimension);
    const left = budget[dimension];
    if (left !== undefined && left <= 0) {
      setImmediate(() => kedi.notify("run/cancel", { runId: "run-1" }));
      return { admitted: false, dimension, reason: "budget exhausted" };
    }
    if (left !== undefined) budget[dimension] = left - 1;
    return { admitted: true };
  });
  kedi.onRequest("history/process", async (params): Promise<JsonObject> => {
    const keep = fixture.historyProcess?.keepLast;
    const messages = params.messages as Json[];
    return { messages: keep ? messages.slice(-keep) : messages };
  });
  kedi.onRequest("tool/call", async (params): Promise<JsonObject> => {
    const tool = fixture.tools?.[String(params.name)] ?? { error: "unknown tool" };
    return "result" in tool ? { ok: true, result: tool.result as Json } : { ok: false, error: String(tool.error) };
  });

  const problems: string[] = [];
  try {
    await withTimeout(kedi.request("initialize", { protocolVersion: 1, client: { name: "kedi-bridge-preflight" }, testModel: true }), "initialize");
    const params = { ...RUN_DEFAULTS, user: "Hello.", ...(fixture.run ?? {}), runId: "run-1" };
    const answer = await withTimeout(settle("run", kedi.request("run", params)), "the run");
    const replies = await withTimeout(Promise.all(answers), "run/input");
    problems.push(...expectations(fixture.expect ?? {}, answer.answer, seen, sent, replies, events));
  } catch (error) {
    problems.push(String((error as Error).message ?? error));
  } finally {
    toBridge.end();
    fromBridge.end();
    await connection.closed;
  }
  return problems;
}

function settle(method: string, request: Promise<JsonObject>): Promise<{ method: string; answer: Answer }> {
  return request.then(
    (result) => ({ method, answer: { result } }),
    (error) => {
      if (!(error instanceof RpcError)) throw error;
      return { method, answer: { error: { code: error.code, message: error.message, data: error.data } } };
    },
  );
}

function withTimeout<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer within ${FIXTURE_TIMEOUT_MS / 1000}s`)), FIXTURE_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function expectations(
  expect: JsonObject,
  answer: Answer,
  seen: JsonObject[],
  sent: string[],
  replies: { method: string; answer: Answer }[],
  events: JsonObject[],
): string[] {
  const found: string[] = [];
  const shown = answer.error ? `an error, ${answer.error.code}: ${answer.error.message}` : JSON.stringify(answer.result);
  if ("result" in expect && !contains(answer.result, expect.result)) found.push(`the run answered ${shown}, expected ${JSON.stringify(expect.result)}`);
  if ("error" in expect && !contains(answer.error, expect.error)) found.push(`the run answered ${shown}, expected the error ${JSON.stringify(expect.error)}`);
  if (expect.failed && !answer.error) found.push(`the run answered ${shown}, expected it to fail`);
  for (const key of (expect.errorDataKeys as string[] | undefined) ?? []) {
    const data = answer.error?.data;
    if (!data || typeof data !== "object" || !(key in data)) found.push(`the run's error data has no ${key}`);
  }
  for (const key of (expect.resultKeys as string[] | undefined) ?? []) {
    if (!answer.result || !(key in answer.result)) found.push(`the run's result has no ${key}`);
  }
  for (const wanted of (expect.answers as JsonObject[] | undefined) ?? []) {
    const held = replies.some((reply) => reply.method === wanted.method && contains(reply.answer.result, wanted.result));
    if (!held) found.push(`no ${wanted.method} answer held ${JSON.stringify(wanted.result)}`);
  }
  if ("modelRequests" in expect && seen.length !== expect.modelRequests) {
    found.push(`the bridge sent ${seen.length} model requests, expected ${expect.modelRequests}`);
  }
  for (const check of (expect.modelSaw as { request: number; contains: string }[] | undefined) ?? []) {
    const request = seen[check.request - 1];
    if (!strings(request).some((text) => text.includes(check.contains))) {
      found.push(`model request ${check.request} did not carry ${JSON.stringify(check.contains)}`);
    }
  }
  for (const check of (expect.modelMissed as { request: number; contains: string }[] | undefined) ?? []) {
    const request = seen[check.request - 1];
    if (strings(request).some((text) => text.includes(check.contains))) {
      found.push(`model request ${check.request} carried ${JSON.stringify(check.contains)}`);
    }
  }
  for (const wanted of (expect.events as JsonObject[] | undefined) ?? []) {
    if (!events.some((event) => contains(event, wanted))) found.push(`no run/event held ${JSON.stringify(wanted)}; the bridge sent ${JSON.stringify(events)}`);
  }
  const order = expect.order as string[] | undefined;
  if (order) {
    let position = 0;
    for (const method of sent) if (method === order[position]) position++;
    if (position < order.length) found.push(`the bridge's requests ${JSON.stringify(sent)} do not follow ${JSON.stringify(order)}`);
  }
  for (const counted of (expect.count as { method: string; times: number }[] | undefined) ?? []) {
    const times = sent.filter((method) => method === counted.method).length;
    if (times !== counted.times) found.push(`the bridge sent ${counted.method} ${times} times, expected ${counted.times}`);
  }
  return found;
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

function contains(actual: unknown, expected: unknown): boolean {
  if (expected && typeof expected === "object" && !Array.isArray(expected)) {
    if (!actual || typeof actual !== "object") return false;
    return Object.entries(expected).every(([key, value]) => key in actual && contains((actual as Record<string, unknown>)[key], value));
  }
  return JSON.stringify(actual) === JSON.stringify(expected);
}
