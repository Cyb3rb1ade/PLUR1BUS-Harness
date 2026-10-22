# Owner NAS Ubuntu VM: Laya candidates A, B, C, D (PR #626), 2026-10-21

Evidence in `2026-10-21-nas-ubuntu-candidates.json` (27 valid runs, every run with its swap and contention record; 16 discarded attempts listed). Same 60 core cases (de/en, 180 single-request calls), same runner (`scripts/spikes/decision-laya-candidates.mjs`) and same warm-up/statistics method as the cloud receipts in `2026-10-21-linux-x64-candidates.md`. This replaces the earlier "no valid measurement" record (kept in the JSON under `earlierAttempt`).

**Read this first.** Labels are agent-authored (not independently validated; one case = 1.67 points of accuracy). The machine is a KVM guest on the owner NAS (Intel Xeon E5-2620 v3 @ 2.40 GHz, Haswell-EP, AVX2 and FMA but **no AVX-512, no VNNI, no AMX**), Ubuntu 26.04.1, Linux 7.0.0-38, Node 24.21.0, onnxruntime-node 1.30.0, Transformers.js 4.3.1, with the GNOME desktop session running. It is not reference hardware. The guest changed in the middle of the session: **cfg1** = 16 vCPUs and 3387 MiB RAM (C, all of B except the repeats, D at 2/4/8 threads); the owner then restarted the VM (the journal of the previous boot ends without a shutdown record, about 18:37 to 18:41 CEST) and **cfg2** = 64 vCPUs and 7393 MiB RAM (A, Cr, D at 1 thread, all repeat runs). CPU model and flags are identical; repeats of B, C and D at 2 threads on cfg2 fall inside the run-to-run spread of cfg1 (table below). Candidate A was only measurable on cfg2 (about 1.75 GiB RSS; the 3.4 GiB guest swapped, see JSON `earlierAttempt`).

Rules applied to every kept run: 1-minute load below 0.5 and no heavy foreign process before launch; `vmstat 1` during the run and **any nonzero si/so discards the run**, even a few KiB during model load (16 attempts discarded for it, most of them on cfg1 where B needs 1 GiB next to the desktop; all kept runs have si = so = 0); foreign CPU share in the inference loop at most 0.2 % (worst 30-call chunk at most 1.3 %), steal below 0.05 %. From B-t1 attempt 4 on, the cached pages of the other candidates' model files were evicted with `posix_fadvise(DONTNEED)` before each run to reduce page-cache pressure; the earlier kept runs (C-t1..t8, D-t2..t8) ran without it. D-t1 was lost to the VM restart and repeated on cfg2.

## Candidates

- **A** `inferenceprince/laya-onnx` @ dd0f4db7 (English root Laya, fp16), hash-verified against the manifest.
- **B** `convaiinnovations/laya-multilingual` @ 1720e3e3 (mmBERT-base), our fp32 ONNX export (torch dynamo, opset 18) built on the Mac with the committed scripts. Parity: 0 of 180 token-id mismatches JS vs Python tokenizers, max |logit diff| ONNX vs eager fp32 2.2e-5, 0 argmax flips. The weight file is byte-identical to the cloud build; the graph file differs (macOS vs Linux export). B's 180 picks are identical to the cloud result and to an arm64 Mac run.
- **C** B with ORT dynamic int8 (`quantize_dynamic`, per-channel QInt8, `reduce_range=False`) as in the cloud run.
- **D** A with the same int8 recipe after the fp32 upcast.
- **Cr** (extra, not requested) C's recipe with `reduce_range=True`, to test whether the C/D failure is the 8-bit weight range on AVX2.

## Result (uncapped, one run per cell)

