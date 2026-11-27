"""``serve()``: check the bridge, then serve it on stdio, or refuse with the diagnostics."""

from __future__ import annotations

import os
import sys
from collections.abc import Callable
from typing import Literal

from .connection import Bridge, connect
from .diagnostics import Diagnostic, format_diagnostics
from .handshake import check_handshake
from .peer import ErrorCode, RpcError
from .preflight import PreflightReport, cached_preflight, preflight

PreflightMode = Literal["cached", "always", "off"]

_protocol_output: Callable[[bytes], None] | None = None


def claim_stdout() -> Callable[[bytes], None]:
    """Keeps stdout for protocol frames: from now on, what the process prints, through Python or
    its file descriptor 1 (subprocesses, native code), goes to stderr. Returns the writer for
    frames. ``serve()`` calls it; call it yourself before importing a harness that prints."""
    global _protocol_output
    if _protocol_output is not None:
        return _protocol_output
    sys.stdout.flush()
    descriptor = os.dup(1)
    os.dup2(2, 1)
    sys.stdout = sys.stderr

    def write(frame: bytes) -> None:
        view = memoryview(frame)
        while view:
            written = os.write(descriptor, view)
            view = view[written:]

    _protocol_output = write
    return write


def describe(report: PreflightReport) -> str:
    """The report for stderr: the diagnostics, then a summary line."""
    errors = len(report.errors)
    warnings = len(report.diagnostics) - errors
    parts = [f"{len(report.passed)} passed"]
    if errors:
        parts.append(f"{errors} failed")
    if warnings:
        parts.append(f"{warnings} warning{'' if warnings == 1 else 's'}")
    if report.skipped:
        parts.append(f"{len(report.skipped)} skipped ({'; '.join(f'{name}: {reason}' for name, reason in report.skipped)})")
    summary = f"kedi bridge check: {', '.join(parts)}{' (cached: the bridge is unchanged)' if report.cached else ''}"
    return f"{format_diagnostics(report.diagnostics)}\n\n{summary}" if report.diagnostics else summary


def serve(bridge: Bridge, *, preflight_mode: PreflightMode = "cached", entry: str | None = None) -> int:
    """Serves ``bridge`` on stdio once it passes its preflight, and returns the exit code. With
    ``--check``, runs the preflight, prints the report and returns: 0 if it passed, 1 if not.

    ``cached`` (the default) runs the preflight once per fingerprint of the bridge, the SDK and
    the fixtures, and replays its result after; ``always`` runs it on every start; ``off`` runs only
    the handshake's checks. ``KEDI_BRIDGE_PREFLIGHT`` overrides it."""
    entry = entry or (sys.argv[0] if sys.argv else "")
    if "--check" in sys.argv[1:]:
        report = preflight(bridge)
        print(describe(report), file=sys.stderr)
        return 1 if report.errors else 0
    write = claim_stdout()
    mode = os.environ.get("KEDI_BRIDGE_PREFLIGHT") or preflight_mode
    if mode == "off":
        report = PreflightReport(check_handshake(bridge.handshake))
    elif mode == "always":
        report = preflight(bridge)
    else:
        report = cached_preflight(bridge, entry)
    if report.diagnostics:
        print(describe(report), file=sys.stderr)
    errors = report.errors
    # A bridge that failed its preflight still answers initialize, with what is wrong, so Kedi
    # reports it rather than a closed connection.
    refusal = (
        RpcError(ErrorCode.INTERNAL_ERROR, _refusal_message(errors, entry), {"diagnostics": [d.to_json() for d in errors]})
        if errors
        else None
    )
    connection = connect(bridge, sys.stdin.fileno(), write, refusal)
    connection.closed.wait()
    return 1 if errors else 0


def _refusal_message(errors: list[Diagnostic], entry: str) -> str:
    codes = "; ".join(f"{diagnostic.code} {diagnostic.title}" for diagnostic in errors)
    return f"the bridge failed its preflight: {codes}. Run `python {entry} --check` for the details"
