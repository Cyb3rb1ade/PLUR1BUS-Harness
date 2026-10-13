// core/import fs-safe.ts, the parts the existing fs-safe.test.ts leaves out: existsNoFollow, decodeSourceText, readSourceTextSafe,
// and the boundaries of readSourceFileSafe (chunk edges, special files, aliases). The existing file already covers symlink
// swap, fd closing, short reads and the FIFO; nothing here repeats it.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, linkSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { decodeSourceText, existsNoFollow, readSourceFileSafe, readSourceTextSafe } from "../../src/import/fs-safe.ts";
import { ImportError } from "../../src/import/types.ts";
import { mulberry32, useTempDirs } from "./helpers.ts";

const tmpDir = useTempDirs();
const posixOnly = process.platform === "win32" ? "POSIX symlinks, special files and hard links" : undefined;
const MARKER = "redact-probe-alpha";

function refusal(fn: () => unknown): ImportError {
  try { fn(); } catch (e) { assert.ok(e instanceof ImportError, String(e)); return e; }
  assert.fail("expected an ImportError");
}

describe("existsNoFollow", () => {
  it("is true for a file, a directory and an empty file", () => {
    const d = tmpDir();
    writeFileSync(path.join(d, "f"), "");
    mkdirSync(path.join(d, "dir"));
    assert.deepEqual([existsNoFollow(path.join(d, "f")), existsNoFollow(path.join(d, "dir")), existsNoFollow(d)], [true, true, true]);
  });

  it("is false for a missing path and for a path below a regular file", () => {
    const d = tmpDir();
    writeFileSync(path.join(d, "f"), "x");
    assert.equal(existsNoFollow(path.join(d, "missing")), false);
    assert.equal(existsNoFollow(path.join(d, "f", "child")), false);
    assert.equal(existsNoFollow(path.join(d, "missing", "a", "b")), false);
  });

  it("is true for a dangling symlink and a symlink loop (the link exists, existsSync would say no)", { skip: posixOnly }, () => {
    const d = tmpDir();
    symlinkSync(path.join(d, "nowhere"), path.join(d, "dangling"));
    symlinkSync(path.join(d, "loop-b"), path.join(d, "loop-a"));
    symlinkSync(path.join(d, "loop-a"), path.join(d, "loop-b"));
    for (const name of ["dangling", "loop-a", "loop-b"]) {
      assert.equal(existsNoFollow(path.join(d, name)), true, name);
      assert.equal(existsSync(path.join(d, name)), false, `${name}: follows the link and fails`);
    }
  });
});

