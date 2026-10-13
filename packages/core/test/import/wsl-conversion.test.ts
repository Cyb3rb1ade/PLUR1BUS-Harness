// core/import wsl.ts conversions (docs/import.md §B.2, gap G5): decodeWslOutput, parseWslListOutput, listWslDistros,
// probeWslDistro, validateAndNormalizeSubpaths and the argument handling of spawnWslTarStream, all with injected runners and
// spawn functions (no wsl.exe). The existing wsl.test.ts covers the happy paths and the timers; this file is the table of inputs.
// What real wsl.exe prints in each Windows language cannot be verified here: localized rows below are the strings the code
// claims to understand, not a record of real output.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import {
  PROBE_SCRIPT, WSL_TAR_FIND_SCRIPT, decodeWslOutput, listWslDistros, parseWslListOutput, probeWslDistro, spawnWslTarStream,
  validateAndNormalizeSubpaths, type WslDistro, type WslRunner,
} from "../../src/import/wsl.ts";
import { ImportError } from "../../src/import/types.ts";
import { mulberry32 } from "./helpers.ts";

const u16 = (s: string, bom = false) => Buffer.concat([bom ? Buffer.from([0xff, 0xfe]) : Buffer.alloc(0), Buffer.from(s, "utf16le")]);
const ok = (stdout: Buffer | string, exitCode = 0) => ({ stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout), stderr: Buffer.alloc(0), exitCode });
function importError(fn: () => unknown): ImportError {
  try { fn(); } catch (e) { assert.ok(e instanceof ImportError, String(e)); return e; }
  assert.fail("expected an ImportError");
}
async function importErrorAsync(fn: () => Promise<unknown>): Promise<ImportError> {
  try { await fn(); } catch (e) { assert.ok(e instanceof ImportError, String(e)); return e; }
  assert.fail("expected an ImportError");
}

describe("decodeWslOutput", () => {
  const cases: [string, Buffer, string][] = [
    ["empty", Buffer.alloc(0), ""],
    ["UTF-16LE with BOM, BOM removed", u16("Ubuntu\r\nDebian\r\n", true), "Ubuntu\r\nDebian\r\n"],
    ["UTF-16LE without BOM, ASCII", u16("Ubuntu\r\nDebian\r\n"), "Ubuntu\r\nDebian\r\n"],
    ["UTF-16LE without BOM, Latin-1 letters", u16("Ubuntu-é\r\n"), "Ubuntu-é\r\n"],
    ["UTF-8 with BOM, BOM removed", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("AB")]), "AB"],
    ["UTF-8 ASCII", Buffer.from("abcd"), "abcd"],
    ["UTF-8 with non-ASCII", Buffer.from("Ubuntu-é\n"), "Ubuntu-é\n"],
    ["UTF-8 NUL-delimited records (the probe script's output) are not mistaken for UTF-16", Buffer.from("HOME=/home/u\0OPENCLAW=/home/u/.openclaw\0HERMES=/home/u/.hermes\0"), "HOME=/home/u\0OPENCLAW=/home/u/.openclaw\0HERMES=/home/u/.hermes\0"],
    ["UTF-16LE with BOM and a dangling odd byte: the odd byte is dropped", Buffer.concat([u16("AB", true), Buffer.from([0x43])]), "AB"],
  ];
  for (const [title, buf, expected] of cases) it(title, () => assert.equal(decodeWslOutput(buf), expected));

  it("UTF-16LE of a typical distro table decodes to text the table parser accepts", () => {
    const table = "  NAME      STATE           VERSION\r\n* Ubuntu    Running         2\r\n  Debian    Stopped         2\r\n";
    for (const buf of [u16(table, true), u16(table)]) assert.equal(parseWslListOutput(decodeWslOutput(buf)).length, 2);
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert - UTF-16LE without BOM is only recognised when a quarter of the high bytes are NUL: CJK text, and anything under 4 bytes, is decoded as UTF-8", () => {
    assert.notEqual(decodeWslOutput(u16("日本語ディストロ")), "日本語ディストロ");
    assert.equal(decodeWslOutput(u16("A")), "A\u0000");
    assert.equal(decodeWslOutput(u16("AB").subarray(0, 3)), "A\u0000B");
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert - UTF-16BE (FE FF) is not recognised and decodes to replacement characters", () => {
    const text = decodeWslOutput(Buffer.from([0xfe, 0xff, 0, 0x41, 0, 0x42, 0, 0x43]));
    assert.ok(text.includes("\ufffd") && text.includes("A"), JSON.stringify(text));
  });
});

