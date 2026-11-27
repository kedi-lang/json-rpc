"""Small bridges for the SDK's tests: each answers with its model's text."""

from __future__ import annotations

from typing import Any

from kedi_bridge import JsonObject, ModelRequest, Run


def say(role: str, text: str) -> JsonObject:
    return {"role": role, "parts": [{"type": "text", "text": text}]}


def text_of(message: JsonObject) -> str:
    return "".join(part.get("text", "") for part in message["parts"] if part["type"] == "text")


def request(run: Run, messages: list[JsonObject]) -> ModelRequest[JsonObject]:
    """A request in Kedi's schema, answered by the test model."""
    return ModelRequest(
        send=lambda _model, _run: say("assistant", "real model"),
        describe=lambda: {"system": run.params.get("system"), "messages": messages, "tools": [], "output": None},
        reply=lambda message, _usage: message,
    )


class Minimal:
    """A bridge that converses through the SDK: model requests, Kedi's tools, continuations."""

    files: list[str] = []

    def __init__(self, capabilities: JsonObject, *, on_input: bool = False) -> None:
        self.handshake: JsonObject = {"backend": {"name": "minimal"}, "kind": "agent-framework", "capabilities": capabilities}
        self._on_input = on_input

    def run(self, run: Run) -> JsonObject:
        messages: list[JsonObject] = [say("user", run.params["user"])]
        continuation = run.params.get("continuation")
        if continuation:
            messages += [say("assistant", str(continuation["answer"].get("text"))), say("user", continuation["message"])]
        if self._on_input:
            run.on_input(lambda texts: messages.extend(say("user", text) for text in texts))
        while True:
            reply: Any = run.model_request(request(run, messages))
            messages.append(reply)
            calls = [part for part in reply["parts"] if part["type"] == "toolCall"]
            if not calls:
                return {"text": text_of(reply)}
            for call in calls:
                outcome = run.call_tool(call["id"], call["name"], call["arguments"])
                result = outcome["result"] if outcome["ok"] else outcome["error"]
                messages.append({"role": "tool", "parts": [{"type": "toolResult", "id": call["id"], "result": result}]})


class Bypassing:
    """A bridge that calls its model itself, around the SDK: nothing is admitted or scripted."""

    files: list[str] = []

    def __init__(self, capabilities: JsonObject) -> None:
        self.handshake: JsonObject = {"backend": {"name": "bypassing"}, "kind": "agent-framework", "capabilities": capabilities}

    def run(self, run: Run) -> JsonObject:
        return {"text": "real model"}
