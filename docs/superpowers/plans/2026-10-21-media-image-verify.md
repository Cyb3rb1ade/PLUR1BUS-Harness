# Media image verification (TypeSafe System One) and media retention — implementation plan

**Goal.** An optional, off-by-default check of generated images by TypeSafe's System One model with prompt-fidelity
levels and an advanced question mode, a retry loop (default 2 retries) with early exit and best-of-failures delivery, a
follow-up offer for the other images on every surface, and user-set retention with a live sweep, as specified in
[`2026-10-21-media-image-verify-design.md`](../specs/2026-10-21-media-image-verify-design.md) (cited as "spec §n").
**Architecture.** `packages/media` gets a dependency-free System One client, image preparation (pure-TS PNG codec,
local ffmpeg for JPEG/WebP), the question sets and verdict, a candidate store and one loop shared by `JobRunner` and the
turn tools. The core composes the verifier per check behind privacy → egress → secret (the `composeMedia` order), adds
per-run budget admission, offers (`media.offer.*`), a `media.retention` system job and one shared `OutputStore`. Web,
switchboard and CLI render the offer question and take the answer.
**Status.** Plan only. Owner decisions of 2026-10-21 recorded (spec §2); open questions Q1–Q15 (spec §17). WP1–WP3 and
WP5 are unblocked now; WP6 needs Q15 (schema changes); WP11 needs the owner's TypeSafe key (Q7).
**Constraints.** No new dependency (no `@typesafe-ai/sdk`, no image library); additive RPC methods with
`x-stability: "experimental"`, `x-server: "core"`, `x-since: "1.7.0"`, closed params; every config key with `x-restart`
and `x-tier`; no new RPC error codes (new reason strings only, documented in `docs/errors.md`); no network in tests (fake
servers on 127.0.0.1 or an injected `fetch`); TDD (red test first); `erasableSyntaxOnly`; no inline styles; de/en
catalogues complete; secrets never in jobs, manifests, offers, logs, tool results or errors. Rust work by Claude agents
(owner preference). No CI polling, force-push, rebase, amend or stash.

## Review focus

1. Verification never runs when nobody enabled it: without a verify config the job, manifest and tool result are
   byte-identical to today (spec §4.1).
2. Under "Only local models" no byte leaves the machine for TypeSafe: no request, no egress decision, no secret lease
   (spec §11.1).
3. No alternate reaches any surface before a "yes": candidates live in their own root, tool results carry no
   `{ id, files }` object for them (spec §8.1, §8.3).
4. Every run and every check is admitted and settled in the budget; a refusal stops the loop, never fails the job
   (spec §7.4).
5. A restart mid-loop never starts a new generation (spec §7.5).
6. The original image is never modified; only an in-memory copy is sent (spec §10).
7. Retention deletes through the one store instance that carries the media-index listener, and never touches a running
   job (spec §13).

## Dependencies and order

```text
WP0 owner answers (Q1–Q15)
 ├──► WP1 System One client + fake server ──┐
 ├──► WP2 image preparation ────────────────┼──► WP4 loop, candidates, JobRunner ──► WP7 core composition, offers, RPC handlers ──► WP8 web + switchboard
 ├──► WP3 question sets, levels, verdict ───┘                                    │                                          └──► WP9 CLI (Rust)
 ├──► WP5 retention (store wiring, prune, system job) ──────────────────────────┤
 └──► WP6 schemas (config + RPC, gen, docs:gen) ─────────────────────────────────┘
                                                        WP10 docs ◄── WP4–WP9      WP11 live calibration + E2E ◄── all
```

One branch and one **ready** PR per work package; stacked (`--base <predecessor>`, "baut auf #N auf") only where a WP
needs its predecessor's code: WP4 on WP1–WP3, WP7 on WP4–WP6, WP8/WP9 on WP7.

---

## WP0 — Owner answers (≈ 0.25 agent days)

**Content.** Record the answers to spec §17 Q1–Q15 as status lines in the spec; adjust defaults (retention days, model
pin, thresholds) and the WP list if an answer changes scope (Q9 buttons, Q11 inbox kind, Q15 schema release).
Enter D117 in the core spec's register once decided.
**Acceptance.** Every question has a status; the spec's defaults match the answers.

## WP1 — System One client and fake server (`packages/media`; ≈ 1.5 agent days)

