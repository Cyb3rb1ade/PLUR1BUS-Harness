# MM-1: verification and acceptance boundaries

Updated 2026-11-02. MM-1 adds local image, audio and video embedding to the Rust
library, producing normalized native 768-dimensional segment vectors. Defaults
are 140 image and 70 video soft tokens, audio windows of at most 30 seconds, and
at most 32 evenly selected video frames grouped in batches of 2–4. The text
contract, RPC surface and Store-v1 remain unchanged.

This report distinguishes independent Controller runs from earlier author
measurements. Passing a library or model test does not establish production
wiring, all-platform acceptance, photographic retrieval quality or an encoder
footprint in the release executable.

## Independent Controller verification, 2026-11-02

The reviewed feature head was `0e7b37aed79fe77c5dc436fe0245da6e39fd3a8c`.
The Controller corrected test fixtures to use the physical macOS temporary parent;
production no-follow cache traversal was not relaxed. Before this correction,
nine preparation tests failed with `UnsafePath`. After correction:

| Check | Result and scope |
|---|---|
| Actual Engine library | **110 passed, 0 failed, 0 ignored** on macOS arm64. The Linux-only priority test accounts for the author's 111-test Linux total. |
| FIFO child-test execution | Exact child filter must execute and pass one test; a deliberately nonexistent filter fails the parent assertion. |
| Actual Engine native model integration | **1 passed, 0 failed, 0 ignored**, 21.06 s; the repository `media_model_parity` target linked the actual Engine crate, without contract adapters. |
| Engine Clippy | `--all-targets --features real-models -- -D warnings` passed. |
| Repository checks | Formatting, lint (163 passed, 3 existing LAYA TODOs), and `pnpm docs:check` passed. |
| Vendor provenance | All 39 upstream files compared against the original cached package; exactly four declared HV sampler changes. Source verifier and 11 attribution tests passed. |

The native model test used the existing offline cache. No weights or ORT library
were downloaded. All nine pinned artifact sizes/hashes and the ORT library
size/hash were checked before loading. Revision:
`daa72c51243991dfcaf9f9137d2c573d8f7790c0`; ORT 1.30.0;
Transformers.js 4.3.1; Pillow 12.3.0; Node 24.21.0.

The Controller regenerated synthetic references with the unchanged reference
script, checked all four encoded hashes against the previously frozen manifest,
then reran with `--reuse`. This did not replace the frozen test cases. An earlier
attempt correctly failed before model loading because that selected cache lacked
the Fusion graph; missing prerequisites are not counted as successful tests.

## Frozen JPEG and PNG cases

The four synthetic 320×240 cases share one RGB gradient: quality-85 JPEG with
4:2:0, 4:4:4 and progressive 4:2:0 sampling, plus lossless PNG. Pixel comparison
runs before embedding comparison. Every case must meet its own threshold; an
average cannot hide a failed case.

| Case | Maximum RGB difference | Mean absolute difference | Independent end-to-end cosine | Required |
|---|---:|---:|---:|---|
| JPEG 4:2:0 | 2 LSB | 0.006532118056 LSB | 0.999865899927659 | Maximum 2 LSB; cosine >=0.9997 |
| JPEG 4:4:4 | 2 LSB | 0.010373263889 LSB | 0.999890726595500 | Maximum 2 LSB; cosine >=0.9997 |
| Progressive JPEG 4:2:0 | 2 LSB | 0.006532118056 LSB | 0.999865899927659 | Maximum 2 LSB; cosine >=0.9997 |
| Lossless PNG | 0 LSB | 0 | 1.000000000000002 | Exact pixels; cosine >=0.9999 |

Cosines slightly above 1 reflect floating-point rounding. Encoded SHA-256:

