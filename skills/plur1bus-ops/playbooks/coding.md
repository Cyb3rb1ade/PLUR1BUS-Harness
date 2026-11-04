# Coding CLI diagnostics

Use this playbook when `plur1bus code` cannot open a session, stream events or complete a card. The coding CLI uses the running core. It creates no extra daemon.

1. Read `plur1bus 1staid check --json` and `plur1bus daemon status --json` if the error is `E_CORE_UNAVAILABLE`. Follow the existing diagnosis/repair ladder for an unhealthy unit.
2. Check that PATH is the native Git worktree root and the agent is registered. For a card, verify the project membership, current agent assignment and shared worktree with the project commands. A stored session's root is immutable.
3. Treat `E_APPROVAL_REQUIRED` as a permission result. An interactive native CLI can ask once for a Core-created request on the exact recursive worktree root, then uses `approval.decide` with OS confirmation, limited to this session. `grant.create` is not this flow. Home/drive/system roots, protected Harness paths, helper delegation and `always` stay refused. A binding does not replace a grant; a daemon restart does not grant access. ACP and scripts refuse an ungranted root.
4. Use `--json` for automated diagnostics. Read `code.event/1` lines and the final CLI error. A noninteractive run denies every approval. Never fabricate terminal answers or use `--yes` as a tool/folder approval; it confirms model switches only.
5. An interrupted event link reconnects, replays durable session events and reconciles pending approvals. If recovery fails, keep the reported session ID and reopen with `--session`. Do not resubmit a task whose RPC result is uncertain; read the session first.
6. `/check` and direct-session `/done` are advisory. A card's `/done` invokes the complete D98 gate. Read its checks and review result before diagnosing a refusal. Uncommitted verifier conventions cannot enable network access.
7. Steering, queue management and Rewind require advertised core capabilities. Retain an unsent draft when the core lacks them. Inspect the version/capabilities instead of sending unknown slash commands to the model.

The profile can be enabled for ordinary sessions with `agents.<id>.coding`; apply the live setting through `plur1bus config set`. It changes the fixed operating guide and tool offers while preserving D109 permissions. Coding sessions and D115 project-card sessions select it automatically.

Escalate a native-platform input or terminal-restoration problem with OS/terminal versions and the non-secret session ID. Do not include core tokens, raw private tool bodies or complete configuration files in a report. Local fixture results do not establish the B1 benchmark delta or native Windows acceptance.
