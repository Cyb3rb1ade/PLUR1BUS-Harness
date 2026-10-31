# V2 shared protocol SSE writer

The A2A bridge will write every success/error frame through `ProtocolSseWriter`, retaining SDK-compatible JSON serialization, headers, extension headers and the initial non-stream JSON error behavior. The common writer owns drain, heartbeat and disconnect; its abort-aware iterator wait prevents a disconnected response from waiting for a stalled producer.

V2 is isolated from the pending V1 validation in `codex/v2-shared-sse`, based on main #834. It changes no RPC/config schema, dependency or Rust source. Existing streaming tests remain unchanged.

- [ ] Add SDK byte-parity coverage for task, message, status and artifact events in A2A 1.0 and legacy 0.3, plus error frames.
- [ ] Demonstrate a failing regression for a disconnect while the producer's next item is pending.
- [ ] Route the bridge through the common writer and add an abort-aware iterator wait there; catch asynchronous iterator-close failures.
- [ ] Verify unchanged streaming tests, the complete API suite, lint and docs checks.
- [ ] Obtain one independent final read-only review, address findings, commit and publish a ready V2 PR without merging.
