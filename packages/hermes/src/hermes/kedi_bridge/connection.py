"""Serves a bridge on one connection: the handshake, runs and their control messages."""

from __future__ import annotations

import threading
from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol

from .peer import PROTOCOL_VERSION, ErrorCode, JsonObject, Peer, RpcError
from .run import BridgeUsageError, Run, RunStopped


class Bridge(Protocol):
    handshake: JsonObject
    """The ``initialize`` result, ``protocolVersion`` left out."""
    files: list[str]
    """Files the bridge loads at run time beside its entry, relative to the entry's directory.
    The preflight's cached result covers them."""

    def run(self, run: Run) -> JsonObject:
        """Runs one ``run`` request and returns its answer; ``run.stopped`` is set when Kedi
        cancels or interrupts it."""
        ...


@dataclass
class Connection:
    peer: Peer
    closed: threading.Event
    """Set when Kedi sends ``shutdown`` or closes the connection."""


def connect(bridge: Bridge, source: int, write: Callable[[bytes], None], refusal: RpcError | None = None) -> Connection:
    """Serves ``bridge`` on the file descriptor ``source`` and ``write``, refusing at ``initialize``
    if ``refusal`` is set."""
    peer = Peer(source, write)
    runs: dict[str, Run] = {}
    lock = threading.Lock()
    capabilities: JsonObject = bridge.handshake.get("capabilities") or {}
    state = {"test_mode": False, "ready": False}
    closed = threading.Event()

    def stop_all() -> None:
        with lock:
            live = list(runs.values())
        for run in live:
            run.stop("cancel")

    def on_close(_error: Exception) -> None:
        stop_all()
        closed.set()

    peer.on_close(on_close)

    def initialize(params: JsonObject) -> JsonObject:
        if refusal is not None:
            raise refusal
        if params.get("protocolVersion") != PROTOCOL_VERSION:
            raise RpcError(
                ErrorCode.UNSUPPORTED,
                f"this bridge speaks protocol version {PROTOCOL_VERSION}, not {params.get('protocolVersion')}",
            )
        if params.get("testModel") and not capabilities.get("testModel"):
            raise RpcError(ErrorCode.UNSUPPORTED, "Kedi asked for the test model; this bridge does not declare testModel")
        state["test_mode"] = bool(params.get("testModel"))
        state["ready"] = True
        return {"protocolVersion": PROTOCOL_VERSION, **bridge.handshake}

    def run(params: JsonObject) -> JsonObject:
        if not state["ready"]:
            raise RpcError(ErrorCode.INVALID_REQUEST, "run before initialize")
        current = Run(peer, params, capabilities, bool(state["test_mode"]))
        with lock:
            if current.id in runs:
                raise RpcError(ErrorCode.INVALID_PARAMS, f"run {current.id} is already in progress")
            runs[current.id] = current
        try:
            answer = bridge.run(current)
            _check_answer(current, answer)
            return answer
        except BaseException as error:
            raise _stopped(current, error) from error
        finally:
            with lock:
                runs.pop(current.id, None)
            current.finish()

    def run_input(params: JsonObject) -> JsonObject:
        if not capabilities.get("liveInput"):
            raise RpcError(ErrorCode.UNSUPPORTED, "this bridge does not declare liveInput")
        with lock:
            current = runs.get(str(params.get("runId")))
        if current is None:
            raise RpcError(ErrorCode.UNKNOWN_RUN, f"no run {params.get('runId')} is in progress")
        return {"delivered": current.input(params.get("items") or [])}

    def run_cancel(params: JsonObject) -> None:
        with lock:
            current = runs.get(str(params.get("runId")))
        if current is not None:
            current.stop("cancel")

    def run_interrupt(params: JsonObject) -> None:
        if not capabilities.get("interrupt"):
            return
        with lock:
            current = runs.get(str(params.get("runId")))
        if current is not None:
            current.stop("interrupt")

    def shutdown(_params: JsonObject) -> JsonObject:
        stop_all()
        threading.Timer(0, closed.set).start()
        return {}

    peer.on_request("initialize", initialize)
    peer.on_request("run", run)
    peer.on_request("run/input", run_input)
    peer.on_request("shutdown", shutdown)
    peer.on_notification("run/cancel", run_cancel)
    peer.on_notification("run/interrupt", run_interrupt)
    peer.start()
    return Connection(peer, closed)


def _stopped(run: Run, error: BaseException) -> BaseException:
    """A run's failure as the error Kedi expects: a stop's code, Kedi's denial, the harness's error."""
    # ``finish`` runs after this, so a stop seen here came from Kedi.
    reason = run.stop_reason if run.stop_reason is not None else error
    if isinstance(reason, RunStopped):
        if reason.kind == "cancel":
            return RpcError(ErrorCode.CANCELLED, "the run was cancelled")
        return RpcError(ErrorCode.INTERRUPTED, "the run was interrupted", run.snapshot())
    return error


def _check_answer(run: Run, answer: JsonObject) -> None:
    """The answer has the one result its run asks for, and what the run's mode needs back."""
    kinds = [key for key in ("text", "data", "content", "invalid") if key in answer]
    if len(kinds) != 1:
        raise BridgeUsageError(
            "KB210", f"a run answers with one of text, data, content or invalid; this one has {', '.join(kinds) or 'none'}"
        )
    if "invalid" in answer:
        return
    output = run.params.get("output")
    if output and not output.get("media") and "data" not in answer:
        raise BridgeUsageError("KB211", "the run has an output schema: answer with data")
    if isinstance(run.params.get("history"), list):
        key = "transcript" if run.params.get("processHistory") else "messages"
        if not isinstance(answer.get(key), list):
            what = (
                "the turn's new messages, the user turn included" if key == "messages" else "the whole conversation after the turn"
            )
            raise BridgeUsageError("KB212", f"a transcript run answers with {key}: {what}")
