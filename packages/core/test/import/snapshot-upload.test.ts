/** Uploaded source capabilities are owner-bound, consumed once, and sealed only after complete validation. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { join, sep } from "node:path";
import fs from "node:fs";
import promises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, truncateSync, writeFileSync,
} from "node:fs";
import { packTarBuffer } from "../../src/import/snapshot.ts";
import { useTempDirs } from "./helpers.ts";

const temp = useTempDirs();
const ID = "q".repeat(43);
const OWNER = "owner-fixture";
const MARKER = "fixture-archive-content-never-in-public-error";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function factory() {
  const module = await import("../../src/import/snapshot-upload.ts");
  assert.equal(typeof module?.claimImportSnapshot, "function", "uploaded snapshots need a real one-use intake");
  return module!;
}

function archive(path = "SOUL.md", content = Buffer.from("persona fixture")) {
  const manifest = Buffer.from(JSON.stringify({
    version: 1, source: "openclaw", sourceRoot: "/foreign", origin: "native", flavour: "native",
    timestamp: "2026-10-28T12:00:00Z", files: [{ path, size: content.length, sha256: hash(content) }],
    sqlite: {}, envKeys: {},
  }));
  return gzipSync(packTarBuffer([{ path: "snapshot.json", content: manifest }, { path, content }]));
}

function archiveFiles(entries: Array<{ path: string; content: Buffer; sourceMode?: number }>, extra: object = {}, manifestLast = false) {
  const manifest = { path: "snapshot.json", content: JSON.stringify({
    version: 1, source: "openclaw", sourceRoot: "/foreign", origin: "native", flavour: "posix",
    timestamp: "2026-10-28T12:00:00Z", files: entries.map(({ path, content, sourceMode }) => ({
      path, size: content.length, sha256: hash(content), ...(sourceMode === undefined ? {} : { sourceMode }),
    })), sqlite: {}, envKeys: {}, ...extra,
  }) };
  return gzipSync(packTarBuffer(manifestLast ? [...entries, manifest] : [manifest, ...entries]));
}

/** Observe the filesystem boundary so deleting a plaintext staging file later cannot satisfy the test. */
async function observeSnapshotWrites(home: string, action: () => Promise<unknown>): Promise<string> {
  const writes: string[] = [];
  const writeSync = fs.writeSync;
  const open = promises.open;
  const observe = (data: unknown) => {
    if (typeof data === "string" || Buffer.isBuffer(data)) writes.push(data.toString());
  };
  fs.writeSync = function (...args: unknown[]) {
    observe(args[1]);
    return Reflect.apply(writeSync, fs, args);
  } as typeof fs.writeSync;
  promises.open = async (...args: Parameters<typeof open>) => {
    const file = await open(...args);
    if (String(args[0]).startsWith(join(home, "import") + sep)) {
      const writeFile = file.writeFile.bind(file);
      file.writeFile = async (data, options) => { observe(data); return writeFile(data, options); };
    }
    return file;
  };
  syncBuiltinESMExports();
  try { await action(); return writes.join("\n"); }
  finally { fs.writeSync = writeSync; promises.open = open; syncBuiltinESMExports(); }
}

function publish(home: string, bytes: Buffer, namespace = "import-snapshots") {
  const dir = join(home, "run", namespace);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, ID), bytes, { mode: 0o600 });
  const metadata = { version: 1, userId: OWNER, expiresAt: Date.now() + 600_000, sha256: hash(bytes), size: bytes.length };
  writeFileSync(join(dir, ID + ".json"), JSON.stringify(metadata), { mode: 0o600 });
  return { dir, metadata };
}

function assertNoClaim(home: string) {
  assert.deepEqual(readdirSync(join(home, "run", "import-snapshots")), []);
  assert.equal(existsSync(join(home, "import", ID)), false);
}

async function rejectsFixed(operation: Promise<unknown>) {
  await assert.rejects(operation, (error: Error) => {
    assert.equal(error.message, "Import source snapshot is unavailable");
    assert.ok(!JSON.stringify(error).includes(MARKER));
    return true;
  });
}

