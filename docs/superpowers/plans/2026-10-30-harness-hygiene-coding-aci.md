# Harness hygiene, steering, rewind and the coding ACI — implementation plan

**Goal.** Measure the prompt first (cache-hit rate, fixed overhead, cache-miss causes, a recorded `turn-eval-live`
baseline), then make large tool results an envelope instead of a failure, give our own agent a coding ACI (anchored edits,
a tree-sitter pre-write gate, outlines and symbol queries, crushed sensor output shared with the D98 gate), let people
steer running turns and rewind with a lesson, give our agent its own coding CLI (`plur1bus code`, line-based then a TUI)
and an ACP coding mode, measure all coding work on an own licence-clean benchmark set, prove every tool execution passes
the one gate, and prepare Phase 4, as specified in [`2026-10-30-harness-hygiene-coding-aci-design.md`](../specs/2026-10-30-harness-hygiene-coding-aci-design.md)
(cited as "spec §n"; register entry D120, Q1 decided).
**Architecture.** New components are Rust in one supervised module process, `plur1bus-tools` (`crates/plur1bus-tools`,
`x-server: "tools"`), called by the TypeScript core over the harness RPC (spec §5, §12.3); changes to existing TypeScript
(telemetry, turn loop, router, web, session store) stay TypeScript until their Phase 4 step (owner decision 3, spec §13).
**Status.** Plan only. Owner decisions of 2026-10-30 recorded (spec §2, decisions 1–6), and every owner question of
spec §18 is decided (Q18 and Q20 on 2026-10-30, all others on 2026-10-31 as recommended). No package waits on an owner
answer any more; the remaining gates are measurement, spike and dependency gates ("Gates" below).
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
7. Every package's PR carries its delta against the H2 baseline and, for coding work, the B1 baseline (spec §6.4, §6.6,
   §16).
8. `plur1bus code` and the ACP coding mode never answer an approval on their own and bind only granted roots
   (spec §8.8, §8.9).
9. The benchmark job never puts a secret into a log or an uploaded report (spec §6.6).

## Gates

Only measurement, spike and dependency gates remain; none waits on an owner answer.

1. **H2-3 (measurement):** the general `turn-eval-live` baseline lands before any package that changes behaviour.
2. **B1 (measurement):** the coding benchmark baseline is committed before H1-1, the first ACI package.
3. **H2-4 (measurement):** starts after H2-3 has measured the cache-miss cost per tool admission (Q8).
4. **Delta rule (measurement):** every package reports its delta against the H2 and B1 baselines; a package that makes a
   gated rate worse does not merge without an owner decision (spec §6.4).
5. **C2 (spike):** starts by proving that the grammar crates build and load on the five release targets (spec U3).
6. **H3-2 (document check):** starts after the barge-in mapping has been checked against the voice D45 phase-2 plan
   (spec U12).
7. **Phase 4 (spike and dependency):** starts after RE-11 and the P4 spike (Q19).
8. **Dependencies:** code dependencies as in the diagram below (for example CLI-1 needs C1–C3 and H3-1); M6-Pi waits
   for PR #820 to merge; every new crate passes the gate of `docs/dependency-policy.md` and `deny.toml`.

## Dependencies and order

```text
WP0 D120 register entry + ADR-019 (docs; runs alongside, gates nothing)
 H2-1 cache telemetry ─► H2-2 overhead + doctor rows ─► H2-3 live baseline (GATE) ─► H2-4 tool admission
                                                                   │
                                                                   └─► B1 coding benchmark + baseline (GATE for ACI)
      ┌──────────────────────────────────────────────────────────────────────────────┘
      ▼
 H1-1 plur1bus-tools skeleton ─► H1-2 artifact store ─► H1-3 crushers ─► H1-4 dispatcher integration + artifact.read
      │
      └─► C1 anchors + file.edit ─► C2 syntax gate + file.write ─► C3 outline + symbols
                                                                         │
 H3-1 steering core ─► H3-2 steering surfaces ◄───────────────────────────┘ (order only; no code dependency on C3)
      ▼
 CLI-1 plur1bus code, line-based (needs C1–C3, H3-1) ─► CLI-ACP coding mode over ACP
      ▼
 C4 sensors + D98 (needs H1-3, H1-4) ─► H4 rewind with lesson ─► T1-a architecture test ─► T1-b Rust typestate
      ▼
 CLI-2 full-screen TUI (needs CLI-1) ─► P4-spike (Phase 4 itself starts after RE-11)
 M6-Pi verification: independent, after PR #820 merges
```

