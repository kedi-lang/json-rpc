// Protocol version 1 shapes, as schema/v1/protocol.json defines them.

import type { Json, JsonObject } from "./peer.ts";
import type { EffortLevel, MediaKind, McpTransport } from "./handshake.ts";

export type ToolRisk = "read_only" | "mutating" | "sensitive";
export type ToolOrigin = "adapter_native" | "mcp" | "provider_builtin";
export type HookEvent = "pre_tool_use" | "post_tool_use" | "post_tool_use_failure";

export type MediaSource = { data: string; url?: never } | { url: string; data?: never };

export type TextPart = { type: "text"; text: string };
export type UserContentPart =
  | TextPart
  | ({ type: "media"; name: string; kind: MediaKind; mediaType?: string | null } & MediaSource);
export type ContentPart = TextPart | ({ type: "media"; kind: MediaKind; mediaType?: string | null } & MediaSource);

export type TranscriptPart =
  | TextPart
  | { type: "media"; ref?: string; kind?: MediaKind; mediaType?: string | null; data?: string; url?: string }
  | { type: "toolCall"; id: string; name: string; arguments: Json }
  | { type: "toolResult"; id: string; result: Json; isError?: boolean }
  | { type: "reasoning"; text?: string };

export interface TranscriptMessage {
  /** Kedi's id for the message; send it back as given. */
  id?: string;
  role: "user" | "assistant" | "tool";
  parts: TranscriptPart[];
  /** The bridge's own data for the message, sent back as given. */
  providerData?: Json;
}

export interface Tool {
  name: string;
  description?: string | null;
  inputSchema: JsonObject | null;
  outputSchema?: JsonObject | null;
  requiredBeforeOutput?: boolean;
}

export type Output =
  | null
  | { schema: JsonObject; toolName: string; media?: never }
  | { media: "image"; schema?: JsonObject; toolName?: string }
  | { media: "audio"; voice: string | null };

export interface Usage {
  requests?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
}

export interface McpServer {
  transport: McpTransport;
  command?: string | null;
  args?: string[];
  env?: Record<string, string>;
  url?: string | null;
  headers?: Record<string, string>;
}

export interface RunParams {
  runId: string;
  callKind: "invoke" | "produce";
  promptKind: "raw" | "template" | "claim";
  model: string | null;
  fallbackModels?: string[];
  settings?: JsonObject;
  effort?: EffortLevel | null;
  system: string | null;
  instructionParts: { identity: string; source: string; content: string }[];
  user: string;
  userContent: UserContentPart[] | null;
  output: Output;
  tools: Tool[];
  continuation: { answer: JsonObject; message: string } | null;
  session: { id: string; turn: number; state: Json } | null;
  history?: TranscriptMessage[];
  processHistory?: boolean;
  /**
   * With a session, when the bridge declared `compaction`: the program's policy. `native`
   * compacts the session as the backend does, at `threshold` input tokens when set; without
   * it, keep the backend's automatic compaction off.
   */
  compaction?: Compaction | null;
  /**
   * When the bridge declared `codemode` and the program turns code mode on: turn the backend's
   * code mode on, and offer Kedi's tools to its code only. Without it, keep the code mode off.
   */
  codemode?: boolean;
  subagent: {
    id: string | null;
    parentRunId: string | null;
    conversationId: string;
    name: string | null;
    limits: Record<string, number | null>;
  } | null;
  hooks?: HookEvent[];
  mcpServers?: McpServer[];
  admitResults?: boolean;
}

/**
 * A run's answer: text, data or content, and what the run's mode needs back. `invalid` quotes
 * a model answer that could not be parsed, with the parse `error`: Kedi then corrects the model.
 */
export type RunAnswer = ({ text: string } | { data: Json } | { content: ContentPart[] } | { invalid: string; error?: string }) & {
  usage?: Usage;
  /** State mode: what the next turn's `session.state` will be. */
  state?: Json;
  /** Transcript mode: the turn's new messages, the user turn included. */
  messages?: TranscriptMessage[];
  /** Transcript mode with history processing: the whole conversation after the turn. */
  transcript?: TranscriptMessage[];
};

export interface Compaction {
  mode: "native" | "disabled";
  threshold: number | null;
}

/** Token counts a model reports for one request; a count left out is unknown. */
export interface TokenCounts {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** One model request in Kedi's transcript schema, as `model/complete` carries it. */
export interface ModelCall {
  system: string | null;
  messages: TranscriptMessage[];
  tools: { name: string; description?: string | null; inputSchema?: JsonObject | null }[];
  output: { schema: JsonObject; toolName: string } | null;
}

export type ToolOutcome = { ok: true; result: Json } | { ok: false; error: string };
