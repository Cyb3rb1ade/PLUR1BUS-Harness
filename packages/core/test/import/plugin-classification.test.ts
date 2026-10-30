// Mv2 A13 classifies declarations for display only; plugin names/configuration never imply bridge compatibility.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyForeignPlugin, discoverForeignPlugins } from "../../src/import/plugin-classification.ts";

describe("foreign plugin classification (Mv2 A13)", () => {
  it("marks only declared tools, commands, services and explicitly read-only hooks as bridge-possible", () => {
    const plugin = classifyForeignPlugin({ source: "openclaw", name: "example", profile: null,
      registeredParts: [{ kind: "tool" }, { kind: "command" }, { kind: "service" },
        { kind: "hook", mode: "read-only" }] });
    assert.equal(plugin.classification, "bridge-possible");
    assert.deepEqual(plugin.parts, ["command", "hook:read-only", "service", "tool"]);
  });

  for (const kind of ["memory", "channel", "provider", "context-engine"]) {
    it(`marks declared ${kind} integration nonportable even when tools are present`, () => {
      const plugin = classifyForeignPlugin({ source: "hermes", name: "innocent-name", profile: "work",
        manifest: { kind }, registeredParts: [{ kind: "tool" }] });
      assert.equal(plugin.classification, "nonportable");
    });
  }

  it("refuses rewriting hooks and leaves incomplete hook or unknown declarations unknown", () => {
    for (const [part, expected] of [
      [{ kind: "hook", mode: "rewriting" }, "nonportable"],
      [{ kind: "hook" }, "unknown"],
      [{ kind: "future-capability" }, "unknown"],
    ] as const) {
      assert.equal(classifyForeignPlugin({ source: "openclaw", name: "example", profile: null,
        registeredParts: [part] }).classification, expected);
    }
  });

  it("lists configured plugin identifiers as unknown and discards unverified configuration claims", () => {
    const plugins = discoverForeignPlugins({ source: "openclaw", profile: null, config: { plugins: { entries: {
      "memory-looking-name": { enabled: true, kind: "tool", manifest: { kind: "tool" },
        registeredParts: [{ kind: "tool" }], description: "DO_NOT_COPY_PLUGIN_METADATA" },
    } } } });
    assert.equal(plugins.length, 1);
    assert.equal(plugins[0]!.classification, "unknown");
    assert.equal(JSON.stringify(plugins).includes("DO_NOT_COPY_PLUGIN_METADATA"), false);
  });
});
