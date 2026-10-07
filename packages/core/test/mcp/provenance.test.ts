import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { wrapToolResult } from "../../src/mcp/provenance.ts";
import { createRedactor } from "../../src/mcp/redact.ts";

const base = { server: "docs", tool: "echo", caller: { agentId: "bernd", principal: "user:v1:abc" }, trust: "untrusted" as const, redactor: createRedactor(), maxBytes: 1024 };

describe("mcp provenance envelope (D19)", () => {
  it("attaches origin, hops and transformedBy to every result", () => {
    const r = wrapToolResult({ content: [{ type: "text", text: "hi" }] }, base);
    assert.deepEqual(r.provenance, { origin: { system: "mcp:docs", agent: null, principal: "user:v1:abc", trust: "untrusted" }, hops: 1, transformedBy: [] });
    assert.equal(r.isError, false);
    assert.deepEqual(r.content, [{ type: "text", text: "hi" }]);
  });
  it("keeps a tool-reported error a result, not an exception", () => {
    assert.equal(wrapToolResult({ content: [], isError: true }, base).isError, true);
  });
  it("truncates over the cap and says so, on a character boundary", () => {
    const r = wrapToolResult({ content: [{ type: "text", text: "é".repeat(2000) }] }, base);
    const text = (r.content[0] as { text: string }).text;
    assert.ok(Buffer.byteLength(text) <= 1024 && !text.includes("\uFFFD"));
    assert.deepEqual(r.provenance.transformedBy, ["truncate"]);
  });
  it("redacts secrets from text, resources and structured content and says so", () => {
    const redactor = createRedactor(["s3cr3t-value"]);
    const r = wrapToolResult({ content: [{ type: "text", text: "key=s3cr3t-value" }, { type: "resource", resource: { uri: "x://y", text: "s3cr3t-value" } }], structuredContent: { k: "s3cr3t-value" } }, { ...base, redactor });
    assert.ok(!JSON.stringify(r).includes("s3cr3t-value"));
    assert.deepEqual(r.provenance.transformedBy, ["redact"]);
  });
  it("drops an oversized binary block with a placeholder instead of passing it", () => {
    const r = wrapToolResult({ content: [{ type: "image", data: "A".repeat(5000), mimeType: "image/png" }] }, base);
    assert.equal((r.content[0] as { type: string }).type, "text");
    assert.deepEqual(r.provenance.transformedBy, ["truncate"]);
  });
  it("carries operator-vetted only when the definition said so", () => {
    assert.equal(wrapToolResult({ content: [] }, { ...base, trust: "operator-vetted" }).provenance.origin.trust, "operator-vetted");
  });
});

it("modern structuredContent retains scalars, arrays and null while redacting every content field", () => {
  for (const structuredContent of [null, 42, false, ["fake-secret-value"], "fake-secret-value"]) {
    const result = wrapToolResult({ content: [{ type: "resource_link", name: "fake-secret-value", uri: "test://fake-secret-value" }], structuredContent },
      { server: "fixture", tool: "echo", caller: { agentId: "test", principal: "test" }, trust: "untrusted", redactor: createRedactor(["fake-secret-value"]), maxBytes: 4096 });
    assert.ok(Object.hasOwn(result, "structuredContent"));
    assert.ok(!JSON.stringify(result).includes("fake-secret-value"));
  }
});
