// Gaps found by the logs audit (20.10.): a multi-line PEM block printed by a child process, GitHub token families other
// than ghp_/github_pat_, credentials in a URL path, and truncation that ran before redaction. Secret-shaped fixtures are
// assembled at run time from fragments so no committed file holds a live-looking value.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { LIMITS, REDACTION } from "@plur1bus/log-schema";
import { OutputLines } from "../../src/logs/output.ts";
import { createRedactor } from "../../src/logs/redact.ts";
import { createWriter } from "../../src/logs/writer.ts";
import type { LogWriter } from "../../src/logs/writer.ts";
import { logsDir } from "./helpers.ts";

interface Call { event: string; attrs: Record<string, any> }
function fakeWriter() {
  const calls: Call[] = [];
  const writer = { write: (event: string, attrs: Record<string, any> = {}) => { calls.push({ event, attrs }); } } as unknown as LogWriter;
  return { writer, texts: () => calls.filter((c) => c.event === "process.output.line").map((c) => c.attrs.text as string) };
}
const buf = (s: string) => Buffer.from(s, "utf8");
const begin = (kind = "") => ["-----BEGIN ", kind, "PRIVATE KEY-----"].join("");
const end = (kind = "") => ["-----END ", kind, "PRIVATE KEY-----"].join("");
/** 64-character base64 lines, as `openssl` prints them; random, so most contain `+` or `/` (the audit's measured case). */
const body = (n: number): string[] => Array.from({ length: n }, () => randomBytes(48).toString("base64"));

