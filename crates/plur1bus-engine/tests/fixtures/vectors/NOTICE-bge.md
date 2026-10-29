# BGE reranker recordings

`bge-scores.json` and `token-ids-bge.json` are scores and token IDs that the pinned Node engine computed from this
repository's own test sentences (`sentences.json`) with the reranker below. They contain no model weights.

- Model: [BAAI/bge-reranker-v2-m3](https://huggingface.co/BAAI/bge-reranker-v2-m3), revision
  `953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e`, Copyright Beijing Academy of Artificial Intelligence (BAAI).
- Licence: Apache License 2.0 (`licences/Apache-2.0.txt`), as the original's model card declares.
- ONNX conversion used for inference: `woxpas-ai/bge-reranker-v2-m3-onnx`, revision
  `c44ebc43de724ae8816668bb44d2e728e17faa18`. The conversion ships no LICENSE file; by the owner's decision of
  2026-10-29 the original's licence applies. The receipt the recorder checks is `licences/bge-reranker-v2-m3.json`.
