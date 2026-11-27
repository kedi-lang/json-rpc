"""What a bridge declares in ``initialize``, and the checks ``serve()`` runs on it before serving.

A handshake is the ``initialize`` result as a dict, ``protocolVersion`` left out:
``{"backend": {"name": ...}, "kind": ..., "capabilities": {...}, "mediaKinds": [...], ...}``.
"""

from __future__ import annotations

from typing import Any

from .diagnostics import Diagnostic, docs

KNOWN_CAPABILITIES = frozenset({
    "structuredOutput", "tools", "nativeStructuredOutput", "nativeToolCalling", "nativeTools",
    "events", "mediaInput", "sessions", "transcript", "governed", "subagents", "liveInput",
    "interrupt", "usage", "modelFallback", "imageOutput", "audioOutput", "testModel",
})
KEDI_SETTINGS = frozenset({"context_limit", "media_limit", "request_retries", "tool_reason", "voice"})
EFFORT_LEVELS = frozenset({"minimal", "low", "medium", "high", "xhigh", "max"})
MEDIA_KINDS = frozenset({"image", "audio", "video", "document"})
TRANSPORTS = frozenset({"stdio", "http", "sse"})
CODE_LANGUAGES = frozenset({"python", "javascript"})


def check_handshake(handshake: dict[str, Any]) -> list[Diagnostic]:
    """Problems Kedi would refuse the handshake for, found before serving."""
    found: list[Diagnostic] = []
    has: dict[str, Any] = handshake.get("capabilities") or {}

    def requires(code: str, capability: str, needed: str, why: str) -> None:
        if has.get(capability) and not has.get(needed):
            found.append(Diagnostic(
                code, "error", f"{capability} is declared without {needed}", [why],
                f"declare {needed} and implement it, or drop {capability}", docs("4-capabilities"),
            ))

    for name in has:
        if name not in KNOWN_CAPABILITIES:
            found.append(Diagnostic(
                "KB008", "error", f"{name} is not a protocol version 1 capability",
                ["Kedi ignores a capability it does not know, so the bridge would run without it"],
                "check its spelling against the capability table", docs("4-capabilities"),
            ))
    requires("KB001", "subagents", "governed", "Kedi admits each of a child's requests against its limits")
    requires("KB002", "liveInput", "subagents", "run/input reaches a running child")
    requires("KB003", "interrupt", "liveInput", "an interrupt comes with the input that caused it")
    mcp = handshake.get("mcp") or {}
    if mcp.get("transports") and not has.get("nativeTools"):
        found.append(Diagnostic(
            "KB007", "error", "mcp is declared without nativeTools",
            ["MCP tools are the bridge's own: their calls need hook/invoke, approval/request and artifact/admit"],
            "declare nativeTools and take MCP calls through those steps, or drop mcp", docs("4-capabilities"),
        ))
    if handshake.get("compaction") is not None and not has.get("sessions"):
        found.append(Diagnostic(
            "KB011", "error", "compaction is declared without sessions",
            ["the backend compacts its own session state, which only sessions hand back to Kedi"],
            "declare sessions and hand back the compacted state, or drop compaction", docs("4-capabilities"),
        ))
    codemode = handshake.get("codemode")
    if codemode is not None and not has.get("tools"):
        found.append(Diagnostic(
            "KB012", "error", "codemode is declared without tools",
            ["the backend's code calls Kedi's tools, which tools/call reaches"],
            "declare tools and offer them to the code, or drop codemode", docs("4-capabilities"),
        ))
    if codemode is not None and (codemode.get("language") if isinstance(codemode, dict) else None) not in CODE_LANGUAGES:
        found.append(Diagnostic("KB013", "error", "codemode names no language", help="declare codemode: {language: python} or {language: javascript}"))
    if has.get("mediaInput") and not handshake.get("mediaKinds"):
        found.append(Diagnostic(
            "KB004", "error", "mediaInput is declared without mediaKinds",
            help="list the kinds the backend takes: image, audio, video, document", docs=docs("4-capabilities"),
        ))
    for kind in handshake.get("mediaKinds") or []:
        if kind not in MEDIA_KINDS:
            found.append(Diagnostic("KB010", "error", f"{kind} is not a media kind", help="use image, audio, video or document"))
    own = [name for name in handshake.get("settings") or [] if name in KEDI_SETTINGS]
    if own:
        found.append(Diagnostic(
            "KB005", "error", f"settings lists Kedi's own settings: {', '.join(own)}",
            ["Kedi applies these itself and never sends them"],
            "list only the settings your backend applies", docs("4-capabilities"),
        ))
    for level in handshake.get("effort") or []:
        if level not in EFFORT_LEVELS:
            found.append(Diagnostic("KB006", "error", f"{level} is not an effort level", help="use minimal, low, medium, high, xhigh or max"))
    for transport in mcp.get("transports") or []:
        if transport not in TRANSPORTS:
            found.append(Diagnostic("KB009", "error", f"{transport} is not an MCP transport", help="use stdio, http or sse"))
    return found
