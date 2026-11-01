# AF0 Apple Foundation Models live probe

Status: **observed**.

Input policy: synthetic inputs and model `system`; the unknown-model test uses an invented identifier.
The server was invoked with `serve --socket` in an owned 0700 temporary directory.
The probe never runs licence commands or changes Apple Intelligence settings.

Evidence: [this run](./2026-11-01-probe-full.json) and the unchanged [stopped run](./2026-11-01-probe.md) ([original JSON](./2026-11-01-probe.json)). The controller corrected its exit-code interpretation.
Platform: macOS 27.2, build 26B123; arm64.
Node: v24.21.0. Source base: 86a0023c853d6ec709281e51f330ad1ae174bda3.

| Observation | HTTP | Format | DONE | Usage | Log probabilities | ms |
| --- | --- | --- | --- | --- | --- | --- |
| health | 200 | json | false | false | false | 10.5 |
| models | 200 | json | false | false | false | 2.0 |
| stream-omitted | 200 | sse | true | false | false | 398.3 |
| stream-false | 200 | json | false | true | false | 212.4 |
| usage | 200 | sse | true | true | false | 209.8 |
| usage-disabled | 200 | sse | true | false | false | 208.5 |
| completion-token-field | 200 | sse | true | false | false | 207.0 |
| latency-1 | 200 | json | false | true | false | 208.9 |
| latency-2 | 200 | json | false | true | false | 211.1 |
| latency-3 | 200 | json | false | true | false | 208.0 |
| latency-4 | 200 | json | false | true | false | 207.6 |
| latency-5 | 200 | json | false | true | false | 204.5 |
| latency-6 | 200 | json | false | true | false | 228.0 |
| latency-7 | 200 | json | false | true | false | 205.8 |
| latency-8 | 200 | json | false | true | false | 205.7 |
| latency-9 | 200 | json | false | true | false | 204.8 |
| latency-10 | 200 | json | false | true | false | 209.5 |
| latency-11 | 200 | json | false | true | false | 205.6 |
| latency-12 | 200 | json | false | true | false | 208.2 |
| concurrency-2 | 200 | sse | true | false | false | 258.2 |
| concurrency-1 | 200 | sse | true | false | false | 332.3 |
| json-schema | 200 | sse | true | false | false | 359.0 |
| tools | 200 | sse | true | false | false | 511.3 |
| forced-tool | 200 | sse | true | false | false | 466.2 |
| parallel-tools | 200 | sse | true | false | false | 800.4 |
| logprobs | 200 | sse | true | false | false | 219.5 |
| unknown-model | 400 | json | false | false | false | 0.8 |
| overflow | 200 | sse | true | false | false | 4725.5 |

Exact response events, error objects, CLI output and measurement limits are in the adjacent JSON.

First inference: 398.3 ms; warm p95: 228.0 ms (12 observations).
This first request is not evidence of a cold OS cache or an unloaded system model.

Remaining measurements:

- Model-unavailable error: Apple Intelligence is available; its settings are not changed for a probe.
- Licence-unagreed state: no licence command is run and the accepted licence is not altered.
- Exact 4096-token boundary: overflow supplies a lower bound, not an exact window proof.
- Delayed idle unloading and system model-service RSS; ps measures the CLI process only.

Cleanup: {"directServerReaped":true,"temporaryDirectoryRemoved":true}.
