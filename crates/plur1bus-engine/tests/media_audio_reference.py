#!/usr/bin/env python3
"""Record generated audio with the pinned Apache Gemma4 Python extractor.

Install into a separate environment with:
    python -m pip install transformers==5.5.0 numpy==1.26.4
The caller supplies a JSON object on stdin with `samples` and `processorConfig`.
The recorder performs no network access and writes no model or waveform files.
"""

import hashlib
import json
import sys

import numpy as np
import transformers
from transformers.models.gemma4 import feature_extraction_gemma4


EXTRACTOR_SHA256 = "44101c7ce4286e2e37ca10629b97a5c09c53b3862ad21ce6f9ae35d3d87d76d4"


def main():
    """Fail on missing or mismatched reference dependencies; emit actual features."""
    if transformers.__version__ != "5.5.0" or np.__version__ != "1.26.4":
        raise RuntimeError("audio reference requires transformers==5.5.0 and numpy==1.26.4")
    with open(feature_extraction_gemma4.__file__, "rb") as source:
        source_sha = hashlib.sha256(source.read()).hexdigest()
    if source_sha != EXTRACTOR_SHA256:
        raise RuntimeError(f"pinned Gemma4 extractor source SHA mismatch: {source_sha}")
    request = json.load(sys.stdin)
    samples = np.asarray(request["samples"], dtype=np.float32)
    if samples.ndim != 1 or not samples.size or samples.size > 480_000:
        raise ValueError("reference requires one nonempty mono window of at most 480000 samples")
    if not np.isfinite(samples).all():
        raise ValueError("reference samples must be finite")
    processor = request["processorConfig"]
    extractor = feature_extraction_gemma4.Gemma4AudioFeatureExtractor(
        **processor["feature_extractor"]
    )
    # A one-item batch preserves the (time, channels) shape expected by the upstream pad step.
    result = extractor(
        [samples], padding=False, truncation=False, pad_to_multiple_of=None, return_tensors="np"
    )
    features = result["input_features"][0]
    mask = result["input_features_mask"][0]
    # EmbeddingGemma2Processor._process_audio (Transformers.js 4.3.1) counts
    # every fourth actual frame-mask element; it does not apply Gemma4's cap.
    tokens = int(mask[::4].sum())
    json.dump(
        {"features": features.flatten().tolist(), "mask": mask.tolist(),
         "frames": int(features.shape[0]), "featureSize": int(features.shape[1]),
         "softTokens": int(tokens), "extractorSha256": source_sha},
        sys.stdout, allow_nan=False, separators=(",", ":")
    )
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
