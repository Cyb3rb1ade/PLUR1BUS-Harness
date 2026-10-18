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
| `auth.ts` | `composeAuth`: one streaming adapter per provider definition, credential lease per attempt (each leased value is registered for redaction), tool-call dialect family per wire format, billing class per provider (`billingClassOf`; a provider whose class cannot be determined is refused at load, the others are unaffected). |
| `provider.ts` | `createTurnProvider`: the turn loop (identity, triage, tool registry, capability routing, prompt, provider call, tool dispatch, result cap), repair of invalid tool arguments, budget tickets and retry budget, cross-billing refusal. |
| `http.ts` | `providerFetch` (egress decision, pinned address, no redirects) and `anthropicBreakpoints` (cache markers for the Anthropic wire body). |
| `media.ts` | `composeMedia`: the first configured image adapter, wrapped so that egress and the secret lease happen per operation; the output store under `<home>/media/outputs`. |
| `tools.ts` | `composeTools`: file tools, host tools, `exec.run`, media tools, `web.search`, `secret_names` and MCP tools into a fresh registry per turn. |
| `inbox.ts` | `openInbox` (store, service, one-off copy of legacy break-glass notices) and `lateInboxPort`. |
| `trace.ts` | `stage` (start/end/error records with trace and span ids) and `errorCode`. |
| `legacy.ts`, `collaboration.ts` | `legacyAdapter` (a plain `ChatProvider` as a router adapter, test seam) and `composedAgentRunner` (collaboration runs through the same pipeline). |

## Billing class (`billingClassOf`, `auth.ts`)

ADR-005: a fallback must not cross silently between a subscription ("plan") and a metered ("paid") provider. The class of
each provider is derived once in `composeAuth` and stored in `billing[providerId]`. Every composed provider has a class:
a provider without one is refused at load, alone (fail closed, below).

Order of decision:

1. `profile.client_registration === "dynamic_on_authorize"` is always `plan`.
2. The explicit path: the definition's `billingPath`, else `profile.billing_path` (the definition wins). `chatgpt_plan`,
   `cli_login`, `plan` give `plan`; `api_key`, `workload`, `paid` give `paid`.
3. Without an explicit path, the credential kind: `api_key`, `adc`, `federated_token` give `paid`; `oauth_pkce`,
   `device_code`, `external_cli` give `plan`.

Tests: `billing.test.ts`.

* **Unknown explicit path, unknown kind or missing profile: that provider is refused at load.** `billingClassOf` answers
  `undefined` for an explicit path outside the vocabulary (`enterprise`, `""`, `PLAN`: the match is case-sensitive and never
  falls back to the credential kind), for an unknown credential kind and for a missing profile. `composeAuth` then refuses
  only that provider: it gets no adapter, no class and no model-profile candidate (a profile left without candidates is
  dropped), so it can never run without a billing class. Every other provider is composed and serves turns as before. If all
  are refused, no provider is composed and turns answer `no-provider`, as before. The refusal is reported, not thrown:
  `composeAuth` returns `refused` (`{ provider, code: "E_CONFIG_INVALID", reason }`), the composition root logs one
  `turn provider refused` error per provider (`code`, `provider`, `reason`), `TurnComposition.refusedProviders` carries the
  list, and `doctor.report` shows one failing check `providers.<id>` per refused provider (no new error code, no new RPC
  field: the check list of the existing report grows). Correct configurations get the same classes as before. Tests:
  `auth.test.ts > fail closed: ...` (one test per case, plus all-refused and model profiles), `open.test.ts > one provider
  without a billing class is refused and reported ...`, `doctor-report.test.ts > lists composition problems ...`,
  `auth.test.ts > records the billing class of every correct definition unchanged (plan vs paid, ADR-005)`,
  `billing.test.ts > an unknown explicit billing path is unknown (undefined), never a fallback to the kind`.
