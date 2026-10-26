#!/usr/bin/env python3
"""Record raw-text count and token-ID goldens using pinned Python reference libraries.

RE-14/T2: no network calls, no Rust counter imports, and no tokenizer files in the repository.
Every listed artifact and original rank source must match its committed SHA-256 before recording.
"""
import argparse
import base64
import hashlib
import json
import os
import pathlib
import random
import sys
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[2]
TIKTOKEN_VERSION = "0.14.0"
TOKENIZERS_VERSION = "0.23.2"


def verified_bytes(path, expected_hash):
    """Read a pinned external file, refusing absent or changed bytes."""
    data = pathlib.Path(path).read_bytes()
    if hashlib.sha256(data).hexdigest() != expected_hash:
        raise ValueError(f"SHA-256 mismatch: {path}")
    return data


def validate_texts(document):
    """Return uniquely named UTF-8 text fixtures; malformed fixtures fail closed."""
    if (document.get("version") != 1 or not isinstance(document.get("texts"), list)
            or not document["texts"]):
        raise ValueError("Expected version 1 with a nonempty texts list")
    seen = set()
    for item in document["texts"]:
        if set(item) != {"id", "text"} or not isinstance(item["id"], str) or not item["id"]:
            raise ValueError("Every fixture needs a nonempty string id and text")
        if item["id"] in seen:
            raise ValueError(f"duplicate fixture id: {item['id']}")
        if not isinstance(item["text"], str):
            raise ValueError(f"Expected text for fixture {item['id']}")
        item["text"].encode("utf-8")
        seen.add(item["id"])
    return document["texts"]


def reference_encoder(artifact, artifact_bytes, ranks_path):
    """Construct the independent reference encoder with special-token insertion disabled."""
    if artifact.get("sourceFormat") == "tiktoken-ranks":
        import tiktoken
        import tiktoken_ext.openai_public as openai_public

        if tiktoken.__version__ != TIKTOKEN_VERSION:
            raise ValueError(f"Install tiktoken=={TIKTOKEN_VERSION} for reference recording")
        if artifact["family"] != "o200k" or ranks_path is None:
            raise ValueError("o200k reference recording needs --ranks with the pinned original source")
        source = verified_bytes(ranks_path, artifact["sourceSha256"])
        ranks = {
            base64.b64decode(line.split()[0]): int(line.split()[1]) for line in source.splitlines()
        }

        def pinned_ranks(_url, expected_hash):
            if expected_hash != artifact["sourceSha256"]:
                raise ValueError("The artifact is not OpenAI tiktoken's pinned o200k_base source")
            return ranks

        # Use the official regex and special-token contract. Replacing its loader prevents I/O.
        with patch.object(openai_public, "load_tiktoken_bpe", pinned_ranks):
            encoder = tiktoken.Encoding(**openai_public.o200k_base())
        return encoder.encode_ordinary, {
            "library": "tiktoken", "version": TIKTOKEN_VERSION, "mode": "encode_ordinary",
        }

    import tokenizers

    if tokenizers.__version__ != TOKENIZERS_VERSION:
        raise ValueError(f"Install tokenizers=={TOKENIZERS_VERSION} for reference recording")
    tokenizer = tokenizers.Tokenizer.from_str(artifact_bytes.decode("utf-8"))
    tokenizer.no_truncation()
    tokenizer.no_padding()
    return lambda text: tokenizer.encode(text, add_special_tokens=False).ids, {
        "library": "tokenizers", "version": TOKENIZERS_VERSION,
        "mode": "encode(add_special_tokens=False)",
    }


def verify_token_ids(reference, converted, texts):
    """Refuse equal-count encodings whose token IDs differ, so BPE or regex drift cannot hide."""
    for index, text in enumerate(texts):
        if reference(text) != converted(text):
            raise ValueError(f"token-ID mismatch against the independent reference at case {index}")