**Files.** `packages/media/src/verify/client.ts` (`SystemOneClient`: `ask({ model, state, questions, assets }, { key,
signal, timeoutMs, maxAttempts })`; JSON body with `data_base64`; headers `Authorization: Bearer`,
`TypeSafe-Danger-Zone-Images: true`, `content-type: application/json`; `checkedUrl`/`privateHost`/`boundedBytes` from
`http.ts`; https unless loopback; key refused for private hosts, keyless allowed for loopback; `redirect: "error"`;
response ≤ 1 MiB; injectable `fetch`; retry per spec §9.2 with `parseRetryAfter` from `adapters/_shared/retry.ts`;
classification to the spec §9.1 reasons; response validation per spec §3.3), `packages/media/src/verify/types.ts`
(question, answer, check record, reason types), `packages/media/src/verify/index.ts`, export from `src/index.ts`.
`packages/media/test/fixtures/typesafe-fake.ts` (in-process fetch + 127.0.0.1 server, request validation per spec §14).
**Tests (red first).** `test/verify-client.test.ts`: request shape (headers, model, state keys, each asset referenced
exactly once, `format` with `data_base64`, no whitespace, no `data:` prefix); each answer type parsed; 401, 400 with
`max_tokens_exceeded`, 413, 415, 422 `detail`, 429 with/without `Retry-After` (≤ 10 s honoured, longer → `rate-limited`),
529, 500/503 retried once, per-attempt and total timeout, connection reset, non-JSON, missing answer id, noul out of
range, unknown answer type, response `model` recorded; no body text, URL or key in any thrown error; a fetch spy fails
any non-loopback host.
**Acceptance.** `pnpm --filter @plur1bus/media test` green with the package's 85 % coverage gates; no new dependency.

## WP2 — Image preparation (`packages/media`; ≈ 2 agent days)

**Files.** `packages/media/src/verify/png-codec.ts` (decode: colour types 0/2/3/4/6, depths 1–16, Adam7, `tRNS`, APNG
default image; `inflateSync` with `maxOutputLength`; area-average downscale; rotate/flip; encode 8-bit RGB/RGBA with
`deflateSync`), `packages/media/src/verify/prepare.ts` (spec §10.1–§10.4: sniff, bounds, orientation from EXIF via the
existing parser in `adapters/_shared/images.ts` — export `exifOrientation` there, plus WebP `EXIF` chunk reading —, fast
path with `stripMetadata`, PNG path, ffmpeg path reusing `video.ts`'s `run()` pattern with an injectable processor,
reasons `too-small`, `aspect-out-of-range`, `unsupported-format`, `preprocess-unavailable`, `too-large`).
**Tests.** `test/verify-prepare.test.ts` with synthetic images built in the test (no binary fixtures beyond a few bytes):
2048² → 1568², 1792×1024 → 1568×896, 1024² fast path (bytes = `stripMetadata` output), 200² → `too-small`,
4000×300 → `aspect-out-of-range`, 16-bit/palette/interlaced/tRNS decode equality against a reference decode, bomb
header → `too-large`, original SHA-256 unchanged; JPEG orientation 6 and WebP through ffmpeg (skipped when ffmpeg is
absent, like `video-native.test.ts`) and through an injected processor (always run); no ffmpeg → `preprocess-unavailable`.
**Acceptance.** Coverage gates hold; preparation never writes outside a private temp dir, which is removed.

## WP3 — Question sets, levels, templates, verdict (`packages/media`; ≈ 1.5 agent days)

**Files.** `packages/media/src/verify/questions.ts` (the spec §6.2 bank and level tables, versioned
`prompt-fidelity-<level>@1`; conditional `text`/`negative`; templates of spec §6.3 with versions; `buildRequest(prompt,
negativePrompt, image, reference?, set)` → `state`, `assets`, `questions`, one UUID reference each),
`packages/media/src/verify/verdict.ts` (goodness, gates, `minConfidence`, `minAggregate`, aggregate, `compareCandidates`
per spec §6.4), `packages/media/src/verify/config.ts` (`resolveVerifyConfig(global, agent, call)` per spec §5.1,
validation of advanced questions per spec §6.3, canonical JSON and `questionSetHash`).
**Tests.** `test/verify-questions.test.ts`, `test/verify-verdict.test.ts`: every threshold at both sides of its
boundary for each level; conditional questions present/absent; advanced noul min/max, choice accept/minProbability,
score min, minConfidence, minAggregate; tie-break order including run/index; precedence call > agent > global > default
per field, `questions` replaced not merged, `level` + `template` together refused; hash stable across key order.
**Acceptance.** The level tables in code equal spec §6.2 (checked against a fixture copy of the table, reviewed in the
PR); coverage gates hold.

