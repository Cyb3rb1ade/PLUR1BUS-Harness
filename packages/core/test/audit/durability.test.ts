import { it, mock } from "node:test";
import assert from "node:assert/strict";
import fs, { readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { createAuditChain, ACTIVE_NAME, ANCHOR_NAME, hashLine } from "../../src/audit/chain.ts";
import { tempDir } from "../helpers/temp-dir.ts";

const event = { at: 1, actor: { user: "u", host: "h" }, action: "test", target: "t", detail: {} };
it("syncs both record and anchor files plus the directory before releasing the writer lock on POSIX", () => {
  const dir = tempDir("audit-durable-");
  const synced: string[] = [];
  const original = fs.fsyncSync;
  const spy = mock.method(fs, "fsyncSync", (fd: number) => { synced.push(fs.fstatSync(fd).isDirectory() ? "directory" : "file"); original(fd); });
  syncBuiltinESMExports();
  try { createAuditChain({ dir }).append(event); }
  finally { spy.mock.restore(); syncBuiltinESMExports(); }
  assert.deepEqual(synced, process.platform === "win32" ? ["file", "file"] : ["file", "file", "directory"]);
  assert.equal(createAuditChain({ dir }).verify().ok, true);
});

it("flushes torn evidence before truncating it and committing the next record", () => {
  const dir = tempDir("audit-torn-durable-"); const chain = createAuditChain({ dir });
  chain.append(event);
  fs.appendFileSync(path.join(dir, ACTIVE_NAME), "torn evidence");
  const operations: string[] = [];
  const originalSync = fs.fsyncSync; const originalTruncate = fs.truncateSync;
  const syncing = mock.method(fs, "fsyncSync", (fd: number) => { operations.push(fs.fstatSync(fd).isDirectory() ? "directory" : "file"); originalSync(fd); });
  const truncating = mock.method(fs, "truncateSync", (file: fs.PathLike, length?: number) => { operations.push("truncate"); originalTruncate(file, length); });
  syncBuiltinESMExports();
  try { chain.append(event); }
  finally { syncing.mock.restore(); truncating.mock.restore(); syncBuiltinESMExports(); }
  assert.deepEqual(operations, process.platform === "win32" ? ["file", "truncate", "file", "file"] : ["file", "directory", "truncate", "file", "file", "directory"]);
});

it("completes short writes for both the record and anchor before reporting success", () => {
  const dir = tempDir("audit-short-write-"); const chain = createAuditChain({ dir });
  const original = fs.writeSync;
  const short = mock.method(fs, "writeSync", (fd: number, data: string | Uint8Array, offset?: number, length?: number) => {
    const bytes = typeof data === "string" ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const start = typeof data === "string" ? 0 : offset ?? 0;
    const remaining = typeof data === "string" ? bytes.length : length ?? bytes.length - start;
    return original(fd, bytes, start, Math.max(1, Math.floor(remaining / 2)));
  });
  syncBuiltinESMExports();
  try { chain.append({ ...event, target: "Unicode ü 😀" }); }
  finally { short.mock.restore(); syncBuiltinESMExports(); }
  assert.deepEqual([chain.verify().ok, chain.verify().records, chain.verify().anchor.status], [true, 1, "match"]);
});

it("refuses a write with no progress without advancing or replacing the previous anchor", () => {
  const dir = tempDir("audit-zero-write-"); const chain = createAuditChain({ dir });
  chain.append(event);
  const anchor = readFileSync(path.join(dir, ANCHOR_NAME), "utf8");
  const zero = mock.method(fs, "writeSync", () => 0);
  syncBuiltinESMExports();
  try { assert.throws(() => chain.append(event), /write made no progress/); }
  finally { zero.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(readFileSync(path.join(dir, ANCHOR_NAME), "utf8"), anchor);
  assert.deepEqual([chain.verify().ok, chain.verify().records], [true, 1]);
});

it("checks an external pin at an older rotated sequence and detects a consistent complete rewrite", () => {
  const dir = tempDir("audit-pin-");
  const chain = createAuditChain({ dir });
  chain.append(event);
  const old = chain.verify();
  chain.rotate(); chain.append({ ...event, at: 2 });
  assert.equal(chain.verify({ seq: 1, hash: old.lastHash! }).ok, true);
  assert.deepEqual(chain.verify({ seq: 99, hash: old.lastHash! }).findings.map(f => f.code), ["pin-missing"]);
  const rotated = path.join(dir, "audit-chain.0000000001.jsonl");
  const first = JSON.parse(readFileSync(rotated, "utf8")); first.rec.target = "rewritten";
  const firstLine = JSON.stringify(first); writeFileSync(rotated, firstLine + "\n");
  const active = path.join(dir, ACTIVE_NAME);
  const second = JSON.parse(readFileSync(active, "utf8")); second.prev = hashLine(firstLine);
  const secondLine = JSON.stringify(second); writeFileSync(active, secondLine + "\n");
  writeFileSync(path.join(dir, ANCHOR_NAME), JSON.stringify({ v: 1, seq: 2, hash: hashLine(secondLine) }));
  assert.equal(chain.verify().ok, true); // A consistent rewrite cannot be detected without external evidence.
  const pinned = chain.verify({ seq: 1, hash: old.lastHash! });
  assert.equal(pinned.ok, false);
  assert.deepEqual(pinned.findings.map(f => [f.code, f.seq]), [["pin-mismatch", 1]]);
});

it("KNOWN GAP: native Windows directory-entry durability requires a host capability beyond portable Node fsync", { todo: true }, () => {
  assert.fail("file contents are fsynced, but portable Node does not guarantee directory-entry flush on Windows");
});
