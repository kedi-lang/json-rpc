# Hermes Agent bridge

A Kedi JSON-RPC bridge for [Hermes Agent](https://github.com/NousResearch/hermes-agent) (Nous
Research, MIT), written with the [Python SDK](../README.md). It is tested with Hermes
**v0.23.4**.

```kedi
> agent: rpc:
    command: python /path/to/bridge.py
> model: gemini/gemini-3.5-flash-lite
```

`> model:` names a Hermes provider and model as `provider/model`. Hermes resolves the provider's
credentials from its environment variables (`GEMINI_API_KEY`, `OPENROUTER_API_KEY`, ...), as it
does for its own sessions. For a local or private endpoint, point `KEDI_HERMES_PROVIDERS` at a
YAML file with Hermes's `providers:` mapping (`providers.<name>.api`, `api_key`) and name it as
`<name>/<model>`; the bridge does not read your `~/.hermes/config.yaml`.

## How it works

- **The model gate.** Hermes retries and falls back inside its provider call: a failed streamed
  request is sent again without streaming. So the bridge admits model requests at the wire.
  - **Where it sits.** It wraps httpx's transports, which carry every physical request any
    Hermes client makes.
  - **Admission.** Each model request is admitted with `budget/admit` before it is sent. A model
    request is a POST to a chat completions, messages or responses path, or any POST to the
    host the run's model resolved to. That covers a provider's native API too, such as Gemini's
    `/interactions`, so the gate fails closed on a path it does not know.
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
  - **Where the home lives.** One home per process, removed at exit; a killed bridge's home is
    removed by the next bridge to start. Installed as a Kedi package, it lives in the package's
    runtime directory (`KEDI_PACKAGE_RUNTIME_DIR`), so `kedi remove` takes it with the package.
    `KEDI_HERMES_HOME` keeps it in a directory you choose.
- **Hermes's system prompt.** Hermes keeps its own identity and runtime environment text
  around Kedi's system text, as a harness does.
- **Sessions.** State mode: `state` holds Hermes's messages, and the next turn continues from
  them.

## Capabilities

`tools`, `nativeToolCalling`, `structuredOutput`, `governed`, `subagents` (Kedi's children
run as runs), `liveInput` (Hermes's steering: a user row after the current tool batch),
`interrupt`, `sessions`, `testModel`. It passes the conformance fixtures for these and skips
the others. It does not have:
- native tools, MCP and media input;
- transcript mode and history processing;
- events;
- per-request usage (`run/usage`). A streamed reply's counts arrive at its end, so the run
  reports Hermes's totals instead;
- compaction;
- model fallback;
- Hermes's own subagents (`delegate_task`).

## Development

Hermes v0.23.4 installs from its lockfile, on Python 3.14:

```sh
git clone --depth 1 --branch v0.23.4 https://github.com/NousResearch/hermes-agent
cd hermes-agent && UV_PROJECT_ENVIRONMENT=/path/to/venv uv sync --frozen --no-dev --python 3.14
cd -
PYTHONPATH=../src /path/to/venv/bin/python bridge.py --check
PYTHONPATH=../src:. /path/to/venv/bin/python -m unittest discover -s tests   # real mode against a stub upstream
PYTHONPATH=../src python ../../testing/fake_kedi.py --bridge "/path/to/venv/bin/python bridge.py" ../../fixtures/v1/*.json
```
