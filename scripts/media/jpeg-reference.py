"""SPDX-License-Identifier: Apache-2.0
Owned, frozen synthetic fixtures and Pillow references; no network or goldens.
"""
import json
import hashlib
import math
import sys
from pathlib import Path
from PIL import Image

if Image.__version__ != "12.3.0":
    raise RuntimeError("media parity requires Pillow==12.3.0")
directory = Path(sys.argv[1])
directory.mkdir(parents=True, exist_ok=True)
reuse = sys.argv[2:] == ["--reuse"]
if sys.argv[2:] and not reuse:
    raise RuntimeError("only --reuse is supported")
width, height, budget = 320, 240, 140
rgb = bytes(v for y in range(height) for x in range(width)
            for v in (x % 256, y % 256, (x + y) % 256))
image = Image.frombytes("RGB", (width, height), rgb)
factor = math.sqrt(budget * 9 * 16 ** 2 / (width * height))
target = (math.floor(factor * width / 48) * 48,
          math.floor(factor * height / 48) * 48)
cases = []
# Freeze all variants before observing any metric. Refuse to overwrite a fixture.
for name, options in [
    ("jpeg-420", {"subsampling": 2, "progressive": False}),
    ("jpeg-444", {"subsampling": 0, "progressive": False}),
    ("jpeg-progressive-420", {"subsampling": 2, "progressive": True}),
    ("png-lossless", None),
]:
    jpeg = options is not None
    encoded = directory / (name + (".jpg" if jpeg else ".png"))
    if reuse and not encoded.is_file():
        raise RuntimeError("required frozen fixture missing: " + str(encoded))
    if not reuse and encoded.exists():
        raise RuntimeError("refusing to replace measured fixture: " + str(encoded))
    if not reuse and jpeg:
        image.save(encoded, format="JPEG", quality=85, **options)
    elif not reuse:
        image.save(encoded, format="PNG")
    decoded = Image.open(encoded).convert("RGB")
    raw = directory / (name + ".rgb")
    if reuse and raw.exists():
        if raw.read_bytes() != decoded.tobytes():
            raise RuntimeError("frozen Pillow decode reference changed: " + str(raw))
    else:
        raw.write_bytes(decoded.tobytes())
    same_pixels = directory / (name + "-decoded.png")
    if reuse and same_pixels.exists():
        if Image.open(same_pixels).convert("RGB").tobytes() != decoded.tobytes():
            raise RuntimeError("frozen same-pixel reference changed")
    else:
        decoded.save(same_pixels, format="PNG")
    resized = directory / (name + "-pil-resized.rgb")
    resized_rgb = decoded.resize(target, Image.Resampling.BICUBIC).tobytes()
    if reuse and resized.exists():
        if resized.read_bytes() != resized_rgb:
            raise RuntimeError("frozen Pillow resize reference changed")
    else:
        resized.write_bytes(resized_rgb)
    cases.append({"name": name, "jpeg": jpeg, "encoded": str(encoded),
                  "decoded": str(raw), "samePixels": str(same_pixels),
                  "resized": str(resized), "width": width, "height": height,
                  "targetWidth": target[0], "targetHeight": target[1], "budget": budget,
                  "encodedSha256": hashlib.sha256(encoded.read_bytes()).hexdigest()})
print(json.dumps({"pillow": Image.__version__, "cases": cases}))
