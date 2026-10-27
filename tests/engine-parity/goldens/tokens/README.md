# Raw-text token count goldens (RE-14/T2)

`texts.json` contains fourteen texts written for this repository: German, English, Rust code, JSON, empty text,
whitespace, NFD, emoji, CJK, literal special-token spellings, contractions, numbers, control characters and punctuation.
`counts.json` records both counts and complete token IDs from the independent Python reference, not from the Rust
counter. `encode_ordinary` treats marker spellings as ordinary user text; no chat template or hidden provider preamble
is claimed. These are exact raw-text **o200k_base** counts. They do not establish an exact tokenizer for GPT-6,
unpublished Gemini/Grok models, or a provider's complete chat request.

## Pinned source and license

The admitted artifact is listed in `crates/plur1bus-engine/src/tokens/artifacts.json`. No tokenizer JSON or vocabulary is
committed or bundled. The external cache holds `<artifact-id>/tokenizer.json`.
The complete original MIT license texts and the Apache-2.0 conversion-reference attribution are retained in
[`scripts/tokens/NOTICE`](../../../../scripts/tokens/NOTICE), with immutable source links and license-file hashes.
Setup places this notice beside the external tokenizer JSON, including when restoring a cache that lacks it.

- Original `o200k_base.tiktoken` ranks: [tiktoken-rs revision
  72a5a800651a1cea1ad609292446ba02c80e3bcd](https://github.com/zurawiki/tiktoken-rs/blob/72a5a800651a1cea1ad609292446ba02c80e3bcd/tiktoken-rs/assets/o200k_base.tiktoken).
- Original SHA-256: `446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d`. OpenAI's pinned Python
  `tiktoken==0.14.0` independently requires exactly this hash in `tiktoken_ext.openai_public.o200k_base`.
- The upstream [MIT license](https://github.com/zurawiki/tiktoken-rs/blob/72a5a800651a1cea1ad609292446ba02c80e3bcd/LICENSE)
  credits Roger Zurawicki (2023). OpenAI [tiktoken](https://github.com/openai/tiktoken) is MIT, copyright OpenAI and
  Shantanu Jain. These are existing permitted licenses under `docs/dependency-policy.md`; no owner exception is granted.
- `scripts/tokens/tiktoken-to-json.mjs` deterministically converts the original byte ranks, preserving token IDs, the
  official o200k regex, all valid BPE splits and whole-piece lookup. Its approach follows the documented byte-level BPE
  conversion used by Hugging Face's Apache-2.0 `transformers` `TikTokenConverter`. Special-token insertion is disabled.
- Generated tokenizer JSON SHA-256: `ce0e5d85d93742a3e1a31c4cc6ad1b6eae6a4a757fd39f4ca7056c8865e82799`
  (11,985,716 UTF-8 bytes). The setup checks the source hash before conversion and the output hash afterward.
- The immutable `tiktoken-rs 0.12.1` crate also contains these original ranks; its package SHA-256 is
  `2aeff724640cfe13037336ddf35befdffd2909cbdb65cf041cc8a4cf8c584cfa`. The committed artifact uses the pinned GitHub URL.

Using the original tiktoken vocabulary is explicitly allowed by the work package. It is an alternate original source,
not a substitute tokenizer for an unavailable family. The managed build workspace's enforced network policy does not
allow `huggingface.co`; the original tiktoken ranks are available from the permitted upstream GitHub source.

## Re-record and verify

Use Node 24.21 and an isolated Python environment. The pinned reference tools are development-only dependencies:
OpenAI `tiktoken` is MIT and Hugging Face `tokenizers` is Apache-2.0.

```sh
python3 -m venv /tmp/re14-tokenizer-reference
/tmp/re14-tokenizer-reference/bin/pip install -r scripts/tokens/requirements-reference.txt
export PLUR1BUS_TOKENIZER_DIR=/tmp/re14-tokenizers
NODE_USE_ENV_PROXY=1 node scripts/tokens/setup-tokenizers.mjs
curl --fail --location \
  https://raw.githubusercontent.com/zurawiki/tiktoken-rs/72a5a800651a1cea1ad609292446ba02c80e3bcd/tiktoken-rs/assets/o200k_base.tiktoken \
  --output /tmp/re14-o200k_base.tiktoken
/tmp/re14-tokenizer-reference/bin/python scripts/tokens/record-goldens.py \
  --ranks /tmp/re14-o200k_base.tiktoken
/tmp/re14-tokenizer-reference/bin/python scripts/tokens/record-goldens.py \
  --ranks /tmp/re14-o200k_base.tiktoken --check
/tmp/re14-tokenizer-reference/bin/python scripts/tokens/test_record_goldens.py
node --test scripts/tokens/*.test.mjs
PLUR1BUS_TOKENIZER_FILES_REQUIRED=1 cargo test -p plur1bus-engine --test tokens
```

The recorder verifies both the converted tokenizer file and original ranks against their manifest hashes. It obtains
the encoding regex from the actual pinned Python library, replacing only its network loader with the checked local
ranks. It fails if any admitted artifact is missing or changed. `--check` never rewrites a missing or stale golden.
Before recording or checking, it also compares complete token IDs from the converted JSON through Python
`tokenizers==0.23.2` with the independent `tiktoken` result: the fourteen fixtures plus 3,000 reproducible Unicode
samples (seed `20261026`). An equal count with different token IDs fails, so a regex or BPE change cannot hide.
The Rust golden test compares actual counts and token IDs with these references. CI prepares the pinned cache and
sets `PLUR1BUS_TOKENIZER_FILES_REQUIRED=1`, so absent files fail the golden test instead of silently skipping it.
`NODE_USE_ENV_PROXY=1` makes Node's fetch honor an inherited proxy in managed environments; it is harmless without one.

## Families without an admitted file

Every `tokenizerFamily` in the provider-owned table is still enumerated and tested with the labeled heuristic when its
matching file is unavailable. A file's existence alone never admits an unapproved license or a different vocabulary.

| Family | Why this package admits no tokenizer file |
|---|---|
| `claude-v1`, `claude-v2`, `openai-unpublished`, `gemini-unpublished`, `grok-unpublished` | No public exact tokenizer is established for these families. |
| `gemma3` | Gemma Terms require explicit owner approval; none was granted. It remains heuristic. |
| Grok-2 (not a current table family) | xAI Community License requires explicit owner approval; none was granted. It remains excluded. |
| `gemma4`, `deepseek-v4`, `qwen3-8`, `glm` | The referenced original HF artifacts, immutable revisions and their license evidence could not be fetched under the workspace network policy. No older or differently named tokenizer is substituted. |
| `kimi` | The reference identifies a notice-bearing conditional artifact. No owner decision for it is established here. |
| `tekken` | A public tokenizer for a particular open model does not establish one exact vocabulary for every model in this broad family; the reference calls Mistral Large 4 unpublished. |
| `local-model` | The family's tokenizer depends on the selected local model. A generic family entry cannot safely select an arbitrary model's vocabulary. RE-03 will provide model-specific catalog entries. |

Adding a genuine permitted file requires its immutable source, SHA-256, license evidence, new reference goldens and the
same required-file CI checks. Conditional licenses remain owner decisions.
