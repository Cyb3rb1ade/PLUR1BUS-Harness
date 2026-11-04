# PLUR1BUS JPEG sampling patch

This is the published `zune-jpeg` **0.5.15** package, modified for MM-1 under the
owner/controller decision of 2026-11-01. It retains the existing `image` 0.25.10
JPEG backend and its grayscale, CMYK/YCCK, EXIF and bounded container handling.
There is no new codec dependency, native library, external fork or licence exception.

The upstream package is MIT OR Apache-2.0 OR Zlib; all three original licence texts
and copyright notices are retained. Every modified source file carries a notice.

The published archive has SHA-256
`27bc9d5b815bc103f142aa054f561d9187d191692ec7c2d1e2b4737f8dbd7296`,
was released on 2026-03-26, and records upstream Git revision
`31d81fed7551c8ccea456d9d8e2b1fd8bebb6995` in `crates/zune-jpeg` of
<https://github.com/etemesi254/zune-image>. `upstream-source.json` records that
provenance and the original/local SHA-256 of every published file. No upstream
source or package metadata outside the four listed upsampler files is modified.

Upstream 4:2:0 chroma upsampling rounds the vertical interpolation to an integer,
then rounds horizontal interpolation again. This differs from Pillow/libjpeg-turbo,
which combines both weights and rounds once, alternating biases 8 and 7 before
shifting by four bits. The patch implements that fused calculation. AVX2, NEON and
experimental portable SIMD dispatch through the same fused HV function; other
sampling modes, IDCT, colour conversion and decoder paths are unchanged.

The stricter owner requirement is at most 2 LSB per decoded RGB channel and JPEG
final-vector cosine at least 0.9997 **for each frozen image**. On the unchanged
320×240 quality-85 reference images, upstream reached 4 LSB for 4:2:0/progressive.
The fused calculation reaches 2 LSB. Independent Mac q8 graph checks measured
0.9998658999276594 for both 4:2:0 variants and 0.9998907265955004 for 4:4:4. PNG
remains exact. Those measurements motivate this patch; they are not a claim about
all possible JPEG content. A tested alternative decoder passed the pixel bound
but failed the per-image model bound and is not included.

Run the local source receipt check from the repository root:

```sh
node vendor/zune-jpeg/verify-source.mjs
```

The focused production decoder test is
`frozen_jpeg_decodes_stay_within_two_lsb_and_png_is_exact` in the feature-gated
`media_image_reference` target. `PLUR1BUS_MEDIA_JPEG_REFERENCE` names the JSON
manifest produced once by `scripts/media/jpeg-reference.py`; it points to the
frozen encoded images and Pillow RGB references. Fixtures, generator, the 2-LSB
assertion and per-image cosine thresholds must not be changed to accommodate a
codec difference. Generated test media and model outputs are not vendored.

Remove this patch when the selected published decoder performs the same fused
rounding and passes these unchanged bounds. Do not silently enable the previous
HV SIMD implementation: its two rounds change the decoded pixels and vector space.