describe("parseWslListOutput", () => {
  const row = (name: string, state: string, version: number, def = false) => ({ name, state, version, isDefault: def });
  it("English table: header skipped, default marker, states, versions 1 and 2", () => {
    const text = "  NAME            STATE           VERSION\r\n* Ubuntu-24.04    Running         2\r\n  Debian          Stopped         1\r\n";
    assert.deepEqual(parseWslListOutput(text), [row("Ubuntu-24.04", "Running", 2, true), row("Debian", "Stopped", 1)]);
  });
  it("names with spaces split on runs of 2+ spaces; with single spaces the last token is the state", () => {
    assert.deepEqual(parseWslListOutput("  Ubuntu 24.04 LTS    Running    2"), [row("Ubuntu 24.04 LTS", "Running", 2)]);
    assert.deepEqual(parseWslListOutput("Ubuntu 24.04 Running 2"), [row("Ubuntu 24.04", "Running", 2)]);
  });
  it("a default marker without a following space, a tab-separated row, and a version above 2 are accepted", () => {
    assert.deepEqual(parseWslListOutput("*Ubuntu   Running   2"), [row("Ubuntu", "Running", 2, true)]);
    assert.deepEqual(parseWslListOutput("Ubuntu\tRunning\t2"), [row("Ubuntu", "Running", 2)]);
    assert.deepEqual(parseWslListOutput("Ubuntu   Running   3"), [row("Ubuntu", "Running", 3)]);
  });
  it("every state word that is not a running word is Stopped (Stopped, Installing, Uninstalling, Converting, Beendet, Arrêté ...)", () => {
    for (const state of ["Stopped", "Installing", "Uninstalling", "Converting", "Beendet", "Arrêté", "Detenido"]) {
      assert.equal(parseWslListOutput(`Ubuntu    ${state}    2`)[0]!.state, "Stopped", state);
    }
  });
  it("the running words it knows are Running (case-insensitive): English, German, French, Italian 'attivo', Portuguese and Spanish", () => {
    for (const state of ["Running", "RUNNING", "running", "wird ausgeführt", "En cours d’exécution", "attivo", "Em execução", "En ejecución"]) {
      assert.equal(parseWslListOutput(`Ubuntu    ${state}    2`)[0]!.state, "Running", state);
    }
  });
  it("blank lines, trailing spaces and CRLF are ignored; empty input and a header alone give no distros", () => {
    assert.deepEqual(parseWslListOutput(""), []);
    assert.deepEqual(parseWslListOutput("\r\n\r\n   \r\n"), []);
    assert.deepEqual(parseWslListOutput("  NAME      STATE           VERSION\r\n"), []);
    assert.deepEqual(parseWslListOutput("\r\nUbuntu   Running   2   \r\n\r\n"), [row("Ubuntu", "Running", 2)]);
  });
  it("headers it knows in other languages are skipped (NAME/NOM/NOMBRE x STATE/STATUS/STATUT/ESTADO x VERSION/VERSIÓN), also any line with NAME, VERSION, STATUS or STATE in it", () => {
    for (const header of ["  NAME   STATE   VERSION", "  NAME   STATUS   VERSION", "  NOM   STATUT   VERSION", "  NOMBRE   ESTADO   VERSIÓN", "  NOME  STATO  VERSIONE", "  NOM  ÉTAT  VERSION"]) {
      assert.deepEqual(parseWslListOutput(`${header}\nUbuntu   Running   2`), [row("Ubuntu", "Running", 2)], header);
    }
  });
  it("a row that cannot be a distro is refused with wsl-unparseable (fail closed), not skipped: prose, a lone number, a marker with a number, a name without state", () => {
    for (const bad of ["hello world", "2", "* 2", "Ubuntu  2", "Ubuntu"]) {
      const e = importError(() => parseWslListOutput(bad));
      assert.deepEqual([e.code, e.reason, e.exit], ["E_IMPORT_FAILED", "wsl-unparseable", 2], bad);
      assert.ok(e.message.includes(bad.trim()) || bad.trim() === "", bad);
    }
  });
  it("one bad row among good ones refuses the whole output", () => {
    assert.throws(() => parseWslListOutput("Ubuntu   Running   2\nnonsense here\nDebian   Stopped   2"), /wsl-unparseable|Cannot parse/);
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert - a header in a language the code does not list (Portuguese 'NOME ESTADO VERSÃO', Russian) is refused, not skipped", () => {
    for (const header of ["  NOME          ESTADO          VERSÃO", "  ИМЯ           СОСТОЯНИЕ       ВЕРСИЯ"]) {
      assert.equal(importError(() => parseWslListOutput(`${header}\nUbuntu   Running   2`)).reason, "wsl-unparseable", header);
    }
  });
  it("characterization: Ist-Verhalten, nicht spezifiziert - Italian 'In esecuzione' is not a running word (only 'attivo' is), so the row is Stopped", () => {
    assert.equal(parseWslListOutput("* Ubuntu         In esecuzione   2")[0]!.state, "Stopped");
  });
  it("characterization: Ist-Verhalten, nicht spezifiziert - a name that ends in a number is not confused with the version (the last number is the version)", () => {
    assert.deepEqual(parseWslListOutput("Ubuntu 24    Running    2"), [row("Ubuntu 24", "Running", 2)]);
  });
});

