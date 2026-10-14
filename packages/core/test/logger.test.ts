import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, engineLoggerFrom } from "../src/logger.ts";
import { createRedactor } from "../src/logs/redact.ts";

// Credential shapes are assembled at run time so no token-like literal sits in the source.
const SK = ["sk", "ant", "A1b2C3d4E5f6G7h8I9j0K1l2M3"].join("-");
const BEARER = ["abcdef", "ghijkl", "mnopqr"].join("");
const PASS = ["hunter", "two", "pass"].join("");

function harness(): { engine: ReturnType<typeof engineLoggerFrom>; lines: () => Array<Record<string, any>>; raw: () => string; done: () => Promise<void> } {
  const dir = mkdtempSync(join(tmpdir(), "engine-logger-"));
  const file = join(dir, "core.log");
  const log = createLogger({ file, level: "debug", role: "core" });
  const raw = () => readFileSync(file, "utf8");
  return {
    engine: engineLoggerFrom(log),
    raw,
    lines: () => raw().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>),
    done: async () => { await log.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

describe("engine logger adapter", () => {
  it("never throws into the engine: circular, BigInt, throwing getters and toJSON are logged as text", async () => {
    const h = harness();
    try {
      const circular: Record<string, unknown> = { name: "x" };
      circular.self = circular;
      const getter = { get boom(): never { throw new Error("getter"); } };
      assert.doesNotThrow(() => h.engine.warn("odd arguments", circular, { n: 10n }, getter, { toJSON() { throw new Error("toJSON"); } }));
      const [line] = h.lines();
      assert.ok(line, "the call still produced one line");
      assert.equal(line!.msg, "odd arguments");
    } finally { await h.done(); }
  });

  it("keeps the whole error chain (cause, aggregate members) and errors nested inside objects", async () => {
    const h = harness();
    try {
      const root = new Error("disk full");
      const mid = new Error("write failed", { cause: root });
      const agg = new AggregateError([new Error("member one")], "many");
      h.engine.error("engine failed", mid, { wrapped: agg });
      const text = h.raw();
      for (const needle of ["write failed", "disk full", "many", "member one"]) assert.ok(text.includes(needle), `${needle} is in the line`);
    } finally { await h.done(); }
  });

  it("redacts secrets in the message, in arguments, in headers and in error text", async () => {
    const h = harness();
    try {
      h.engine.error(`upstream said Authorization: Bearer ${BEARER}`, {
        headers: { authorization: `Bearer ${BEARER}`, accept: "json" },
        url: `https://user:${PASS}@example.test/path?api_key=${PASS}&q=1`,
        nested: [{ password: PASS }],
      }, new Error(`request with ${SK} failed`, { cause: new Error(`token=${PASS}`) }));
      const text = h.raw();
      for (const secret of [BEARER, PASS, SK]) assert.ok(!text.includes(secret), `${secret.slice(0, 6)}… leaked: ${text}`);
      assert.ok(text.includes("accept"), "non-secret fields survive");
    } finally { await h.done(); }
  });

  it("bounds a huge message and huge arguments to one short line", async () => {
    const h = harness();
    try {
      h.engine.info("m".repeat(5_000_000), { blob: "x".repeat(5_000_000), list: Array.from({ length: 100_000 }, (_, i) => i) }, new Error("e".repeat(1_000_000)));
      const raw = h.raw();
      assert.ok(Buffer.byteLength(raw) <= 16 * 1024, `line is ${Buffer.byteLength(raw)} bytes`);
      assert.equal(raw.split("\n").filter(Boolean).length, 1);
    } finally { await h.done(); }
  });

  it("cannot forge extra lines: line breaks and Unicode separators in foreign text stay inside one record", async () => {
    const h = harness();
    try {
      const forged = '{"at":"x","level":"error","msg":"forged"}';
      h.engine.info(`a\n${forged}\r\n${forged}\u2028${forged}\u2029`, { text: `b\n${forged}\u0085` });
      const raw = h.raw();
      assert.equal(raw.split(new RegExp("\\r\\n|\\n|\\r|\\u2028|\\u2029|\\u0085")).filter(Boolean).length, 1, raw);
      assert.equal(h.lines().length, 1);
    } finally { await h.done(); }
  });
});

// KNOWN GAP (packages/core/src/logs/redact.ts, outside this audit): the free-text key=value rule consumes
// `Error: token=...` as one pair named `Error`, so the credential after the colon is never examined.
describe("redactor gaps found while auditing the engine logger", () => {
  it("KNOWN GAP: redacts a secret-keyed pair that follows a `Name:` prefix", { todo: true }, () => {
    const out = createRedactor().text(`Error: token=${PASS} while connecting`);
    assert.ok(!out.includes(PASS), out);
  });
  // KNOWN GAP: the same rule is quadratic in the length of an unbroken word run (about 0.8 s at 4 KiB, 4 s at 8 KiB).
  it("KNOWN GAP: redacting a 4 KiB unbroken run stays fast", { todo: true }, () => {
    const t = Date.now();
    createRedactor().text("m".repeat(4096));
    assert.ok(Date.now() - t < 100, `took ${Date.now() - t} ms`);
  });
});
