# M2 criterion 9 — model switch and live cache evidence (2026-10-16)

## Behaviour and inventory

`session.model.set` is additive. It resolves the session owner and agent use right, rejects archived/non-direct/busy sessions and unknown/empty profiles, and returns a cache/cost warning without mutation by default. Only `confirmed: true` with the preview's `expectedRevision` commits the profile selection. SQLite migration v4 persists it with a revision; compare-and-swap prevents stale/ABA confirmations. Running turns keep their selected profile; a switch is refused while a turn exists. Model profiles retain their existing auth, budget, billing/fallback and tool-dispatch rules.

The turn loop uses the confirmed profile for context-window selection and the real router. Frozen session memory and the existing per-model prompt registry are retained. Returning to a model recovers the same prefix identity and stable-zone hashes. No engine or prompt-cache registry reset is introduced. Recalls remain live outside zone 3; the existing prompt session tests explicitly cover tool-invoked recall as a tail `tool_result`. Automatic recall in the composition still uses context in the tail: no claim that all production recall is now a tool result.

CLI: `plur1bus chat --session <id> --model <configured-profile>` warns and asks; pipes/JSON need `--yes`. The warning is on stderr even with `--yes`; stdout remains the raw chat RPC result. `LANG=de…` selects the German warning. The Web chat adds a DE/EN preview/confirm/cancel control that confirms the displayed profile/revision and resets on chat navigation.

**Incognito chats:** the profile is kept in the session's own store, so a switch also works for ephemeral (incognito) sessions: the in-memory store holds it, nothing is persisted, and ownership, agent-use right and human-only rules are the same as for durable sessions.

**Web transport (2026-10-18):** the browser switches through `chat.model.get` / `chat.model.set` (`GET`/`PATCH /api/v1/chats/{id}/model`), whose identity is the authenticated person, never a `caller` from the browser; CSRF, rate limit and roles are those of every chat write, and `chat.model.set` is people-only and never a WebMCP tool. Both also carry the chat's reasoning choice (see [model-discovery.md](model-discovery.md#reasoning-levels)); `session.model.set` takes the same optional `reasoning`. The paragraph below is the history of the gap that closed.

**KNOWN GAP / handoff to M3 (closed by the chat routes above):** `packages/api/src/rpc-route.ts` currently allowlists chat methods and does not yet allow `session.model.set`. That transport is explicitly outside this package's scope. The browser control reports refusal safely, but end-to-end browser switching is not accepted until M3 adds this method through its authenticated caller, agent-rights and CSRF path. No API transport was changed. WebMCP explicitly forbids the method; core RBAC is human-only. All three Rust parity tables, schema fixtures, generated Python/schema capabilities and generated RPC/CLI docs are updated.

## B5 nightly

`b5-provider-cache` is appended as its own job to `nightly.yml`; existing jobs are untouched. Owner supplies repository secret `ANTHROPIC_API_KEY` and variable `PLUR1BUS_B5_MODEL` naming the model to test. There is no default model choice and no locally executed paid call. The test additionally requires GitHub Actions' `nightly` workflow context. Missing gate/key/model writes a machine-readable skipped result and a clean test skip.

The production Anthropic adapter makes six sequential real requests with explicit cache markers and a stable prompt-builder prefix. Provider-reported `inputTokens` already includes cache-read and cache-creation tokens; `cachedInputTokens / inputTokens` is therefore the read share. Every turn from 3 must individually reach 0.90; a token-weighted aggregate is also recorded. Missing/invalid usage or a provider failure fails the run. The artifact holds counts, hashes, model and status; no response text, credential, request body or raw provider error is logged. Pure evaluator tests exercise cold turns and invalid/missing counts.

**Built, not accepted:** no credential was used and no live run was made. Acceptance requires the owner to inspect a successful, non-skipped `b5-provider-cache` artifact. Do not call criterion 9 fulfilled until that and Web acceptance are complete.

## Named evidence

- `packages/core/test/session/model-switch.test.ts`: preview/confirmation, owner isolation, missing profile, stale/ABA, busy refusal and restart persistence.
- `packages/core/test/integration/core-pipeline.test.ts`: actual Core RPC to actual router; an unconfirmed preview leaves the next turn unchanged; confirmed switch and return.
- `packages/core/test/session/role-routing.test.ts`: selected model context and router, stable hashes on return, live recall only in tail.
- `packages/core/test/prompt/{session,cache-layout,b6-determinism,telemetry,b5-metrics}.test.ts`: L7/L9/B6 and synthetic accounting/evaluator boundaries.
- `tests/system/model-switch.test.ts`: built release CLI, daemon/core, refusal without `--yes`, then actual confirmed turn.
- `packages/web/test/chat-model-switch.test.ts`, `packages/web/test/i18n.test.ts`, `packages/webmcp/test/rbac-matrix.test.ts`: immutable preview confirmation, DE/EN and policy classification. The RBAC suite retains its existing known-gap TODOs; none were added or weakened here.
- `tests/nightly/b5-provider.test.ts`: live-only evidence; locally checked only the configured skip.

No new dependencies, error codes, engine changes, CI polling or merge.

Local validation: 649 focused assertions passed with zero failures; the WebMCP matrix additionally reports its 120 pre-existing TODO cases. The full core integration file passed all 12 tests and the release CLI system test passed. `cargo test -p plur1bus-rpc`: 87 passed; `cargo test -p plur1bus`: 1,648 passed, four pre-existing ignored tests. Typecheck, hygiene, i18n, generated-doc parity and rustfmt passed. The non-gating live test skipped locally as designed. A pre-existing macOS `/var` versus `/private/var` entry-guard defect in the help-doc bundler surfaced in the extra docs check and was repaired in a separate commit; all five existing bundler tests then passed.