def verify_converted_o200k(artifact_bytes, reference, fixtures):
    """Check the conversion against actual Python tiktoken on fixtures and seeded Unicode text."""
    import tokenizers

    if tokenizers.__version__ != TOKENIZERS_VERSION:
        raise ValueError(f"Install tokenizers=={TOKENIZERS_VERSION} for conversion verification")
    tokenizer = tokenizers.Tokenizer.from_str(artifact_bytes.decode("utf-8"))
    tokenizer.no_truncation()
    tokenizer.no_padding()
    rng = random.Random(20261026)
    alphabet = ("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
                " \t\r\n+-\\/_=()[]{};:'\"äöüßé中😀")
    texts = [item["text"] for item in fixtures]
    texts += ["".join(rng.choices(alphabet, k=rng.randrange(0, 400))) for _ in range(3000)]
    verify_token_ids(
        reference, lambda text: tokenizer.encode(text, add_special_tokens=False).ids, texts
    )
    print(f"Verified converted o200k token IDs against tiktoken on {len(texts)} cases")


def build_goldens(manifest, texts, cache_root, ranks_path):
    """Count every fixture for every admitted artifact; no missing artifact is skipped."""
    if manifest.get("version") != 1 or not manifest.get("artifacts"):
        raise ValueError("Expected version 1 with at least one admitted artifact")
    fixtures = validate_texts(texts)
    cases = []
    references = []
    for artifact in manifest["artifacts"]:
        if (artifact["licenseStatus"] != "permissive"
                or artifact["license"] not in {"MIT", "Apache-2.0", "BSD-3-Clause"}):
            raise ValueError(f"Reference recording refuses unapproved license: {artifact['id']}")
        if artifact["family"] in {"gemma3", "grok", "grok2", "grok-unpublished"}:
            raise ValueError(f"Owner license approval is absent: {artifact['family']}")
        artifact_bytes = verified_bytes(
            cache_root / artifact["id"] / artifact["file"], artifact["sha256"]
        )
        encode, reference = reference_encoder(artifact, artifact_bytes, ranks_path)
        if artifact.get("sourceFormat") == "tiktoken-ranks":
            verify_converted_o200k(artifact_bytes, encode, fixtures)
        references.append({"artifactId": artifact["id"], "sha256": artifact["sha256"], **reference})
        for item in fixtures:
            ids = encode(item["text"])
            cases.append({
                "family": artifact["family"], "artifactId": artifact["id"], "id": item["id"],
                "tokens": len(ids), "ids": ids,
            })
    return {"version": 1, "reference": references, "cases": cases}


def write_or_check(path, document, check):
    """Write deterministic goldens, or refuse drift without changing the file in check mode."""
    encoded = (json.dumps(document, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    if check:
        if not path.exists() or path.read_bytes() != encoded:
            raise ValueError(f"stale golden file: {path}; rerun scripts/tokens/record-goldens.py")
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(encoded)


def main():
    """Record or check the committed token goldens using an explicitly prepared external cache."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--tokenizer-dir", type=pathlib.Path, default=os.getenv("PLUR1BUS_TOKENIZER_DIR")
    )
    parser.add_argument("--ranks", type=pathlib.Path, help="pinned original o200k_base.tiktoken source")
    parser.add_argument("--check", action="store_true")
    parser.add_argument(
        "--output", type=pathlib.Path,
        default=ROOT / "tests/engine-parity/goldens/tokens/counts.json",
    )
    args = parser.parse_args()
    if args.tokenizer_dir is None:
        parser.error("--tokenizer-dir or PLUR1BUS_TOKENIZER_DIR is required; no missing-file skips")
    manifest = json.loads((ROOT / "crates/plur1bus-engine/src/tokens/artifacts.json").read_text())
    texts = json.loads((ROOT / "tests/engine-parity/goldens/tokens/texts.json").read_text())
    document = build_goldens(manifest, texts, pathlib.Path(args.tokenizer_dir), args.ranks)
    write_or_check(args.output, document, args.check)
    action = "Checked" if args.check else "Recorded"
    print(f"{action} {len(document['cases'])} count/token-ID goldens")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, ImportError) as error:
        print(error, file=sys.stderr)
        sys.exit(1)
