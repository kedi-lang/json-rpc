"""The fast-agent bridge against a real (local) upstream: what reaches the wire is what Kedi admitted.

The fixtures run in test mode, where Kedi's test model answers. These run the bridge in real mode
against a stub OpenAI-compatible endpoint (fast-agent's ``generic`` provider), and compare the
requests that reach it with the ``budget/admit`` requests Kedi answered.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
BRIDGE = HERE.parent
sys.path[:0] = [str(BRIDGE.parent / "src")]

from kedi_bridge.peer import Peer  # noqa: E402

RUN = {
    "callKind": "invoke", "promptKind": "raw", "fallbackModels": [], "settings": {}, "effort": None,
    "system": "You are being tested.", "instructionParts": [], "user": "Where is Lyon?", "userContent": None, "output": None,
    "tools": [], "continuation": None, "session": None, "subagent": None, "hooks": [], "mcpServers": [], "admitResults": False,
}
LOOKUP = {"name": "lookup", "description": "A city's country.", "inputSchema": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}
TEXT = {"content": "Lyon is in France."}
# Runs the bridge with fast-agent's own send-again-without-streaming back on, as a provider that
# sends a second request inside one would: the wire must refuse it.
RESENDING = """
import runpy
import sys

import kedi_bridge

served = kedi_bridge.serve


def serve(bridge):
    from fast_agent.llm.provider.openai.llm_openai import OpenAILLM

    OpenAILLM._fallback_to_non_streaming_on_empty_stream = lambda self, model: True
    return served(bridge)


