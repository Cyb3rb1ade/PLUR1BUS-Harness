/** Real SSH/SFTP across both shipped worker entry points, including acquisition and containment regressions. */
import assert from "node:assert/strict";
import { setImmediate as turn } from "node:timers/promises";
import { before, test } from "node:test";
import { createSftpFs, probeSftpHostKey } from "../src/sftp.ts";
import type { PrivateKeyLease } from "../src/worker.ts";
import { buildNative, fixture } from "./native-fixture.ts";

before(buildNative, { timeout: 900_000 });

for (const mode of ["standalone", "harness"] as const) {
  test(`${mode}: the real worker exposes only six reads and keeps leased keys out of results`, async () => {
    const host = await fixture(mode);
    try {
      const identity = await probeSftpHostKey(host.options);
      assert.equal(identity.hostKeySha256, host.options.endpoint.hostKeySha256);
      assert.equal(identity.hostKeyAlgorithm, "ssh-ed25519");
      assert.equal(host.released(), 0);
      const marker = host.privateKey.toString().split("\n")[1]!;
      const session = await createSftpFs(host.options);
      try {
        assert.ok(Object.isFrozen(session.fs));
        assert.deepEqual(Object.keys(session.fs).sort(), ["lstat", "readFile", "readdir", "readlink", "realpath", "stat"]);
        const results = [await session.fs.stat("first-home/config.json"), await session.fs.lstat("/__fixture_link__"),
          await session.fs.readdir("first-home"), (await session.fs.readFile("first-home/config.json", 64)).toString(),
          await session.fs.realpath("/__fixture_link__"), await session.fs.readlink("/__fixture_link__")];
        assert.equal((results[0] as { type: string }).type, "file");
        assert.equal((results[1] as { type: string }).type, "symlink");
        assert.equal(results[3], "public-config");
        assert.equal(results[4], "/first-home/config.json");
        assert.equal(results[5], "/first-home/config.json");
        assert.equal(JSON.stringify(results).includes(marker), false);
        assert.equal(host.stderr().includes(marker), false);
        assert.equal(host.released(), 1);
        assert.ok(host.leased.every(key => key.every(byte => byte === 0)));
      } finally { await session.close(); await session.close(); }
    } finally { await host.close(); }
  });

  test(`${mode}: a changed host key wins over invalid private-key authentication`, async () => {
    const host = await fixture(mode);
    const key = Buffer.from("SLOT-KEY-MARKER-NEVER-LOG-THIS");
    let released = 0;
    try {
      const pin = host.options.endpoint.hostKeySha256;
      await assert.rejects(createSftpFs({ ...host.options, endpoint: { ...host.options.endpoint,
        hostKeySha256: `${pin.slice(0, -1)}${pin.endsWith("A") ? "B" : "A"}` },
      async leaseKey() { return { key, release() { released++; } }; } }),
      { reason: "host-key-mismatch", message: "remote-fs: host-key-mismatch" });
      assert.equal(released, 0);
      assert.equal(key.toString(), "SLOT-KEY-MARKER-NEVER-LOG-THIS");
      assert.equal(host.stderr().includes("SLOT-KEY-MARKER"), false);
    } finally { await host.close(); }
  });

  test(`${mode}: malformed leased key bytes produce only a fixed redacted failure`, async () => {
    const host = await fixture(mode);
    const key = Buffer.from("SLOT-KEY-MARKER-NEVER-LOG-THIS");
    let released = 0;
    try {
      let result: unknown;
      try {
        await createSftpFs({ ...host.options, async leaseKey() { return { key, release() { released++; } }; } });
        assert.fail("malformed key must fail authentication");
      } catch (error) { result = error; }
      assert.equal((result as { reason: string }).reason, "authentication-failed");
      assert.equal(String(result), "RemoteFsError: remote-fs: authentication-failed");
      assert.equal(JSON.stringify(result).includes("SLOT-KEY-MARKER"), false);
      assert.equal(host.stderr().includes("SLOT-KEY-MARKER"), false);
      assert.equal(released, 1);
      assert.ok(key.every(byte => byte === 0));
    } finally { await host.close(); }
  });

  test(`${mode}: selected roots reject lexical and static canonical escapes`, async () => {
    const host = await fixture(mode);
    try {
      const session = await createSftpFs({ ...host.options, root: "/first-home" });
      try {
        for (const path of ["../second-home/config.yaml", "/second-home/config.yaml", "escape-parent/config.yaml"]) {
          await assert.rejects(session.fs.stat(path), { reason: "path-denied" });
          await assert.rejects(session.fs.readFile(path, 64), { reason: "path-denied" });
        }
        assert.equal((await session.fs.lstat("escape-parent")).type, "symlink");
        await assert.rejects(session.fs.realpath("escape-parent"), { reason: "path-denied" });
        await assert.rejects(session.fs.readlink("escape-parent"), { reason: "path-denied" });
      } finally { await session.close(); }
    } finally { await host.close(); }
  });

  test(`${mode}: file, total, entry and depth budgets persist across operations`, async () => {
    const host = await fixture(mode);
    try {
      const session = await createSftpFs({ ...host.options, root: "/first-home",
        limits: { maxFileBytes: 13, maxTotalBytes: 20, maxEntries: 3, maxDepth: 1 } });
      try {
        await assert.rejects(session.fs.readFile("config.json", 12), { reason: "file-limit" });
        assert.equal((await session.fs.readFile("config.json", 13)).toString(), "public-config");
        await assert.rejects(session.fs.readFile("config.json", 13), { reason: "total-limit" });
        await assert.rejects(session.fs.stat("nested/deep"), { reason: "depth-limit" });
        assert.equal((await session.fs.readdir(".")).length, 3);
        // Native cumulative entries are enforced before returning the second listing.
        await assert.rejects(session.fs.readdir("."), { reason: "limit-exceeded" });
      } finally { await session.close(); }
    } finally { await host.close(); }
  });

  test(`${mode}: read deadlines and explicit close terminate pending work`, async () => {
    const host = await fixture(mode, 2000);
    try {
      const timed = await createSftpFs({ ...host.options, limits: { timeoutMs: 1000 } });
      try { await assert.rejects(timed.fs.readFile("first-home/config.json", 64), { reason: "timeout" }); }
      finally { await timed.close(); }
      const session = await createSftpFs(host.options);
      const pending = assert.rejects(session.fs.readFile("first-home/config.json", 64), { reason: "unavailable" });
      await turn();
      await session.close();
      await pending;
    } finally { await host.close(); }
  });

  test(`${mode}: untrusted descriptors cannot acquire a private key`, async () => {
    const host = await fixture(mode);
    try {
      await assert.rejects(createSftpFs({ ...host.options, worker: { ...host.options.worker, sha256: "0".repeat(64) } }),
        { reason: "worker-untrusted" });
      assert.equal(host.released(), 0);
      await assert.rejects(createSftpFs({ ...host.options, endpoint: { ...host.options.endpoint, ip: "localhost" } }),
        { reason: "invalid-limit" });
    } finally { await host.close(); }
  });

  test(`${mode}: lstat of the selected nested root stays within that root`, async () => {
    const host = await fixture(mode);
    try {
      const session = await createSftpFs({ ...host.options, root: "/first-home" });
      try { assert.equal((await session.fs.lstat(".")).type, "directory"); }
      finally { await session.close(); }
    } finally { await host.close(); }
  });

  test(`${mode}: readlink checks canonical parents before looking up an external entry`, async () => {
    const host = await fixture(mode);
    try {
      const session = await createSftpFs({ ...host.options, root: "/first-home" });
      try { await assert.rejects(session.fs.readlink("escape-parent/missing"), { reason: "path-denied" }); }
      finally { await session.close(); }
    } finally { await host.close(); }
  });

  test(`${mode}: a late key lease is released and erased after acquisition times out`, async t => {
    const host = await fixture(mode);
    let resolveLease!: (lease: PrivateKeyLease) => void;
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const late = new Promise<PrivateKeyLease>(resolve => { resolveLease = resolve; });
    let released = 0;
    let signal!: AbortSignal;
    try {
      t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
      const pending = createSftpFs({ ...host.options, limits: { timeoutMs: 60_000 }, leaseKey: async stop => {
        signal = stop; started(); return late;
      } });
      await entered;
      const rejection = assert.rejects(pending, { reason: "timeout" });
      t.mock.timers.tick(60_000);
      await rejection;
      const key = Buffer.from(host.privateKey);
      resolveLease({ key, release() { released++; } });
      await turn();
      assert.equal(signal.aborted, true);
      assert.equal(released, 1);
      assert.ok(key.every(byte => byte === 0));
    } finally { t.mock.timers.reset(); await host.close(); }
  });

  test(`${mode}: invalid native limits cannot leave a worker running`, async () => {
    const host = await fixture(mode);
    const processCount = () => process.getActiveResourcesInfo().filter(name => name === "ProcessWrap").length;
    try {
      const baseline = processCount();
      await assert.rejects(createSftpFs({ ...host.options, limits: { maxFileBytes: 2 * 1024 ** 3 } }), { reason: "invalid-limit" });
      await turn();
      assert.equal(processCount(), baseline);
      assert.equal(host.released(), 0);
    } finally { await host.close(); }
  });

  test(`${mode}: aborted acquisitions revoke late leases without hanging close`, async () => {
    const host = await fixture(mode);
    const abort = new AbortController();
    let resolveLease!: (lease: PrivateKeyLease) => void;
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    let released = 0;
    try {
      const pending = createSftpFs({ ...host.options, signal: abort.signal, leaseKey: async () => {
        started(); return new Promise(resolve => { resolveLease = resolve; });
      } });
      await entered;
      const rejection = assert.rejects(pending, { reason: "aborted", message: "remote-fs: aborted" });
      abort.abort(new Error("DO-NOT-LOG-ABORT-CONTENTS"));
      await rejection;
      const key = Buffer.from(host.privateKey);
      resolveLease({ key, release() { released++; } });
      await turn();
      assert.equal(released, 1);
      assert.ok(key.every(byte => byte === 0));
      assert.equal(host.stderr().includes("DO-NOT-LOG"), false);
    } finally { await host.close(); }
  });
}
