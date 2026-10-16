import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderTypst, typstTemplate } from "../src/typst.ts";
import { NEUTRAL_KIT } from "../src/tokens.ts";

describe("typst second engine", () => {
  it("builds a report template with the kit tokens", () => {
    const doc = typstTemplate({ title: "Report", subtitle: "Sub", author: "A", body: "Body text." });
    assert.ok(doc.includes("Report"));
    assert.ok(doc.includes(`rgb("#2563eb")`)); // accent from the neutral kit
    assert.ok(doc.includes("Source Serif 4"));
  });

  it("reports unavailable with a clear reason when the binary is absent", async () => {
    const result = await renderTypst("= x", { bin: "/nonexistent/typst" }, new AbortController().signal);
    assert.equal(result.available, false);
    assert.ok(result.reason && result.reason.length > 0);
    assert.equal(result.pdf, undefined);
  });

  it("escapes Typst markup so the title is data, never directives", () => {
    const doc = typstTemplate({ title: "#pagebreak", body: "" });
    assert.ok(doc.includes("\\#pagebreak"), "a leading # is escaped");
  });
});