The sequence follows the owner's order H2 → B1 → H1 → C1/C2 → C3 → H3 → CLI-1 → C4 → H4 → T1 → CLI-2 → P4-spike: the
benchmark right after H2 so every ACI package is measured against it, the line-based CLI after C1–C3 and H3, the TUI
later. Stack a PR on its predecessor (`--base`) only where it needs that code: H1-2/H1-3 on H1-1, H1-4 on H1-2 and H1-3,
C1 on H1-1, C2 on C1, C3 on C2, H3-2 on H3-1, CLI-1 on C3 and H3-1, CLI-ACP on CLI-1, C4 on H1-4, T1-b on C2, CLI-2 on
CLI-1.

---

## WP0 — Register entry and ADR-019 (0.5 agent days; Claude, docs)

The owner's decisions are recorded in spec §18 (all decided by 2026-10-31). Enter D120 in the core spec's
register (`docs/superpowers/specs/2026-09-24-m1b-2a-core-daemon-cli-design.md` §2); write `docs/adr/ADR-019-rust-new-components-and-core-strangler.md`
from spec §13 (status Accepted: decision 3 of 2026-10-30, form decided 2026-10-31, Q2), add the amendment note to ADR-012's status line and after its
§2, and mark the RE-D9 row in `docs/superpowers/plans/2026-10-23-rust-engine-rewrite.md` §6 and in
`docs/superpowers/plans/rust-engine/README.md` as superseded by ADR-019. Tests: `node scripts/check-doc-links.mjs`,
`node scripts/lint-hygiene.mjs`. Acceptance: D120 is registered, ADR-019 exists, ADR-012 and the RE-D9 rows carry their notes.

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

## H2-3 — The `turn-eval-live` baseline (1.5 agent days + an owner credentials run; Sonnet, TypeScript) — GATE

Extend `packages/core/src/toolcall/turn-eval-live.ts` and `scripts/eval/turn-eval.ts` reports with provider cache-read
share per scenario and provider, fixed overhead per agent, inline tool-result bytes and tokens (p50/p95), counts of
`tool-result-too-large` and opaque-pointer results, rounds, turns and wall time; run the fixture regression and one live
run with the configured models; commit the report as `docs/evals/2026-10-baseline-harness-hygiene.md` (models, dates,
denominators, no credentials). The coding tasks moved to B1 (spec §6.6). Tests: report schema tests, the fixture corpus
green in regression mode, a scripted run that produces every new field. Acceptance: the baseline exists and every later
PR can be compared with it.

## H2-4 — Tool admission without a full cache miss (2.5 agent days; Sonnet, TypeScript; after H2-3's numbers)

Implement Q8 as decided 2026-10-31 (pre-admission per agent profile plus the `tool.invoke` overflow): profile tool sets
in the agent configuration (`packages/config-schema`, `x-restart: "live"`), the frozen per-session offer in
`toolcall/stable-tools.ts` and `session_tool_offers`, `capabilities.search` returning input schemas of not-offered
tools, and `tool.invoke` as a composition-level rewrite into an ordinary dispatcher call (`composition/provider.ts`);
`artifact.read` joins `CORE_TOOL_NAMES` (registered with H1-4). Tests: a profile session never changes zone 1; a
`tool.invoke` call produces exactly the policy decision, approval and audit records a direct call produces; turn-eval
tool-prefix changes stay 0/24. Docs: `docs/tool-reliability.md`, `docs/composition.md`. Acceptance: `tools-changed`
misses per session ≤ 1 on the live corpus with no lower needed-tool hit rate than the baseline.

