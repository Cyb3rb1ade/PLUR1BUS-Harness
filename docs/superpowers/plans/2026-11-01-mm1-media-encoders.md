# MM-1 media encoders implementation plan

> **For agentic workers:** Use subagent-driven development for the independent preprocessing modules, then integrate and review the complete library.

**Goal:** Add local Rust image, audio and video embedding building blocks without changing text embedding, stores or RPC.

**Architecture:** Keep immutable media encoder metadata beside the unchanged Node-derived artifact catalogue. Decode and preprocess at a bounded library edge, run vision, audio and media-conditioned text in independent lazy CPU sessions, and return normalized 768-wide segment vectors. Text inference keeps priority and its existing public interface.

**Tech stack:** Rust 1.95, ort 2.0.0-rc.14 with dynamic ONNX Runtime 1.30.0, image 0.25.10 with only jpeg/png/webp, an in-tree Pillow-compatible bicubic resampler and 512-point FFT.

**Spec:** Owner work package R, MM-1 and decisions E2/E3/E8/E12/E13, supplied 2026-10-30; continuation on main authorized 2026-11-01. The summary of MM-0 and MM-0b replaces their unavailable scratch reports.

## Global constraints

- One PR for MM-1. Start from main `df525459`; do not touch #820 or its local candidate.
- Ask the controller for a free version before any RPC or existing contract change. Versions through 1.19 are reserved. This library step changes neither.
- Q8 for text, vision and audio on every platform; keep platform-specific dtype metadata so a future q4 choice changes the vector-space identity. Audio remains q8.
- Never modify `EmbeddingProvider`, generated `EmbeddingService`, Node-derived contract 1.17.0, or store-v1.
- No Jina-derived data, metrics, vectors, files or logs. Test media are generated at runtime.
- PIL resize parity is exact; Python Mel tolerance is 1e-5; complete JPEG embedding uses cosine tolerance.
- Photo budget 140, video budget 70, audio windows at most 30 seconds, at most 32 uniformly selected video frames in groups of 2–4.
- Separate media sessions and a pool using at most half the logical cores. Honor Cancel at stage boundaries and terminate active ONNX runs.
- Stop on the work package's explicit limits, including failed resize parity, text recall budget interference, unsupported ONNX inputs/operators, dependency-policy failures or more than 2 GiB extra memory.
- No skipped or disabled tests, no CI polling, no force-push/rebase/amend. Commits use the repository owner identity. The controller merges.

## Review focus

- Corrupt image headers, enormous dimensions and nonfinite audio must fail before unbounded allocation.
- Orientation and alpha composition happen before resize and patchification; padding never becomes a real soft token.
- Video selection preserves first/last frame and audio segments never silently discard samples past 30 seconds.
- Model bytes, dtype, preprocessing and token budgets all affect spaceId; no inferred SHA/size metadata.
- Cancellation while waiting for a session or running inference must leave no blocked text path or detached native work.

## Tasks

### 1. Verify the baseline and authoritative inputs

- [ ] Run normal `pnpm test:prep` and the existing local embedding unit tests with the pinned toolchains.
- [ ] Verify K's empty `[0,512]` inputs and unknown `pixel_values` refusal remain present.
- [ ] Read pinned Apache Transformers.js 4.3.1 preprocessing and model composition. Recover exact processor/config and encoder size/SHA metadata from the pinned revision or a verified existing cache; do not invent missing values.
- [ ] Record image crate release age, license, enabled features and dependency closure before accepting it.

### 2. Image preprocessing

**Files:** `crates/plur1bus-engine/src/media/{image,resize}.rs`, image tests, engine Cargo.toml/Cargo.lock.

**Produces:** An owned image tensor (padded HWC patches, column/row position IDs, valid soft-token count) after bounded JPEG/PNG/WebP decode, EXIF orientation, alpha over white and PIL bicubic resize. Preprocessing accepts bytes, a soft-token budget and `&Cancel`; errors are typed `MediaError`.

- [ ] Write and run failing bounds/orientation/alpha/patch-layout tests and generated-image PIL parity tests.
- [ ] Implement the resampler and decoding edge with explicit allocation limits; patch positions pad with -1, pixels with zero.
- [ ] Compare exact RGB resize output to Pillow over synthetic sizes/patterns. Compare patchification to the Apache reference.

### 3. Audio and video preprocessing

**Files:** `crates/plur1bus-engine/src/media/{audio,fft,video}.rs`, preprocessing reference recorder and tests.

**Produces:** Finite 16 kHz mono windows, Python-compatible log-Mel features with boolean frame mask, valid soft-token count, and uniform frame indices grouped for vision inference. Audio profile constants must come from the pinned processor configuration.

- [ ] Pin failing tests for FFT, short/long/invalid audio, framing/masks and video boundary selection.
- [ ] Implement a 512-point FFT and Python-extractor parity without adding a dependency.
- [ ] Verify log-Mel at 1e-5 and patchification exactly, using generated media and reproducible reference scripts.

### 4. Media identities and inference

**Files:** `crates/plur1bus-engine/src/media/{mod,artifacts,identity,session,embedder,seam}.rs`, narrow internal session reuse if required, `src/lib.rs`.

- [ ] Pin failing tests for platform dtype selection, immutable artifact validation, spaceId changes, cancellation and independent text progress.
- [ ] Add `MediaEmbedder::identity`, `capabilities`, and `embed(&MediaInput, &Cancel)` beside the unchanged text provider.
- [ ] Construct placeholder token IDs directly from pinned config, validate soft-token counts against produced features, and use independent vision/audio/media-text slots with their own bounded pool.
- [ ] Include all artifacts, preprocessing version, budgets and video rules in media space identity. Add FlatMediaEncoder as an explicitly selected test boundary.
- [ ] Run feature-gated real-model parity against onnxruntime-node with identical inputs (cosine >= 0.9999); measure text latency during media work, peak memory, per-modality latency, binary size and build time.

### 5. Review, verification and PR

- [ ] Run fmt, focused Rust tests, appropriate clippy, pnpm lint/docs:check, cargo deny and dependency/license/notice checks. Report any unavailable evidence explicitly.
- [ ] Obtain an independent whole-change review and fix confirmed findings.
- [ ] Update media documentation with precise available behavior and measurements; open one MM-1 PR and attach it to this task. Do not claim real-model acceptance from a synthetic seam.
