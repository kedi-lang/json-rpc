# Changelog

Version 1 is experimental; these are the changes made while it is developed.

## Version 1

- Admission and approval: `governed`, `budget/admit`, `nativeTools`, `approval/request`.
- Unknown usage counts are unknown, not zero; token limits fail closed.
- Kedi-managed children: `subagents`, run lineage; `liveInput`, `run/input`,
  `interrupt`, `run/interrupt`, `-32006`, `usage`, `run/usage`.
- `settings`, `effort` and `modelFallback`.
- Frames end at LF only.
- `imageOutput`, `audioOutput`; media answers are `content` parts.
- Hooks: `hook/invoke`, and the run's hooked events.
- MCP: `mcp.transports`, `mcpServers`, `artifact/admit`.
- A failing run carries the harness's error in `data.harness`.
- Transcript mode: `transcript`, `history`, `messages`, `media/get`.
- History processing: `processHistory`, `history/process`, `transcript` answers.
- Test model: `testModel`, `model/complete`.
- Native compaction: `compaction` `{threshold}` in `initialize`, `compaction` `{mode, threshold}`
  in session runs; `model/complete` carries `purpose` and may answer with `usage`.
- Code mode: `codemode` `{language}` in `initialize`, `codemode: true` in runs whose program
  turns code mode on (`> codemode: enabled`), which runs the backend's own.
