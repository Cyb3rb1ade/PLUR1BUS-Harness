// Route parsing of the hash router: encoding of names, traversal, malformed escapes and oversized paths (d03 audit).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { decodeSegment, resolve, routePath, subSegments } from "../src/router.ts";

describe("router: names with reserved characters", () => {
  const NAMES = ["plain", "a b", "what?", "tag#1", "100%", "a/b", "ü-日本語-😀", "%2F", "a%20b", "..x", "x.."];

  test("routePath encodes every segment, so the name survives resolve and subSegments", () => {
    for (const name of NAMES) {
      const to = routePath("skills", name);
      assert.ok(!/[?#]/.test(to), `${name}: ${to} must not contain ? or #`);
      assert.equal(to.split("/").length, 3, `${name}: ${to} must stay two segments`);
      const r = resolve(to);
      assert.equal(r.kind, "page", name);
      if (r.kind === "page") assert.deepEqual(subSegments(r.sub), [name], name);
    }
  });

  test("sub stays the encoded remainder (pages decode it themselves)", () => {
    const r = resolve(routePath("chat", "a/b"));
    assert.equal(r.kind === "page" ? r.sub : undefined, "a%2Fb");
  });

  test("the first segment may be percent-encoded too", () => {
    assert.equal(resolve("/%63hat").kind, "page");
    assert.equal(resolve("/%63hat/x%20y").kind, "page");
  });

  test("decodeSegment keeps a malformed escape as it is instead of throwing", () => {
    assert.equal(decodeSegment("100%"), "100%");
    assert.equal(decodeSegment("a%20b"), "a b");
    assert.equal(decodeSegment("%E0%A4%A"), "%E0%A4%A");
  });
});

describe("router: hostile paths are not-found", () => {
  test("dot segments, plain or encoded, never reach a page", () => {
    for (const p of ["/chat/..", "/chat/../settings", "/chat/%2e%2e", "/chat/%2E%2E/x", "/chat/./x", "/chat/%2e", "/../chat", "/%2e%2e/chat"])
      assert.equal(resolve(p).kind, "not-found", p);
  });

  test("a malformed escape in any segment is not-found (pages decode sub and would throw)", () => {
    for (const p of ["/chat/%", "/chat/%E0%A4%A", "/chat/ok/%zz", "/%/x"]) assert.equal(resolve(p).kind, "not-found", p);
  });

  test("a huge path is not-found and the carried path is bounded", () => {
    const r = resolve(`/chat/${"a".repeat(200_000)}`);
    assert.equal(r.kind, "not-found");
    if (r.kind === "not-found") assert.ok(r.path.length <= 2048);
  });

  test("unicode paths resolve like ascii ones", () => {
    assert.equal(resolve("/chat/日本語").kind, "page");
    assert.equal(resolve("/日本語").kind, "not-found");
  });

  test("special routes resolve to their own kinds", () => {
    assert.equal(resolve("/consent").kind, "consent");
    assert.equal(resolve("/login").kind, "login");
    assert.equal(resolve("/join").kind, "join");
  });
});
