# Local media model parity

`media_model_parity` is an explicit `real-models` integration target. Missing
models, the private Node Engine dependency, Python/Pillow, or ONNX Runtime fail
the test. It never fetches models or repairs a cache. All generated inputs are
owned synthetic images/audio; no model-derived vectors are checked in.

Prepare Node 24.21/pnpm 10 with the normal `pnpm test:prep`, and a task-local
Python environment with `Pillow==12.3.0`. Supply a host-prepared unified cache
containing the production `media::artifacts::graph_files` entries for vision,
audio, and the q8 text fusion graph. All size/SHA pins are checked before load.
The existing ORT 1.30.0 library must match `tests/common/onnx_runtime.rs`'s pin.

```sh
export PLUR1BUS_MEDIA_MODELS_CACHE=/absolute/host-prepared-cache
export ORT_DYLIB_PATH=/absolute/verified-1.30.0-library
export PLUR1BUS_NODE=/absolute/node24/bin/node
export PLUR1BUS_PYTHON=/absolute/task-venv/bin/python
cargo test -p plur1bus-engine --features real-models --test media_model_parity -- --nocapture
```

JPEG 4:2:0, 4:4:4, progressive 4:2:0, and lossless PNG variants are frozen by the
generator before measurement. A failure retains its temporary directory for
inspection. `PLUR1BUS_MEDIA_PARITY_KEEP=1` also retains successful runs. The test
can reuse the exact measured encoded bytes with
`PLUR1BUS_MEDIA_PARITY_FIXTURES=/absolute/retained-directory`. This invokes
`jpeg-reference.py --reuse`: encoded fixtures are never replaced, existing PIL
decode/resize references must match byte for byte, and fixture SHA256 is logged.
The test
logs maximum and mean absolute RGB-channel decode deviation. It independently
asserts JPEG maximum **2 LSB per channel** before cosine computation; PNG must
have **0 LSB** deviation. JPEG's per-image end-to-end cosine minimum is **.9997**,
an explicit owner decision accounting for Pillow/libjpeg-turbo versus Rust
decoder rounding. It is never averaged across fixtures. Identical decoded
pixels (PIL resize, normalization, and encoder) and identical model tensors keep
the **.9999** minimum, as does PNG end to end. The real audio graph additionally
checks its boolean mask and feature/final-vector parity at **.9999**.

The original decoder rounded vertical and horizontal chroma interpolation
separately. On the frozen 4:2:0 and progressive fixtures this produced 4 LSB
maximum deviation and cosine .9996163998778644. The local zune-jpeg 0.5.15 patch
uses the fused libjpeg interpolation formula with one final rounding step;
see `vendor/zune-jpeg/PLUR1BUS-PATCH.md` for source and licence provenance.
Its actual product decoder output is byte-identical to the native diagnostic
input: both fixtures measure maximum 2 LSB, mean .006532118056 LSB, and cosine
.9998658999276594. The 4:4:4 fixture measures maximum 2 LSB, mean .010373263889
LSB and cosine .9998907265955004; PNG has zero deviation and cosine approximately
1. Identical decoded pixels and identical graph inputs pass .9999 for all four.
Neither fixture bytes nor acceptance bounds were adjusted after measurement.

These results apply to the specified fixtures. Additional small, high-frequency
JPEG boundary cases already exceeded 2 LSB before this correction; the patch
reduces their mean error but does not establish a universal decoder-equivalence
guarantee. The test retains the strict per-fixture assertions above.
