# Kedi JSON-RPC Bridge Protocol, Version 1

Status: experimental. Version 1 may change without a compatibility promise until Kedi
marks it stable. The shapes of every message are in
[`schema/v1/protocol.json`](../schema/v1/protocol.json); this document says what they mean.
"Must", "must not" and "may" are requirements on the side named.

## 1. Model

Kedi runs a **bridge**, a process that connects one agent framework or harness (the
backend) to Kedi. Kedi renders every model-visible text: system text, prompts, tool
descriptions, corrections. The bridge transports them to its backend and must not write
model-visible text of its own, except a harness's request-independent identity prompt.

Kedi owns the guarantees of a program: run budgets, approvals, hooks, subagent limits,
history, artifacts, media. Every step a budget or permission can stop is a request the
bridge sends **before** the step, and Kedi's answer decides whether the step runs.
Notifications only report what happened.

## 2. Transport

- JSON-RPC 2.0, one message per line on the bridge's stdin and stdout, UTF-8, at most
  8 MiB per line.
- A line ends at LF (`\n`) only. Kedi writes U+2028 and U+2029 unescaped, and a text may
  hold CR: a bridge must not split frames with a reader that also ends lines at those
  (Node's `readline`, Python's `str.splitlines()`).
- stdout carries only protocol frames. Logs and diagnostics go to stderr; Kedi quotes its
  last lines when a run fails.
- Both sides send requests. Each side answers the other's requests with the same `id`.
- A line that is not a JSON-RPC 2.0 object, or a line over the limit, ends the connection.
  Version 1 has no reconnect: the connection is the lease of everything tied to it.

## 3. Lifecycle

1. Kedi starts the bridge and sends `initialize`. It sends nothing else before the answer.
2. The bridge answers with its backend, `kind` and capabilities (section 4). Kedi refuses a
   handshake whose capabilities break a rule below, before any run.
3. Kedi sends `run` requests, possibly several at once. Each run has a `runId`; requests a
   bridge sends about a run name it, and are valid only while the run is in progress.
4. `shutdown` asks the bridge to finish; Kedi then closes stdin.

`kind` is `agent-framework` (a library that runs one model loop, such as an SDK) or
`agent-harness` (an agent with tools and state of its own). It selects defaults, such as
the history mode (section 7).

## 4. Capabilities

A capability left out is unavailable, and Kedi refuses before any model I/O a program that
needs it. A bridge must advertise only what it implements.

| Capability | The bridge promises |
|---|---|
| `structuredOutput` | answers `{data}` for a run with an output schema |
| `tools` | calls Kedi's tools with `tool/call` |
| `nativeStructuredOutput`, `nativeToolCalling` | sends Kedi's schema and tools as its backend's native fields; otherwise Kedi puts them in its own protocol text |
| `nativeTools` | runs tools of its own; each call goes through `hook/invoke`, `approval/request` and, with `governed`, `budget/admit`, and each result through `artifact/admit` |
| `events` | sends `run/event` while a run runs: `message.delta` as text streams, and `message.completed` with `phase: commentary` for the model's text beside its tool calls. A `final` completion is optional: Kedi reports the answer from the run's result |
| `mediaInput` | sends prompt media to its backend; needs `mediaKinds` |
| `sessions` | continues a conversation from the `state` Kedi hands back (state mode) |
| `transcript` | lets Kedi hold the conversation (transcript mode); asks `history/process` when told |
| `governed` | asks `budget/admit` before every model request its backend makes: retries, tool-loop turns and internal calls included |
| `subagents` | runs Kedi's children as runs; needs `governed` |
| `liveInput` | takes `run/input` for a running run; needs `subagents` |
| `interrupt` | stops an attempt on `run/interrupt`; needs `liveInput` |
| `usage` | sends `run/usage` for every model request |
| `modelFallback` | tries `fallbackModels` in order when a request fails, admitting each attempt |
| `imageOutput`, `audioOutput` | its model draws images or speaks |
| `testModel` | sends its model requests as `model/complete` when Kedi asks |

`initialize` also lists `mediaKinds`, the `settings` names and `effort` levels the backend
applies (never Kedi's own settings: `context_limit`, `media_limit`, `request_retries`,
`tool_reason`, `voice`), and `mcp.transports`, which needs `nativeTools`. `compaction`
`{threshold}` says the backend compacts its session natively, which needs `sessions`;
`threshold` says whether it honors an exact input-token threshold (§7). `codemode`
`{language}` says the backend has a code mode of its own, model-written `python` or
`javascript` that calls tools, which needs `tools` (§5).

## 5. Runs

A `run` carries the call as Kedi assembled it: `system` and `instructionParts`, `user` and
`userContent` (the user turn with its media where their labels put them), `output`,
`tools`, the profile's `model`, `fallbackModels`, `settings` and `effort`, and, as they
apply, `session`, `history`, `subagent` lineage, the hooked events, `mcpServers` and
`admitResults`.

The run answers with `text`, `data` (a structured run) or `content` (a media output), and
optionally `usage`, `state` (state mode) and `messages` or `transcript` (transcript mode).
When Kedi rejects an answer, it sends the same run again with `continuation`: the rejected
answer and Kedi's correction, for the bridge to replay as the model's turn and a user turn.

`run/cancel` stops a run; it answers with `-32003`. A run Kedi stopped itself (an exhausted
budget, a denied step) gets `run/cancel` after Kedi answered the request that stopped it.

**Native code mode** (with `codemode`). A run whose program asks for the backend's own code
mode (`> codemode: native`) carries `codemode: {mode: "native"}`. The bridge then:
- turns its backend's code mode on for the run, and offers Kedi's tools to the model's code
  only, not as tools of their own;
