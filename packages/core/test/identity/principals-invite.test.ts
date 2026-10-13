// identity principals.ts (exact-byte opaque ids) and invite-token.ts (one-time link tokens): the pure helpers.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { deriveUserPrincipal, isUserPrincipal, USER_PRINCIPAL } from "../../src/identity/principals.ts";
import { hashInviteToken, INVITE_CODE_MAX_MINUTES, INVITE_TTL_DEFAULT_MINUTES, INVITE_TTL_MAX_MINUTES, inviteLink, isInviteTokenShape, mintInviteToken, parseOrigin } from "../../src/identity/invite-token.ts";
import { DEFAULT_CODE_TTL_MS } from "../../src/identity/service.ts";
import { IdentityError } from "../../src/identity/store.ts";
import { mulberry32 } from "./helpers.ts";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

describe("identity principals", () => {
  it("v2 is 'user:v2:' plus the SHA-256 of the exact UTF-8 bytes of the id (derived independently)", () => {
    for (const id of ["a", "01890000-0000-7000-8000-000000000000", "café", "\u{1F600}", "x".repeat(128)]) assert.equal(deriveUserPrincipal(id), `user:v2:${sha(id)}`, id);
  });

  it("128 characters is the longest id; empty, 129, controls (including DEL) and non-strings are refused as invalid-params", () => {
    assert.ok(deriveUserPrincipal("y".repeat(128)));
    for (const bad of ["", "y".repeat(129), "a\u0000b", "a\nb", "a\tb", "a\u001fb", "a\u007fb", 5, null, undefined, {}, ["a"]]) {
      assert.throws(() => deriveUserPrincipal(bad as never), (e: unknown) => e instanceof IdentityError && e.code === "invalid-params", JSON.stringify(bad));
    }
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert: the length limit counts UTF-16 units, so a 65-character id of astral symbols (130 units) is refused", () => {
    assert.throws(() => deriveUserPrincipal("\u{1F600}".repeat(65)), (e: unknown) => e instanceof IdentityError && e.code === "invalid-params");
    assert.ok(deriveUserPrincipal("\u{1F600}".repeat(64)));
  });

  it("ids are never normalized: case, surrounding space, NFC/NFD and look-alike letters all give different principals", () => {
    const ids = ["Alice", "alice", " alice", "alice ", "café", "café", "аlice", "alice​"];
    assert.equal(new Set(ids.map(deriveUserPrincipal)).size, ids.length);
  });

  it("isUserPrincipal accepts exactly user:v1|v2: and 64 lower-case hex digits", () => {
    const h = "a".repeat(64);
    assert.equal(isUserPrincipal(`user:v1:${h}`), true); assert.equal(isUserPrincipal(`user:v2:${h}`), true);
    for (const bad of [`user:v3:${h}`, `user:v2:${h.slice(1)}`, `user:v2:${h}a`, `user:v2:${"A".repeat(64)}`, `user:v2:${h}\n`, `\nuser:v2:${h}`, `User:v2:${h}`, `user:v2:${"g".repeat(64)}`, "", 5, null, undefined, {}]) assert.equal(isUserPrincipal(bad), false, String(bad));
    assert.equal(USER_PRINCIPAL.test(`user:v2:${h}`), true);
  });
});

