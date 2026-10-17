import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkFonts, checkImages, checkInlineContrast, checkLinks } from "../src/checks.ts";

describe("automatic checks (static, seeded defects)", () => {
  it("finds a broken link: a fragment to a missing target and a javascript: target", () => {
    const findings = checkLinks(`<a href="#absent">x</a> <a href="javascript:alert(1)">y</a>`);
    assert.ok(findings.some((f) => f.check === "links" && f.severity === "warn" && f.message.includes("#absent")));
    assert.ok(findings.some((f) => f.check === "links" && f.severity === "error" && f.message.includes("javascript:")));
  });

  it("finds an image below 150 dpi at print size", () => {
    const findings = checkImages(`<img src="pixel.png" width="192" height="192" data-natural-width="100">`);
    assert.ok(findings.some((f) => f.check === "images" && f.severity === "error" && /below 150/.test(f.message)));
  });

  it("finds a font family that is used but not embedded and has no fallback", () => {
    const findings = checkFonts(`<style>p { font-family: "NotAShippedFont" }</style>`);
    assert.ok(findings.some((f) => f.check === "fonts" && f.severity === "error" && f.message.includes("NotAShippedFont")));
  });

  it("finds an inline low-contrast colour pair (seeded contrast defect)", () => {
    const findings = checkInlineContrast(`<p style="color:#eeeeee;background:#ffffff">low</p>`);
    assert.ok(findings.some((f) => f.check === "contrast" && f.severity === "error" && /below 4.5:1/.test(f.message)));
  });
});
