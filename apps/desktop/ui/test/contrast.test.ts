import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

type RGB = [number, number, number];
export function composite(value: string, base: RGB = [255, 255, 255]): RGB {
  if (value.startsWith("#")) return [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16)) as RGB;
  const [r, g, b, alpha = 1] = value.match(/[\d.]+/g)!.map(Number);
  return [r!, g!, b!].map((channel, i) => channel * alpha + base[i]! * (1 - alpha)) as RGB;
}
export function contrast(a: RGB, b: RGB): number {
  const luminance = (rgb: RGB) => rgb.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i]!, 0);
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}

test("every semantic ink/background token pair meets 4.5:1 in both themes", () => {
  const css = readFileSync(new URL("../src/theme/tokens.css", import.meta.url), "utf8");
  for (const [theme, block] of [...css.matchAll(/\{([^}]+)\}/g)].map((match, i) => [i === 0 ? "light" : "dark", match[1]!] as const)) {
    const tokens = Object.fromEntries([...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(match => [match[1], match[2]]));
    const color = (name: string, base?: RGB) => composite(tokens[name]!, base);
    const check = (ink: string, bg: RGB, label: string) => assert.ok(contrast(color(ink), bg) >= 4.5, `${theme} ${ink}/${label}: ${contrast(color(ink), bg).toFixed(2)}:1`);
    for (const bg of ["page", "window", "surface", "chip", "track", "changed", "glass", "dialog-footer"]) {
      for (const ink of ["ink", "ink-2", "ink-3", "muted"]) check(ink, color(bg, color("page")), bg);
    }
    for (const semantic of ["primary", "ok", "warn", "error", "info"]) {
      for (const base of ["page", "surface"]) check(`${semantic}-ink`, color(`${semantic}-bg`, color(base)), `${semantic}-bg over ${base}`);
    }
    // A radial gradient interpolates between these extrema; check every 1% step too.
    const extrema = [color("surface"), color("hero-glow-teal", color("surface")), color("hero-glow-magenta", color("surface"))];
    for (const a of extrema) for (const b of extrema) for (let i = 0; i <= 100; i++) {
      const bg = a.map((v, channel) => v + (b[channel]! - v) * i / 100) as RGB;
      for (const ink of ["ink", "ink-2", "ink-3"]) check(ink, bg, "hero gradient");
      check("ok-ink", color("ok-bg", bg), "ok-bg over hero gradient");
    }
  }
});
