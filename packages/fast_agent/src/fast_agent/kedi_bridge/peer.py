"""One side of a JSON-RPC 2.0 connection over a byte stream: frames end at LF only."""

from __future__ import annotations

import json
import os
import threading
from collections.abc import Callable
from concurrent.futures import Future
from typing import Any

PROTOCOL_VERSION = 1
MAX_FRAME_BYTES = 8 * 1024 * 1024

Json = Any
JsonObject = dict[str, Any]


class ErrorCode:
    PARSE_ERROR = -32700
    INVALID_REQUEST = -32600
    METHOD_NOT_FOUND = -32601
    INVALID_PARAMS = -32602
    INTERNAL_ERROR = -32603
    UNSUPPORTED = -32001
    RUN_FAILED = -32002
    CANCELLED = -32003
    OVERLOADED = -32004
    UNKNOWN_RUN = -32005
    INTERRUPTED = -32006


class RpcError(Exception):
    """A JSON-RPC error: one the other side answered with, or one to answer with."""

    def __init__(self, code: int, message: str, data: Json = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data


class ConnectionEnded(Exception):
    """The connection to Kedi ended before an answer arrived."""


RequestHandler = Callable[[JsonObject], JsonObject]
NotificationHandler = Callable[[JsonObject], None]


class Peer:
    """Reads frames from the file descriptor ``source`` and writes them with ``write``.

    ``str.splitlines()`` also ends lines at CR, U+2028 and U+2029, which JSON strings may hold
    unescaped, so this splits on LF itself. Each request from the other side runs in a thread
    of its own: a ``run`` blocks until the run ends, while its control messages keep arriving.
    """

    def __init__(self, source: int, write: Callable[[bytes], None]) -> None:
        self._write = write
        self._write_lock = threading.Lock()
        self._lock = threading.Lock()
        self._ended = False
        self._next = 1
        self._pending: dict[int, Future[JsonObject]] = {}
        self._requests: dict[str, RequestHandler] = {}
        self._notifications: dict[str, NotificationHandler] = {}
        self._closed: list[Callable[[Exception], None]] = []
        self._observers: list[Callable[[JsonObject], None]] = []
        self._source = source
        self._reader = threading.Thread(target=self._read, name="kedi-bridge-reader", daemon=True)

    def start(self) -> None:
        """Starts reading; register the handlers first."""
        self._reader.start()

    def on_request(self, method: str, handler: RequestHandler) -> None:
        self._requests[method] = handler

    def on_notification(self, method: str, handler: NotificationHandler) -> None:
        self._notifications[method] = handler

    def on_message(self, listener: Callable[[JsonObject], None]) -> None:
        """Sees every frame the other side sends, before it is handled."""
        self._observers.append(listener)

    def on_close(self, listener: Callable[[Exception], None]) -> None:
        self._closed.append(listener)

    @property
    def ended(self) -> bool:
        return self._ended

    def request(self, method: str, params: JsonObject) -> Future[JsonObject]:
        """Sends a request; the future holds the result, or raises the ``RpcError`` answered."""
        future: Future[JsonObject] = Future()
        with self._lock:
            if self._ended:
                future.set_exception(ConnectionEnded("the connection to Kedi has ended"))
                return future
            request_id = self._next
            self._next += 1
            self._pending[request_id] = future
        self._send({"id": request_id, "method": method, "params": params})
        return future

    def notify(self, method: str, params: JsonObject) -> None:
        self._send({"method": method, "params": params})

    def _send(self, message: JsonObject) -> None:
        if self._ended:
            return
        frame = json.dumps({"jsonrpc": "2.0", **message}, ensure_ascii=False, separators=(",", ":"))
        with self._write_lock:
            try:
                self._write(frame.encode("utf-8") + b"\n")
            except OSError as error:
                self._fail(ConnectionEnded(f"cannot write to Kedi: {error}"))

    def _read(self) -> None:
        buffered = b""
        while not self._ended:
            try:
                chunk = os.read(self._source, 65536)
            except OSError:
                chunk = b""
            if not chunk:
                self._fail(ConnectionEnded("Kedi closed the connection"))
                return
            buffered += chunk
            while not self._ended:
                end = buffered.find(b"\n")
                if end == -1:
                    break
                line, buffered = buffered[:end], buffered[end + 1 :]
                if line.strip():
                    self._receive(line)
            # Spec section 2: a frame over the limit ends the connection.
            if len(buffered) > MAX_FRAME_BYTES:
                self._fail(ConnectionEnded("Kedi sent a frame over 8 MiB"))

    def _receive(self, line: bytes) -> None:
        try:
            message = json.loads(line)
            if not isinstance(message, dict):
                raise ValueError("not an object")
        except ValueError:
            # Spec section 2: a line that is not a JSON-RPC object ends the connection.
            self._send({"id": None, "error": {"code": ErrorCode.PARSE_ERROR, "message": "not JSON"}})
            self._fail(ConnectionEnded("Kedi sent a line that is not JSON"))
            return
        for observe in self._observers:
            observe(message)
        method = message.get("method")
        if isinstance(method, str):
            params = message.get("params") or {}
            if "id" not in message:
                handler = self._notifications.get(method)
                if handler is not None:
                    handler(params)
                return
            threading.Thread(
                target=self._answer, args=(message["id"], method, params), name=f"kedi-{method}", daemon=True
            ).start()
            return
        with self._lock:
            future = self._pending.pop(message.get("id"), None)  # type: ignore[arg-type]
        if future is None:
            return
        error = message.get("error")
        if error:
            future.set_exception(RpcError(int(error.get("code", 0)), str(error.get("message", "")), error.get("data")))
        else:
            future.set_result(message.get("result") or {})

    def _answer(self, request_id: Any, method: str, params: JsonObject) -> None:
        handler = self._requests.get(method)
        if handler is None:
            self._send({"id": request_id, "error": {"code": ErrorCode.METHOD_NOT_FOUND, "message": f"unknown method {method}"}})
            return
        try:
            result = handler(params)
        except BaseException as error:  # noqa: BLE001 - every failure becomes the answer
            self._send({"id": request_id, "error": error_frame(error)})
            return
        self._send({"id": request_id, "result": result})

    def _fail(self, error: Exception) -> None:
        with self._lock:
            if self._ended:
                return
            self._ended = True
            pending = list(self._pending.values())
            self._pending.clear()
        for future in pending:
            future.set_exception(error)
        for listener in self._closed:
            listener(error)

    def close(self) -> None:
        """Ends the connection from this side."""
        self._fail(ConnectionEnded("the bridge closed the connection"))


def error_frame(error: BaseException) -> JsonObject:
    """An error as a JSON-RPC error object; a harness's own error goes in ``data.harness``."""
    if isinstance(error, RpcError):
        frame: JsonObject = {"code": error.code, "message": error.message}
        if error.data is not None:
            frame["data"] = error.data
        return frame
    return {"code": ErrorCode.RUN_FAILED, "message": str(error) or type(error).__name__, "data": {"harness": harness_error(error)}}


def harness_error(error: BaseException, depth: int = 0) -> JsonObject:
    """A harness error as ``{type, message, cause?}``, its cause chain included."""
    frame: JsonObject = {"type": type(error).__name__, "message": str(error)}
    cause = error.__cause__ or error.__context__
    if cause is not None and depth < 4:
        frame["cause"] = harness_error(cause, depth + 1)
    return frame