- sends each call the code makes as it would a direct one: Kedi's tools through `tool/call`,
  its own through the `nativeTools` steps (§6);
- gives the code no file, process, network or environment of the machine except through
  those tools.

Without the field, the backend's code mode stays off.

## 6. Steps Kedi Decides

| Request | Sent | Kedi's answer |
|---|---|---|
| `budget/admit` | before every model request (`request`) and every attempt of a bridge tool (`toolAttempt`) | `admitted`, or a denial with the dimension, reason and, for a run budget, `limit`, `consumed`, `scopeDepth`: the bridge skips the step and ends the run |
| `hook/invoke` `pre_tool_use` | before each call of a bridge tool, for the events the run's `hooks` lists | `continue`, `edit` with the arguments to run, or `deny` with a reason for the model |
| `approval/request` | before each call of a bridge tool, after its `pre_tool_use` | `allow`, `deny` with a reason, or `edit` with arguments; riskier edited arguments need another request |
| `artifact/admit` | after each call of a bridge tool, when the run's `admitResults` is true | the result to send the model: the result itself or Kedi's artifact reference |
| `history/process` | before each model request, when the run's `processHistory` is true | the conversation the program's processor kept |

`hook/invoke` also reports `post_tool_use` with the result and `post_tool_use_failure` with
`{type, message}`. A hook or processor that fails, or a cancelled approval prompt, stops the
run. A step Kedi is still deciding when the run ends is cancelled: its request is answered
with `-32003`.

`tool/call` runs one of Kedi's tools: Kedi applies the program's hooks, approval and budgets
itself. The answer is `{ok: true, result}` or `{ok: false, error}`, the error being for the
model to read.

## 7. History

**State mode** (`sessions`): a run in a conversation carries `session` `{id, turn, state}`,
`state` being what the bridge returned for the last committed turn. Kedi commits a turn's
`state` only after accepting its answer.

**Transcript mode** (`transcript`): Kedi holds the conversation. A run carries `history`,
the earlier messages in Kedi's schema (`TranscriptMessage`), and answers with `messages`,
the turn's new ones, the user turn included. Media is named by `ref` after the turn that
attached it; a bridge that lacks the bytes asks `media/get`. Kedi gives each message an
`id`; a bridge sends it back as given, and `providerData` too.

With a history processor, a run carries `processHistory: true`, the bridge asks
`history/process` before each model request, and the run answers with `transcript`, the
whole conversation after the turn.

Kedi uses transcript mode for an `agent-framework`, and for an `agent-harness` only when the
program needs Kedi's copy (history processing, replay). `history` travels in every run, so
a long conversation counts against the 8 MiB frame.

**Compaction** (with `compaction`, state mode only). A run with a `session` carries
`compaction: {mode, threshold}` when the program sets a policy.
- **`native`.** Compact the session as the backend does. When `threshold` is set, compact
  once the context passes that many input tokens. The answer's `state` is then the
  compacted session.
- **`disabled`, or no `compaction` field.** Keep the backend's automatic compaction off.

A summary request is a model request:
- it is admitted (`budget/admit`) and counted (`run/usage`) like any other;
- in test mode it goes as `model/complete` with `purpose: "compaction"`;
- it is no turn of the run, so it carries no live input and no `run/event` reports it.

Kedi refuses a `threshold` the bridge cannot honor, and native compaction in a program that
processes or replays history, before any model I/O.

## 8. Children and Live Input

With `subagents`, Kedi runs its children on the bridge as runs whose `subagent` names the
child, the bridge run whose tool call started it, the child's conversation and its
remaining limits. Kedi admits each of a child's requests against its limits.

With `liveInput`, `run/input` hands a running run input from its parent or a child. The
bridge adds each text as a user turn before its next model request and answers
`delivered: true` once a request carries it, or `false` if the run ends first.

With `interrupt`, `run/interrupt` stops the current attempt: the run answers `-32006`, in a
session with its state so far in the error's `data` (`state`, `messages` or `transcript`).
The task continues in another attempt; an interrupt is not a cancel.

## 9. Usage

A count left out is unknown, never zero. With `usage`, `run/usage` reports each model
request's counts as it completes, and Kedi checks a child's token limits as each arrives;
the run's `usage` is then ignored. A governed bridge's requests are counted at
`budget/admit`.

## 10. Test Model

With `testModel`, Kedi may ask in `initialize` for test mode. The bridge then sends each
model request, admitted as usual, as `model/complete`, with the conversation in Kedi's
schema (media may be inline), the system text, the tools and the output, and treats
Kedi's `message` as its model's reply. `purpose` is `compaction` for a summary request (§7)
and `turn` otherwise. The answer may carry `usage`, the counts the model would have
reported; the bridge takes them as its model's, so tests can drive thresholds and token
limits.

## 11. Errors

| Code | Meaning |
|---|---|
| `-32700`…`-32603` | JSON-RPC parse, request, method, params and internal errors |
| `-32001` | unsupported: the operation needs a capability that was not negotiated |
| `-32002` | the run failed in the backend |
| `-32003` | the run stopped after `run/cancel` |
| `-32004` | overloaded: no capacity for another request right now |
| `-32005` | unknown run: the `runId` names no run in progress |
| `-32006` | interrupted: the run stopped after `run/interrupt` |

A failing run should carry the harness's own error in `data.harness`, `{type, message,
cause?}`. Kedi quotes it with the bridge's last stderr lines, and keeps it behind its own
error when Kedi stopped the run.

## 12. Versioning

`protocolVersion` is an integer; both sides must refuse another version. Within version 1,
new optional fields and capabilities may be added. A side must ignore fields it does not
know, and must not rely on a capability the other side did not advertise.
