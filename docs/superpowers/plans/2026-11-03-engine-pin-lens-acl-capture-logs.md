# Engine pin move: Semantic Lens ACL and content-free capture logs (upstream #278, #279)

Status: plan, 2026-11-03. Owner request: adopt the latest PLUR1BUS engine changes into the Harness and the Rust engine.

Harness prerequisite update, 2026-11-04: #879 and #820 have actually merged into `main` in that order. The Harness still pins `9f34008c`; this documentation PR does not consume the upstream security fixes or complete P0/P1. The source inventory below is dated 2026-11-03 and must be refreshed before executing the pin move.

## 1. What changed upstream

Repository `Cyb3rb1ade/openclaw-plur1bus-memory`. The Harness pins
`9f34008c143c5da87b2194b5a28442b407ff8ba7` (branch `feat/reembedding-validate`, PR #275, contract 1.17.0).
Compared with that pin, `main` (`f63c3365`, 2026-11-02) carries six new commits in nine files:

| Upstream | Change | Files |
|---|---|---|
| #278 (`8e753189`, closes #276) | Semantic Lens hydration authorizes every raw row with `checkAccess(memoryCtx, row)` before projection or quotas; missing or denied rows are dropped and consume no Lens slot. Docs: Lens is enabled by default, CRR is opt-in. 27 end-to-end regressions. | `engine/recall/assemble-prompt-context.js`, `docs/recall-architecture.md`, `tests/engine-semantic-lens-acl.test.js` |
| #279 (`92bb9c04`, closes #277) | The batch-embedding fallback warning and the scheduler's late-capture diagnostic emit fixed messages (`operation=capture stage=batch-embedding errorCode=batch-embedding-failed`; `operation=capture stage=late-settlement errorCode=capture-late-error`), never inspect the error and omit the agent id. Six regressions. | `engine/capture/capture-turn.js`, `lib/runtime-scheduler.js`, `tests/capture-content-free-logging.test.js` |
| `f9c17c09`, `0dac5887` | `zod` 4.6.6 added to the engine's `overrides`. | `package.json`, `package-lock.json` |

No change to `types/engine.d.ts`, `engine/config/engine-config.schema.json`, the RPC or the engine contract (stays 1.17.0).

Two pin commits are not on `main`: `98e18b6b` (`admin.reembedding.validate`, contract 1.17.0) and `9f34008c` (zod override). They come with PR #275, which is still open.

Version note: `v7.19.0` (`83640e6b`, 2026-11-02) is a release-line tag of the OpenClaw plugin and has diverged from `main` (52 commits not on `main`, 488 `main` commits not in the tag), so it cannot be the Harness pin. Its changes are handled in [the 7.19.0 adoption plan](2026-11-03-plur1bus-7-19-adoption.md). `main`'s `package.json` still says `7.18.4`.

## 2. Why it matters for the Harness

- The Harness core runs the Node engine in production through `@cyb3rb1ade/plur1bus-memory` (`packages/core/package.json`). With the current pin, Semantic Lens (enabled by default) can put another principal's user-scoped memory into the prompt. #278 closes that leak. This is a security fix; the pin move has priority over feature work.
- The Rust engine already enforces the Lens ACL (RE-04/T5, #871) as the sole controller-authorized parity exception `RE-04-T5-LENS-ACL`. After the pin move, Node and Rust agree, and the exception goes away.
- Capture logging in Rust (RE-05) was ruled content-free; Node now matches, so the drift entry becomes an upstream-aligned rule.
- `zod`: the Harness lockfile currently resolves only `zod@4.6.6`. Companion S1 moves the security override to `4.6.7` under the dependency policy; the pin bump keeps that effective override.

## 3. Tasks

### P0 – New engine pin (engine repo; Owner)

Merge PR #275 into engine `main` after its review (or merge `main` into `feat/reembedding-validate` with a normal merge commit), together with PR #257 (rerank order) and the `zod` 4.6.7 override from the 7.19.0 adoption plan (E1). The resulting commit, or an engine-line tag cut from it, is `PIN_NEW`. It must contain `98e18b6b`, `8e753189`, `92bb9c04`, #257 and the zod override. Fix the `package.json` version field to the released version so the Harness doctor and `engine.version` report it correctly.

Acceptance: `npm ci --ignore-scripts`, `npm run lint` and `npm test` green on `PIN_NEW` (upstream reports 6,371 passed for #278 + #279 combined).

### P1 – Harness pin bump (TypeScript; Harness PR, about 0.5 agent-days)

- `packages/core/package.json`: `@cyb3rb1ade/plur1bus-memory` → `#PIN_NEW`; regenerate `pnpm-lock.yaml`.
- `CORE_CONTRACT` stays `1.17.0` (no contract delta). Run `pnpm test:prep` and regenerate the core startup vectors if they depend on the pin.
- `CHANGELOG.md` under Fixed: recall no longer lets Semantic Lens surface another person's memories; capture fallback and late-error logs are content-free. Name the pin.
- Update every document that names the pin as the current engine (`CHANGELOG` entries stay historical).
- Tests: the full core suite with the real engine in CI (Linux, macOS, Windows), `engine-config-parity.test.ts`, `pnpm docs:check`, `pnpm audit` (the 4.6.7 security override from companion S1 remains effective).
- Harness system test (new): a recall through the real engine with an authorized base row, a foreign user-scoped row linked by a Lens community and Lens at its default; the final prompt contains the base and not the foreign row.

### P2 – Rust engine provenance (Rust; engine-crate PR, Owner merge, about 1 agent-day)

- Move the pin references to `PIN_NEW`: `crates/plur1bus-engine/schema/SOURCES.md`, `schema/DRIFT.json` (`engineCommit`), `schema/engine-contract.schema.json` (`x-source-commit`), the headers of `src/recall/{memory,style,temporal}_constants.rs` and `src/store/sqlite.rs`, `tests/fixtures/neo-v1/{make.mjs,expected.json}`.
- Drift checks: `engine-contract.schema.json` and `engine-config.schema.json` must stay content-identical (no upstream change); the verbatim constants and DDL strings must be byte-identical at `PIN_NEW`. Any difference is a stop.
- Re-record every golden whose recorder verifies source hashes (`tests/fixtures/recall/record.mjs`, `render-sources.json` with 39 hashes, which include `assemble-prompt-context.js`) at `PIN_NEW` with Node 24.21.0. Expected render outputs must be byte-identical except the four default/enabled Lens cases in `render-plain.json`, which now match the Rust result without an exception. The namespace rerank-order golden changes authorized by companion H2 are reviewed separately against #257. Any other output difference is a stop and gets reported, not adopted.

### P3 – Remove the Lens parity exception (same PR as P2)

- Drop `parityException.id = RE-04-T5-LENS-ACL` from the four cases and the exception section from `tests/fixtures/recall/golden/render/README.md`; rewrite the Lens paragraph in `docs/engine-stores.md` and the line in `crates/plur1bus-engine/README.md` as plain parity ("Node and Rust both authorize Lens hydration with the canonical request ACL").
- Mark the stop report `RE-04-T5-semantic-lens-acl-stop.md` as resolved upstream by #278, with the pin.
- Keep the Rust Lens ACL tests (all three Lens states); they are now parity tests.

### P4 – Capture logging parity (Rust RE-05; capture task owner, about 0.5 agent-days)

- The Rust capture path emits the same fixed messages as Node for the batch-embedding fallback and the late settlement after a timeout, never formats the error and omits the agent id in the late diagnostic.
- Turn the RE-05 drift-ledger entry for content-free capture logging into an upstream-aligned rule with the pin.
- Tests: a provider error carrying capture text, a plain rejection object and a throwing coercion hook; the logs contain only the fixed message, the result and queue accounting are unchanged.
- If RE-05 capture is not yet on `main`, this becomes a requirement in the open RE-05 task instead of a separate PR.

## 4. Order and stops

P0 → P1 (security fix live) → P2 + P3 → P4. P1 does not wait for P2.
Stop and report if: `PIN_NEW` lacks #275, #278, #279 or #257; any contract, config schema or constant changes, or any golden output changes outside the four Lens cases and the #257 namespace rerank-order cases explicitly authorized by companion H2; the core suite fails with the real engine for a reason other than the known main failures.

## 5. Housekeeping

The upstream issues #276 and #277 exist and are closed by #278 and #279, so the controller's open question about filing those two engine issues is settled.