| Candidate | Threads | Warm p50 / p95 (ms) | 5-question batch p50 (ms) | Accuracy de / en (%) | Brier de / en | ECE de / en | Max RSS (MiB) | Guest |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| A Laya EN fp16 | 1 | 812.9 / 1357.3 | 2412.1 | 46.7 / 65.0 | 0.647 / 0.457 | 0.099 / 0.165 | 1750 | cfg2 |
| A Laya EN fp16 | 2 | 464.1 / 829.0 | 1364.8 | 46.7 / 65.0 | 0.647 / 0.457 | 0.099 / 0.165 | 1836 | cfg2 |
| A Laya EN fp16 | 4 | 340.1 / 569.6 | 793.0 | 46.7 / 65.0 | 0.647 / 0.457 | 0.099 / 0.165 | 1819 | cfg2 |
| A Laya EN fp16 | 8 | 263.4 / 411.4 | 566.6 | 46.7 / 65.0 | 0.647 / 0.457 | 0.099 / 0.165 | 1872 | cfg2 |
| B multilingual fp32 | 1 | 228.1 / 293.4 | 723.3 | 51.7 / 65.0 | 0.562 / 0.483 | 0.189 / 0.162 | 1025 | cfg1 |
| B multilingual fp32 | 2 | 130.3 / 175.6 | 390.9 | 51.7 / 65.0 | 0.562 / 0.483 | 0.189 / 0.162 | 1032 | cfg1 |
| B multilingual fp32 | 4 | 107.6 / 140.8 | 279.2 | 51.7 / 65.0 | 0.562 / 0.483 | 0.189 / 0.162 | 1036 | cfg1 |
| B multilingual fp32 | 8 | 88.9 / 117.8 | 242.3 | 51.7 / 65.0 | 0.562 / 0.483 | 0.189 / 0.162 | 1051 | cfg1 |
| C B + int8 | 1 | 178.5 / 261.0 | 700.6 | 25.0 / 33.3 | 0.688 / 0.688 | 0.068 / 0.016 | 729 | cfg1 |
| C B + int8 | 2 | 119.9 / 157.5 | 380.0 | 25.0 / 33.3 | 0.688 / 0.688 | 0.068 / 0.016 | 788 | cfg1 |
| C B + int8 | 4 | 79.9 / 117.1 | 260.5 | 25.0 / 33.3 | 0.688 / 0.688 | 0.068 / 0.016 | 788 | cfg1 |
| C B + int8 | 8 | 68.5 / 88.8 | 191.1 | 25.0 / 33.3 | 0.688 / 0.688 | 0.068 / 0.016 | 800 | cfg1 |
| Cr B + int8 (reduce_range) | 1 | 198.8 / 290.8 | 813.1 | 50.0 / 58.3 | 0.625 / 0.530 | 0.122 / 0.142 | 739 | cfg2 |
| Cr B + int8 (reduce_range) | 2 | 121.8 / 179.9 | 455.4 | 50.0 / 58.3 | 0.625 / 0.530 | 0.122 / 0.142 | 763 | cfg2 |
| Cr B + int8 (reduce_range) | 4 | 83.7 / 128.7 | 248.3 | 50.0 / 58.3 | 0.625 / 0.530 | 0.122 / 0.142 | 714 | cfg2 |
| Cr B + int8 (reduce_range) | 8 | 70.5 / 91.8 | 186.6 | 50.0 / 58.3 | 0.625 / 0.530 | 0.122 / 0.142 | 715 | cfg2 |
| D A + int8 | 1 | 664.4 / 1230.7 | 2286.1 | 28.3 / 30.0 | 0.687 / 0.688 | 0.030 / 0.014 | 589 | cfg2 |
| D A + int8 | 2 | 342.1 / 621.4 | 1104.3 | 28.3 / 30.0 | 0.687 / 0.688 | 0.030 / 0.014 | 613 | cfg1 |
| D A + int8 | 4 | 222.8 / 384.3 | 654.0 | 28.3 / 30.0 | 0.687 / 0.688 | 0.030 / 0.014 | 616 | cfg1 |
| D A + int8 | 8 | 151.1 / 264.1 | 429.9 | 28.3 / 30.0 | 0.687 / 0.688 | 0.030 / 0.014 | 605 | cfg1 |

Max RSS for B on cfg2 repeats was about 1.36 GiB against 1.03 GiB on cfg1 (the memory-mapped weight file counts when more RAM is free); the figures above are the first kept run.

## Run-to-run spread at 2 threads (warm p50 / p95, ms)

