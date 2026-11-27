"""The preflight: the handshake's checks, then the conformance fixtures run in-process against
the bridge in test mode. A result is cached under the bridge's fingerprint."""

from __future__ import annotations

import copy
import hashlib
import json
import os
import threading
from concurrent.futures import Future, TimeoutError as FutureTimeout
from dataclasses import dataclass, field
from importlib import resources
from pathlib import Path
from typing import Any

from .connection import Bridge, connect
from .diagnostics import Diagnostic, docs
from .handshake import check_handshake
from .peer import JsonObject, Peer, RpcError
from .version import SDK_VERSION

FIXTURE_TIMEOUT = 10.0
SDK_SOURCES = Path(__file__).resolve().parent

RUN_DEFAULTS: JsonObject = {
    "callKind": "invoke",
    "promptKind": "raw",
    "model": "test",
    "fallbackModels": [],
    "settings": {},
    "effort": None,
    "system": "You are being tested.",
    "instructionParts": [],
    "userContent": None,
    "output": None,
    "tools": [],
    "continuation": None,
    "session": None,
    "subagent": None,
    "hooks": [],
    "mcpServers": [],
    "admitResults": False,
}


@dataclass
class PreflightReport:
    diagnostics: list[Diagnostic] = field(default_factory=list)
    passed: list[str] = field(default_factory=list)
    skipped: list[tuple[str, str]] = field(default_factory=list)
    cached: bool = False
    """Whether this report was replayed from the cache rather than checked now."""

    @property
    def errors(self) -> list[Diagnostic]:
        return [diagnostic for diagnostic in self.diagnostics if diagnostic.severity == "error"]

    def to_json(self) -> JsonObject:
        return {
            "diagnostics": [diagnostic.to_json() for diagnostic in self.diagnostics],
            "passed": self.passed,
            "skipped": [list(skip) for skip in self.skipped],
        }

    @classmethod
    def from_json(cls, stored: JsonObject) -> PreflightReport:
        return cls(
            [Diagnostic(**diagnostic) for diagnostic in stored["diagnostics"]],
            list(stored["passed"]),
            [(name, reason) for name, reason in stored["skipped"]],
            cached=True,
        )


def load_fixtures(directory: str | Path | None = None) -> list[JsonObject]:
    """The conformance fixtures: the SDK's embedded copy of fixtures/v1, or those in ``directory``."""
    if directory is None:
        root = resources.files("kedi_bridge") / "fixtures" / "v1"
        names = sorted(entry.name for entry in root.iterdir() if entry.name.endswith(".json"))
        return [json.loads((root / name).read_text("utf-8")) for name in names]
    path = Path(directory)
    return [json.loads(file.read_text("utf-8")) for file in sorted(path.glob("*.json"))]


def preflight(bridge: Bridge, fixtures: list[JsonObject] | None = None) -> PreflightReport:
    """Checks ``bridge`` now: its handshake, then every fixture it declares the capabilities for."""
    fixtures = load_fixtures() if fixtures is None else fixtures
    report = PreflightReport(check_handshake(bridge.handshake))
    if report.errors:
        return report
    handshake = bridge.handshake
    # Capabilities, and what the handshake declares beside them: compaction, with a threshold,
    # and a code mode of the backend's own.
    declared = {
        **(handshake.get("capabilities") or {}),
        "compaction": handshake.get("compaction") is not None,
        "compactionThreshold": (handshake.get("compaction") or {}).get("threshold") is True,
        "codemode": handshake.get("codemode") is not None,
    }
    if not declared.get("testModel"):
        report.diagnostics.append(Diagnostic(
            "KB090", "warning", "the bridge has no test model, so its capabilities were not exercised",
            [f"{len(fixtures)} conformance fixtures need testModel to run without a model endpoint"],
            "declare testModel and send model requests through run.model_request", docs("10-test-model"),
        ))
        return report
    for fixture in fixtures:
        missing = [name for name in fixture.get("capabilities") or [] if not declared.get(name)]
        if missing:
            report.skipped.append((fixture["name"], f"needs {', '.join(missing)}"))
            continue
        problems = _run_fixture(bridge, fixture)
        if not problems:
            report.passed.append(fixture["name"])
            continue
        report.diagnostics.append(Diagnostic(
            fixture["code"], "error", fixture["failure"],
            [f"fixture {fixture['name']}: {fixture['description']}", *problems],
            fixture["help"], docs(fixture["spec"]),
        ))
    return report


