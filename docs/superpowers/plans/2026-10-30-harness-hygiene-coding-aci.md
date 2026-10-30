# Harness hygiene, steering, rewind and the coding ACI — implementation plan

**Goal.** Measure the prompt first (cache-hit rate, fixed overhead, cache-miss causes, a recorded `turn-eval-live`
baseline), then make large tool results an envelope instead of a failure, give our own agent a coding ACI (anchored edits,
a tree-sitter pre-write gate, outlines and symbol queries, crushed sensor output shared with the D98 gate), let people
steer running turns and rewind with a lesson, prove every tool execution passes the one gate, and prepare Phase 4, as
specified in [`2026-10-30-harness-hygiene-coding-aci-design.md`](../specs/2026-10-30-harness-hygiene-coding-aci-design.md)
(cited as "spec §n"; register entry D120 proposed).
**Architecture.** New components are Rust in one supervised module process, `plur1bus-tools` (`crates/plur1bus-tools`,
`x-server: "tools"`), called by the TypeScript core over the harness RPC (spec §5, §12.3); changes to existing TypeScript
(telemetry, turn loop, router, web, session store) stay TypeScript until their Phase 4 step (owner decision 3, spec §13).
**Status.** Plan only. Owner decisions of 2026-10-30 recorded (spec §2); Q1–Q19 open (spec §18), every package assumes the
recommendation until the owner answers. **Gate:** H2-3 (the baseline) lands before any package that changes behaviour;
every later package reports its delta against it in its PR (spec §6.4).
**Constraints.** JSON Schema stays the single source: every RPC addition carries `x-server`, `x-stability:
"experimental"`, `x-since` (the next free minor at implementation time) and closed params; every config key `x-restart`
and `x-tier`; no new RPC error codes (new reason strings only, in `docs/errors.md`); no network in tests (fake servers on
127.0.0.1 or injected ports); TDD (red test first); `erasableSyntaxOnly`; de/en catalogues complete for web strings.
Rust: `#![forbid(unsafe_code)]` in `plur1bus-tools`, the workspace clippy lints, no new crate without the gate of
`docs/dependency-policy.md` and `deny.toml`. `scripts/lint-hygiene.mjs` scans the new crate (no foreign-host idiom,
HYG-001). Secrets never cross into `plur1bus-tools`. **Every Rust package is done by a Claude agent, never Codex** (owner
preference). One branch and one ready PR per package; no CI polling (push, open the PR, report the number, stop); no
force-push, rebase, amend or stash; commits carry the owner's identity.

## Review focus

1. Nothing fails because a result is large; an envelope is always valid JSON; the degraded mode works with
   `plur1bus-tools` stopped (spec §5, §7.1, §7.7).
2. Artifacts are owner-private per session, redacted before they leave the core, never captured, never indexed, swept by
   retention and quota (spec §7.2, §7.6).
3. No Rust method mutates anything without a valid dispatcher ticket bound to the approved action hash (spec §11.2).
4. The syntax gate refuses only new errors in changed ranges and writes nothing on refusal (spec §8.4).
5. A steer never kills a running tool, every skipped call still gets a tool result on every wire, and a withdrawn
   approval never becomes a grant (spec §9.1, §9.4).
6. Rewind never rewrites messages or events; the hidden branch and its digest stay in the store and the audit chain
   (spec §10).
7. Every package's PR carries its delta against the H2 baseline (spec §6.4, §16).

## Dependencies and order

```text
WP0 owner answers, D120, ADR-019 text
 └─► H2-1 cache telemetry ─► H2-2 overhead + doctor rows ─► H2-3 live baseline (GATE) ─► H2-4 tool admission
                                                                   │
      ┌────────────────────────────────────────────────────────────┘
      ▼
 H1-1 plur1bus-tools skeleton ─► H1-2 artifact store ─► H1-3 crushers ─► H1-4 dispatcher integration + artifact.read
      │
      └─► C1 anchors + file.edit ─► C2 syntax gate + file.write ─► C3 outline + symbols
                                                                         │
 H3-1 steering core ─► H3-2 steering surfaces ◄───────────────────────────┘ (order only; no code dependency on C3)
      ▼
 C4 sensors + D98 (needs H1-3, H1-4) ─► H4 rewind with lesson ─► T1-a architecture test ─► T1-b Rust typestate
      ▼
 P4-spike (after T1-b; Phase 4 itself starts after RE-11)
 M6-Pi verification: independent, after PR #820 merges
```

