// Audit secrets #3 (2026-10-20): the redaction registry displaced its oldest value after 256 ("Nothing is removed" said the
// comment). The value a store name holds now is pinned and never displaced; only retired values (rotated away, or registered
// without a name) are bounded, so a token that rotates every hour cannot push a fixed secret out of the masking, in the registry
// or in a log writer that subscribed to it.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWriter } from "../../src/logs/writer.ts";
import { MAX_REGISTERED_SECRETS, createSecretRedaction } from "../../src/secrets/redaction.ts";
import { createMemoryAuditSink } from "../../src/secrets/audit.ts";
import { createMemoryBackend } from "../../src/secrets/memory-backend.ts";
import { createSecretStore } from "../../src/secrets/store.ts";
import { fakeClock } from "./helpers.ts";

const CHAIN = "chain-key-0123456789abcdef";
const token = (i: number) => `oauth-token-${String(i).padStart(5, "0")}-xxxxxxxx`;
const masked = (r: ReturnType<typeof createSecretRedaction>, value: string) => !r.redactor().text(`x ${value} y`).includes(value);

describe("redaction registry", () => {
  it("a pinned value survives any number of other values (the chain key vs 1000 OAuth refreshes)", () => {
    const r = createSecretRedaction();
    r.register(CHAIN, "approvals.chain-key.v1");
    for (let i = 0; i < 1000; i++) r.register(token(i), `oauth:${i % 3}`);
    assert.ok(masked(r, CHAIN));
    assert.ok(masked(r, token(999)) && masked(r, token(998)) && masked(r, token(997)), "the current token of every name");
    assert.ok(masked(r, token(996)), "and the retired ones the registry still keeps");
    assert.ok(!masked(r, token(0)), "a long-retired value is the one that goes (bounded)");
  });

  it("every distinct stored name stays masked, however many there are (no value of the store is displaced by count)", () => {
    const r = createSecretRedaction();
    for (let i = 0; i < MAX_REGISTERED_SECRETS + 44; i++) r.register(`fixed-secret-${i}-0123456789`, `name.${i}`);
    for (let i = 0; i < MAX_REGISTERED_SECRETS + 44; i++) assert.ok(masked(r, `fixed-secret-${i}-0123456789`), String(i));
  });

  it("a rotation keeps the old value masked (it is retired, not forgotten) and re-reading changes nothing", () => {
    const r = createSecretRedaction(); const heard: [string, boolean][] = [];
    r.subscribe((v, info) => heard.push([v, info.pinned]));
    r.register("first-value-12345678", "k");
    r.register("first-value-12345678", "k");
    r.register("second-value-1234567", "k");
    assert.ok(masked(r, "first-value-12345678") && masked(r, "second-value-1234567"));
    assert.deepEqual([...heard].sort(), [["first-value-12345678", false], ["first-value-12345678", true], ["second-value-1234567", true]]);
    assert.deepEqual(heard[0], ["first-value-12345678", true]);
  });

  it("values without a name are bounded and never displace a pinned one", () => {
    const r = createSecretRedaction();
    r.register(CHAIN, "chain");
    for (let i = 0; i < MAX_REGISTERED_SECRETS * 2; i++) r.register(token(i));
    assert.ok(masked(r, CHAIN));
    assert.ok(masked(r, token(MAX_REGISTERED_SECRETS * 2 - 1)));
    assert.ok(!masked(r, token(0)));
  });

  it("a header value and its bare credential are both current for the name; a late subscriber learns which values are pinned", () => {
    const r = createSecretRedaction();
    r.register("Bearer abcdefgh12345678", "api");
    const heard: [string, boolean][] = [];
    r.subscribe((v, info) => heard.push([v, info.pinned]));
    assert.deepEqual(heard, [["Bearer abcdefgh12345678", true], ["abcdefgh12345678", true]]);
    r.register("Bearer zzzzzzzz12345678", "api");
    assert.deepEqual(heard.slice(2).sort(), [["Bearer abcdefgh12345678", false], ["Bearer zzzzzzzz12345678", true], ["abcdefgh12345678", false], ["zzzzzzzz12345678", true]]);
  });

  it("short and non-string values are ignored, with or without a name", () => {
    const r = createSecretRedaction(); const seen: string[] = [];
    r.subscribe((v) => seen.push(v));
    r.register("short", "k"); r.register("short"); r.register(5 as never, "k"); r.register(undefined as never);
    assert.deepEqual(seen, []);
  });

  it("contains and mask look for registered values only", () => {
    const r = createSecretRedaction();
    r.register("needle-value-12345678", "k");
    assert.equal(r.contains("see needle-value-12345678 here"), true);
    assert.equal(r.contains("see nothing here"), false);
    assert.equal(r.mask("a needle-value-12345678 b needle-value-12345678"), "a [redacted] b [redacted]");
    assert.equal(r.mask("ordinary words: key = value"), "ordinary words: key = value");
  });
});

describe("through the store into a log writer", () => {
  it("a fixed secret is still masked in the log after 600 rotations of another name", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "p1b-redbound-"));
    try {
      const store = createSecretStore({ keyring: createMemoryBackend(), file: createMemoryBackend(), fileFallback: () => false, audit: createMemoryAuditSink(), clock: fakeClock() });
      const w = createWriter({ dir, role: "core", source: { kind: "harness", id: "core", version: null }, timers: false });
      store.redaction.subscribe((v, info) => w.registerSecret(v, info));
      const owner = { kind: "owner" as const, id: "t" };
      await store.set(owner, "approvals.chain-key.v1", CHAIN);
      for (let i = 0; i < 600; i++) await store.set(owner, "oauth.profile", token(i));
      assert.ok(masked(store.redaction, CHAIN));
      w.write("process.output.line", { text: `leak ${CHAIN} and ${token(599)}`, untrusted: true }, { stream: "stdout" });
      w.close();
      const file = path.join(dir, "core.log");
      assert.ok(existsSync(file));
      const text = readFileSync(file, "utf8");
      assert.ok(!text.includes(CHAIN), "the fixed secret was masked");
      assert.ok(!text.includes(token(599)), "so was the current token");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
