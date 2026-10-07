// E1: seeded, deterministic fuzz of the line decoder and of a server reading hostile lines. No framework: a mulberry32
// generator. PLUR1BUS_FUZZ_SEED / PLUR1BUS_FUZZ_CASES override seed and case count; the seed is printed on failure.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { RPC_VERSION } from "@plur1bus/rpc-schema";
import { createControlServer, type ControlServer } from "../src/control-server.ts";
import { LineDecoder, LineTooLong, MAX_LINE_BYTES, encodeLine } from "../src/framing.ts";
import { tempDir } from "./helpers/temp-dir.ts";

const SEED = Number(process.env.PLUR1BUS_FUZZ_SEED ?? 0xe1f022) >>> 0;
const CASES = Number(process.env.PLUR1BUS_FUZZ_CASES ?? 300);

function mulberry32(a: number): () => number {
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return (((t ^ (t >>> 14)) >>> 0) / 4294967296); };
}
const below = (r: () => number, n: number) => Math.floor(r() * n);
const randBytes = (r: () => number, n: number) => Buffer.from(Array.from({ length: n }, () => below(r, 256)));

/** One hostile line (without the newline). */
function hostileLine(r: () => number): Buffer {
  switch (below(r, 9)) {
    case 0: return randBytes(r, below(r, 300)).filter((b) => b !== 0x0a) as Buffer;
    case 1: { const full = Buffer.from(`{"jsonrpc":"2.0","id":1,"method":"m","params":{"s":"é😀"}}`); return full.subarray(0, full.length - 5 - below(r, 3)); } // cut inside a multi-byte char
    case 2: { const d = 100 + below(r, 200_000); return Buffer.from(`{"jsonrpc":"2.0","id":1,"method":"m","params":${"[".repeat(d)}0${"]".repeat(d)}}`); }
    case 3: { const d = 100 + below(r, 50_000); return Buffer.from(`{"jsonrpc":"2.0","id":1,"method":"m","params":${'{"a":'.repeat(d)}0${"}".repeat(d)}}`); }
    case 4: return Buffer.from(`{"jsonrpc":"2.0","id":1,"id":${below(r, 5)},"method":"a","method":"module.status","params":{},"params":{"x":1}}`);
    case 5: { const big = "9".repeat(1 + below(r, 3000)); return Buffer.from([`{"jsonrpc":"2.0","id":${big},"method":"module.status","params":{}}`, `{"jsonrpc":"2.0","id":1,"method":"m","params":{"n":1e${below(r, 999_999)}}}`, `{"jsonrpc":"2.0","id":-${big}.${big},"method":"m"}`][below(r, 3)]!); }
    case 6: return Buffer.from(`[{"jsonrpc":"2.0","id":1,"method":"module.status","params":{}},{"jsonrpc":"2.0","id":2,"method":"module.status"}]`); // batch
    case 7: return Buffer.from(below(r, 2) ? `{"jsonrpc":"2.0","result":1}` : `{"jsonrpc":"2.0","id":null,"error":{"code":-1,"message":"x"}}`); // a response, no request
    default: return Buffer.from(["null", "true", "0", `"s"`, "[]", "{}", "[[[]]]", `{"id":{}}`][below(r, 8)]!);
  }
}

/** Feeds `data` to a decoder in random chunks; returns what it produced. */
function feed(r: () => number, data: Buffer): { values: unknown[]; bad: number; tooLong: boolean } {
  const d = new LineDecoder(); const out = { values: [] as unknown[], bad: 0, tooLong: false };
  for (let i = 0; i < data.length;) {
    const n = 1 + below(r, 70_000); const c = d.decode(data.subarray(i, i + n)); i += n;
    out.values.push(...c.values); out.bad += c.bad.length; if (c.tooLong) { out.tooLong = true; break; }
  }
  return out;
}

