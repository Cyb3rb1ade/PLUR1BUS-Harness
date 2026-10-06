import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine } from "../src/framing.ts";
import { RpcCallError, connect } from "../src/client.ts";
import { checkAddress, checkRunDir, checkSocketFile, readRecordedPid, readRunToken, UntrustedRunDir } from "../src/trust.ts";

const T = { timeout: 20_000 };
const posix = { ...T, skip: process.platform === "win32" && "POSIX owner and mode checks" };
const TOKEN = "b".repeat(64);

const made: string[] = [];
const home = () => { const d = mkdtempSync(join(tmpdir(), "p1b-trust-")); made.push(d); return d; };
after(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** `<home>/run/core.sock` listening; counts connections and records every byte received. */
async function fakeCore(runDir: string, hello: unknown = { contract: "1.4.1", rpc: "1.0.0", instanceId: "i", pid: 4242 }) {
  mkdirSync(runDir, { recursive: true });
  const address = join(runDir, "core.sock");
  const seen = { connections: 0, bytes: 0, methods: [] as string[] };
  const server: Server = createServer((sock: Socket) => {
    seen.connections++;
    const dec = new LineDecoder();
    sock.on("data", (chunk) => {
      seen.bytes += chunk.length;
      for (const m of dec.decode(chunk).values as any[]) {
        seen.methods.push(m.method);
        sock.write(encodeLine({ jsonrpc: "2.0", id: m.id, result: m.method === "core.auth" ? hello : {} }));
      }
    });
    sock.on("error", () => {});
  });
  await new Promise<void>((res) => server.listen(address, res));
  return { address, seen, close: () => new Promise<void>((res) => server.close(() => res())) };
}

describe("checkRunDir / checkSocketFile / checkAddress (M2)", () => {
  it("passes a private real run/ and a socket of ours; a missing path is core-absent, not untrusted", posix, async () => {
    const h = home(); const run = join(h, "run");
    mkdirSync(run); chmodSync(run, 0o700);
    assert.deepEqual(checkRunDir(run), { ok: true });
    assert.deepEqual(checkRunDir(join(h, "absent")), { ok: true });
    const core = await fakeCore(run);
    try { assert.deepEqual(checkAddress(core.address), { ok: true }); } finally { await core.close(); }
  });

  it("refuses a group- or other-writable run/", posix, () => {
    const h = home(); const run = join(h, "run");
    mkdirSync(run);
    for (const mode of [0o770, 0o707, 0o777]) {
      chmodSync(run, mode);
      const v = checkRunDir(run);
      assert.equal(v.ok, false, mode.toString(8));
      assert.equal(!v.ok && v.reason, "run-dir-untrusted");
    }
  });

  it("refuses a symlinked run/ even when its target is private", posix, () => {
    const h = home(); const real = join(h, "planted"); mkdirSync(real); chmodSync(real, 0o700);
    symlinkSync(real, join(h, "run"));
    const v = checkRunDir(join(h, "run"));
    assert.equal(!v.ok && v.reason, "run-dir-untrusted");
    assert.match(!v.ok ? v.detail : "", /symlink/);
  });

  it("refuses a run/ of another uid (simulated through the euid seam) and a socket of another uid", posix, async () => {
    const h = home(); const run = join(h, "run");
    mkdirSync(run); chmodSync(run, 0o700);
    const other = (process.geteuid?.() ?? 1000) + 1;
    const dir = checkRunDir(run, { euid: other });
    assert.equal(!dir.ok && dir.reason, "run-dir-untrusted");
    assert.match(!dir.ok ? dir.detail : "", /belongs to uid/);
    const core = await fakeCore(run);
    try {
      const sock = checkSocketFile(core.address, { euid: other });
      assert.equal(!sock.ok && sock.reason, "socket-untrusted");
    } finally { await core.close(); }
  });

  it("refuses a regular file where the socket should be", posix, () => {
    const h = home(); const run = join(h, "run"); mkdirSync(run); chmodSync(run, 0o700);
    writeFileSync(join(run, "core.sock"), "x");
    const v = checkSocketFile(join(run, "core.sock"));
    assert.equal(!v.ok && v.reason, "socket-untrusted");
  });

  it("does nothing on Windows or for a pipe name", T, () => {
    assert.deepEqual(checkRunDir("C:\\x", { platform: "win32" }), { ok: true });
    assert.deepEqual(checkAddress("\\\\.\\pipe\\plur1bus-x-core"), { ok: true });
  });

  it("readRunToken reads from a trusted run/ and throws UntrustedRunDir (reading nothing) otherwise", posix, () => {
    const h = home(); const run = join(h, "run"); mkdirSync(run); chmodSync(run, 0o700);
    writeFileSync(join(run, "core.token"), `${TOKEN}\n`);
    assert.equal(readRunToken(h, join(run, "core.token")), TOKEN);
    chmodSync(run, 0o775);
    assert.throws(() => readRunToken(h, join(run, "core.token")), (e: unknown) => e instanceof UntrustedRunDir && e.reason === "run-dir-untrusted");
  });

  it("readRecordedPid parses the first field and ignores junk", T, () => {
    const h = home(); const f = join(h, "core.pid");
    writeFileSync(f, "4242 some-instance\n"); assert.equal(readRecordedPid(f), 4242);
    writeFileSync(f, "nope\n"); assert.equal(readRecordedPid(f), undefined);
    assert.equal(readRecordedPid(join(h, "absent.pid")), undefined);
  });
});

describe("client connect refuses an untrusted endpoint and sends nothing", () => {
  const refused = (reason: string) => (e: unknown) => e instanceof RpcCallError && e.error === "E_UNAUTHORIZED" && e.reason === reason;
  const quiet = (core: { seen: { connections: number; bytes: number } }) => assert.deepEqual({ c: core.seen.connections, b: core.seen.bytes }, { c: 0, b: 0 }, "nothing may reach the socket");

  it("a group-writable run/ (M2)", posix, async () => {
    const h = home(); const run = join(h, "run");
    const core = await fakeCore(run); chmodSync(run, 0o770);
    try {
      await assert.rejects(connect({ address: core.address, token: TOKEN }), refused("run-dir-untrusted"));
      quiet(core);
    } finally { await core.close(); }
  });

  it("a symlinked run/ (M2)", posix, async () => {
    const h = home(); const planted = join(h, "planted");
    const core = await fakeCore(planted); chmodSync(planted, 0o700);
    symlinkSync(planted, join(h, "run"));
    try {
      await assert.rejects(connect({ address: join(h, "run", "core.sock"), token: TOKEN }), refused("run-dir-untrusted"));
      quiet(core);
    } finally { await core.close(); }
  });

  it("a run/ of another uid (M2, euid seam)", posix, async () => {
    const h = home(); const run = join(h, "run");
    const core = await fakeCore(run); chmodSync(run, 0o700);
    try {
      await assert.rejects(connect({ address: core.address, token: TOKEN, trust: { euid: (process.geteuid?.() ?? 1000) + 1 } }), refused("run-dir-untrusted"));
      quiet(core);
    } finally { await core.close(); }
  });

  it("a private run/ still connects", posix, async () => {
    const h = home(); const run = join(h, "run");
    const core = await fakeCore(run); chmodSync(run, 0o700);
    try {
      const c = await connect({ address: core.address, token: TOKEN });
      assert.equal(c.hello.pid, 4242);
      await c.close();
    } finally { await core.close(); }
  });

  it("Windows without a recorded pid refuses before connecting (M1, Low)", T, async () => {
    const h = home(); const run = join(h, "run"); chmodSync(mkdirSync(run, { recursive: true }) ?? run, 0o700);
    const core = await fakeCore(run);
    try {
      await assert.rejects(connect({ address: core.address, token: TOKEN, platform: "win32" }), refused("server-pid-unknown"));
      quiet(core);
    } finally { await core.close(); }
  });

  it("Windows with a pid lookup that names another process refuses before core.auth is sent (M1)", T, async () => {
    const h = home(); const run = join(h, "run");
    const core = await fakeCore(run);
    try {
      await assert.rejects(
        connect({ address: core.address, token: TOKEN, platform: "win32", expectedServerPid: 4242, serverPidOf: () => 999 }),
        refused("pipe-server-mismatch"),
      );
      assert.equal(core.seen.methods.includes("core.auth"), false, "the token must not be sent");
      assert.equal(core.seen.bytes, 0);
    } finally { await core.close(); }
  });

  it("Windows with a lookup that cannot name the server refuses too (M1)", T, async () => {
    const h = home(); const run = join(h, "run");
    const core = await fakeCore(run);
    try {
      await assert.rejects(
        connect({ address: core.address, token: TOKEN, platform: "win32", expectedServerPid: 4242, serverPidOf: () => undefined }),
        refused("pipe-server-mismatch"),
      );
      assert.equal(core.seen.bytes, 0);
    } finally { await core.close(); }
  });

  it("Windows with a matching pid lookup connects (M1)", T, async () => {
    const h = home(); const run = join(h, "run");
    const core = await fakeCore(run);
    try {
      const c = await connect({ address: core.address, token: TOKEN, platform: "win32", expectedServerPid: 4242, serverPidOf: () => 4242 });
      assert.equal(c.hello.pid, 4242);
      await c.close();
    } finally { await core.close(); }
  });

  it("Windows without a native lookup still refuses a hello that names another pid (M1 fallback)", T, async () => {
    const h = home(); const run = join(h, "run");
    const core = await fakeCore(run, { contract: "1.4.1", rpc: "1.0.0", instanceId: "i", pid: 777 });
    try {
      await assert.rejects(connect({ address: core.address, token: TOKEN, platform: "win32", expectedServerPid: 4242 }), refused("pipe-server-mismatch"));
    } finally { await core.close(); }
  });
});
