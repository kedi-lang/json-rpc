"""The Kedi bridge for fast-agent (https://fast-agent.ai).

    python bridge.py           serve on stdio
    python bridge.py --check   preflight only

Kedi runs a program's turns on a fast-agent agent:
- every model request fast-agent makes goes through ``Run.model_request``: Kedi admits it, hands
  it live input and processed history, and in test mode answers it with its test model. They
  all pass ``FastAgentLLM._execute_with_retry`` with the conversation in fast-agent's own
  messages, whichever provider and HTTP client they use;
- Kedi owns retries: fast-agent's own, the SDKs' and the "ask once more" after an empty reply
  are off, so every request Kedi admits is one request;
- Kedi's tools are the agent's tools, called back through ``tool/call``, and the model sees no
  other tool.

``> model:`` names a fast-agent provider and model as ``provider/model``, as everywhere in Kedi:
``google/gemini-3.1-flash-lite-preview``. Credentials come from the providers' environment
variables.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import json
import os
import sys
import tempfile
import threading
import uuid
from collections.abc import Awaitable, Callable
from concurrent.futures import Future
from contextvars import ContextVar
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from kedi_bridge import (
    ErrorCode,
    JsonObject,
    ModelRequest,
    NativeToolCall,
    Refused,
    RpcError,
    Run,
    claim_stdout,
    serve,
)

claim_stdout()  # fast-agent prints through rich; frames keep stdout to themselves

import aiohttp  # noqa: E402
import anthropic  # noqa: E402
import convert  # noqa: E402
import httpx  # noqa: E402
import openai  # noqa: E402
from fast_agent import FastAgent  # noqa: E402
from fast_agent.agents.llm_decorator import LlmDecorator  # noqa: E402
from fast_agent.agents.mcp_agent import McpAgent  # noqa: E402
from fast_agent.config import (  # noqa: E402
    CompactionSettings,
    MCPElicitationSettings,
    MCPServerSettings,
)
from fast_agent.history.compaction import (  # noqa: E402
    MID_TURN_RECENT_TOOL_EXCHANGES,
    CompactionSkipped,
    compact_conversation,
)
from fast_agent.llm.compaction_support import compaction_trigger_tokens  # noqa: E402
from fast_agent.llm.fastagent_llm import FastAgentLLM, RequestParams  # noqa: E402
from fast_agent.llm.model_factory import ModelFactory  # noqa: E402
from fast_agent.llm.model_info import ModelInfo  # noqa: E402
from fast_agent.llm.provider.openai.llm_openai import OpenAILLM  # noqa: E402
from fast_agent.llm.provider.openai.responses import ResponsesLLM  # noqa: E402
from fast_agent.llm.provider_types import Provider  # noqa: E402
from fast_agent.llm.reasoning_effort import parse_reasoning_setting  # noqa: E402
from fast_agent.llm.stream_types import StreamChunk  # noqa: E402
from fast_agent.mcp.mcp_aggregator import MCPAggregator  # noqa: E402
from fast_agent.mcp.prompt import Prompt  # noqa: E402
from fast_agent.ptc.runtime import ProgrammaticToolRuntime  # noqa: E402
from fast_agent.tools.filesystem_tool_definitions import (  # noqa: E402
    ATTACH_MEDIA_TOOL_NAME,
    READ_TEXT_FILE_TOOL_NAME,
)
from fast_agent.types import PromptMessageExtended  # noqa: E402
from fast_agent.types.llm_stop_reason import LlmStopReason  # noqa: E402
from fastmcp.tools import FunctionTool, ToolResult  # noqa: E402
from mcp import Tool  # noqa: E402
from mcp_types import CallToolResult, TextContent  # noqa: E402

try:
    from importlib.metadata import version as _version

    FAST_AGENT_VERSION = _version("fast-agent-mcp")
except Exception:  # noqa: BLE001
    FAST_AGENT_VERSION = "unknown"

VERSION = "0.1.0"
SETTINGS =("temperature", "max_tokens", "top_p")
EFFORT = ["minimal", "low", "medium", "high", "xhigh", "max"]
# Kedi owns retries. fast-agent's programmatic tool calling (its code mode), on by default for
# some model generations, stays off until a program turns code mode on, and then offers
# every function upfront, none behind search. Its automatic compaction, the providers'
# in-request compaction included, stays off unless the program's policy is native. MCP servers
# get no sampling: their requests would be model requests of their own.
HOME_CONFIG = (
    "llm_retries: 0\nptc:\n  enabled: false\n  search: false\ncompaction:\n  auto: false\n  strategy: client\n"
    "mcp:\n  client:\n    auto_sampling: false\n"
)

# One event loop for every run, in a thread of its own: the SDK is synchronous and calls back
# from its threads, fast-agent is asyncio.
LOOP = asyncio.new_event_loop()
threading.Thread(target=LOOP.run_forever, name="fast-agent-loop", daemon=True).start()


def _without_sdk_retries(cls: Any) -> None:
    original = cls.__init__

    def __init__(self: Any, *args: Any, **kwargs: Any) -> None:
        kwargs["max_retries"] = 0
        original(self, *args, **kwargs)

    cls.__init__ = __init__


for _client in (openai.AsyncOpenAI, openai.OpenAI, anthropic.AsyncAnthropic, anthropic.Anthropic):
    _without_sdk_retries(_client)
# fast-agent's OpenAI providers send again, inside one request, after an empty reply: once more,
# and without streaming. The reply goes to Kedi as it came.
OpenAILLM._openai_completion = OpenAILLM._openai_completion_once  # type: ignore[method-assign]
OpenAILLM._fallback_to_non_streaming_on_empty_stream = lambda self, model: False  # type: ignore[method-assign]
ResponsesLLM._is_empty_responses_completion = staticmethod(lambda message: False)  # type: ignore[method-assign]

# What else a provider may send again inside one request, the wire refuses: a request Kedi
# admitted makes one POST.
POSTS: ContextVar[list[int] | None] = ContextVar("kedi_posts", default=None)


def _one_post() -> None:
    left = POSTS.get()
    if left is None:
        return
    if not left[0]:
        raise RuntimeError("fast-agent sent a second request inside one Kedi admitted; it is refused")
    left[0] -= 1


_httpx_send = httpx.AsyncHTTPTransport.handle_async_request


async def _httpx_once(self: httpx.AsyncHTTPTransport, request: httpx.Request) -> httpx.Response:
    if request.method == "POST":
        _one_post()
    return await _httpx_send(self, request)


_aiohttp_request = aiohttp.ClientSession._request


async def _aiohttp_once(self: aiohttp.ClientSession, method: str, *args: Any, **kwargs: Any) -> Any:
    if str(method).upper() == "POST":
        _one_post()
    return await _aiohttp_request(self, method, *args, **kwargs)


httpx.AsyncHTTPTransport.handle_async_request = _httpx_once  # type: ignore[method-assign]
aiohttp.ClientSession._request = _aiohttp_once  # type: ignore[method-assign]


@dataclass
class Turn:
    """A run as the bridge runs it on fast-agent."""

    run: Run
    agent: Any = None
    opening: list[PromptMessageExtended] = field(default_factory=list)
    loaded: int = 0
    """How many of the agent's messages came before this turn (session state, Kedi's transcript)."""
    processed: list[JsonObject] = field(default_factory=list)
    covered: int = 0
    """History processing: Kedi's processed conversation, and how many messages it covers."""
    pending: list[str] = field(default_factory=list)
    lock: threading.Lock = field(default_factory=threading.Lock)
    replies: int = 0
    fallbacks: dict[str, FastAgentLLM] = field(default_factory=dict)
    compacting: bool = False
    compact_due: bool = False

    def arrived(self, texts: list[str]) -> None:
        with self.lock:
            self.pending.extend(texts)

    def take_input(self) -> list[str]:
        with self.lock:
            texts, self.pending = self.pending, []
        return texts

    def kedi(self, messages: list[PromptMessageExtended], offset: int) -> list[JsonObject]:
        """Messages in Kedi's schema; the turn's user message in Kedi's own layout."""
        return [
            converted
            for index, message in enumerate(messages)
            for converted in ([convert.kedi_turn(self.run.params)] if offset + index == self.loaded else convert.kedi_messages(message))
        ]

    def stream(self, chunk: StreamChunk) -> None:
        if chunk.event == "delta" and chunk.text and not chunk.is_reasoning:
            self.run.event("message.delta", messageId=f"{self.run.id}-{self.replies + 1}", text=chunk.text)

    def fallback(self, model: str) -> FastAgentLLM:
        """A fallback model's LLM, on the run's agent."""
        if model not in self.fallbacks:
            factory = ModelFactory.create_factory(_model_name(model))
            self.fallbacks[model] = factory(agent=self.agent, context=self.agent.context)
        return self.fallbacks[model]

    def passed(self, llm: FastAgentLLM, counts: JsonObject | None) -> None:
        """Native compaction: a request whose input passed the threshold compacts the session
        before the next request, or when the turn ends."""
        policy = self.run.params.get("compaction") or {}
        if policy.get("mode") != "native" or self.run.params.get("session") is None:
            return
        threshold = policy.get("threshold") or compaction_trigger_tokens(llm, CompactionSettings(), llm.usage_accumulator.context_window_size)
        tokens = (counts or {}).get("inputTokens")
        if isinstance(tokens, int) and threshold is not None and tokens > threshold:
            self.compact_due = True

    async def compact(self, agent: Any, *, mid_turn: bool) -> None:
        """Compacts the session as fast-agent does, with its own summary request; Kedi admits and
        counts it like any request. A session too short for fast-agent's kept turns keeps none."""
        if not self.compact_due:
            return
        self.compact_due, self.compacting = False, True
        try:
            for keep in (CompactionSettings().keep_turns, 0):
                try:
                    await compact_conversation(
                        agent, settings=CompactionSettings(strategy="client", keep_turns=keep),
                        recent_tool_exchanges=MID_TURN_RECENT_TOOL_EXCHANGES if mid_turn else None,
                    )
                    return
                except CompactionSkipped:
                    continue
            self.compact_due = mid_turn  # nothing to compact mid-turn yet: try again when the turn ends
        finally:
            self.compacting = False

    def back(self) -> JsonObject:
        """What the run hands back besides its answer: its state, or its messages in Kedi's schema."""
        history = list(self.agent.message_history) if self.agent is not None else []
        if not self.replies:  # stopped before the turn's first reply was kept
            history = [*history[:self.loaded], *self.opening]
        params = self.run.params
        if params.get("processHistory"):
            return {"transcript": [*self.processed, *self.kedi(history[self.covered:], self.covered)]}
        if isinstance(params.get("history"), list):
            return {"messages": self.kedi(history[self.loaded:], self.loaded)}
        if params.get("session") is not None:
            return {"state": {"messages": [message.model_dump(mode="json", exclude_none=True) for message in history]}}
        return {}


