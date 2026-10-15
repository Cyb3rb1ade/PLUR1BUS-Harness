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

## Creation protocol

`agent.create` accepts an optional idempotency key. The browser always supplies one key per attempt and reuses it after a lost response. Keys are bound to the authenticated actor and canonical request digest. Reusing a key for different input returns `E_CONFLICT`; a completed retry returns the original agent ID and `replayed: true`.

The steps are an engine runtime reservation, private files, Config-owner registration, and person rights. A private fsynced intent journal records every attempted effect before it runs. Failed steps undo rights, config, files and the runtime reservation in reverse order, including effects applied before a lost response. Config compensation checks the expected agent configuration and uses compare-and-set against the supervisor. It never overwrites a concurrently changed record.

Provisioning agents remain paused until a durable completion marker exists. Activation is separately acknowledged in the journal. Startup compensates incomplete sagas before serving, or completes activation of a committed saga that crashed before publication. Failed compensation blocks startup rather than silently serving partial agents. Existing import recovery semantics are retained.

The engine exposes `open` and `close`, not identity creation/erasure. Reservation and compensation mean opening/closing the runtime handle. No claim of physical memory-namespace erasure is made; provisioning admits no turns or captures. Existing populated identities and hard delete stay fail-closed until an engine erasure API exists.

## Model licences

Memory and voice confirmations share the private durable model licence ledger. Entries contain the authenticated person, server time, licence, model, artifact revision or voice byte digests, and source. The audit is written before acceptance is stored. `model.licence.list` exposes records to authorized administration; no client can supply its recorded identity or timestamp.

The Memory wizard confirms NC choices before saving configuration. The HTTP config proxy checks subsequent NC selections against the actor's exact model/revision acceptance. Engine configuration also verifies persistent acceptance at startup, covering local CLI/config-file edits. Unknown revisions cannot reuse an older confirmation. Jina v5 uses the pinned retrieval artifact; the unpinned base selection is refused.

Non-interactive setup explicitly selects MIT multilingual E5-small when no embedding configuration exists. Reruns preserve existing embedding model/provider/dimensions instead of changing the store identity without validated re-embedding; an unconfirmed NC selection still fails the core licence gate. A legacy blanket acceptance flag never selects an NC model unattended. `model.embedding.select` prevents the Memory wizard from reporting success with a different active embedding. It accepts the already-active model, or uses the existing validated migration driver when the engine exposes generation validation. Unsupported targets and missing validation produce explicit actionable failures, leaving the Memory step unfinished. The pinned engine supports E5 and the pinned Jina targets, but currently lacks public generation validation and rejects the EmbeddingGemma 2/Qwen3 catalogue targets. This includes empty generations: a zero-row plan is not a concurrency-safe substitute for validation. Choose the already-active E5 model explicitly, or update the engine and use the migration workflow. Licence confirmation itself does not migrate data.
