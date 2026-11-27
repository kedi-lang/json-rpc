"""The Kedi bridge for Hermes Agent (Nous Research).

    python bridge.py           serve on stdio
    python bridge.py --check   preflight only

Kedi's ``> model:`` names a Hermes provider and model as ``provider/model`` (``gemini/gemini-3.5-
flash-lite``, ``openrouter/...``). Hermes resolves the provider's credentials from its environment
variables, as it does for its own sessions.
"""

from __future__ import annotations

import json
import threading
import uuid
from typing import Any
from urllib.parse import urlparse

from kedi_bridge import ErrorCode, JsonObject, RpcError, Run, claim_stdout, serve

claim_stdout()  # Hermes prints progress to stdout; frames only from here on.

import home  # noqa: E402

home.prepare()

from gate import CURRENT_RUN, Gate  # noqa: E402
from hermes_cli.runtime_provider import resolve_runtime_provider  # noqa: E402
from run_agent import AIAgent  # noqa: E402
from tools.registry import registry, session_tool_scope  # noqa: E402

try:
    from importlib.metadata import version as _version

    HERMES_VERSION = _version("hermes-agent")
except Exception:  # noqa: BLE001 - a source checkout has no real version
    HERMES_VERSION = "unknown"

VERSION = "0.1.0"
GATE = Gate()
GATE.install()


def _model(run: Run) -> JsonObject:
    """Where the run's requests go: Kedi's test model, or a Hermes provider and its credentials."""
    name = run.params.get("model")
    if run.test_mode:
        return {"provider": "custom", "model": name or "kedi-test", "base_url": home.TEST_BASE_URL, "api_key": "kedi-test-mode", "api_mode": "chat_completions"}
    if not name or "/" not in name:
        raise RpcError(ErrorCode.RUN_FAILED, f"Hermes needs a model named provider/model, such as gemini/gemini-3.5-flash-lite; got {json.dumps(name)}")
    provider, model = name.split("/", 1)
    try:
        runtime = resolve_runtime_provider(requested=provider, target_model=model)
    except Exception as error:  # noqa: BLE001 - Hermes says what is missing
        raise RpcError(ErrorCode.RUN_FAILED, f"Hermes cannot use provider {provider!r}: {error}") from error
    return {"provider": runtime.get("provider") or provider, "model": model, "base_url": runtime.get("base_url"),
            "api_key": runtime.get("api_key"), "api_mode": runtime.get("api_mode")}


def _register_tools(run: Run, scope: str) -> list[str]:
    """Kedi's tools, as Kedi rendered them, in a tool scope of the run's own."""
    names = []
    for tool in run.params.get("tools") or []:
        name = tool["name"]

        def handler(args: JsonObject, *, _name: str = name, **_context: Any) -> str:
            outcome = run.call_tool(f"call-{uuid.uuid4().hex[:12]}", _name, args)
            value = outcome["result"] if outcome["ok"] else {"error": outcome["error"]}
            return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)

        schema = {"name": name, "description": tool.get("description") or "", "parameters": tool.get("inputSchema") or {"type": "object", "properties": {}}}
        registry.register(name=name, toolset=scope, scope=scope, schema=schema, handler=handler)
        names.append(name)
    return names


def _history(run: Run) -> tuple[list[JsonObject], str]:
    """The conversation before this turn, in Hermes's messages, and the user text that starts it."""
    params = run.params
    state = (params.get("session") or {}).get("state") or {}
    messages: list[JsonObject] = list(state.get("messages") or [])
    user = params["user"]
    continuation = params.get("continuation")
    if continuation:
        rejected = continuation["answer"]
        said = rejected["text"] if isinstance(rejected.get("text"), str) else json.dumps(rejected.get("data", rejected), ensure_ascii=False)
        messages += [{"role": "user", "content": user}, {"role": "assistant", "content": said}]
        user = continuation["message"]
    return messages, user