CURRENT: ContextVar[Turn | None] = ContextVar("kedi_turn", default=None)


class _History:
    """The conversation a request sends, for history processing."""

    def __init__(self, request: Request) -> None:
        self.request = request

    def get(self) -> list[JsonObject]:
        turn = self.request.turn
        return [*turn.processed, *turn.kedi(self.request.messages[turn.covered:], turn.covered)]

    def set(self, messages: list[JsonObject]) -> None:
        turn = self.request.turn
        turn.processed, turn.covered = messages, len(self.request.messages)
        self.request.messages[:] = convert.fast_messages(messages, turn.run)


class Request(ModelRequest[PromptMessageExtended]):
    """One attempt of a fast-agent model request, as Kedi decides it."""

    def __init__(self, turn: Turn, llm: FastAgentLLM, func: Any, args: tuple[Any, ...], kwargs: dict[str, Any]) -> None:
        super().__init__(
            history=_History(self) if turn.run.params.get("processHistory") else None,
            purpose="compaction" if turn.compacting else "turn",
        )
        self.turn, self.llm, self.func, self.args, self.kwargs = turn, llm, func, args, kwargs
        # generate sends (conversation, params, tools); structured sends (conversation, model, params).
        self.messages: list[PromptMessageExtended] = args[0]
        self.tools: list[Tool] | None = args[2] if func.__name__ == "_apply_prompt_provider_specific" and len(args) > 2 else None
        # What the request sends as system text: fast-agent's, as its provider gets it.
        params = next((arg for arg in args if isinstance(arg, RequestParams)), None)
        self.system: str | None = params.system_prompt if params is not None and params.system_prompt is not None else llm.instruction
        self.target = llm
        self.started = len(llm.usage_accumulator.turns)
        self.counts: JsonObject | None = None
        self.sending: list[Future[Any]] = []

    def send(self, model: str | None, run: Run) -> PromptMessageExtended:
        call, args = self.func, self.args
        if model is not None and model != run.params.get("model"):
            self.target = self.turn.fallback(model)
            self.started = len(self.target.usage_accumulator.turns)
            call = getattr(self.target, self.func.__name__)
            own = self.target.default_request_params.model
            args = tuple(arg.model_copy(update={"model": own}) if isinstance(arg, RequestParams) else arg for arg in args)
        async def once() -> PromptMessageExtended:
            POSTS.set([1])
            return await call(*args, **self.kwargs)

        future = asyncio.run_coroutine_threadsafe(once(), LOOP)
        self.sending.append(future)
        reply = future.result()
        if reply.stop_reason == LlmStopReason.ERROR:
            # fast-agent reports a failed request as a message; it fails here so the next model is tried.
            raise RuntimeError(reply.last_text() or "fast-agent's model request failed")
        return reply

    def describe(self) -> JsonObject:
        return convert.model_call(self.turn.run, self.system, self.messages, self.tools)

    def reply(self, message: JsonObject, usage: JsonObject | None) -> PromptMessageExtended:
        self.counts = usage
        return convert.fast_message(message, self.turn.run)

    def usage(self, reply: PromptMessageExtended) -> JsonObject | None:
        if self.counts is not None:
            return self.counts
        turns = self.target.usage_accumulator.turns[self.started:]
        if not turns:
            return None
        prompt, completion = turns[-1].prompt, turns[-1].completion
        counts = {"inputTokens": prompt.total, "outputTokens": completion.total, "cacheReadTokens": prompt.cache_read, "cacheWriteTokens": prompt.cache_write}
        if prompt.total is not None and completion.total is not None:
            counts["totalTokens"] = prompt.total + completion.total
        return {name: value for name, value in counts.items() if isinstance(value, int)}

    def cancel(self) -> None:
        for future in self.sending:
            future.cancel()


