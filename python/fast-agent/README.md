# fast-agent bridge

A Kedi JSON-RPC bridge for [fast-agent](https://fast-agent.ai) (evalstate/fast-agent, Apache-2.0),
written with the [Python SDK](../README.md). It is tested with fast-agent **0.10.69**
(`fast-agent-mcp` on PyPI). The [`fast_agent` package](../../packages/fast_agent) installs it.

```kedi
> agent: rpc:
    command: python /path/to/bridge.py
> model: google/gemini-3.1-flash-lite-preview
```

fast-agent's own tools work in the bridge's current directory, or in `DIR` with
`python bridge.py --cwd DIR`.

`> model:` names a fast-agent provider and model as `provider/model`, as everywhere in Kedi:
`google/gemini-3.1-flash-lite-preview`, `anthropic/claude-haiku-4-5`, `openrouter/<model>`. The
bridge hands fast-agent its own `provider.model`; a name without a provider is refused.
fast-agent reads each provider's credentials from its environment variables (`GOOGLE_API_KEY`,
`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, ...). `GENERIC_BASE_URL` points the `generic` provider
(`generic/<model>`) at any OpenAI-compatible endpoint.

## How it works

- **One point for every model request.** Every request fast-agent makes passes
  `FastAgentLLM._execute_with_retry`, whichever provider and HTTP client (httpx or aiohttp) sends
  it. That point gets fast-agent's own messages, so the bridge sends each request through
  `Run.model_request` there:
  - Kedi admits it;
  - Kedi hands it live input and processed history;
  - in test mode Kedi's test model answers it.
- **Kedi owns retries.** These are off, so a request Kedi admits is one request:
  - fast-agent's own retries;
  - the OpenAI and Anthropic SDKs' retries;
  - the OpenAI providers' "send again" after an empty reply (once more, and without streaming).

  Anything else a provider would send inside one request is refused at the wire, because an
  admitted request makes one POST. A provider that tries fails visibly instead of sending a
  request Kedi never saw.
- **Kedi's text, as written.** fast-agent expands templates in an agent's instruction
  (`{{file:...}}`, `{{url:...}}`, `{{env}}`, ...). The bridge escapes every brace pair, so Kedi's
  system text reaches the model as written and no file or URL is read. The test model gets the
  system text fast-agent actually sends.
- **The tools, each under Kedi's steps.**
  - **Kedi's own tools.** They are the agent's tools, called back with `tool/call`.
  - **fast-agent's own tools**, as pi's are:
    - its file tools: `read_text_file` (and `attach_media`) at risk `read_only`, and
      `write_text_file` and `edit_file` at `mutating`;
    - its shell (`bash`, `execute`, `shell` or `exec`, by model) and `process` at `sensitive`.

    Each call goes through the `pre_tool_use` hook, approval, admission, the post hooks and
    artifact admission. Under `> approval: deny`, Kedi still allows `read_only` tools.
  - **Kedi's `> mcp:` servers.** They attach to the run's agent. Each call of their tools goes
    through the `pre_tool_use` hook, approval, admission, the post hooks and artifact admission.
    The servers' hints (read-only, destructive) decide the risk.
  - **What the servers cannot do.** They get no sampling and cannot ask the user anything:
    stdin is Kedi's protocol.
  - **No other tool.** A run whose agent offers the model any other tool is refused before its
    first request. That covers fast-agent's code tool outside code mode, its subagents, its
    image generation and its web search.
- **What is off by default.** fast-agent turns some features on by default. The bridge's home
  turns them off:
  - programmatic tool calling (its code mode), which is on for the GPT-6 Astra, Sol, Terra and
    Luna models, unless the program turns code mode on;
  - automatic compaction, the providers' in-request compaction included.

  A `ptc=` model query is refused.
- **Code mode.** With `> codemode: enabled`, the run turns fast-agent's own code mode on:
  - the model gets one tool, `exec_sandbox`, and writes Python that runs in fast-agent's Monty
    sandbox;
  - Kedi's tools, its servers' tools and fast-agent's own tools are the sandbox's functions, all
    of them upfront;
  - each call from code goes to Kedi as a direct call would, so the hooks, approval and budgets
    apply;
  - code reaches files and the shell only through those functions. With its shell on,
    fast-agent would let sandbox code open the machine's files itself, which the bridge turns
    off. The sandbox has no network or environment access.

  A run whose sandbox holds any other function is refused. The code tool's description is
  fast-agent's own text. Kedi's CodeMode settings (`> codemode:` with search or execution
  limits) do not apply to fast-agent's sandbox, so Kedi refuses them.
- **Structured answers.** A run with an output schema gives the model an output tool,
  `final_result`, as Kedi's own adapters do, not a forced JSON format: the model calls the
  tools it needs, then answers by calling it, and the turn ends there with no further request.
  An answer given as JSON text instead is taken too.
- **Provider errors.** fast-agent's app exits on a provider error it classes as a key error,
  which for Google is any API error, a 429 or 503 included. The run fails with the provider's
  message instead, and the bridge serves on.
- **Isolation.** The bridge gives fast-agent a home of its own. Installed as a Kedi package, the
  home is the package's runtime directory (`KEDI_PACKAGE_RUNTIME_DIR`). No user config, skill,
  plugin, card or session from `~/.fast-agent` reaches a run.
- **Media.** A turn whose images fast-agent would leave out, because its model cannot take them,
  fails rather than reaching the model without them.

## Capabilities

`tools`, `nativeToolCalling`, `nativeTools` with `mcp` (stdio, http, sse), `structuredOutput`,
`governed`, `testModel`, plus:
- **Children:** `subagents` (Kedi's children run as runs), `liveInput` (kept in the agent's
  history), `interrupt`.
- **History:** `sessions` (state mode), `transcript` (Kedi holds the conversation, history
  processing included), `compaction` (fast-agent's summary, at the program's exact threshold).
- **Reporting:** `usage` (per request), `events` (text deltas, commentary and the answer).
- **Settings:** `modelFallback`; `settings` (`temperature`, `max_tokens`, `top_p`); `effort`
  (`minimal` to `max`, as fast-agent's reasoning setting).
- **Media:** `mediaInput` (images).
- **Code:** `codemode` (`python`): `> codemode: enabled` runs fast-agent's own code mode.

It passes all 20 conformance fixtures.

**Not supported:**
- Copilot: its recovery writes prompts of its own.
- Images or speech from the model.

Kedi refuses `tool_attempt_limit` in a profile with `> mcp:` servers.

## Development

fast-agent 0.10.69 installs from the package's lock, on Python 3.13:

```sh
cd ../../packages/fast_agent/src/fast_agent && UV_PROJECT_ENVIRONMENT=/path/to/venv uv sync --frozen --no-dev
cd -
PYTHONPATH=../src /path/to/venv/bin/python bridge.py --check
PYTHONPATH=../src /path/to/venv/bin/python -m unittest discover -s tests   # real mode against a stub upstream
PYTHONPATH=../src python ../../testing/fake_kedi.py --bridge "/path/to/venv/bin/python bridge.py" ../../fixtures/v1/*.json
```