describe("uploaded import snapshots", () => {
  it("seals configurations and omits credential members before the first staging write", async () => {
    const api = await factory();
    const home = temp();
    const canary = "SNAPSHOT-RAW-CREDENTIAL-NEVER-WRITTEN";
    const config = Buffer.from(JSON.stringify({ apiKey: canary, mcp: { servers: {
      private: { command: "node", args: ["--credential", canary], env: { API_TOKEN: canary },
        headers: { Authorization: canary }, oauth: { codeVerifier: canary } },
    } } }));
    const bytes = archiveFiles([
      { path: "openclaw.json", content: config, sourceMode: 0o644 },
      { path: ".env", content: Buffer.from(`VISIBLE_KEY=${canary}\nSECOND_KEY='${canary}'\n`) },
      { path: "credentials/id_ed25519", content: Buffer.from(canary) },
      { path: "auth-profiles.json", content: Buffer.from(canary) },
      { path: "SOUL.md", content: Buffer.from("persona fixture"), sourceMode: 0o640 },
    ], { omittedCredentials: [".env.existing"], envKeys: { ".env.existing": ["EXISTING_KEY"] },
      omittedConfigKeys: [{ path: "previous.apiKey", form: "inline", discardedValue: canary }],
      unknownMetadata: canary }, true);
    publish(home, bytes);
    const written = await observeSnapshotWrites(home, () => api.claimImportSnapshot({ home, snapshotId: ID, userId: OWNER }));
    assert.equal(written.includes(canary), false, "plaintext must never enter any staging write");
    const root = join(home, "import", ID, "snapshot");
    const manifest = JSON.parse(readFileSync(join(root, "snapshot.json"), "utf8"));
    assert.equal(JSON.stringify(manifest).includes(canary), false);
    assert.equal(readFileSync(join(root, "openclaw.json"), "utf8").includes(canary), false);
    assert.equal(existsSync(join(root, ".env")), false);
    assert.equal(existsSync(join(root, "credentials", "id_ed25519")), false);
    assert.equal(existsSync(join(root, "auth-profiles.json")), false);
    assert.deepEqual(manifest.envKeys[".env"], ["VISIBLE_KEY", "SECOND_KEY"]);
    assert.deepEqual(manifest.envKeys[".env.existing"], ["EXISTING_KEY"]);
    assert.ok(manifest.omittedCredentials.includes(".env"));
    assert.deepEqual(manifest.omittedConfigKeys.find((entry: { path: string }) => entry.path === "previous.apiKey"),
      { path: "previous.apiKey", form: "inline" });
    assert.ok(manifest.omittedConfigKeys.some((entry: { path: string }) => entry.path === "apiKey"));
    assert.equal(manifest.files.find((entry: { path: string }) => entry.path === "openclaw.json").sourceMode, 0o644);
    assert.equal(manifest.files.find((entry: { path: string }) => entry.path === "SOUL.md").sourceMode, 0o640);
    for (const entry of manifest.files) {
      const data = readFileSync(join(root, entry.path));
      assert.deepEqual([entry.size, entry.sha256], [data.length, hash(data)]);
    }
  });

  it("authenticates omitted raw members and original configuration bytes before resealing", async () => {
    const api = await factory();
    const config = Buffer.from(JSON.stringify({ apiKey: MARKER }));
    for (const entries of [
      [{ path: "openclaw.json", content: config }],
      [{ path: ".env", content: Buffer.from(`KEY=${MARKER}`) }],
    ]) {
      const home = temp();
      const bytes = archiveFiles(entries, { files: entries.map(({ path, content }) => ({
        path, size: content.length, sha256: "0".repeat(64),
      })) });
      publish(home, bytes);
      const written = await observeSnapshotWrites(home, () => rejectsFixed(api.claimImportSnapshot({ home, snapshotId: ID, userId: OWNER })));
      assert.equal(written.includes(MARKER), false);
      assertNoClaim(home);
    }
  });

  it("validates inventory uniqueness, source permissions, and omission declarations without leaking metadata", async () => {
    const api = await factory();
    const content = Buffer.from("safe persona");
    const duplicate = { path: "SOUL.md", content };
    const cases = [
      archiveFiles([duplicate, duplicate]),
      archiveFiles([{ ...duplicate, sourceMode: 0o1000 }]),
      archiveFiles([duplicate], { omittedConfigKeys: [{ path: "apiKey", form: MARKER }] }),
      archiveFiles([duplicate], { omittedCredentials: ["../" + MARKER] }),
      archiveFiles([duplicate], { files: [{ path: "SOUL.md", size: content.length, sha256: hash(content) },
        { path: "unavailable", size: 0, sha256: hash(Buffer.alloc(0)) }] }),
    ];
    for (const bytes of cases) {
      const home = temp(); publish(home, bytes);
      await rejectsFixed(api.claimImportSnapshot({ home, snapshotId: ID, userId: OWNER }));
      assertNoClaim(home);
    }
  });

  it("counts discarded credentials against the same raw byte and file limits", async () => {
    const api = await factory();
    for (const limits of [{ maxBytes: 1024 }, { maxFiles: 1 }]) {
      const home = temp();
      publish(home, archiveFiles([{ path: ".env", content: Buffer.alloc(2048, 65) }]));
      await rejectsFixed(api.claimImportSnapshot({ home, snapshotId: ID, userId: OWNER, limits }));
      assertNoClaim(home);
    }
  });

  it("retains only names when a credential file exceeds the env-name inspection buffer", async () => {
    const api = await factory();
    const home = temp();
    publish(home, archiveFiles([{ path: ".env", content: Buffer.alloc(1024 * 1024 + 1, 65) }]));
    await api.claimImportSnapshot({ home, snapshotId: ID, userId: OWNER });
    const root = join(home, "import", ID, "snapshot");
    assert.equal(existsSync(join(root, ".env")), false);
    const manifest = JSON.parse(readFileSync(join(root, "snapshot.json"), "utf8"));
    assert.deepEqual(manifest.files, []);
    assert.deepEqual(manifest.omittedCredentials, [".env"]);
    assert.deepEqual(manifest.envKeys, {});
  });

  it("requires the trusted tar sink to consume every raw member and retains its archive limits", async () => {
    const { extractTarStream } = await import("../../src/import/snapshot.ts");
    const path = join(temp(), "staging");
    await assert.rejects(extractTarStream(packTarBuffer([{ path: "private", content: MARKER }]), path,
      { onFile: async () => {} }), error => (error as { reason: string }).reason === "member-unconsumed");
    assert.equal(existsSync(path), false);
    const seen: string[] = [];
    const result = await extractTarStream(packTarBuffer([{ path: "private", content: MARKER }]), path,
      { onFile: async (_entry, chunks) => { for await (const chunk of chunks) seen.push(chunk.toString()); } });
    assert.equal(result.filesCount, 1);
    assert.equal(seen.join(""), MARKER);
    assert.deepEqual(readdirSync(path), []);
  });

  it("consumes one owner capability and seals the streamed root contents with a private receipt", async () => {
    const api = await factory();
    const home = temp();
    const bytes = archive();
    const { dir } = publish(home, bytes);
    const result = await api.claimImportSnapshot({ home, snapshotId: ID, userId: OWNER });
    assert.deepEqual(result, { snapshotId: ID, sha256: hash(bytes), files: 2, bytes: result.bytes });
    assert.equal(readFileSync(join(home, "import", ID, "snapshot", "SOUL.md"), "utf8"), "persona fixture");
    assert.deepEqual(readdirSync(dir), []);
    const receiptPath = join(home, "import", ID, "receipt.json");
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    assert.equal(receipt.schema, "import.source-snapshot/1");
    assert.equal(receipt.manifestSha256, hash(readFileSync(join(home, "import", ID, "snapshot", "snapshot.json"))));
    assert.equal(receipt.userId, OWNER);
    if (process.platform !== "win32") {
      assert.equal(lstatSync(receiptPath).mode & 0o777, 0o600);
      assert.equal(lstatSync(join(home, "import", ID)).mode & 0o777, 0o700);
    }
    await rejectsFixed(api.claimImportSnapshot({ home, snapshotId: ID, userId: OWNER }));
  });

  it("refuses another owner before consuming the upload and cannot use extension upload IDs", async () => {
    const api = await factory();
    const home = temp();
    const { dir } = publish(home, archive());
    await rejectsFixed(api.claimImportSnapshot({ home, snapshotId: ID, userId: "another-owner" }));
    assert.equal(existsSync(join(dir, ID + ".json")), true);
    assert.equal(existsSync(join(dir, ID)), true);
    const otherHome = temp();
    const extension = publish(otherHome, archive(), "uploads");
    await rejectsFixed(api.claimImportSnapshot({ home: otherHome, snapshotId: ID, userId: OWNER }));
    assert.equal(existsSync(join(extension.dir, ID)), true);
    assert.equal(existsSync(join(otherHome, "import")), false);
  });

  it("cleans a claimed upload and staging tree after corrupt hashes, manifests, or unsafe tar members", async () => {
    const api = await factory();
    const cases = [
      gzipSync(packTarBuffer([{ path: "../" + MARKER, content: "outside" }])),
      gzipSync(packTarBuffer([{ path: MARKER, typeflag: "2", linkname: "/outside" }])),
      gzipSync(packTarBuffer([{ path: MARKER, typeflag: "3" }])),
      gzipSync(packTarBuffer([{ path: "snapshot.json", content: MARKER }])),
      gzipSync(packTarBuffer([{ path: "unlisted", content: MARKER }])),
    ];
    for (const bytes of cases) {
      const home = temp();
      publish(home, bytes);
      await rejectsFixed(api.claimImportSnapshot({ home, snapshotId: ID, userId: OWNER }));
      assertNoClaim(home);
    }
    const home = temp();
    const { dir, metadata } = publish(home, archive());
    writeFileSync(join(dir, ID + ".json"), JSON.stringify({ ...metadata, sha256: "0".repeat(64) }));
    await rejectsFixed(api.claimImportSnapshot({ home, snapshotId: ID, userId: OWNER }));
    assertNoClaim(home);
  });

  it("enforces depth and expanded byte limits before sealing", async () => {
    const api = await factory();
    const home = temp();
    publish(home, archive(Array.from({ length: 33 }, () => "d").join("/")));
    await rejectsFixed(api.claimImportSnapshot({ home, snapshotId: ID, userId: OWNER }));
    assertNoClaim(home);
    const limited = temp();
    publish(limited, archive("large", Buffer.alloc(2048)));
    await rejectsFixed(api.claimImportSnapshot({ home: limited, snapshotId: ID, userId: OWNER,
      limits: { maxBytes: 1024 } }));
    assertNoClaim(limited);
  });

  it("rejects oversized compressed bytes, unsafe paths and linked storage without reading archive contents", async () => {
    const api = await factory();
    const home = temp();
    const { dir, metadata } = publish(home, Buffer.from("bad"));
    truncateSync(join(dir, ID), 1024 ** 3 + 1);
    writeFileSync(join(dir, ID + ".json"), JSON.stringify({ ...metadata, size: 1024 ** 3 + 1 }));
    await rejectsFixed(api.claimImportSnapshot({ home, snapshotId: ID, userId: OWNER }));
    assert.equal(existsSync(join(home, "import", ID)), false);
    await rejectsFixed(api.claimImportSnapshot({ home, snapshotId: "../" + ID, userId: OWNER }));
    const linkedHome = temp();
    const outside = temp();
    mkdirSync(join(linkedHome, "run"));
    symlinkSync(outside, join(linkedHome, "run", "import-snapshots"), process.platform === "win32" ? "junction" : "dir");
    await rejectsFixed(api.claimImportSnapshot({ home: linkedHome, snapshotId: ID, userId: OWNER }));
    assert.deepEqual(readdirSync(outside), []);
  });

  it("honours cancellation without claiming the upload or accepting the caller's abort reason", async () => {
    const api = await factory();
    const home = temp();
    const { dir } = publish(home, archive());
    const controller = new AbortController();
    controller.abort(new Error(MARKER));
    await rejectsFixed(api.claimImportSnapshot({ home, snapshotId: ID, userId: OWNER, signal: controller.signal }));
    assert.equal(existsSync(join(dir, ID + ".json")), true);
  });
});

describe("interrupted snapshot intake", () => {
  it("prunes only expired claims after the full worker grace and retains active owner uploads", async () => {
    const api = await factory();
    assert.equal(typeof api.pruneImportSnapshotClaims, "function");
    const home = temp();
    const { dir, metadata } = publish(home, archive());
    const claim = `.${ID}.claim-${"a".repeat(32)}.json`;
    renameSync(join(dir, ID + ".json"), join(dir, claim));
    writeFileSync(join(dir, claim), JSON.stringify({ ...metadata, expiresAt: Date.now() - 600_001 }));
    const active = "r".repeat(43);
    writeFileSync(join(dir, active), "active archive");
    writeFileSync(join(dir, `.${active}.claim-${"b".repeat(32)}.json`), JSON.stringify(metadata));
    const malformed = ".caller-controlled-claim.json";
    writeFileSync(join(dir, malformed), MARKER);
    await api.pruneImportSnapshotClaims(home);
    assert.equal(existsSync(join(dir, claim)), false);
    assert.equal(existsSync(join(dir, ID)), false);
    assert.equal(existsSync(join(dir, active)), true);
    assert.equal(existsSync(join(dir, malformed)), true);
  });
});