class Hermes:
    handshake: JsonObject = {
        "backend": {"name": "hermes-agent", "version": HERMES_VERSION},
        "kind": "agent-harness",
        "capabilities": {
            "tools": True,
            "nativeToolCalling": True,
            "structuredOutput": True,
            "governed": True,
            "subagents": True,
            "liveInput": True,
            "interrupt": True,
            "sessions": True,
            "testModel": True,
        },
    }
    files: list[str] = ["convert.py", "gate.py", "home.py"]

    def run(self, run: Run) -> JsonObject:
        route = _model(run)
        scope = f"kedi-run-{run.id}"
        gated = GATE.open(run, urlparse(route["base_url"] or "").hostname)
        token = CURRENT_RUN.set(run.id)
        tools: list[str] = []
        try:
            with session_tool_scope(scope):
                tools = _register_tools(run, scope)
                agent = AIAgent(
                    base_url=route["base_url"], api_key=route["api_key"], provider=route["provider"], model=route["model"],
                    api_mode=route["api_mode"], quiet_mode=True, skip_context_files=True, skip_memory=True,
                    platform="kedi", enabled_toolsets=[scope] if tools else [], save_trajectories=False,
                )
                finished = threading.Event()
                threading.Thread(target=_stop_on_signal, args=(run, agent, finished), daemon=True).start()
                history, user = _history(run)
                so_far: list[JsonObject] = [*history, {"role": "user", "content": user}]
                # Live input joins the turn as Hermes's steering: a user row after the current tool batch.
                run.on_input(lambda texts: [agent.steer(text) for text in texts], on="arrival")
                run.on_interrupt(lambda: {"state": {"messages": _conversation(getattr(agent, "_session_messages", None) or so_far)}})
                try:
                    result = agent.run_conversation(user, system_message=run.params.get("system"), conversation_history=history, task_id=run.id)
                finally:
                    finished.set()
        finally:
            CURRENT_RUN.reset(token)
            GATE.close(run.id)
            for name in tools:
                registry.deregister(name, scope=scope)
        if run.stop_reason is not None:
            raise run.stop_reason
        if gated.failure is not None:
            raise gated.failure
        if result.get("failed") or result.get("error"):
            message = str(result.get("error") or "Hermes failed the turn")
            raise RpcError(ErrorCode.RUN_FAILED, message, {"harness": {"type": "HermesTurnError", "message": message}})
        return _answer(run, result)


def _stop_on_signal(run: Run, agent: Any, finished: threading.Event) -> None:
    """Interrupts the agent when Kedi cancels or interrupts the run while it works."""
    while not finished.wait(0.05):
        if run.stopped.is_set():
            agent.interrupt(hard_cancel=True)
            return


def _answer(run: Run, result: JsonObject) -> JsonObject:
    said = str(result.get("final_response") or "")
    answer: JsonObject
    output = run.params.get("output") or {}
    if output.get("schema") and not output.get("media"):
        try:
            answer = {"data": json.loads(_unfenced(said))}
        except ValueError as error:
            answer = {"invalid": said, "error": f"not JSON: {error}"}
    else:
        answer = {"text": said}
    if run.params.get("session") is not None:
        answer["state"] = {"messages": _conversation(result.get("messages") or [])}
    counts = {"requests": result.get("api_calls"), "inputTokens": result.get("input_tokens"), "outputTokens": result.get("output_tokens"), "totalTokens": result.get("total_tokens")}
    answer["usage"] = {key: value for key, value in counts.items() if isinstance(value, int)}
    return answer


def _conversation(messages: list[JsonObject]) -> list[JsonObject]:
    """Hermes's messages as the session's state: the system prompt is rebuilt each turn."""
    return [message for message in messages if message.get("role") != "system"]


def _unfenced(text: str) -> str:
    stripped = text.strip()
    if stripped.startswith("```") and stripped.endswith("```"):
        stripped = stripped.split("\n", 1)[1] if "\n" in stripped else ""
        stripped = stripped.rsplit("```", 1)[0]
    return stripped.strip()


if __name__ == "__main__":
    raise SystemExit(serve(Hermes()))
