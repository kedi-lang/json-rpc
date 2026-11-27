"""The Hermes bridge against a real (local) upstream: what reaches the wire is what Kedi admitted.

The fixtures run in test mode, where Kedi's test model answers. These run the bridge in real mode
against a stub OpenAI-compatible endpoint, a Hermes named provider, and count the requests that
reach it against the ``budget/admit`` requests Kedi answered.
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

import httpx

HERE = Path(__file__).resolve().parent
BRIDGE = HERE.parent
sys.path[:0] = [str(BRIDGE), str(BRIDGE.parent / "src")]

from gate import Gate  # noqa: E402

from kedi_bridge.peer import Peer  # noqa: E402

RUN = {
    "callKind": "invoke", "promptKind": "raw", "fallbackModels": [], "settings": {}, "effort": None,
    "system": "You are being tested.", "instructionParts": [], "user": "Hello.", "userContent": None, "output": None,
    "tools": [], "continuation": None, "session": None, "subagent": None, "hooks": [], "mcpServers": [], "admitResults": False,
}


class Upstream:
    """A stub chat completions endpoint: scripted statuses, every POST counted."""

    def __init__(self, statuses: list[int]) -> None:
        self.statuses = list(statuses)
        self.hits: list[dict] = []
        upstream = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args: object) -> None:
                pass

            def do_GET(self) -> None:
                self._json(200, {"object": "list", "data": [{"id": "stub-model", "object": "model"}]})

            def do_POST(self) -> None:
                body = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)) or b"{}")
                if not self.path.endswith("/chat/completions"):
                    self._json(404, {})
                    return
                upstream.hits.append({"stream": bool(body.get("stream")), "headers": dict(self.headers)})
                status = upstream.statuses.pop(0) if upstream.statuses else 200
                if status != 200:
                    self._json(status, {"error": {"message": "transient", "type": "server_error"}})
                    return
                answer = {
                    "id": "c1", "object": "chat.completion", "created": int(time.time()), "model": "stub-model",
                    "choices": [{"index": 0, "message": {"role": "assistant", "content": "from upstream"}, "finish_reason": "stop"}],
                    "usage": {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5},
                }
                if body.get("stream"):
                    chunk = {"id": "c1", "object": "chat.completion.chunk", "created": answer["created"], "model": "stub-model",
                             "choices": [{"index": 0, "delta": {"role": "assistant", "content": "from upstream"}, "finish_reason": "stop"}]}
                    data = f"data: {json.dumps(chunk)}\n\ndata: [DONE]\n\n".encode()
                    self.send_response(200)
                    self.send_header("content-type", "text/event-stream")
                    self.send_header("content-length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                    return
                self._json(200, answer)

            def _json(self, status: int, payload: dict) -> None:
                data = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
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

    def __init__(self, upstream: Upstream, *, request_limit: int | None = None) -> None:
        self.directory = Path(tempfile.mkdtemp(prefix="kedi-hermes-test-"))
        providers = self.directory / "providers.yaml"
        providers.write_text(f"providers:\n  stub:\n    api: {upstream.url}\n    api_key: stub-key\n")
        env = {
            **os.environ,
            "PYTHONPATH": os.pathsep.join([str(BRIDGE.parent / "src"), str(BRIDGE)]),
            "KEDI_HERMES_PROVIDERS": str(providers),
            "KEDI_BRIDGE_PREFLIGHT": "off",
        }
        self.process = subprocess.Popen(
            [sys.executable, str(BRIDGE / "bridge.py")], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, env=env,
        )
        assert self.process.stdin and self.process.stdout
        stdin = self.process.stdin

        def write(frame: bytes) -> None:
            stdin.write(frame)
            stdin.flush()

        self.peer = Peer(self.process.stdout.fileno(), write)
        self.admissions: list[str] = []
        self.left = request_limit

        def admit(params: dict) -> dict:
            self.admissions.append(params["dimension"])
            if params["dimension"] == "request" and self.left is not None:
                if self.left <= 0:
                    return {"admitted": False, "dimension": "request", "reason": "request budget exhausted"}
                self.left -= 1
            return {"admitted": True}

        self.peer.on_request("budget/admit", admit)
        self.peer.start()
        self.peer.request("initialize", {"protocolVersion": 1, "client": {"name": "test"}}).result(timeout=120)

    def run(self) -> dict:
        future = self.peer.request("run", {**RUN, "runId": "r1", "model": "stub/stub-model"})
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
        for stream in (self.process.stdout, self.process.stderr):
            if stream:
                stream.close()
        shutil.rmtree(self.directory, ignore_errors=True)


class RealModeTests(unittest.TestCase):
    def test_every_request_on_the_wire_was_admitted_including_hermes_own_retries(self) -> None:
        upstream = Upstream([500])
        kedi = Kedi(upstream)
        try:
            answer = kedi.run()
        finally:
            kedi.close()
            upstream.close()
        self.assertEqual(answer.get("result", {}).get("text"), "from upstream", answer)
        self.assertGreaterEqual(len(upstream.hits), 2, "Hermes retries the failed request")
        self.assertEqual(kedi.admissions.count("request"), len(upstream.hits))
        self.assertFalse(any("x-kedi-run" in {key.lower() for key in hit["headers"]} for hit in upstream.hits))

    def test_a_request_kedi_denies_never_reaches_the_wire(self) -> None:
        upstream = Upstream([500])
        kedi = Kedi(upstream, request_limit=1)
        try:
            answer = kedi.run()
        finally:
            kedi.close()
            upstream.close()
        self.assertIn("error", answer)
        self.assertIn("request budget exhausted", answer["error"]["message"])
        self.assertEqual(len(upstream.hits), 1)
        self.assertEqual(kedi.admissions.count("request"), 2)


class GateTests(unittest.TestCase):
    def test_any_post_to_a_runs_model_host_is_a_model_request_so_native_apis_are_gated_too(self) -> None:
        gate = Gate()

        class Run:
            id = "r"

        gate.open(Run(), "generativelanguage.googleapis.com")  # type: ignore[arg-type]
        cases = {
            ("POST", "https://generativelanguage.googleapis.com/v1beta/interactions"): True,
            ("POST", "https://api.openai.com/v1/chat/completions"): True,
            ("POST", "https://example.org/v1/messages"): True,
            ("GET", "https://generativelanguage.googleapis.com/v1beta/models"): False,
            ("POST", "https://generativelanguage.googleapis.com/api/show"): False,
            ("POST", "https://example.org/upload"): False,
        }
        for (method, url), expected in cases.items():
            with self.subTest(method=method, url=url):
                self.assertEqual(gate.is_model_request(httpx.Request(method, url)), expected)


if __name__ == "__main__":
    unittest.main()