describe(`framing fuzz (seed ${SEED}, ${CASES} cases)`, () => {
  it("LineDecoder never throws from decode and every line is either a value or one typed bad entry", { timeout: 120_000 }, () => {
    const r = mulberry32(SEED);
    for (let i = 0; i < CASES; i++) {
      const lines = Array.from({ length: 1 + below(r, 4) }, () => hostileLine(r));
      const data = Buffer.concat(lines.flatMap((l) => [l, Buffer.from("\n")]));
      let res;
      try { res = feed(r, data); } catch (e) { assert.fail(`case ${i} seed ${SEED}: decode threw ${String(e)}`); }
      const nonEmpty = lines.filter((l) => l.length > 0).length;
      assert.equal(res.values.length + res.bad, nonEmpty, `case ${i} seed ${SEED}`);
    }
  });

  it("chunking never changes the outcome (same lines, any split)", { timeout: 60_000 }, () => {
    const r = mulberry32(SEED ^ 1);
    for (let i = 0; i < CASES; i++) {
      const data = Buffer.concat(Array.from({ length: 3 }, () => Buffer.concat([hostileLine(r), Buffer.from("\n")])));
      const whole = new LineDecoder().decode(data);
      const split = feed(r, data);
      // assert.deepEqual recurses and would itself overflow on the deeply nested values; compare a depth-safe fingerprint.
      const fp = (vs: unknown[]) => vs.map((v) => { try { return JSON.stringify(v); } catch { return "<too deep>"; } });
      assert.deepEqual(fp(split.values), fp(whole.values), `case ${i} seed ${SEED}`);
      assert.equal(split.bad, whole.bad.length, `case ${i} seed ${SEED}`);
    }
  });

  it("truncated UTF-8 at every cut point of a multi-byte line is a parse error or a value, never a throw", () => {
    const line = Buffer.from(`{"s":"é€😀"}`);
    for (let cut = 0; cut < line.length; cut++) {
      const r = new LineDecoder().decode(Buffer.concat([line.subarray(0, cut), Buffer.from("\n")]));
      assert.equal(r.values.length + r.bad.length, cut === 0 ? 0 : 1, `cut ${cut}`);
    }
  });

  it("the 4 MiB limit is exact: a complete line of MAX bytes parses, MAX+1 unterminated bytes is LineTooLong, memory is released", { timeout: 30_000 }, () => {
    const pad = (n: number) => { const head = `{"s":"`, tail = `"}`; return Buffer.concat([Buffer.from(head), Buffer.alloc(n - head.length - tail.length, 0x78), Buffer.from(tail)]); };
    const ok = new LineDecoder().decode(Buffer.concat([pad(MAX_LINE_BYTES), Buffer.from("\n")]));
    assert.equal(ok.values.length, 1); assert.equal(ok.tooLong, undefined);
    const d = new LineDecoder();
    const over = d.decode(Buffer.alloc(MAX_LINE_BYTES + 1, 0x61));
    assert.ok(over.tooLong instanceof LineTooLong);
    // the buffer was dropped: the next valid line decodes
    assert.deepEqual(d.decode(Buffer.from('{"id":1}\n')).values, [{ id: 1 }]);
    // an endless stream of small chunks never holds more than the limit
    const e = new LineDecoder(); let seen = false;
    for (let i = 0; i < 100 && !seen; i++) seen = e.decode(Buffer.alloc(64 * 1024, 0x61)).tooLong !== undefined;
    assert.ok(seen, "an unterminated stream must hit the limit after ~4 MiB");
  });

  it("encodeLine output decodes to the same value for random JSON (property)", () => {
    const r = mulberry32(SEED ^ 2);
    const gen = (depth: number): unknown => {
      switch (below(r, depth > 4 ? 4 : 6)) {
        case 0: return below(r, 1e9) - 5e8; case 1: return String.fromCodePoint(...Array.from({ length: below(r, 6) }, () => 0x20 + below(r, 0x10ff00)).filter((c) => c < 0xd800 || c > 0xdfff));
        case 2: return r() < 0.5; case 3: return null;
        case 4: return Array.from({ length: below(r, 4) }, () => gen(depth + 1));
        default: return Object.fromEntries(Array.from({ length: below(r, 4) }, (_, i) => [`k${i}`, gen(depth + 1)]));
      }
    };
    for (let i = 0; i < CASES; i++) { const v = gen(0); assert.deepEqual(new LineDecoder().push(encodeLine(v)), [v], `case ${i} seed ${SEED}`); }
  });
});

