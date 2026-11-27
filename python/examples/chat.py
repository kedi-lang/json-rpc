"""A bridge for OpenAI-compatible chat endpoints, written with the SDK.

    python examples/chat.py --base-url http://127.0.0.1:8080/v1   serve
    python examples/chat.py --check                              preflight only

It keeps the conversation in Kedi's transcript schema and converts it to chat messages only to
send a request, so test mode, history and sessions need no other conversion.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.request
from typing import Any

from kedi_bridge import JsonObject, ModelRequest, RpcError, Run, serve


def flag(name: str, default: str) -> str:
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


BASE_URL = flag("--base-url", "http://127.0.0.1:8080/v1")


def text(message: JsonObject) -> str:
    return "".join(part["text"] for part in message["parts"] if part["type"] == "text")


def chat_messages(system: str | None, messages: list[JsonObject]) -> list[JsonObject]:
    chat: list[JsonObject] = [{"role": "system", "content": system}] if system else []
    for message in messages:
        if message["role"] == "tool":
            for part in message["parts"]:
                if part["type"] == "toolResult":
                    chat.append({"role": "tool", "tool_call_id": part["id"], "content": json.dumps(part["result"])})
            continue
        calls = [
            {"id": part["id"], "type": "function", "function": {"name": part["name"], "arguments": json.dumps(part["arguments"])}}
            for part in message["parts"]
            if part["type"] == "toolCall"
        ]
        chat.append({"role": message["role"], "content": text(message), **({"tool_calls": calls} if calls else {})})
    return chat


def complete(call: JsonObject, model: str | None) -> JsonObject:
    body: JsonObject = {"model": model, "messages": chat_messages(call["system"], call["messages"])}
    if call["tools"]:
        body["tools"] = [
            {"type": "function", "function": {"name": tool["name"], "description": tool.get("description") or "", "parameters": tool.get("inputSchema") or {}}}
            for tool in call["tools"]
        ]
    if call["output"]:
        body["response_format"] = {"type": "json_schema", "json_schema": {"name": call["output"]["toolName"], "schema": call["output"]["schema"]}}
    headers = {"content-type": "application/json"}
    if os.environ.get("OPENAI_API_KEY"):
        headers["authorization"] = f"Bearer {os.environ['OPENAI_API_KEY']}"
    request = urllib.request.Request(f"{BASE_URL}/chat/completions", json.dumps(body).encode(), headers)
    with urllib.request.urlopen(request, timeout=600) as response:  # noqa: S310 - the configured endpoint
        answer = json.load(response)
    chosen = answer["choices"][0]["message"]
    parts: list[JsonObject] = []
    if chosen.get("content"):
        parts.append({"type": "text", "text": chosen["content"]})
    for tool in chosen.get("tool_calls") or []:
        parts.append({"type": "toolCall", "id": tool["id"], "name": tool["function"]["name"], "arguments": json.loads(tool["function"]["arguments"] or "{}")})
    reply: JsonObject = {"message": {"role": "assistant", "parts": parts}}
    if answer.get("usage"):
        usage = answer["usage"]
        reply["usage"] = {
            "inputTokens": usage.get("prompt_tokens"),
            "outputTokens": usage.get("completion_tokens"),
            "totalTokens": usage.get("total_tokens"),
        }
    return reply


class Chat:
    handshake: JsonObject = {
        "backend": {"name": "openai-chat-example", "version": "0.1.0"},
        "kind": "agent-framework",
        "capabilities": {
            "tools": True,
            "structuredOutput": True,
            "nativeStructuredOutput": True,
            "nativeToolCalling": True,
            "governed": True,
            "subagents": True,
            "liveInput": True,
            "interrupt": True,
            "usage": True,
            "modelFallback": True,
            "sessions": True,
            "transcript": True,
            "testModel": True,
        },
    }
    files: list[str] = []

    def run(self, run: Run) -> JsonObject:
        params = run.params
        transcript = isinstance(params.get("history"), list)
        state = (params.get("session") or {}).get("state") or {}
        messages: list[JsonObject] = list(params["history"]) if transcript else list(state.get("messages") or [])
        turn_start = len(messages)
        user_parts = []
        for part in params.get("userContent") or [{"type": "text", "text": params["user"]}]:
            if part["type"] == "text":
                user_parts.append(part)
            else:
                source = {"data": part["data"]} if "data" in part else {"url": part["url"]}
                user_parts.append({"type": "media", "kind": part["kind"], "mediaType": part.get("mediaType"), **source})
        messages.append({"role": "user", "parts": user_parts})
        if params.get("continuation"):
            rejected = params["continuation"]["answer"]
            said = rejected["text"] if isinstance(rejected.get("text"), str) else json.dumps(rejected.get("data", rejected))
            messages.append({"role": "assistant", "parts": [{"type": "text", "text": said}]})
            messages.append({"role": "user", "parts": [{"type": "text", "text": params["continuation"]["message"]}]})

        def back() -> JsonObject:
            if params.get("processHistory"):
                return {"transcript": messages}
            if transcript:
                return {"messages": messages[turn_start:]}
            return {"state": {"messages": messages}}

        def take_input(texts: list[str]) -> None:
            messages.extend({"role": "user", "parts": [{"type": "text", "text": said}]} for said in texts)

        run.on_input(take_input)
        run.on_interrupt(back)
        output = params.get("output") or {}
        output = {"schema": output["schema"], "toolName": output["toolName"]} if output.get("schema") and output.get("toolName") else None

        def describe() -> JsonObject:
            return {
                "system": params.get("system"),
                "messages": messages,
                "tools": [{"name": tool["name"], "description": tool.get("description"), "inputSchema": tool.get("inputSchema")} for tool in params.get("tools") or []],
                "output": output,
            }

        class History:
            def get(self) -> list[JsonObject]:
                return messages

            def set(self, kept: list[JsonObject]) -> None:
                messages[:] = kept

        request: ModelRequest[JsonObject] = ModelRequest(
            send=lambda model, _run: complete(describe(), model),
            describe=describe,
            reply=lambda message, _usage: {"message": message},
            usage=lambda reply: reply.get("usage"),
            history=History(),
        )
        while True:
            message: Any = run.model_request(request)["message"]
            messages.append(message)
            calls = [part for part in message["parts"] if part["type"] == "toolCall"]
            if not calls:
                said = text(message)
                if not output:
                    return {"text": said, **back()}
                try:
                    return {"data": json.loads(said), **back()}
                except ValueError:
                    raise RpcError(-32002, f"the model's answer is not JSON: {said[:200]}") from None
            results = []
            for call in calls:
                outcome = run.call_tool(call["id"], call["name"], call["arguments"])
                result = outcome["result"] if outcome["ok"] else outcome["error"]
                results.append({"type": "toolResult", "id": call["id"], "result": result, **({} if outcome["ok"] else {"isError": True})})
            messages.append({"role": "tool", "parts": results})


if __name__ == "__main__":
    raise SystemExit(serve(Chat()))
