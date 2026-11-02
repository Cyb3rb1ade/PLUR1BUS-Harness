# RE-04/T5 Node render fixtures

Run from the repository root with Node **24.21.0**, `TZ=UTC`, and
`PLUR1BUS_ENGINE_SRC` pointing at a read-only checkout of
`9f34008c143c5da87b2194b5a28442b407ff8ba7`:

```sh
node crates/plur1bus-engine/tests/fixtures/recall/record.mjs --render
```

`render-sources.json` verifies 39 immutable source hashes **before** the Node-version
check and before imports. `record-render.mjs` records two fresh child processes and
refuses differing output. No model, tokenizer, network or LLM call is involved.
The real assembler, warm/minimal paths and helper formatters run at the pin; the
selected T3/T4 pipeline rows, clock, lease holder, scheduler and CA5 Neo store are
synthetic external collaborators. Neo prelude output is separately recorded as a
dependency and consumed in Rust through `NeoPrelude`, not a T5 Neo implementation.

Eleven JSON files contain 119 cases. Inputs cover defaults and explicit on/off
states for compression, full text, confidence framing, contradiction disclosure,
CRR/visible hints, Neo, temporal context and trace inclusion. They also cover
native-production top-N/summary defaults, surrogate cuts, nested unknown wrappers,
JavaScript tag whitespace, provenance/valid time, stable ties, bound graph bridges,
faded/owner rejection, minimal maintenance, warm failures and system supplement.
CRR trace cases count all attempted authorized candidates and decisions, including
rejections and the empty-selection trigger guard.

Only `timing` is removed because RE-04/T6 owns wall-clock phases. `rawLine` is the
actual `JSON.stringify` result in Node field order. Rust compares it as raw text,
also comparing every original block text and the actual host
`planGlobalInjectBudget` joined result. UTF-16 cuts retain lone-surrogate JSON
escapes through `JsString`; `chars` counts code units and `tokensEstimate` is absent.
The existing T0/T1 `parts`/`joiner` codec carries legacy reference markers without
changing a decoded byte or relaxing the repository hygiene rules.

The pin returns its original six blocks and separately computes deferrals. Host
joining performs the aggregate clipping/dropping; it must not cap the original
array twice. Tiny-cap operational warnings retain the pin's inherited overflow
behavior. The projected display-only runtime rows do not form a factual
contradiction pair; separate actual helper captures exercise version precedence
and disclosure instead of inventing an assembler block.

## Controller-authorized Lens ACL exception

The [stop report](../../../../../../../docs/superpowers/plans/rust-engine/RE-04-T5-semantic-lens-acl-stop.md)
records the native full-pipeline reproduction and the controller's 2026-11-01
decision. The Node reference stays unchanged. The recorder's Lens hydration
collaborator applies the exact pinned `checkAccess`, matching CRR's callback;
Rust applies its existing T1 `check_access` before quotas and projection.

`render-plain.json` has six security cases: absent Lens object / enabled true /
enabled false, each with compression on/off and a foreign user-scoped row.
Every final prompt excludes it and retains the authorized base. The recorder
also runs the unchecked pin privately to detect an output difference. **Only the
four default/enabled cases** carry `parityException.id = RE-04-T5-LENS-ACL` and the
stop-report path. The two disabled controls and every other golden are unmarked.
No denied ID/content, log, ledger row or new denial counter is emitted. Test
inputs use synthetic principals/rows; unsafe pin outputs are never saved here.

The renderer's reminder/session/Neo effects are explicit caller-owned intents.
Warm recall itself persists nothing. Separate native-store tests verify that
optional retrieval maintenance can change only `retrievalCount` and
`lastRetrievedAt`, and that warm vector reads preserve row/file/ledger bytes.
T6 and RE-08 retain full trace/timing/degraded and production composition work.

The single final-review fix pass also covers missing/conflicting nested graph
ownership, a valid sparse tuple, overlay default/on/off/continuity-off/no-workspace
states, and raw-JSON property enumeration for numeric/prefixed/array communities.
The actual stored-overlay fixture uses the pinned InterpretationOverlayStore.
Decimal/exponent summary encodings retain a separate input lexeme so Rust tests
exercise serde floating variants even when JSON.stringify prints an integer.
Fractional and non-positive limits preserve Node's strict-counter result.
Recorded raw-row contradiction winner/disclosure fields are now asserted for all
four cases, including the disabled null and 400-unit entity-cut case.

The [review rulings](../../../../../../../docs/superpowers/plans/rust-engine/RE-04-T5-review-rulings.md)
record the one source review, its single fix pass and every explicit ownership
boundary. All textual runtime/helper results use raw JSON/text assertions; extra
nontextual policy metadata checks supplement those assertions.
