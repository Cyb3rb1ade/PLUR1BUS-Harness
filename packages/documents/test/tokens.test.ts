import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BODY_CONTRAST,
  LARGE_TEXT_CONTRAST,
  NEUTRAL_KIT,
  NEUTRAL_REQUIREMENTS,
  contrast,
  parseHex,
  relativeLuminance,
  requirementRatio,
} from "../src/tokens.ts";

describe("colour tokens", () => {
  it("parses #rgb, #rrggbb and #rrggbbaa", () => {
    assert.deepEqual(parseHex("#fff"), { r: 255, g: 255, b: 255 });
    assert.deepEqual(parseHex("#000000"), { r: 0, g: 0, b: 0 });
    assert.deepEqual(parseHex("#2563eb"), { r: 0x25, g: 0x63, b: 0xeb });
  });

  it("computes the WCAG reference luminance for black and white", () => {
    assert.equal(relativeLuminance(parseHex("#000000")), 0);
    assert.ok(Math.abs(relativeLuminance(parseHex("#ffffff")) - 1) < 1e-9);
  });

  it("gives black-on-white the canonical 21:1 ratio", () => {
    assert.ok(Math.abs(contrast("#000000", "#ffffff") - 21) < 0.01);
  });

  it("computes the contrast of every declared neutral-kit pair and clears its threshold", () => {
    for (const req of NEUTRAL_REQUIREMENTS) {
      const ratio = requirementRatio(NEUTRAL_KIT, req);
      assert.ok(
        ratio >= req.minimum,
        `${req.label}: ${req.foreground} on ${req.background} is ${ratio.toFixed(2)}:1, below ${req.minimum}:1`,
      );
    }
  });

  it("keeps the body and large-text thresholds at the WCAG AA values", () => {
    assert.equal(BODY_CONTRAST, 4.5);
    assert.equal(LARGE_TEXT_CONTRAST, 3.0);
  });

  it("refuses a non-hex colour", () => {
    assert.throws(() => parseHex("blue"));
  });
});