describe("listWslDistros", () => {
  type Call = { cmd: string[]; timeoutMs: number | undefined };
  function runner(script: Record<string, ReturnType<typeof ok> | Error>) {
    const calls: Call[] = [];
    const fn: WslRunner = async (cmd, opts) => {
      calls.push({ cmd, timeoutMs: opts?.timeoutMs });
      const r = script[cmd.slice(1).join(" ")];
      if (r === undefined) throw new Error(`unscripted call ${cmd.join(" ")}`);
      if (r instanceof Error) throw r;
      return r;
    };
    return { fn, calls };
  }

  it("asks -l -q, then -l --running -q, then -l -v, with the timeout, and combines names, running set, default marker and versions", async () => {
    const r = runner({
      "-l -q": ok(u16("Ubuntu-24.04\r\nDebian\r\n", true)),
      "-l --running -q": ok(u16("Debian\r\n", true)),
      "-l -v": ok(u16("  NAME            STATE           VERSION\r\n* Ubuntu-24.04    Stopped         2\r\n  Debian          Running         1\r\n", true)),
    });
    const out = await listWslDistros(r.fn, 1234);
    assert.deepEqual(out, [
      { name: "Ubuntu-24.04", state: "Stopped", version: 2, isDefault: true },
      { name: "Debian", state: "Running", version: 1, isDefault: false },
    ]);
    assert.deepEqual(r.calls.map((c) => c.cmd), [["wsl.exe", "-l", "-q"], ["wsl.exe", "-l", "--running", "-q"], ["wsl.exe", "-l", "-v"]]);
    assert.ok(r.calls.every((c) => c.timeoutMs === 1234));
  });

  it("no distros: -l -q empty means [] after a single call", async () => {
    const r = runner({ "-l -q": ok("") });
    assert.deepEqual(await listWslDistros(r.fn), []);
    assert.equal(r.calls.length, 1);
  });

  it("if -l -q fails with a non-zero exit it falls back to -l -v; if that fails too the answer is [] (WSL not installed)", async () => {
    const fallback = runner({ "-l -q": ok("", 1), "-l -v": ok("  NAME STATE VERSION\nUbuntu   Running   2\n") });
    assert.deepEqual(await listWslDistros(fallback.fn), [{ name: "Ubuntu", state: "Running", version: 2, isDefault: false }]);
    const none = runner({ "-l -q": ok("", 1), "-l -v": ok("", 1) });
    assert.deepEqual(await listWslDistros(none.fn), []);
    const notInstalled = async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.from("wsl.exe not found"), exitCode: 127 });
    assert.deepEqual(await listWslDistros(notInstalled), []);
  });

  it("names with CR, blank lines and surrounding spaces are cleaned; names with spaces are matched whole in the verbose table", async () => {
    const r = runner({
      "-l -q": ok("  Ubuntu 24.04 LTS \r\n\r\nDebian\r\n"),
      "-l --running -q": ok("Ubuntu 24.04 LTS\r\n"),
      "-l -v": ok("  NAME   STATE   VERSION\n* Ubuntu 24.04 LTS    Running    2\n  Debian    Stopped    1\n"),
    });
    assert.deepEqual(await listWslDistros(r.fn), [
      { name: "Ubuntu 24.04 LTS", state: "Running", version: 2, isDefault: true },
      { name: "Debian", state: "Stopped", version: 1, isDefault: false },
    ]);
  });

  it("a failing --running or -v call degrades to Stopped and version 2 instead of failing (the names are what matters)", async () => {
    const r = runner({ "-l -q": ok("Ubuntu\n"), "-l --running -q": new Error("boom"), "-l -v": ok("", 1) });
    assert.deepEqual(await listWslDistros(r.fn), [{ name: "Ubuntu", state: "Stopped", version: 2, isDefault: false }]);
  });

  it("a runner timeout (ImportError) propagates unchanged; any other runner exception becomes wsl-probe-failed", async () => {
    const timeout = new ImportError("E_SOURCE_BUSY", "wsl-timeout", "wsl.exe timed out after 5ms");
    assert.equal(await importErrorAsync(() => listWslDistros(async () => { throw timeout; })), timeout);
    const e = await importErrorAsync(() => listWslDistros(async () => { throw new Error("spawn EACCES"); }));
    assert.deepEqual([e.code, e.reason, e.exit], ["E_IMPORT_FAILED", "wsl-probe-failed", 2]);
    assert.match(e.message, /spawn EACCES/);
  });

  it("an -l -q answer that already is a table (a runner that returns the verbose listing) is parsed as a table", async () => {
    const r = runner({ "-l -q": ok("  NAME   STATE   VERSION\n* Ubuntu   Running   2\n") });
    assert.deepEqual(await listWslDistros(r.fn), [{ name: "Ubuntu", state: "Running", version: 2, isDefault: true }]);
    assert.equal(r.calls.length, 1);
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert - when --running cannot be asked, every distro counts as Stopped, so a running one is only probed with probeWsl", async () => {
    const r = runner({ "-l -q": ok("A\nB\n"), "-l --running -q": ok("", 1), "-l -v": ok("", 1) });
    assert.deepEqual((await listWslDistros(r.fn)).map((d) => d.state), ["Stopped", "Stopped"]);
  });
});

