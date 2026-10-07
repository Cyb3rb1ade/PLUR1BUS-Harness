"""Generate red-1 tray badges using Glow tokens; requires cairosvg==2.8.2."""
from pathlib import Path
from struct import pack
import re
import cairosvg

ROOT = Path(__file__).resolve().parent
TOKENS = (ROOT / "../../ui/src/theme/tokens.css").resolve().read_text()
LIGHT, DARK = TOKENS.split(':root[data-theme="dark"]', 1)
BASE = (ROOT / "small.svg").read_text()
OUT = ROOT / "tray"
OUT.mkdir(exist_ok=True)

def token(block, name):
    return re.search(r"--" + name + r":\s*(#[0-9A-Fa-f]{6})", block).group(1)

for theme, block in [("light", LIGHT), ("dark", DARK)]:
    ink, red = token(block, "ink"), token(block, "wordmark-red")
    amber = token(DARK, "warn-ink")
    badges = {
        "running": "",
        "busy": f'<circle cx="790" cy="780" r="160" fill="none" stroke="{ink}" stroke-width="70"/>',
        "attention": f'<path d="M790 570 L1000 940 H580 Z" fill="{amber}"/><path d="M790 690 V805 M790 865 V885" stroke="{token(LIGHT, "ink")}" stroke-width="45"/>',
        "update": f'<circle cx="820" cy="800" r="155" fill="{red}" stroke="{ink}" stroke-width="40"/>',
    }
    for state, badge in badges.items():
        source = BASE.replace("#E5484D", red).replace("</svg>", badge + "</svg>")
        stem = f"{state}-{theme}"
        (OUT / (stem + ".svg")).write_text(source)
        frames = [(n, cairosvg.svg2png(bytestring=source.encode(), output_width=n, output_height=n)) for n in [16, 20, 24, 32, 40]]
        (OUT / (stem + ".png")).write_bytes(dict(frames)[32])
        offset = 6 + 16 * len(frames)
        entries = []
        for n, data in frames:
            entries.append(pack("<BBBBHHII", n, n, 0, 0, 1, 32, len(data), offset))
            offset += len(data)
        (OUT / (stem + ".ico")).write_bytes(pack("<HHH", 0, 1, len(frames)) + b"".join(entries) + b"".join(data for _, data in frames))
        symbolic = re.sub(r'#[0-9A-Fa-f]{6}', 'currentColor', source)
        (OUT / (stem + "-symbolic.svg")).write_text(symbolic)
        template = re.sub(r'#[0-9A-Fa-f]{6}', '#000000', source)
        (OUT / (stem + "-template.png")).write_bytes(cairosvg.svg2png(bytestring=template.encode(), output_width=32, output_height=32))
