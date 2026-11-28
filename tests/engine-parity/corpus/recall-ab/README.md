# RE-D11 recall corpus

The corpus contains 16 synthetic cards and 15 English and German queries. `expectedIds` names the cards that answer each query. An empty list marks a query with no supporting card. Expectation lists are unordered when several cards are needed. The baseline results retain the complete observed ranking and the scores emitted by the pinned Node pipeline.

`baseline-flat.json` fixes a flat-embedder control. `baseline-e5.json` records the locally prepared multilingual E5 small model. Both use the corpus clock and the existing 0.3 filter, with reranking, canonical recall and associative spread off. The recorder verifies the frozen Node dependency and compares two fresh stores before it emits a baseline. The E5 run verifies the model files against the pin and runs offline.

```sh
node --conditions=source --experimental-strip-types tests/engine-parity/corpus/recall-ab/record-node.ts flat
PLUR1BUS_MODELS_CACHE=/absolute/prepared/model/cache \
  node --conditions=source --experimental-strip-types tests/engine-parity/corpus/recall-ab/record-node.ts e5
```

Use these results to compare ranks, scores and threshold effects before changing the Rust default. The corpus is synthetic and small. Treat the observed ranks as a baseline for the listed queries.

The native recorder is exercised through the ordinary recall entry point with
the same corpus. Set `PLUR1BUS_MODELS_CACHE` to the prepared cache and
`ORT_DYLIB_PATH` to the verified runtime. The targeted suite prints one
`RECALL_AB` JSON line per profile.

```sh
cargo test --locked -p plur1bus-engine --features real-models --lib recall_ab -- --include-ignored --nocapture --test-threads=1
```

The [quality report](../../../../docs/evidence/ry-b2-9-recall.md) describes the
observed ranks and the profile floor. The legacy scale remains the default.
