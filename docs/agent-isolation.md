# Agent isolation and provisioning

The core owns one process-wide `AsyncLocalStorage` AgentScope. Collaboration uses that same context. Turn workers establish it with the agent's workspace before invoking providers, tools or the engine memory port; maintenance checkpoints establish it explicitly. The memory port rejects absent and mismatched scopes before touching storage. A worker thread starts with an empty context and must establish a trusted scope itself. No worker falls back to the `main` agent.

The explicit-agent control plane remains outside this worker context: authenticated administration enumerates agents and manages records by their explicit IDs and RBAC. An ALS context carries runtime identity, not a substitute for authorization. The accepted same-OS-user trust boundary is unchanged.

| Subsystem | Per agent? | Mechanism |
|---|---|---|
| Config, persona, behaviour | Yes | Directory and explicit configuration entry per agent |
| Sessions, transcripts | Yes | Agent-keyed records; sessions are the unit of replay |
| Memory store, pools | Yes | Engine identity and workspace/user pool keys; turn-memory port requires matching scope |
| Secret scope | Yes | Scope identifies the agent; unscoped worker access is refused; global secret administration remains Owner-only |
| Tool registry | Yes | Global immutable catalogue with per-turn agent view |
| MCP clients | Yes | Agent allowlist selects clients; discovery metadata may be cached globally |
| Terminal environment/backend | Yes | Constructed child allowlist and agent variables |
| Budgets, rate limits, approvals | Yes | Explicit agent-keyed counters/state |
| Embedding/rerank model cache | No | Shared service, separated by embedding identity |
| HTTP listener, process lock, OS process | No | One daemon; API authorization provides the boundary |
| Native model runtime/addons | No | Shared ONNX/LanceDB runtime |

The Agents UI publishes the per-agent/process-global categories in English and German.

An external ACP agent does not share the caller's tool process. Its file and terminal calls are limited to the provisioned worktree. Seatbelt denies new hard links. A regular file that already has more than one name refuses the session and `terminal/create`. The measurement and the residual (a process outside the sandbox) are in `docs/research/2026-10-29-m6b-external-agent-spike.md`.

On Linux, an external ACP sandbox uses bubblewrap with its own user and PID namespaces and drops capabilities. The inner helper requires an enforced `RLIMIT_NPROC`; `tasksStep` sets it to `maxTasks + 1` to allow for bubblewrap's namespace-init task. The configured limit covers payload tasks, including threads and unreaped children, while the extra init task also consumes a kernel slot. Linux applies this resource limit to the real user ID's task accounting in the user-namespace hierarchy; it is not a cgroup or an unconditional per-sandbox counter. The helper checks for a different user namespace and the backend probes actual enforcement; ACP refuses when the required protection is unavailable. Other limits in the hierarchy can constrain a run sooner.

When the limit is reached, the kernel prevents a further fork with `EAGAIN`. The target may handle that error and continue or exit successfully; Linux does not turn it into `task-limit-exceeded`. On macOS the watchdog samples the target's process group and descendants and, when it measures too many tasks, kills the group and returns `task-limit-exceeded` (exit 121). Sampling can allow brief overshoot. A future separately reviewed Linux design could use a delegated cgroup v2 `pids.max` and `pids.events` to provide a unified typed outcome; the current sandbox does not use that mechanism.

## Creation protocol

`agent.create` accepts an optional idempotency key. The browser always supplies one key per attempt and reuses it after a lost response. Keys are bound to the authenticated actor and canonical request digest. Reusing a key for different input returns `E_CONFLICT`; a completed retry returns the original agent ID and `replayed: true`.

The steps are an engine runtime reservation, private files, Config-owner registration, and person rights. A private fsynced intent journal records every attempted effect before it runs. Failed steps undo rights, config, files and the runtime reservation in reverse order, including effects applied before a lost response. Config compensation checks the expected agent configuration and uses compare-and-set against the supervisor. It never overwrites a concurrently changed record.

Provisioning agents remain paused until a durable completion marker exists. Activation is separately acknowledged in the journal. Startup compensates incomplete sagas before serving, or completes activation of a committed saga that crashed before publication. Failed compensation blocks startup rather than silently serving partial agents. Existing import recovery semantics are retained.

The engine exposes `open` and `close`, not identity creation/erasure. Reservation and compensation mean opening/closing the runtime handle. No claim of physical memory-namespace erasure is made; provisioning admits no turns or captures. Existing populated identities and hard delete stay fail-closed until an engine erasure API exists.

## Model licences

Memory and voice confirmations share the private durable model licence ledger. Entries contain the authenticated person, server time, licence, model, artifact revision or voice byte digests, and source. The audit is written before acceptance is stored. `model.licence.list` exposes records to authorized administration; no client can supply its recorded identity or timestamp.

The Memory wizard confirms NC choices before saving configuration. The HTTP config proxy checks subsequent NC selections against the actor's exact model/revision acceptance. Engine configuration also verifies persistent acceptance at startup, covering local CLI/config-file edits. Unknown revisions cannot reuse an older confirmation. Jina v5 uses the pinned retrieval artifact; the unpinned base selection is refused.

Non-interactive setup explicitly selects MIT multilingual E5-small when no embedding configuration exists. Reruns preserve existing embedding model/provider/dimensions instead of changing the store identity without validated re-embedding; an unconfirmed NC selection still fails the core licence gate. A legacy blanket acceptance flag never selects an NC model unattended. The Memory wizard never reports a model as chosen that the engine does not run: it reads the running models with `model.memory.status` and writes the chosen embedding model and reranker into `engine.embedding` and `engine.reranker`, the blocks the engine is built from. Another embedding model is written only while the store holds no table; the step comes before the first agent is created, because creating an agent creates its table. Once there is data, the API's `config.set` pre-check (`model.licence.check`) refuses another embedding identity with `E_CONFLICT` `embedding-migration-required`, and moving the store is `plur1bus memory reembed` (or `plur1bus config set engine.embedding…`), which copies, validates and switches. A local model the engine does not pin (the Qwen3 entries of ADR-006's catalogue) is not offered and is refused by the same check. Licence confirmation itself does not migrate data.
