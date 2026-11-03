# Recall parity recordings

Run under Node 24.21.0 and `LC_ALL=C.UTF-8`. Engine source directories are read-only inputs.
Recordings contain synthetic fixtures, deterministic providers and real native Lance tables;
no remote provider, model weights or network requests are used.

```sh
PLUR1BUS_ENGINE_SRC=/path/to/engine-at-9f34008c \
  node crates/plur1bus-engine/tests/fixtures/recall/record.mjs \
  --namespaces /path/to/plugin-at-v7.18.31
```

`record-namespaces.mjs` verifies every SHA-256 in `namespace-sources.json` **before importing**
reference code. Those expected hashes come from immutable git objects at the commits below;
a modified or incomplete source tree aborts recording. The regression test also proves refusal
before an untrusted module can execute. Both complete recording passes must produce identical
outputs before the twenty-seven files in `golden/namespaces/` are written.

| Reference | Responsibilities |
|---|---|
| Harness `9f34008c143c5da87b2194b5a28442b407ff8ba7` | Namespace configuration, pools, actual memory storage, identity routing/query coalescing, RRF, merged tier budget, failure propagation, child traces and retrieval-ledger creation. |
| Plugin `v7.18.31`, commit `6419a60e79975d0b5244798c1fdbbd7997a712ce` | CP-5.1 reranked tier-order preservation, CP-5.2 cross-table rerank-score ordering, and the actual runtime rerank case. |

The plugin wrapper predates the harness pin's query coalescing and identity routing. For the
plugin runtime rerank case the recorder therefore executes the **same inputs at both sources**:
result/trace/ledger and `rerankCalls` come from plugin `index.js`; `embeddingCalls` comes from
the harness runtime. Both actual call recordings are retained (`embeddingCallsAtResultSource`
and `embeddingCallSource`), so the composite oracle does not invent an expected call count.
The original pin cannot provide CP-5.2 ordering. Pure merge scenarios use the plugin pipeline.

Each file records the commits, full participating source hashes, Node/Unicode/ICU versions,
inputs and actual outputs. The hash manifest includes namespace config, both pools, MemoryDB,
identity helpers, budget, pipeline, graph, both trace implementations and production glue.
The recorder's missing-table omission and `sourceKind: "private"` match the pin's
`engine/recall/assemble-prompt-context.js:342–346`; they are explicit production setup, not
behavior manufactured inside the pipeline under test.

Runtime coverage includes:

- Two tables, missing legacy tables and a genuine second native table read failure.
- Thirteen candidates with no `adaptiveBudget` object (default budget twelve), and tier
  allocation both with an enabled object and without that object. An explicit disabled-budget case separately proves the skip branch;
  the recorder applies no blanket budget override. Ledger ids/count come from the post-budget selection.
- Same-width and different-width foreign identities with no provider; available per-identity
  providers with RRF; one global rerank after fusion and its reported failure fallback.
- Actual child reranking, canonical knowledge, emotional re-scoring, graph hydration, duplicate
  text and graph-endpoint ACL rejection. Full scalar entries and stage-local trace arrays are
  checked, including rows later removed by merge/budget. File mtimes and request clocks are
  genuinely frozen inputs, so canonical `mtimeMs` remains part of the comparison.

`createRetrievalLedgerEntry` hashes the query. Its actual JSONL is saved as `ledgerLines`;
Rust compares persisted text byte for byte after replacing only the valid generated UUID with
`__UUID__`. Object field order, nulls, number spelling and selected-id order are therefore
checked. In-memory objects compare numeric values and key sets; array ordering remains exact.
Only Node trace `addedAt`/`recordedAt` wall-clock fields are omitted from the runtime snapshots.
T6 still owns timers, complete text/secret normalization and a `JsString`-capable trace type
for canonical ids cut through a UTF-16 surrogate pair.

Pure merge scenarios additionally cover canonical normalization, origin/id/Jaccard dedupe,
disjoint validity, provenance wrappers, child replay, bounded decisions and equal rerank-score
ties across tables. Rust independently enumerates all 24 **score assignments to fixed rows in
fixed tables**, with a higher raw-score unreranked distractor. This changes reranked order in
every permutation and asserts that the distractor stays after all reranked rows.

