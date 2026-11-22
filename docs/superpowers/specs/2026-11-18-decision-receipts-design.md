# Decision receipts with replay (D133, P4-45 D0, library in P4-K K11)

Source: owner decision D133 (09.11.2026, riders of 18.11.2026), rulings 1 to 11, and the controller rulings R-K-18 to R-K-23 for
K11. This document says what the library `crates/plur1bus-core/src/decision/receipts/` builds. It is a library: nothing in the
turn path, the RPC schema, the CLI or the configuration schema is touched. Everything under "Proposal" is for the owner and is
not implemented anywhere else.

## 1. What a receipt is

Every decision of the decision service on the turn path produces one receipt, whatever the backend. The first version covers
three use cases: triage (`triage`), the model tier (`routing`) and the tool offer (`CapabilityIndex.route`, here `tools`). The
other use cases (`skills`, `pruning`, `placement`, `zoom`, `compaction`) will use the same format later; the closed enum is
extended then, and a reader of format `1` refuses a use case it does not know.

A receipt answers "what did the service decide, on which basis, and what happened after", and **never** "about what". Ruling 1:
a receipt holds only identifiers, hashes, classes, counters and times. The message text is referenced by session id and message
id and is read by a replay with the rights of the session store.

### 1.1 Format `plur1bus.decisionreceipt/1`

Fields, in the order they are written:

| Field | Content |
|---|---|
| `schema` | `plur1bus.decisionreceipt/1` |
| `id`, `turnId`, `sessionId`, `agent` | identifiers |
| `messageId` | the message the decision was about, an identifier (optional) |
| `useCase` | `triage`, `routing` or `tools` |
| `at` | epoch milliseconds, taken from the clock port when the receipt is written |
| `backend` | `role`, `laya`, `kev`, `jev`, or none when a rule decided without a backend |
| `modelRevision` | an identifier of the model revision the backend named (optional) |
| `calibrationVersion` | version of the calibration record (ADR-015) in force |
| `promptVersion` | an identifier |
| `candidates` | the candidate ids (categories, profiles, tool ids), each once, at most 256 |
| `registryHash` | lower-case SHA-256 hex of the capability registry, for the tool offer |
| `result` | the choice (a candidate id) or the abstention; `distribution` (probability per candidate id, same order) and `confidence` |
| `validation` | `accepted`, or `rejected` with a reason from a closed set (`invalid`, `not-a-candidate`, `below-floor`, `privacy`, `other`) |
| `fallback` | none, or the fallback: a role id and the ids of the rules that applied |
| `durationMs`, `tokensIn`, `tokensOut` | non-negative integers |
| `outcome` | after the turn ends, once: tools used, tools reloaded by `capabilities.search`, tool errors by class with a count |

Every string is an identifier: 1 to 128 characters of `A-Z a-z 0-9 . _ : / @ -` (no white space, no control characters). A
validation reason, a fallback rule or an error class is an identifier or a member of a closed set, never a message. The closed
set and the identifier shape are the first defence against content in a receipt; the second is that the capture function takes
the decision input (`state`, `question`, option descriptions, features, levels) and copies none of it, and the third is the
marker test of section 6. Error values of the library name a field, never its value.

### 1.2 What a receipt never holds

Message texts, prompts, questions, option descriptions, tool arguments, tool results, secrets, model answers, free-text reasons.
The `Debug` output of every type in the library is covered by the same rule.

### 1.3 Distinction from neighbouring records

The decision event (`DecisionEvent`) is volatile telemetry of one call; the trace is the turn's own record; `session_tool_offers`
and the registry counters are aggregates per tool. A receipt is the durable, per decision record that lets a change be tried on
the same cases. The follow-up fields of the outcome are checked against the registry counters in a golden test (D2).

## 2. Store

A new file, `decision-receipts.sqlite` (the name is a proposal, K11-Q6), created by Rust and never read by TypeScript. It is opened through
`plur1bus_store` in owner mode with `user_version` 1 (one migration step), `BEGIN IMMEDIATE` for every write, one writer, directory
0700 and file 0600 through `crate::private_store`, and a platform hook that has to confirm the permissions or the store is not
opened. A file written by a newer schema is refused and not touched.

Tables: `receipts` (a sequence number, the id, `turn_id`, `session_id`, `agent`, `use_case`, `created_at`, the receipt body as JSON,
the outcome as JSON or null, and a unique key on `(turn_id, use_case)`) and `adoptions` (the audit of baseline adoptions, section 5).

**One receipt per turn and use case** is enforced by the unique key: a second write for the same pair is an error, never an overwrite.
The outcome can be written once; a second write is an error.

**Incognito (R-K-20).** The write function takes the incognito property of the session as a mandatory argument. For an incognito
session it writes nothing, not even a row without fields, and says so in its result.

## 3. Retention (ruling 6, R-K-19)