* The guard in `provider.ts` compares `billing[primary]` with `billing[candidate]` and refuses when both are set and differ
  and the profile does not allow cross billing (`providers.modelProfilePolicy.<profile>.allowCrossBilling`). A refusal emits
  `provider.cross_billing_refused` (warning) and lets the router try the next candidate. A candidate without a class can
  only come from the test seam `CompositionOptions.providers.billing`; it is not refused for billing.

## Provider turn loop (`provider.ts`)

Behaviour at the edges (tests in `provider.test.ts`):

* Each round streams the model's text as `delta` chunks. After the stream, if the final text is **longer** than what was
  streamed and **starts with** it, the remainder is emitted as one extra `delta`; if the final text does not start with
  the streamed text, nothing extra is emitted and the streamed text stands. Test: `provider.test.ts > characterization: the unstreamed remainder of the final text is emitted once; a mismatching final text is not`.
* Usage is accumulated over all rounds and each `usage` chunk carries the running total (`provider.test.ts > usage is accumulated over all rounds of a turn`).
* A tool call for a name that is not among the selected tools ends the turn with `TurnToolError("tool-unknown")`. Invalid
  arguments are repaired at most once; a second invalid answer ends the turn with `tool-call-invalid`. The round limit
  (default 25, `maxRounds`) ends the turn with `turn-round-limit` and the limit as `detail`.
* **Duplicate tool-call ids in one response are made unique, never merged** (`uniqueToolCallIds`). The first call keeps its
  id; each later duplicate gets `<id>_<n>` with the smallest `n >= 2` that no call of the same response uses. The new id is
  used everywhere for that call: the `tool.call`/`tool.result` chunks (the web chat keys tool cards by id and shows both),
  the dispatcher, and the assistant `toolCalls` and `tool` messages sent back to the provider. The suffix stays inside the
  provider id grammars (Anthropic: letters, digits, `_`, `-`). Tests: `provider.test.ts > duplicate tool-call ids in one response are made unique deterministically; both run, nothing is merged`,
  `provider.test.ts > a renamed duplicate never takes an id another call of the same response already uses`.
* **A failing tool ends the turn** with a `TurnToolError` whose `code` is the tool's own error code and whose `detail` is a
  redacted, bounded copy of the error envelope (`toolErrorDetail`): every string is redacted against the secret values this
  composition leased (provider credentials, media keys; `TurnProviderOptions.secrets`) and the log redaction rules, the
  message is cut to 500 characters, and an envelope still over 4096 characters keeps only `callId`, `tool`, `isError` and
  `error.code`/`message`/`sourceCode`. The text is **not** sent to the model (no second model call is made) and is not
  part of the streamed chunks. Tests: `provider.test.ts > a failing tool ends the turn with the tool's own error code and the original envelope`,
  `provider.test.ts > a tool's thrown message is redacted against registered secrets and bounded in TurnToolError.detail`,
  `provider.test.ts > toolErrorDetail reduces a bulky envelope (long hint, many issues) to its identity, code and a bounded message`.

## Error codes of a turn (`trace.ts`)

`errorCode(error)` produces the `code` field of the `error` span record. Precedence: a non-empty string `code`, else a
non-empty string `kind`, else `"turn-failed"`; the result is never empty. Tests: `trace.test.ts > composition/trace errorCode`.

* `code` wins over `kind`; a non-string `code` (for example the number `429`) is skipped and the string `kind` is used; if
  both are non-strings the result is `turn-failed`. Tests (all `characterization:` rows of the table): `code wins over kind`,
  `non-string code falls through to kind`, `non-string code and kind`.
* An empty code is no code: `{ code: "" }` gives `turn-failed`, `{ code: "", kind: "rate_limit" }` gives `rate_limit`. Test
  rows `an empty code is no code: the fallback`, `an empty code falls through to a string kind`.
* `null`, `undefined`, primitives and `{}` give `turn-failed`.