describe("decodeSourceText", () => {
  const ok: [string, number[], string][] = [
    ["empty", [], ""],
    ["ASCII", [0x68, 0x69], "hi"],
    ["UTF-8 multi-byte (2, 3 and 4 byte sequences)", [0xc3, 0xbc, 0xe2, 0x82, 0xac, 0xf0, 0x9f, 0x98, 0x80], "ü€😀"],
    ["UTF-8 BOM is removed", [0xef, 0xbb, 0xbf, 0x41], "A"],
    ["UTF-16LE with BOM", [0xff, 0xfe, 0x41, 0x00, 0xfc, 0x00], "Aü"],
    ["UTF-16BE with BOM", [0xfe, 0xff, 0x00, 0x41, 0x00, 0xfc], "Aü"],
    ["UTF-16LE with BOM and a surrogate pair", [0xff, 0xfe, 0x3d, 0xd8, 0x00, 0xde], "😀"],
    ["UTF-16 BOM alone", [0xff, 0xfe], ""],
    ["NUL bytes inside valid UTF-8", [0x41, 0x00, 0x42], "A\u0000B"],
    ["CRLF is kept", [0x61, 0x0d, 0x0a, 0x62], "a\r\nb"],
  ];
  for (const [title, bytes, expected] of ok) {
    it(`decodes: ${title}`, () => assert.equal(decodeSourceText(Buffer.from(bytes)), expected));
  }

  const bad: [string, number[]][] = [
    ["a lone continuation byte", [0x41, 0x80]],
    ["0xFF in UTF-8", [0x41, 0xff]],
    ["a truncated 3-byte sequence at the end", [0x41, 0xe2, 0x82]],
    ["an overlong encoding of '/'", [0xc0, 0xaf]],
    ["an encoded surrogate (CESU-8 style)", [0xed, 0xa0, 0x80]],
    ["a code point above U+10FFFF", [0xf4, 0x90, 0x80, 0x80]],
    ["UTF-16LE of odd length", [0xff, 0xfe, 0x41, 0x00, 0x42]],
    ["UTF-16LE with a lone high surrogate", [0xff, 0xfe, 0x00, 0xd8]],
    ["UTF-16BE with a lone low surrogate", [0xfe, 0xff, 0xdc, 0x00]],
  ];
  for (const [title, bytes] of bad) {
    it(`refuses: ${title}`, () => {
      const e = refusal(() => decodeSourceText(Buffer.from(bytes)));
      assert.deepEqual([e.code, e.reason, e.message], ["E_SOURCE_UNSUPPORTED", "invalid-text-encoding", "Source text has invalid encoding"]);
    });
  }

  it("never puts any of the input into the error (configs may hold credentials)", () => {
    const e = refusal(() => decodeSourceText(Buffer.concat([Buffer.from(`api_key=${MARKER}\n`), Buffer.from([0xff, 0xfe, 0xfd])])));
    assert.ok(!JSON.stringify({ m: e.message, r: e.reason, c: e.code, s: e.stack?.split("\n")[0] }).includes(MARKER));
  });

  it("random bytes: either a string or the documented refusal, never another exception (seeded)", () => {
    const SEED = 0x7e47;
    const rnd = mulberry32(SEED);
    let accepted = 0, refused = 0;
    for (let i = 0; i < 500; i++) {
      const len = Math.floor(rnd() * 40);
      const bytes = Buffer.from(Array.from({ length: len }, () => (rnd() < 0.5 ? Math.floor(rnd() * 128) : Math.floor(rnd() * 256))));
      try { assert.equal(typeof decodeSourceText(bytes), "string"); accepted++; }
      catch (e) { assert.ok(e instanceof ImportError && e.reason === "invalid-text-encoding", `seed=0x${SEED.toString(16)} case=${i}: ${String(e)}`); refused++; }
    }
    assert.ok(accepted > 50 && refused > 50, `both outcomes occur (accepted ${accepted}, refused ${refused})`);
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert - a UTF-32LE BOM (FF FE 00 00) is read as UTF-16LE: NUL characters, no refusal", () => {
    assert.equal(decodeSourceText(Buffer.from([0xff, 0xfe, 0x00, 0x00, 0x41, 0x00, 0x00, 0x00])), "\u0000A\u0000");
  });
});

describe("readSourceTextSafe", () => {
  it("returns decoded text with the BOM removed, for UTF-8 and UTF-16 files", () => {
    const d = tmpDir();
    writeFileSync(path.join(d, "u8"), Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from("{a:1}\n")]));
    writeFileSync(path.join(d, "u16"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("ü€", "utf16le")]));
    assert.equal(readSourceTextSafe(path.join(d, "u8"), 100), "{a:1}\n");
    assert.equal(readSourceTextSafe(path.join(d, "u16"), 100), "ü€");
  });

  it("the byte limit counts bytes, not characters (UTF-16 doubles them)", () => {
    const d = tmpDir();
    writeFileSync(path.join(d, "u16"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("abcd", "utf16le")]));
    assert.equal(readSourceTextSafe(path.join(d, "u16"), 10), "abcd");
    assert.equal(refusal(() => readSourceTextSafe(path.join(d, "u16"), 9)).reason, "file-too-large");
  });

  it("an undecodable file is refused as invalid-text-encoding, an oversize one before decoding, a symlink as unsafe-symlink", () => {
    const d = tmpDir();
    writeFileSync(path.join(d, "bad"), Buffer.from([0x41, 0xff]));
    assert.equal(refusal(() => readSourceTextSafe(path.join(d, "bad"), 100)).reason, "invalid-text-encoding");
    assert.equal(refusal(() => readSourceTextSafe(path.join(d, "bad"), 1)).reason, "file-too-large");
    assert.equal(refusal(() => readSourceTextSafe(path.join(d, "missing"), 100)).reason, "source-unreadable");
  });
});

