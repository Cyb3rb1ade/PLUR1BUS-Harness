# RE-04/T5 review rulings and verification boundaries

One independent read-only review examined base `df525459` through candidate
`73458c9c4a217bf3239f3333546f5a3ae90da48a`, patch SHA-256
`32e5825bc8071e563ee23ae29b628fda307f552bf7903a3d7193132cbec87be6`.
Its verdict at that candidate was not ready: zero Critical, four Important and
one Minor. It found no surviving raw-row Lens ACL bypass. This document records
the implementer's reconciliation and single fix pass; it does not claim a second
review or authorize merging. The controller/owner retains external review and merge.

## Findings and the single fix pass

- **I1, bound graph integrity:** CRR now requires normalized consistency between
  both outer endpoint tuples and both nested ownership copies. Actual Node cases
  reject absent/conflicting nested copies and retain valid full/sparse tuples.
  `review_crr_nested_bindings_match_the_pin` reproduces the original failure.
  Raw target ACL authorization remains independent of graph integrity.
- **I2, overlay controls:** The runtime forwards authorized snapshots only with a
  workspace, enabled continuity and enabled overlays. Actual assembler cases cover
  absent/default settings, explicit on/off, continuity off and no workspace;
  each retains the authorized base. `review_overlay_switches_preserve_the_base`
  reproduces the original failure. Lifecycle/ownership loading remains with its owner.
- **I3, numeric summary controls:** `summaryMaxWords` retains the schema's Number
  semantics, including integral decimal/exponent encodings. The selected-pipeline
  boundary forwards the numeric value; rendering uses the existing T0 helper for
  positive integers and preserves the pin's strict-counter behavior otherwise.
  `review_summary_numeric_encodings_match_the_pin` covers integer, decimal,
  exponent, fractional, zero and negative limits without changing the schema.
- **I4, disclosure evidence:** The tests now consume actual recorded winner IDs
  and lossless disclosure lines for default/on/off/entity-cut cases. The real
  assembler's empty projected-row detection behavior is retained.
  `review_disclosure_uses_recorded_nonempty_and_disabled_oracles` also rejects a
  temporary always-empty implementation; restoring the exact source makes it pass.
  The production helper itself already matched these newly asserted oracles.
- **M1 regraded Important:** Numeric object keys can change the actual selected
  memory under a cap. Lower frequency does not make the result difference cosmetic.
  `LensIndex` now applies JavaScript property enumeration to object communities and
  entries while retaining array order and ordinary string-key insertion order.
  `review_crr_property_enumeration_preserves_selected_ids` uses actual Node raw-JSON
  numeric/prefixed/array controls. The protected T0 parser is unchanged.

The four behavioral discrepancies (I1–I3 and regraded M1) were observed red before
their product changes, then green. I4's missing assertion was verified with a runtime mutation
and exact restoration. The final PR records full-suite counts, commands and timings.
No Minor finding remains deferred after the M1 reclassification.

## Explicit rulings on review exclusions

Each exclusion considered by the reviewer is retained here with its owning boundary
and the practical limit of this PR's assurance.

1. **Complete deadlines, cancellation, adaptive budgets, degraded recovery, caches
   and trace normalization/redaction/timing:** RE-04/T6 owns these. T5 verifies its
   text/trace inputs and result fields. If that separation is wrong, a composed
   recall could exceed a budget or expose improperly normalized trace data; T6
   acceptance must verify the complete path.
2. **Production request construction, namespace/provider leases, upstream logging
   and all-identity warm wrappers:** RE-08 supplies these. T5's read-only ports and
   native Store checks do not prove a future collaborator honors every flag.
   Incorrect composition could persist a warm cache or violate authorization.
3. **Actual Neo selection, global/window lanes, classification, persistence and
   hook deduplication:** CA5 owns the implementation. Recorded output tests the
   trait boundary. A faulty real implementation could return different text or
   perform unwanted writes; CA5/RE-08 must verify their integration.
4. **T3 selection and T4 namespace fusion/ledger behavior:** Their independent
   implementations and PR850 are unchanged. T5 consumes authorized ordered rows.
   Incorrect upstream selection would affect prompts; this PR does not substitute
   for their own review or integration checks.
5. **Durable reminders, pending queues, activity, GC, start-notice consumption,
   reply outcomes, persona/dream/open-thread state and nudge I/O:** T5 owns text
   and explicit intents, not execution of those workflows. The owning tasks and
   RE-08 must consume them; otherwise presentation could repeat or state stay stale.
6. **Lens lifecycle restrictions beyond the pin:** Preserve the pin's existing
   status/epistemic behavior. The controller authorized the shared hydration ACL,
   not CRR's broader expiry policy. Applying extra restrictions would remove
   otherwise compatible authorized Lens results.
7. **Authorization of already-selected rows and supplied pattern/overlay/reminder
   snapshots or additive text:** Their owning readers must supply authorized data.
   T5 does not create a second ownership policy inside pure formatters. A caller
   violating that contract could inject unauthorized data; raw Lens hydration
   receives its explicit T1 check because that is the identified missing boundary.
8. **Injected-conflict requester/concurrency redesign:** Retain the pin's partial
   requester matching and drift model behind the CA5 port. No new scoped bypass
   was established. Concurrent mutable-store behavior remains an integration
   responsibility; this PR's policy/hash checks do not establish stronger atomicity.
9. **Empty projected-row factual detection:** Keep the actual assembler behavior;
   separately assert the real raw-row disclosure helper. Inventing an assembler
   block would break parity and change user context. I4 closes the evidence gap.
10. **Arbitrary legacy Date.parse forms and malformed persisted UTF-16 input:**
    No valid production source outside the row/file contracts was established.
    Emitted surrogate cuts remain lossless. Expanding parsing would require a
    separately authorized protected-foundation change and compatibility evidence.
11. **Outer short/internal-turn routing before selected rows:** Outer orchestration
    owns those guards; T5 handles its declared warm/minimal inputs. Incorrect
    composition could run a renderer for the wrong kind of turn and must be tested
    where RE-08/T6 wire that routing.
12. **Unlisted transitive Node dependencies:** The recorder checks its 39 listed
    sources against immutable Git bytes; it does not claim a complete import-closure
    attestation. Other reference files must still come from the pinned checkout.
13. **Runtime tests, determinism, builds, lint/docs and publication:** The fresh
    reviewer performed static source/artifact inspection only. The implementer owns
    the recorded real captures and local gates; a static verdict alone cannot
    establish that the patch compiles or runs.
14. **Future fixes and merge readiness:** The independent report binds its exact
    candidate, not later commits. The single fix pass is validated by regression
    tests and the full suite. External re-review and the owner's merge remain
    necessary; no second independent verdict is implied.

## Foundation follow-up

The new zero-word oracle also shows the protected T0 `generate_summary` initializes
its fallback cut differently from Node for a zero limit. T5 handles this case at its
numeric render adapter and matches the pin. `src/text/` remains unchanged. A shared
T0 correction needs the controller's separate authorization and its own consumers'
compatibility tests; this PR makes no broader foundation guarantee.