| Candidate | p50 runs | p95 runs |
|---|---|---|
| A (cfg2, 2 runs) | 464.1 / 525.3 | 829.0 / 909.8 |
| B (cfg1, cfg2, cfg2) | 130.3 / 133.7 / 145.4 | 175.6 / 180.4 / 220.9 |
| C (cfg1, cfg2, cfg2) | 119.9 / 134.8 / 116.6 | 157.5 / 180.9 / 193.3 |
| D (cfg1, cfg2, cfg2) | 342.1 / 420.7 / 439.0 | 621.4 / 775.4 / 857.7 |

Differences of about 15 percent between single runs are noise on this shared machine.

## Reading

- **fp32 against fp16, A against B.** B is about 3.6x faster than A at 1 and 2 threads (p50 228 vs 813 ms and 130 vs 464 ms) and 3.0x at 8 threads (89 vs 263 ms), with 40 % less RSS. The ratio matches the cloud VM (3.5x), so it is the portable signal. A's p95 stays above 400 ms even at 8 threads; B's p95 is 176 ms at 2 threads and 118 ms at 8. Scaling is modest: 8 threads give 2.6x (B) and 3.1x (A) over one thread.
- **int8 is numerically unusable on this CPU.** C and D return near-uniform probabilities (max confidence 0.002; accuracy 25.0 / 33.3 % and 28.3 / 30.0 %, Brier about 0.688, which is the value of a uniform guess over three options), and their picks agree with B (A) on only 37.8 % (30.6 %) of the 180 rows. The same files behave differently elsewhere: on arm64 the identical C agrees with B on 95.6 % of rows and D with A on 93.9 %, on the AVX-512 VNNI cloud VM 76.1 % and 65.6 %. This is consistent with the saturation of the u8 x s8 integer matrix multiply on AVX2 without VNNI that the ONNX Runtime quantization documentation warns about (it recommends reduced-range weights there), and Cr supports that reading, but the cause was not isolated further; the weights themselves are fine on other CPUs; the int8 accuracy losses reported in the cloud receipt are therefore not transferable in either direction. Cr (7-bit weights) recovers to 50.0 / 58.3 % and 77 % agreement with B, still below B (51.7 / 65.0), with Brier 0.625 / 0.530.
- **int8 gives no real speed-up here either.** C against B: 1.28x at 1 thread, 1.09x at 2, 1.35x at 4, 1.30x at 8 (cloud: 2.3x); Cr against B 1.07 to 1.29x. D against A: 1.2x to 1.7x (and D is slower than B). With VNNI absent, the integer kernels do not beat the fp32 AVX2 kernels by much. RSS drops (C/Cr about 0.7 to 0.8 GiB, D 0.6 GiB, B 1.0 GiB, A 1.75 to 1.87 GiB).
- **Budgets.** A p50 below 100 ms is reached only at 8 threads by B (88.9 ms) and at 4 and 8 threads by C and Cr (C is broken; Cr 83.7 and 70.5 ms). A p95 below 100 ms is reached only by C and Cr at 8 threads (88.8 and 91.8 ms). B meets 200 ms p95 from 2 threads (175.6 ms); A does not meet it at any thread count tried (best 411 ms).
- **Accuracy and German gate.** A and B reproduce the cloud numbers exactly (A 28/60 de, 39/60 en; B 31/60, 39/60); B is +5 points in German and equal in English. A, B, C and Cr fail the preliminary German gate (A gap 18.3 points, B 13.3 points with Brier gap 0.079, C 8.3 points). D formally passes the relative gate (gap 1.7 points) only because it is at chance level in both languages (28.3 / 30.0 %); that is not a pass, the gate compares the languages with each other and does not look at absolute quality. B stays uncalibrated (all temperatures 1.0; ECE de 0.189 / en 0.162).
- **Memory fit.** On the 3.4 GiB guest B and the int8 files fit without swapping only intermittently (many B attempts were discarded for a few KiB of swap activity at load time); A did not fit. With 7.2 GiB everything runs cleanly.

## Not measured

Long-state latency, batches beyond five questions, the hash-pinned original runner (`A-orig-*`) on the NAS, static QDQ int8 with calibration data, other int8 variants (Cr is a single follow-up), a calibrated multilingual temperature, independent labels, reference hardware.
