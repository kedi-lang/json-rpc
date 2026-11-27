"""OpenAI chat completions, as Hermes sends and reads them, and Kedi's transcript schema.

Test mode turns each request Hermes makes into a ``ModelCall`` for ``model/complete``, and Kedi's
reply into the chat completion Hermes parses, as JSON or as server-sent events.
"""

from __future__ import annotations

import json
import time
import uuid
from typing import Any

from kedi_bridge import JsonObject


def _text_of(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(part.get("text", "") for part in content if isinstance(part, dict) and part.get("type") == "text")
    return ""


def _user_parts(content: Any) -> list[JsonObject]:
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    parts: list[JsonObject] = []
    for part in content or []:
        if not isinstance(part, dict):
            continue
        if part.get("type") == "text":
            parts.append({"type": "text", "text": part.get("text", "")})
        elif part.get("type") == "image_url":
            url = (part.get("image_url") or {}).get("url", "")
            if url.startswith("data:") and ";base64," in url:
                media_type, data = url[5:].split(";base64,", 1)
                parts.append({"type": "media", "kind": "image", "mediaType": media_type, "data": data})
            else:
                parts.append({"type": "media", "kind": "image", "url": url})
    return parts


def _result(content: Any) -> Any:
    text = _text_of(content)
    try:
        return json.loads(text)
    except ValueError:
        return text


def model_call(body: JsonObject) -> JsonObject:
    """A chat completions request as Kedi's ``ModelCall``."""
    system: list[str] = []
    messages: list[JsonObject] = []
    for message in body.get("messages") or []:
        role = message.get("role")
        if role in ("system", "developer"):
            system.append(_text_of(message.get("content")))
        elif role == "user":
            messages.append({"role": "user", "parts": _user_parts(message.get("content"))})
        elif role == "assistant":
            parts: list[JsonObject] = []
            if message.get("reasoning"):
                parts.append({"type": "reasoning", "text": str(message["reasoning"])})
            text = _text_of(message.get("content"))
            if text:
                parts.append({"type": "text", "text": text})
            for call in message.get("tool_calls") or []:
                function = call.get("function") or {}
                try:
                    arguments = json.loads(function.get("arguments") or "{}")
                except ValueError:
                    arguments = function.get("arguments")
                parts.append({"type": "toolCall", "id": call.get("id", ""), "name": function.get("name", ""), "arguments": arguments})
            messages.append({"role": "assistant", "parts": parts})
        elif role == "tool":
            part = {"type": "toolResult", "id": message.get("tool_call_id", ""), "result": _result(message.get("content"))}
            if messages and messages[-1]["role"] == "tool":
                messages[-1]["parts"].append(part)
            else:
                messages.append({"role": "tool", "parts": [part]})
    tools = [
        {
            "name": (tool.get("function") or {}).get("name", ""),
            "description": (tool.get("function") or {}).get("description"),
            "inputSchema": (tool.get("function") or {}).get("parameters"),
        }
        for tool in body.get("tools") or []
        if tool.get("type") == "function"
    ]
    output = None
    response_format = body.get("response_format") or {}
    if response_format.get("type") == "json_schema":
        schema = response_format.get("json_schema") or {}
        output = {"schema": schema.get("schema") or {}, "toolName": schema.get("name") or "final_result"}
    return {"system": "\n\n".join(text for text in system if text) or None, "messages": messages, "tools": tools, "output": output}


def completion(message: JsonObject, usage: JsonObject | None, model: str) -> JsonObject:
    """Kedi's test-model message as a chat completion."""
    text = "".join(part.get("text", "") for part in message.get("parts") or [] if part.get("type") == "text")
    calls = [
        {
            "id": part.get("id") or f"call_{uuid.uuid4().hex[:12]}",
            "type": "function",
            "function": {"name": part["name"], "arguments": json.dumps(part.get("arguments") or {}, ensure_ascii=False)},
        }
        for part in message.get("parts") or []
        if part.get("type") == "toolCall"
    ]
    reply: JsonObject = {"role": "assistant", "content": text or None}
    if calls:
        reply["tool_calls"] = calls
    counts = usage or {}
    prompt = counts.get("inputTokens")
    completion_tokens = counts.get("outputTokens")
    total = counts.get("totalTokens")
    if total is None and prompt is not None and completion_tokens is not None:
        total = prompt + completion_tokens
    return {
        "id": f"chatcmpl-kedi-{uuid.uuid4().hex[:12]}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [{"index": 0, "message": reply, "finish_reason": "tool_calls" if calls else "stop"}],
        "usage": {"prompt_tokens": prompt or 0, "completion_tokens": completion_tokens or 0, "total_tokens": total or 0},
    }


def usage_of(completion_body: JsonObject) -> JsonObject:
    """A chat completion's counts in Kedi's ``Usage``; a count left out is unknown."""
    usage = completion_body.get("usage") or {}
    counts: JsonObject = {"requests": 1}
    for key, name in (("prompt_tokens", "inputTokens"), ("completion_tokens", "outputTokens"), ("total_tokens", "totalTokens")):
        if isinstance(usage.get(key), int):
            counts[name] = usage[key]
    cached = (usage.get("prompt_tokens_details") or {}).get("cached_tokens")
    if isinstance(cached, int):
        counts["cacheReadTokens"] = cached
    return counts


def event_stream(body: JsonObject) -> bytes:
    """A chat completion as the server-sent events of a streamed one."""
    choice = body["choices"][0]
    message = choice["message"]
    delta: JsonObject = {"role": "assistant"}
    if message.get("content"):
        delta["content"] = message["content"]
    if message.get("tool_calls"):
        delta["tool_calls"] = [dict(call, index=index) for index, call in enumerate(message["tool_calls"])]
    head = {"id": body["id"], "object": "chat.completion.chunk", "created": body["created"], "model": body["model"]}
    first = {**head, "choices": [{"index": 0, "delta": delta, "finish_reason": None}]}
    last = {**head, "choices": [{"index": 0, "delta": {}, "finish_reason": choice["finish_reason"]}], "usage": body["usage"]}
    return f"data: {json.dumps(first, ensure_ascii=False)}\n\ndata: {json.dumps(last, ensure_ascii=False)}\n\ndata: [DONE]\n\n".encode()
