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
outputs before the fifteen files in `golden/namespaces/` are written.

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
  allocation both with an enabled object and without that object. The recorder never forces
  budgeting off. Ledger ids/count come from the post-budget selection.
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
