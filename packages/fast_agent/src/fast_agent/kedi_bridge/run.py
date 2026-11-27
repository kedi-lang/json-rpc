"""A run in progress: its params, its stop signal, and the steps Kedi decides."""

from __future__ import annotations

import threading
from collections.abc import Callable
from concurrent.futures import FIRST_COMPLETED, Future, wait
from dataclasses import dataclass, field
from typing import Any, Generic, Literal, Protocol, TypeVar

from .peer import ErrorCode, Json, JsonObject, Peer, RpcError

Reply = TypeVar("Reply")
StopKind = Literal["cancel", "interrupt"]
RISK_ORDER = {"read_only": 0, "mutating": 1, "sensitive": 2}


class RunStopped(Exception):
    """Why a run stopped: Kedi cancelled it, or interrupted its attempt."""

    def __init__(self, kind: StopKind) -> None:
        super().__init__("the run was cancelled" if kind == "cancel" else "the run was interrupted")
        self.kind = kind


class StepDenied(RpcError):
    """Kedi denied a step: the run ends with Kedi's error."""

    def __init__(self, reason: str, data: Json = None) -> None:
        super().__init__(ErrorCode.RUN_FAILED, reason, data)


class BridgeUsageError(Exception):
    """The bridge used the SDK in a way the protocol does not allow."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code


class History(Protocol):
    def get(self) -> list[JsonObject]: ...
    def set(self, messages: list[JsonObject]) -> None: ...


class ModelRequest(Generic[Reply]):
    """One model request, as the bridge's backend makes it. Subclass it, or pass the callables.

    ``send`` sends the request to the backend's model; check ``run.stopped`` in long waits.
    ``describe`` gives the request in Kedi's transcript schema (``ModelCall``): test mode sends it
    as ``model/complete``. ``reply`` turns Kedi's test-model message, with the counts its model
    reports, into the backend's reply. ``purpose`` is ``"compaction"`` for the summary request of
    native compaction: admitted and counted like any request, but no turn of the run, so it hands
    over no live input and confirms none. ``usage`` gives a reply's counts, for ``run/usage``.
    ``history`` gets and sets the conversation the request sends, for history processing.
    """

    purpose: Literal["turn", "compaction"] = "turn"
    history: History | None = None

    def __init__(
        self,
        send: Callable[[str | None, Run], Reply] | None = None,
        describe: Callable[[], JsonObject] | None = None,
        reply: Callable[[JsonObject, JsonObject | None], Reply] | None = None,
        *,
        usage: Callable[[Reply], JsonObject | None] | None = None,
        history: History | None = None,
        purpose: Literal["turn", "compaction"] = "turn",
    ) -> None:
        self._send, self._describe, self._reply, self._usage = send, describe, reply, usage
        self.history = history
        self.purpose = purpose

    def send(self, model: str | None, run: Run) -> Reply:
        if self._send is None:
            raise NotImplementedError("ModelRequest.send")
        return self._send(model, run)

    def describe(self) -> JsonObject:
        if self._describe is None:
            raise NotImplementedError("ModelRequest.describe")
        return self._describe()

    def reply(self, message: JsonObject, usage: JsonObject | None) -> Reply:
        if self._reply is None:
            raise NotImplementedError("ModelRequest.reply")
        return self._reply(message, usage)

    def usage(self, reply: Reply) -> JsonObject | None:
        return self._usage(reply) if self._usage is not None else None


@dataclass
class NativeToolCall:
    call_id: str
    name: str
    arguments: JsonObject
    origin: str = "adapter_native"
    risk: str | Callable[[JsonObject], str] = "mutating"
    """The call's risk; a function is asked again for arguments a hook or approval edited."""
    description: str | None = None
    input_schema: JsonObject | None = None


@dataclass
class Allowed:
    arguments: JsonObject
    run: Literal[True] = True


@dataclass
class Refused:
    reason: str
    run: Literal[False] = False