describe("identity invite tokens", () => {
  it("a minted token is 43 base64url characters (256 bits) and 300 of them are distinct", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 300; i++) { const t = mintInviteToken(); assert.match(t, /^[A-Za-z0-9_-]{43}$/); assert.equal(isInviteTokenShape(t), true); seen.add(t); }
    assert.equal(seen.size, 300);
  });

  it("shape check: only 43 url-safe characters; padding, a different length, other alphabets and non-strings fail", () => {
    const t = "A".repeat(43);
    assert.equal(isInviteTokenShape(t), true); assert.equal(isInviteTokenShape("-_".repeat(21) + "a"), true);
    for (const bad of [t.slice(1), t + "A", t + "=", "+".repeat(43), "/".repeat(43), "A".repeat(42) + " ", "A".repeat(42) + "\n", "é".repeat(43), "", 5, null, undefined]) assert.equal(isInviteTokenShape(bad), false, String(bad));
  });

  it("the stored hash is SHA-256 over a version tag, a NUL and the token; it is stable and never equals the token", () => {
    const t = "B".repeat(43);
    assert.equal(hashInviteToken(t), sha(`plur1bus-invite-v1\u0000${t}`));
    assert.equal(hashInviteToken(t), hashInviteToken(t)); assert.notEqual(hashInviteToken(t), hashInviteToken("C".repeat(43)));
    assert.equal(hashInviteToken(t).includes(t), false);
  });

  it("the link carries the token in the fragment, which a browser never sends to the server", () => {
    const t = mintInviteToken(); const link = inviteLink("https://harness.example.org", t);
    assert.equal(link, `https://harness.example.org/#/invite/${t}`);
    const u = new URL(link); assert.equal(u.search, ""); assert.equal(u.pathname, "/"); assert.equal(u.hash, `#/invite/${t}`);
  });

  it("the documented lifetimes: 60 minutes by default, 30 days at most for a link, 60 minutes for the code riding along (the identity service's own ceiling)", () => {
    assert.equal(INVITE_TTL_DEFAULT_MINUTES, 60); assert.equal(INVITE_TTL_MAX_MINUTES, 30 * 24 * 60); assert.equal(INVITE_CODE_MAX_MINUTES * 60_000, DEFAULT_CODE_TTL_MS);
  });
});

describe("identity invite origins", () => {
  it("a web origin is accepted as written, with or without one trailing slash, with a port", () => {
    assert.equal(parseOrigin("https://harness.example.org"), "https://harness.example.org");
    assert.equal(parseOrigin("https://harness.example.org/"), "https://harness.example.org");
    assert.equal(parseOrigin("http://localhost:8080"), "http://localhost:8080");
    assert.equal(parseOrigin("http://127.0.0.1:3000/"), "http://127.0.0.1:3000");
    assert.equal(parseOrigin("http://[::1]:3000"), "http://[::1]:3000");
  });

  it("anything with userinfo, path, query, fragment, another scheme, or a lookalike host is refused", () => {
    const bad = ["https://user@harness.example.org", "https://user:pw@harness.example.org", "https://harness.example.org/app", "https://harness.example.org//", "https://harness.example.org?x=1", "https://harness.example.org/?x=1", "https://harness.example.org#frag", "https://harness.example.org/#/x",
      "ftp://harness.example.org", "javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "//harness.example.org", "harness.example.org", "", " https://harness.example.org", "https://harness.example.org ", "https://harness.example.org\n"];
    for (const raw of bad) assert.equal(parseOrigin(raw), null, JSON.stringify(raw));
    for (const raw of [5, null, undefined, {}, []]) assert.equal(parseOrigin(raw), null);
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert: only the canonical spelling is accepted, so an upper-case host, an explicit default port or an IDN written in Unicode is refused rather than rewritten", () => {
    for (const raw of ["HTTPS://harness.example.org", "https://Harness.Example.org", "https://harness.example.org:443", "http://harness.example.org:80", "https://münchen.example.org"]) assert.equal(parseOrigin(raw), null, raw);
  });

  it("a very long value is refused (256 characters at most)", () => {
    const ok = `https://${"a".repeat(50)}.org`;
    assert.equal(parseOrigin(ok), ok);
    assert.equal(parseOrigin(`https://${"a".repeat(260)}.org`), null);
  });

  it("seeded noise never throws and never returns anything that is not a canonical origin", () => {
    const seed = 0x0121_0dad; const rnd = mulberry32(seed); const alphabet = "abc:/.@#?[]%\\ \n0127https";
    for (let i = 0; i < 1500; i++) {
      let s = rnd() < 0.5 ? "https://" : ""; const n = Math.floor(rnd() * 24); for (let k = 0; k < n; k++) s += alphabet[Math.floor(rnd() * alphabet.length)];
      const r = parseOrigin(s);
      if (r !== null) assert.equal(new URL(r).origin, r, `seed ${seed.toString(16)} case ${i}: ${JSON.stringify(s)}`);
    }
  });
});