## B1 — Coding benchmark set and its baseline (4 agent days + an owner credentials run; Sonnet, TypeScript + task fixtures) — GATE for ACI

Author the 24 tasks of spec §6.6 under `tests/bench/coding/<id>/` (`task.json`, starting tree, reference solution,
hidden checker, seed generator; Rust, TypeScript, Python, Go, shell; 8 easy, 8 medium, 8 hard; MIT, no upstream content
per Q21); a runner `packages/core/src/toolcall/coding-bench.ts` with a script `scripts/eval/coding-bench.ts` that
provisions a fresh git worktree per task and seed, runs the checker in the verifier sandbox, and drives the agent through
the turn path with the coding profile (`--fixture` self-test without a model; `--live` with the `turn-eval-live` model
list); a `host-eval` hook for host-adapter subjects; a nightly job `coding-bench-live` in `.github/workflows/nightly.yml`
that copies `turn-eval-live`'s secret pattern (setup step writes the eval store; the run step has no secret; the eval home
is deleted at the end) and uploads only the redacted report; a canary secret in the eval store that the job searches for
in its log and report; the paired comparison (sign test or McNemar, counts shown) in the report; the baseline on today's
tools committed as `docs/evals/2026-10-baseline-coding-bench.md`. Tests: the fixture self-test in the per-PR suite (every
checker fails on the start and passes on the reference for three seeds), report schema tests, the canary test. Docs:
`docs/turn-eval.md` (a coding-bench section), `docs/ci.md` (the new nightly job). Acceptance: spec §16 B1 row; H1-1
does not start before the baseline is committed.

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

## CLI-1 — `plur1bus code`, line-based (7 agent days; Claude agent, Rust + a small TypeScript core method)

`crates/plur1bus/src/commands/code/` (`mod.rs` binding and session, `stream.rs` the two-connection event reader,
`render.rs` line renderer with inline diffs and envelope summaries, `input.rs` the `reedline` editor with Enter = steer,
Alt+Enter = queue, `/steer`, `/queue`, `/unqueue`, Ctrl+C/Ctrl+D, `approve.rs` inline approvals through `approval.decide`,
`commands.rs` for `/check`, `/diff`, `/done`, `/rewind`, `/compact`, `/model`, `/help`), the `Code(CodeArgs)` entry in
`crates/plur1bus/src/cli.rs` sharing `pick_agent` and the model switch with `commands/session.rs`; the core method
`code.session.open` (RPC schema, handler beside `rpc/chat-surface.ts`, D115 card binding through `ProjectWorktreePort`,
`session_worktrees` in session schema v10, the D109 grant request for a folder that is not a granted root) and the coding
profile (pre-admitted ACI tools, the static coding section in zone 2); `reedline` 0.52.1 through the dependency gate
(`deny.toml`, `docs/dependency-policy.md`, `THIRD_PARTY*`); the non-interactive mode with `code.event/1` documents. Spec
§8.8, Q22–Q25. Tests: Rust unit tests for key handling (Enter and Alt+Enter while busy and idle), the renderer against
recorded event streams (diff folding, envelopes, `NO_COLOR`), approval prompts answered from a scripted TTY, non-TTY runs
answering "no"; `crates/plur1bus/tests/cli_surface.rs`; a core test for `code.session.open` (card binding, refusal of an
ungranted folder without a person, grant path with one); an end-to-end run of two benchmark tasks through
`plur1bus code --json` against a fake provider. Docs: `docs/cli.md` (generated from the clap tree), a coding-mode section
in `docs/user/`, the operations skill. Acceptance: spec §16 CLI-1 row.

## CLI-ACP — The coding mode over `plur1bus acp serve` (2 agent days; Sonnet, TypeScript)