def cached_preflight(bridge: Bridge, entry: str, cache_directory: Path | None = None) -> PreflightReport:
    """The preflight, replayed from the cache when the bridge, the SDK and the fixtures are unchanged."""
    directory = cache_directory or cache_dir()
    file = directory / f"{fingerprint(bridge, entry)}.json"
    try:
        return PreflightReport.from_json(json.loads(file.read_text("utf-8")))
    except (OSError, ValueError, KeyError, TypeError):
        pass  # Not checked yet.
    report = preflight(bridge)
    try:
        directory.mkdir(parents=True, exist_ok=True)
        temporary = file.with_suffix(f".{os.getpid()}.tmp")
        temporary.write_text(json.dumps(report.to_json()), "utf-8")
        temporary.replace(file)
    except OSError:
        pass  # A read-only cache only means checking again next time.
    return report


def cache_dir() -> Path:
    if os.environ.get("KEDI_BRIDGE_CACHE"):
        return Path(os.environ["KEDI_BRIDGE_CACHE"])
    base = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache")
    return base / "kedi" / "bridge-checks"


SKIPPED_DIRECTORIES = frozenset({"__pycache__", ".git", ".venv", "venv", "dist", "build", "node_modules"})


def fingerprint(bridge: Bridge, entry: str) -> str:
    """What the preflight's result depends on: the SDK (its version and sources), the fixtures,
    the handshake, the bridge's entry and the files it declares. When the entry's directory holds
    a ``pyproject.toml``, the bridge's package (its files and lockfile) counts too."""
    digest = hashlib.sha256()
    digest.update(f"sdk {SDK_VERSION}\n".encode())
    digest.update(f"fixtures {json.dumps(load_fixtures(), sort_keys=True)}\n".encode())
    digest.update(f"handshake {json.dumps(bridge.handshake, sort_keys=True)}\n".encode())
    entry_path = Path(entry).resolve()
    files = {entry_path, *_walk(SDK_SOURCES)}
    root = entry_path.parent
    # Never above the entry's directory: an installed bridge may sit below a home directory.
    if (root / "pyproject.toml").exists():
        files.update(_walk(root))
    for file in sorted(files):
        digest.update(f"{file}\n".encode())
        digest.update(file.read_bytes() if file.exists() else b"missing")
    # A declared file that is missing counts as missing: it breaks the bridge as a changed one does.
    for name in getattr(bridge, "files", None) or []:
        declared = (root / name).resolve()
        digest.update(f"declared {name}\n".encode())
        digest.update(declared.read_bytes() if declared.exists() else b"missing")
    return digest.hexdigest()[:32]


def _walk(directory: Path) -> list[Path]:
    found = []
    for path in sorted(directory.iterdir()):
        if path.name in SKIPPED_DIRECTORIES or path.name.startswith("."):
            continue
        if path.is_dir():
            found.extend(_walk(path))
        elif path.suffix != ".pyc":
            found.append(path.resolve())
    return found


def _pipe() -> tuple[int, Any]:
    read, write = os.pipe()
    stream = os.fdopen(write, "wb", buffering=0)
    return read, stream