describe(`control server under hostile lines (seed ${SEED})`, () => {
  const TOKEN = "f".repeat(64);
  const address = process.platform === "win32" ? `\\\\.\\pipe\\plur1bus-fuzz-test-${process.pid}` : join(tempDir("p1b-fuzz-"), "m.sock");
  const hello = () => ({ rpc: RPC_VERSION, instanceId: "mod-fuzz", pid: process.pid, module: { name: "fixture", version: "0.1.0", apiVersion: "1" } });
  let server: ControlServer;
  before(async () => { server = createControlServer({ address, token: TOKEN, hello, authIdleMs: 2000, handlers: { "module.status": async () => ({}) } }); await server.listen(); });
  after(async () => { await server.close(); });

  /** Sends bytes, collects every reply until the socket closes or goes quiet; returns replies and whether it closed. */
  function exchange(bytes: Buffer, quietMs = 150): Promise<{ replies: any[]; unparsed: number }> {
    return new Promise((resolve, reject) => {
      const sock: Socket = createConnection(address); const dec = new LineDecoder(); const replies: any[] = []; let unparsed = 0;
      let quiet: NodeJS.Timeout; const done = () => { clearTimeout(quiet); sock.destroy(); resolve({ replies, unparsed }); };
      const arm = () => { clearTimeout(quiet); quiet = setTimeout(done, quietMs); };
      sock.on("data", (c) => { const x = dec.decode(c); replies.push(...x.values); unparsed += x.bad.length; arm(); });
      sock.on("end", done);
      sock.on("close", done); sock.on("error", () => done());
      sock.once("connect", () => { sock.write(bytes); arm(); });
      setTimeout(() => reject(new Error("exchange timeout")), 20_000).unref();
    });
  }

  it("every hostile line gets a typed JSON-RPC error (or a clean close); the server keeps serving afterwards", { timeout: 120_000 }, async () => {
    const r = mulberry32(SEED ^ 3);
    for (let i = 0; i < Math.min(CASES, 60); i++) {
      const line = hostileLine(r);
      const { replies, unparsed } = await exchange(Buffer.concat([line, Buffer.from("\n")]));
      assert.equal(unparsed, 0, `case ${i} seed ${SEED}: a reply was not valid JSON`);
      for (const m of replies) {
        assert.equal(m.jsonrpc, "2.0", `case ${i} seed ${SEED}`);
        assert.ok(m.error && typeof m.error.code === "number" && typeof m.error.data?.error === "string", `case ${i} seed ${SEED}: untyped reply ${JSON.stringify(m).slice(0, 200)}`);
      }
    }
    // alive: a normal auth still works
    const { replies } = await exchange(encodeLine({ jsonrpc: "2.0", id: 1, method: "module.auth", params: { token: TOKEN } }));
    assert.equal(replies[0]?.result?.module?.name, "fixture");
  });

  it("a batch is not served: it answers one invalid-request error with a null id", async () => {
    const { replies } = await exchange(encodeLine([{ jsonrpc: "2.0", id: 1, method: "module.status", params: {} }]));
    assert.equal(replies.length, 1);
    assert.equal(replies[0].id, null);
    assert.equal(replies[0].error.code, -32600);
  });

  it("a response-shaped message (no method) is an invalid request, not a crash", async () => {
    const { replies } = await exchange(encodeLine({ jsonrpc: "2.0", result: 1 }));
    assert.equal(replies[0].error.code, -32600);
  });

  it("an over-long unterminated line is refused with line-too-long and the connection closes", { timeout: 60_000 }, async () => {
    const { replies } = await exchange(Buffer.alloc(MAX_LINE_BYTES + 1, 0x61), 5000);
    assert.equal(replies[0]?.error?.data?.reason, "line-too-long");
  });
});