| Case | SHA-256 |
|---|---|
| JPEG 4:2:0 | `275600883a904440cb349a22492ed0801b4c8eced541928a0ca9aa07e124e2f9` |
| JPEG 4:4:4 | `94982dba5134512b938ac274cddf6b8a8fe10319ac8f4ae4e65ad4290be6a843` |
| Progressive JPEG 4:2:0 | `ba122821ce273585dc73c84edbf6acad1dcf77343cb3aa2450b4bef2202c4901` |
| Lossless PNG | `b770835aabb13db72fb346d1d4cc6f467952acb93c5894becaf3f9568693ccaf` |

The existing acceptance protocol uses >=0.9997 for each JPEG because native and
Pillow/libjpeg-turbo decoding can round differently. Identical decoded pixels,
identical model tensors and PNG retain >=0.9999. This Controller run did not
change either threshold. Its identical-input/image and identical-decoded-pixel
comparisons were approximately 1; the lowest decoded-pixel cosine was
0.999999999999998. Audio feature/final cosines were 0.999999999996068 and
0.999999999999084, respectively.

The unpatched decoder failed the frozen 4:2:0 regression at 4 LSB and
0.9996163998778644. The local `zune-jpeg` patch combines vertical/horizontal
chroma interpolation and rounds once with alternating 8/7 biases. Only four
scalar/AVX2/NEON/portable-SIMD HV sampler files differ from the published package;
IDCT and color conversion remain unchanged. Image identity records
`mm1-image-v2` and `zune0.5.15-fused-hv-v1`.
[Patch provenance and source verification](../vendor/zune-jpeg/PLUR1BUS-PATCH.md)
are included.

The 2-LSB limit describes these frozen cases. Earlier small high-frequency 32×24
cases had larger boundary differences (up to 9 LSB RGB and 5 LSB YCCK). The patch
reduces their mean error without establishing universal JPEG equivalence.
Grayscale, CMYK/YCCK and EXIF orientation remain supported. An alternative decoder
was rejected after failing an individual cosine case.

## Earlier author measurements

These results are retained as historical evidence, not represented as fresh
Controller runs. The final earlier macOS harness used the actual media,
K-transport, ORT-session and vendor sources at `f2bddf31`, checking 71 source
hashes. Its unchanged repository test body used a crate alias and generated-type
adapters; it did not compile Lance or the complete Engine crate. A separate Linux
run passed 111 library and 23 transport integration tests, including 56 media
tests. The independent Controller model run above now also covers the actual
Engine crate on macOS.

| Area | Reported result | Boundary |
|---|---|---|
| Image preprocessing | Exact Pillow RGB resize over 48 synthetic cases; patch layout, scale and positions checked | Resampler evidence; JPEG differences evaluated separately. |
| Audio preprocessing | Python log-Mel tolerance 1e-5; masks/patch layout and own 512-point FFT checked | Mono 16 kHz; decoding/resampling supplied audio files is outside this library step. |
| Native input types | Image `[B,P,768]` / `[B,P,2]`; audio float `[B,T,128]` plus bool mask | Native model evidence on macOS arm64 only. |
| Cancellation | 25-ms deadline returned from real vision after 33.96 ms; subsequent run succeeded | `7674627e`; native model loading is cancellable before/after the call. |
| Text during native vision | p95 63.05 ms; maximum 64.45 ms across 30 calls | Warm 13-token query and measured overlap, not general recall latency. |
| Audio resources | 30 s / 480000 samples: 2504.79 ms; additional RSS 969637888 B | `7674627e`. |
| Video resources | 32 repeated synthetic frames after audio: 13818.99 ms; cumulative additional RSS 1613807616 B | Maximum tensor/count path; below 2 GiB in that run. |
| E3 budgets | At 280/140/70 soft tokens, 20/20 corresponding queries ranked first; MRR 1 | Simple named synthetic scenes, ceiling effect; photographic quality remains open. |
| Preparation | 12 preparation and 2 boundary tests plus 23 transport tests | Loopback/synthetic files; not a live HF download or MM-3b automatic Core invocation. |

The strong overlap test started native vision 50 ms before text timing and checked
active work before/after each text call. Vision runs took 1289.99/1099.09 ms;
additional RSS was 504102912 B. A broader earlier provider measurement reported
text p95 149.73 ms, maximum 180.26 ms, cold image 2379 ms and two frames 1104 ms;
the short warm overlap measurement does not replace that broader result.