describe("probeWslDistro", () => {
  const running: WslDistro = { name: "Ubuntu-24.04", state: "Running", version: 2, isDefault: true };
  const stopped: WslDistro = { ...running, state: "Stopped" };
  const recorder = (answer: ReturnType<typeof ok>) => {
    const calls: { cmd: string[]; timeoutMs: number | undefined }[] = [];
    const fn: WslRunner = async (cmd, opts) => { calls.push({ cmd, timeoutMs: opts?.timeoutMs }); return answer; };
    return { fn, calls };
  };
  const nul = (...records: string[]) => records.map((r) => `${r}\0`).join("");

  it("runs the probe script as one argv element of a sh -lc inside the named distro, with the timeout", async () => {
    const r = recorder(ok(nul("HOME=/home/u")));
    await probeWslDistro(running, { runner: r.fn, timeoutMs: 777 });
    assert.deepEqual(r.calls, [{ cmd: ["wsl.exe", "-d", "Ubuntu-24.04", "-e", "sh", "-lc", PROBE_SCRIPT], timeoutMs: 777 }]);
  });

  it("turns NUL-delimited records into candidates, each with the HOME that was announced before it, and \\\\wsl.localhost access paths", async () => {
    const r = recorder(ok(nul("HOME=/home/u", "OPENCLAW=/home/u/.openclaw", "HERMES=/home/u/.hermes", "HOME=/home/v", "HERMES=/home/v/.hermes")));
    const out = await probeWslDistro(running, { runner: r.fn });
    assert.deepEqual(out.map((c) => [c.sourceType, c.sourceRoot, c.accessRoot, c.sourceHome, c.accessHome, c.probed, c.distro, c.state]), [
      ["openclaw", "/home/u/.openclaw", "\\\\wsl.localhost\\Ubuntu-24.04\\home\\u\\.openclaw", "/home/u", "\\\\wsl.localhost\\Ubuntu-24.04\\home\\u", true, "Ubuntu-24.04", "Running"],
      ["hermes", "/home/u/.hermes", "\\\\wsl.localhost\\Ubuntu-24.04\\home\\u\\.hermes", "/home/u", "\\\\wsl.localhost\\Ubuntu-24.04\\home\\u", true, "Ubuntu-24.04", "Running"],
      ["hermes", "/home/v/.hermes", "\\\\wsl.localhost\\Ubuntu-24.04\\home\\v\\.hermes", "/home/v", "\\\\wsl.localhost\\Ubuntu-24.04\\home\\v", true, "Ubuntu-24.04", "Running"],
    ]);
  });

  it("keeps a newline inside a path when the records are NUL-delimited, and also reads newline-delimited fixtures when there is no NUL", async () => {
    const withNewline = await probeWslDistro(running, { runner: recorder(ok(nul("HOME=/home/u", "OPENCLAW=/home/u/.open\nclaw"))).fn });
    assert.equal(withNewline[0]!.sourceRoot, "/home/u/.open\nclaw");
    const legacy = await probeWslDistro(running, { runner: recorder(ok("HOME=/home/u\r\nOPENCLAW=/home/u/.openclaw\r\n")).fn });
    assert.deepEqual(legacy.map((c) => c.sourceRoot), ["/home/u/.openclaw"]);
  });

  it("ignores records that are not absolute paths, unknown keys, empty values and lines without '='", async () => {
    const r = recorder(ok(nul("HOME=/home/u", "OPENCLAW=relative/path", "OPENCLAW=", "HERMES=~/.hermes", "OTHER=/x", "noequals", "=/x", "", "OPENCLAW=/home/u/.openclaw")));
    assert.deepEqual((await probeWslDistro(running, { runner: r.fn })).map((c) => c.sourceRoot), ["/home/u/.openclaw"]);
  });

  it("a candidate before any HOME record gets '/home' as its home", async () => {
    const out = await probeWslDistro(running, { runner: recorder(ok(nul("OPENCLAW=/srv/oc"))).fn });
    assert.deepEqual([out[0]!.sourceHome, out[0]!.accessHome], ["/home", "\\\\wsl.localhost\\Ubuntu-24.04\\home"]);
  });

  it("no installation found is an empty list, not an error", async () => {
    assert.deepEqual(await probeWslDistro(running, { runner: recorder(ok(nul("HOME=/home/u"))).fn }), []);
    assert.deepEqual(await probeWslDistro(running, { runner: recorder(ok("")).fn }), []);
  });

  it("a non-zero exit gives one unprobed candidate with the exit code as reason and empty paths", async () => {
    const out = await probeWslDistro(running, { runner: recorder(ok("", 5)).fn });
    assert.deepEqual(out, [{ sourceType: "openclaw", distro: "Ubuntu-24.04", state: "Running", sourceRoot: "", accessRoot: "", sourceHome: "", accessHome: "", probed: false, reason: "probe-failed: exit 5" }]);
  });

  it("a stopped distro is not started (the runner is not called) unless probeWsl is set (owner decision C12)", async () => {
    const r = recorder(ok(nul("HOME=/home/u", "OPENCLAW=/home/u/.openclaw")));
    const skipped = await probeWslDistro(stopped, { runner: r.fn });
    assert.deepEqual(r.calls, []);
    assert.deepEqual(skipped, [{ sourceType: "openclaw", distro: "Ubuntu-24.04", state: "Stopped", sourceRoot: "", accessRoot: "", sourceHome: "", accessHome: "", probed: false, reason: "stopped (not probed)" }]);
    const probed = await probeWslDistro(stopped, { runner: r.fn, probeWsl: true });
    assert.equal(r.calls.length, 1);
    assert.deepEqual([probed[0]!.probed, probed[0]!.state], [true, "Stopped"]);
  });

  it("a runner failure (timeout) propagates", async () => {
    const timeout = new ImportError("E_SOURCE_BUSY", "wsl-timeout", "timed out");
    await assert.rejects(() => probeWslDistro(running, { runner: async () => { throw timeout; } }), (e: unknown) => e === timeout);
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert - a literal backslash in a Linux path is indistinguishable from a separator in accessRoot", async () => {
    const out = await probeWslDistro(running, { runner: recorder(ok(nul("HOME=/home/u", "OPENCLAW=/home/u/a\\b"))).fn });
    assert.equal(out[0]!.accessRoot, "\\\\wsl.localhost\\Ubuntu-24.04\\home\\u\\a\\b");
  });
});

