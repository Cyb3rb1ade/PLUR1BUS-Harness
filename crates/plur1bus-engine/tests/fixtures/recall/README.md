# Recall parity recordings

Run under Node 24.21.0 and `LC_ALL=C.UTF-8`. The engine source directories are
read-only inputs. Recordings contain synthetic fixtures only.

T4 namespace recordings:

```sh
PLUR1BUS_ENGINE_SRC=/path/to/engine-at-9f34008c \
  node crates/plur1bus-engine/tests/fixtures/recall/record.mjs \
  --namespaces /path/to/plugin-at-v7.18.31
```

`record-namespaces.mjs` loads the complete Node modules and uses real LanceDB
tables with deterministic flat embeddings. It records each scenario twice and
requires identical outputs before writing the four files in `golden/namespaces/`.
The source directories need their ordinary Node dependencies available in their
module-resolution ancestry. No remote provider or model is used.

- Namespace configuration, missing legacy tables, failure propagation and the
  global retrieval-ledger callback come from the harness pin
  `9f34008c143c5da87b2194b5a28442b407ff8ba7`.
- Persisted lines use `createRetrievalLedgerEntry` from `lib/memory-dynamics.js`:
  the query is hashed, never stored as plaintext. The recorder replaces only the
  generated UUID with `__UUID__`; the timestamp is the frozen scenario clock.
- Global merge ordering comes from plugin tag `v7.18.31`, commit
  `6419a60e79975d0b5244798c1fdbbd7997a712ce`, including CP-5.2's `rerankScore`
  comparator. The pin predates that comparator; it is not a reference for this
  change package.
- Each file records both commits, the relevant source-file SHA-256 values,
  Node/Unicode/ICU versions, the inputs and Node's outputs.
- The failure scenario injects a synthetic read error into the second native
  table. Node rejects the entire recall and emits no retrieval-ledger entry.
- Merge cases cover duplicate ids, canonical heading/text normalization, global
  caps, stable ties, Jaccard and disjoint validity, immutable provenance wrappers,
  child-trace replay and bounded global decisions.

The Rust test enumerates all 24 permutations independently of these recordings.
It checks the merged order restricted to reranked ids, with a higher-scoring
unreranked distractor in the other namespace.
