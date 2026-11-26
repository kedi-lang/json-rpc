// A preflight report as text, for stderr.

import { formatDiagnostics } from "./diagnostics.ts";
import type { PreflightReport } from "./preflight.ts";

export function failed(report: PreflightReport): boolean {
  return report.diagnostics.some((diagnostic) => diagnostic.severity === "error");
}

/** The report for stderr: the diagnostics, then a summary line. */
export function describe(report: PreflightReport): string {
  const errors = report.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
  const warnings = report.diagnostics.length - errors;
  const parts = [
    `${report.passed.length} passed`,
    ...(errors ? [`${errors} failed`] : []),
    ...(warnings ? [`${warnings} warning${warnings === 1 ? "" : "s"}`] : []),
    ...(report.skipped.length ? [`${report.skipped.length} skipped (${report.skipped.map((skip) => `${skip.name}: ${skip.reason}`).join("; ")})`] : []),
  ];
  const summary = `kedi bridge check: ${parts.join(", ")}${report.cached ? " (cached: the bridge is unchanged)" : ""}`;
  return report.diagnostics.length ? `${formatDiagnostics(report.diagnostics)}\n\n${summary}` : summary;
}
