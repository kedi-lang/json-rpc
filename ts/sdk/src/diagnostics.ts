// Diagnostics: what is wrong with a bridge, said like a compiler would.

export type Severity = "error" | "warning";

export interface Diagnostic {
  /** A stable code, such as `KB003`. */
  code: string;
  severity: Severity;
  /** One line: what is wrong. */
  title: string;
  /** What was declared and what was found, line by line. */
  detail?: string[];
  /** How to fix it. */
  help?: string;
  /** Where the protocol says so. */
  docs?: string;
}

const SPEC = "https://github.com/kedi-lang/json-rpc/blob/main/spec/protocol.md";

export function docs(section: string): string {
  return `${SPEC}#${section}`;
}

/** Diagnostics as text for stderr: one block each, like a compiler's. */
export function formatDiagnostics(diagnostics: Diagnostic[]): string {
  return diagnostics
    .map((diagnostic) => {
      const lines = [`${diagnostic.severity}[${diagnostic.code}]: ${diagnostic.title}`];
      for (const line of diagnostic.detail ?? []) lines.push(`  │  ${line}`);
      if (diagnostic.help) lines.push(`  = help: ${diagnostic.help}`);
      if (diagnostic.docs) lines.push(`  = docs: ${diagnostic.docs}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

export class BridgeConfigurationError extends Error {
  readonly diagnostics: Diagnostic[];

  constructor(diagnostics: Diagnostic[]) {
    super(`the bridge is not ready to serve:\n\n${formatDiagnostics(diagnostics)}`);
    this.name = "BridgeConfigurationError";
    this.diagnostics = diagnostics;
  }
}
