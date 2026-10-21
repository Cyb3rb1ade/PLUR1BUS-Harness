# Owner NAS Ubuntu VM: Laya candidate attempt (PR #626), 2026-10-21

Evidence in `2026-10-21-nas-ubuntu-candidates.json`. **Result: no valid latency measurement.** Candidate A does not fit next to the desktop session on this VM without swapping; candidates B, C and D could not be built.

## The machine

Ubuntu 26.04.1, Linux 7.0.0-38, KVM guest "Standard PC (i440FX + PIIX)", 16 logical CPUs as the guest sees them, Haswell class (avx, avx2, fma, f16c; no AVX-512, no VNNI, no AMX), **3387 MiB RAM**, 3.9 GiB swap (swappiness 60, systemd-oomd active), a GNOME desktop session running. About 2.0 GiB MemAvailable when idle. Node v24.21.0 (official linux-x64 tarball, SHA-256 checked), onnxruntime-node 1.30.0, @huggingface/transformers 4.3.1, installed only in a scratch directory (`--ignore-scripts`, no lockfile). The scratch directory on the VM was deleted afterwards.

## What happened

| Candidate | Outcome |
|---|---|
| A (`laya-onnx` fp16, original runner, 1 thread) | Ran once, **discarded**: vmstat shows swap activity in 156 of 272 sampled seconds (swap-in 572 MiB, swap-out 921 MiB), model load 79.0 s, MemAvailable fell to 782 MiB, swap in use grew from 298 to 645 MiB, i.e. the desktop session was pushed out. Threads 2 and 4 and the candidate runner were cancelled so as not to push it further. |
| B, C, D | **Not built.** The export and quantization scripts need torch, onnx, onnxscript, transformers and `laya==0.4.12` from PyPI. `files.pythonhosted.org` resolves to `0.0.0.0` in the local DNS (on the Mac and on the VM; `pypi.org` answers), so no wheel can be downloaded. The block was not circumvented. |

Discarded A run, shown only so the failure is traceable (not a latency result): warm p50 / p95 866 / 1444 ms, five-question batch p50 2356 ms, max RSS 1685 MiB, picks as in the cloud and Windows receipts (DE 28/60, EN 39/60, German gate not passed). The RSS (1.7 GiB) is what does not fit: desktop session (about 1.3 GiB used) plus A exceeds 3.4 GiB.

## Needed to complete the NAS measurement

- More RAM for the VM (or no desktop session): A needs about 1.7 GiB RSS; B (about 1.0 GiB) and C/D (about 0.6 GiB) would fit as is.
- `files.pythonhosted.org` reachable (or a ready-made B/C/D ONNX set), so B, C and D can be exported with `scripts/spikes/candidates-prep/*` and measured unchanged with `scripts/spikes/decision-laya-candidates.mjs`.

Measurement rule used: only with 1-minute load below 0.5, no heavy foreign process and at least 1900 MiB MemAvailable; any run with vmstat si/so above 0 is discarded.