Text RSS baseline was 262307840 B and cumulative peak 1876115456 B. Resource,
cancellation and overlap measurements used `7674627e`; first-call/budget paths
were rechecked at `60ba2460`. The complete resource matrix was not repeated at
`f2bddf31`. E3 used real q8 text and 20 independently named synthetic scenes at
`60ba2460`; total image times at 280/140/70 were 70040.99/20591.26/9237.37 ms,
with additional RSS 1026506752 B.

Explicit limits remain: 64 MiB encoded/native decoder output, 40 million pixels,
and container/metadata/inner-WebP dimensions checked before decoding. Internal
library limits can be best effort; explicit outer checks remain active. FIFO and
symlink refusal, initialization before lowering priority, and budget-dependent
identity were reviewed. Windows file/scheduling paths were source-reviewed,
without a native run. Initial full-crate linking failed at a 32-GB filesystem
limit before tests ran; reduced test debug information enabled the subsequent
unchanged assertions and dependency set.

## Dependencies, licensing and attribution

The added image decoder closure was recorded by the author as follows:

| Crate | Version | Publication date | License alternatives |
|---|---|---|---|
| image | 0.25.10 | 2026-03-10 | MIT / Apache-2.0 |
| byteorder-lite | 0.1.0 | 2024-04-07 | Unlicense / MIT |
| fdeflate | 0.3.7 | 2024-12-06 | MIT / Apache-2.0 |
| image-webp | 0.2.4 | 2025-08-27 | MIT / Apache-2.0 |
| miniz_oxide | 0.8.9 | 2025-06-09 | MIT / Zlib / Apache-2.0 |
| moxcms | 0.8.1 | 2026-03-07 | BSD-3-Clause / Apache-2.0 |
| png | 0.18.1 | 2026-02-14 | MIT / Apache-2.0 |
| pxfm | 0.1.30 | 2026-07-06 | BSD-3-Clause / Apache-2.0 |
| quick-error | 2.0.1 | 2021-05-07 | MIT / Apache-2.0 |
| zune-core | 0.5.3 | 2026-08-07 | MIT / Apache-2.0 / Zlib |
| zune-jpeg | 0.5.15 | 2026-03-26 | MIT / Apache-2.0 / Zlib |

`image` is exactly pinned with default features disabled and only JPEG/PNG/WebP.
The author's 29-package closure audit found no license violations; its newest
release was 44 days old and no version was yanked at that check. These are dated
audit results. Audio FFT and Pillow-compatible resampling are local sources;
preparation reuses K transport.

The vendored package preserves all original MIT, Apache and Zlib texts and
copyrights. It is not a workspace member. Nine inherited whitespace locations
are retained for exact provenance. Commit `27e88836` preserved the baseline's
199 native NPM inventory rows and 196 native NPM notice references/hashes;
these counts are not total license-text counts. Three vendor license texts are
additive, including the regression for vendored `source:null` packages.

The earlier release audit reported no blocking findings and no collection/policy
errors. Raw `cargo deny` still reported the existing `paste` maintenance advisory
`RUSTSEC-2024-0436`; the existing Owner exception expires 2027-01-30. Neither
`deny.toml` nor the allowlist was changed. This document does not claim a fresh
registry/advisory audit from the Controller's provenance comparison.

## Release footprint: measurement and remaining acceptance

Baseline `df5254598fc484870194efb2caa3cedf8f187e09` and candidate
`7993b634108222bb0c39f604eb620645376232a5` have that exact merge base, with no later
main merged into the candidate range. The previous Controller checked clean
worktrees and matching hardware/toolchain.