describe("validateAndNormalizeSubpaths", () => {
  it("normalises to './<segments>' with '/', collapsing '.', empty segments and trailing separators; Windows separators count as separators", () => {
    assert.deepEqual(validateAndNormalizeSubpaths(["a//b", "./a", ".", "a/./b", "a\\b", "a/", "a\\\\b\\"]), ["./a/b", "./a", ".", "./a/b", "./a/b", "./a", "./a/b"]);
  });
  it("an empty list means the whole root", () => assert.deepEqual(validateAndNormalizeSubpaths([]), ["."]));
  it("names that merely contain dots, dashes or percent signs are not traversal: '..a', 'a..', '...', '%2e%2e', 'a/-rf', full-width dots", () => {
    assert.deepEqual(validateAndNormalizeSubpaths(["..a", "a..", "...", "%2e%2e", "a/-rf", "．．", "a b", " "]), ["./..a", "./a..", "./...", "./%2e%2e", "./a/-rf", "./．．", "./a b", "./ "]);
  });
  const refused: [string, unknown][] = [
    ["empty string", ""], ["not a string", 5], ["NUL byte", "a\0b"], ["leading dash", "-rf"], ["leading dash after nothing else", "-"],
    ["absolute POSIX", "/etc"], ["leading backslash", "\\x"], ["drive letter with separator", "C:\\x"], ["drive letter without separator", "c:foo"],
    ["'..'", ".."], ["'../x'", "../x"], ["'x/..'", "x/.."], ["'a/../b'", "a/../b"], ["backslash '..\\x'", "..\\x"], ["'./..'", "./.."], ["'a\\..\\b'", "a\\..\\b"], ["'a//../b'", "a//../b"],
  ];
  for (const [title, value] of refused) {
    it(`refuses ${title}`, () => {
      const e = importError(() => validateAndNormalizeSubpaths([value as string]));
      assert.deepEqual([e.code, e.reason, e.exit], ["E_TAR_SECURITY", "invalid-subpath", 3]);
    });
  }
  it("one bad entry refuses the whole list", () => assert.throws(() => validateAndNormalizeSubpaths(["ok", "../bad", "also-ok"]), { reason: "invalid-subpath" }));

  it("property: every accepted entry is './' + non-empty segments (none '.' or '..', no backslash, no NUL) or '.'; every rejected one has a documented cause (seeded)", () => {
    const SEED = 0x5ab9;
    const rnd = mulberry32(SEED);
    const frag = ["a", "b", "..", ".", "", "-x", "c:", "d e", "\0", "é", "...", "a..b", "%2e"];
    for (let i = 0; i < 3000; i++) {
      const sep = rnd() < 0.5 ? "/" : "\\";
      const value = Array.from({ length: 1 + Math.floor(rnd() * 6) }, () => frag[Math.floor(rnd() * frag.length)]!).join(sep) || "";
      const ctx = `seed=0x${SEED.toString(16)} case=${i} value=${JSON.stringify(value)}`;
      const segments = value.split(/[\/\\]+/);
      const mustRefuse = value === "" || value.includes("\0") || value.startsWith("-") || value.startsWith("/") || value.startsWith("\\") || /^[a-zA-Z]:/.test(value) || segments.includes("..");
      let out: string[] | undefined;
      try { out = validateAndNormalizeSubpaths([value]); } catch (e) { assert.ok(e instanceof ImportError && e.reason === "invalid-subpath", ctx); }
      assert.equal(out === undefined, mustRefuse, ctx);
      if (out) {
        const p = out[0]!;
        assert.ok(p === "." || (p.startsWith("./") && p.slice(2).split("/").every((s) => s !== "" && s !== "." && s !== "..")), `${ctx}: ${p}`);
        assert.ok(!p.includes("\\") && !p.includes("\0"), ctx);
      }
    }
  });
});