`packages/core/src/acp/`: `--profile coding`, ACP session modes (`chat`, `coding`, `session/set_mode`), `cwd` binding through
`code.session.open` (refusal for a folder that is not a granted root), `diff` content on `file.edit`/`file.write` tool calls,
D109 approvals as `session/request_permission` with the option mapping of spec §8.9, the extension methods
`_app.plur1bus/steer` and `_app.plur1bus/follow_up` advertised in `agentCapabilities._meta`; the CLI flag in
`crates/plur1bus/src/cli.rs`. Tests: the ACP test client (`packages/core/test/acp/`) for each mapping, unknown custom
methods still `-32601`, the stderr rule (no prompt text) unchanged. Docs: `docs/acp.md`. Acceptance: spec §16 CLI-ACP row.

## C4 — Sensors and the D98 gate (2.5 agent days; Sonnet, TypeScript; crushers from H1-3)

`collab/verifier.ts`: spool check output to an artifact (cap 16 MiB per check) instead of stopping at 64 KiB; evidence is
the SHA-256 of the full output; `collab/coding-gate.ts`: `checks[].artifact` and `checks[].essence` (crushed by H1-3),
the reuse rule of spec §8.6 (Q16), per-project `timeoutMs` (at most 600 s) from `.plur1bus-verifiers.json`;
`collab/coding-surface.ts`: refusals carry the essence for `coding_complete` and `task.complete`; a new `code.check` tool
running the same plan through the same `VerifierPort`. Tests: a 1 MiB test log no longer fails with `output-limit`; a
refusal names the failing tests; reuse accepted only on an identical tree hash through the gate's own runner and never
skips review or the manifest check. Docs: `docs/collaboration.md`, the D98 section of
`docs/superpowers/specs/2026-09-28-basics-quality-bar-design.md` (implementation note). Acceptance: spec §16 C4 row.

## H4 — Rewind with lesson (3 agent days; Sonnet or Opus, TypeScript)

Session schema v11 (`path_rewinds`, spec §10.1; v10 is CLI-1's `session_worktrees`) in `session/migrations.ts`; the active-path filter wherever the prompt is
built and in compaction (`session/compaction.ts`, summaries overlapping a hidden range dropped from the view); `/rewind` as
a transcript command in `session/turn-loop.ts`; `chat.rewind`/`session.rewind` and `--undo` in `rpc/chat-surface.ts` with
the audit record and `hiddenDigest`; lesson distillation through the `summarize` role with the deterministic fallback;
the agent trigger as decided in Q13 (project setting, N = 3, unattended D115 cards only, propose-only otherwise); "Rewind to
here" in the web; the optional `--files` checkpoint restore (Q14) behind an approval. Tests: the hidden range never
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

## CLI-2 — Full-screen TUI for `plur1bus code` (9 agent days; Claude agent, Rust)

`crates/plur1bus/src/commands/code/tui/` on `ratatui` 0.30.x and `crossterm` 0.29 (through the dependency gate; licences
and the `lru 0.18` unification checked in spec §8.8) behind a default-on cargo feature `tui`: transcript pane, tool and
diff pane with scrolling and folding, status line (model, tokens, cache-hit, budget, worktree, branch), approval modal,
queue list, the same keys as CLI-1, resize and mouse-free operation, a clean terminal restore on panic and signal;
`plur1bus code --tui`, with the line mode as the fallback for dumb terminals and pipes; the same session, stream and
approval layer as CLI-1 (no second RPC path). Tests: frame snapshots with ratatui's test backend for the main states,
key handling, terminal restore after a panic, `--help` p95 under 100 ms with the feature on; manual checks on the five
release targets (U18). Docs: `docs/cli.md`, the user guide. Acceptance: spec §16 CLI-2 row.

## P4-spike — Phase 4 dependency spike and estimate (2 agent days; Claude agent, Rust)

On a throwaway branch: compile each candidate of spec §12.5 for the five release targets, run `cargo deny`, record binary
size and cold start; resolve U3–U8 where possible; write `docs/superpowers/plans/<date>-core-phase4-outline.md` with the
strangler steps of spec §12.2, a work-package list per step and an estimate per step. No product code merges. Acceptance:
an estimate per Phase 4 step; Phase 4 starts after RE-11 and this spike (Q19, decided 2026-10-31).

## M6-Pi — Pi over ACP verification (1.5 agent days + owner; Claude agent; after PR #820)

Install Pi and `pi-acp` (pinned versions) in a provisioned worktree; run the spec §14 table against repository tasks of
the benchmark set (B1) through PR #820's ACP client; record pass, partial or fail with evidence in `docs/acp.md` (a
verification section) and in ADR-011's connector catalogue row, labelling `pi-acp` an optional third-party attachment
with the accepted limits (Q18, decided 2026-10-30). No native-RPC code. Acceptance: the table is filled.