_execute_with_retry = FastAgentLLM._execute_with_retry


async def _governed(self: FastAgentLLM, func: Any, *args: Any, **kwargs: Any) -> Any:
    turn = CURRENT.get()
    if turn is None:
        raise RuntimeError("a fast-agent model request outside a Kedi run")

    async def attempt(*a: Any, **kw: Any) -> PromptMessageExtended:
        request = Request(turn, self, func, a, kw)
        try:
            reply = await asyncio.to_thread(turn.run.model_request, request)
        finally:
            request.cancel()
        if request.purpose == "compaction":
            return reply
        turn.passed(request.target, request.usage(reply))
        turn.replies += 1
        said = "".join(part.text for part in reply.content or [] if isinstance(part, TextContent))
        if said:
            # Text beside tool calls is commentary; a reply without them is the answer.
            turn.run.event("message.completed", messageId=f"{turn.run.id}-{turn.replies}", text=said, phase="commentary" if reply.tool_calls else "final")
        return reply

    return await _execute_with_retry(self, attempt, *args, **kwargs)


FastAgentLLM._execute_with_retry = _governed  # type: ignore[method-assign]
_prepare_llm_call = LlmDecorator._prepare_llm_call


def _with_live_input(self: LlmDecorator, messages: list[PromptMessageExtended], request_params: RequestParams | None = None) -> Any:
    """Live input joins the conversation as user turns before the agent's next model request,
    and stays in its history."""
    turn = CURRENT.get()
    texts = turn.take_input() if turn is not None else []
    call = _prepare_llm_call(self, [*messages, *(Prompt.user(text) for text in texts)], request_params)
    if turn is not None and call.summary is not None:
        # fast-agent leaves out what its model cannot take; a turn fails rather than reaching the
        # model without its media.
        raise RpcError(ErrorCode.RUN_FAILED, f"fast-agent's model cannot take the turn's content: {call.summary.message}")
    return call


