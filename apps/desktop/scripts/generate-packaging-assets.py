"""Packaging fallback exports from the checked-in DskIcons-derived raster masters.

Run with an existing Pillow tool environment; this does not add a package dependency.
Canvas exports take precedence when supplied by the owner. No listing screenshots are fabricated.
"""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1] / 'src-tauri'
ICONS = ROOT / 'icons'
OUT = ROOT / 'packaging-assets'
OUT.mkdir(exist_ok=True)
small = Image.open(ICONS / '32x32.png').convert('RGBA')
master = Image.open(ICONS / '128x128@2x.png').convert('RGBA')
def icon(size):
    return (small if size < 48 else master).resize((size, size), Image.Resampling.LANCZOS)
def png(name, size):
    p = OUT / name
    p.parent.mkdir(parents=True, exist_ok=True)
    icon(size).save(p)
for scale in [100, 150, 200, 400]:
    for base, name in [(44,'Square44x44Logo'), (150,'Square150x150Logo'), (50,'StoreLogo')]:
        png(f'msix/{name}.scale-{scale}.png', base * scale // 100)
for size,name in [(44,'Square44x44Logo'),(150,'Square150x150Logo'),(50,'StoreLogo')]:
    png(f'msix/{name}.png',size)
(OUT/'msix/icon.ico').write_bytes((ICONS/'icon.ico').read_bytes())
for size in [16,24,32,48,256]:
    png(f'msix/Square44x44Logo.targetsize-{size}.png', size)
for size in [16,24,32,48,64,128,256,512]:
    png(f'hicolor/{size}x{size}/apps/app.plur1bus.desktop.png', size)
p=(OUT/'hicolor/scalable/apps');p.mkdir(parents=True,exist_ok=True)
(p/'app.plur1bus.desktop.svg').write_bytes((ICONS/'master.svg').read_bytes())
p=(OUT/'hicolor/symbolic/apps');p.mkdir(parents=True,exist_ok=True)
(p/'app.plur1bus.desktop-symbolic.svg').write_bytes((ICONS/'tray/running-dark-symbolic.svg').read_bytes())
# Neutral specification fallback; supplied canvas exports may replace these same paths.
for name, size in [('nsis-sidebar.bmp',(164,314)), ('nsis-header.bmp',(150,57))]:
    bg=Image.new('RGB',size,'#17191d')
    mark=icon(96 if size[1]>100 else 40)
    bg.paste(mark,((size[0]-mark.width)//2,24 if size[1]>100 else 8),mark)
    bg.save(OUT/name)
bg=Image.new('RGB',(1320,800),'#f5f5f7')
draw=ImageDraw.Draw(bg)
draw.line([(530,340),(730,340)],fill='#737780',width=8)
draw.polygon([(730,340),(700,320),(700,360)],fill='#737780')
bg.save(OUT/'dmg-background.tiff',dpi=(144,144),compression='tiff_lzw')
