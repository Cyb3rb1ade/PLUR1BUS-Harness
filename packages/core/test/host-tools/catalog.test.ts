import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CAPABILITIES, RISKS } from "../../src/policy/capabilities.ts";
import { HOST_TOOLS, getHostTool } from "../../src/host-tools/index.ts";

const NAME = /^[a-z][a-z0-9_.-]{0,63}$/;

describe("host-tools catalog", () => {
  it("registers the D106 families with capabilities from the D109 table", () => {
    const names = HOST_TOOLS.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "apps.list", "apps.open", "apps.running",
      "clipboard.read", "clipboard.write",
      "notify",
      "pkg.detect", "pkg.info", "pkg.install", "pkg.list-installed", "pkg.remove", "pkg.search",
      "proc.info", "proc.kill", "proc.list", "proc.wait",
      "sys.battery", "sys.disks", "sys.info", "sys.network",
    ]);
    for (const t of HOST_TOOLS) {
      assert.match(t.name, NAME, t.name);
      assert.ok(CAPABILITIES.has(t.capability), `${t.name} unknown capability ${t.capability}`);
      assert.ok((RISKS as readonly string[]).includes(t.riskClass), `${t.name} risk ${t.riskClass}`);
      assert.equal(t.schema.input.type, "object");
      assert.equal(t.schema.output.type, "object");
      assert.equal(typeof t.run, "function");
    }
  });

  it("maps read vs mutating families onto the D109 ids", () => {
    assert.equal(getHostTool("proc.list")!.capability, "sys.read");
    assert.equal(getHostTool("proc.info")!.capability, "sys.read");
    assert.equal(getHostTool("proc.wait")!.capability, "sys.read");
    assert.equal(getHostTool("proc.kill")!.capability, "proc.signal");
    assert.equal(getHostTool("proc.kill")!.riskClass, "medium");
    assert.equal(getHostTool("sys.info")!.capability, "sys.read");
    assert.equal(getHostTool("pkg.detect")!.capability, "sys.read");
    assert.equal(getHostTool("pkg.install")!.capability, "pkg.change");
    assert.equal(getHostTool("pkg.remove")!.capability, "pkg.change");
    assert.equal(getHostTool("pkg.install")!.riskClass, "high");
    assert.equal(getHostTool("apps.list")!.capability, "sys.read");
    assert.equal(getHostTool("apps.open")!.capability, "sys.read");
    assert.equal(getHostTool("clipboard.read")!.capability, "clipboard.read");
    assert.equal(getHostTool("clipboard.write")!.capability, "clipboard.read");
    assert.equal(getHostTool("notify")!.capability, "sys.read");
  });
});