LlmDecorator._prepare_llm_call = _with_live_input  # type: ignore[method-assign]


def _compacting_first(method: Any) -> Any:
    """Before the agent's next model call, a session past its threshold is compacted."""

    async def call(self: LlmDecorator, *args: Any, **kwargs: Any) -> Any:
        turn = CURRENT.get()
        if turn is not None:
            await turn.compact(self, mid_turn=True)
        return await method(self, *args, **kwargs)

    return call


for _name in ("_generate_with_summary", "_structured_with_summary", "_structured_schema_via_generate_with_summary"):
    setattr(LlmDecorator, _name, _compacting_first(getattr(LlmDecorator, _name)))


async def _native_call(
    turn: Turn, call: NativeToolCall, invoke: Callable[[dict[str, Any]], Awaitable[CallToolResult]]
) -> CallToolResult:
    """A call of a tool that is not Kedi's (fast-agent's own, or a tool of Kedi's MCP servers),
    through every step Kedi decides: the pre hook, approval, admission, the call, the post hooks,
    artifact admission. Calls from fast-agent's code tool take the same path."""
    before = await asyncio.to_thread(turn.run.before_native_tool, call)
    if isinstance(before, Refused):
        return CallToolResult(is_error=True, content=[TextContent(type="text", text=before.reason)])
    result = await invoke(before.arguments)
    said = convert.result_value(result)
    if result.is_error:
        outcome = await asyncio.to_thread(turn.run.after_native_tool, call, before.arguments, error=RuntimeError(convert.text(said)))
    else:
        outcome = await asyncio.to_thread(turn.run.after_native_tool, call, before.arguments, result=said)
    value = outcome["result"] if outcome["ok"] else outcome["error"]
    return CallToolResult(is_error=not outcome["ok"], content=[TextContent(type="text", text=convert.text(value))])


