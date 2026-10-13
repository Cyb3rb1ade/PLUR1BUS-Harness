// core/import readonly.ts (docs/import.md §8.2: "Nothing here writes to a source path"). The existing readonly.test.ts covers the
// SQLite copy/immutable machinery; this file adds the invariant itself as a hash-and-timestamp comparison of the whole source
// directory after every way of opening, plus the pure helpers it leaves out (isSecretFileName, envKeyNames edges, readBounded,
// isFile/isDir, sqliteWarning, sqliteTables, copyFileBounded).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  copyFileBounded, envKeyNames, isDir, isFile, isSecretFileName, openSqliteReadOnly, readBounded, sqliteTables, sqliteWarning,
  type SqliteHandle,
} from "../../src/import/readonly.ts";
import { ImportError } from "../../src/import/types.ts";
import { mulberry32, snapshotTree, useTempDirs } from "./helpers.ts";

const tmpDir = useTempDirs();
const MARKER = "redact-probe-alpha";
const posixOnly = process.platform === "win32" ? "POSIX symlinks and modes" : undefined;

function makeDb(file: string, rows = 3): void {
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT)");
  for (let i = 0; i < rows; i++) db.prepare("INSERT INTO notes(body) VALUES (?)").run(`row-${i}`);
  db.close();
}
const count = (h: SqliteHandle) => (h.db.prepare("SELECT count(*) AS c FROM notes").get() as { c: number }).c;

