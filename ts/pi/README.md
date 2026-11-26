# pi Bridge

Runs Kedi on the [pi](https://pi.dev) coding agent, through pi's TypeScript SDK
(`@earendil-works/pi-coding-agent` 1.5.2) and the [bridge SDK](../sdk).

```kedi
> agent: rpc:
    command: node path/to/ts/pi/bridge.ts --cwd ./workspace
> model: google/gemini-3.5-flash-lite
> approval: allow
[summary] << Read note.txt with your read tool and repeat its first sentence.
= <summary>
```

Models are named `provider/model` from pi's catalog, with pi's own credentials: the
providers' environment variables (such as `GEMINI_API_KEY`) or `~/.pi/agent/auth.json`.

## How Kedi's Guarantees Hold

| Kedi | In pi |
|---|---|
| Every model request admitted (`governed`), counted (`usage`), scriptable (`testModel`) | the session's stream function is wrapped, so pi's retries, compaction and internal calls pass through it too; pi's own retries and auto-compaction are off |
| pi's tools (read, bash, edit, write) under Kedi's hooks, approval and budgets (`nativeTools`) | an inline extension's `tool_call` and `tool_result`: risk `read_only` for read, `mutating` for edit and write, `sensitive` for bash; an edit replaces the arguments pi runs |
| Kedi's tools | pi custom tools that call `tool/call` |
| Structured output (`nativeStructuredOutput`) | a pi tool named after the output, whose arguments are the answer; a JSON text answer is accepted too |
| Live input, interrupts | steering messages, `session.abort()` |
| `> effort:` | pi's thinking level (`minimal` to `max`), clamped to the model |
| `> settings:` | `temperature` and `max_tokens`, which every pi provider applies alike; Kedi refuses other names |
| Media input | images, base64 or fetched from their URL; each request carries the user turn in Kedi's order (pi itself sends text, then images) |
| Events | `message.delta` as the model streams, `message.completed` with `commentary` beside tool calls and `final` for the answer |
| Sessions | the session's entries are the state Kedi hands back |
| Model-visible text is Kedi's | no discovered extensions, skills, prompt templates or context files (AGENTS.md); Kedi's system text follows pi's own prompt; Kedi's text is never run as a pi command or template |

A step Kedi denies ends the run with Kedi's error, and pi makes no request after it.

## Checks

```sh
npm install
npm run check        # tsc
npm test             # pi's tools take Kedi's steps in order
node bridge.ts --check
python ../../testing/fake_kedi.py --bridge "node bridge.ts" ../../fixtures/v1/*.json
```

## Distribution

`npm run build` bundles the bridge, the SDK and pi into one file, `dist/bridge.mjs`
(about 10 MB), that needs only Node 22.18 or newer: `node dist/bridge.mjs` serves Kedi
with no `node_modules`. The bundle carries the conformance fixtures, so its preflight runs
wherever it is copied.

Not yet: transcript mode, MCP servers, model fallback.
