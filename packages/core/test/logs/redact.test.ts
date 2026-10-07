import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRedactor } from "../../src/logs/redact.ts";

const vectors = JSON.parse(readFileSync(new URL("../../../log-schema/fixtures/vectors.json", import.meta.url), "utf8"));
const red = createRedactor();

describe("log redaction (D111 §4 data, reader side)", () => {
  it("redacts every canary shape and leaves none of it behind", () => {
    for (const c of vectors.redactionCanaries as Array<{ rule: string; pattern: string; parts: string[]; matches: string[] }>) {
      const whole = c.parts.join("");
      const out = red.text(`before ${whole} after`);
      for (const m of c.matches) assert.ok(!out.includes(m), `${c.pattern}: ${m} survived: ${out}`);
      assert.match(out, /\[REDACTED:/, c.pattern);
    }
  });

  it("keeps the documented non-matches readable", () => {
    for (const n of vectors.redactionNonMatches as Array<{ text: string }>) assert.equal(red.text(n.text), n.text, n.text);
  });

  it("key names: credential names redact their value, token counts and look-alikes stay", () => {
    for (const k of vectors.keyNames.redact as string[]) {
      assert.equal(red.isSecretKey(k), true, k);
      assert.deepEqual(red.value({ [k]: "hunter2-value" }), { [k]: "[REDACTED:key]" }, k);
    }
    for (const k of vectors.keyNames.keep as string[]) {
      assert.equal(red.isSecretKey(k), false, k);
      assert.deepEqual(red.value({ [k]: "visible" }), { [k]: "visible" }, k);
    }
  });

  it("redacts nested values and arrays, and a whole object under a credential key", () => {
    assert.deepEqual(red.value({ a: { b: [{ password: "x" }, { ok: 1 }] }, token: { nested: "y" }, n: null, t: true }),
      { a: { b: [{ password: "[REDACTED:key]" }, { ok: 1 }] }, token: "[REDACTED:key]", n: null, t: true });
  });

  it("redacts key=value, header and JSON-in-text forms", () => {
    assert.equal(red.text("login password=hunter2 user=bob"), "login password=[REDACTED:key] user=bob");
    assert.equal(red.text('body {"api_key":"abc","x":1}'), 'body {"api_key":"[REDACTED:key]","x":1}');
    assert.equal(red.text("Authorization: Bearer abcdefgh12345678"), "Authorization: [REDACTED:key]");
    assert.equal(red.text("Cookie: a=b; c=d"), "Cookie: [REDACTED:key]");
  });

  it("URLs lose userinfo, query values and fragment; names stay", () => {
    assert.equal(red.text("GET https://user:pw@example.test/p?a=1&b=2#frag ok"), "GET https://example.test/p?a=[REDACTED:url]&b=[REDACTED:url]#[REDACTED:url] ok");
  });

  it("credential paths become class and short hash; ordinary paths stay", () => {
    const out = red.text("read /home/u/.ssh/id_ed25519 and C:\\Users\\u\\.aws\\credentials and /srv/app/.env.local and /var/log/app.log");
    assert.match(out, /<deny:ssh>\/…#[0-9a-f]{6}/);
    assert.match(out, /<deny:cloud-cli>\/…#[0-9a-f]{6}/);
    assert.match(out, /<deny:dotenv>\/…#[0-9a-f]{6}/);
    assert.ok(out.includes("/var/log/app.log"));
    assert.ok(!out.includes("id_ed25519") && !out.includes("credentials"));
  });

  it("known secret values are redacted raw, base64 and URL-encoded; short ones are ignored", () => {
    const secret = "s3cr3t/Value+with=odd chars";
    const r = createRedactor({ secrets: () => [secret, "short"] });
    const out = r.text(`raw ${secret} b64 ${Buffer.from(secret).toString("base64")} url ${encodeURIComponent(secret)} short`);
    assert.equal(out, "raw [REDACTED:secret] b64 [REDACTED:secret] url [REDACTED:secret] short");
  });

  it("PII only when switched on", () => {
    const msg = "mail bob@example.test call +4930123456";
    assert.equal(red.text(msg), msg);
    assert.equal(createRedactor({ redactPii: () => true }).text(msg), "mail [REDACTED:pii] call [REDACTED:pii]");
  });

  it("is idempotent: redacting redacted output changes nothing", () => {
    const r = createRedactor({ secrets: () => ["topsecret-value-123"] });
    const input = "Authorization: Bearer abcdefgh12345678 token=zzz https://u:p@h.test/x?k=v /home/u/.ssh/id topsecret-value-123";
    const once = r.text(input);
    assert.equal(r.text(once), once);
    const v = { a: input, password: "x" };
    assert.deepEqual(r.value(r.value(v)), r.value(v));
  });

  it("caps recursion depth instead of overflowing", () => {
    let deep: any = "leaf";
    for (let i = 0; i < 50; i++) deep = { n: deep };
    assert.ok(JSON.stringify(red.value(deep)).includes("[TRUNCATED]"));
  });
});
