# @kedi-lang/bridge

Write [Kedi](https://github.com/kedi-lang/kedi) JSON-RPC bridges in TypeScript. The SDK
speaks the [protocol](../../spec/protocol.md), runs the steps Kedi decides around each model
request and tool call, and checks the bridge before it serves: a capability the bridge
declares but does not implement is reported with what is wrong and how to fix it, and Kedi
is refused rather than served wrongly.

Status: experimental, not yet on npm; it follows protocol version 1 as it changes.

## A Bridge

```ts
import { serve } from "@kedi-lang/bridge"; // first: from here on, stdout carries only frames
import { createAgent } from "my-harness";

await serve({
  handshake: {
    backend: { name: "my-harness", version: "1.0.0" },
    kind: "agent-harness",
    capabilities: { tools: true, structuredOutput: true, governed: true, usage: true, testModel: true },
  },
  async run(run) {
    const agent = createAgent({ system: run.params.system });
    const reply = await run.modelRequest({
      send: (model, signal) => agent.complete({ model, signal }),
      describe: () => agent.requestInKediSchema(),
      reply: (message) => agent.replyFromKediSchema(message),
      usage: (reply) => reply.usage,
    });
    return { text: reply.text };
  },
});
```

`examples/chat.ts` is a complete bridge for OpenAI-compatible endpoints: Kedi's tools,
structured output, governed requests with fallbacks, sessions, transcripts with history
processing, live input and interrupts, usage, and the test model.

## What the SDK Does

| Call | Runs, in order |
|---|---|
| `run.modelRequest(request)` | live input (`run.onInput`), `history/process` when asked, `budget/admit` per model tried (fallbacks included), the request (or `model/complete` in test mode), `run/usage`, `delivered` answers |
| `run.nativeTool(call, execute)` | `pre_tool_use`, `approval/request` (again when edited arguments are riskier), `budget/admit`, the call, `post_tool_use` or `post_tool_use_failure`, `artifact/admit` |
| `run.callTool(id, name, args)` | `tool/call`: Kedi runs one of its tools with the program's hooks, approval and budgets |
| `run.signal` | aborts on `run/cancel` and `run/interrupt`; every SDK wait races it, so a stop answers `-32003` or `-32006` |
| `run.onInterrupt(snapshot)` | what an interrupted attempt hands back: `{state}`, `{messages}` or `{transcript}` |

Errors the harness throws reach Kedi with its type, message and cause chain, in
`data.harness`.

## The Preflight

`serve()` checks the bridge before it serves:

1. **The handshake**: the capability rules Kedi enforces (`liveInput` needs `subagents`,
   `mcp` needs `nativeTools`, …), misspelled capabilities, Kedi's own settings.
2. **The behavior**: with `testModel`, the [conformance fixtures](../../fixtures/v1) run
   in-process against the bridge's own `run`, its model scripted by each fixture. A fixture
   runs when the bridge declares its capabilities.

```text
error[KB106]: live input does not reach the next model request
  │  fixture live-input: Input sent while the run runs reaches the next model request, and is acknowledged delivered.
  │  the run answered an error, -32002: KB201: live input arrived, but the run has no run.onInput handler, expected {"text":"Blue it is."}
  │  no run/input answer held {"delivered":true}
  │  model request 2 did not carry "Use the blue one."
  = help: register run.onInput and add each text as a user turn; run.modelRequest answers it delivered
  = docs: https://github.com/kedi-lang/json-rpc/blob/main/spec/protocol.md#8-children-and-live-input

kedi bridge check: 7 passed, 1 failed, 5 skipped (interrupt-session: needs interrupt, sessions; interrupt: needs interrupt; structured: needs structuredOutput; transcript: needs transcript; usage: needs usage)
```

A bridge that fails answers `initialize` with the diagnostics, so Kedi reports them instead
of a closed connection.

The result is cached under a fingerprint of the bridge's package (its files and lockfile),
the SDK, the fixtures and the handshake. An unchanged bridge starts without checking again,
and one that failed prints the same diagnostics again without rerunning them.

| Option | |
|---|---|
| `node bridge.ts --check` | run the preflight, print the report, exit 0 or 1 |
| `serve(bridge, { preflight: "always" })` or `KEDI_BRIDGE_PREFLIGHT=always` | check on every start |
| `preflight: "off"` | only the handshake's checks |
| `KEDI_BRIDGE_CACHE` | where results are cached (default `~/.cache/kedi/bridge-checks`) |

## Development

Node 22.18 or newer runs the TypeScript sources directly.

```sh
npm install
npm run check   # tsc
npm test        # node --test
python ../../testing/fake_kedi.py --bridge "node examples/chat.ts" ../../fixtures/v1/*.json
```