The sequence follows the owner's order H2 → H1 → C1/C2 → C3 → H3 → C4 → H4 → T1 → P4-spike. Stack a PR on its
predecessor (`--base`) only where it needs that code: H1-2/H1-3 on H1-1, H1-4 on H1-2 and H1-3, C1 on H1-1, C2 on C1, C3
on C2, H3-2 on H3-1, C4 on H1-4, T1-b on C2.

---

## WP0 — Owner answers, register entry, ADR text (0.5 agent days; Claude, docs)

Record the owner's answers to Q1–Q19 in spec §18 and adjust the packages they change; enter D120 in the core spec's
register (`docs/superpowers/specs/2026-09-24-m1b-2a-core-daemon-cli-design.md` §2); write `docs/adr/ADR-019-rust-new-components-and-core-strangler.md`
from spec §13 (status Proposed until the owner accepts), add the amendment note to ADR-012's status line and after its
§2, and mark the RE-D9 row in `docs/superpowers/plans/2026-10-23-rust-engine-rewrite.md` §6 and in
`docs/superpowers/plans/rust-engine/README.md` as superseded by ADR-019. Tests: `node scripts/check-doc-links.mjs`,
`node scripts/lint-hygiene.mjs`. Acceptance: the owner's answers are in the spec, D120 is registered, ADR-019 exists.

## H2-1 — Cache telemetry read models and miss attribution (2 agent days; Sonnet, TypeScript) — first Sonnet package

Add a read model over the budget store's `usage_event` (per provider, agent and model, 24 h and 7 d windows,
token-weighted, estimated rows excluded and counted) in `packages/core/src/budget/cache-report.ts`; expose the existing
per-session `CacheTelemetry.summary` and that read model through a new core method `telemetry.cache.summary` (schema in
`packages/rpc-schema/schema/rpc.schema.json`, handler in `packages/core/src/rpc/`, read scope like `doctor.report`);
add miss attribution in `packages/core/src/prompt/telemetry.ts` (compare each render's `zoneHashes` with the previous
request of the same session and model; emit `prompt.cache-miss` with the cause list of spec §6.1 and per-cause counters in
the summary). No behaviour change, no new store. Tests (red first): attribution for each cause with fixture renders and
usage, the window maths against hand-computed rows, the RPC contract fixture, the no-I/O prompt test still green.
Docs: `docs/prompt-cache.md` (usage section, follow-up list), `docs/rpc.md` via `pnpm docs:gen`, the event in
`docs/log-schema.md` if the catalogue lists it. Acceptance: a fake-provider session with one admitted tool shows exactly one
`tools-changed` miss; `telemetry.cache.summary` returns per-provider and per-session ratios.

## H2-2 — Fixed overhead per agent and doctor rows (1.5 agent days; Claude agent, TypeScript + Rust)

Measure zones 1+2 and zone 3 per agent at render time (`packages/core/src/prompt/`, counted with `engine.tokens.count`
when the Rust engine serves it, chars/4 otherwise, with `method`), expose `telemetry.prompt.overhead`, and add the four
`1staid` rows of spec §6.3 (`prompt.cache-hit`, `prompt.fixed-overhead`, `tools.service`, `tools.artifacts`; the last two
report `skip` until H1-1/H1-2 land) in `crates/plur1bus/src/commands/firstaid.rs` with append-only ids, calling the core
when it is up. Tests: overhead for a fixture agent with known zone texts; Rust tests for each row's status rule with a fake
core; `crates/plur1bus/tests/cli_surface.rs` and the skill-freshness test updated. Docs: `docs/doctor.md`, the operations
skill's diagnose playbook. Acceptance: `plur1bus --json 1staid check` lists the rows; `doctor.report` shows them.

## H2-3 — The `turn-eval-live` baseline (2.5 agent days + an owner credentials run; Sonnet, TypeScript) — GATE

