# Turn composition

`packages/core/src/composition/` wires the pieces of a chat turn together: provider credentials and adapters, the
provider router with budget admission and billing checks, tool registration, media, the inbox, collaboration and the
trace spans around each stage. It adds little logic of its own; most behaviour below is the seam between modules. The
pipeline as a whole is described in [architecture/turn-pipeline.md](architecture/turn-pipeline.md); this page records
what the code does at the edges, derived from `packages/core/test/composition/` and the source.

Cases that the tests tag "characterization" are observed behaviour that no specification asked for. They are described
as they are, and the ones that look like defects are collected under [Open points](#open-points-offene-punkte). They are
not commitments. Test references are `file > test name` relative to `packages/core/test/composition/`.

## Parts

| File | Role |
|---|---|
| `index.ts` | `openTurnComposition`: opens budget, voice, auth, MCP, media, sessions, collaboration, in this order, and closes them in reverse. `approvalPolicyContext` (fail closed when the permission stores are not open) and `routerEventSink` (router events to log and audit). |
| `auth.ts` | `composeAuth`: one streaming adapter per provider definition, credential lease per attempt, tool-call dialect family per wire format, billing class per provider (`billingClassOf`). |
| `provider.ts` | `createTurnProvider`: the turn loop (identity, triage, tool registry, capability routing, prompt, provider call, tool dispatch, result cap), repair of invalid tool arguments, budget tickets and retry budget, cross-billing refusal. |
| `http.ts` | `providerFetch` (egress decision, pinned address, no redirects) and `anthropicBreakpoints` (cache markers for the Anthropic wire body). |
| `media.ts` | `composeMedia`: the first configured image adapter, wrapped so that egress and the secret lease happen per operation; the output store under `<home>/media/outputs`. |
| `tools.ts` | `composeTools`: file tools, host tools, `exec.run`, media tools, `web.search` and MCP tools into a fresh registry per turn. |
| `inbox.ts` | `openInbox` (store, service, one-off copy of legacy break-glass notices) and `lateInboxPort`. |
| `trace.ts` | `stage` (start/end/error records with trace and span ids) and `errorCode`. |
| `legacy.ts`, `collaboration.ts` | `legacyAdapter` (a plain `ChatProvider` as a router adapter, test seam) and `composedAgentRunner` (collaboration runs through the same pipeline). |

## Billing class (`billingClassOf`, `auth.ts`)

ADR-005: a fallback must not cross silently between a subscription ("plan") and a metered ("paid") provider. The class of
each provider is derived once in `composeAuth` and stored in `billing[providerId]` only if one was found.

Order of decision:

1. `profile.client_registration === "dynamic_on_authorize"` is always `plan`.
2. The explicit path: the definition's `billingPath`, else `profile.billing_path` (the definition wins). `chatgpt_plan`,
   `cli_login`, `plan` give `plan`; `api_key`, `workload`, `paid` give `paid`.
3. Without an explicit path, the credential kind: `api_key`, `adc`, `federated_token` give `paid`; `oauth_pkce`,
   `device_code`, `external_cli` give `plan`.

Tests: `billing.test.ts` (all cases except the two below).

* **Unknown explicit path: no class.** `enterprise`, `""` and `PLAN` (the match is case-sensitive) do not fall back to the
  credential kind; the result is `undefined`. Test: `billing.test.ts > characterization: an unknown explicit billing path yields no class instead of falling back to the kind`.
* **Unknown kind or missing profile: no class.** `kind: "mystery"`, `{}` and `undefined` give `undefined`. Test:
  `billing.test.ts > characterization: an unknown credential kind and a missing profile yield no class`.
* A provider without a class is never refused for billing: the guard in `provider.ts` compares `billing[primary]` with
  `billing[candidate]` and only refuses when **both** are set and differ and the profile does not allow cross billing
  (`providers.modelProfilePolicy.<profile>.allowCrossBilling`). A refusal emits `provider.cross_billing_refused` (warning)
  and lets the router try the next candidate.

## Provider turn loop (`provider.ts`)

Behaviour at the edges (tests in `provider.test.ts`):

* Each round streams the model's text as `delta` chunks. After the stream, if the final text is **longer** than what was
  streamed and **starts with** it, the remainder is emitted as one extra `delta`; if the final text does not start with
  the streamed text, nothing extra is emitted and the streamed text stands. Test: `provider.test.ts > characterization: the unstreamed remainder of the final text is emitted once; a mismatching final text is not`.
* Usage is accumulated over all rounds and each `usage` chunk carries the running total (`provider.test.ts > usage is accumulated over all rounds of a turn`).
* A tool call for a name that is not among the selected tools ends the turn with `TurnToolError("tool-unknown")`. Invalid
  arguments are repaired at most once; a second invalid answer ends the turn with `tool-call-invalid`. The round limit
  (default 25, `maxRounds`) ends the turn with `turn-round-limit` and the limit as `detail`.
* **Duplicate tool-call ids in one response are not rejected.** Both calls run, in order, and both results are appended as
  `tool` messages under the same id. Test: `provider.test.ts > characterization: duplicate tool-call ids in one response are not rejected`.
* **A failing tool ends the turn** with a `TurnToolError` whose `code` is the tool's own error code and whose `detail` is the
  original error envelope. That envelope contains the text the tool threw. The text is **not** sent to the model (no second
  model call is made) and is not part of the streamed chunks. Tests: `provider.test.ts > a failing tool ends the turn with the tool's own error code and the original envelope`,
  `provider.test.ts > characterization: a tool's thrown message is kept in TurnToolError.detail and never reaches the model or the stream`.

## Error codes of a turn (`trace.ts`)

`errorCode(error)` produces the `code` field of the `error` span record. Precedence: a string `code`, else a string `kind`,
else `"turn-failed"`. Tests: `trace.test.ts > composition/trace errorCode`.

* `code` wins over `kind`; a non-string `code` (for example the number `429`) is skipped and the string `kind` is used; if
  both are non-strings the result is `turn-failed`. Tests (all `characterization:` rows of the table): `code wins over kind`,
  `non-string code falls through to kind`, `non-string code and kind`.
* An empty string is still a string: `{ code: "" }` gives `""`, an empty code in the log. Test row `empty-string code is still a string`.
* `null`, `undefined`, primitives and `{}` give `turn-failed`.

`stage(name, signal, log, run)` throws first if the signal is already aborted, logs `start`, runs the work, checks the
signal again after the work, logs `end` with `durationMs`, or logs `error` with the code and rethrows the original
exception object. Span ids are 16 hex characters, trace ids 32.

## Provider HTTP (`http.ts`)

* `providerFetch` with an injected transport (recorded fixtures) never consults egress and forces `redirect: "error"`. Only
  for `anthropic_messages` and only for a **string** body the JSON is parsed and the cache markers are rewritten; any other body
  is passed through, and a request without body forwards no `body` key.
* **An unparsable string body on an anthropic request** is not wrapped: the raw `SyntaxError` from `JSON.parse` escapes and
  the transport is never called. Test: `http.test.ts > characterization: an unparsable anthropic body surfaces a raw SyntaxError and sends nothing`.
* Without an injected transport: abort check, egress decision (`egress_denied` as a `ProviderError`, nothing connected),
  refusal of non-http(s) URLs, credentials in the URL and non-string bodies (`request_refused_locally`), connection to the
  address egress vetted while keeping the original host name, and refusal of any 3xx response (`provider redirects refused`).
  Tests: `http.test.ts > composition/http providerFetch over the pinned egress transport`.
* `anthropicBreakpoints` returns the body untouched without a rendered prompt in scope; otherwise it clears all old
  `cache_control` markers and places exactly the builder's breakpoints. A breakpoint whose segment has no counterpart in the
  body is dropped instead of being placed elsewhere.

## Media (`media.ts`)

* `composeMedia` returns `null` without configured adapters, takes only the **first** one, refuses a plaintext `apiKey` (also an
  empty string) with `MediaError("unsupported_parameter")` and validates the adapter configuration at composition time.
  Creation needs neither a secret nor an egress decision.
* Per operation: abort check, egress decision for the base URL and then every download host (one refusal stops the
  operation with `backend_unavailable`, before any secret is read), secret lease as the core (a missing secret is
  `backend_unavailable`, never a keyless request), second abort check, adapter call. The lease is revoked right away.
* **The abort signal is checked before egress and again after the secret lookup, not between them.** A cancel that lands
  while egress is deciding still leases the secret once; the operation then throws the abort reason and the lease is
  revoked. Test: `media.test.ts > characterization: a signal aborted while egress decides still leases the secret once, then throws the abort reason`.

## Other composition behaviour covered by tests

* `openTurnComposition`: stores live under `<home>/state`; `close()` is idempotent; an unusable budget store disables the budget
  and what needs it, an unusable session store fails the whole composition; a provider factory that throws closes
  everything opened before (`open.test.ts`).
* `approvalPolicyContext` throws when the permission stores are not open, so the dispatcher refuses the call (fail closed);
  `routerEventSink` logs breaker and retry as info, fallback, skipped and cross-billing refusals as warnings, audits each
  event as actor `core`, and logs an audit failure without passing it on (`wiring.test.ts`).
* `composeTools` registers file tools (only with a root), host tools and `exec.run` in a fixed order, a fresh registry per
  turn, refuses an extra tool whose name is taken, keeps file tools inside their roots and denies state directories
  (`tools.test.ts`).
* `openInbox` creates `state/inbox.sqlite`, copies legacy break-glass notices once (never the reason text), logs and
  continues when the legacy source fails, and fails the open on invalid retention values; `lateInboxPort` drops calls
  while no service exists (`inbox.test.ts`).
* `composedAgentRunner` refuses to run outside the right `AgentScope` or without an authenticated caller and caps long answers
  at about 2000 tokens with the full text in a private file (`legacy-collab.test.ts`).

## Open points (Offene Punkte)

These are observations, not decisions. Do not rely on them.

1. **A mistyped `billingPath` disables the billing check for that provider.** An unknown explicit path yields no class instead
   of falling back to the credential kind (or failing), and a provider without a class is never refused for billing. A plan
   provider with `billingPath: "enterprise"` can therefore be reached by fallback from a paid one and vice versa without an
   event. Nothing in `composeAuth` logs the missing class.
2. **Unknown kinds and missing profiles also silently yield no class**, with the same effect.
3. **`TurnToolError.detail` carries the raw text a tool threw.** The turn loop does not forward it, but any consumer of
   `detail` receives text a tool or its library chose (the test uses a secret-like marker to show this). Whether `detail`
   should be reduced to a code is undecided.
4. **Duplicate tool-call ids are sent back under one id.** A provider that requires unique ids may reject the next
   request; the code does not check for this.
5. **An unparsable anthropic body leaks a raw `SyntaxError`** and not a `ProviderError`, so retry and error mapping in the router
   see an untyped failure.
6. **`errorCode` returns `""` for an empty-string `code`**, which produces an error record without a usable code. `kind` is not
   consulted in that case.
7. **Late cancel in `composeMedia` still leases a secret** (once, revoked afterwards). A lease is taken for an operation that was already
   cancelled.
8. **Known gap (`todo` test, not fixed):** `openInbox` copies legacy break-glass notices in one pass and stops at the first
   malformed notice, so valid notices behind it are lost and the copy is retried at every start with the same result
   (`inbox.test.ts > KNOWN GAP: core/composition openInbox ...`).
