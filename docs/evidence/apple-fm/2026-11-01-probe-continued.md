# AF0 Apple Foundation Models live probe

Status: **blocked**.

Input policy: synthetic inputs and model `system`; the unknown-model test uses an invented identifier.
The server was invoked with `serve --socket` in an owned 0700 temporary directory.
The probe never runs licence commands or changes Apple Intelligence settings.

Evidence: [this run](./2026-11-01-probe-continued.json) and the unchanged [stopped run](./2026-11-01-probe.md) ([original JSON](./2026-11-01-probe.json)). The controller corrected its exit-code interpretation.
Platform: macOS 27.2, build 26B123; arm64.
Node: v24.21.0. Source base: ae9c37f897832b7f18fed20ec793932ecfe755ca.

| Observation | HTTP | Format | DONE | Usage | Log probabilities | ms |
| --- | --- | --- | --- | --- | --- | --- |

Exact response events, error objects, CLI output and measurement limits are in the adjacent JSON.

Stopped at **serve-and-protocol**: fm socket readiness timeout

Remaining measurements:

- Model-unavailable error: Apple Intelligence is available; its settings are not changed for a probe.
- Licence-unagreed state: no licence command is run and the accepted licence is not altered.
- Exact 4096-token boundary: overflow supplies a lower bound, not an exact window proof.
- Delayed idle unloading and system model-service RSS; ps measures the CLI process only.

Cleanup: {"directServerReaped":true,"temporaryDirectoryRemoved":true}.
