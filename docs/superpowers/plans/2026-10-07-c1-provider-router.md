# C1 — Provider router with fallback and circuit breaker

Scope: new files under `packages/providers/src/router/` and `packages/providers/test/router/` (plus one export line in `src/index.ts`). Builds on the chat_completions adapter (`ProviderError` taxonomy, `stream()`).

## Design
- **Profiles**: `profile name -> ordered Candidate[]` (`provider`, `model`, `adapter`). The request's `model` is replaced per candidate.
- **Classification** (`classify.ts`): retryable = rate_limit (non-quota), server, timeout, network. Not retryable on the same candidate: auth, content_filter, context_length, bad_request, protocol, aborted, unknown.
  Fallback allowed after: retryable kinds (once retries are spent) and `auth` (another candidate has another credential). **Never** after content_filter / context_length / bad_request / protocol / aborted / unknown (switching vendor would dodge a policy decision or repeat the same error) — fail closed.
- **Retry**: exponential backoff, full jitter, honours `retryAfterMs`; a Retry-After above `maxRetryAfterMs` skips straight to fallback. Clock and random are injected (fake clock in tests).
- **Breaker** per `provider/model`: closed -> open after N consecutive breaker-relevant failures; open -> half_open after `openMs`; half_open admits one probe at a time; probe success closes, failure re-opens.
- **Fallback only before the first streamed event**; afterwards the error goes to the caller (and still counts for the breaker).
- **provider.fallback** event is emitted through the `onEvent` sink before the next candidate is tried; also `provider.retry`, `provider.breaker`, `provider.budget_denied`, `provider.skipped`. A result/stream carries `served` (provider, model) so the caller can show who answered.
- **Budget guard port** (`BudgetGuard.authorize`): asked before *every* attempt (retries and fallbacks included) with that candidate's identity; a denial skips the candidate (it never lets a fallback through unchecked); `maxAttempts` bounds total spend. Settled with usage on success/partial. The real budget store (`packages/core/src/budget`) is not imported; an adapter implements the port later.

## Rulings
See `// RULING:` markers in the code; listed in the PR.
