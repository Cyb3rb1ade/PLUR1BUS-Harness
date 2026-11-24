# RE-D11 · Cosine recall on the frozen corpus

The [corpus](../../tests/engine-parity/corpus/recall-ab/corpus.json) has 16 synthetic cards and 15 German and English queries. The labels identify 16 relevant query-card pairs. One query has no supporting card. The [recordings](../../tests/engine-parity/corpus/recall-ab/) retain the complete ranks per query. The two Node baselines were reproduced byte for byte at pin `9f34008c143c5da87b2194b5a28442b407ff8ba7`. The native run used macOS arm64 and SHA-verified ONNX Runtime 1.30.0 with float32 multilingual E5 small. It used the corpus clock, a pool of 40, an output allowance of 16, and disabled reranking, deduplication, canonical recall and graph expansion. Recall@k counts the labeled pairs in the first k results across all queries.

| Profile | Floor | Selected pairs | Labeled pairs | Recall@1 | Recall@5 | Negative query |
|---|---:|---:|---:|---:|---:|---:|
| Native E5 legacy | 0.30 | 240 | 16/16 | 13/16 | 16/16 | 16 |
| Native E5 cosine | 0.82 | 24 | 16/16 | 13/16 | 16/16 | 0 |
| Native flat legacy | 0.30 | 240 | 16/16 | 1/16 | 6/16 | 16 |
| Native flat cosine | 1.00 | 240 | 16/16 | 1/16 | 6/16 | 16 |

The native E5 legacy rank matched Node for all 15 queries. Its cosine rank is the same E5 order with entries below 0.82 removed in these unboosted cases. The weakest labeled pair scored about 0.834 in the Node reference converted from squared-L2 and the negative query peaked at about 0.736. The 0.82 floor leaves room for numeric variation. In `bench-arrival`, the unrelated maintenance card still precedes the delivery card. The flat embedder ties every vector; both native scales preserve membership and the flat order has no semantic significance.

| Query | Labeled IDs | E5 cosine order |
|---|---|---|
| meeting-time | roadmap-review | roadmap-review, roadmap-draft |
| draft-deadline | roadmap-draft | roadmap-draft, roadmap-review |
| study-time | roadmap-budget | roadmap-budget, roadmap-review |
| two-dates | roadmap-draft, roadmap-review | roadmap-review, roadmap-draft, roadmap-budget |
| heating | boiler | boiler |
| bike-security | tool-box | tool-box |
| picnic-food | picnic | picnic |
| paula-allergy | paula-diet | paula-diet |
| case-exact | scanner | scanner, printer |
| key-paraphrase | schluessel | schluessel |
| drill-power | ersatzakku | ersatzakku |
| bench-arrival | lieferung | wartung, lieferung |
| file-formats | archiv, schnitt | schnitt, archiv |
| umlaut | autor | autor, wartung, schluessel |
| unknown | None | None |

The same Lance L2 candidate search serves both scales. A valid unit-vector distance `d` maps to cosine as `1 - d/2`. The legacy boost terms are rescaled at the configured floor by the inverse derivative of the reciprocal distance function, preserving their relative weights at that point. Raw cosine filtering occurs before those boosts. A failed floor can now admit the existing refinement branch when initial retrieval finds no qualifying row.

The native default remains legacy. This corpus calibrates the pinned E5 profile and does not establish a general default for other profiles or production data. Set `engine.recall.scoreScale` to `"cosine"` with the Rust engine to opt in. Other L2-normalized profiles require an explicit `engine.recall.cosineMinScore` in `[-1, 1]`. The legacy floor retains its existing interpretation. Native config accepts the old `forgetThreshold` on input for compatibility and drops it from the native type. Native forget remains ID-based. The pinned Node manifest and setup projections retain their original shape.