def _run_fixture(bridge: Bridge, fixture: JsonObject) -> list[str]:
    """Runs one fixture against a fresh connection to ``bridge``; what did not hold, described."""
    to_bridge_read, to_bridge = _pipe()
    from_bridge_read, from_bridge = _pipe()
    connection = connect(bridge, to_bridge_read, from_bridge.write)
    kedi = Peer(from_bridge_read, to_bridge.write)
    sent: list[str] = []
    seen: list[JsonObject] = []
    events: list[JsonObject] = []
    answers: list[Future[tuple[str, JsonObject]]] = []
    script = list(copy.deepcopy(fixture.get("model") or []))
    summaries = list(copy.deepcopy(fixture.get("summaries") or []))
    summarized: list[JsonObject] = []
    budget = dict(fixture.get("budget") or {})
    lock = threading.Lock()
    admitted = {"requests": 0}

    def observe(message: JsonObject) -> None:
        if isinstance(message.get("method"), str):
            sent.append(message["method"])
        if message.get("method") == "run/event":
            events.append(message.get("params") or {})

    def complete(params: JsonObject) -> JsonObject:
        if params.get("purpose") == "compaction":
            with lock:
                summarized.append(params)
                reply = summaries.pop(0) if summaries else {"parts": [{"type": "text", "text": "A summary."}]}
            usage = reply.pop("usage", None)
            return {"message": {"role": "assistant", **reply}, **({"usage": usage} if usage else {})}
        with lock:
            seen.append(params)
            count = len(seen)
        for action in (fixture.get("onModelRequest") or {}).get(str(count), []):
            action = dict(action)
            method = action.pop("send")
            message = {"runId": "run-1", **action}
            if method == "run/input":
                answers.append(_settle(method, kedi.request(method, message)))
            else:
                kedi.notify(method, message)
        if str(params.get("model")) in (fixture.get("failModels") or []):
            raise RpcError(-32002, f"model {params.get('model')} is down")
        with lock:
            reply = script.pop(0) if script else {"parts": [{"type": "text", "text": "done"}]}
        usage = reply.pop("usage", None)
        return {"message": {"role": "assistant", **reply}, **({"usage": usage} if usage else {})}

    def admit(params: JsonObject) -> JsonObject:
        dimension = str(params.get("dimension"))
        with lock:
            left = budget.get(dimension)
            if left is not None and left <= 0:
                threading.Timer(0, kedi.notify, ("run/cancel", {"runId": "run-1"})).start()
                return {"admitted": False, "dimension": dimension, "reason": "budget exhausted"}
            if left is not None:
                budget[dimension] = left - 1
            if dimension == "request":
                admitted["requests"] += 1
        return {"admitted": True}

    def process(params: JsonObject) -> JsonObject:
        keep = (fixture.get("historyProcess") or {}).get("keepLast")
        messages = params.get("messages") or []
        return {"messages": messages[-keep:] if keep else messages}

    def tool_call(params: JsonObject) -> JsonObject:
        tool = (fixture.get("tools") or {}).get(str(params.get("name")), {"error": "unknown tool"})
        return {"ok": True, "result": tool["result"]} if "result" in tool else {"ok": False, "error": str(tool.get("error"))}

    kedi.on_message(observe)
    kedi.on_request("model/complete", complete)
    kedi.on_request("budget/admit", admit)
    kedi.on_request("history/process", process)
    kedi.on_request("tool/call", tool_call)
    kedi.start()

    problems: list[str] = []
    try:
        _within(kedi.request("initialize", {"protocolVersion": 1, "client": {"name": "kedi-bridge-preflight"}, "testModel": True}), "initialize")
        params = {**RUN_DEFAULTS, "user": "Hello.", **copy.deepcopy(fixture.get("run") or {}), "runId": "run-1"}
        method, answer = _within(_settle("run", kedi.request("run", params)), "the run")
        replies = [_within(reply, "run/input") for reply in answers]
        expect = fixture.get("expect") or {}
        problems += _expectations(expect, answer, seen, sent, replies, events)
        if expect.get("compacted"):
            if not summarized:
                problems.append("no summary request (model/complete with purpose compaction) reached Kedi")
            governed = (bridge.handshake.get("capabilities") or {}).get("governed") is True
            if governed and admitted["requests"] != len(seen) + len(summarized):
                problems.append(
                    f"{admitted['requests']} requests admitted, for {len(seen)} turn and {len(summarized)} "
                    "summary requests: each needs budget/admit"
                )
            for summary in fixture.get("summaries") or []:
                said = json.dumps(summary.get("parts"))
                if any(isinstance(event.get("text"), str) and event["text"] and event["text"] in said for event in events):
                    problems.append("a run/event reported the summary request's text: a summary is no turn of the run")
    except Exception as error:  # noqa: BLE001 - what went wrong is the finding
        problems.append(str(error) or type(error).__name__)
    finally:
        kedi.close()
        connection.peer.close()
        for stream in (to_bridge, from_bridge):
            try:
                stream.close()
            except OSError:
                pass
        for descriptor in (to_bridge_read, from_bridge_read):
            try:
                os.close(descriptor)
            except OSError:
                pass
    return problems