30 days, and an upper limit on the number of receipts, a parameter of the library with the default 20,000 per installation (the
proposal of D133 section 6; not yet confirmed by the owner, K11-Q1). The oldest receipts go first when the limit is exceeded; the 30 days
apply independently. A receipt is kept when its age is exactly 30 days and goes when it is older by one millisecond (the narrowest
reading of "30 days", K11-Q2); with `max` receipts allowed, `max` stay and the oldest of `max + 1` goes. The clock is a port; there is
no timer in the library: a host calls `prune`. The limit must be at least 1.

## 4. Replay

Input: a set of receipts, marked **development** or **final** (ruling 4). The candidate is a decision client (changed prompt, class or
category table, backend or top K) built by the host. The replay decides each case again through the existing decision client port
(`decision::DecisionClient`, which keeps its own privacy, deadline and normalisation rules) and compares the result with the stored one.
No model call and no network happens in the library itself: the backend is whatever the host passes in, and the tests pass a fake.

Rules of the live path apply first (ruling 2, R-K-21). Before any case runs, the replay asks ports: whether `jev` is opted in
(`decision.triage: jev`), whether only local models are allowed, whether egress and budget admit the candidate backend. A missing port
or a port that fails refuses the whole replay. With only local models a backend that is not local is never asked. The text of a case
is read through a port with the rights of the session store; it is never copied into the report.

Cases are processed in the order of their receipt ids, so the report does not depend on the order in which the receipts were written.

Report (`plur1bus.decisionreplay/1`): the set kind, the candidate label and backend, the receipt ids, and counts: agreements, disagreements
(a different choice, or exactly one side abstained), both abstained, abstentions of the baseline and of the candidate, **fallback cases
(reported separately, never a hit of the selector, ruling 3)**, failed cases (listed with their class, never dropped, ruling 4), the
latency sums of both sides, the baseline tokens, and the miss rate of the offer (reloaded divided by offered, as a pair of integers and
a per mille value). The report ends with the SHA-256 of its own canonical JSON. The same receipts always give the same bytes.

## 5. Adopting a baseline (ruling 10, R-K-22, R-K-23)

A change becomes the new baseline only through a person. Allowed: owner and admin, principal kind `person`. The adoption needs a report
over a **final** set that shares no receipt with the development set. The new baseline is a new version of the calibration record: the
library asks the port `CalibrationRecords` for the current version and appends version `n + 1`; the old versions stay readable. The audit
line is written first (`audit::recorded_then`); when it cannot be written nothing happens. The record and the adoption row are written in
one transaction: when the record port fails halfway, the adoption row is rolled back and the old baseline stays as it was. A configuration
change that follows from an adoption runs under the rule of that configuration (a block with credentials is the owner's, `jev` needs its
opt-in); the library changes no configuration.

## 6. Rights (ruling 11)

| Action | owner | admin | operator | member | viewer |
|---|---|---|---|---|---|
| list receipts | yes | yes | no | no | no |
| replay | person only | person only | no | no | no |
| adopt a baseline | person only | person only | no | no | no |

A token with scopes needs the action name among them. In doubt the library refuses. Listing follows `logs.query` (any kind of principal
of the two roles); replay and adoption are `humanOnly`.

## 7. Proof

- Marker test "no content in a receipt": every input of a receipt carries unique markers in all its content fields; after writing, no marker
  is in the store file (read as bytes, with the WAL), in an audit line, in an error text or in a `Debug` output; the report is covered too.
- Same receipts, same report: byte equal on repetition and when the receipts were written in another order.
- Each role, each kind, each retention limit, the one-per-turn key, the newer schema, the interrupted adoption and the order audit before
  effect have a test, and mutations of each are killed.

## 8. Proposal: the two RPC methods (not in `rpc.schema.json`, no new error code)

`decision.receipts.list`, experimental, closed params, next free minor at merge time:

- Params: `{ sessionId?: string, useCase?: "triage"|"routing"|"tools", after?: string (cursor), limit?: integer 1..200 }`.
- Result: `{ receipts: Receipt[], next?: string }`, receipts in the format of section 1.1.
- Errors: the existing permission refusal for operator, member and viewer; the existing storage refusal for a newer store.

`decision.replay`, experimental, closed params, persons of owner and admin only:

- Params: `{ set: "development"|"final", receiptIds: string[] (1..5000), candidate: { backend?: string, promptVersion?: string, topK?: integer } }`.
- Result: the report of section 4.
- Errors: the existing permission refusal; the existing refusal when a gate port denies (egress, budget, local only, `jev` without opt-in).

Adoption has no method in this proposal (K11-Q4).

## 9. Open questions for the owner

- K11-Q1: the upper limit of 20,000 receipts per installation is D133's proposal and not confirmed.
- K11-Q2: age exactly 30 days is kept; the first millisecond over it goes.
- K11-Q3: `tools` as the name of the use case of the tool offer (the decision service has no such use case today).
- K11-Q4: where a person adopts a baseline (a third method, or a parameter of `decision.replay`).
- K11-Q5: replay with the role backend while only local models are allowed is refused, because the role may route to a cloud model; allow it when the router reports the role as local?
- K11-Q6: the store and file names.