## WP4 — Loop, candidate store, JobRunner integration (`packages/media`; ≈ 3 agent days)

**Files.** `packages/media/src/verify/loop.ts` (`runVerifiedGeneration`: spec §4.2, §7.1–§7.5; ports: adapter call,
`candidates: OutputStore`, `outputs: OutputStore`, `verifier` (client + key/egress/privacy gate supplied by the host),
`runBudget { admit(key, units), settle(key, units|null) }`, `checkBudget`, `onProgress`, `onPersist`), `packages/media/src/jobs.ts`
(`Job.verify` field; hook at today's line 95; recovery helper `finalizeInterrupted`), `packages/media/src/types.ts`
(`Progress.stage` adds `verifying`, optional `run`/`maxRuns`), `packages/media/src/store.ts` (`Manifest.verification`
optional; `OutputStore.promote(from, id)` copy-then-delete under both locks, idempotent; candidate puts with
`embedMetadata: false`; final put embeds per the job's O4 flag).
**Tests.** `test/verify-loop.test.ts` with fake adapters and the WP1 fake: pass in run 1 (one adapter call), pass in run 2,
all fail → best-of-failed, n = 3 slot filling, partial result, `seed + (k−1)`, adapter error in run 2, run-2 budget
refusal, check budget refusal, fail-open/closed matrix (spec §9.3), cancellation during generation and during a check
(candidates deleted, no offer), kill after each persisted step then `finalizeInterrupted` (zero adapter calls),
promotion crash between two candidates then repeated accept; regression: no verify config → manifest byte-identical
to a run on `main` (golden JSON).
**Acceptance.** Coverage gates hold; `JobRunner` without verify unchanged (existing `lifecycle.test.ts`, `store*.test.ts`
untouched and green).

## WP5 — Retention (`packages/media` + `packages/core`; ≈ 1.5 agent days)

**Files.** `packages/media/src/store.ts` (`prune(now, { olderThanMs })`, additive), `packages/core/src/composition/media-store.ts`
(new: one `OutputStore` per home for outputs and one for candidates, from the live config), `packages/core/src/composition/media.ts`,
`packages/core/src/composition/index.ts` (use the shared store also when no adapter is configured; register the
`media.retention` system job with an interval timer like the capabilities recheck, run at start and on
`media.retentionDays` change), `packages/core/src/channels/core-host.ts` (shared store), `packages/core/src/media-retention.ts`
(new: the sweep of spec §13.3 over outputs, candidates, offers, terminal job records, owner records; orphan candidates
at start; upgrade deferral and inbox `system` entry of spec §13.4).
**Tests.** `packages/media/test/store.coverage.test.ts` (prune with `olderThanMs`), `packages/core/test/media-retention.test.ts`
(fake clock: each category deleted at the boundary, running jobs untouched, live change applied on the next run,
media-index `onDelete` received through the shared instance, ledger rows hold counts only, deferral + one inbox entry),
`packages/core/test/channels/core-host.test.ts` (shared instance).
**Acceptance.** Media older than the setting disappear within one sweep interval; nothing else changes on a home without
old media. Can land before WP6 with the retention value read through a typed accessor that defaults to "off" until the
config key exists (the sweep is inert then).

## WP6 — Schemas, generated code and docs (`packages/config-schema`, `packages/rpc-schema`; ≈ 1.5 agent days; needs Q15)

**Files.** `packages/config-schema/schema/config.schema.json` (`media.verify.*`, `agents.<id>.media.verify.*`,
`media.retentionDays` per spec §5.2 with `x-restart`, `x-tier`, `x-write-roles`, `x-audit`), `packages/rpc-schema/schema/rpc.schema.json`
(spec §12.2: `request.verify` on `media.generate`/`media.edit`; `verification`/`offerId` on jobs; `stage`/`run`/`maxRuns`
on `media.job.progress`; `media.offer.get|list|resolve`, `media.offer.resolved`, `media.verify.status|templates|test`),
`pnpm gen` outputs (`generated/*`, fixtures, `packages/web/src/palette/settings-index.ts`), `pnpm docs:gen` outputs
(`docs/rpc.md`, `docs/config.md`, `docs/cli.md` after WP9; this needs `cargo build -q -p plur1bus`, so the WP runs on a
machine/CI with room for the Rust build, not in a disk-limited agent worktree), `docs/errors.md` (reasons
`local-only` for media verify, `verify-unconfigured`, `offer-resolved`, `offer-expired`).
**Tests.** Existing schema tests (every key `x-restart`/`x-tier`, methods `x-stability`/`x-since`/`x-server`, params
closed) plus new cases for the added keys; `node scripts/check-doc-links.mjs`; `pnpm docs:check` in CI.
**Acceptance.** `pnpm --filter @plur1bus/config-schema test`, `pnpm --filter @plur1bus/rpc-schema test` green;
`docs:check` clean.

## WP7 — Core composition, budget, offers, RPC handlers, turn tools (`packages/core`; ≈ 3 agent days)

**Files.** `packages/core/src/composition/media-verify.ts` (new: per-check verifier: `localOnlyFor` → `egress.decide` →
`createAuthSecretStore(...).get(apiKeyRef)` → `registerSecret` → client; `verifyEgressHosts(config)`; local-adapter
detection for the notice), `packages/core/src/rpc/media-surface.ts` (resolve verify config at submit; per-call
`verify.enabled` under local-only → `E_DENIED` reason `local-only` before enqueue; per-run admission via
`checkBeforeCall` with keys `<jobId>#r<k>`, check reservations with provider `typesafe`; `publicJob` adds
`verification`/`offerId`; progress notification fields; `recover()` uses `finalizeInterrupted`; offer methods),
`packages/core/src/media-offers.ts` (new: offer records, resolve with RBAC per spec §8.4, promotion, `media.offer.resolved`
notification), `packages/core/src/composition/tools.ts` (turn tools call `runVerifiedGeneration`; `verify` input; tool
result `verification` + `offer` per spec §8.3; new tool `media.offer.resolve`), `packages/core/src/inbox/producers.ts`
(only if Q11 = yes: `media-offer` entries for RPC-direct jobs, settled on resolve/expiry).
**Tests.** `packages/core/test/rpc/media-verify.test.ts` (fake adapter + WP1 fake: inherited verify under local-only →
zero requests and `unchecked: local-only`; explicit per-call → `E_DENIED` before the adapter; egress denied; secret
missing; key never in job/manifest/offer/log/notification — compared against the leased value; per-run budget events;
recovery after restart), `packages/core/test/rpc/media-offers.test.ts` (accept/decline/expire, `E_CONFLICT` reasons,
`E_NOT_FOUND`, RBAC requester/other member/Owner, notification audience), `packages/core/test/composition/tools.test.ts`
(tool result shape; alternates not `{ id, files }` before yes; `media.offer.resolve` returns `{ id, files }` objects on
accept), existing `media-budget.test.ts` and `media-video.test.ts` unchanged and green.
**Acceptance.** `pnpm --filter @plur1bus/core test` for the touched files green (engine-dependent tests may fail locally,
known); `pnpm --filter @plur1bus/core typecheck`.

## WP8 — Web UI and switchboard (`packages/web`, `packages/core/src/channels`; ≈ 3 agent days)

**Files.** `packages/core/src/channels/switchboard.ts` (`#collectMedia` also collects `offer` objects; after
`flushMedia`, the question text in `channels.<name>.locale` through `output()`; no buttons unless Q9 says so),
`packages/core/src/channels/offer-text.ts` (new: en/de strings of spec §8.2), `packages/web/src/pages/chat/model.ts`
(`offerReference` → offer entry; several output ids per tool result), `packages/web/src/pages/chat/*` offer card
component, `packages/web/src/pages/surfaces/media.ts` (Settings > Media "Image check (Preview)" and retention, spec
§12.3), the agent page's media override, gallery badge/drawer/"Pending alternates" (`packages/web/src/pages/gallery.ts`,
`library`), i18n catalogues de/en.
**Tests.** `packages/core/test/channels/switchboard.test.ts` (question after images in en and de; suppressed by a `never`
profile and by the rate limit; free-text yes → tool → alternates sent through `sendOutput`; no → nothing sent),
`packages/core/test/channels/e2e-telegram.test.ts` (one offer round trip), `packages/web/test/chat-model.test.ts`
(offer entry), new `packages/web/test/media-verify-settings.test.ts` and `offer-card.test.ts` (mock server; axe light/dark,
en/de, 360/1440 px like the inbox hardening tests), `node scripts/check-i18n.mjs`, `styles.test.ts` (no inline styles).
**Acceptance.** Web tests green with `PLUR1BUS_WEB_E2E_REQUIRED=1` in CI; the §11.2 notice visible whenever a local
adapter and verification are both on.

## WP9 — CLI (`crates/plur1bus`; ≈ 1.5 agent days; Claude agent)

**Files.** `crates/plur1bus/src/commands/media.rs` (`--verify[=level]`, `--verify-template`, `--verify-retries`,
`--no-verify`; `--wait` prints the offer question on stderr; `media offers`, `media offer show|accept|decline`,
`media verify status|templates|test`; schema ids per spec §12.4; `--out` for accepted images never overwrites),
`crates/plur1bus/src/commands/config.rs` (post-write notice on stderr for `media.verify.enabled` and
`agents.<id>.media.verify.enabled` when `media.verify.status` reports local adapters), `crates/plur1bus/src/commands/help_examples.rs`.
**Tests.** Unit tests beside the existing `parse_generate_and_json` (request JSON for each flag; ids; `--no-verify` vs
`--verify` conflict), a `tests/` case against the fake core for `offer accept --out`, `cargo fmt`, `cargo clippy -D warnings`.
**Acceptance.** `docs/cli.md` regenerated in WP6's docs:gen run; `check-docs-commands.mjs` passes for the user docs of WP10.

## WP10 — Docs (≈ 1 agent day)

**Files.** New `docs/media-verify.md` (how it works, levels and their questions, advanced mode and templates, what
leaves the machine, costs as tokens, failure behaviour, offers, limits from TypeSafe with the fetch date);
`docs/media.md` (retention section replacing "the host must schedule it", verification pointer, candidate store);
`docs/adr/ADR-017-media.md` (amendment 2026-10-21: opt-in verification, never replacing moderation; retention);
`docs/privacy.md` (verification under local-only), `docs/budgets.md` (runs and checks), `docs/inbox.md` (Q11),
`docs/egress.md` (inventory host), user docs `docs/user/de/media.md`, `docs/user/en/media.md`,
`docs/user/de/datenschutz.md`, `docs/user/en/privacy.md`.
**Tests.** `node scripts/check-doc-links.mjs`; the bundled user docs check and `check-docs-commands.mjs` in `docs:check`.
**Acceptance.** Every new setting, method, command and reason is documented once; no collective error-code names.

## WP11 — Live calibration and acceptance (≈ 1 agent day + owner; needs the owner's TypeSafe key)

**Content.** A scripted, opt-in run (`PLUR1BUS_TYPESAFE_LIVE=1`, never in CI) of about 100 checks over a fixed prompt set
(German and English; matching, near-miss and unrelated images generated once and stored locally) at the three levels;
record pass rates, token usage per image, latency percentiles and any rejected request; adjust the `@1` tables or
publish them as `@2`; confirm the model pin (Q5) and the docs contradiction on image input. One end-to-end run per
surface (web chat, Telegram test bot, CLI) with retries forced by a strict level.
**Acceptance.** A short status note under `docs/handoff/status/` with the measured numbers; spec §3.7 unknowns updated
with measured values; owner sign-off on the thresholds.

## Estimate

| WP | Agent days |
|---|---|
| WP0 | 0.25 |
| WP1 | 1.5 |
| WP2 | 2 |
| WP3 | 1.5 |
| WP4 | 3 |
| WP5 | 1.5 |
| WP6 | 1.5 |
| WP7 | 3 |
| WP8 | 3 |
| WP9 | 1.5 |
| WP10 | 1 |
| WP11 | 1 (+ owner) |
| **Total** | **≈ 20.75** |

Critical path: WP1–WP3 (parallel, ≈ 2) → WP4 (3) → WP7 (3) → WP8 (3) → WP11 (1) ≈ 12 days with parallel lanes for
WP5, WP6, WP9, WP10.
