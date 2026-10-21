import test from "node:test";

// Phase Q inventory: explicit missing acceptance, not bypasses of existing tests.
test.todo("Q/config: source-level settings persist across restart with bounded trace expiry and live reload");
// Q/MCP is closed: packages/core/test/mcp/stderr-d111.test.ts (real stdio children, a real core.out writer and log file; this root
// directory is run by no package script, and the test needs the MCP fixture server that lives with the core tests).
test.todo("Q/supervisor: D111 writer parity, trusted attribution, trace, live levels and child-output redaction");
test.todo("Q/spec-section-8: named D111 suite passes on all five native release targets");
