# @plur1bus/hostctl

Local-only D106 extensions for file, process, system, application and clipboard control. No listener, remote server or MCP transport. Every registered operation uses the Harness ToolDispatcher and D109; roots and credential deny paths are checked independently at execution time.

See [hostctl documentation](../../docs/hostctl.md). Build: `pnpm --filter @plur1bus/hostctl build`. Offline tests: `pnpm --filter @plur1bus/hostctl test` (Vitest). Tests use temporary synthetic files and fake policy/process/platform ports; the optional native Trash smoke is opt-in.