describe("openSqliteReadOnly never changes the source directory", () => {
  it("copy mode: contents, sizes, timestamps and the file list are identical afterwards, and nothing is left in the staging directory", () => {
    const src = tmpDir(); const stage = tmpDir();
    makeDb(path.join(src, "a.db"), 5);
    const before = snapshotTree(src);
    const h = openSqliteReadOnly(path.join(src, "a.db"), { stagingDir: stage });
    assert.deepEqual([h.mode, h.immutableReason, h.attempts, count(h)], ["copy", null, 1, 5]);
    assert.equal(readdirSync(stage).length, 1, "one private copy directory while the handle is open");
    h.close();
    assert.deepEqual(snapshotTree(src), before);
    assert.deepEqual(readdirSync(stage), [], "close() removes the copy");
  });

  it("copy mode with a live writer: rows still in the WAL are read, and neither the db nor the WAL nor any other file changed", () => {
    const src = tmpDir(); const stage = tmpDir();
    const writer = new DatabaseSync(path.join(src, "live.db"));
    try {
      writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT)");
      for (let i = 0; i < 4; i++) writer.prepare("INSERT INTO notes(body) VALUES (?)").run(`wal-row-${i}`);
      assert.ok(existsSync(path.join(src, "live.db-wal")) && statSync(path.join(src, "live.db-wal")).size > 0, "the rows are in the WAL, not in the main file");
      const before = snapshotTree(src);
      const h = openSqliteReadOnly(path.join(src, "live.db"), { stagingDir: stage });
      assert.deepEqual([h.mode, count(h)], ["copy", 4]);
      h.close();
      assert.deepEqual(snapshotTree(src), before);
    } finally { writer.close(); }
  });

  it("immutable mode (database above the copy limit): same guarantee, the staging directory is never used", () => {
    const src = tmpDir(); const stage = tmpDir();
    makeDb(path.join(src, "a.db"), 2);
    const before = snapshotTree(src);
    const h = openSqliteReadOnly(path.join(src, "a.db"), { stagingDir: stage, maxCopyBytes: 1 });
    assert.deepEqual([h.mode, h.immutableReason, h.attempts, count(h)], ["immutable", "too-large", 0, 2]);
    assert.throws(() => h.db.exec("INSERT INTO notes(body) VALUES ('x')"), /readonly/i, "the immutable handle cannot write");
    h.close();
    assert.deepEqual(snapshotTree(src), before);
    assert.deepEqual(readdirSync(stage), []);
  });

  it("writing through the copy handle changes only the private copy, never the source", () => {
    const src = tmpDir(); const stage = tmpDir();
    makeDb(path.join(src, "a.db"), 1);
    const before = snapshotTree(src);
    const h = openSqliteReadOnly(path.join(src, "a.db"), { stagingDir: stage });
    h.db.exec("INSERT INTO notes(body) VALUES ('only in the copy')");
    assert.equal(count(h), 2);
    h.close();
    assert.deepEqual(snapshotTree(src), before);
  });

  it("the private copy lives in a p1b-import-sqlite-* directory of the staging dir and is owner-only", { skip: posixOnly }, () => {
    const src = tmpDir(); const stage = tmpDir();
    makeDb(path.join(src, "a.db"));
    let copyPath = ""; let copyMode = 0;
    const h = openSqliteReadOnly(path.join(src, "a.db"), { stagingDir: stage, afterCopy: (_a, copy) => { copyPath = copy; copyMode = statSync(copy).mode & 0o777; } });
    h.close();
    assert.equal(path.dirname(path.dirname(copyPath)), stage);
    assert.match(path.basename(path.dirname(copyPath)), /^p1b-import-sqlite-/);
    assert.equal(copyMode, 0o600 & ~process.umask());
  });

  it("a file that is not a SQLite database never touches the source and never leaks a staging directory, with the documented back-off 50, 200, 800 ms", () => {
    const src = tmpDir(); const stage = tmpDir();
    writeFileSync(path.join(src, "garbage.db"), "this is plain text, not a database\n".repeat(30));
    const before = snapshotTree(src);
    const sleeps: number[] = [];
    assert.throws(() => openSqliteReadOnly(path.join(src, "garbage.db"), { stagingDir: stage, onBusy: "throw", sleep: (ms) => sleeps.push(ms) }), (e: unknown) => {
      assert.ok(e instanceof ImportError);
      assert.deepEqual([e.code, e.reason, e.exit], ["E_SOURCE_BUSY", "source-busy", 3]);
      assert.match(e.message, /4 attempts/);
      return true;
    });
    assert.deepEqual(sleeps, [50, 200, 800]);
    assert.deepEqual(readdirSync(stage), []);
    assert.deepEqual(snapshotTree(src), before);
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert - a text file is reported like a database that kept changing (SQLITE_NOTADB counts as a torn read, docs/import.md §B.5)", () => {
    const src = tmpDir(); const stage = tmpDir();
    writeFileSync(path.join(src, "garbage.db"), "not a database ".repeat(40));
    const h = openSqliteReadOnly(path.join(src, "garbage.db"), { stagingDir: stage, sleep: () => {} });
    try {
      assert.deepEqual([h.mode, h.immutableReason, h.attempts], ["immutable", "source-busy", 4]);
      assert.throws(() => h.db.prepare("SELECT 1 FROM sqlite_master").get(), (e: unknown) => e instanceof ImportError && e.code === "E_SOURCE_BUSY");
    } finally { h.close(); }
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert - a missing database path throws the raw ENOENT error, not an ImportError", () => {
    assert.throws(() => openSqliteReadOnly(path.join(tmpDir(), "nope.db")), (e: unknown) => !(e instanceof ImportError) && (e as NodeJS.ErrnoException).code === "ENOENT");
  });

  it("an empty file is a valid empty database (copy mode, no tables)", () => {
    const src = tmpDir(); const stage = tmpDir();
    writeFileSync(path.join(src, "empty.db"), "");
    const h = openSqliteReadOnly(path.join(src, "empty.db"), { stagingDir: stage });
    try { assert.deepEqual([h.mode, sqliteTables(h.db)], ["copy", []]); } finally { h.close(); }
  });

  it("sqliteTables lists tables only (no views, no indexes), including sqlite_sequence", () => {
    const src = tmpDir(); const stage = tmpDir();
    const db = new DatabaseSync(path.join(src, "t.db"));
    db.exec("CREATE TABLE a(id INTEGER PRIMARY KEY AUTOINCREMENT, x); CREATE TABLE b(y); CREATE VIEW v AS SELECT 1; CREATE INDEX i ON a(x)");
    db.close();
    const h = openSqliteReadOnly(path.join(src, "t.db"), { stagingDir: stage });
    try { assert.deepEqual(sqliteTables(h.db).sort(), ["a", "b", "sqlite_sequence"]); } finally { h.close(); }
  });
});

describe("sqliteWarning", () => {
  const handle = (immutableReason: SqliteHandle["immutableReason"]) => ({ immutableReason }) as SqliteHandle;
  it("is null for a checked copy", () => assert.equal(sqliteWarning(handle(null), "x.db"), null));
  it("names the label and says why the WAL was not read", () => {
    const big = sqliteWarning(handle("too-large"), "memory/main.db")!;
    assert.ok(big.startsWith("memory/main.db: ") && /larger than the copy limit/.test(big) && /without its WAL/.test(big), big);
    const busy = sqliteWarning(handle("source-busy"), "memory/main.db")!;
    assert.ok(busy.startsWith("memory/main.db: ") && /kept changing/.test(busy) && /source-busy/.test(busy) && /without its WAL/.test(busy), busy);
  });
});

