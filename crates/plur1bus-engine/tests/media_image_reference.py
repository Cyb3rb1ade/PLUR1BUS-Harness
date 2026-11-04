"""Generate local synthetic Pillow references; no downloaded images or recorded goldens."""
import json
import sys
from PIL import Image

if Image.__version__ != "12.3.0":
    raise RuntimeError("MM-1 reference requires Pillow==12.3.0")

request = json.load(sys.stdin)
width, height = request["source"]
pattern = request["pattern"]
data = bytearray()
for y in range(height):
    for x in range(width):
        if pattern == "checker":
            value = 255 if (x + y) % 2 else 0
            data.extend((value, 255 - value, value))
        elif pattern == "impulse":
            data.extend((255 if x == width // 2 and y == height // 2 else 0,) * 3)
        else:
            data.extend(((x * 37 + y * 17) % 256, (x * 13 + y * 73) % 256,
                         (x * 197 + y * 29 + 11) % 256))
image = Image.frombytes("RGB", (width, height), bytes(data))
resized = image.resize(tuple(request["target"]), Image.Resampling.BICUBIC)
json.dump({"pillow": Image.__version__, "source": data.hex(), "resized": resized.tobytes().hex()}, sys.stdout)
