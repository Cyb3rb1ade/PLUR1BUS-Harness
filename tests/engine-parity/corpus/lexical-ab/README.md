# Native hybrid recall pilot

`recall-ab.json` is the frozen synthetic corpus from RE-D11, copied here so this branch can be reviewed independently. `diagnostic.json` records the actual `engine.recall.compare` result from an unpublished integration with the Block B branch at `f68345553`. The fixture prebuilt the index before calling the read-only comparison. The run used the same input cards and queries on both arms. It disabled reranking, graph expansion, canonical recall and text deduplication. E5 used the same verified model and runtime as T7. All pools contain the same 16 source rows. The flat embedder ties vector scores, so a rank difference between calls can reflect tie order.

| Embedder | Sources | Candidates | MRR@10 | Relevant pairs in top 10 |
|---|---|---:|---:|---:|
| Flat | Vector | 40 / 50 / 100 | 0.1956 / 0.1956 / 0.1956 | 10/16 |
| Flat | Hybrid | 40 / 50 / 100 | 0.5250 / 0.5190 / 0.5250 | 16/16 |
| E5 | Vector | 40 / 50 / 100 | 0.9643 / 0.9643 / 0.9643 | 16/16 |
| E5 | Hybrid | 40 / 50 / 100 | 0.9286 / 0.9286 / 0.9286 | 16/16 |

MRR uses the first labeled hit per positive query. Recall counts all labeled pairs. The ordering loss in the small E5 pilot supports keeping hybrid opt-in while completing the acceptance gates.

## Public-corpus comparison

`public-sources.json` pins each public payload, SHA-256 and local filename. Put those files in a scratch directory, then run `prepare-public.py <scratch>` with PyArrow 26.0.1. The preparer verifies hashes before reading passages. It materializes GermanQuAD (474 passages, 2,204 positive queries) with and without 5,000 nonempty FineWeb-2 documents from the pinned shard in source order. Distractors are capped at 6,144 characters. For English it retains QASPER test abstracts and body paragraphs and questions with at least one evidence paragraph that matches after whitespace normalization. The preparer adds 200 synthetic German compounds with explicit boundaries, 200 paired separated controls and 60 synthetic identifiers. Raw public payloads, materialized passages and vectors stay in the scratch directory. See [ATTRIBUTION](ATTRIBUTION) for credit and licences.

`LEXICAL_QUALITY_DIR=<scratch> cargo test --locked -p plur1bus-engine --test recall lexical_bakeoff -- --ignored` runs the Lance BM25 comparison. It records lexical MRR@10, macro recall@10 and hit@1. For the E5 arms, add `--features real-models` before `--test` and supply the verified cache and runtime using `PLUR1BUS_MODELS_CACHE` and `ORT_DYLIB_PATH`. The E5 run adds exact L2 vector ranks and production RRF with pool width 40. It writes aggregate scores to `hybrid-e5-results.json`. `LEXICAL_QUALITY_CORPORA` optionally selects a comma-separated subset. The comparison isolates candidate sources. The diagnosis above runs the full native recall pipeline with its usual authorization boundary.

The separate summary arm indexes distinct fields. The production opt-in candidate joins text and summary. The fallback uses Lance's language-neutral tokenizer on separate fields. Four-grams stay within German-folded words. The compound controls use the same split queries with those constituents stored as separate words.

[Public and synthetic results](public-e5-results.json) record all four lexical configurations, scores for lexical-only and hybrid, the vector baseline, and lexical index bytes. Recall@10 is the mean fraction of labeled passages found per positive query. Each cell shows hybrid MRR@10 and macro recall@10, except the vector baseline column.

| Corpus | Passages / queries | E5 vector | Fallback + E5 | Analyzer joined + E5 | Analyzer separate + E5 | Analyzer four-gram + E5 |
|---|---:|---:|---:|---:|---:|---:|
| GermanQuAD | 474 / 2,204 | .9068 / .9750 | .9191 / .9896 | .9366 / .9932 | .9366 / .9932 | .9361 / .9914 |
| GermanQuAD with distractors | 5,474 / 2,204 | .8807 / .9560 | .9064 / .9900 | .9207 / .9941 | .9207 / .9941 | .9133 / .9891 |
| QASPER | 20,233 / 1,309 | .1488 / .1828 | .1475 / .2066 | .1637 / .2133 | .1581 / .2100 | .1644 / .2136 |

- Joined and separate analyzer fields tie on GermanQuAD. Joined fields lead by 0.56 MRR points on QASPER, so the candidate keeps the joined layout. The analyzer clears the public German and English comparisons against fallback and reaches 60/60 identifier hit@1. The fallback also reaches 60/60.
- Four-grams reduce German MRR by 0.73 points with distractors and reduce identifier hit@1 to 48/60. They stay outside the active index. Analyzer plus E5 gives 100% recall@10 on both 200-query compound sets. The zero-point gap leaves the RE-D18 lexicon trigger closed on this probe. Lexical-only compound recall is zero with the analyzer and 99.5% with four-grams, so the hybrid result depends on the vector source.
- At 20,233 rows the lexical indexes occupy 9,965,286 bytes (joined), 11,379,557 (separate), 18,499,385 (joined with four-grams) and 40,451,027 (fallback). These are index files only.
- The first full run and the repeat from cached vectors agree on the joined analyzer, German scores and vector baseline. Some tied ranks vary. QASPER fallback MRR is .1483 on the first run and .1475 on the repeat, and four-gram identifier hit@1 is 49/60 and 48/60 respectively. The table uses the repeat, which also measured index files.
- The plan's owner-snapshot comparison, added p95 recall latency and index build-time gates remain open. Run against the owner snapshot on its host, and measure timing on a quiet reference system. Keep hybrid opt-in pending those results.