describe("copyFileBounded", () => {
  it("copies exactly, reports the byte counts, and leaves the source untouched (seeded sizes around the 64 KiB chunk)", () => {
    const d = tmpDir();
    const SEED = 0xb0b0;
    const rnd = mulberry32(SEED);
    for (const size of [0, 1, 65535, 65536, 65537, 131072, 150001]) {
      const bytes = Buffer.from(Array.from({ length: size }, () => Math.floor(rnd() * 256)));
      writeFileSync(path.join(d, `s${size}`), bytes);
      const before = snapshotTree(d).filter((x) => x.startsWith(`s${size}|`));
      const r = copyFileBounded(path.join(d, `s${size}`), path.join(d, `d${size}`), 1 << 20);
      assert.deepEqual(r, { bytesCopied: size, initialSize: size }, `seed=0x${SEED.toString(16)} size=${size}`);
      assert.ok(readFileSync(path.join(d, `d${size}`)).equals(bytes), `size=${size}`);
      assert.deepEqual(snapshotTree(d).filter((x) => x.startsWith(`s${size}|`)), before);
    }
  });

  it("refuses a file above the limit before creating the destination; the limit itself is allowed", () => {
    const d = tmpDir();
    writeFileSync(path.join(d, "s"), "12345");
    assert.throws(() => copyFileBounded(path.join(d, "s"), path.join(d, "d"), 4), /exceeds copy limit \(5 > 4\)/);
    assert.ok(!existsSync(path.join(d, "d")));
    assert.equal(copyFileBounded(path.join(d, "s"), path.join(d, "d"), 5).bytesCopied, 5);
  });

  it("a missing source throws ENOENT and creates no destination", () => {
    const d = tmpDir();
    assert.throws(() => copyFileBounded(path.join(d, "nope"), path.join(d, "d"), 10), { code: "ENOENT" });
    assert.ok(!existsSync(path.join(d, "d")));
  });
});

describe("isSecretFileName", () => {
  const secret = [".env", ".ENV", ".env.local", ".env.production", ".Env.Staging", "auth.json", "Auth.JSON", "credentials.json", ".netrc", ".npmrc", ".pypirc",
    "server.pem", "KEY.PEM", "tls.key", "SERVER.KEY", "id_rsa", "id_rsa.pub", "id_rsa_backup", "id_ed25519", "id_ed25519.pub", "id_ecdsa", "ID_RSA"];
  const plain = ["env", ".environment", "environment.md", "README.md", "SKILL.md", "auth.json.md", "credentials.jsonl", "monkey", "turkey", "keyboard.md", "key", "pem",
    "mykey", ".keys", "idrsa", "authjson", "netrc", "notes.env", "env.local"];
  for (const name of secret) it(`secret: ${name}`, () => assert.equal(isSecretFileName(name), true));
  for (const name of plain) it(`not secret: ${name}`, () => assert.equal(isSecretFileName(name), false));

  it("characterization: Ist-Verhalten, nicht spezifiziert - other common credential files are not on the list (id_dsa, .git-credentials, .aws, token.json, service-account.json, .p12)", () => {
    for (const name of ["id_dsa", ".git-credentials", "token.json", "service-account.json", "client_secret.json", "keystore.p12", "secrets.yaml", ".pgpass"]) {
      assert.equal(isSecretFileName(name), false, name);
    }
  });
});

