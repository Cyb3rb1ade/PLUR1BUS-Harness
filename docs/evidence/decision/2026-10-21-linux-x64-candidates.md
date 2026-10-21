# Linux x64 decision candidates (PR #626), 2026-10-21

Same 60 core cases (de/en, 180 single-request calls) and the same warm-up/statistics method as the Mac and Windows receipts; evidence in `2026-10-21-linux-x64-candidates.json`, candidate A receipts in `laya-linux-x64-threads{1,2}.json` (+ `laya-linux-x64-environment.json`).

**Read this first.** Labels are agent-authored (not independently validated; one case = 1.67 points of accuracy). The machine is a shared 2-vCPU cloud sandbox VM (KVM, Intel Xeon @ 2.10 GHz, family 6 model 207 = Sapphire Rapids class, AVX2, AVX-512 incl. VNNI, AVX-VNNI, AMX-INT8/BF16 flags exposed, 7.8 GiB RAM, no swap, Linux 6.18.44, Node 24.21.0, onnxruntime-node 1.30.0), not the owner NAS VM and not reference hardware. Absolute latencies do not transfer; ratios are the portable signal. Every timing run started only on a quiet machine (no cargo/rustc/pnpm/vitest/node --test, 1-min load < 0.5) and its foreign-CPU share was recorded (all kept runs: foreign share of the inference loop <= 1.6 %, worst 30-call chunk <= 4.1 %); one run was discarded and repeated (C-t2-rep3, 7 % foreign CPU).

## Candidates