@dataclass
class _PendingInput:
    id: str
    text: str
    answer: Callable[[bool], None] = field(repr=False)


class Run:
    def __init__(self, peer: Peer, params: JsonObject, capabilities: JsonObject, test_mode: bool) -> None:
        self.params = params
        self.test_mode = test_mode
        self._peer = peer
        self._capabilities = capabilities
        self._lock = threading.Lock()
        self.stopped = threading.Event()
        """Set when Kedi cancels or interrupts the run; check it in every long wait."""
        self.stop_reason: RunStopped | None = None
        self._stop_future: Future[None] = Future()
        self._queued: list[_PendingInput] = []
        self._handed: list[_PendingInput] = []
        self._on_input: Callable[[list[str]], None] | None = None
        self._on_arrival = False
        self._snapshot: Callable[[], JsonObject] | None = None

    @property
    def id(self) -> str:
        return str(self.params["runId"])

    def on_input(self, handler: Callable[[list[str]], None], *, on: Literal["request", "arrival"] = "request") -> None:
        """Live input (``run/input``): ``handler`` gets each input's text as a user turn, right before
        the next ``model_request`` builds its request. With ``on="arrival"`` it gets them as they
        arrive, for a harness that queues input itself (steering). Either way an input is answered
        delivered once a request's ``describe()`` carries its text."""
        self._on_input = handler
        self._on_arrival = on == "arrival"
        if self._on_arrival:
            self._hand()

    def on_interrupt(self, snapshot: Callable[[], JsonObject]) -> None:
        """What an interrupted attempt hands back: ``{state}``, ``{messages}`` or ``{transcript}``."""
        self._snapshot = snapshot

    def model_request(self, request: ModelRequest[Reply]) -> Reply:
        """One model request, with every step Kedi decides around it: live input, history
        processing, admission per model tried (fallbacks included), the test model, usage."""
        self._raise_if_stopped()
        turn = request.purpose != "compaction"
        if turn and self._queued:
            # Input not handed over stays queued, and the run's end answers it undelivered.
            if self._on_input is None:
                raise BridgeUsageError("KB201", "live input arrived, but the run has no run.on_input handler")
            self._hand()
        if turn and self.params.get("processHistory"):
            if request.history is None:
                raise BridgeUsageError("KB202", "the run asks for history processing; the request has no history")
            kept = self._ask("history/process", {"runId": self.id, "messages": request.history.get()})
            request.history.set(kept["messages"])
        fallbacks = self.params.get("fallbackModels") or [] if self._capabilities.get("modelFallback") else []
        models = [self.params.get("model"), *fallbacks]
        failure: BaseException | None = None
        for model in models:
            if self._capabilities.get("governed"):
                self.admit("request")
            if turn:
                self._confirm_carried(request)
            try:
                reply = self._test_reply(request, model) if self.test_mode else self._race(self._spawn(request.send, model, self))
            except BaseException as error:  # noqa: BLE001 - a failed model is tried with the next
                if self.stopped.is_set():
                    raise self.stop_reason from error  # type: ignore[misc]
                failure = error
                continue
            # With usage, every model request is reported; counts the reply lacks stay unknown.
            if self._capabilities.get("usage"):
                self.report_usage(request.usage(reply) or {})
            return reply
        assert failure is not None
        raise failure

    def native_tool(self, call: NativeToolCall, execute: Callable[[JsonObject, Run], Json]) -> JsonObject:
        """A call of one of the bridge's own tools, through every step Kedi decides: the
        ``pre_tool_use`` hook, approval, admission, the call, the post hooks, artifact admission.
        Returns what the model should read: ``{ok: True, result}`` or ``{ok: False, error}``."""
        before = self.before_native_tool(call)
        if isinstance(before, Refused):
            return {"ok": False, "error": before.reason}
        try:
            result = self._race(self._spawn(execute, before.arguments, self))
        except RunStopped:
            raise
        except Exception as error:  # noqa: BLE001 - the tool's failure is the model's to read
            return self.after_native_tool(call, before.arguments, error=error)
        return self.after_native_tool(call, before.arguments, result=result)

    def before_native_tool(self, call: NativeToolCall) -> Allowed | Refused:
        """The steps before a call of one of the bridge's own tools, for a harness that runs its
        tools itself: the ``pre_tool_use`` hook, approval (asked again when edited arguments are
        riskier), and admission. Returns the arguments to run, or why not to run it."""
        if not self._capabilities.get("nativeTools"):
            raise BridgeUsageError("KB203", f"{call.name} is the bridge's own tool, but the bridge does not declare nativeTools")
        base = self._tool_base(call)

        def risk_of(args: JsonObject) -> str:
            return call.risk(args) if callable(call.risk) else call.risk

        args = call.arguments
        if "pre_tool_use" in self._hooks():
            pre = self._ask("hook/invoke", {
                **base, "event": "pre_tool_use", "arguments": args,
                **({"inputSchema": call.input_schema} if call.input_schema else {}),
            })
            if pre.get("decision") == "deny":
                return Refused(str(pre.get("reason") or "denied"))
            if pre.get("decision") == "edit":
                args = pre["arguments"]
        approved = -1
        while approved < RISK_ORDER[risk_of(args)]:
            risk = risk_of(args)
            approval = self._ask("approval/request", {
                **base, "arguments": args, "risk": risk,
                **({"description": call.description} if call.description else {}),
            })
            if approval.get("decision") == "deny":
                return Refused(str(approval.get("reason") or "denied"))
            approved = RISK_ORDER[risk]
            if approval.get("decision") == "edit":
                args = approval["arguments"]
        if self._capabilities.get("governed"):
            self.admit("toolAttempt")
        return Allowed(args)

    def after_native_tool(
        self, call: NativeToolCall, args: JsonObject, *, result: Json = None, error: BaseException | None = None
    ) -> JsonObject:
        """The steps after a call of one of the bridge's own tools: ``post_tool_use`` or
        ``post_tool_use_failure``, then artifact admission. Returns what the model should read."""
        base = self._tool_base(call)
        hooks = self._hooks()
        if error is not None:
            message = str(error) or type(error).__name__
            if "post_tool_use_failure" in hooks:
                self._ask("hook/invoke", {
                    **base, "event": "post_tool_use_failure", "arguments": args,
                    "error": {"type": type(error).__name__, "message": message},
                })
            return {"ok": False, "error": message}
        if "post_tool_use" in hooks:
            self._ask("hook/invoke", {**base, "event": "post_tool_use", "arguments": args, "result": result})
        if self.params.get("admitResults"):
            result = self._ask("artifact/admit", {**base, "result": result})["result"]
        return {"ok": True, "result": result}

    def call_tool(self, call_id: str, name: str, arguments: JsonObject) -> JsonObject:
        """Calls one of Kedi's tools; Kedi applies the program's hooks, approval and budgets."""
        answer = self._ask("tool/call", {"runId": self.id, "callId": call_id, "name": name, "arguments": arguments})
        if answer.get("ok"):
            return {"ok": True, "result": answer.get("result")}
        return {"ok": False, "error": str(answer.get("error"))}

    def admit(self, dimension: Literal["request", "toolAttempt"]) -> None:
        """Asks Kedi to admit a step; raises ``StepDenied`` if it does not."""
        answer = self._ask("budget/admit", {"runId": self.id, "dimension": dimension})
        if not answer.get("admitted"):
            raise StepDenied(str(answer.get("reason") or f"{dimension} denied"))

    def media(self, ref: str) -> JsonObject:
        """The bytes of a conversation's media, by its ``ref``."""
        return self._ask("media/get", {"runId": self.id, "ref": ref})

    def report_usage(self, usage: JsonObject) -> None:
        """Reports one model request's token counts; ``model_request`` does this."""
        self._peer.notify("run/usage", {"runId": self.id, **usage})

    def event(self, type: str, **fields: Json) -> None:
        """A ``run/event``, with the ``events`` capability."""
        if self._capabilities.get("events"):
            self._peer.notify("run/event", {"runId": self.id, "type": type, **fields})

    # The connection's side.

    def input(self, items: list[JsonObject]) -> bool:
        """Queues ``run/input`` items; blocks until they are delivered or the run ends."""
        done: Future[bool] = Future()
        state = {"left": len(items), "delivered": True}
        lock = threading.Lock()

        def answer(value: bool) -> None:
            with lock:
                state["delivered"] = bool(state["delivered"]) and value
                state["left"] = int(state["left"]) - 1
                if state["left"] == 0 and not done.done():
                    done.set_result(bool(state["delivered"]))

        with self._lock:
            for item in items:
                self._queued.append(_PendingInput(str(item["id"]), str(item["text"]), answer))
        if not items:
            return True
        if self._on_arrival:
            self._hand()
        return done.result()

    def stop(self, kind: StopKind) -> None:
        with self._lock:
            if self.stopped.is_set():
                return
            self.stop_reason = RunStopped(kind)
            self.stopped.set()
        self._stop_future.set_result(None)

    def snapshot(self) -> JsonObject | None:
        return self._snapshot() if self._snapshot is not None else None

    def finish(self) -> None:
        with self._lock:
            left = self._queued + self._handed
            self._queued, self._handed = [], []
        for pending in left:
            pending.answer(False)
        self.stop("cancel")

    def _hand(self) -> None:
        """Hands queued input to the run's ``on_input`` handler."""
        with self._lock:
            if self._on_input is None or not self._queued:
                return
            handed, self._queued = self._queued, []
            self._handed.extend(handed)
        self._on_input([pending.text for pending in handed])

    def _confirm_carried(self, request: ModelRequest[Any]) -> None:
        """Answers delivered the handed input whose text the request carries."""
        if not self._handed:
            return
        carried = strings(request.describe())
        with self._lock:
            keep = []
            for pending in self._handed:
                if any(pending.text in text for text in carried):
                    pending.answer(True)
                else:
                    keep.append(pending)
            self._handed = keep

    def _test_reply(self, request: ModelRequest[Reply], model: str | None) -> Reply:
        params: JsonObject = {"runId": self.id, "model": model, **request.describe()}
        if request.purpose:
            params["purpose"] = request.purpose
        answer = self._ask("model/complete", params)
        return request.reply(answer["message"], answer.get("usage"))

    def _hooks(self) -> set[str]:
        return set(self.params.get("hooks") or [])

    def _tool_base(self, call: NativeToolCall) -> JsonObject:
        return {"runId": self.id, "callId": call.call_id, "tool": call.name, "origin": call.origin}

    def _ask(self, method: str, params: JsonObject) -> JsonObject:
        return self._race(self._peer.request(method, params))

    def _spawn(self, function: Callable[..., Any], *args: Any) -> Future[Any]:
        """Runs a blocking call in a thread, so a stop can end the wait for it."""
        future: Future[Any] = Future()

        def target() -> None:
            try:
                future.set_result(function(*args))
            except BaseException as error:  # noqa: BLE001 - carried to the waiter
                future.set_exception(error)

        threading.Thread(target=target, name=f"kedi-run-{self.id}", daemon=True).start()
        return future

    def _race(self, future: Future[Any]) -> Any:
        """Waits for ``future`` unless the run stops first: then raises the reason."""
        self._raise_if_stopped()
        wait([future, self._stop_future], return_when=FIRST_COMPLETED)
        # A stop wins over an answer that arrived with it: Kedi sends run/cancel or run/interrupt
        # before it answers the request the run was waiting on.
        self._raise_if_stopped()
        return future.result()

    def _raise_if_stopped(self) -> None:
        if self.stopped.is_set():
            raise self.stop_reason  # type: ignore[misc]


def strings(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [text for item in value for text in strings(item)]
    if isinstance(value, dict):
        return [text for item in value.values() for text in strings(item)]
    return []
