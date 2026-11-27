from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import threading
import tomllib
import unittest
from pathlib import Path

from bridges import Bypassing, Minimal

from kedi_bridge import (
    SDK_VERSION,
    ModelRequest,
    NativeToolCall,
    Run,
    cached_preflight,
    check_handshake,
    connect,
    describe,
    fingerprint,
    preflight,
)
from kedi_bridge.peer import Peer

HERE = Path(__file__).resolve().parent
PYTHON = HERE.parent
REPO = PYTHON.parent
HANDSHAKES = json.loads((REPO / "fixtures" / "handshake" / "v1.json").read_text("utf-8"))
RUN = {
    "callKind": "invoke", "promptKind": "raw", "model": "m", "system": None, "instructionParts": [], "user": "Hi.",
    "userContent": None, "output": None, "tools": [], "continuation": None, "session": None, "subagent": None,
}


def pipe_pair():
    read, write = os.pipe()
    return read, os.fdopen(write, "wb", buffering=0)


class Wire:
    """A bridge on one end, a Kedi peer on the other, in-process."""

    def __init__(self, bridge) -> None:
        self.to_bridge_read, self.to_bridge = pipe_pair()
        self.from_bridge_read, self.from_bridge = pipe_pair()
        self.connection = connect(bridge, self.to_bridge_read, self.from_bridge.write)
        self.kedi = Peer(self.from_bridge_read, self.to_bridge.write)

    def start(self) -> Peer:
        self.kedi.start()
        return self.kedi

    def close(self) -> None:
        self.kedi.close()
        self.connection.peer.close()
        for stream in (self.to_bridge, self.from_bridge):
            stream.close()
        for descriptor in (self.to_bridge_read, self.from_bridge_read):
            os.close(descriptor)


class HandshakeTests(unittest.TestCase):
    def test_every_shared_case_is_refused_as_kedi_refuses_it(self) -> None:
        for case in HANDSHAKES["cases"]:
            with self.subTest(case["name"]):
                codes = [diagnostic.code for diagnostic in check_handshake(case["handshake"])]
                self.assertEqual(codes, [case["refuses"]] if case["refuses"] else [])

    def test_a_misspelled_capability_is_reported(self) -> None:
        found = check_handshake({"backend": {"name": "x"}, "kind": "agent-harness", "capabilities": {"liveinput": True}})
        self.assertEqual(found[0].code, "KB008")


class PeerTests(unittest.TestCase):
    def _peer(self):
        read, kedi_side = pipe_pair()
        written: list[bytes] = []
        closed = threading.Event()
        peer = Peer(read, written.append)
        peer.on_close(lambda _error: closed.set())
        return peer, kedi_side, written, closed, read

    def test_frames_end_at_lf_only_so_separators_inside_strings_survive(self) -> None:
        peer, kedi_side, _written, _closed, read = self._peer()
        seen: list[dict] = []
        arrived = threading.Event()

        def take(params: dict) -> None:
            seen.append(params)
            arrived.set()

        peer.on_notification("note", take)
        peer.start()
        text = "a b c\rd"
        kedi_side.write(json.dumps({"jsonrpc": "2.0", "method": "note", "params": {"text": text}}, ensure_ascii=False).encode() + b"\n")
        self.assertTrue(arrived.wait(5))
        self.assertEqual(seen, [{"text": text}])
        kedi_side.close()
        os.close(read)

    def test_a_line_that_is_not_json_ends_the_connection_with_a_parse_error(self) -> None:
        peer, kedi_side, written, closed, read = self._peer()
        peer.start()
        kedi_side.write(b"not json\n")
        self.assertTrue(closed.wait(5))
        self.assertEqual(json.loads(written[0])["error"]["code"], -32700)
        kedi_side.close()
        os.close(read)

    def test_a_frame_over_the_limit_ends_the_connection(self) -> None:
        peer, kedi_side, _written, closed, read = self._peer()
        peer.start()

        def flood() -> None:
            try:
                kedi_side.write(b"x" * (8 * 1024 * 1024 + 70000))
            except OSError:
                pass

        threading.Thread(target=flood, daemon=True).start()
        self.assertTrue(closed.wait(10))
        self.assertTrue(peer.ended)
        os.close(read)

    def test_an_unknown_method_is_answered_method_not_found(self) -> None:
        wire = Wire(Minimal({"testModel": True}))
        kedi = wire.start()
        with self.assertRaises(Exception) as caught:
            kedi.request("nope", {}).result(timeout=5)
        self.assertEqual(getattr(caught.exception, "code", None), -32601)
        wire.close()