| Measurement | Baseline | Candidate | Difference |
|---|---:|---:|---:|
| Release executable | 877168 B | 877168 B | 0 B |
| Cold real time | 1283.54 s | 1153.44 s | -130.10 s |
| Cold user / sys | 2553.99 / 120.20 s | 2275.59 / 113.45 s | |
| Cold maximum build RSS | 2290909184 B | 2159837184 B | |
| Warm real time | 0.52 s | 0.60 s | +0.08 s |
| Warm user / sys | 0.20 / 0.17 s | 0.18 / 0.16 s | |
| Warm maximum build RSS | 181714944 B | 185008128 B | |

Each build exited 0. Each warm run had no compiling/running line and retained its
cold binary hash. Baseline SHA-256:
`5e395a4c0dd3561262590a11f1b9b4a3fe114b325792f1688fd3e0568750d0aa`;
candidate SHA-256:
`cc5441a53794872ff7ba7b2254da985010cd8961e3b06058ffbe86c8e1cc5e31`.
Equal size does not imply identical bytes. One cold/warm pair does not establish
a causal build-speed improvement.

The machine was Mac17,9, 48 GiB RAM, 18 logical CPUs, macOS 27.2 (26B123),
rustc/cargo 1.95.0, LLVM 22.1.2, Apple Clang 21.0.0, SDK 27.2, CMake 4.4.3.
The measured default-feature release target was `aarch64-apple-darwin`, package
and binary `plur1bus-engine`, two jobs, `CARGO_INCREMENTAL=0`, unpackaged and
without post-build stripping/signing. Both measurements explicitly disabled the
configured sccache wrapper with `RUSTC_WRAPPER=""`; the candidate log recorded
663 direct rustc invocations and no sccache invocation. Global configuration was
unchanged.

**These binaries do not exercise the media pipeline.** At that baseline the
entry point references only library `CRATE_VERSION`, offers `--version`, and
retains an unimplemented `serve` path. The release library defines 110 media
symbols; neither executable's 1886-symbol inventory includes media symbols.
The library includes `pub mod media` without a feature gate. `real-models = []`
only enables test targets; it does not wire production media. No particular LTO
mode is assumed as an explanation.

**The zero-byte delta is not encoder-footprint acceptance.** After RE-08 wires
production media, acceptance needs a new matching baseline and the actual
production entry point. Measure binary and packaged runtime bytes separately
from model-cache bytes; exercise a real encode and record loaded ORT/model
memory against the same text-only process baseline. Keep input cases, profiles,
compiler flags, toolchain and hardware fixed. Include cold and warm timings and
resource peaks, without inferring runtime cost from an unused library archive.
Recall below 600 ms and native execution on other release targets remain open.

### Reproducing the historical executable measurement

Cold means a new Cargo target with no compiled Rust/CMake artifacts; source
fetching happens first and network time is excluded. OS file caches are not
flushed. Warm means an immediate identical no-op build in that target. Review
local, parent and user Cargo configuration for flags, wrappers and profile
changes as well as the environment guard below. Record real compiler invocations
without copying credentials from configuration.

Run in Bash in a clean, updated baseline worktree on the Apple-Silicon Mac.
For the candidate use another new target and replace the main-equality check
with the recorded candidate commit check. Only exit-zero runs are measurements.