Extend `packages/core/src/toolcall/turn-eval-live.ts` and `scripts/eval/turn-eval.ts` reports with provider cache-read
share per scenario and provider, fixed overhead per agent, inline tool-result bytes and tokens (p50/p95), counts of
`tool-result-too-large` and opaque-pointer results, rounds, turns and wall time; add the coding scenario set of spec §6.4
(three fixture repositories under `tests/fixtures/coding/{rust,ts,python}` with failing tests, a rename and an addition,
each verified by its own test command) to the turn-eval corpus and to `host-eval`; run the fixture regression and one
live run with the configured models; commit the report as `docs/evals/2026-10-baseline-harness-hygiene.md` (models, dates,
denominators, no credentials). Tests: report schema tests, the fixture corpus green in regression mode, a scripted run
that produces every new field. Acceptance: the baseline exists and every later PR can be compared with it.

## H2-4 — Tool admission without a full cache miss (2.5 agent days; Sonnet, TypeScript; after H2-3's numbers)

Implement the answer to Q8 (assumed: pre-admission per agent profile plus the `tool.invoke` overflow): profile tool sets
in the agent configuration (`packages/config-schema`, `x-restart: "live"`), the frozen per-session offer in
`toolcall/stable-tools.ts` and `session_tool_offers`, `capabilities.search` returning input schemas of not-offered
tools, and `tool.invoke` as a composition-level rewrite into an ordinary dispatcher call (`composition/provider.ts`);
`artifact.read` joins `CORE_TOOL_NAMES` (registered with H1-4). Tests: a profile session never changes zone 1; a
`tool.invoke` call produces exactly the policy decision, approval and audit records a direct call produces; turn-eval
tool-prefix changes stay 0/24. Docs: `docs/tool-reliability.md`, `docs/composition.md`. Acceptance: `tools-changed`
misses per session ≤ 1 on the live corpus with no lower needed-tool hit rate than the baseline.

## H1-1 — `plur1bus-tools` skeleton, RPC server, supervisor slot (3 agent days; Claude agent, Rust + TypeScript)

Create `crates/plur1bus-tools` (lib + bin `plur1bus-tools serve --home <dir> [--lifeline stdin --instance <uuid>]`), the
`x-server: "tools"` value and `tools.hello`/`tools.health` in the RPC schema (and the schema tests that enforce server
values), the core-only dispatch guard, the supervisor slot (`crates/plur1bus/src/supervisor/`, child spec, start after the
core, own backoff, adoption), the no-supervisor spawn from the core (`PLUR1BUS_TOOLS_BIN`), the TypeScript client
`packages/core/src/tools-service/client.ts`, the ticket key exchange of spec §11.2 in `tools.hello`, and the binary in the
release payload, container image and desktop bundle; AGENTS.md crate row. Tests: Rust unit tests for the guard and the
hello; a core test that spawns the binary and calls `tools.health`; a supervisor test (crash → restart with backoff);
`pnpm docs:check`. Acceptance: `plur1bus --json 1staid check` reports `tools.service: ok`; killing the process restarts it
and the core keeps serving turns.

## H1-2 — Artifact store (2 agent days; Claude agent, Rust)

`crates/plur1bus-tools/src/artifacts/`: layout, permissions (0700/0600; the Windows owner-only DACL helper of
`crates/plur1bus-rpc`), `index.sqlite` (`rusqlite`, already a workspace dependency), `tools.artifact.begin|append|commit`
with sequence-checked chunks of at most 1 MiB, `tools.artifact.read` (offset, limit, grep with `regex`, context,
maxMatches, `nextOffset`), owner and session scope checks, the 64 MiB cut, retention (session + 30 days), quota (1 GiB,
oldest ended sessions first), incognito lifetime, the start-up sweep and the one-time sweep of `state/tool-results/`; a
system job in the core triggers the daily sweep (`packages/core/src/system-jobs/`); config keys `tools.artifacts.*`.
Tests: permissions per platform, scope refusals, chunk order and duplicate refusal, cut at a line boundary, retention and
quota with an injected clock, incognito deletion at session end, regex with a pathological pattern stays linear.
Acceptance: the `tools.artifacts` doctor row reports size, quota and the last sweep.

## H1-3 — Crushers (3 agent days; Claude agent, Rust)