describe("spawnWslTarStream: argument handling", () => {
  function fakeSpawn() {
    const calls: { cmd: string; args: string[]; opts: Record<string, unknown> }[] = [];
    const spawnFn = ((cmd: string, args: string[], opts: Record<string, unknown>) => {
      calls.push({ cmd, args, opts });
      const child = new EventEmitter() as EventEmitter & { stdout: Readable; stderr: Readable; kill: (s?: string) => boolean };
      child.stdout = Readable.from([]); child.stderr = Readable.from([]); child.kill = () => true;
      setImmediate(() => child.emit("close", 0, null));
      return child;
    }) as unknown as typeof import("node:child_process").spawn;
    return { calls, spawnFn };
  }

  it("passes distro, root and subpaths as separate argv elements after the constant script, never inside it", async () => {
    const f = fakeSpawn();
    const hostile = "$(touch /tmp/pwned); `id` \"quoted\" 'single' & | > <";
    const p = spawnWslTarStream("Ubuntu 24.04", hostile, ["a b", "c;d", "$(x)"], { spawnFn: f.spawnFn, timeoutMs: 5000 });
    for await (const _ of p.stream) { /* drain */ }
    await p.waitClose();
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0]!.cmd, "wsl.exe");
    assert.deepEqual(f.calls[0]!.args, ["-d", "Ubuntu 24.04", "--exec", "sh", "-c", WSL_TAR_FIND_SCRIPT, "sh", hostile, "--", "./a b", "./c;d", "./$(x)"]);
    assert.ok(!WSL_TAR_FIND_SCRIPT.includes("touch /tmp/pwned"));
    assert.equal(f.calls[0]!.opts["windowsHide"], true);
    assert.deepEqual(f.calls[0]!.opts["stdio"], ["ignore", "pipe", "pipe"]);
  });

  it("no subpaths means the whole root ('.')", async () => {
    const f = fakeSpawn();
    const p = spawnWslTarStream("U", "/root", [], { spawnFn: f.spawnFn });
    for await (const _ of p.stream) { /* drain */ }
    await p.waitClose();
    assert.deepEqual(f.calls[0]!.args.slice(-2), ["--", "."]);
  });

  const badDistros: [string, string][] = [["empty", ""], ["leading dash", "-d"], ["slash", "a/b"], ["backslash", "a\\b"], ["colon", "a:b"], ["NUL", "a\0b"], ["LF", "a\nb"], ["CR", "a\rb"]];
  for (const [title, distro] of badDistros) {
    it(`refuses a distro name with ${title} before anything is spawned`, () => {
      const f = fakeSpawn();
      const e = importError(() => spawnWslTarStream(distro, "/root", ["a"], { spawnFn: f.spawnFn }));
      assert.deepEqual([e.code, e.reason, e.exit], ["E_INVALID_PARAMS", "invalid-distro-name", 2]);
      assert.equal(f.calls.length, 0);
    });
  }

  it("refuses a bad subpath before anything is spawned", () => {
    const f = fakeSpawn();
    assert.throws(() => spawnWslTarStream("U", "/root", ["ok", "../escape"], { spawnFn: f.spawnFn }), { reason: "invalid-subpath" });
    assert.equal(f.calls.length, 0);
  });

  it("accepts the distro names Windows allows: dots, dashes, underscores, digits and spaces", () => {
    for (const name of ["Ubuntu-24.04", "Ubuntu_22", "docker-desktop", "My Distro 2", "Debian.1"]) {
      const f = fakeSpawn();
      const p = spawnWslTarStream(name, "/root", ["a"], { spawnFn: f.spawnFn });
      p.dispose();
      assert.equal(f.calls[0]!.args[1], name);
    }
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert - the source root is passed on unvalidated as the script's first positional argument: relative and dash-leading roots are accepted (the script's own cd decides)", () => {
    const f = fakeSpawn();
    for (const root of ["relative/root", "-x", ""]) {
      const p = spawnWslTarStream("U", root, ["a"], { spawnFn: f.spawnFn });
      p.dispose();
    }
    assert.deepEqual(f.calls.map((c) => c.args[7]), ["relative/root", "-x", ""]);
  });
});
