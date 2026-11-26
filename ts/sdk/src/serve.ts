// serve(): check the bridge, then serve it on stdio, or refuse with the diagnostics.

import { type Bridge, connect } from "./connection.ts";
import type { Diagnostic } from "./diagnostics.ts";
import { checkHandshake } from "./handshake.ts";
import { ErrorCode, type Json, RpcError } from "./peer.ts";
import { cachedPreflight, preflight, type PreflightReport } from "./preflight.ts";
import { describe, failed } from "./report.ts";
import { protocolOutput } from "./stdout.ts";

export type PreflightMode = "cached" | "always" | "off";

export interface ServeOptions {
  /**
   * `cached` (the default) runs the preflight once per fingerprint of the bridge, the SDK
   * and the fixtures, and replays its result after; `always` runs it on every start; `off`
   * runs only the handshake's checks. `KEDI_BRIDGE_PREFLIGHT` overrides it.
   */
  preflight?: PreflightMode;
  /** The bridge's entry file, for its fingerprint; `process.argv[1]` by default. */
  entry?: string;
}

/**
 * Serves `bridge` on stdio once it passes its preflight. With `--check`, runs the
 * preflight, prints the report and exits: 0 if it passed, 1 if not.
 */
export async function serve(bridge: Bridge, options: ServeOptions = {}): Promise<void> {
  const entry = options.entry ?? process.argv[1] ?? "";
  if (process.argv.includes("--check")) {
    const report = await preflight(bridge);
    process.stderr.write(`${describe(report)}\n`);
    process.exitCode = failed(report) ? 1 : 0;
    return;
  }
  const mode = (process.env.KEDI_BRIDGE_PREFLIGHT as PreflightMode | undefined) ?? options.preflight ?? "cached";
  const report: PreflightReport =
    mode === "off"
      ? { diagnostics: checkHandshake(bridge.handshake), passed: [], skipped: [], cached: false }
      : mode === "always"
        ? await preflight(bridge)
        : await cachedPreflight(bridge, entry);
  if (report.diagnostics.length) process.stderr.write(`${describe(report)}\n`);
  const errors = report.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  // A bridge that failed its preflight still answers initialize, with what is wrong, so Kedi
  // reports it rather than a closed connection.
  const refusal = errors.length
    ? new RpcError(ErrorCode.internalError, refusalMessage(errors, entry), { diagnostics: errors as unknown as Json })
    : undefined;
  const { closed } = connect(bridge, process.stdin, protocolOutput, refusal);
  await closed;
  process.exit(errors.length ? 1 : 0);
}

function refusalMessage(errors: Diagnostic[], entry: string): string {
  const codes = errors.map((diagnostic) => `${diagnostic.code} ${diagnostic.title}`).join("; ");
  return `the bridge failed its preflight: ${codes}. Run \`node ${entry} --check\` for the details`;
}
