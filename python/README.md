# kedi-bridge

Write [Kedi](https://kedi-lang.org) JSON-RPC bridges in Python: the protocol, its checks and
diagnostics. It is the Python counterpart of [`@kedi-lang/bridge`](../ts/sdk), for harnesses
written in Python. It uses only the standard library, so it installs beside any harness's pinned
dependencies.

A bridge connects one agent framework or harness to Kedi. Kedi renders every model-visible text
and owns the program's guarantees (budgets, approvals, hooks, history). The bridge sends its
backend's model requests and tool calls through the steps Kedi decides. The protocol is in
[`spec/protocol.md`](../spec/protocol.md).

## A bridge

```python
from kedi_bridge import ModelRequest, Run, serve


class MyBridge:
    handshake = {
        "backend": {"name": "my-harness", "version": "1.0.0"},
        "kind": "agent-harness",
        "capabilities": {"tools": True, "governed": True, "testModel": True},
    }
    files: list[str] = []

    def run(self, run: Run) -> dict:
        messages = [{"role": "user", "parts": [{"type": "text", "text": run.params["user"]}]}]
        reply = run.model_request(ModelRequest(
            send=lambda model, run: my_harness_complete(model, messages),   # the real model
            describe=lambda: {"system": run.params["system"], "messages": messages, "tools": [], "output": None},
            reply=lambda message, usage: message,                          # the test model's reply
        ))
        return {"text": "".join(part["text"] for part in reply["parts"] if part["type"] == "text")}


if __name__ == "__main__":
    raise SystemExit(serve(MyBridge()))
```

- **Steps Kedi decides.** `Run.model_request` asks for admission (`budget/admit`), hands over
  live input, processes history, tries fallback models and reports usage. In test mode it sends
  the request to Kedi as `model/complete`.
- **Native tools.** `Run.native_tool` (or `before_native_tool` and `after_native_tool`, for a
  harness that runs its own tools) takes one of the bridge's own tools through the hooks,
  approval, admission and artifact admission.
- **Kedi's tools.** `Run.call_tool` calls them.
- **Threads.** The API is synchronous and thread-safe. A run blocks in `Bridge.run` while its
  control messages keep arriving, and `run.stopped` is set when Kedi cancels or interrupts it.

## Checks

`serve()` checks the bridge before it serves:

- **The handshake.** It is checked against the protocol's rules, with the same diagnostic codes
  Kedi uses (`KB001`…).
- **The conformance fixtures.** With `testModel`, the fixtures (`fixtures/v1`, embedded in the
  SDK) run in-process against the bridge.
- **Caching.** A result is cached under the bridge's fingerprint: the SDK, the fixtures, the
  handshake, the entry, the files the bridge declares and, when the entry's directory holds a
  `pyproject.toml`, the bridge's package.
- **Failure.** A bridge that fails still answers `initialize`, with its diagnostics, so Kedi
  reports them.

```sh
python my_bridge.py --check      # the preflight, as a report; exits 1 if it failed
```

`KEDI_BRIDGE_PREFLIGHT=always|cached|off` overrides the mode.

stdout carries only protocol frames. `serve()` sends everything else to stderr: Python's
`print`, writes to file descriptor 1, and subprocesses. Call `claim_stdout()` first if the
harness prints while it is imported.

## Development

```sh
PYTHONPATH=src:tests python -m unittest discover -s tests
python scripts/sync_fixtures.py --check            # the embedded fixtures match fixtures/v1
PYTHONPATH=src python examples/chat.py --check     # the example passes its preflight
PYTHONPATH=src python ../testing/fake_kedi.py --bridge "python examples/chat.py" ../fixtures/v1/*.json
```

The last command runs the fixtures over stdio and checks every frame against the schema. It
needs `jsonschema`.