`stage(name, signal, log, run)` throws first if the signal is already aborted, logs `start`, runs the work, checks the
signal again after the work, logs `end` with `durationMs`, or logs `error` with the code and rethrows the original
exception object. Span ids are 16 hex characters, trace ids 32.

## Provider HTTP (`http.ts`)

* `providerFetch` with an injected transport (recorded fixtures) never consults egress and forces `redirect: "error"`. Only
  for `anthropic_messages` and only for a **string** body the JSON is parsed and the cache markers are rewritten; any other body
  is passed through, and a request without body forwards no `body` key.
* **A string body on an anthropic request that is not a JSON object** (unparsable, `null`, an array, a number) is refused
  locally with `ProviderError("invalid_request")`, code `request_refused_locally`; the transport is never called and the
  budget treats the attempt as not billable. Tests: `http.test.ts > an unparsable anthropic body is refused as a ProviderError (request_refused_locally) and nothing is sent`,
  `http.test.ts > an anthropic body that parses to a non-object is refused the same way`.
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
* Per operation: abort check, egress decision for the base URL and then every download host, each followed by an abort
  check (one refusal stops the operation with `backend_unavailable`, before any secret is read), secret lease as the core
  (a missing secret is `backend_unavailable`, never a keyless request; the value is registered for redaction), abort check,
  adapter call. The lease is revoked right away.
* **A cancel that lands while egress decides leases nothing**: the operation throws the abort reason before the next host is
  asked and before the secret is read. Tests: `media.test.ts > a signal aborted while egress decides leases no secret and throws the abort reason`,
  `media.test.ts > a cancel during the base-URL decision stops before the download hosts are asked`.

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

Observations from the test wave (#422). Fixed points stay listed with the test that now pins the behaviour.

1. **Fixed: a mistyped `billingPath` disabled the billing check for that provider.** It is now refused at load (that provider only) with
   `E_CONFIG_INVALID` ([Billing class](#billing-class-billingclassof-authts); `auth.test.ts > fail closed: a misspelled billingPath refuses the provider at load with E_CONFIG_INVALID`).
2. **Fixed: unknown kinds and missing profiles silently yielded no class.** Same refusal (`auth.test.ts > fail closed: an unknown credential kind refuses the provider at load with E_CONFIG_INVALID`,
   `auth.test.ts > fail closed: a missing profile refuses the provider at load with E_CONFIG_INVALID`).
3. **Fixed: `TurnToolError.detail` carried the raw text a tool threw.** It is a redacted, bounded copy now
   (`provider.test.ts > a tool's thrown message is redacted against registered secrets and bounded in TurnToolError.detail`). Kept on
   purpose: `detail` still holds the (redacted) message and is not reduced to a code, because the session layer and the
   operator need to see why a tool failed. Secrets the composition never leased (for example values an MCP server holds) are
   only caught by the pattern rules of the log redactor.
4. **Fixed: duplicate tool-call ids were sent back under one id.** They are made unique deterministically
   (`provider.test.ts > duplicate tool-call ids in one response are made unique deterministically; both run, nothing is merged`).
5. **Fixed: an unparsable anthropic body leaked a raw `SyntaxError`.** It is a `ProviderError` with code `request_refused_locally`
   (`http.test.ts > an unparsable anthropic body is refused as a ProviderError (request_refused_locally) and nothing is sent`).
6. **Fixed: `errorCode` returned `""` for an empty-string `code`.** It falls through to `kind` and then to `turn-failed`
   (`trace.test.ts > an empty code is no code: the fallback`).
7. **Fixed: a late cancel in `composeMedia` still leased a secret.** The signal is checked after every egress decision
   (`media.test.ts > a signal aborted while egress decides leases no secret and throws the abort reason`).
8. **Fixed (#421): `openInbox` stopped copying legacy break-glass notices at the first malformed one.** Valid notices behind
   it are copied (`inbox.test.ts > KNOWN GAP: core/composition openInbox ...`; the test is active, only its title keeps the
   old wording).
