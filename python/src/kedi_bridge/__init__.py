"""The Kedi bridge SDK for Python: write a Kedi JSON-RPC bridge for a Python harness.

Standard library only, so it installs beside any harness's pinned dependencies. The API is
synchronous and thread-safe: a run blocks in ``Bridge.run`` while its control messages keep
arriving, and the steps Kedi decides (``Run.model_request``, ``Run.native_tool``, ...) may be
called from any thread.
"""

from .connection import Bridge, Connection, connect
from .diagnostics import BridgeConfigurationError, Diagnostic, format_diagnostics
from .handshake import check_handshake
from .peer import PROTOCOL_VERSION, ConnectionEnded, ErrorCode, Json, JsonObject, RpcError, harness_error
from .preflight import PreflightReport, cached_preflight, fingerprint, load_fixtures, preflight
from .run import (
    Allowed,
    BridgeUsageError,
    ModelRequest,
    NativeToolCall,
    Refused,
    Run,
    RunStopped,
    StepDenied,
)
from .serve import PreflightMode, claim_stdout, describe, serve
from .version import SDK_VERSION

__all__ = [
    "PROTOCOL_VERSION",
    "SDK_VERSION",
    "Allowed",
    "Bridge",
    "BridgeConfigurationError",
    "BridgeUsageError",
    "Connection",
    "ConnectionEnded",
    "Diagnostic",
    "ErrorCode",
    "Json",
    "JsonObject",
    "ModelRequest",
    "NativeToolCall",
    "PreflightMode",
    "PreflightReport",
    "Refused",
    "RpcError",
    "Run",
    "RunStopped",
    "StepDenied",
    "cached_preflight",
    "check_handshake",
    "claim_stdout",
    "connect",
    "describe",
    "fingerprint",
    "format_diagnostics",
    "harness_error",
    "load_fixtures",
    "preflight",
    "serve",
]