kedi_bridge.serve = serve
sys.argv = [sys.argv[1]]
sys.path.insert(0, sys.argv[0].rsplit("/", 1)[0])
runpy.run_path(sys.argv[0], run_name="__main__")
"""
CALL = {"tool": "lookup", "arguments": {"city": "Lyon"}}
# A file in the bridge's working directory, for fast-agent's own file tools.
NOTE = {"note.txt": "The secret word is kedi.\n"}
# A stdio MCP server with one tool that changes something, as a Kedi `> mcp:` server.
MCP = {"name": "stub", "transport": "stdio", "command": sys.executable, "args": [str(HERE / "mcp_server.py")], "env": {}}


class Upstream:
    """A stub chat completions endpoint: scripted replies (a status, text or a tool call), every
    POST counted with its body."""

    def __init__(self, replies: list[Any]) -> None:
        self.replies = list(replies)
        self.hits: list[dict[str, Any]] = []
        upstream = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args: object) -> None:
                pass

            def do_GET(self) -> None:
                self._send(200, "application/json", json.dumps({"object": "list", "data": [{"id": "stub-model", "object": "model"}]}))

            def do_POST(self) -> None:
                body = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)) or b"{}")
                upstream.hits.append(body)
                reply = upstream.replies.pop(0) if upstream.replies else TEXT
                if isinstance(reply, int):
                    self._send(reply, "application/json", json.dumps({"error": {"message": "transient", "type": "server_error"}}))
                    return
                if "tool" in reply:
                    delta = {"role": "assistant", "content": None, "tool_calls": [{
                        "index": 0, "id": f"call_{len(upstream.hits)}", "type": "function",
                        "function": {"name": reply["tool"], "arguments": json.dumps(reply["arguments"])},
                    }]}
                    finish = "tool_calls"
                else:
                    delta, finish = {"role": "assistant", "content": reply["content"]}, "stop"
                head = {"id": "c1", "object": "chat.completion.chunk", "created": int(time.time()), "model": "stub-model"}
                chunks = [
                    {**head, "choices": [{"index": 0, "delta": delta, "finish_reason": None}]},
                    {**head, "choices": [{"index": 0, "delta": {}, "finish_reason": finish}]},
                    {**head, "choices": [], "usage": {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5}},
                ]
                self._send(200, "text/event-stream", "".join(f"data: {json.dumps(chunk)}\n\n" for chunk in chunks) + "data: [DONE]\n\n")

            def _send(self, status: int, kind: str, text: str) -> None:
                data = text.encode()
                self.send_response(status)
                self.send_header("content-type", kind)
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/v1"

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


class Kedi:
    """The bridge as a subprocess, and Kedi's side of the connection."""

    def __init__(
        self, upstream: Upstream, *, request_limit: int | None = None, resending: bool = False, approval: str = "allow",
        files: dict[str, str] | None = None,
    ) -> None:
        self.directory = Path(tempfile.mkdtemp(prefix="kedi-fast-agent-test-"))
        for name, text in (files or {}).items():
            (self.directory / name).write_text(text)
        command = [sys.executable, str(BRIDGE / "bridge.py")]
        if resending:
            (self.directory / "resending.py").write_text(RESENDING)
            command = [sys.executable, str(self.directory / "resending.py"), str(BRIDGE / "bridge.py")]
        env = {
            **os.environ,
            "PYTHONPATH": str(BRIDGE.parent / "src"),
            "GENERIC_BASE_URL": upstream.url,
            "KEDI_PACKAGE_RUNTIME_DIR": str(self.directory),
            "KEDI_BRIDGE_PREFLIGHT": "off",
        }
        self.process = subprocess.Popen(
            command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, env=env, cwd=self.directory,
        )
        assert self.process.stdin and self.process.stdout
        stdin = self.process.stdin

        def write(frame: bytes) -> None:
            stdin.write(frame)
            stdin.flush()

        self.peer = Peer(self.process.stdout.fileno(), write)
        self.admissions: list[str] = []
        self.tool_calls: list[dict[str, Any]] = []
        self.approvals: list[dict[str, Any]] = []
        self.left = request_limit

        def admit(params: dict[str, Any]) -> dict[str, Any]:
            self.admissions.append(params["dimension"])
            if params["dimension"] == "request" and self.left is not None:
                if self.left <= 0:
                    return {"admitted": False, "dimension": "request", "reason": "request budget exhausted"}
                self.left -= 1
            return {"admitted": True}

        def call(params: dict[str, Any]) -> dict[str, Any]:
            self.tool_calls.append(params)
            return {"ok": True, "result": "France"}

        def approve(params: dict[str, Any]) -> dict[str, Any]:
            self.approvals.append(params)
            return {"decision": approval, **({"reason": "not today"} if approval == "deny" else {})}

        self.peer.on_request("budget/admit", admit)
        self.peer.on_request("tool/call", call)
        self.peer.on_request("approval/request", approve)
        self.peer.start()
        self.peer.request("initialize", {"protocolVersion": 1, "client": {"name": "test"}}).result(timeout=120)

    def run(self, **params: Any) -> dict[str, Any]:
        future = self.peer.request("run", {**RUN, "runId": "r1", "model": "generic/stub-model", **params})
        try:
            return {"result": future.result(timeout=120)}
        except Exception as error:  # noqa: BLE001 - the answer under test
            return {"error": {"code": getattr(error, "code", None), "message": str(error)}}

    def close(self) -> None:
        assert self.process.stdin
        self.process.stdin.close()
        try:
            self.process.wait(timeout=30)
        except subprocess.TimeoutExpired:
            self.process.kill()
        if self.process.stdout:
            self.process.stdout.close()
        shutil.rmtree(self.directory, ignore_errors=True)


def converse(
    replies: list[Any], *, request_limit: int | None = None, resending: bool = False, approval: str = "allow",
    files: dict[str, str] | None = None, **params: Any,
) -> tuple[dict[str, Any], Upstream, Kedi]:
    upstream = Upstream(replies)
    kedi = Kedi(upstream, request_limit=request_limit, resending=resending, approval=approval, files=files)
    try:
        return kedi.run(**params), upstream, kedi
    finally:
        kedi.close()
        upstream.close()


