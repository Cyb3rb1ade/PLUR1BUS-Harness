import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRedactor, isSecretKey } from "../../src/logs/redact.ts";
import { createSecretRedaction, redactProtocolOutput, redactProtocolValue } from "../../src/secrets/index.ts";

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
    assert.equal(r.text("pay to DE89370400440532013000 now"), "pay to DE89370400440532013000 now");
    assert.equal(r.text("card 4111-2222-3333-4444 exp"), "card 4111-2222-3333-4444 exp");
    assert.equal(createRedactor({ pii: true }).text("mail a.b@example.test"), "mail [REDACTED:pii]");
    assert.equal(createRedactor({ pii: true }).text("pay to DE89370400440532013000 now"), "pay to [REDACTED:pii] now");
    assert.equal(createRedactor({ pii: true }).text("pay to DE89 3704 0044 0532 0130 00 now"), "pay to [REDACTED:pii] now");
    assert.equal(createRedactor({ pii: true }).text("card 4111-2222-3333-4444 exp"), "card [REDACTED:pii] exp");
    assert.equal(createRedactor({ pii: true }).text("card 4111222233334444 exp"), "card [REDACTED:pii] exp");
    assert.equal(createRedactor({ pii: true }).text("amex 3782-822463-10005"), "amex [REDACTED:pii]");
    const reg = createRedactor({ secrets: ["hunter2hunter2", "short"] });
    const b64 = Buffer.from("hunter2hunter2").toString("base64");
    assert.equal(reg.text(`a hunter2hunter2 b ${b64} c short`), "a [REDACTED:secret] b [REDACTED:secret] c short");
  });
  it("secret registry: hex (lower and upper case) and base64url with padding are masked like base64 and percent forms", () => {
    // 20 bytes: the padded forms end in "=" (20 % 3 = 2) and the base64 alphabets differ ("??>" gives "+" and "/" vs "-" and "_").
    const secret = "ab?>?>?>cd/+=value-1234";
    const buf = Buffer.from(secret);
    const std = buf.toString("base64"); const url = buf.toString("base64url");
    const forms = [secret, std, std.replace(/=+$/, ""), url, url + "=".repeat((4 - (url.length % 4)) % 4), buf.toString("hex"), buf.toString("hex").toUpperCase(), encodeURIComponent(secret)];
    assert.ok(forms.some((f) => f.endsWith("=") && !f.includes("+") && !f.includes("/")), "a padded base64url form is part of the vectors");
    const reg = createRedactor({ secrets: [secret] });
    for (const form of new Set(forms)) {
      assert.equal(reg.text(`line ${form} end`), "line [REDACTED:secret] end", form);
    }
    // The whole padded form goes, no dangling "=" is left behind.
    const padded = Buffer.from("secret-with-pad!").toString("base64url") + "==";
    assert.equal(createRedactor({ secrets: ["secret-with-pad!"] }).text(`x ${padded} y`), "x [REDACTED:secret] y");
  });
  it("secret registry: the same minimum length applies before the forms are derived, and foreign hex or base64url stays", () => {
    const reg = createRedactor({ secrets: ["abc123", "hunter2hunter2"] });
    // "abc123" is shorter than 8: neither it nor its hex form (616263313233) is masked.
    assert.equal(reg.text("abc123 616263313233 YWJjMTIz"), "abc123 616263313233 YWJjMTIz");
    // Hex and base64url of some other value stay readable (a 64-digit digest, the hex of another string, an unrelated padded run).
    const foreignHex = Buffer.from("another-value-xx").toString("hex");
    const digest = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
    const foreignB64 = Buffer.from("another-value-xx").toString("base64url") + "==";
    const line = `h=${foreignHex} d=${digest.toUpperCase()} u=${foreignB64}`;
    assert.equal(reg.text(line), line);
    // The registered value's own hex form, in both cases, inside a longer line, is masked.
    const own = Buffer.from("hunter2hunter2").toString("hex");
    assert.equal(reg.text(`a ${own} b ${own.toUpperCase()} c`), "a [REDACTED:secret] b [REDACTED:secret] c");
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

  it("finds a secret-keyed pair behind a `Name:` prefix, a cause chain or a quoted message", () => {
    const pw = ["hunter", "two", "pass"].join("");
    for (const text of [`Error: token=${pw} x`, `TypeError: password=${pw}`, `cause: password=${pw}, retrying`, `Name: key=1 api_key=${pw}`,
      `{"msg":"connect failed password=${pw}"}`, `a: b: c: secret=${pw}`]) {
      assert.ok(!r.text(text).includes(pw), r.text(text));
    }
    assert.equal(r.text("Error: token=abc while connecting"), "Error: token=[REDACTED:key] while connecting");
    assert.equal(r.text("sent x-api-key: abc123 now"), "sent x-api-key: [REDACTED:key] now");
    assert.equal(r.text("x-api-key: abc123"), "x-api-key: [REDACTED:key]");
    assert.equal(r.text("sent x-api-key=abc123"), "sent x-api-key=[REDACTED:key]");
    assert.equal(r.text("retry: attempt=2 ok"), "retry: attempt=2 ok");
  });
  it("is linear on long runs without a separator (64 KiB under a generous bound)", () => {
    for (const run of ["m".repeat(65536), "a.b-".repeat(16384), "key ".repeat(16384), "\"a".repeat(32768), "k:".repeat(32768), "= ".repeat(32768), "a".repeat(32768) + "://", "ab+".repeat(21845)]) {
      const t = Date.now();
      r.text(run);
      assert.ok(Date.now() - t < 500, `took ${Date.now() - t} ms`);
    }
  });

  it("redactProtocolOutput and redactProtocolValue apply PII only for a2a, secrets for both", () => {
    const secrets = createSecretRedaction();
    secrets.register("my-super-secret-token", "agent-token");

    const a2aText = redactProtocolOutput(
      "IBAN: DE89 3704 0044 0532 0130 00, val: my-super-secret-token",
      "a2a",
      secrets,
    );
    assert.equal(a2aText, "IBAN: [REDACTED:pii], val: [REDACTED:secret]");

    const mcpText = redactProtocolOutput(
      "IBAN: DE89 3704 0044 0532 0130 00, val: my-super-secret-token",
      "mcp",
      secrets,
    );
    assert.equal(mcpText, "IBAN: DE89 3704 0044 0532 0130 00, val: [REDACTED:secret]");

    const a2aVal = redactProtocolValue(
      { iban: "DE89 3704 0044 0532 0130 00", customVal: "my-super-secret-token" },
      "a2a",
      secrets,
    );
    assert.deepEqual(a2aVal, { iban: "[REDACTED:pii]", customVal: "[REDACTED:secret]" });

    const mcpVal = redactProtocolValue(
      { iban: "DE89 3704 0044 0532 0130 00", customVal: "my-super-secret-token" },
      "mcp",
      secrets,
    );
    assert.deepEqual(mcpVal, { iban: "DE89 3704 0044 0532 0130 00", customVal: "[REDACTED:secret]" });
  });
});