`crates/plur1bus-tools/src/crush/` with the crushers of spec §7.3 (`test.*`, `build.*`, `exec.generic`, `json`, `text`),
each versioned; detection from hints and output markers; budget split (summary, essence, head, tail); `catch_unwind` at the
RPC boundary with fallback to `exec.generic`; golden fixtures from real runs of node `--test`, vitest, pytest, cargo test,
go test, Gradle, tsc, eslint, cargo clippy, ruff and mypy under `crates/plur1bus-tools/tests/fixtures/crush/`. Tests: each
golden keeps every failure and error line it must keep and stays within the budget; success collapses to one line; a
fuzzed input never panics through the boundary. Acceptance: on the coding corpus every failing test name appears in the
essence.

## H1-4 — Dispatcher integration and `artifact.read` (2.5 agent days; Sonnet or Opus, TypeScript)

In `packages/core/src/tools/dispatcher.ts` step 4: measure, redact (the existing redactor with the chunk overlap of spec
§7.6), offload through the client, return the envelope; the degraded envelope when the service is down; the exemptions
(`skill.*`, `memory.*`, `artifact.read`); `tools.results.inlineTokens` and `limits.inlineTokens`; `exec.run` spooling to an
open artifact with head/tail capture (`tools/exec/run.ts`); `capResult` without a store; the `SubagentResultPort` backed by
the parent session's artifacts; the `artifact.read` tool and its capability row in `policy/capabilities.ts`; audit records;
redaction of successful inline results. Tests: a 5 MiB MCP result and a 10 MiB exec output return envelopes, never errors;
the redactor catches a secret split across chunks; scope refusal across sessions; the degraded mode with the service
stopped; turn-eval regression unchanged; live delta reported. Docs: `docs/tool-reliability.md`, `docs/fs-tools.md`,
`docs/errors.md`, `docs/privacy.md`. Acceptance: spec §16 H1 row.

## C1 — Anchored reading and `file.edit` (3 agent days; Claude agent, Rust + TypeScript)

`crates/plur1bus-tools/src/aci/{anchor,edit,write}.rs`: anchors (`<line>:<hash>`, three base32 characters of a truncated
SHA-256 over the line without its end-of-line), `tools.file.read` (line ranges, `fileHash`, end-of-line style, encoding),
`tools.file.edit` (ops `replace`, `insert_before`, `insert_after`, `delete`; stale-anchor refusal with ±5-line windows;
overlap refusal; atomic temp-fsync-rename preserving mode, end-of-line style and a byte-order mark; unified diff through
the H1 budget; new anchors), the ticket check on every mutating call, containment re-check (inside the named root, no
symlink escape, no hard links); in TypeScript `file.read`'s `anchors` flag and the `file.edit` tool definition with the
`file.write` classification (`composition/tools.ts`, `tools/fs/tools.ts`, discovery metadata). Tests: anchor stability
across CRLF/LF and BOM files, stale and overlapping ops, a symlink and a hard-link escape refused, a missing or replayed
ticket refused, atomicity under a simulated crash between write and rename. Acceptance: spec §16 C1 row on the coding
corpus.

## C2 — Syntax gate and `file.write` through it (2.5 agent days; Claude agent, Rust)

Add `tree-sitter` 0.27.x and the nine grammar crates of spec §12.5 through the dependency gate (`deny.toml`,
`docs/dependency-policy.md`, `THIRD_PARTY.md`/`THIRD_PARTY-LICENSES.txt`), first proving they build on the five release
targets (U3); `crates/plur1bus-tools/src/aci/gate.rs` with the rule of spec §8.4 (new `ERROR`/`MISSING` nodes intersecting
changed ranges), language detection, the diagnostic format, `gate: "none"` for unknown languages; `file.edit` and
`tools.file.write` run the gate before writing; the optional lint-on-write from `.plur1bus-verifiers.json` (`onWrite`)
through the D98 verifier sandbox. Tests: per language a valid edit passes, a broken edit is refused with nothing written,
an already broken file still accepts an edit elsewhere; gate latency p95 under 50 ms on a 1 MiB fixture. Acceptance: zero
broken files written on the coding corpus.

## C3 — Outline and symbol queries (3 agent days; Claude agent, Rust + TypeScript)

`crates/plur1bus-tools/src/aci/{outline,symbols}.rs` on `tree-sitter-tags` with the grammars' tag queries:
`tools.file.outline`, `tools.code.list_symbols`, `tools.code.get_symbol`, `tools.code.find_references` (spec §8.5), the
worktree walk through hardened `git ls-files`, the deny list and roots, the 1 MiB file cap, paging at 200, the lazy
in-memory index keyed by path, size, mtime and hash; TypeScript tool definitions (`file.outline`, `code.list_symbols`,
`code.get_symbol`, `code.find_references`, effect `read`) and discovery metadata. Tests: outline of a fixture per
language matches a golden; `find_references` finds every reference listed in the fixture; ignored and denied files never
appear. Acceptance: spec §16 C3 row.

