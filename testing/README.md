# Testing Bridges

`fake_kedi.py` plays Kedi's side of the protocol against a bridge and runs the
conformance fixtures in `fixtures/v1/`:

```sh
python -m pip install "jsonschema>=4.23"
python testing/fake_kedi.py --bridge "node my_bridge.mjs" fixtures/v1/*.json
```

The bridge runs in test mode: it must declare `testModel`, and every model request comes
to the fake Kedi as `model/complete`, answered from the fixture's script. No model
endpoint, network or key is involved. Every frame, both directions, is checked against
`schema/v1/protocol.json`, then the fixture's expectations. A fixture whose capabilities the
bridge lacks is skipped and reported as skipped.

## Fixtures

A fixture is a JSON file:

| Field | Meaning |
|---|---|
| `name`, `description` | what it checks |
| `code`, `failure`, `help`, `spec` | the diagnostic a failure reports: its stable code, what is wrong, how to fix it, and the spec section |
| `capabilities` | what the bridge must declare for the fixture to run |
| `run` | `run` params; the fake Kedi fills in the rest (`user` defaults to `Hello.`) |
| `model` | the test model's replies, in order: assistant messages in Kedi's transcript schema (`{"parts": [...]}`); `done` once they run out |
| `tools` | Kedi's tools: `{"name": {"result": ...}}` or `{"name": {"error": "..."}}` for `tool/call` |
| `budget` | admissions left per `budget/admit` dimension (`request`, `toolAttempt`); then denied |
| `onModelRequest` | what the fake Kedi sends when model request N arrives, before answering it: `{"N": [{"send": "run/input", "items": [...]}]}`, `run/interrupt`, `run/cancel` |
| `expect` | what must hold once the run answers (below) |

| `expect` field | Holds when |
|---|---|
| `result` | the run's result contains these fields and values |
| `error` | the run answered an error containing these fields (`{"code": -32006}`) |
| `failed` | the run answered an error |
| `resultKeys` | the result has these fields |
| `errorDataKeys` | the run's error `data` has these fields |
| `modelRequests` | the bridge sent this many model requests |
| `modelSaw` | model request N carried a string containing this text |
| `order` | the bridge's requests include these methods in this order |
| `count` | the bridge sent this method this many times |
| `answers` | the bridge answered a request of this method with a result containing these fields |

Kedi's `kedi adapter check` and the TypeScript SDK's preflight run the same fixtures.