_call_mcp_tool = MCPAggregator.call_tool


async def _governed_mcp(self: MCPAggregator, name: str, arguments: dict[str, Any] | None = None, tool_use_id: str | None = None, **kwargs: Any) -> CallToolResult:
    """A call of a tool of Kedi's MCP servers, through Kedi's steps."""
    turn = CURRENT.get()
    if turn is None:
        return await _call_mcp_tool(self, name, arguments, tool_use_id, **kwargs)
    known = self.tool_catalog().namespaced_tool(name)
    hints = known.tool.annotations if known else None
    call = NativeToolCall(
        call_id=tool_use_id or f"call-{uuid.uuid4().hex[:12]}",
        name=self.resolve_tool_name(name).local_name or name,
        arguments=arguments or {},
        origin="mcp",
        # The server's own hints decide the risk: read-only, destructive, or neither.
        risk="read_only" if hints and hints.read_only_hint else "sensitive" if hints and hints.destructive_hint else "mutating",
        description=known.tool.description if known else None,
        input_schema=known.tool.input_schema if known else None,
    )
    return await _native_call(turn, call, lambda args: _call_mcp_tool(self, name, args, tool_use_id, **kwargs))


MCPAggregator.call_tool = _governed_mcp  # type: ignore[method-assign]


def _own_tool(agent: McpAgent, name: str) -> tuple[str, Any] | None:
    """A tool of fast-agent's own, as pi's are: its file tools and its shell, with the risk Kedi
    asks approval at (reading, changing files, running commands) and its definition; None for
    any other tool."""
    files = agent._filesystem_runtime
    tool = next((tool for tool in files.tools if tool.name == name), None) if files is not None else None
    if tool is not None:
        return ("read_only" if name in (READ_TEXT_FILE_TOOL_NAME, ATTACH_MEDIA_TOOL_NAME) else "mutating"), tool
    shell = agent._shell_runtime
    if shell is not None and shell.owns_tool(name):
        return "sensitive", next((tool for tool in shell.tools if tool.name == name), None)
    return None


_call_local_tool = McpAgent._call_local_tool


async def _governed_own(self: McpAgent, name: str, arguments: dict[str, Any] | None = None, tool_use_id: str | None = None, **kwargs: Any) -> CallToolResult | None:
    """A call of one of fast-agent's own tools, through Kedi's steps; Kedi's tools go to Kedi
    with tool/call instead."""
    turn = CURRENT.get()
    own = _own_tool(self, name) if turn is not None else None
    if turn is None or own is None:
        return await _call_local_tool(self, name, arguments, tool_use_id, **kwargs)
    risk, tool = own
    call = NativeToolCall(
        call_id=tool_use_id or f"call-{uuid.uuid4().hex[:12]}",
        name=name,
        arguments=arguments or {},
        origin="adapter_native",
        risk=risk,
        description=tool.description if tool is not None else None,
        input_schema=tool.inputSchema if tool is not None else None,
    )

    async def invoke(args: dict[str, Any]) -> CallToolResult:
        result = await _call_local_tool(self, name, args, tool_use_id, **kwargs)
        assert result is not None, name
        return result

    return await _native_call(turn, call, invoke)