describe("multi-line PEM private key in process output", () => {
  it("masks every body line, keeps the text around the block, and resets after the END line", () => {
    const f = fakeWriter(); const o = new OutputLines(f.writer, "stdout");
    const lines = body(25);
    o.push(buf(["before", begin(), ...lines, end(), "after"].join("\n") + "\n")); o.close();
    const out = f.texts();
    assert.equal(out[0], "before");
    assert.equal(out.at(-1), "after");
    for (const l of lines) assert.ok(!out.some((t) => t.includes(l.slice(0, 16))), `body line leaked: ${l}`);
    assert.ok(!out.some((t) => t.includes("PRIVATE KEY")), "no BEGIN/END marker text either");
    assert.equal(out.length, 1 + 1 + lines.length + 1 + 1, "one masked line per key line, so line counts stay meaningful");
    assert.ok(out.slice(1, -1).every((t) => t === "[REDACTED:pattern]"), JSON.stringify(out.slice(1, 4)));
  });

  it("works for RSA, OPENSSH, ENCRYPTED and PGP block names, and when the block arrives in small chunks", () => {
    for (const [b, e] of [[begin("RSA "), end("RSA ")], [begin("OPENSSH "), end("OPENSSH ")], [begin("ENCRYPTED "), end("ENCRYPTED ")],
      ["-----BEGIN PGP PRIVATE KEY BLOCK-----", "-----END PGP PRIVATE KEY BLOCK-----"]] as const) {
      const f = fakeWriter(); const o = new OutputLines(f.writer, "stderr");
      const lines = body(6); const text = [b, ...lines, e, "done"].join("\n") + "\n";
      for (let i = 0; i < text.length; i += 7) o.push(buf(text.slice(i, i + 7)));
      o.close();
      const out = f.texts();
      for (const l of lines) assert.ok(!out.some((t) => t.includes(l.slice(0, 16))), `${b}: ${l}`);
      assert.equal(out.at(-1), "done", b);
    }
  });

  it("an unterminated block is masked to the end of the stream (fail closed, like the single-text rule)", () => {
    const f = fakeWriter(); const o = new OutputLines(f.writer, "stdout");
    const lines = body(4);
    o.push(buf(["note", begin(), ...lines].join("\n") + "\n")); o.close();
    const out = f.texts();
    assert.equal(out[0], "note");
    for (const l of lines) assert.ok(!out.some((t) => t.includes(l.slice(0, 16))));
  });

  it("text before BEGIN and after END on the same line survives; two blocks in one stream are both masked", () => {
    const f = fakeWriter(); const o = new OutputLines(f.writer, "stdout");
    const a = body(2); const b = body(2);
    o.push(buf([`key: ${begin()}`, ...a, `${end()} trailer`, "middle", begin(), ...b, end(), ""].join("\n"))); o.close();
    const out = f.texts();
    assert.equal(out[0], "key: [REDACTED:pattern]");
    assert.ok(out.includes("[REDACTED:pattern] trailer"), JSON.stringify(out));
    assert.ok(out.includes("middle"));
    for (const l of [...a, ...b]) assert.ok(!out.some((t) => t.includes(l.slice(0, 16))));
  });

  it("the block state advances on lines the rate limiter drops (a flood cannot unmask the body)", () => {
    let t = 1_000_000; const f = fakeWriter();
    const o = new OutputLines(f.writer, "stdout", { now: () => t });
    for (let i = 0; i < LIMITS.rateBurst + 50; i++) o.push(buf(`noise ${i}\n`));
    const lines = body(10);
    o.push(buf([begin(), ...lines, end(), "tail"].join("\n") + "\n"));
    t += 60_000; o.push(buf("later\n")); o.close();
    const out = f.texts();
    for (const l of lines) assert.ok(!out.some((x) => x.includes(l.slice(0, 16))));
    assert.equal(out.at(-1), "later");
  });

  it("ordinary output, text that merely mentions a key, and a public-key block are not touched", () => {
    const f = fakeWriter(); const o = new OutputLines(f.writer, "stdout");
    const pub = ["-----BEGIN PUBLIC KEY-----", "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE", "-----END PUBLIC KEY-----"];
    o.push(buf(["generated a private key at ./server.key", ...pub, "ok"].join("\n") + "\n")); o.close();
    assert.deepEqual(f.texts(), ["generated a private key at ./server.key", ...pub, "ok"]);
  });

  it("end to end through the real writer: no body line reaches core.log", () => {
    const dir = logsDir(); const w = createWriter({ dir, role: "core", source: { kind: "harness", id: "core", version: null }, timers: false });
    const o = new OutputLines(w, "stdout"); const lines = body(25);
    o.push(buf([begin(), ...lines, end(), ""].join("\n"))); o.close(); w.close();
    const file = readFileSync(path.join(dir, "core.log"), "utf8");
    for (const l of lines) assert.ok(!file.includes(l.slice(0, 16)), l);
    assert.ok(file.includes("[REDACTED:pattern]"));
  });

  it("the markers the stream mask uses are the ones redaction.json's pem rule uses (no drift)", () => {
    const rule = REDACTION.rules.find((r: any) => r.id === "pattern").patterns.find((p: any) => p.id === "pem-private-key");
    const probe = [begin("RSA "), "x", end("RSA ")].join("\n");
    assert.match(probe, new RegExp(rule.pattern));
    const f = fakeWriter(); const o = new OutputLines(f.writer, "stdout"); o.push(buf(probe + "\n")); o.close();
    assert.ok(!f.texts().join("\n").includes("PRIVATE KEY"));
  });
});

describe("redaction happens before the 4096-byte cut", () => {
  it("a key that straddles the cut leaves no readable prefix", () => {
    const f = fakeWriter(); const o = new OutputLines(f.writer, "stdout");
    const key = ["sk-", "ant-", "api03-", "Q".repeat(60)].join("");
    o.push(buf("x".repeat(LIMITS.lineBytes - 20) + " " + key + "\n")); o.close();
    const [text] = f.texts();
    assert.ok(text);
    assert.ok(!/sk-/.test(text!), text!.slice(-40));
    assert.ok(Buffer.byteLength(text!) <= LIMITS.lineBytes);
  });

  it("a secret that starts before the cut and runs far past it is masked from its start", () => {
    const f = fakeWriter(); const o = new OutputLines(f.writer, "stdout");
    o.push(buf("x".repeat(LIMITS.lineBytes - 30) + " sk-" + "Q".repeat(20_000) + "\n")); o.close();
    const [text] = f.texts();
    assert.ok(!/sk-|QQQQ/.test(text!), text!.slice(-60));
  });

  it("a long line without secrets is still cut to lineBytes and flagged", () => {
    const f = fakeWriter(); const o = new OutputLines(f.writer, "stdout");
    o.push(buf("ab ".repeat(3000) + "\n")); o.close();
    const [text] = f.texts();
    assert.equal(Buffer.byteLength(text!), LIMITS.lineBytes);
  });
});

