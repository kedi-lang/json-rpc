# Kedi JSON-RPC

The bridge protocol of [Kedi](https://github.com/kedi-lang/kedi): how Kedi runs an
agent framework or harness written in any language, over JSON-RPC 2.0 on the bridge's
stdio.

Kedi renders every model-visible text and keeps its guarantees: run budgets, approvals,
hooks, subagent limits, history, artifacts. A bridge transports Kedi's requests to its
backend and asks Kedi before every step a budget or permission can stop. In Kedi the
other side is `JsonRpcAdapter`; see
[JSON-RPC Bridges](https://kedi-lang.github.io/kedi-docs/adapter-development/json-rpc-bridges/).

## Layout

| Directory | Contents |
|---|---|
| `spec/` | The protocol, versioned, with its changelog |
| `schema/` | JSON Schema for every message; the TypeScript and Rust types are generated from it |
| `fixtures/` | Language-neutral conformance scenarios (`v1/`) and handshakes (`handshake/`), shared with Kedi's tests and the SDKs |
| `testing/` | A fake Kedi to test and preflight bridges against |
| `ts/sdk/` | The TypeScript bridge SDK: `serve()`, preflight checks, diagnostics |
| `ts/pi/` | The bridge for the [pi](https://pi.dev) coding agent, on pi's TypeScript SDK |
| `packages/pi/` | The `pi` Kedi package: `> import: pi`, then `> agent: pi` |
| `python/` | The Python bridge SDK (`kedi-bridge`): the same `serve()`, preflight and diagnostics, standard library only |

The reference bridge for OpenAI-compatible endpoints ships with Kedi
(`kedi/agent_adapter/adapters/jsonrpc/openai_chat_bridge.mjs`).

## Status

Protocol version 1 is experimental: it may change without a compatibility promise until
Kedi marks it stable. Design and progress:
[kedi-lang/kedi#197](https://github.com/kedi-lang/kedi/issues/197) (protocol),
[#278](https://github.com/kedi-lang/kedi/issues/278) (TypeScript SDK).

## License

Apache-2.0.