class PreflightTests(unittest.TestCase):
    def test_a_bridge_that_routes_its_model_requests_through_the_sdk_passes_what_it_declares(self) -> None:
        report = preflight(Minimal({"testModel": True, "governed": True, "usage": True, "tools": True}, on_input=True))
        self.assertEqual(report.diagnostics, [], describe(report))
        self.assertIn("governed-admits-each-request", report.passed)
        self.assertIn("usage", report.passed)
        self.assertEqual(sorted(name for name, _ in report.skipped), [
            "compaction", "events", "history-processing", "interrupt", "interrupt-session", "interrupt-transcript",
            "live-input", "media-input", "model-fallback", "structured", "transcript",
        ])

    def test_declared_live_input_that_never_reaches_the_model_is_an_error_with_the_fix(self) -> None:
        report = preflight(Minimal({"testModel": True, "governed": True, "subagents": True, "liveInput": True, "tools": True}))
        live = next((diagnostic for diagnostic in report.diagnostics if diagnostic.code == "KB106"), None)
        self.assertIsNotNone(live, describe(report))
        assert live is not None
        self.assertRegex("\n".join(live.detail), r"KB201: live input arrived, but the run has no run\.on_input handler")
        self.assertEqual(len(report.diagnostics), 1, describe(report))

    def test_a_bridge_that_calls_its_model_around_the_sdk_fails_governance_and_the_test_model(self) -> None:
        report = preflight(Bypassing({"testModel": True, "governed": True, "tools": True}))
        codes = [diagnostic.code for diagnostic in report.diagnostics]
        self.assertIn("KB100", codes, describe(report))
        self.assertIn("KB104", codes, describe(report))

    def test_a_handshake_that_breaks_a_rule_is_reported_without_running_fixtures(self) -> None:
        report = preflight(Minimal({"testModel": True, "liveInput": True}))
        self.assertEqual([diagnostic.code for diagnostic in report.diagnostics], ["KB002"])
        self.assertEqual(report.passed, [])

    def test_without_a_test_model_the_fixtures_are_skipped_with_a_warning_not_passed(self) -> None:
        report = preflight(Minimal({}))
        self.assertEqual([(d.code, d.severity) for d in report.diagnostics], [("KB090", "warning")])
        self.assertEqual(report.passed, [])


class PackageTests(unittest.TestCase):
    def test_the_version_constant_matches_pyproject(self) -> None:
        project = tomllib.loads((PYTHON / "pyproject.toml").read_text("utf-8"))
        self.assertEqual(SDK_VERSION, project["project"]["version"])

    def test_the_embedded_fixtures_match_fixtures_v1(self) -> None:
        check = subprocess.run([sys.executable, str(PYTHON / "scripts" / "sync_fixtures.py"), "--check"], capture_output=True, text=True)
        self.assertEqual(check.returncode, 0, check.stderr)


