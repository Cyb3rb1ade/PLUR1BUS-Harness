import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRedactor, isSecretKey } from "../../src/logs/redact.ts";

const r = createRedactor();
const SK = "sk-" + "A1b2C3d4E5f6G7h8I9j0K1l2";
const GHP = "ghp_" + "a".repeat(36);
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlX3ZhbHVl";

describe("reader-side redaction (D111 section 4)", () => {
  it("replaces values under secret-looking keys and keeps counts and ids", () => {
    const out = r.value({ authorization: "Bearer abcdefghijkl", accessToken: "t", max_tokens: 10, input_tokens: 3, agent: "bernd", attrs: { password: "x", model: "m", nested: { api_key: "k" } } });
    assert.deepEqual(out, { authorization: "[REDACTED:key]", accessToken: "[REDACTED:key]", max_tokens: 10, input_tokens: 3, agent: "bernd", attrs: { password: "[REDACTED:key]", model: "m", nested: { api_key: "[REDACTED:key]" } } });
    assert.ok(isSecretKey("id_token_hint") && isSecretKey("Set-Cookie") && !isSecretKey("tokens") && !isSecretKey("outputTokens"));
  });
  it("replaces credential shapes in free text and says which rule did it", () => {
    for (const secret of [SK, GHP, JWT, "AKIAABCDEFGHIJKLMNOP", "xoxb-1234567890-abcdef", "ek_" + "q".repeat(20), "Bearer abc.def-ghi_jkl"]) {
      const out = r.text(`call failed with ${secret} in the header`);
      assert.ok(!out.includes(secret.replace(/^Bearer /, "")), out);
      assert.match(out, /\[REDACTED:(pattern|key)\]/);
    }
    assert.equal(r.text("Basic info about this"), "Basic info about this");
  });
  it("redacts key=value and JSON-ish pairs inside a message", () => {
    assert.equal(r.text("retry token=abc123 attempt=2"), "retry token=[REDACTED:key] attempt=2");
    assert.equal(r.text('{"client_secret":"s3cr3t","ok":1}'), '{"client_secret":"[REDACTED:key]","ok":1}');
    assert.equal(r.text("max_tokens=100"), "max_tokens=100");
  });
  it("redacts PLUR1BUS_* env values and long base64url runs, but keeps hex digests readable", () => {
    assert.equal(r.text("PLUR1BUS_HOME=/srv/x"), "PLUR1BUS_HOME=[REDACTED:pattern]");
    const run = "A".repeat(20) + "-" + "b".repeat(30);
    assert.match(r.text(`blob ${run}`), /blob \[REDACTED:pattern\]/);
    const sha = "a".repeat(64);
    assert.equal(r.text(`sha256 ${sha}`), `sha256 ${sha}`);
  });
  it("urls lose userinfo, query values and fragment; parameter names stay", () => {
    assert.equal(r.text("GET https://user:pw@example.test/cb?code=abc&state=xyz#frag now"), "GET https://example.test/cb?code=[REDACTED:url]&state=[REDACTED:url]#[REDACTED:url] now");
  });
  it("replaces deny-listed paths by class and a short hash", () => {
    for (const [p, cls] of [["/home/u/.ssh/id_ed25519", "ssh"], ["C:\\Users\\u\\.aws\\credentials", "cloud-cli"], ["/srv/app/.env", "dotenv"], ["/home/u/.gnupg/pubring.kbx", "gnupg"]] as const) {
      const out = r.text(`opened ${p} failed`);
      assert.match(out, new RegExp(`^opened <deny:${cls}>/…#[0-9a-f]{6} failed$`), out);
    }
    assert.equal(r.text("opened /home/u/project/readme.md"), "opened /home/u/project/readme.md");
  });
  it("PII only when asked; secret registry values (and their encodings) when given", () => {
    assert.equal(r.text("mail a.b@example.test"), "mail a.b@example.test");
    assert.equal(createRedactor({ pii: true }).text("mail a.b@example.test"), "mail [REDACTED:pii]");
    const reg = createRedactor({ secrets: ["hunter2hunter2", "short"] });
    const b64 = Buffer.from("hunter2hunter2").toString("base64");
    assert.equal(reg.text(`a hunter2hunter2 b ${b64} c short`), "a [REDACTED:secret] b [REDACTED:secret] c short");
  });
  it("does not mutate its input and leaves non-strings alone", () => {
    const input = { a: { token: "x" }, n: 1, z: null, l: ["Bearer abcdefghij"] };
    const copy = structuredClone(input);
    r.value(input);
    assert.deepEqual(input, copy);
    assert.deepEqual(r.value({ n: 1, z: null, b: true }), { n: 1, z: null, b: true });
  });
});
it("a generated path flood cannot stall redaction", async () => {
  const { spawn } = await import("node:child_process");
  const moduleUrl = new URL("../../src/logs/redact.ts", import.meta.url).href;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--conditions=source", "--input-type=module", "-e",
      `import {createRedactor} from ${JSON.stringify(moduleUrl)}; createRedactor().text("/x".repeat(256));`], { stdio: "ignore" });
    const timer = setTimeout(() => { child.kill(); reject(new Error("redaction stalled on a generated path flood")); }, 5000);
    child.on("error", err => { clearTimeout(timer); reject(err); });
    child.on("close", code => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(`fixture exited ${code}`)); });
  });
});
