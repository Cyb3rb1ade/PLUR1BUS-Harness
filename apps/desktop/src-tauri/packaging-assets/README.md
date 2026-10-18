# Packaging artwork fallback

These deterministic exports use the checked-in DskIcons-derived raster masters. They are specification fallbacks because the October 11 DskInstallerAssets canvas export is not available in this checkout. Replace exports at the same paths when the owner supplies them; do not change the visual identity.

`../scripts/generate-packaging-assets.py` (from `src-tauri`, use `../scripts/`) runs in an existing Pillow tool environment, without adding a repository dependency. Below 48 physical pixels the red `1` master is used; from 48 upward the plate/ring master is used. MSIX scales and target sizes, Linux hicolor/scalable/symbolic icons, RGB 24-bit NSIS bitmaps, and a 1320×800 HiDPI TIFF for the 660×400 DMG are included. DMG icon centers are 180,170 and 480,170.

Store listing box/poster art and genuine application screenshots remain release assets. This directory does not substitute fabricated screenshots for acceptance evidence.
