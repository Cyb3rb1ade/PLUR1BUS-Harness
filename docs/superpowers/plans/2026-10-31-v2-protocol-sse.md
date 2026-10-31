# V2 shared protocol SSE writer

The A2A bridge will write every success/error frame through `ProtocolSseWriter`, retaining SDK-compatible JSON serialization, headers, extension headers and the initial non-stream JSON error behavior. The common writer owns drain, heartbeat and disconnect; its abort-aware iterator wait prevents a disconnected response from waiting for a stalled producer.

V2 is stacked on V1 #843 in `codex/v2-shared-sse`. Its diff against V1 changes no RPC/config schema, dependency or Rust source. Existing streaming tests remain unchanged.

- [x] Add SDK byte-parity coverage for task, message, status and artifact events in A2A 1.0 and legacy 0.3, plus error frames.
- [x] Demonstrate a failing regression for a disconnect while the producer's next item is pending.
- [x] Route the bridge through the common writer and add an abort-aware iterator wait there; catch asynchronous iterator-close failures.
- [x] Verify unchanged streaming tests, the complete API suite, lint and docs checks.
- [x] Obtain one independent final read-only review; no findings, and 15 focused checks independently passed.
- [x] Prepare the verified V2 diff for a normal push and a ready PR; the Controller merges pull requests.

Final local verification: API 1,063 passed, zero failures, two existing skips and two existing TODOs; real supervisor and HTTP/Core tests were required and ran with the built RPC 1.12 CLI/Core. `pnpm lint` and `pnpm docs:check` both exited zero. The existing A2A streaming and protocol route test files are unchanged. The independent reviewer also ran all 15 focused checks successfully.