- **A** `inferenceprince/laya-onnx` @ dd0f4db7, English root Laya (ModernBERT-large 421M, fp16 weights), exactly as pinned in the manifest; also run through the original hash-pinned runner (`A-orig-*`, the committed receipts).
- **B** `convaiinnovations/laya-multilingual` @ 1720e3e3 (mmBERT-base, 322M, Apache-2.0), exported by us to ONNX fp32 (torch dynamo exporter, opset 18, laya 0.4.12 `DecisionModel` as model code; head, option-marker scoring and temperatures identical to A's contract). Fidelity: 0/180 token-id mismatches between the JS and Python tokenizers, max |logit diff| ONNX vs eager fp32 1.4e-5, no argmax flips.
- **C** B with ORT dynamic int8 (`quantize_dynamic`, per-channel QInt8 weights; attention score/value MatMuls stay fp32).
- **D** A with the same int8 recipe (needs an fp32 upcast of A first; a direct fp16 quantization is not possible with ORT and a first in-memory attempt was OOM-killed).
- **A32** (extra control) A with fp16 weights upcast to fp32, to see whether fp16 costs anything on this CPU.

## Main result (uncapped; threads 1 and 2)

| Run | Threads | Token cap | Warm p50 / p95 (ms) | 5-question batch p50 (ms) | Accuracy de / en (%) | Brier de / en | ECE de / en | Max RSS (MiB) | Load (ms) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| A-orig-t1 | 1 | - | 539.6 / 923.8 | 1691.2 | 46.7 / 65.0 | 0.647 / 0.457 | 0.099 / 0.165 | 1707 | 4510.2 |
| A-orig-t2 | 2 | - | 303.2 / 565.8 | 812.7 | 46.7 / 65.0 | 0.647 / 0.457 | 0.099 / 0.165 | 1744 | 4309.4 |
| A-t1 | 1 | - | 538.3 / 919.9 | 1588.6 | 46.7 / 65.0 | 0.647 / 0.457 | 0.099 / 0.165 | 1725 | 3338.8 |
| A-t2 | 2 | - | 344.2 / 572.6 | 1036.2 | 46.7 / 65.0 | 0.647 / 0.457 | 0.099 / 0.165 | 1736 | 3058.0 |
| A32-t2 | 2 | - | 310.1 / 531.3 | 830.9 | 45.0 / 65.0 | 0.647 / 0.457 | 0.082 / 0.165 | 1643 | 2911.6 |
| B-t1 | 1 | - | 156.5 / 231.5 | 433.7 | 51.7 / 65.0 | 0.562 / 0.483 | 0.189 / 0.162 | 1021 | 3118.5 |
| B-t2 | 2 | - | 96.9 / 145.4 | 290.0 | 51.7 / 65.0 | 0.562 / 0.483 | 0.189 / 0.162 | 1019 | 2787.9 |
| C-t1 | 1 | - | 50.6 / 79.7 | 150.9 | 48.3 / 53.3 | 0.658 / 0.564 | 0.206 / 0.162 | 651 | 2251.1 |
| C-t2 | 2 | - | 41.9 / 61.9 | 139.2 | 48.3 / 53.3 | 0.658 / 0.564 | 0.206 / 0.162 | 652 | 2833.9 |
| D-t1 | 1 | - | 132.5 / 265.3 | 342.2 | 41.7 / 56.7 | 0.669 / 0.535 | 0.150 / 0.118 | 601 | 1484.7 |
| D-t2 | 2 | - | 93.3 / 154.4 | 294.7 | 41.7 / 56.7 | 0.669 / 0.535 | 0.150 / 0.118 | 602 | 1431.0 |

`A-orig-*` = original runner (committed receipts); `A-*` = the candidate runner on the same model (same picks and metrics, so the two runners agree). German gate (accuracy gap <= 5 points and Brier gap <= 0.05): every candidate fails it.

| Candidate | Accuracy gap en-de (points) | Brier gap de-en | Gate | Picks that agree with the fp reference |
|---|---:|---:|---|---:|
| A | 18.3 | 0.191 | fail | - |
| B | 13.3 | 0.079 | fail | - |
| C | 5.0 | 0.095 | fail | 76.1 % (vs B-t2) |
| D | 15.0 | 0.134 | fail | 65.6 % (vs A-t2) |
| A32 | 20.0 | 0.190 | fail | 99.4 % (vs A-t2) |

## Repeat runs (threads 2, uncapped), run-to-run spread

| Candidate | warm p50 (ms), runs 1/2/3 | warm p95 (ms), runs 1/2/3 |
|---|---|---|
| A | 344.2 / 285.7 / 312.2 | 572.6 / 523.6 / 532.8 |
| B | 96.9 / 92.4 / 98.1 | 145.4 / 123.8 / 146.5 |
| C | 41.9 / 59.4 / 42.1 | 61.9 / 89.7 / 62.8 |
| D | 93.3 / 94.0 / 96.2 | 154.4 / 170.7 / 178.7 |

C-t2-rep2 (59.4 ms) is an outlier against 41.9 and 42.1 ms although the contention checks passed; treat sub-20 ms differences as noise.

## Token caps (threads 2)

Cap rule as in Laya `build_sequence`: head (question and options) kept whole, state clipped on the right to the remaining room; a head that alone exceeds the cap is an error row (none occurred). **Caps of 128 and 256 truncate nothing on this fixture** (longest sequence: 79 tokens for the mmBERT tokenizer, 117 for the English one), so those rows reproduce the uncapped answers exactly and differ only by timing noise. Only cap 64 changes inputs (36 of 180 rows lose state tokens).

| Run | Threads | Token cap | Warm p50 / p95 (ms) | 5-question batch p50 (ms) | Accuracy de / en (%) | Brier de / en | ECE de / en | Max RSS (MiB) | Load (ms) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| A-t2-cap128 | 2 | 128 | 293.4 / 554.0 | 858.2 | 46.7 / 65.0 | 0.647 / 0.457 | 0.099 / 0.165 | 1729 | 3449.4 |
| A-t2-cap256 | 2 | 256 | 311.8 / 556.8 | 873.7 | 46.7 / 65.0 | 0.647 / 0.457 | 0.099 / 0.165 | 1786 | 2916.9 |
| B-t2-cap64 | 2 | 64 | 90.9 / 115.9 | 254.5 | 51.7 / 65.0 | 0.556 / 0.477 | 0.148 / 0.148 | 1020 | 2713.8 |
| B-t2-cap128 | 2 | 128 | 99.0 / 136.9 | 272.4 | 51.7 / 65.0 | 0.562 / 0.483 | 0.189 / 0.162 | 1014 | 3134.3 |
| B-t2-cap256 | 2 | 256 | 90.1 / 136.1 | 273.2 | 51.7 / 65.0 | 0.562 / 0.483 | 0.189 / 0.162 | 1021 | 2716.3 |
| C-t2-cap64 | 2 | 64 | 36.7 / 52.1 | 111.4 | 46.7 / 55.0 | 0.631 / 0.556 | 0.198 / 0.175 | 640 | 2099.6 |
| C-t2-cap128 | 2 | 128 | 38.8 / 55.4 | 102.9 | 48.3 / 53.3 | 0.658 / 0.564 | 0.206 / 0.162 | 639 | 2296.1 |
| C-t2-cap256 | 2 | 256 | 40.5 / 60.6 | 132.0 | 48.3 / 53.3 | 0.658 / 0.564 | 0.206 / 0.162 | 691 | 2148.8 |
| D-t2-cap128 | 2 | 128 | 89.1 / 150.9 | 239.6 | 41.7 / 56.7 | 0.669 / 0.535 | 0.150 / 0.118 | 589 | 1296.1 |
| D-t2-cap256 | 2 | 256 | 97.4 / 166.2 | 283.2 | 41.7 / 56.7 | 0.669 / 0.535 | 0.150 / 0.118 | 588 | 1220.5 |

Cap 64 on B: picks agree with uncapped B on 90.6 % of all 180 rows, core-case accuracy unchanged (51.7 / 65.0). On C: picks agree with uncapped C on 93.3 % of rows, accuracy 46.7 / 55.0 against 48.3 / 53.3 uncapped. Cap-64 latency gain: B p50 91 vs ~97 ms, C 37 vs ~42 ms (about 6-12 %, partly inside the run-to-run spread).

## Reading

- **Latency.** On this VM, B (fp32 mmBERT-base) is about 3.5x faster than A at 2 threads (warm p50 ~97 vs ~340 ms, p95 ~145 vs ~570 ms) with 40 % less RSS; C (int8) is another ~2.3x faster (p50 ~42 ms, p95 ~62 ms), D (int8 of A) reaches ~93 / 154 ms. Only C meets a 100 ms budget at p95 here; B meets 200 ms at p95, A does not. Single-thread: A 538 / 920, B 157 / 232, C 51 / 80, D 133 / 265 ms. The VM exposes AVX-512 VNNI/AMX; the Windows NAS Haswell guest and the owner's hardware may show a different ratio, notably for int8.
- **Accuracy (fixture-relative, agent labels).** A: de 46.7 / en 65.0. B: de 51.7 / en 65.0 (+5 points German, equal English; the model card says it is weaker on English but this fixture does not show it). int8 hurts: C drops en to 53.3 (-11.7) and agrees with B on only 76 % of picks; D drops to 41.7 / 56.7 and agrees with A on 66 %. The Brier score worsens for both int8 variants. With 60 cases per language these differences are at the edge of what the fixture can resolve (B vs A in German is +3 cases).
- **German gate.** All candidates fail it. B narrows the gaps (13.3 points, Brier +0.079) but still fails; C is closest on accuracy (5.0 points) only because English got worse, not because German improved.
- **Calibration.** B ships uncalibrated (all temperatures 1.0), ECE de 0.189 / en 0.162; A de 0.099 / en 0.165. No temperature refit was done here.
- **Not measured:** long-state latency (fixture states are short), batches beyond five questions, other CPUs, quantization variants (static QDQ with calibration data, int8 only for the head or FFN, fp16/bf16 execution), a calibrated multilingual temperature.
