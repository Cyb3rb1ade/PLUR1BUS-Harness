# Desktop app icons

The checked-in artwork is a specification-derived fallback because the canvas PNG exports are inaccessible. It is not a pixel match to the canvas. The `P`, `1`, and `B` paths come from the bundled Lilita One Regular font (Google Fonts revision `b9f4a43f3684f93a02b88133755deb51508c2fcf`, SHA-256 `f5b641c45c69d772ee4eda687bc9fda411d5cad6b0b45371491da4580cbc8d59`, OFL in `../../ui/assets/fonts/lilita/OFL.txt`).

`small.svg` and `glyph.svg` draw only the red `1` on transparency. `master.svg` draws the light `P` and `B`, red `1`, dark plate, and teal/magenta duo ring. `generate.py` selects the red `1` for every raster below 48 px, including the 40 px ICO frame, and `P1B` from 48 px upward. It generates all Tauri PNG, ICO and ICNS frames; no system font is consulted.

With Python and CairoSVG 2.8.2 available, run `python3 generate.py` in this directory. Keep the generated files and source SVGs together. The threshold and frame sizes are checked by the UI icon test.
