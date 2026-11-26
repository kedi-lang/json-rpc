// What a bridge declares in initialize, and the checks serve() runs on it before serving.

import { type Diagnostic, docs } from "./diagnostics.ts";

export type MediaKind = "image" | "audio" | "video" | "document";
export type EffortLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type McpTransport = "stdio" | "http" | "sse";

export interface Capabilities {
  structuredOutput?: boolean;
  tools?: boolean;
  nativeStructuredOutput?: boolean;
  nativeToolCalling?: boolean;
  nativeTools?: boolean;
  events?: boolean;
  mediaInput?: boolean;
  sessions?: boolean;
  transcript?: boolean;
  governed?: boolean;
  subagents?: boolean;
  liveInput?: boolean;
  interrupt?: boolean;
  usage?: boolean;
  modelFallback?: boolean;
  imageOutput?: boolean;
  audioOutput?: boolean;
  testModel?: boolean;
}

export interface Handshake {
  backend: { name: string; version?: string };
  kind: "agent-framework" | "agent-harness";
  capabilities: Capabilities;
  mediaKinds?: MediaKind[];
  /** The `> settings:` names the backend applies. */
  settings?: string[];
  /** The `> effort:` levels the backend maps. */
  effort?: EffortLevel[];
  mcp?: { transports: McpTransport[] };
}

const KNOWN_CAPABILITIES = new Set<string>([
  "structuredOutput", "tools", "nativeStructuredOutput", "nativeToolCalling", "nativeTools",
  "events", "mediaInput", "sessions", "transcript", "governed", "subagents", "liveInput",
  "interrupt", "usage", "modelFallback", "imageOutput", "audioOutput", "testModel",
]);
const KEDI_SETTINGS = new Set(["context_limit", "media_limit", "request_retries", "tool_reason", "voice"]);
const EFFORT_LEVELS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);
const MEDIA_KINDS = new Set(["image", "audio", "video", "document"]);
const TRANSPORTS = new Set(["stdio", "http", "sse"]);

/** Problems Kedi would refuse the handshake for, found before serving. */
export function checkHandshake(handshake: Handshake): Diagnostic[] {
  const found: Diagnostic[] = [];
  const has = handshake.capabilities;
  const requires = (code: string, capability: keyof Capabilities, needed: keyof Capabilities, why: string) => {
    if (has[capability] && !has[needed]) {
      found.push({
        code,
        severity: "error",
        title: `${capability} is declared without ${needed}`,
        detail: [why],
        help: `declare ${needed} and implement it, or drop ${capability}`,
        docs: docs("4-capabilities"),
      });
    }
  };
  for (const name of Object.keys(has)) {
    if (!KNOWN_CAPABILITIES.has(name)) {
      found.push({
        code: "KB008",
        severity: "error",
        title: `${name} is not a protocol version 1 capability`,
        detail: ["Kedi ignores a capability it does not know, so the bridge would run without it"],
        help: "check its spelling against the capability table",
        docs: docs("4-capabilities"),
      });
    }
  }
  requires("KB001", "subagents", "governed", "Kedi admits each of a child's requests against its limits");
  requires("KB002", "liveInput", "subagents", "run/input reaches a running child");
  requires("KB003", "interrupt", "liveInput", "an interrupt comes with the input that caused it");
  if (handshake.mcp?.transports.length && !has.nativeTools) {
    found.push({
      code: "KB007",
      severity: "error",
      title: "mcp is declared without nativeTools",
      detail: ["MCP tools are the bridge's own: their calls need hook/invoke, approval/request and artifact/admit"],
      help: "declare nativeTools and take MCP calls through those steps, or drop mcp",
      docs: docs("4-capabilities"),
    });
  }
  if (has.mediaInput && !handshake.mediaKinds?.length) {
    found.push({
      code: "KB004",
      severity: "error",
      title: "mediaInput is declared without mediaKinds",
      help: "list the kinds the backend takes: image, audio, video, document",
      docs: docs("4-capabilities"),
    });
  }
  for (const kind of handshake.mediaKinds ?? []) {
    if (!MEDIA_KINDS.has(kind)) {
      found.push({ code: "KB010", severity: "error", title: `${kind} is not a media kind`, help: "use image, audio, video or document" });
    }
  }
  const own = (handshake.settings ?? []).filter((name) => KEDI_SETTINGS.has(name));
  if (own.length) {
    found.push({
      code: "KB005",
      severity: "error",
      title: `settings lists Kedi's own settings: ${own.join(", ")}`,
      detail: ["Kedi applies these itself and never sends them"],
      help: "list only the settings your backend applies",
      docs: docs("4-capabilities"),
    });
  }
  for (const level of handshake.effort ?? []) {
    if (!EFFORT_LEVELS.has(level)) {
      found.push({ code: "KB006", severity: "error", title: `${level} is not an effort level`, help: "use minimal, low, medium, high, xhigh or max" });
    }
  }
  for (const transport of handshake.mcp?.transports ?? []) {
    if (!TRANSPORTS.has(transport)) {
      found.push({ code: "KB009", severity: "error", title: `${transport} is not an MCP transport`, help: "use stdio, http or sse" });
    }
  }
  return found;
}