McpAgent._call_local_tool = _governed_own  # type: ignore[method-assign]

# With its shell on, fast-agent lets sandbox code open the machine's files itself ("not a
# filesystem sandbox"), in place of read_text_file, and no step of Kedi's would see it. Code
# reaches files only through the file tools, as a direct call does: read_text_file stays one of
# the sandbox's functions, and the sandbox gets no host file access.
McpAgent._sandbox_file_reads = lambda self: None  # type: ignore[method-assign]
_model_tools = ProgrammaticToolRuntime.model_tools


def _files_through_tools(self: ProgrammaticToolRuntime, *args: Any, **kwargs: Any) -> Any:
    return _model_tools(self, *args, **{**kwargs, "file_read": False, "file_write": False})


ProgrammaticToolRuntime.model_tools = _files_through_tools  # type: ignore[method-assign]


def _mcp_server(name: str, server: JsonObject) -> MCPServerSettings:
    """A Kedi ``> mcp:`` server as fast-agent's, named s1, s2, ... in order. It cannot ask the
    user anything (elicitation): stdin is Kedi's protocol."""
    silent = MCPElicitationSettings(mode="none")
    if server["transport"] == "stdio":
        return MCPServerSettings(
            name=name, transport="stdio", command=server.get("command"), args=server.get("args") or [], env=server.get("env") or None, elicitation=silent,
        )
    return MCPServerSettings(name=name, transport=server["transport"], url=server.get("url"), headers=server.get("headers") or None, elicitation=silent)


class KediTestLLM(FastAgentLLM):
    """Test mode: ``Run.model_request`` answers each request with Kedi's test model, so this LLM
    never sends one itself."""

    def __init__(self, provider: Provider = Provider.FAST_AGENT, name: str = "KediTest", **kwargs: Any) -> None:
        super().__init__(name=name, provider=provider, **kwargs)

    async def initialize(self) -> None:
        pass

    @property
    def model_info(self) -> ModelInfo:
        # Kedi's test model takes the images fast-agent would otherwise leave out.
        return ModelInfo(
            name="kedi-test", provider=Provider.FAST_AGENT, context_window=None, max_output_tokens=None,
            tokenizes=["text/plain", "image/png", "image/jpeg", "image/gif", "image/webp"], json_mode=None, reasoning=None,
        )

    async def _apply_prompt_provider_specific(self, *args: Any, **kwargs: Any) -> PromptMessageExtended:
        raise AssertionError("test mode answers every request through model/complete")

    def _convert_extended_messages_to_provider(self, messages: list[PromptMessageExtended]) -> list[Any]:
        del messages
        return []


class KediTool(FunctionTool):
    """One of Kedi's tools: its schema is Kedi's, and a call goes back to Kedi."""

    async def run(self, arguments: dict[str, Any]) -> ToolResult:  # type: ignore[override]
        turn = CURRENT.get()
        assert turn is not None
        outcome = await asyncio.to_thread(turn.run.call_tool, f"call-{uuid.uuid4().hex[:12]}", self.name, arguments)
        value = outcome["result"] if outcome["ok"] else {"error": outcome["error"]}
        text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
        return ToolResult(content=[TextContent(type="text", text=text)])


def kedi_tool(spec: JsonObject) -> KediTool:
    fields: dict[str, Any] = {name: None for name in FunctionTool.model_fields}
    fields.update(
        name=spec["name"],
        description=spec.get("description") or "",
        parameters=spec.get("inputSchema") or {"type": "object", "properties": {}},
        fn=lambda **_: None,
        tags=set(),
        run_in_thread=False,
    )
    return KediTool.model_construct(**fields)


def _model_name(name: str) -> str:
    """A Kedi model name, ``provider/model``, as fast-agent's ``provider.model``."""
    provider, slash, model = name.partition("/")
    if not slash or not model or provider not in {p.config_name for p in Provider}:
        raise RpcError(
            ErrorCode.RUN_FAILED,
            f"fast-agent needs a model named provider/model, such as google/gemini-3.1-flash-lite-preview; got {json.dumps(name)}",
        )
    if provider == "copilot":
        # Copilot's recovery adds prompts of fast-agent's own; Kedi renders every model-visible text.
        raise RpcError(ErrorCode.RUN_FAILED, "fast-agent's Copilot provider writes prompts of its own; use another provider")
    if "ptc=" in model.partition("?")[2]:
        raise RpcError(ErrorCode.RUN_FAILED, "fast-agent's ptc model query is Kedi's to decide; remove it from > model:")
    return f"{provider}.{model}"


