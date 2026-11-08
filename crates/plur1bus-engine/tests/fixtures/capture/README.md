# Shared import/capture classification oracles

These two pure recorders and their existing Node goldens were recovered from the hash-checked CA2 snapshot before integration. They have been re-executed against read-only engine pin `9f34008c143c5da87b2194b5a28442b407ff8ba7`; both golden files and the generated Unicode data are byte-identical to the preserved originals. C3 uses identical source bytes for these classifiers.

- `record-quality.mjs`: 1,419 quality/category/importance cases plus Unicode 17 boundary checks. `quality-unicode17.json` carries the Node ICU Unicode-3.0 notice and a golden-bound hash.
- `record-dynamics.mjs`: 868 pure dynamics cases, both flashbulb flag states, exact ordered JSON projections. The recorded deferred-queue observations remain source evidence; the deferred queue is not integrated by this change.

Run with Node 24.21.0, `PLUR1BUS_ENGINE_SRC` pointing at the read-only pin export, `PLUR1BUS_ENGINE_GIT` at its read-only repository, and `PLUR1BUS_NODE_LICENSE` at that Node distribution's LICENSE for the quality recorder. The Rust tests compare raw output bytes and use the production modules. The imported capture folder currently contains shared pure rules and schema defaults, not capture admission or the RX6 pipeline.
