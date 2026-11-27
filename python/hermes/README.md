# Hermes Agent bridge

A Kedi JSON-RPC bridge for [Hermes Agent](https://github.com/NousResearch/hermes-agent) (Nous
Research, MIT), written with the [Python SDK](../README.md). Status: in progress
([kedi-lang/kedi#197](https://github.com/kedi-lang/kedi/issues/197), phase 5 B). It is tested
with Hermes **v0.23.4**.

```kedi
> agent: rpc:
    command: python /path/to/bridge.py
> model: gemini/gemini-3.5-flash-lite
```

`> model:` names a Hermes provider and model as `provider/model`. Hermes resolves the provider's
credentials from its environment variables (`GEMINI_API_KEY`, `OPENROUTER_API_KEY`, ...), as it
does for its own sessions.

## How it works

- **The model gate.** Hermes retries and falls back inside its provider call: a failed streamed
  request is sent again without streaming. So the bridge admits model requests at the wire.
  - **Where it sits.** It wraps httpx's transports, which carry every physical request any
    Hermes client makes.
  - **Admission.** Each model request (a POST to a chat completions, messages or responses
    path) is admitted with `budget/admit` before it is sent.
  - **Test mode.** Kedi's test model answers the request, and nothing leaves the process.
  - **Which run.** A request belongs to the run whose thread sent it, or to the run its
    `X-Kedi-Run` header names.
  - **Refusals.** A model request that belongs to no run is refused. A denial is an HTTP 400,
    which Hermes does not retry, and the run ends with Kedi's reason.
- **Kedi's tools.** Kedi's tools join a tool scope of the run's own (`session_tool_scope`),
  exactly as Kedi rendered them, and their calls go to Kedi with `tool/call`. Hermes's Tool
  Search bridge is off, so the model sees them directly.
- **Isolation.** The bridge gives Hermes a `HOME` and `HERMES_HOME` of its own, so no user
  plugin, skill, memory, context file or session reaches a run.
  - **What it turns off.** Automatic compression and retries of side calls are off.
  - **Where the home lives.** The home is temporary per process. `KEDI_HERMES_HOME` keeps it in
    a directory you choose.
- **Hermes's system prompt.** Hermes keeps its own identity and runtime environment text
  around Kedi's system text, as a harness does.
- **Sessions.** State mode: `state` holds Hermes's messages, and the next turn continues from
  them.

## Capabilities

`tools`, `nativeToolCalling`, `structuredOutput`, `governed`, `sessions`, `usage`, `testModel`.
It passes 9 conformance fixtures and skips 10, for capabilities still to come:
- native tools, MCP and media input;
- transcript mode and history processing;
- live input and interrupts;
- compaction;
- model fallback;
- Hermes's own subagents (`delegate_task`), governed with `subagent/admit` (phase 5 B).

## Development

Hermes v0.23.4 installs from its lockfile, on Python 3.14:

```sh
git clone --depth 1 --branch v0.23.4 https://github.com/NousResearch/hermes-agent
cd hermes-agent && UV_PROJECT_ENVIRONMENT=/path/to/venv uv sync --frozen --no-dev --python 3.14
cd -
PYTHONPATH=../src /path/to/venv/bin/python bridge.py --check
PYTHONPATH=../src python ../../testing/fake_kedi.py --bridge "/path/to/venv/bin/python bridge.py" ../../fixtures/v1/*.json
```