def _model(run: Run) -> str:
    if run.test_mode:
        return "passthrough"  # replaced by KediTestLLM before any request
    name = run.params.get("model")
    if not name:
        raise RpcError(ErrorCode.RUN_FAILED, "fast-agent needs a model, such as google/gemini-3.1-flash-lite-preview")
    return _model_name(name)


def _home() -> str:
    runtime = os.environ.get("KEDI_PACKAGE_RUNTIME_DIR")
    home = Path(runtime) / "fast-agent" if runtime else Path(tempfile.mkdtemp(prefix="kedi-fast-agent-"))
    home.mkdir(parents=True, exist_ok=True)
    (home / "fast-agent.yaml").write_text(HOME_CONFIG)
    return str(home)


def _literal(text: str) -> str:
    """Kedi's text as fast-agent's instruction, as written: fast-agent expands templates in an
    instruction ({{file:...}}, {{url:...}}, {{env}}, ...), so every brace pair is escaped."""
    return text.replace("{{", r"\{{").replace("}}", r"\}}")


def _history(run: Run) -> list[PromptMessageExtended]:
    """The conversation before this turn: Kedi's transcript, or the session's state."""
    params = run.params
    if isinstance(params.get("history"), list):
        return convert.fast_messages(params["history"], run)
    state = (params.get("session") or {}).get("state") or {}
    return [PromptMessageExtended.model_validate(message) for message in state.get("messages") or []]


def _opening(run: Run) -> list[PromptMessageExtended]:
    """The turn's messages; a continuation replays the rejected answer as the model's turn and
    Kedi's correction as the user's next."""
    params = run.params
    user = convert.user_message(run)
    continuation = params.get("continuation")
    if not continuation:
        return [user]
    rejected = continuation["answer"]
    said = rejected["text"] if isinstance(rejected.get("text"), str) else json.dumps(rejected.get("data", rejected), ensure_ascii=False)
    return [user, Prompt.assistant(said), Prompt.user(continuation["message"])]


def _request_params(run: Run) -> RequestParams | None:
    settings = {name: value for name, value in (run.params.get("settings") or {}).items() if name in SETTINGS}
    return RequestParams(**settings) if settings else None