describe("envKeyNames", () => {
  const read = (content: string | Buffer) => { const f = path.join(tmpDir(), ".env"); writeFileSync(f, content); return envKeyNames(f); };

  it("returns names only: values, comments and malformed lines never appear in the result", () => {
    const keys = read(`# header ${MARKER}\nexport A=${MARKER}-1\nB="x=y ${MARKER}"\n  C = ${MARKER}\nnot a line ${MARKER}\n1BAD=${MARKER}\nD:${MARKER}\n`);
    assert.deepEqual(keys, ["A", "B", "C"]);
    assert.ok(!JSON.stringify(keys).includes(MARKER));
  });

  it("handles CRLF, a UTF-8 BOM, UTF-16LE with BOM, duplicates (kept once, first position) and lower-case, digit and underscore names", () => {
    assert.deepEqual(read("A=1\r\nB=2\r\n"), ["A", "B"]);
    assert.deepEqual(read(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("A=1\nB=2\n")])), ["A", "B"]);
    assert.deepEqual(read(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("A=1\nB=2\n", "utf16le")])), ["A", "B"]);
    assert.deepEqual(read("A=1\nB=2\nA=3\n"), ["A", "B"]);
    assert.deepEqual(read("lower=1\n_under=2\nWITH_9=3\nexport  SPACED=4\n"), ["lower", "_under", "WITH_9", "SPACED"]);
  });

  it("is an empty list for a missing file, a directory, an undecodable file, an empty file and a file over 1 MiB", () => {
    const d = tmpDir();
    assert.deepEqual(envKeyNames(path.join(d, "missing")), []);
    assert.deepEqual(envKeyNames(d), []);
    assert.deepEqual(read(Buffer.from([0x41, 0x3d, 0xff])), []);
    assert.deepEqual(read(""), []);
    assert.deepEqual(read(`BIG=${"x".repeat(1024 * 1024)}\n`), [], "one byte over 1 MiB is refused");
    assert.deepEqual(read(`BIG=${"x".repeat(1024 * 1024 - 5)}\n`), ["BIG"], "just under the limit is read");
  });

  it("does not follow a symlink (the file is read with readSourceFileSafe)", { skip: posixOnly }, () => {
    const d = tmpDir();
    writeFileSync(path.join(d, "real"), "A=1\n");
    symlinkSync(path.join(d, "real"), path.join(d, ".env"));
    assert.deepEqual(envKeyNames(path.join(d, ".env")), []);
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert - a line inside a multi-line quoted value that looks like KEY=... is listed as a key; 'export=1' lists 'export'", () => {
    assert.deepEqual(read(`A="first line\nB=second line"\n`), ["A", "B"]);
    assert.deepEqual(read("export=1\n"), ["export"]);
  });
});

describe("readBounded, isFile, isDir", () => {
  it("returns the decoded text of a regular file, at the limit and with a BOM removed; empty text is '' and not null", () => {
    const d = tmpDir();
    writeFileSync(path.join(d, "f"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("abc")]));
    writeFileSync(path.join(d, "e"), "");
    assert.equal(readBounded(path.join(d, "f"), 6), "abc");
    assert.equal(readBounded(path.join(d, "e"), 0), "");
  });

  it("returns null for a missing path, a directory, a file over the limit (also by one byte), and undecodable text", () => {
    const d = tmpDir();
    writeFileSync(path.join(d, "f"), "abcd");
    writeFileSync(path.join(d, "bad"), Buffer.from([0x61, 0xff]));
    assert.equal(readBounded(path.join(d, "f"), 4), "abcd");
    assert.equal(readBounded(path.join(d, "f"), 3), null);
    assert.equal(readBounded(path.join(d, "missing"), 100), null);
    assert.equal(readBounded(d, 100), null);
    assert.equal(readBounded(path.join(d, "bad"), 100), null);
  });

  it("follows a symlink to a regular file (dotfile managers link config files) and treats a dangling link as missing", { skip: posixOnly }, () => {
    const d = tmpDir();
    writeFileSync(path.join(d, "real"), "linked");
    symlinkSync(path.join(d, "real"), path.join(d, "link"));
    symlinkSync(path.join(d, "nowhere"), path.join(d, "dangling"));
    mkdirSync(path.join(d, "dir"));
    symlinkSync(path.join(d, "dir"), path.join(d, "dirlink"));
    assert.equal(readBounded(path.join(d, "link"), 100), "linked");
    assert.equal(readBounded(path.join(d, "dangling"), 100), null);
    assert.equal(readBounded(path.join(d, "dirlink"), 100), null);
    assert.deepEqual([isFile(path.join(d, "link")), isFile(path.join(d, "dangling")), isFile(path.join(d, "dirlink")), isFile(path.join(d, "dir"))], [true, false, false, false]);
    assert.deepEqual([isDir(path.join(d, "dirlink")), isDir(path.join(d, "dir")), isDir(path.join(d, "link")), isDir(path.join(d, "dangling")), isDir(path.join(d, "missing"))], [true, true, false, false, false]);
  });

  it("an unreadable file (mode 000) is null, not an exception", { skip: process.platform === "win32" || process.getuid?.() === 0 ? "needs a non-root POSIX user" : undefined }, () => {
    const d = tmpDir();
    writeFileSync(path.join(d, "f"), "x");
    chmodSync(path.join(d, "f"), 0);
    try { assert.equal(readBounded(path.join(d, "f"), 10), null); } finally { chmodSync(path.join(d, "f"), 0o600); }
  });
});
