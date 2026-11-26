// The Kedi bridge SDK. Import it before the harness: from then on, stdout carries only
// protocol frames, and whatever the harness prints goes to stderr.

import "./stdout.ts";

export { type Bridge, connect } from "./connection.ts";
export { BridgeConfigurationError, type Diagnostic, formatDiagnostics } from "./diagnostics.ts";
export { type Capabilities, checkHandshake, type Handshake } from "./handshake.ts";
export { ErrorCode, harnessError, type Json, type JsonObject, PROTOCOL_VERSION, RpcError } from "./peer.ts";
export { cachedPreflight, fingerprint, loadFixtures, preflight, type PreflightReport } from "./preflight.ts";
export { BridgeUsageError, type ModelRequest, type NativeToolCall, Run, RunStopped, StepDenied } from "./run.ts";
export { describe } from "./report.ts";
export { type PreflightMode, serve, type ServeOptions } from "./serve.ts";
export type * from "./types.ts";