class FastAgentBridge:
    handshake: JsonObject = {
        "backend": {"name": "fast-agent", "version": FAST_AGENT_VERSION},
        "kind": "agent-harness",
        "mediaKinds": ["image"],
        "settings": list(SETTINGS),
        "effort": EFFORT,
        # fast-agent compacts at an exact input-token threshold: the bridge decides when.
        "compaction": {"threshold": True},
        # Its code mode: model-written Python in a sandbox (Monty) whose functions are Kedi's tools.
        "codemode": {"language": "python"},
        "mcp": {"transports": ["stdio", "http", "sse"]},
        "capabilities": {
            "tools": True,
            "nativeToolCalling": True,
            "nativeTools": True,
            "structuredOutput": True,
            "governed": True,
            "subagents": True,
            "liveInput": True,
            "interrupt": True,
            "usage": True,
            "events": True,
            "modelFallback": True,
            "mediaInput": True,
            "sessions": True,
            "transcript": True,
            "testModel": True,
        },
    }
    files: list[str] = ["convert.py"]

    def __init__(self, cwd: Path | None = None) -> None:
        self.cwd = cwd or Path.cwd()
        """Where fast-agent's file tools and shell work."""

    def run(self, run: Run) -> JsonObject:
        future = asyncio.run_coroutine_threadsafe(self._run(run), LOOP)
        threading.Thread(target=_cancel_on_stop, args=(run, future), daemon=True).start()
        try:
            answer = future.result()
        except (asyncio.CancelledError, concurrent.futures.CancelledError, Exception):
            if run.stop_reason is not None:
                raise run.stop_reason from None
            raise
        if run.stop_reason is not None:
            raise run.stop_reason
        return answer

    async def _run(self, run: Run) -> JsonObject:
        turn = Turn(run)
        token = CURRENT.set(turn)
        try:
            fast = FastAgent(f"kedi-{run.id}", parse_cli_args=False, quiet=True, isolated=True, home=_home())

            @fast.agent(name="kedi", instruction=_literal(run.params.get("system") or ""), model=_model(run))
            async def _agent() -> None: ...

            async with fast.run() as app:
                agent = turn.agent = app.kedi
                if run.test_mode:
                    await agent.attach_llm(lambda **kwargs: KediTestLLM(**kwargs))
                elif run.params.get("effort"):
                    agent.llm.set_reasoning_effort(parse_reasoning_setting(run.params["effort"]))
                agent.llm.add_stream_listener(turn.stream)
                for spec in run.params.get("tools") or []:
                    agent.add_tool(kedi_tool(spec))
                # fast-agent's own tools, as pi's: its file tools and its shell, in the working
                # directory, each call through Kedi's steps.
                agent.enable_shell(self.cwd)
                servers = [f"s{index}" for index, _ in enumerate(run.params.get("mcpServers") or [], 1)]
                for name, server in zip(servers, run.params.get("mcpServers") or []):
                    await agent.attach_mcp_server(server_name=name, server_config=_mcp_server(name, server))
                code_mode = run.params.get("codemode") is True
                if code_mode:
                    agent.restore_ptc(True)
                await _check_tools(agent, run, servers, code_mode=code_mode)
                history = await asyncio.to_thread(_history, run)
                agent.load_message_history(history)
                turn.loaded = turn.covered = len(history)
                turn.processed = list(run.params.get("history") or [])
                turn.opening = await asyncio.to_thread(_opening, run)
                run.on_input(turn.arrived, on="arrival")
                run.on_interrupt(turn.back)
                params = _request_params(run)
                output = run.params.get("output") or {}
                if output.get("schema") and not output.get("media"):
                    data, message = await agent.structured_schema(turn.opening, output["schema"], params)
                    answer: JsonObject = {"data": data} if data is not None else {"invalid": message.last_text() or "", "error": "not JSON matching the schema"}
                else:
                    message = await agent.generate(turn.opening, params)
                    answer = {"text": message.last_text() or ""}
                if run.stop_reason is not None:
                    raise run.stop_reason
                await turn.compact(agent, mid_turn=False)
                if message.stop_reason == LlmStopReason.ERROR:
                    said = message.last_text() or "fast-agent's model request failed"
                    raise RpcError(ErrorCode.RUN_FAILED, said, {"harness": {"type": "FastAgentError", "message": said}})
                return {**answer, **turn.back()}
        finally:
            CURRENT.reset(token)


async def _check_tools(agent: Any, run: Run, servers: list[str], *, code_mode: bool) -> None:
    """The model sees Kedi's tools, its servers' and fast-agent's own file tools and shell, all
    through Kedi's steps, and nothing else; with code mode on, only the code tool, whose code
    reaches only those. Any other tool fast-agent turns on (its subagents, image generation, web
    search, ...) would escape Kedi."""
    kedi = {spec["name"] for spec in run.params.get("tools") or []}

    def given(name: str) -> bool:
        return name in kedi or name.split("__", 1)[0] in servers or _own_tool(agent, name) is not None

    surface = await agent.tool_surface()
    code_tool = surface.programmatic.tool_name if surface.programmatic is not None else None
    if code_mode and code_tool is None:
        raise RpcError(ErrorCode.RUN_FAILED, "fast-agent could not turn its code mode on for this model")
    offered = {tool.name for tool in (await agent.list_tools()).tools}
    unexpected = {name for name in offered if not given(name) and not (code_mode and name == code_tool)}
    unexpected |= {function.tool.name for function in surface.programmatic_functions() if not given(function.tool.name)}
    if unexpected:
        raise RpcError(ErrorCode.RUN_FAILED, f"fast-agent offers tools Kedi did not give: {', '.join(sorted(unexpected))}")


def _cancel_on_stop(run: Run, future: Future[Any]) -> None:
    while not future.done():
        if run.stopped.wait(0.05):
            future.cancel()
            return


if __name__ == "__main__":
    # python bridge.py [--cwd DIR]: fast-agent's tools work in DIR, the current directory by default.
    cwd = Path(sys.argv[sys.argv.index("--cwd") + 1]) if "--cwd" in sys.argv else None
    raise SystemExit(serve(FastAgentBridge(cwd)))
