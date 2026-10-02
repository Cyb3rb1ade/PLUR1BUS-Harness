"""Regenerate Tauri icon files from the checked-in Lilita-derived SVG art.

Requires cairosvg==2.8.2. Outputs are deterministic for a fixed CairoSVG stack.
"""
from pathlib import Path
from struct import pack
import cairosvg

ROOT = Path(__file__).resolve().parent
MASTER = (ROOT / "master.svg").read_bytes()
SMALL = (ROOT / "small.svg").read_bytes()


def render(size: int) -> bytes:
    source = SMALL if size < 48 else MASTER
    return cairosvg.svg2png(bytestring=source, output_width=size, output_height=size)


def write_ico() -> None:
    sizes = [16, 20, 24, 32, 40, 48, 64, 256]
    frames = [(size, render(size)) for size in sizes]
    offset = 6 + len(frames) * 16
    chunks = [pack("<HHH", 0, 1, len(frames))]
    for size, data in frames:
        byte_size = 0 if size == 256 else size
        chunks.append(pack("<BBBBHHII", byte_size, byte_size, 0, 0, 1, 32, len(data), offset))
        offset += len(data)
    chunks.extend(data for _, data in frames)
    (ROOT / "icon.ico").write_bytes(b"".join(chunks))


def write_icns() -> None:
    # Standard 1x and retina PNG chunks, including the 16 and 32 px red-1 forms.
    chunks = []
    for kind, size in [("icp4", 16), ("icp5", 32), ("icp6", 64), ("ic07", 128), ("ic08", 256), ("ic09", 512), ("ic10", 1024), ("ic11", 32), ("ic12", 64), ("ic13", 256), ("ic14", 512)]:
        data = render(size)
        chunks.append(kind.encode("ascii") + pack(">I", len(data) + 8) + data)
    payload = b"".join(chunks)
    (ROOT / "icon.icns").write_bytes(b"icns" + pack(">I", len(payload) + 8) + payload)


if __name__ == "__main__":
    for name, size in [("32x32.png", 32), ("128x128.png", 128), ("128x128@2x.png", 256)]:
        (ROOT / name).write_bytes(render(size))
    write_ico()
    write_icns()
