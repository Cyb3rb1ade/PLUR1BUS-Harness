import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalOrigin, isOriginAllowed, pageToolsToMcp, parseWebMcpToolName } from "../src/index.ts";

describe("pageToolsToMcp", () => {
  it("names tools webmcp:<origin>/<tool> and carries schema and readOnlyHint", () => {
    const schema = { type: "object", properties: { text: { type: "string" } }, required: ["text"] };
    const out = pageToolsToMcp("https://Todo.Example.com:443/", [
      { name: "add-todo", description: "Add", inputSchema: schema, annotations: { readOnlyHint: false, consequentialHint: true } },
      { name: "list.todos", title: "List", description: "List", annotations: { readOnlyHint: true } },
    ]);
    assert.equal(out.length, 2);
    assert.equal(out[0]!.name, "webmcp:https://todo.example.com/add-todo");
    assert.deepEqual(out[0]!.inputSchema, schema);
    assert.notEqual(out[0]!.inputSchema, schema, "schema is copied, not shared with the page");
    assert.deepEqual(out[0]!.annotations, { readOnlyHint: false, untrustedContentHint: true, consequentialHint: true });
    assert.equal(out[1]!.name, "webmcp:https://todo.example.com/list.todos");
    assert.equal(out[1]!.title, "List");
    assert.equal(out[1]!.annotations.readOnlyHint, true);
    assert.deepEqual(out[1]!.inputSchema, { type: "object", properties: {} });
    assert.equal(out[0]!.origin, "https://todo.example.com");
    assert.equal(out[0]!.pageToolName, "add-todo");
  });

  it("sanitises names, dedupes collisions, skips nameless entries, defaults readOnlyHint to false", () => {
    const out = pageToolsToMcp("http://localhost:3000", [
      { name: "do thing/../x" },
      { name: "do_thing_.._x" },
      { name: "" },
      { name: 42 as any },
      { name: "ü".repeat(200) },
    ]);
    assert.deepEqual(out.map((t) => t.name), ["webmcp:http://localhost:3000/do_thing_.._x", "webmcp:http://localhost:3000/do_thing_.._x_2", `webmcp:http://localhost:3000/${"_".repeat(128)}`]);
    assert.equal(out[0]!.annotations.readOnlyHint, false);
    assert.equal(out[0]!.pageToolName, "do thing/../x");
    for (const t of out) assert.ok(parseWebMcpToolName(t.name));
  });

  it("returns nothing for non-https (non-localhost) or malformed origins", () => {
    for (const o of ["http://example.com", "ftp://example.com", "https://example.com/path", "javascript:alert(1)", "null", "", "https://user:pw@example.com"]) {
      assert.deepEqual(pageToolsToMcp(o, [{ name: "a" }]), [], o);
    }
  });

  it("drops non-JSON schema content", () => {
    const cyclic: any = { type: "object" };
    cyclic.self = cyclic;
    assert.deepEqual(pageToolsToMcp("https://a.example", [{ name: "a", inputSchema: cyclic }])[0]!.inputSchema, { type: "object", properties: {} });
  });
});

describe("isOriginAllowed", () => {
  it("matches exact origins, canonicalised", () => {
    assert.ok(isOriginAllowed("https://app.example.com", ["https://app.example.com"]));
    assert.ok(isOriginAllowed("https://APP.example.com:443", ["https://app.example.com/"]));
    assert.ok(!isOriginAllowed("https://app.example.com:8443", ["https://app.example.com"]));
    assert.ok(!isOriginAllowed("https://evil.com", ["https://app.example.com"]));
    assert.ok(!isOriginAllowed("https://app.example.com.evil.com", ["https://app.example.com"]));
  });

  it("https only, except localhost", () => {
    assert.ok(!isOriginAllowed("http://app.example.com", ["http://app.example.com", "https://app.example.com"]));
    assert.ok(isOriginAllowed("http://localhost:3000", ["http://localhost:3000"]));
    assert.ok(isOriginAllowed("http://127.0.0.1:8080", ["http://127.0.0.1:8080"]));
    assert.ok(isOriginAllowed("http://[::1]:5173", ["http://[::1]:5173"]));
    assert.ok(isOriginAllowed("http://gui.localhost", ["http://gui.localhost"]));
    assert.ok(!isOriginAllowed("http://localhost:3001", ["http://localhost:3000"]));
    assert.equal(canonicalOrigin("http://10.0.0.1"), undefined);
  });

  it("subdomain rule *.example.com matches strict https subdomains on the default port only", () => {
    const allow = ["*.example.com"];
    assert.ok(isOriginAllowed("https://a.example.com", allow));
    assert.ok(isOriginAllowed("https://a.b.example.com", allow));
    assert.ok(isOriginAllowed("https://a.example.com", ["https://*.example.com"]));
    assert.ok(!isOriginAllowed("https://example.com", allow));
    assert.ok(!isOriginAllowed("https://badexample.com", allow));
    assert.ok(!isOriginAllowed("https://a.example.com:8443", allow));
    assert.ok(!isOriginAllowed("http://a.example.com", allow));
    assert.ok(!isOriginAllowed("http://a.example.com", ["http://*.example.com"]));
  });

  it("ignores every other wildcard form", () => {
    for (const rule of ["*", "*.com", "https://*", "https://a.*.com", "*example.com", "https://ex*.com", "**.example.com"]) {
      assert.ok(!isOriginAllowed("https://a.example.com", [rule]), rule);
    }
    assert.ok(!isOriginAllowed("https://a.example.com", []));
  });
});