## Estimate

In execution order:

| Package | Agent days | Executor |
|---|---|---|
| WP0 | 0.5 | Claude (docs) |
| H2-1 | 2 | **Sonnet (first)** |
| H2-2 | 1.5 | Claude agent (Rust part) |
| H2-3 | 1.5 + owner run | Sonnet |
| H2-4 | 2.5 | Sonnet |
| B1 | 4 (3–5) + owner run | Sonnet |
| H1-1 | 3 | Claude agent (Rust) |
| H1-2 | 2 | Claude agent (Rust) |
| H1-3 | 3 | Claude agent (Rust) |
| H1-4 | 2.5 | Sonnet or Opus |
| C1 | 3 | Claude agent (Rust) |
| C2 | 2.5 | Claude agent (Rust) |
| C3 | 3 | Claude agent (Rust) |
| H3-1 | 3 | Opus or Sonnet |
| H3-2 | 2.5 | Sonnet |
| CLI-1 | 7 (6–9) | Claude agent (Rust) |
| CLI-ACP | 2 (1.5–3) | Sonnet |
| C4 | 2.5 | Sonnet |
| H4 | 3 | Sonnet or Opus |
| T1-a | 1 | Sonnet |
| T1-b | 2 | Claude agent (Rust) |
| CLI-2 | 9 (8–11) | Claude agent (Rust) |
| P4-spike | 2 | Claude agent |
| M6-Pi | 1.5 + owner | Claude agent |
| **Total** | **66.5** (range 58–83 with review rounds) | |

The total was 45.5 (range 40–56) before the owner decisions 5 and 6. The new packages add 22 days (B1 4, CLI-1 7,
CLI-ACP 2, CLI-2 9); H2-3 drops from 2.5 to 1.5 because its coding scenarios moved into B1. The owner's rough ranges were
6–10 for the line-based CLI (refined to 7: binding and core method 1.5, streaming renderer 1.5, line editor and keys 1,
inline approvals 1, diffs 0.5, commands 0.5, non-interactive mode and tests 1), 8–12 for the TUI (refined to 9) and 3–5
for the benchmark (refined to 4: 24 tasks with checkers and seeds 2.5, runner and nightly job 1, baseline 0.5); CLI-ACP is
new (2). Phase 4 itself is not estimated here; the P4 spike produces that estimate. The nice-to-have item below is not in
the total. Reviews follow the repository's rules (`CLAUDE.md`); the controller watches CI and merges.

## The first Sonnet-sized package

**H2-1** is the best first package: TypeScript only, telemetry only (no behaviour change, no new store), about two agent
days, built on code that already exists (`prompt/telemetry.ts`, `usage_event`), with crisp tests (one attribution per
cause, window maths against hand-computed rows), and it produces the number H2-4 and every later package depend on. T1-a
is the fallback first package if a second agent is free (independent, one day).

## Nice to have (not scheduled, not in the totals)