## H3-1 — Steering in the core (3 agent days; Opus or Sonnet, TypeScript)

`session/turn-loop.ts`: `TurnLoop.steer`, the per-turn `SteerInbox`, storing steer messages as user messages of the
running turn with a `turn.steer` event; `session/store.ts`: the insert and a per-session follow-up queue (bound 20) with
`session.queue.list|remove`; `composition/provider.ts`: inbox check at the top of each tool-call iteration, skipped results
for the remaining calls, steer messages appended, completion rule of spec §9.1; `tools/dispatcher.ts`: the separate steer
signal and the approval withdrawal through the approvals service (`approval.withdrawn` in its chain); telemetry fields;
RPC: `delivery` on `session.submit`/`chat.submit`, the new result states, the queue methods, the `session.event` types,
contract fixtures; the REST body in `packages/api`. Tests: every case of spec §9.8 except the surface ones, including all
four wire formats after a steer. Docs: `docs/rpc.md` (generated), `docs/errors.md`, `docs/composition.md`,
`docs/approvals.md`. Acceptance: spec §16 H3 row.

## H3-2 — Steering surfaces: web, channels, voice (2.5 agent days; Sonnet, TypeScript)

Web (`packages/web/src/pages/chat/{composer,store,controller}.ts`): Enter/Alt+Enter while busy, the swap setting, queue
chips, the "steered" marker, de/en strings. Channels (`channels/router.ts`): steer detection (`!` and `/steer `), the sender
rule of spec §9.2, `agents.<id>.busyDelivery` with `byChannelKind` (config schema, `x-restart: "live"`), queued messages
on today's path. Voice (`voice/talk.ts`, `voice/v2.ts`): playback stop always, steer during a tool phase, cancel while
speaking, the `agent.steer` port. Check the voice D45 phase-2 plan (project document) first and record any difference (U12).
Tests: router prefix, sender rule and bound; web key bindings and chips; voice barge-in in both phases. Docs:
`docs/switchboard.md`, `docs/web-ui.md`, `docs/voice-local.md`. Acceptance: a person can steer from the web, Telegram and
voice in the system tests.

## C4 — Sensors and the D98 gate (2.5 agent days; Sonnet, TypeScript; crushers from H1-3)

`collab/verifier.ts`: spool check output to an artifact (cap 16 MiB per check) instead of stopping at 64 KiB; evidence is
the SHA-256 of the full output; `collab/coding-gate.ts`: `checks[].artifact` and `checks[].essence` (crushed by H1-3),
the reuse rule of spec §8.6 behind Q16, per-project `timeoutMs` (at most 600 s) from `.plur1bus-verifiers.json`;
`collab/coding-surface.ts`: refusals carry the essence for `coding_complete` and `task.complete`; a new `code.check` tool
running the same plan through the same `VerifierPort`. Tests: a 1 MiB test log no longer fails with `output-limit`; a
refusal names the failing tests; reuse accepted only on an identical tree hash through the gate's own runner and never
skips review or the manifest check. Docs: `docs/collaboration.md`, the D98 section of
`docs/superpowers/specs/2026-09-28-basics-quality-bar-design.md` (implementation note). Acceptance: spec §16 C4 row.

## H4 — Rewind with lesson (3 agent days; Sonnet or Opus, TypeScript)

Session schema v10 (`path_rewinds`, spec §10.1) in `session/migrations.ts`; the active-path filter wherever the prompt is
built and in compaction (`session/compaction.ts`, summaries overlapping a hidden range dropped from the view); `/rewind` as
a transcript command in `session/turn-loop.ts`; `chat.rewind`/`session.rewind` and `--undo` in `rpc/chat-surface.ts` with
the audit record and `hiddenDigest`; lesson distillation through the `summarize` role with the deterministic fallback;
the agent trigger behind Q13 (project setting, N = 3, unattended D115 cards only, propose-only otherwise); "Rewind to
here" in the web; the optional `--files` checkpoint restore behind Q14 and an approval. Tests: the hidden range never
reaches the model, undo restores it, messages and events stay byte-identical, the digest matches, FTS marks hidden
messages, the cache prefix up to `parent_seq` is unchanged. Docs: `docs/architecture/compaction.md`, `docs/rpc.md`,
`docs/web-ui.md`. Acceptance: spec §16 H4 row.

