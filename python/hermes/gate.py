"""The model gate: every model request Hermes sends goes through Kedi first.

Hermes retries and falls back inside its provider call (a failed streamed request is sent again
without streaming), so the gate sits at the wire: it wraps httpx's transports, which carry every
physical request any Hermes client makes. A model request (a POST to a chat completions, messages
or responses path) is admitted with ``budget/admit``; in test mode Kedi's test model answers it,
and no request leaves the process. Everything else passes through.

A model request is a POST to a chat completions, messages or responses path, or any POST to the
host a run's model resolved to: a provider's native API (Gemini's ``/interactions``, for one)
is gated as well, so the gate fails closed when Hermes takes a path it does not know.

A request belongs to the run named by its ``X-Kedi-Run`` header (a delegated child's route sets
it) or, without one, to the run the calling thread works for (``CURRENT_RUN``). A model request
that belongs to no run is refused: nothing reaches a model ungoverned.
"""

from __future__ import annotations

import asyncio
import json
import threading
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any

import httpx
from convert import completion, event_stream, model_call

from kedi_bridge import JsonObject, ModelRequest, Run, RunStopped

CURRENT_RUN: ContextVar[str | None] = ContextVar("kedi_hermes_run", default=None)
RUN_HEADER = "x-kedi-run"
MODEL_PATHS = ("/chat/completions", "/messages", "/responses")
# Metadata Hermes probes for at startup (an Ollama context-length lookup): no model answers it.
PROBE_PATHS = frozenset({"/api/show"})


@dataclass
class GatedRun:
    run: Run
    failure: BaseException | None = None
    """Why the gate refused a request: Kedi's denial or the run's stop. The run reports it."""
    requests: int = 0
    lock: threading.Lock = field(default_factory=threading.Lock)


class Gate:
    def __init__(self) -> None:
        self._runs: dict[str, GatedRun] = {}
        self._model_hosts: set[str] = set()
        """Every host a run's model resolved to; kept after the run, so a late request is refused."""
        self._lock = threading.Lock()
        self._installed = False

    def open(self, run: Run, model_host: str | None) -> GatedRun:
        gated = GatedRun(run)
        with self._lock:
            self._runs[run.id] = gated
            if model_host:
                self._model_hosts.add(model_host)
        return gated

    def is_model_request(self, request: httpx.Request) -> bool:
        if request.method != "POST" or request.url.path in PROBE_PATHS:
            return False
        if request.url.path.endswith(MODEL_PATHS):
            return True
        with self._lock:
            return request.url.host in self._model_hosts

    def close(self, run_id: str) -> None:
        with self._lock:
            self._runs.pop(run_id, None)

    def install(self) -> None:
        if self._installed:
            return
        self._installed = True
        sync_send = httpx.HTTPTransport.handle_request
        async_send = httpx.AsyncHTTPTransport.handle_async_request
        gate = self

        def handle_request(transport: httpx.HTTPTransport, request: httpx.Request) -> httpx.Response:
            if not gate.is_model_request(request):
                return sync_send(transport, request)
            return gate._handle(request, lambda forwarded: sync_send(transport, forwarded))

        async def handle_async_request(transport: httpx.AsyncHTTPTransport, request: httpx.Request) -> httpx.Response:
            if not gate.is_model_request(request):
                return await async_send(transport, request)
            await request.aread()
            loop = asyncio.get_running_loop()

            def forward(forwarded: httpx.Request) -> httpx.Response:
                response = asyncio.run_coroutine_threadsafe(async_send(transport, forwarded), loop).result()
                content = asyncio.run_coroutine_threadsafe(response.aread(), loop).result()
                return httpx.Response(response.status_code, headers=response.headers, content=content, request=forwarded)

            return await asyncio.to_thread(gate._handle, request, forward)

        httpx.HTTPTransport.handle_request = handle_request  # type: ignore[method-assign]
        httpx.AsyncHTTPTransport.handle_async_request = handle_async_request  # type: ignore[method-assign]

    def _handle(self, request: httpx.Request, forward: Any) -> httpx.Response:
        run_id = request.headers.get(RUN_HEADER) or CURRENT_RUN.get()
        with self._lock:
            gated = self._runs.get(run_id) if run_id else None
        if gated is None:
            return _refusal(request, "this model request belongs to no Kedi run, so it was not sent")
        try:
            body: JsonObject = json.loads(request.content or b"{}")
        except ValueError:
            body = {}
        run = gated.run
        streamed = bool(body.get("stream"))

        def send(_model: str | None, _run: Run) -> httpx.Response:
            response = forward(_without_header(request))
            if response.status_code >= 400:
                response.read()
            return response

        def reply(message: JsonObject, counts: JsonObject | None) -> httpx.Response:
            built = completion(message, counts, str(body.get("model") or "kedi-test"))
            if streamed:
                return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=event_stream(built), request=request)
            return httpx.Response(200, json=built, request=request)

        def describe() -> JsonObject:
            if "messages" in body:
                return model_call(body)
            # A provider's native request: its text, so live input can still be seen in it.
            raw = request.content.decode("utf-8", "replace")
            return {"system": None, "messages": [{"role": "user", "parts": [{"type": "text", "text": raw}]}], "tools": [], "output": None}

        model_request: ModelRequest[httpx.Response] = ModelRequest(send=send, describe=describe, reply=reply)
        try:
            with gated.lock:
                gated.requests += 1
            return run.model_request(model_request)
        except RunStopped as stop:
            gated.failure = stop
            return _refusal(request, "the run was stopped")
        except Exception as error:  # noqa: BLE001 - Kedi's denial or a failed model ends the turn
            gated.failure = error
            return _refusal(request, str(error) or type(error).__name__)


def _without_header(request: httpx.Request) -> httpx.Request:
    if RUN_HEADER not in request.headers:
        return request
    headers = httpx.Headers(request.headers)
    del headers[RUN_HEADER]
    return httpx.Request(request.method, request.url, headers=headers, content=request.content, extensions=request.extensions)


def _refusal(request: httpx.Request, reason: str) -> httpx.Response:
    """A 400: Hermes fails the turn after one request, without retrying."""
    error = {"error": {"message": f"Kedi: {reason}", "type": "invalid_request_error", "code": "kedi_refused"}}
    return httpx.Response(400, json=error, request=request)