```bash
set -euo pipefail
test "$(uname -sm)" = "Darwin arm64"
test -z "$(git status --porcelain)"
test "$(git rev-parse HEAD)" = "$(git rev-parse refs/remotes/origin/main)"
for mm1_name in $(compgen -e); do
  case "$mm1_name" in
    RUSTC_WRAPPER)
      test -z "${RUSTC_WRAPPER:-}" || { echo "Nonempty compiler wrapper" >&2; exit 1; } ;;
    RUSTC|RUSTFLAGS|CARGO_ENCODED_RUSTFLAGS|RUSTC_WORKSPACE_WRAPPER|CARGO_BUILD_RUST*|CARGO_TARGET_AARCH64_APPLE_DARWIN_RUSTFLAGS|CARGO_PROFILE_*|CC|CXX|CFLAGS|CXXFLAGS|CC_*|CXX_*|CFLAGS_*|CXXFLAGS_*|CPPFLAGS|LDFLAGS|CMAKE_ARGS|CMAKE_TOOLCHAIN_FILE*|CMAKE_BUILD_PARALLEL_LEVEL)
      echo "Remove before measuring: $mm1_name" >&2; exit 1 ;;
  esac
done

mm1_target=aarch64-apple-darwin
mm1_measure_dir="$(mktemp -d "${TMPDIR:-/tmp}/mm1-macos-baseline.XXXXXX")"
mm1_binary="$mm1_measure_dir/target/$mm1_target/release/plur1bus-engine"
git rev-parse HEAD > "$mm1_measure_dir/source-commit.txt"
rustc -Vv > "$mm1_measure_dir/rustc.txt"
cargo -V > "$mm1_measure_dir/cargo.txt"
sw_vers > "$mm1_measure_dir/macos.txt"
xcrun clang --version > "$mm1_measure_dir/clang.txt"
xcrun --show-sdk-version > "$mm1_measure_dir/sdk.txt"
cmake --version > "$mm1_measure_dir/cmake.txt"
sysctl -n hw.model hw.memsize hw.logicalcpu > "$mm1_measure_dir/hardware.txt"
RUSTC_WRAPPER="" cargo fetch --locked --target "$mm1_target"

RUSTC_WRAPPER="" CARGO_TARGET_DIR="$mm1_measure_dir/target" CARGO_INCREMENTAL=0 CARGO_TERM_COLOR=never \
  /usr/bin/time -lp cargo build --locked --offline --release --verbose --jobs 2 \
  --target "$mm1_target" -p plur1bus-engine --bin plur1bus-engine \
  > "$mm1_measure_dir/cold.stdout" 2> "$mm1_measure_dir/cold.stderr"
stat -f '%z' "$mm1_binary" > "$mm1_measure_dir/binary-bytes.txt"
shasum -a 256 "$mm1_binary" > "$mm1_measure_dir/binary-sha256.txt"
file "$mm1_binary" > "$mm1_measure_dir/binary-kind.txt"

RUSTC_WRAPPER="" CARGO_TARGET_DIR="$mm1_measure_dir/target" CARGO_INCREMENTAL=0 CARGO_TERM_COLOR=never \
  /usr/bin/time -lp cargo build --locked --offline --release --verbose --jobs 2 \
  --target "$mm1_target" -p plur1bus-engine --bin plur1bus-engine \
  > "$mm1_measure_dir/warm.stdout" 2> "$mm1_measure_dir/warm.stderr"
shasum -a 256 "$mm1_binary" > "$mm1_measure_dir/warm-binary-sha256.txt"
cmp "$mm1_measure_dir/binary-sha256.txt" "$mm1_measure_dir/warm-binary-sha256.txt"
if LC_ALL=C grep -Eq 'Compiling[[:space:]]|Running[[:space:]]' "$mm1_measure_dir/warm.stderr"; then
  echo "Warm rebuild; do not report as a no-op measurement: $mm1_measure_dir" >&2
  exit 1
fi
echo "Measurement evidence: $mm1_measure_dir"
```

Retain the commit, exact command/profile/target/jobs, hardware/toolchain, binary
path/bytes/SHA-256, exit status, cold/warm real times and raw evidence directory.
The warm hash must equal the cold hash. Source or RE-08 baseline changes require
a fresh pair. Initial 11.18-s / approximately 1.97-MB harness measurements do not
answer the production binary/build-size question.

## Reproduction and outstanding checks

The [media reproduction guide](../scripts/media/README.md) describes cache, ORT,
Node and Python prerequisites and the unchanged `real-models` target. Missing
prerequisites fail. `PLUR1BUS_MEDIA_PARITY_FIXTURES` reuses frozen encoded bytes.
Use a physical cache/temporary parent on macOS; do not weaken no-follow traversal.

Raw historical and Controller logs are retained outside the source tree in the
review archive. They are evidence artifacts, not repository dependencies.
Remaining acceptance includes the linked production-media footprint after
RE-08, real recall latency, native model execution on other release targets,
and harder photographic retrieval cases. No model weights, model vectors or
third-party images are committed.
