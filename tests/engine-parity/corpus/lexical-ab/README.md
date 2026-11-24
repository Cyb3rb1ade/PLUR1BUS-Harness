# Native hybrid recall pilot

`recall-ab.json` is the frozen synthetic corpus from RE-D11, copied here so this branch can be reviewed independently. `diagnostic.json` records the actual `engine.recall.compare` result from an unpublished integration with the Block B branch at `f68345553`. The fixture prebuilt the index before calling the read-only comparison. The run used the same input cards and queries on both arms. It disabled reranking, graph expansion, canonical recall and text deduplication. E5 used the same verified model and runtime as T7. All pools contain the same 16 source rows. The flat embedder ties vector scores, so a rank difference between calls can reflect tie order.

| Embedder | Sources | Candidates | MRR@10 | Relevant pairs in top 10 |
|---|---|---:|---:|---:|
| Flat | Vector | 40 / 50 / 100 | 0.1956 / 0.1956 / 0.1956 | 10/16 |
| Flat | Hybrid | 40 / 50 / 100 | 0.5250 / 0.5190 / 0.5250 | 16/16 |
| E5 | Vector | 40 / 50 / 100 | 0.9643 / 0.9643 / 0.9643 | 16/16 |
| E5 | Hybrid | 40 / 50 / 100 | 0.9286 / 0.9286 / 0.9286 | 16/16 |

MRR uses the first labeled hit per positive query. Recall counts all labeled pairs. This pilot reports a ranking loss with E5 and supports keeping hybrid opt-in. The four-gram field and decompounding lexicon remain gated. Adoption requires the plan's wider language, identifier, compound, owner-snapshot and quiet-host comparisons.

The source manifest records verified downloads for the wider German test. GermanQuAD retrieval pairs deepset annotations with German Wikipedia passages. FineWeb-2 supplies the German distractor shard. These downloads live outside Git. Their test results are outside the pilot numbers above. [GermanQuAD corpus](https://huggingface.co/datasets/mteb/germanquad-retrieval) · [GermanQuAD judgments](https://huggingface.co/datasets/mteb/germanquad-retrieval-qrels) · [FineWeb-2](https://huggingface.co/datasets/HuggingFaceFW/fineweb-2)
