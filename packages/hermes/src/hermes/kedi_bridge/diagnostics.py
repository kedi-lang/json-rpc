"""Diagnostics: what is wrong with a bridge, said like a compiler would."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Literal

Severity = Literal["error", "warning"]

SPEC = "https://github.com/kedi-lang/json-rpc/blob/main/spec/protocol.md"


def docs(section: str) -> str:
    return f"{SPEC}#{section}"


@dataclass
class Diagnostic:
    code: str
    """A stable code, such as ``KB003``."""
    severity: Severity
    title: str
    """One line: what is wrong."""
    detail: list[str] = field(default_factory=list)
    """What was declared and what was found, line by line."""
    help: str | None = None
    """How to fix it."""
    docs: str | None = None
    """Where the protocol says so."""

    def to_json(self) -> dict:
        return {key: value for key, value in asdict(self).items() if value not in (None, [])}


def format_diagnostics(diagnostics: list[Diagnostic]) -> str:
    """Diagnostics as text for stderr: one block each, like a compiler's."""
    blocks = []
    for diagnostic in diagnostics:
        lines = [f"{diagnostic.severity}[{diagnostic.code}]: {diagnostic.title}"]
        lines += [f"  │  {line}" for line in diagnostic.detail]
        if diagnostic.help:
            lines.append(f"  = help: {diagnostic.help}")
        if diagnostic.docs:
            lines.append(f"  = docs: {diagnostic.docs}")
        blocks.append("\n".join(lines))
    return "\n\n".join(blocks)


class BridgeConfigurationError(Exception):
    def __init__(self, diagnostics: list[Diagnostic]) -> None:
        super().__init__(f"the bridge is not ready to serve:\n\n{format_diagnostics(diagnostics)}")
        self.diagnostics = diagnostics
