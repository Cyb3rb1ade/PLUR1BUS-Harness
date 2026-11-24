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

## Public-corpus comparison

`public-sources.json` pins each public payload, SHA-256 and local filename. Put those files in a scratch directory, then run `prepare-public.py <scratch>` with PyArrow 26.0.1. The preparer verifies hashes before reading passages. It materializes GermanQuAD (474 passages, 2,204 positive queries) with and without 5,000 nonempty FineWeb-2 documents from the pinned shard in source order. Distractors are capped at 6,144 characters. For English it retains QASPER test abstracts and body paragraphs and questions with at least one evidence paragraph that matches after whitespace normalization. The test generator adds 200 synthetic German compounds with explicit boundaries, 200 paired separated controls and 60 synthetic identifiers. Raw public payloads, materialized passages and vectors stay in the scratch directory. QASPER supplies the CC BY 4.0 English questions and evidence. [QASPER](https://huggingface.co/datasets/allenai/qasper)

`LEXICAL_QUALITY_DIR=<scratch> cargo test --locked -p plur1bus-engine --test recall lexical_bakeoff -- --ignored` runs the Lance BM25 comparison. It records lexical MRR@10, macro recall@10 and hit@1. For the E5 arms, add `--features real-models` before `--test` and supply the verified cache and runtime using `PLUR1BUS_MODELS_CACHE` and `ORT_DYLIB_PATH`. The E5 run adds exact L2 vector ranks and production RRF with pool width 40. It writes aggregate scores to `hybrid-e5-results.json`. `LEXICAL_QUALITY_CORPORA` optionally selects a comma-separated subset. The comparison isolates candidate sources. The diagnosis above runs the full native recall pipeline with its usual authorization boundary.

The separate summary arm indexes distinct fields while the shipped analyzer candidate joins the text and summary. The fallback uses Lance's language-neutral tokenizer on separate fields. Four-grams stay within German-folded words. The compound controls use the same split queries with those constituents stored as separate words. The results cover quality. A quiet reference host is required for the latency and build-time gates, and the Owner snapshot has its own local-only acceptance.