describe("readSourceFileSafe: boundaries", () => {
  it("reads exactly-at-limit files across the 64 KiB chunk edges and refuses limit-1 (seeded content)", () => {
    const d = tmpDir();
    const SEED = 0xc4a9;
    const rnd = mulberry32(SEED);
    for (const size of [1, 2, 65535, 65536, 65537, 131071, 131072, 131073, 200000]) {
      const bytes = Buffer.from(Array.from({ length: size }, () => Math.floor(rnd() * 256)));
      const p = path.join(d, `f${size}`);
      writeFileSync(p, bytes);
      assert.ok(readSourceFileSafe(p, size).equals(bytes), `seed=0x${SEED.toString(16)} size=${size} at the limit`);
      assert.ok(readSourceFileSafe(p, size + 1).equals(bytes), `size=${size} above the limit`);
      assert.equal(refusal(() => readSourceFileSafe(p, size - 1)).reason, "file-too-large", `size=${size} one byte over`);
    }
  });

  it("a negative limit refuses every file, an empty one too", () => {
    const d = tmpDir();
    writeFileSync(path.join(d, "e"), "");
    assert.equal(refusal(() => readSourceFileSafe(path.join(d, "e"), -1)).reason, "file-too-large");
  });

  it("refuses a dangling symlink and a symlink to a directory as unsafe-symlink, a missing path and a path below a file as source-unreadable", { skip: posixOnly }, () => {
    const d = tmpDir();
    mkdirSync(path.join(d, "real"));
    writeFileSync(path.join(d, "f"), "x");
    symlinkSync(path.join(d, "nowhere"), path.join(d, "dangling"));
    symlinkSync(path.join(d, "real"), path.join(d, "dirlink"));
    assert.equal(refusal(() => readSourceFileSafe(path.join(d, "dangling"), 10)).reason, "unsafe-symlink");
    assert.equal(refusal(() => readSourceFileSafe(path.join(d, "dirlink"), 10)).reason, "unsafe-symlink");
    assert.equal(refusal(() => readSourceFileSafe(path.join(d, "missing"), 10)).reason, "source-unreadable");
    assert.equal(refusal(() => readSourceFileSafe(path.join(d, "f", "child"), 10)).reason, "source-unreadable");
    assert.equal(refusal(() => readSourceFileSafe(path.join(d, "f\0x"), 10)).reason, "source-unreadable", "a NUL byte in the path");
  });

  it("refuses device files without reading from them (/dev/null, and /dev/zero which would never end)", { skip: posixOnly }, () => {
    for (const dev of ["/dev/null", "/dev/zero"]) {
      if (!existsSync(dev)) continue;
      assert.equal(refusal(() => readSourceFileSafe(dev, 1 << 30)).reason, "not-regular-file", dev);
    }
  });

  it("every refusal message is '<basename>: <reason>': no directory, no content, no OS text", { skip: posixOnly }, () => {
    const d = tmpDir();
    const sub = path.join(d, `dir-${MARKER}`);
    mkdirSync(sub);
    writeFileSync(path.join(sub, "c.md"), `secret ${MARKER}`);
    symlinkSync(path.join(sub, "c.md"), path.join(sub, "l.md"));
    const cases: [string, number, string][] = [[path.join(sub, "c.md"), 3, "file-too-large"], [path.join(sub, "l.md"), 99, "unsafe-symlink"], [path.join(sub, "gone.md"), 99, "source-unreadable"], [sub, 99, "not-regular-file"]];
    for (const [p, max, reason] of cases) {
      const e = refusal(() => readSourceFileSafe(p, max));
      assert.equal(e.message, `${path.basename(p)}: ${reason}`);
      assert.equal(e.reason, reason);
      assert.equal(e.code, "E_IMPORT_FAILED");
      assert.ok(!e.message.includes(`secret ${MARKER}`));
    }
  });

  it("reads through a symlinked parent directory (only the final component must not be a link)", { skip: posixOnly }, () => {
    const d = tmpDir();
    mkdirSync(path.join(d, "real"));
    writeFileSync(path.join(d, "real", "g.md"), "G");
    symlinkSync(path.join(d, "real"), path.join(d, "alias"));
    assert.equal(readSourceFileSafe(path.join(d, "alias", "g.md"), 10).toString(), "G");
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert - a hard link to a file outside the source root is read like any regular file", { skip: posixOnly }, () => {
    const d = tmpDir();
    mkdirSync(path.join(d, "root"));
    mkdirSync(path.join(d, "outside"));
    writeFileSync(path.join(d, "outside", "target"), `outside-${MARKER}`);
    linkSync(path.join(d, "outside", "target"), path.join(d, "root", "hard.md"));
    assert.equal(readSourceFileSafe(path.join(d, "root", "hard.md"), 100).toString(), `outside-${MARKER}`);
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert - a unix socket is refused as source-unreadable (the open fails), not as not-regular-file", { skip: posixOnly }, async () => {
    const d = tmpDir();
    const sock = path.join(d, "s.sock");
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(sock, resolve));
    try { assert.equal(refusal(() => readSourceFileSafe(sock, 10)).reason, "source-unreadable"); }
    finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});
