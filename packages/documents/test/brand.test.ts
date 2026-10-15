import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveBrandKit, sanitizeSvg, validateBrandKit, validateLogo, type BrandKit } from "../src/brand.ts";
import { NEUTRAL_KIT, contrast } from "../src/tokens.ts";
import { chartPalette, mermaidDefinition, vegaLiteSpec } from "../src/charts.ts";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const SVG_SCRIPT = `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="1" height="1" onload="x()"/></svg>`;

describe("brand kit", () => {
  it("falls back to the neutral kit when no brand is configured", () => {
    assert.deepEqual(resolveBrandKit(undefined), NEUTRAL_KIT);
  });

  it("overlays the brand colours on the neutral kit", () => {
    const brand: BrandKit = { name: "acme", colors: { accent: "#7c3aed", text: "#111111" } };
    const kit = resolveBrandKit(brand);
    assert.equal(kit.accent, "#7c3aed");
    assert.equal(kit.text, "#111111");
    assert.equal(kit.paper, NEUTRAL_KIT.paper); // untouched tokens stay neutral
  });

  it("warns and suggests when a brand colour misses the AA floor", () => {
    const brand: BrandKit = { name: "low", colors: { accent: "#eeeeee" } }; // near-white accent on white paper
    const result = validateBrandKit(brand);
    const warn = result.issues.find((i) => i.field === "accent on paper" && i.severity === "warn");
    assert.ok(warn, "expected a contrast warning");
    assert.ok(warn!.suggestion && contrast(warn!.suggestion, NEUTRAL_KIT.paper) >= 3, "suggestion clears the floor");
  });

  it("accepts a PNG/JPEG logo (magic bytes) and rejects other bytes", () => {
    assert.equal(validateLogo(PNG), null);
    assert.equal(validateLogo(JPEG), null);
    assert.ok(validateLogo(Uint8Array.from([0x00, 0x01, 0x02])) !== null);
  });

  it("sanitises an SVG logo to a script-free subset or rejects it", () => {
    const clean = sanitizeSvg(`<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>`);
    assert.ok(clean && !/script|onload/i.test(clean));
    const dangerous = sanitizeSvg(SVG_SCRIPT);
    assert.ok(dangerous === null || (!/<\s*script/i.test(dangerous) && !/onload/i.test(dangerous)));
  });
});

describe("charts and diagrams use the kit palette", () => {
  const kit = { ...NEUTRAL_KIT, accent: "#7c3aed", text: "#111111", muted: "#4b5563" };

  it("a Vega-Lite spec references the kit colours and never the library defaults", () => {
    const spec = vegaLiteSpec({ mark: "bar", values: [{ a: "x", b: 3 }], x: "a", y: "b", kit });
    const json = JSON.stringify(spec);
    for (const c of chartPalette(kit)) assert.ok(json.includes(c), `spec must contain ${c}`);
    assert.ok(!json.includes("#4c78a8"), "no Vega-Lite default blue");
  });

  it("a Mermaid diagram bakes the kit colours into the theme variables", () => {
    const def = mermaidDefinition({ type: "flowchart", body: "A --> B", kit });
    assert.ok(def.includes('"primaryBorderColor":"#7c3aed"'));
    assert.ok(def.includes('"primaryTextColor":"#111111"'));
    assert.ok(def.includes('"fontFamily":"Inter"'));
  });
});
