# F5 — Per-agent model routing

Stack: `codex/gp4-f5-model-routing` on F2 `codex/gp4-f2-decision-service` (c9632307cd).
F4 system-one/decision sources and F6 pruning/skill-selection are untouched.

## Result

Optional `agents.<id>.modelPolicy` supplies `mode: fixed|auto`, an ordered named-profile
`tiers` list and explicit `perTurn` opt-in. Schema metadata is live/advanced and defaults
are generated. Old agents without a policy retain D105 behavior. Explicit fixed mode
keeps the configured agent/default model; D105 segmentation and capability selection remain. Fixed mode ignores stored auto tiers
and retains only the selected profile's existing candidate fallback, following D30's fixed/auto distinction.

Composition owns one SessionModelRouting cache and uses the same DecisionClient as F2.
The initial auto choice receives bounded message/task/context/tool-count features and the
previous completion state. Session cache hits do not invoke routing again; per-turn changes
require opt-in. Explicit modelProfile wins and cannot overwrite the auto cache. Cancellation,
malformed/uncertain/expired decisions and a broken eligibility view cannot authorize another
model. Natural user messages never set cloudEligible for a separate cloud decision backend.

The existing ProviderRouter executes a per-request internal profile containing only the
chosen tier and subsequent allowed candidates. It owns budget, auth/secret usage, retries,
privacy and billing. Profile request defaults retain the selected profile's existing
request-level fallback semantics. Aliases are private, unique per request and removed after
stream cleanup; public trace retains named profiles. Actual fallback provider/model is pinned
for later session turns, including an intra-profile fallback. Context reservation includes
the current agent's auto tiers through the existing AgentScope.

Mapped model.selected events record actual served provider/model, profile, requested profile,
source and stable reason code. They contain no prompts or model prose. The cache key includes
agent, authenticated principal and session. A metadata restore port checks session ownership,
agent, completed turn state and current eligibility before reusing an event across restart or
cache eviction. A failed durable metadata read refuses routing rather than guessing a new
model. It uses existing SessionStore readers, including backward paging for long
streams. Incognito resolves through the existing volatile store. No new RPC is required.

## Verification

Node 24.21.0; Rust 1.95.0. Scripted in-process low-level providers only; no paid/cloud model
call. Owner identity retained; no Engine pin, lockfile, dependency, rebase/amend/force or CI polling.

- F5 routing suite: **18 passed**, no skip/TODO. Full Core restart/replay; exact tier outage
  order and actual-model cache; opt-in per-turn changes; explicit override; cancellation and
  failed-response cache; live privacy; cross-billing refusal/explicit consent; real voice
  feature deadline with abort-ignoring backend; agent context reservation; unavailable tiers
  and principal-scoped cache.
- Config-schema package: **63 passed**, including three new policy/schema/metadata tests.
- RPC-schema package: **56 passed**; only SessionEventType changes, with generated clients/docs.
- Existing relevant Core suites: **261 passed**, one unchanged opt-in live evaluation skip,
  no failures; includes all F2 decision tests, triage, role routing, provider/billing, composition
  opening/trace and voice pipeline. No test is newly skipped or weakened.
- Rust Config + RPC crates: **148 passed**, zero ignored/failures.
- Typecheck, pnpm gen, docs:gen, docs:check, Rust formatting, hygiene and diff checks pass.

## Remaining scope

F4 native/cloud decision adapters, F6 pruning/skills and F7 settings/D116 integrations remain
separate branches. A policy edit that removes a cached model, or a privacy change that forbids
it, deliberately invalidates that cache entry; it cannot preserve an unauthorized model.
The declared tier order is supplied by configuration; this phase does not claim calibrated
capability/cost measurements for arbitrary model profiles. The existing live-model opt-in
skip remains an external evaluation seam rather than model-quality acceptance evidence.
