# F4 Kev MLX spike: blocked before inference

Checked 2026-10-20 on Apple M5 Pro / 48 GiB / macOS arm64. No Harness product files changed.
No model inference, benchmark, server start or large model download took place. Metrics are null,
and automaticGermanEligibility is false. This result is a reproducible preflight failure, not an
accuracy or latency result and not an F4 backend delivery.

## Exact sources

- Upstream [jaredpalmer/kev](https://github.com/jaredpalmer/kev/tree/1f04cfa28e6a708485b28a9585010b9e436b776e),
  commit `1f04cfa28e6a708485b28a9585010b9e436b776e`, Apache-2.0. Detached checkout `/tmp/gp4-kev-spike`.
- `uv.lock` SHA-256 `a9922dbb89acdef78299fd2b4a8c3f7f0fa1b2bc08b55595b6926fa785a9c466`.
- `pyproject.toml` SHA-256 `7c17fbe9efcadda3eb488b59adf1b6db5938cd33af4d3bd389ce4359b73fcc7d`.
- `LICENSE` SHA-256 `6b08bb37982c233aa12bcbdf19106da12f3f4fcf800773ea42e28ebeddd34fb8`.
- Fixture retained unchanged in `/tmp/gp4-kev-results/decision-eval-cases.json` from F3; not duplicated in this evidence directory. SHA-256
  `4fdd03e69e2647ba604d783bed8d702497a43f345f706c6b72b14e5b1c61ba15`.
  60 DE/EN core pairs plus 30 extra pairs. Labels remain agent-authored, not independently human-validated.

The upstream checkout remains clean, including its lockfile. Only its ignored `.venv` environment was created.
No PyPI package named kev was installed; `uv` attempted to build the local checkout's editable package.
No alternate dependency versions were substituted.

## Model manifests and prospective download sizes

`model-manifests.json` records exact Hub revisions, per-file sizes, LFS SHA-256 where published and Git blob IDs.
The base revisions are the ones in the checkpoints' pinned training metadata, not a newly chosen base revision.

| Artifact | Revision | Repository bytes |
|---|---|---:|
| Kev-0.8B | `bf75a6a8848ea6960ff2ed108d9ed44c2941174f` | 65,566,187 |
| Qwen3.5-0.8B-Base | `dc7cdfe2ee4154fa7e30f5b51ca41bfa40174e68` | 1,769,913,749 |
| Kev-4B | `6cfce5c2fa4b4bd64026336ab649c5ca78857d52` | 159,741,853 |
| Qwen3.5-4B-Base | `1001bb4d826a52d1f399e183466143f4da7b741b` | 9,342,824,751 |

All four Hub cards identify Apache-2.0. These are repository totals; the upstream loader filters file types,
so the exact transfer can be smaller. Model weights were not downloaded. Normal Hugging Face cache conventions
should be retained once a working approved dependency route is available.

## Reproduce the dependency blocker

```sh
cd /tmp/gp4-kev-spike
uv sync --frozen --extra serve --no-dev --python 3.13
uv sync --frozen --offline --extra serve --no-dev --python 3.13
```

`uv-sync.log`: download of `networkx==3.6.1` failed after three retries. The wheel host
`files.pythonhosted.org` resolves to `0.0.0.0` and `::` on this machine; TCP connect fails with
`Connection refused (os error 61)`. A Python stdlib HEAD request reproduced the failure. No proxy is configured.
No DNS setting was changed and no alternate address was used to bypass this result.

`uv-offline.log`: exact `protobuf==6.33.6` macOS universal wheel is absent from the cache.
Frozen offline sync cannot finish either. The environment therefore cannot yet execute the upstream MLX server.
`preflight.json` records Python/uv versions, platform, pinned dependency versions and wheel hashes from `uv.lock`.
`dependency-license-metadata.json` contains the public PyPI metadata of those exact direct/runtime packages;
this is metadata evidence, not a complete transitive license audit.

## Supervised local-only continuation

After resolving the dependency route without changing the frozen lock, the inspected upstream CLI accepts:

```sh
cd /tmp/gp4-kev-spike
KEV_BACKEND=mlx uv run --frozen --no-sync python -m kev.serve \
  --run jaredpalmer/kev-0.8b@bf75a6a8848ea6960ff2ed108d9ed44c2941174f \
  --host 127.0.0.1 --port 18177 --device mps
```

This command has NOT been executed. Any continuation must own the subprocess and stop it in a `finally` block,
including after readiness/inference failure. No persistent service, deployment or external listener is intended.
The upstream `Checkpoint` reads `base_revision` from `head.pt` and uses it for tokenizer/base loading.
If that loaded metadata differs from the recorded base pin, stop instead of fetching an unpinned base.

`POST /v1/systemone` maps a fixture choice to `state` plus
`questions[id] = {type: "choice", instructions: localizedQuestion, criteria: {optionId: localizedDescription}}`.
`GET /v1/models` reports backend, effective temperature and prefix-cache hits/misses. Distinguish a first state-cache
miss from a repeated state-cache hit using these counters; do not label an already cached repeated fixture as cold.
Measure HTTP and model latency separately, startup/model loading separately, and process peak RSS in a fresh process.
Record full backend/environment provenance; MLX serving is not the upstream fp32 torch reference path.

The API rounds distributions to four decimals. For HTTP Brier evaluation, record those raw response distributions
and any normalization, with an explicit sum tolerance; the Laya helper's 1e-6 sum check is too strict for these rounded
responses. Do not report rounded-response metrics as saved unrounded logits. Upstream local benchmark guidance also
requires saving actual logits and the effective inference temperature for a calibration claim. No calibration fit,
label adjustment, role comparison or German gate pass has been measured here.