class CacheTests(unittest.TestCase):
    def _entry(self) -> Path:
        directory = Path(tempfile.mkdtemp(prefix="kedi-bridge-"))
        (directory / "pyproject.toml").write_text("")
        (directory / "bridge.py").write_text("# v1\n")
        return directory / "bridge.py"

    def test_an_unchanged_bridge_replays_its_result_and_a_changed_one_is_checked_again(self) -> None:
        cache = Path(tempfile.mkdtemp(prefix="kedi-cache-"))
        entry = self._entry()
        bridge = Minimal({"testModel": True})
        first = cached_preflight(bridge, str(entry), cache)
        second = cached_preflight(bridge, str(entry), cache)
        self.assertFalse(first.cached)
        self.assertTrue(second.cached)
        self.assertEqual(second.passed, first.passed)
        entry.write_text("# v2\n")
        self.assertFalse(cached_preflight(bridge, str(entry), cache).cached)

    def test_a_failed_check_replays_the_same_diagnostics_without_checking_again(self) -> None:
        cache = Path(tempfile.mkdtemp(prefix="kedi-cache-"))
        entry = self._entry()
        bridge = Minimal({"testModel": True, "governed": True, "subagents": True, "liveInput": True, "tools": True})
        first = cached_preflight(bridge, str(entry), cache)
        replayed = cached_preflight(bridge, str(entry), cache)
        self.assertTrue(first.diagnostics)
        self.assertTrue(replayed.cached)
        self.assertEqual(replayed.diagnostics, first.diagnostics)
        self.assertIn("cached: the bridge is unchanged", describe(replayed))

    def test_the_fingerprint_never_reaches_above_the_bridges_own_directory(self) -> None:
        home = Path(tempfile.mkdtemp(prefix="kedi-home-"))
        (home / "pyproject.toml").write_text("")
        (home / "notes.txt").write_text("v1")
        installed = home / "registry" / "hermes"
        installed.mkdir(parents=True)
        (installed / "bridge.py").write_text("# bridge\n")
        bridge = Minimal({"testModel": True})
        before = fingerprint(bridge, str(installed / "bridge.py"))
        (home / "notes.txt").write_text("v2")
        (installed / "unrelated.txt").write_text("beside the bridge, not declared")
        self.assertEqual(fingerprint(bridge, str(installed / "bridge.py")), before)

    def test_the_fingerprint_covers_the_files_a_bridge_declares_present_or_missing(self) -> None:
        installed = Path(tempfile.mkdtemp(prefix="kedi-bridge-"))
        (installed / "bridge.py").write_text("# bridge\n")
        bridge = Minimal({"testModel": True})
        bridge.files = ["model.bin"]
        entry = str(installed / "bridge.py")
        missing = fingerprint(bridge, entry)
        (installed / "model.bin").write_text("v1")
        present = fingerprint(bridge, entry)
        (installed / "model.bin").write_text("v2")
        self.assertEqual(len({missing, present, fingerprint(bridge, entry)}), 3)

    def test_the_fingerprint_covers_the_handshake(self) -> None:
        entry = str(self._entry())
        self.assertNotEqual(
            fingerprint(Minimal({"testModel": True}), entry), fingerprint(Minimal({"testModel": True, "usage": True}), entry)
        )


INITIALIZE = {"id": 1, "method": "initialize", "params": {"protocolVersion": 1, "client": {"name": "test"}}}


