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
| Every model request admitted (`governed`), counted (`usage`), scriptable (`testModel`) | the session's stream function is wrapped, so pi's retries, compaction and internal calls pass through it too; pi's own retries are off, and its compaction follows the program's policy |
| pi's tools (read, bash, edit, write) under Kedi's hooks, approval and budgets (`nativeTools`) | an inline extension's `tool_call` and `tool_result`: risk `read_only` for read, `mutating` for edit and write, `sensitive` for bash; an edit replaces the arguments pi runs |
| Kedi's tools | pi custom tools that call `tool/call` |
| Structured output (`nativeStructuredOutput`) | a pi tool named after the output, whose arguments are the answer; a JSON text answer is accepted too |
| Live input, interrupts | steering messages, `session.abort()` |
| `> effort:` | pi's thinking level (`minimal` to `max`), clamped to the model |
| `> fallback:` | each fallback model tried in turn, each request admitted; pi resolves the fallback's credentials |
| Every model request governed | pi's prompt cache warming, which would send requests past Kedi, is off |
| `> settings:` | `temperature` and `max_tokens`, which every pi provider applies alike; Kedi refuses other names |
| Media input | images, base64 or fetched from their URL; each request carries the user turn in Kedi's order (pi itself sends text, then images) |
| Events | `message.delta` as the model streams, `message.completed` with `commentary` beside tool calls and `final` for the answer |
| Sessions | the session's entries are the state Kedi hands back |
| `compaction_mode: native` (`compaction: {threshold: true}`) | pi's own session compaction, off unless the program sets a policy. A threshold is pi's reserve below the model's context window: once the context passes it, pi summarizes what lies beyond the most recent half of the threshold, mid-turn or after it, and the compacted session is the state Kedi hands back. Each summary request is admitted and counted, reaches a test model with `purpose: "compaction"`, and reports no event |
| `> codemode: native` (`codemode: {language: javascript}`) | pi's `codemode` tool in its `only` mode: the model writes JavaScript for pi's QuickJS sandbox, and every tool (Kedi's, its servers', pi's own) is listed in the tool's description and taken out of the model's declarations, none left to `searchTools()`. A script's tool calls pass the same `tool_call` gate as direct ones, so hooks, approval and budgets apply. Scripts get no `models`: a classifier or image model call would be a request Kedi never admitted. Without it, `codemode` stays off |
| `> mcp:` servers | pi's MCP client, with no `mcp.json` of the machine: Kedi's servers connect as `s1`, `s2`, … over stdio or streamable HTTP, their tools declared directly as `mcp__s1__<tool>`; each call takes Kedi's steps as an MCP call under the server's own tool name, its risk from the server's hints (read-only, destructive); the servers stop when the run ends |
| Transcript, history processing | Kedi's transcript loads into the session (media by ref through `media/get`; a message Kedi did not change returns as pi wrote it, from `providerData`); with a history processor every request carries what it kept |
| Who the requests say they come from | `User-Agent: kedi-pi/<version>`, and kedi-pi as the attribution OpenRouter, NVIDIA NIM and OpenCode take; pi's own attribution and install report are off |
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
with no `node_modules`. Beside it goes `dist/photon_rs_bg.wasm`, with which pi converts and
resizes images; without it a turn's image cannot be sent, and the run fails saying so. The bundle carries the conformance fixtures, so its preflight runs
wherever it is copied.

