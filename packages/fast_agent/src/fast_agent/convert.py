"""fast-agent's messages and Kedi's transcript schema.

A message Kedi did not change comes back as fast-agent wrote it: ``providerData`` holds
fast-agent's own dump of it (reasoning, channels, timing). A changed one, or one fast-agent
never saw, is built from its parts; media named by ``ref`` come from Kedi (``media/get``).
"""

from __future__ import annotations

import json
import uuid
from typing import Any

from fast_agent.types import PromptMessageExtended
from fast_agent.types.llm_stop_reason import LlmStopReason
from kedi_bridge import ErrorCode, JsonObject, RpcError, Run
from mcp import CallToolRequest, Tool
from mcp_types import CallToolRequestParams, CallToolResult, ImageContent, TextContent


def kedi_messages(message: PromptMessageExtended, *, provider_data: bool = True) -> list[JsonObject]:
    """One fast-agent message in Kedi's schema: a tool-result turn is a tool message, and text
    beside its results (live input) a user message after it."""
    converted: list[JsonObject] = []
    if message.tool_results:
        converted.append({"role": "tool", "parts": [
            {"type": "toolResult", "id": call_id, "result": result_value(result), **({"isError": True} if result.is_error else {})}
            for call_id, result in message.tool_results.items()
        ]})
    parts: list[JsonObject] = []
    for content in message.content or []:
        if isinstance(content, TextContent) and content.text:
            parts.append({"type": "text", "text": content.text})
        elif isinstance(content, ImageContent):
            parts.append({"type": "media", "kind": "image", "mediaType": content.mime_type, "data": content.data})
    if message.role == "assistant":
        parts += [
            {"type": "toolCall", "id": call_id, "name": request.params.name, "arguments": request.params.arguments or {}}
            for call_id, request in (message.tool_calls or {}).items()
        ]
    if parts or not converted:
        converted.append({"role": "assistant" if message.role == "assistant" else "user", "parts": parts})
    if provider_data and len(converted) == 1:
        converted[0]["providerData"] = message.model_dump(mode="json", exclude_none=True)
    return converted


def fast_messages(transcript: list[JsonObject], run: Run) -> list[PromptMessageExtended]:
    """Kedi's transcript as fast-agent's messages."""
    messages = []
    for message in transcript:
        given = message.get("providerData")
        if isinstance(given, dict):
            restored = PromptMessageExtended.model_validate(given)
            own = kedi_messages(restored, provider_data=False)
            if len(own) == 1 and own[0]["role"] == message["role"] and own[0]["parts"] == message["parts"]:
                messages.append(restored)
                continue
        messages.append(fast_message(message, run))
    return messages


def fast_message(message: JsonObject, run: Run) -> PromptMessageExtended:
    parts = message.get("parts") or []
    if message["role"] == "tool":
        return PromptMessageExtended(role="user", content=[], tool_results={
            part["id"]: CallToolResult(content=[TextContent(type="text", text=text(part.get("result")))], isError=bool(part.get("isError")))
            for part in parts if part.get("type") == "toolResult"
        })
    content: list[Any] = []
    calls: dict[str, CallToolRequest] = {}
    for part in parts:
        if part.get("type") == "text":
            content.append(TextContent(type="text", text=part["text"]))
        elif part.get("type") == "media":
            content.append(image(part, run))
        elif part.get("type") == "toolCall":
            calls[part.get("id") or f"call_{uuid.uuid4().hex[:12]}"] = CallToolRequest(
                method="tools/call", params=CallToolRequestParams(name=part["name"], arguments=part.get("arguments") or {})
            )
    if message["role"] == "assistant":
        return PromptMessageExtended(
            role="assistant", content=content, tool_calls=calls or None,
            stop_reason=LlmStopReason.TOOL_USE if calls else LlmStopReason.END_TURN,
        )
    return PromptMessageExtended(role="user", content=content)


def image(part: JsonObject, run: Run) -> ImageContent:
    """A media part as an image: inline, or by ``ref`` from Kedi."""
    media = run.media(part["ref"]) if "ref" in part and "data" not in part else part
    if media.get("kind", "image") != "image":
        raise RpcError(ErrorCode.UNSUPPORTED, f"fast-agent takes images; got {media.get('kind')}")
    if "data" not in media:
        raise RpcError(ErrorCode.UNSUPPORTED, "fast-agent takes images inline; got a URL")
    return ImageContent(type="image", data=media["data"], mimeType=media.get("mediaType") or "image/png")


def user_message(run: Run) -> PromptMessageExtended:
    """The run's user turn, with its media where Kedi put them."""
    parts = run.params.get("userContent")
    if not parts:
        return PromptMessageExtended(role="user", content=[TextContent(type="text", text=run.params["user"])])
    return PromptMessageExtended(role="user", content=[
        TextContent(type="text", text=part["text"]) if part["type"] == "text" else image(part, run) for part in parts
    ])


def kedi_turn(params: JsonObject) -> JsonObject:
    """The run's user turn in Kedi's transcript: its media named as Kedi named them."""
    parts = params.get("userContent")
    if not parts:
        return {"role": "user", "parts": [{"type": "text", "text": params["user"]}]}
    return {"role": "user", "parts": [
        {"type": "text", "text": part["text"]} if part["type"] == "text" else {"type": "media", "ref": part["name"]} for part in parts
    ]}


def model_call(run: Run, system: str | None, messages: list[PromptMessageExtended], tools: list[Tool] | None) -> JsonObject:
    """A request in Kedi's ``ModelCall``, for ``model/complete``: what fast-agent sends."""
    output = run.params.get("output") or {}
    return {
        "system": system or None,
        "messages": [converted for message in messages for converted in kedi_messages(message, provider_data=False)],
        "tools": [{"name": tool.name, "description": tool.description, "inputSchema": tool.input_schema} for tool in tools or []],
        "output": {"schema": output["schema"], "toolName": output.get("toolName") or "final_result"}
        if output.get("schema") and not output.get("media") else None,
    }


def result_value(result: CallToolResult) -> Any:
    text = "".join(getattr(part, "text", "") for part in result.content or [])
    try:
        return json.loads(text)
    except ValueError:
        return text


def text(value: Any) -> str:
    return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
