# Tool reliability libraries (M2)

D97/D103/D105 live in `packages/core/src/toolcall/` and `packages/core/src/triage/`. The 2026-10-16 Draft stack (#536 → #540 and its L11 follow-up) binds persistent capability discovery and one decision-role triage call to composition. The central dispatcher remains authoritative. M2 acceptance 14 is partial: the real-Core next-turn skill test and recorded triage gates pass, while live-model acceptance and the listed lifecycle/task-owner gaps remain open. No new RPC method is added by this stack.

## Validation and one repair

`prepareCall(name, inputSchema, argumentsRaw, repairPort?, modelFamily?)` returns a discriminated
result: `ok` with validated arguments, or a typed `tool-call-invalid` error with
JSON pointers, expected constraints and observed values. It never executes a tool.
The existing `ValidationIssue`, `RepairRequest`, `ToolCallInvalid`, provider tool
definition/call types and dispatcher error vocabulary are imported, not copied.

The local validator supports object/array/scalar/nullable types, properties,
required, closed or schema-valued additional properties, items, enum (including
structured values), const, anyOf/oneOf/allOf, numeric bounds/multipleOf, Unicode
string lengths/patterns, item/property bounds and unique items. Unknown schema
keywords fail registration/compilation; references and format validators are not
supported. It rejects nonfinite numbers, cycles and exotic objects and bounds
argument text to 256 KiB, value depth to 64 and value nodes to 20,000. Schemas have
a depth limit of 32. This is an explicit subset, not a general JSON Schema engine.

Before requesting model repair, JSON-string wrapping, trailing commas and numeric
strings at explicitly numeric schema fields can be repaired deterministically.
The scanner respects quoted strings and escapes. Every change records its kind
and pointer. It does not invent missing values, discard unknown fields or change
arrays into objects. Valid arguments go through unchanged.

On failure, the injected model repair port receives the arguments, issues and a
precise correction message. There is at most one invocation. The returned value
is parsed, normalized and validated again. A failed/throwing repair becomes
`tool-call-invalid`, without propagating a provider stack or executing the tool.
The caller applies cancellation and provider deadlines to this port.

## Provider dialects and quirks

`compileDialect` emits OpenAI Chat's nested `function`, Responses' flat function,
Anthropic's `input_schema`, or Gemini's `parametersJsonSchema` declaration. It is
pure and preserves the authored input. Independent JSON goldens cover each wire.
Names are validated before calls (character set, maximum length); descriptions
and catalogue lengths are bounded. Dotted internal names need a reversible wire
alias supplied by the future adapter binding; they are refused here.

The family table in `quirks.ts` supplies strict/parallel support, catalogue budgets,
name/description rules and known malformed argument forms. The repair driver uses the selected
family repertoire and includes it in correction hints. `local-small` has a
smaller catalogue; unknown families conservatively allow four tools and no
parallel/strict calls (not yet enforced for a family name that is also an `Object.prototype` member such as `constructor` or `toString`: the inherited member is returned as the quirks object, so the limits do not apply and `prepareCall` throws a `TypeError`). These are conservative library defaults, not live vendor
limits or certifications; deployments can maintain explicit model-family rows.

OpenAI strict mode requires closed object schemas and makes every property
required. Authored optional properties become nullable. The integration must
map null placeholders for originally optional fields back to absence before
validating against the original schema. `restoreStrictArguments` supplies this conversion; authored nullable fields
keep their null values. Strict mode is refused for the other families in this
library. Gemini reductions move unsupported constraints into descriptions and
record each removed keyword and path. The original validator remains authoritative:
provider schema reduction never loosens execution validation. Unsupported local
schema vocabulary is rejected instead of silently stripped.

## Results, concurrency and idempotency

`capResult(value, fullResultPort, maxBytes?)` defaults to 32 KiB, a conservative
byte budget for the spec's 8k-token target. A real tokenizer can supply a smaller
budget at integration time; byte counts are not exact token counts. JSON results
remain structurally valid. Oversized, binary and nonserializable values become
opaque full-result references. The store port owns retention, access controls,
continuation/cursor reads and binary metadata. Exceptions become a structured
`tool-failed` hint without their message/stack.

`executeBatch` runs contiguous parallel-safe groups concurrently. Unsafe calls
are barriers, and results remain in request order. The injected executor must
apply the existing dispatcher/policy gate to every call. SHA-256 idempotency keys
include scope, name and recursively canonicalized finite JSON arguments. Not yet enforced: the key joins scope and operation ID with `:` without escaping, so scope `a:b` with operation `c` and scope `a` with operation `b:c` share one key, and a cached, approved result can be served to a call in another scope without a new approval. Use scopes and operation IDs that contain no `:`. Set
scope to the authenticated agent/session/logical task; `operationId` distinguishes
intentional repeated actions with identical arguments. Retried logical operations
must reuse scope and operation ID. The in-memory port coalesces duplicates within
and across batches when reused. Supply a durable transactional port to prevent
repeat effects across crashes; in-memory coalescing is not exactly-once execution.
Failed operations are retained too, since an error may occur after a side effect.

## Capability registration, search and routing

`CapabilityIndex` accepts tools, skills, MCP tools, extensions, plugin commands and
channel actions. Rows include identity/version/source, description, category,
up to two secondary categories, useWhen/notFor/input hints, effect and risk.
Effect/risk use the existing D109 types. Search is lexical BM25 with an optional
embedding-score port, filters and deterministic ID tie breaking. Every hit lists
matched terms, category and embedding reasons. No network service is needed.
`capabilitiesSearch(index, query, filters)` is the method-shaped library port for
future `capabilities.search`; no RPC schema is changed.

`connect(registrationPort)` remains the library snapshot/event port. `SqliteCapabilityRegistry` now persists rows, per-agent counters, canonical SHA-256 hashes, literal-token FTS5 and vectors keyed by row hash plus local model identity. A changed row invalidates its vector; a late vector cannot overwrite a newer row. `LiveCapabilityIndex` owns this service for the composition lifetime and derives each agent view from currently admitted tool registrations. Persisted foreign rows never make a tool visible. Skills use `skills/index.json`, bounded ordinary files and blocked/pinned selections; the read-only supervisor feed consumes `ext.watch`/`ext.changed` and refreshes effective enable/overlay/agent state via `ext.list`. Folder changes and every new turn refresh skill truth. A lost supervisor feed fails closed.

Only the engine's already-ready, explicitly local embedding provider is used. The index does not start a model/download or admit a cloud provider. Missing/failed local embedding keeps FTS5 routing alive; Doctor exposes the current mode and last recheck. Plugin commands/channel actions may supply discovery metadata through the common registry, without new implementations owned by this stack. Generated fallback fields are marked; authored metadata wins. Model-generated summaries and full-source background snapshots remain open.

`capabilities.search` is a dispatcher-only in-process tool, distinct from RPC methods. It searches the same agent view and can add discovered tools to the next model round. It uses an unweighted discovery index, so a negative usage prior cannot hide a tool. All calls continue through current policy/roots/approval checks; argument-dependent denials are determined only when arguments exist.

The registered system job `capabilities.recheck` runs at 03:00 host-local time, removes orphaned skill rows and recalibrates usage priors. File defaults are in `toolcall/calibration.defaults.json`; `<home>/capability-calibration.json` overrides them and is reloaded at recheck. Owner-approved values: minimum 10 effective offers, per-agent statistics with same-name/kind/version global fallback, maximum +0.2 bonus / −0.2 penalty, 14-day half-life (hourly UTC buckets), reset on version change or removal. The current success target/weight are 0.8/0.5 and search-miss weight 0.1. Priors affect ranking only after visibility/policy filtering. Legacy counters without timestamps do not train decayed priors. Review these values after about four weeks of Nightly data. The fixed-clock calibration and policy-precedence tests are in `test/toolcall/live-index.test.ts`.

Routing distributes a default 12 slots across at most three categories using
largest remainders (70/30 gives 8/4), ranks within categories and fills unused slots
from global search. Low confidence reserves representation for supplied categories
and advises `capabilities.search`. The same intent/distribution/budget and index
revision reuse the previous shortlist; registration changes invalidate it.
`categories.ts` defines 90 stable category descriptions, whose serialized prefix
is independent of installation order. Custom categories remain searchable and may
be supplied by a classifier. The index is discovery, not permission authorization;
the registration binding must exclude agent-forbidden administrative surfaces.

## Message triage

`triage(message, options)` is a pure classification boundary; the default classifier
recognizes English/German intents and explicit task connectors, semicolons and
list/newline boundaries. It preserves task spans, records dependencies for explicit
"then/danach" connectors and returns category/model-class distributions,
confidence, chosen class, effort and reasons. It does not split ordinary "and"
inside a task. This baseline is intentionally limited; `triageWithClassifier`
accepts an asynchronous LLM decision port and validates its structured result.
Short yes/no/continue followups in an active task skip classification.
The classifier now rejects missing/non-array task lists with the documented validation error and fractional offsets before routing. Its segmentation regex avoids quadratic whitespace backtracking; the existing long-input/generative assertions remain active. `MessageTriage` additionally checks runtime shape/task consistency, bounds decision time, and fails to the default/core-only path on invalid/unavailable/timeout responses while propagating caller cancellation.

Production composition uses `modelRoles.decision` once per message through the same auth/router/budget/privacy/usage path; context sizing does not classify again. The role sees only the current message as data and no tools or recalled/session text. `chat` and failures use the agent default plus the core discovery surface. Explicit internal task boundaries hold class, effort and the resolved profile; followups retain the preceding class. Absent boundary metadata, a new non-followup message is treated as a boundary. Multi-task turns currently use the highest recommended class serially. Provider reasoning effort has no normalized wire field yet and is recorded, not enforced at vendors.

Class selection chooses the smallest class with above-class probability <= .2
(balanced), .35 (economy) or .1 (quality); confidence below .5 raises it one class.
`classes.defaults.json` maps provider families to profile labels, not guaranteed live model
IDs. `resolveClass` respects provider order and an explicit allowed-profile set;
unavailable classes return undefined, with no silent downshift. `escalate` raises
one class only when the caller's already-escalated flag is false; frontier is capped.
The caller persists that flag; no new verification/escalation owner is introduced here. `applyAtBoundary` changes the active class only at
an explicit task boundary. Runtime profile mappings load from `<home>/model-class-profiles.json` at task boundaries, with live `decision.classProfiles` as fallback. Recommendations and file edits do not switch an active task.

## Tool eval

`EvalScenario` contains input, provider family, available tool/index rows, an
independent golden for calls/arguments/outcomes and task spans/category/minimum
class, needed routing IDs, and a fake model transcript. The 64 JSON fixtures cover
English/German single/multi tasks, chains, parallel transcripts, numeric/trailing
comma repair, one model repair, second failure, denied calls, tool failure and
search-plus-fetch research. Each catalogue has 43 entries including distractors.
Golden dialect tests check the wire declarations separately; execution concurrency,
idempotency and persistent updates have dedicated tests. The eval itself exercises
library boundaries, not the real dispatcher or vendor APIs.

The runner compares fake predictions with independent expected outputs; it never
uses goldens to produce a prediction. Wrong-model and wrong-classifier tests prove
that metrics fall. Metrics aggregate micro counts with reported denominators:

- Routing recall: needed IDs present / all needed IDs (gate >= 95%).
- Segmentation F1: 2 * exact matching spans / (predicted spans + golden spans)
  (gate >= .9; boundary matching is stricter than count-only matching).
- Under-provisioning: tasks below the golden minimum class, including missing tasks,
  / golden tasks (gate <= 5%). Over-provisioning is reported separately.
- Repair success: successful model repairs / model repair attempts. Intentional
  second-failure cases remain in the denominator; deterministic repairs are
  validated by their call goldens and dedicated repair-log tests.
- Scenario pass rate: scenarios meeting call, routing, segmentation, category and
  minimum-class goldens / all scenarios (fixture gate >= 95%).

`runEval` returns JSON; `markdownReport` renders Markdown. Live mode returns
`status: skipped` unless `PLUR1BUS_LIVE_EVAL=1`, then requires an explicit model port.
There is no implicit network client. Fixture pass rates do not imply live-model
quality or performance on arbitrary real messages.

Run from the repo root with Node 24.21 on PATH:

```sh
PLUR1BUS_EVAL_REPORT=/tmp/m2-tool-eval node --experimental-strip-types --conditions=source \
  --no-warnings=ExperimentalWarning --test --test-concurrency=1 \
  packages/core/test/toolcall/*.test.ts packages/core/test/triage/*.test.ts
pnpm typecheck
pnpm lint
```

The optional report prefix writes `.json` and `.md` from the test runner. No files
are written and no networking is performed by the fixture runner itself.

## Follow-ups (integration owners)

1. Turn loop: explicit task-owner boundary metadata, persisted verification/escalation state and provider effort enforcement remain; one bounded decision-role call and stable task profiles are bound by the 2026-10-16 Draft stack.
2. Tool registry/dispatcher: compile names/aliases at registration, bind live
   install/enable/disable events, gate every validated call with D109, pass existing
   structured error envelopes, and bind the full-result store/cursor authorization.
3. Provider adapters: consume compiled dialects and quirks, restore optional-null
   placeholders before validation, apply provider cancellation/deadlines, use the
   recommended catalogue budget and parallel setting, resolve real allowed profiles.
4. Index maintenance: full-source background lifecycle snapshots and summarize-role metadata generation remain; persistent FTS5/local-vector caches, skill rescans and bounded decaying priors are bound by the 2026-10-16 Draft stack.
5. Nightly live eval: explicitly opt in, provide model ports/default-model profiles,
   publish pass rates and label models below the 95% live gate as limited tool use.
   A controller-owned CI change is needed; this PR adds no workflow.
6. D109 effects: registration binds trusted capability/effect/risk metadata and
   excludes never/administrative capabilities; routing must never create grants
   or treat model classifications as authorization.

## D105 independent message replay (2026-10-16)

`test/fixtures/triage-message/` contains 72 distinct DE/EN messages with independent gold spans/categories/minimum classes and a recording of deterministic baseline replies. `triage/message-eval.ts` is separate from D106 `toolcall/eval.ts` and does not change its gate. Recorded results: 86/86 exact spans, F1 1.0, under-provisioning 0.0, 85/86 category matches. An all-chat classifier fails the regression gate. These are baseline recordings, not measured vendor answers. Live evaluation requires `PLUR1BUS_LIVE_TRIAGE_EVAL=1` plus `PLUR1BUS_TRIAGE_CLASSIFIER_MODULE`; only this new live test skips without opt-in. No live p95 or shipped-model quality is claimed.

## L11 boundary (2026-10-16)

The core records dispatcher execution metadata (identity/session/turn/call/tool/version/success only) in `state/skill-mining.sqlite`. The prepared miner reads only archived, exact-owner/agent/scope sessions, excludes incognito/failed/unverified operations, and emits inactive candidates with session IDs rather than content. It copies no arguments, outputs, titles or messages. A separate engine-backed artifact queue is required for production proposals; the pinned public `memory.propose/proposals.*` contract accepts shared-memory corrections only. `SkillMining.propose` therefore fails closed with existing `E_NOT_AVAILABLE`, and Doctor reports unavailable mining. The prepared system job is not registered/scheduled without an authorized scope and backend.

`ArtifactProvenance` and `SelfKnowledgePolicy` are tested library gates: unknown files are human, observed manual edits invalidate agent attribution, human changes become proposals, default self-knowledge approval persists as enabled, and only an owner/audited call may disable it. They do not yet intercept Dreams or all filesystem writers. L11 remains open until the additive engine contract, review RPC/CLI/UI, disabled X1 install and global protection binding exist. See `docs/superpowers/plans/2026-10-16-l11-contract-and-inventory.md`; no second proposal queue or engine internal import is used.