def exchange(script: str, frames: list[dict], answers: int | None = None) -> tuple[list[str], str, int]:
    """Starts a test bridge, sends frames, and collects what it writes until it exits: stdin closes
    once ``answers`` frames arrived."""
    wanted = len(frames) if answers is None else answers
    env = {**os.environ, "KEDI_BRIDGE_PREFLIGHT": "always", "PYTHONPATH": os.pathsep.join([str(PYTHON / "src"), str(HERE)])}
    child = subprocess.Popen(
        [sys.executable, str(HERE / script)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env
    )
    assert child.stdin and child.stdout and child.stderr
    for frame in frames:
        child.stdin.write(json.dumps({"jsonrpc": "2.0", **frame}).encode() + b"\n")
    child.stdin.flush()
    lines: list[str] = []
    while len(lines) < wanted:
        line = child.stdout.readline()
        if not line:
            break
        lines.append(line.decode().rstrip("\n"))
    child.stdin.close()
    child.wait(timeout=60)
    stderr = child.stderr.read().decode()
    child.stdout.close()
    child.stderr.close()
    return lines, stderr, child.returncode


class ServeTests(unittest.TestCase):
    def test_a_bridge_that_fails_its_preflight_refuses_initialize_with_the_diagnostics(self) -> None:
        stdout, stderr, code = exchange("refused_bridge.py", [INITIALIZE])
        answer = json.loads(stdout[0])
        self.assertEqual(answer["error"]["code"], -32603)
        self.assertRegex(answer["error"]["message"], r"KB002 liveInput is declared without subagents")
        self.assertRegex(answer["error"]["message"], r"--check")
        self.assertEqual(answer["error"]["data"]["diagnostics"][0]["code"], "KB002")
        self.assertRegex(stderr, r"error\[KB002\]: liveInput is declared without subagents")
        self.assertEqual(code, 1)

    def test_whatever_the_harness_prints_goes_to_stderr_and_stdout_carries_only_frames(self) -> None:
        run = {"id": 2, "method": "run", "params": {"runId": "r", **RUN}}
        stdout, stderr, _code = exchange("noisy_bridge.py", [INITIALIZE, run])
        for line in stdout:
            json.loads(line)
        for printed in ("harness banner on stdout", "raw descriptor write", "child process output", "harness log during a run"):
            self.assertIn(printed, stderr)
        self.assertEqual(json.loads(stdout[1])["result"], {"text": "real model"})


class ModelRequestTests(unittest.TestCase):
    def test_a_summary_request_is_admitted_and_tagged_takes_no_history_processing_and_gets_its_counts(self) -> None:
        class Summarizing:
            files: list[str] = []
            handshake = {"backend": {"name": "s"}, "kind": "agent-framework", "capabilities": {"governed": True, "sessions": True, "testModel": True}}

            def run(self, run: Run) -> dict:
                reply = run.model_request(ModelRequest(
                    send=lambda _model, _run: {"text": "unused", "counts": {}},
                    describe=lambda: {"system": "Summarize.", "messages": [], "tools": [], "output": None},
                    reply=lambda message, counts: {"text": message["parts"][0]["text"], "counts": counts or {}},
                    purpose="compaction",
                ))
                return {"text": json.dumps(reply)}

        wire = Wire(Summarizing())
        asked: list[str] = []
        kedi = wire.kedi
        kedi.on_request("budget/admit", lambda params: (asked.append(f"admit {params['dimension']}"), {"admitted": True})[1])
        kedi.on_request("history/process", lambda params: (asked.append("history/process"), {"messages": []})[1])
        kedi.on_request("model/complete", lambda params: (
            asked.append(f"model/complete {params.get('purpose')}"),
            {"message": {"role": "assistant", "parts": [{"type": "text", "text": "A summary."}]}, "usage": {"inputTokens": 7}},
        )[1])
        wire.start()
        kedi.request("initialize", {"protocolVersion": 1, "client": {"name": "test"}, "testModel": True}).result(timeout=5)
        answer = kedi.request("run", {"runId": "r", **RUN, "processHistory": True}).result(timeout=10)
        wire.close()
        self.assertEqual(json.loads(answer["text"]), {"text": "A summary.", "counts": {"inputTokens": 7}})
        self.assertEqual(asked, ["admit request", "model/complete compaction"])

    def test_a_native_tool_goes_through_hook_approval_admission_and_artifact_admission_in_order(self) -> None:
        class Tooling:
            files: list[str] = []
            handshake = {"backend": {"name": "t"}, "kind": "agent-harness", "capabilities": {"governed": True, "nativeTools": True}}

            def run(self, run: Run) -> dict:
                call = NativeToolCall("c1", "shell", {"command": "ls"}, risk="mutating")
                outcome = run.native_tool(call, lambda args, _run: f"ran {args['command']}")
                return {"text": json.dumps(outcome)}

        wire = Wire(Tooling())
        asked: list[str] = []
        kedi = wire.kedi

        def hook(params: dict) -> dict:
            asked.append(f"hook {params['event']}")
            return {"decision": "edit", "arguments": {"command": "ls -la"}} if params["event"] == "pre_tool_use" else {}

        def approve(params: dict) -> dict:
            asked.append(f"approval {params['arguments']['command']}")
            return {"decision": "allow"}

        def admit(params: dict) -> dict:
            asked.append(f"admit {params['dimension']}")
            return {"admitted": True}

        def artifact(params: dict) -> dict:
            asked.append("artifact")
            return {"result": "kedi-artifact:1"}

        kedi.on_request("hook/invoke", hook)
        kedi.on_request("approval/request", approve)
        kedi.on_request("budget/admit", admit)
        kedi.on_request("artifact/admit", artifact)
        wire.start()
        kedi.request("initialize", {"protocolVersion": 1, "client": {"name": "test"}}).result(timeout=5)
        run = {"runId": "r", **RUN, "hooks": ["pre_tool_use", "post_tool_use"], "admitResults": True}
        answer = kedi.request("run", run).result(timeout=10)
        wire.close()
        self.assertEqual(json.loads(answer["text"]), {"ok": True, "result": "kedi-artifact:1"})
        self.assertEqual(asked, ["hook pre_tool_use", "approval ls -la", "admit toolAttempt", "hook post_tool_use", "artifact"])


if __name__ == "__main__":
    unittest.main()