The repository has no shared backlog or nice-to-have list: `docs/milestones.md` §7 lists what is out of scope for
v0.1.0, and single plans keep their own "later" sections (for example the workload-identity plan's "Later packages" and
the desktop SSH plan's "WP7 — Later options"). Following that convention, this plan keeps its nice-to-have items here.

### NTH-1 — Our own Pi-ACP adapter (rough 6–8 agent days; owner decision 6, 2026-10-30)

**Why it would exist.** Third-party `pi-acp` (the optional attachment that stays) lets Pi read, write and execute on its
own: no ACP `fs/*` or `terminal/*` delegation, no per-tool permission requests, MCP servers not wired, steering only as
cancel plus re-prompt (spec §14). Our own adapter would run harness tools inside Pi, so harness policy, approvals, the
sandbox, redaction, D98, H1 offloading and `file.edit` apply to Pi's work.

**Design, so it can be picked up later.**

- **Pi SDK, not RPC mode.** The adapter is an ACP agent (stdio, schema v1) that embeds Pi through its SDK:
  `createAgentSession({ customTools, … })` with Pi's built-in `read`, `write`, `edit` and `bash` disabled (`setActiveTools`
  per the owner's note, or the documented `tools`/`noTools`/`excludeTools` options of `createAgentSession`) and replaced by
  custom tools that delegate to the ACP client: `fs/read_text_file`, `fs/write_text_file` and `terminal/create`,
  `terminal/output`, `terminal/wait_for_exit`, `terminal/kill`, `terminal/release`. With the harness as the ACP client
  (PR #820), every read, write and command then passes the harness's worktree containment, D109 policy and approvals,
  the sandbox, redaction, H1 offloading and D98; a harness-side `file.edit` can be exposed to Pi as a custom tool too.
- **Permissions.** Pi's `tool_call` hook maps to ACP `session/request_permission` before a tool runs; the answer
  (allow once, allow always, reject) decides whether the call proceeds. The harness side turns that request into a D109
  approval for subject `acp-agent` (as #820 already does).
- **Steering.** ACP v1 has no steer method. Following ACP's extensibility rules (custom methods start with an underscore
  and carry a reverse-DNS prefix; support is advertised in `_meta` of the capability object), the adapter advertises
  `agentCapabilities._meta["app.plur1bus/steer"]` and `["app.plur1bus/follow_up"]` and serves `_app.plur1bus/steer` and
  `_app.plur1bus/follow_up { sessionId, prompt }`, mapped to Pi's `steer` and `follow_up` (or `prompt` with
  `streamingBehavior: "steer" | "followUp"`). **Semantics differ:** Pi delivers a steer after the current assistant turn
  has finished executing its tool calls, before the next model call (pi.dev, `docs/latest/rpc-commands`), so the step's
  remaining calls run rather than being skipped as decision 2 specifies for our own agent. The harness's ACP client sends
  these methods when the capability is advertised and falls back to `session/cancel` plus a new prompt otherwise.
- **MCP.** MCP servers passed in `session/new` are connected by the adapter and registered as Pi custom tools, so Pi sees
  the harness's MCP servers (closing pi-acp's "accepted but not wired" gap).
- **Language exception.** The adapter runs inside Pi's Node runtime, so it is TypeScript: a documented exception to
  option B (ADR-019 rule 1), limited to this adapter.
- **Pinning and parity.** An exact Pi version pin (`@earendil-works/pi-coding-agent`, 1.4.0 at the time of writing) and
  parity tests that run the spec §14 table against both `pi-acp` and our adapter on benchmark tasks; a Pi update moves
  the pin only with green parity tests.
- **To check before scheduling:** Pi's licence at the pinned version (GitHub detects MIT for `earendil-works/pi` and npm
  lists MIT for 1.4.0; the LICENSE file decides, spec U19); whether a same-name `registerTool` overrides a built-in tool,
  whether `setActiveTools` exists on the SDK or only on the extension API, and whether a `tool_call` handler can block a
  call (spec U16); where the adapter lives (its own small package or repository, since the harness core must not depend
  on Pi).