## T1-a — TypeScript architecture test (1 agent day; Sonnet, TypeScript)

`packages/core/test/architecture/single-gate.test.ts`: the type-checked scan of spec §11.1 over `packages/core/src` and
`packages/hostctl/src`, `callWithRepair` moved to a test helper, the runtime brand in `ToolRegistry.register` and
`ToolDispatcher.#run`, and the surface drive asserting a `policy.decision` record per execution. Tests: the test fails on a
seeded direct `execute` call and on a registry bypass at runtime. Acceptance: green on main with no allowlisted bypass.

## T1-b — Rust typestate gate (2 agent days; Claude agent, Rust)

`crates/plur1bus-tools/src/gate/`: `UnverifiedAction`, `ApprovedAction` (private fields), `Gate::verify` (MAC, 30 s
expiry, single use by call id, recomputed action hash with canonical JSON), every mutating `tools.*` method moved onto it;
`compile_fail` doctests; shared canonical-JSON parity vectors read by `packages/core/test/tools/` and the crate's tests.
Tests: forged, expired, replayed and hash-mismatched tickets refused; doctests prove the types. Acceptance: spec §16 T1
row.

## P4-spike — Phase 4 dependency spike and estimate (2 agent days; Claude agent, Rust)

On a throwaway branch: compile each candidate of spec §12.5 for the five release targets, run `cargo deny`, record binary
size and cold start; resolve U3–U8 where possible; write `docs/superpowers/plans/<date>-core-phase4-outline.md` with the
strangler steps of spec §12.2, a work-package list per step and an estimate per step. No product code merges. Acceptance:
the owner can decide Q19 with numbers.

## M6-Pi — Pi over ACP verification (1.5 agent days + owner; Claude agent; after PR #820)

Install Pi and `pi-acp` (pinned versions) in a provisioned worktree; run the spec §14 table against the three fixture
repositories through PR #820's ACP client; record pass, partial or fail with evidence in `docs/acp.md` (a verification
section) and in ADR-011's connector catalogue row; put Q18 to the owner with the measured gaps. No native-RPC code.
Acceptance: the table is filled and Q18 is answered or explicitly parked.

## Estimate

| Package | Agent days | Executor |
|---|---|---|
| WP0 | 0.5 | Claude (docs) |
| H2-1 | 2 | **Sonnet (first)** |
| H2-2 | 1.5 | Claude agent (Rust part) |
| H2-3 | 2.5 + owner run | Sonnet |
| H2-4 | 2.5 | Sonnet |
| H1-1 | 3 | Claude agent (Rust) |
| H1-2 | 2 | Claude agent (Rust) |
| H1-3 | 3 | Claude agent (Rust) |
| H1-4 | 2.5 | Sonnet or Opus |
| C1 | 3 | Claude agent (Rust) |
| C2 | 2.5 | Claude agent (Rust) |
| C3 | 3 | Claude agent (Rust) |
| H3-1 | 3 | Opus or Sonnet |
| H3-2 | 2.5 | Sonnet |
| C4 | 2.5 | Sonnet |
| H4 | 3 | Sonnet or Opus |
| T1-a | 1 | Sonnet |
| T1-b | 2 | Claude agent (Rust) |
| P4-spike | 2 | Claude agent |
| M6-Pi | 1.5 + owner | Claude agent |
| **Total** | **45.5** (range 40–56 with review rounds) | |

Phase 4 itself is not estimated here; the P4 spike produces that estimate. Reviews follow the repository's rules
(`CLAUDE.md`); the controller watches CI and merges.

## The first Sonnet-sized package

**H2-1** is the best first package: TypeScript only, telemetry only (no behaviour change, no new store), about two agent
days, built on code that already exists (`prompt/telemetry.ts`, `usage_event`), with crisp tests (one attribution per
cause, window maths against hand-computed rows), and it produces the number H2-4 and every later package depend on. T1-a
is the fallback first package if a second agent is free (independent, one day).