describe("credential shapes the D111 data did not cover", () => {
  const r = createRedactor();
  const tail = "Q1w2E3r4T5y6U7i8O9p0A1s2D3f4G5h6J7k8";
  it("redacts gho_, ghs_, ghu_ and ghr_ tokens and still leaves ghp_ and lookalikes right", () => {
    for (const prefix of ["gho", "ghs", "ghu", "ghr", "ghp"]) {
      const token = `${prefix}_${tail}`;
      const out = r.text(`gh said ${token} twice: ${token}`);
      assert.ok(!out.includes(tail.slice(0, 12)), `${prefix}: ${out}`);
      assert.match(out, /\[REDACTED:pattern\]/);
    }
    for (const fine of ["ghost_" + tail, "gho_short", "highgho_" + tail.slice(0, 30), "ghx_" + tail]) assert.equal(r.text(fine), fine, fine);
  });

  it("redacts the secret in a Telegram bot URL path and keeps host, method and bot id", () => {
    const secret = ["AAHd", "qTcvCH1vGWJxfSeofSAs0K5PALDsaw"].join("");
    for (const url of [`https://api.telegram.org/bot123456789:${secret}/getMe`, `https://api.telegram.org/file/bot123456789:${secret}/photos/file_1.jpg`]) {
      const out = r.text(`HTTP 401 for ${url} (retrying)`);
      assert.ok(!out.includes(secret), out);
      assert.ok(out.includes("api.telegram.org/") && out.includes("bot123456789:[REDACTED:url]"), out);
      assert.ok(out.endsWith("(retrying)"));
    }
  });

  it("redacts the secret path part of Slack, Discord and Teams webhook URLs", () => {
    const slack = ["T0123ABCD", "B0456EFGH", "xYz1AbC2dEf3GhI4jKl5MnOp"];
    const discordToken = "d1sc0rdT0ken_" + "Abc-123".repeat(2);
    const guid = (n: string) => `0a1b2c3d-${n}-4e5f-8a9b-0c1d2e3f4a5b`;
    const cases: Array<[string, string]> = [
      [`https://hooks.slack.com/services/${slack.join("/")}`, slack[2]!],
      [`https://discord.com/api/webhooks/123456789012345678/${discordToken}`, discordToken],
      [`https://example.webhook.office.com/webhookb2/${guid("aaaa")}@${guid("bbbb")}/IncomingWebhook/0123456789abcdef0123456789abcdef/${guid("cccc")}`, guid("cccc")],
    ];
    for (const [url, secret] of cases) {
      const out = r.text(`post to ${url} failed`);
      assert.ok(!out.includes(secret), out);
      assert.ok(out.includes("[REDACTED:url]") && out.endsWith(" failed"), out);
    }
  });

  it("leaves ordinary URL paths, query handling and bot-like words alone", () => {
    for (const same of ["https://example.test/docs/robots/index.html", "https://api.telegram.org/bot/getMe", "https://example.test/bot123456789/status",
      "https://hooks.slack.com/services/", "https://example.test/api/webhooks/list", "see /bot123456789:short/x outside a URL"]) assert.equal(r.text(same), same, same);
    assert.ok(!r.text("https://example.test/a/b?sig=abc123#frag").includes("abc123"), "the existing query and fragment steps still run");
  });

  it("redacts values nested in objects too (reader and writer use value())", () => {
    const secret = ["AAHd", "qTcvCH1vGWJxfSeofSAs0K5PALDsaw"].join("");
    const out = r.value({ attrs: { foreign_message: `GET https://api.telegram.org/bot123456789:${secret}/getMe` } });
    assert.ok(!JSON.stringify(out).includes(secret));
  });
});

