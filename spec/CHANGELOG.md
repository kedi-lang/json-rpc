# Changelog

Version 1 is experimental; these are the changes made while it is developed in
[kedi-lang/kedi#197](https://github.com/kedi-lang/kedi/issues/197).

## Version 1

- Admission and approval: `governed`, `budget/admit`, `nativeTools`, `approval/request`
  (kedi#272).
- Unknown usage counts are unknown, not zero; token limits fail closed (kedi#273).
- Kedi-managed children: `subagents`, run lineage (kedi#274); `liveInput`, `run/input`,
  `interrupt`, `run/interrupt`, `-32006`, `usage`, `run/usage` (kedi#275).
- `settings`, `effort` and `modelFallback` (kedi#276).
- Frames end at LF only (kedi#277).
- `imageOutput`, `audioOutput`; media answers are `content` parts (kedi#279).
- Hooks: `hook/invoke`, and the run's hooked events (kedi#280).
- MCP: `mcp.transports`, `mcpServers`, `artifact/admit` (kedi#281).
- A failing run carries the harness's error in `data.harness` (kedi#282).
- Transcript mode: `transcript`, `history`, `messages`, `media/get` (kedi#283).
- History processing: `processHistory`, `history/process`, `transcript` answers (kedi#284).
- Test model: `testModel`, `model/complete` (kedi#285).
- This specification and the JSON Schema move to kedi-lang/json-rpc.