class RealModeTests(unittest.TestCase):
    def test_every_request_on_the_wire_was_admitted_through_a_tool_loop(self) -> None:
        answer, upstream, kedi = converse([CALL, TEXT], tools=[LOOKUP])
        self.assertEqual(answer.get("result", {}).get("text"), "Lyon is in France.", answer)
        self.assertEqual(len(upstream.hits), 2)
        self.assertEqual(kedi.admissions.count("request"), len(upstream.hits))
        self.assertEqual([call["name"] for call in kedi.tool_calls], ["lookup"])
        self.assertEqual(kedi.tool_calls[0]["arguments"], {"city": "Lyon"})

    def test_a_request_kedi_denies_never_reaches_the_wire(self) -> None:
        answer, upstream, kedi = converse([CALL, TEXT], request_limit=1, tools=[LOOKUP])
        self.assertIn("request budget exhausted", answer.get("error", {}).get("message", ""), answer)
        self.assertEqual(len(upstream.hits), 1)
        self.assertEqual(kedi.admissions.count("request"), 2)

    def test_kedi_owns_retries_a_failed_request_is_sent_once(self) -> None:
        answer, upstream, kedi = converse([500, TEXT])
        self.assertIn("error", answer)
        self.assertEqual(len(upstream.hits), 1, "neither fast-agent nor the OpenAI SDK retries")
        self.assertEqual(kedi.admissions.count("request"), 1)

    def test_an_empty_reply_is_not_asked_again_behind_kedi(self) -> None:
        answer, upstream, kedi = converse([{"content": ""}, TEXT])
        self.assertEqual(len(upstream.hits), 1, answer)
        self.assertEqual(kedi.admissions.count("request"), 1)

    def test_a_second_request_inside_one_kedi_admitted_is_refused_at_the_wire(self) -> None:
        answer, upstream, kedi = converse([{"content": ""}, TEXT], resending=True)
        self.assertIn("second request inside one Kedi admitted", answer.get("error", {}).get("message", ""), answer)
        self.assertEqual(len(upstream.hits), 1)
        self.assertEqual(kedi.admissions.count("request"), 1)

    def test_code_mode_calls_kedis_tools_from_code_only_through_kedi(self) -> None:
        code = {"tool": "exec_sandbox", "arguments": {"code": "r = await lookup(city='Lyon')\nprint(r)"}}
        answer, upstream, kedi = converse([code, TEXT], tools=[LOOKUP], codemode=True)
        self.assertEqual(answer.get("result", {}).get("text"), "Lyon is in France.", answer)
        self.assertEqual([tool["function"]["name"] for tool in upstream.hits[0]["tools"]], ["exec_sandbox"])
        self.assertEqual([call["name"] for call in kedi.tool_calls], ["lookup"])
        self.assertEqual(kedi.tool_calls[0]["arguments"], {"city": "Lyon"})
        self.assertEqual(kedi.admissions.count("request"), len(upstream.hits))
        self.assertIn("France", json.dumps(upstream.hits[1]["messages"][-1]))

    def test_code_mode_calls_mcp_tools_from_code_only_through_kedis_approval(self) -> None:
        code = {"tool": "exec_sandbox", "arguments": {"code": "r = await s1__ship(city='Lyon')\nprint(r)"}}
        for decision, outcome in (("allow", "shipped to Lyon"), ("deny", "not today")):
            with self.subTest(decision):
                answer, upstream, kedi = converse(
                    [code, TEXT], approval=decision, mcpServers=[MCP], codemode=True
                )
                self.assertIn("result", answer, answer)
                self.assertEqual([tool["function"]["name"] for tool in upstream.hits[0]["tools"]], ["exec_sandbox"])
                self.assertEqual([approval["tool"] for approval in kedi.approvals], ["ship"])
                self.assertEqual(kedi.approvals[0]["risk"], "mutating")
                self.assertIn(outcome, json.dumps(upstream.hits[1]["messages"][-1]))
                if decision == "deny":
                    self.assertNotIn("shipped", json.dumps(upstream.hits[1]["messages"][-1]))

    def test_with_code_mode_off_the_code_tool_stays_off(self) -> None:
        _, upstream, _ = converse([TEXT], tools=[LOOKUP])
        offered = [tool["function"]["name"] for tool in upstream.hits[0]["tools"]]
        self.assertIn("lookup", offered)
        self.assertNotIn("exec_sandbox", offered)

    def test_fast_agents_own_tools_take_kedis_approval_at_their_risk(self) -> None:
        read = {"tool": "read_text_file", "arguments": {"path": "note.txt"}}
        for decision, outcome in (("allow", "secret word is kedi"), ("deny", "not today")):
            with self.subTest(decision):
                answer, upstream, kedi = converse([read, TEXT], approval=decision, files=NOTE)
                self.assertIn("result", answer, answer)
                approvals = [(approval["tool"], approval["risk"], approval["origin"]) for approval in kedi.approvals]
                self.assertEqual(approvals, [("read_text_file", "read_only", "adapter_native")])
                self.assertIn(outcome, json.dumps(upstream.hits[1]["messages"][-1]))
                if decision == "deny":
                    self.assertNotIn("secret word", json.dumps(upstream.hits[1]["messages"]))

    def test_a_shell_command_runs_only_once_kedi_approves_it(self) -> None:
        marker = Path(tempfile.mkdtemp(prefix="kedi-fast-agent-shell-")) / "ran.txt"
        try:
            shell = {"tool": "bash", "arguments": {"command": f"touch {marker}"}}
            for decision, runs in (("deny", False), ("allow", True)):
                with self.subTest(decision):
                    answer, _, kedi = converse([shell, TEXT], approval=decision)
                    self.assertIn("result", answer, answer)
                    self.assertEqual([(approval["tool"], approval["risk"]) for approval in kedi.approvals], [("bash", "sensitive")])
                    self.assertEqual(marker.exists(), runs)
        finally:
            shutil.rmtree(marker.parent, ignore_errors=True)

    def test_code_reaches_files_only_through_the_file_tools(self) -> None:
        source = (
            "r = await read_text_file(path='note.txt')\nprint(r)\n"
            "try:\n    print(open('note.txt').read())\nexcept Exception as error:\n    print('open failed')"
        )
        answer, upstream, kedi = converse(
            [{"tool": "exec_sandbox", "arguments": {"code": source}}, TEXT], files=NOTE, codemode=True
        )
        self.assertIn("result", answer, answer)
        self.assertEqual([tool["function"]["name"] for tool in upstream.hits[0]["tools"]], ["exec_sandbox"])
        self.assertEqual([(approval["tool"], approval["risk"]) for approval in kedi.approvals], [("read_text_file", "read_only")])
        said = json.dumps(upstream.hits[1]["messages"][-1])
        self.assertEqual(said.count("secret word is kedi"), 1, said)
        self.assertIn("open failed", said)

    def test_kedis_system_text_reaches_the_wire_as_written(self) -> None:
        system = "Keep {{currentDate}}, {{file:notes.txt}}, {{url:https://example.com/x}} and {{env}} as written."
        answer, upstream, _ = converse([TEXT], system=system)
        self.assertIn("result", answer, answer)
        sent = upstream.hits[0]["messages"]
        self.assertEqual(sent[0], {"role": "system", "content": system})

    def test_a_model_is_named_provider_slash_model_as_everywhere_in_kedi(self) -> None:
        answer, upstream, _ = converse([TEXT], model="generic.stub-model")
        self.assertIn("provider/model", answer.get("error", {}).get("message", ""), answer)
        self.assertEqual(upstream.hits, [])

    def test_a_ptc_model_query_is_refused(self) -> None:
        answer, upstream, _ = converse([TEXT], model="generic/stub-model?ptc=on")
        self.assertIn("ptc", answer.get("error", {}).get("message", ""), answer)
        self.assertEqual(upstream.hits, [])


if __name__ == "__main__":
    unittest.main()
