import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { HOME_EXTERNAL_LINKS, getActiveExternalLinks } from "../src/pages/home/links.ts";

describe("home links configuration", () => {
  test("empty placeholder links (contact, donate) are filtered out at runtime", () => {
    const all = HOME_EXTERNAL_LINKS;
    const active = getActiveExternalLinks();
    assert.ok(all.some((l) => l.id === "contact" && l.url === ""));
    assert.ok(all.some((l) => l.id === "donate" && l.url === ""));
    assert.ok(!active.some((l) => l.id === "contact"));
    assert.ok(!active.some((l) => l.id === "donate"));
    for (const link of active) {
      assert.ok(link.url.length > 0, `link ${link.id} must have non-empty url`);
    }
  });

  test("only known repository and project URLs are present", () => {
    const active = getActiveExternalLinks();
    const external = active.filter((l) => /^https?:\/\//.test(l.url));
    const allowed = new Set([
      "https://github.com/Cyb3rb1ade/PLUR1BUS-Harness",
      "https://github.com/Cyb3rb1ade/PLUR1BUS-Host-Addons",
      ["https://github.com/Cyb3rb1ade/", "open", "claw", "-plur1bus-memory"].join(""),
      "https://plur1bus.app",
    ]);
    for (const l of external) {
      assert.ok(allowed.has(l.url), `unexpected external URL: ${l.url}`);
    }
  });
});