def _settle(method: str, request: Future[JsonObject]) -> Future[tuple[str, JsonObject]]:
    settled: Future[tuple[str, JsonObject]] = Future()

    def done(future: Future[JsonObject]) -> None:
        error = future.exception()
        if error is None:
            settled.set_result((method, {"result": future.result()}))
        elif isinstance(error, RpcError):
            settled.set_result((method, {"error": {"code": error.code, "message": error.message, "data": error.data}}))
        else:
            settled.set_exception(error)

    request.add_done_callback(done)
    return settled


def _within(future: Future[Any], what: str) -> Any:
    try:
        return future.result(timeout=FIXTURE_TIMEOUT)
    except FutureTimeout:
        raise TimeoutError(f"{what} did not answer within {FIXTURE_TIMEOUT:g}s") from None


def _expectations(
    expect: JsonObject,
    answer: JsonObject,
    seen: list[JsonObject],
    sent: list[str],
    replies: list[tuple[str, JsonObject]],
    events: list[JsonObject],
) -> list[str]:
    found: list[str] = []
    error = answer.get("error")
    result = answer.get("result")
    shown = f"an error, {error['code']}: {error['message']}" if error else json.dumps(result)
    if "result" in expect and not _contains(result, expect["result"]):
        found.append(f"the run answered {shown}, expected {json.dumps(expect['result'])}")
    if "error" in expect and not _contains(error, expect["error"]):
        found.append(f"the run answered {shown}, expected the error {json.dumps(expect['error'])}")
    if expect.get("failed") and not error:
        found.append(f"the run answered {shown}, expected it to fail")
    for key in expect.get("errorDataKeys") or []:
        data = (error or {}).get("data")
        if not isinstance(data, dict) or key not in data:
            found.append(f"the run's error data has no {key}")
    for key in expect.get("resultKeys") or []:
        if not isinstance(result, dict) or key not in result:
            found.append(f"the run's result has no {key}")
    for wanted in expect.get("answers") or []:
        held = any(method == wanted["method"] and _contains(reply.get("result"), wanted["result"]) for method, reply in replies)
        if not held:
            found.append(f"no {wanted['method']} answer held {json.dumps(wanted['result'])}")
    if "modelRequests" in expect and len(seen) != expect["modelRequests"]:
        found.append(f"the bridge sent {len(seen)} model requests, expected {expect['modelRequests']}")
    for check in expect.get("modelSaw") or []:
        request = seen[check["request"] - 1] if len(seen) >= check["request"] else None
        if not any(check["contains"] in text for text in _strings(request)):
            found.append(f"model request {check['request']} did not carry {json.dumps(check['contains'])}")
    for check in expect.get("modelMissed") or []:
        request = seen[check["request"] - 1] if len(seen) >= check["request"] else None
        if any(check["contains"] in text for text in _strings(request)):
            found.append(f"model request {check['request']} carried {json.dumps(check['contains'])}")
    for check in expect.get("modelTools") or []:
        request = seen[check["request"] - 1] if len(seen) >= check["request"] else {}
        names = [tool.get("name") for tool in request.get("tools") or []]
        if len(names) < check.get("atLeast", 0):
            found.append(f"model request {check['request']} offered {len(names)} tools, expected at least {check['atLeast']}")
        for name in check.get("excludes") or []:
            if name in names:
                found.append(f"model request {check['request']} offered {json.dumps(name)} as a tool of its own")
    for wanted in expect.get("events") or []:
        if not any(_contains(event, wanted) for event in events):
            found.append(f"no run/event held {json.dumps(wanted)}; the bridge sent {json.dumps(events)}")
    order = expect.get("order")
    if order:
        position = 0
        for method in sent:
            if position < len(order) and method == order[position]:
                position += 1
        if position < len(order):
            found.append(f"the bridge's requests {json.dumps(sent)} do not follow {json.dumps(order)}")
    for counted in expect.get("count") or []:
        times = sum(1 for method in sent if method == counted["method"])
        if times != counted["times"]:
            found.append(f"the bridge sent {counted['method']} {times} times, expected {counted['times']}")
    return found


def _strings(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [text for item in value for text in _strings(item)]
    if isinstance(value, dict):
        return [text for item in value.values() for text in _strings(item)]
    return []


def _contains(actual: Any, expected: Any) -> bool:
    if isinstance(expected, dict):
        if not isinstance(actual, dict):
            return False
        return all(key in actual and _contains(actual[key], value) for key, value in expected.items())
    return json.dumps(actual, sort_keys=True) == json.dumps(expected, sort_keys=True)