T4's physical routes are private. Shared-store provenance columns, optional source policy and
strict single-source timeout semantics remain with T6/RE-07. The frozen RE-02 private row has
no shared-source columns; projected defaults match the private tables recorded here.

The post-review fused-reranker regression additionally applies the existing actual Node
`G-RERANK-5` valid-empty oracle to the two-identity fixture. It checks both fallback policies,
zero ledger count/ids and no degradation. An undeclared empty response still falls back or
fails. This carries the required CP-5.5 opt-in into the older identity wrapper; it changes no
recorded golden and does not invent a Node run of that feature combination.

Two inherited pin edges remain explicit. Global identity reranking does not add `rerankScore`,
so mixed tiers can reorder that result under the plugin's finite-score preserve-order predicate.
When global reranking raises the intermediate cap to 100, only memories are sliced afterwards;
with canonicalMaxItems greater than topN, canonical alone can exceed topN when budgeting is
explicitly disabled, or when the enabled budget satisfies `budget >= canonical.len() > topN`.
Ordinary merge retains its combined cap. Altering these concrete Node behaviors needs a separate
compatibility decision. A mismatched expected identity remains an error on every route, including read-only legacy.
The production composition and its per-agent/per-route expectation policy are exercised below. Existing T2 fractional-mtime/cache-identity/atomic-write limitations
are unchanged; the frozen mtime fixtures do not establish complete cache interoperability.

## Production identity composition and re-review coverage

Every runtime pool now uses `AgentDbPool.withOptions({ identityForStore })`, matching the
immutable `create-engine.js:1305–1313` (also hash-checked). The fallback expected identity is the
active identity on **every** route. Foreign-space cases carry explicit `identityRoutes` for the
legacy namespace; they no longer rely on a pool with no expectation. The resolver supports
per-agent expectations as well, covered by the Rust lease regression.

`namespaces-model-upgrade-unconfigured-legacy-rejects` models an A→B embedder change with old
A rows retained as legacy and no `embedding.routes`. Real Node pool initialization throws
`EMBEDDING_IDENTITY_MISMATCH`; a second execution through the actual pinned prompt assembler
records `degraded:error` and no blocks. The provider-present variant proves that an available foreign provider cannot bypass the expectation.
No query or ledger entry is emitted. Rust rejects the
required lease before child providers start. The unbound-legacy case additionally proves that
missing persisted metadata inherits the declared expectation and still participates in identity
counting/coalescing/fusion; neither implementation writes a read-only identity stamp.

The mixed-tier child-rerank cases record both the plugin and pin on the same inputs: core,
project, episodic and graph rows, budget six for seven candidates, and reverse tier order from
the child reranker. The plugin result preserves CP-5.1 selected order; the older pin concatenates
tiers. Rust matches the plugin, including raw ledger id order. The plugin file retains its
actual `resultAtRoutingPin` and `ledgerLinesAtRoutingPin` as an explicit contrast oracle.

Other runtime cases now cover `adaptiveBudget.enabled:false`, the canonical-only topN edge
with both disabled and enabled budgets, `rerankerFallbackOnError:false`, and a nonempty
`workspaceKey`. The exact exported `normalizeBoundedRecallInteger` outputs are recorded too;
T4 reuses that port for merged-budget normalization. `resolveRuntimeRecallBudget` is not called
by `runMergedNamespaceRecall`; automatic prompt/project-based resolution is owned by RE-04/T6
(work package G3), explicitly defined in the T6 brief and listed in MODULE-MAP.

The separate `namespaces-canonical-budget-below-max-items-enabled`/`-disabled` pair uses
`topN:2`, `budget:1` and `canonicalMaxItems:2`. The actual pin returns one canonical item with
the budget enabled and two with it disabled. Removing `canonical.truncate` makes the enabled
Rust oracle fail while its disabled control still passes. The original canonical-over-topN
pair remains intact; all twenty-five previous recordings are byte-identical after recapture.

Source integrity is checked before the exact recording Node-version guard. The negative source
regression therefore rejects an untrusted file for the correct reason on other installed Node
versions too, before importing reference code; successful recording still requires Node24.21.0.
