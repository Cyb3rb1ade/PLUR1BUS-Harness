// core/import paths.ts, the parts the existing paths.test.ts leaves out: the environment/home/tilde helpers, the unmapped-reason
// vocabulary, '..' handling (path traversal out of the source root), --map precedence, the snapshot containment rule and the
// portability report. Pure string logic with the platform injected, so every case runs on every OS.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  envGet, expandTilde, expandUser, expandVars, flavourOf, locateSource, parseMaps, pathFor, portabilityOf, SourcePathMapper, userHome,
  type MapResult, type SourceLocation,
} from "../../src/import/paths.ts";
import { ImportError } from "../../src/import/types.ts";
import { gap, mulberry32 } from "./helpers.ts";

const show = (r: MapResult) => (r.path === null ? `unmapped:${r.reason}` : `${r.how}:${r.path}`);
const posixLoc = (home: string | null = "/home/u") => locateSource({ accessRoot: "/home/u/.openclaw", platform: "linux", env: {}, home });
const winLoc = () => locateSource({ accessRoot: "C:\\Users\\u\\.openclaw", platform: "win32", env: {}, home: "C:\\Users\\u" });

describe("flavourOf and pathFor", () => {
  it("win32 is the only Windows flavour; every other platform is posix", () => {
    for (const p of ["linux", "darwin", "freebsd", "openbsd", "aix", "sunos", "android"] as const) assert.equal(flavourOf(p), "posix", p);
    assert.equal(flavourOf("win32"), "win32");
  });
  it("pathFor accepts a flavour or a platform and returns the matching path module", () => {
    assert.equal(pathFor("win32"), path.win32);
    assert.equal(pathFor("posix"), path.posix);
    assert.equal(pathFor("linux"), path.posix);
    assert.equal(pathFor("darwin"), path.posix);
  });
});

describe("envGet", () => {
  it("is exact on POSIX and case-insensitive on Windows (exact match preferred)", () => {
    assert.equal(envGet({ Path: "x" }, "PATH", "linux"), undefined);
    assert.equal(envGet({ Path: "x" }, "PATH", "win32"), "x");
    assert.equal(envGet({ Path: "lower", PATH: "upper" }, "PATH", "win32"), "upper");
    assert.equal(envGet({}, "PATH", "win32"), undefined);
    assert.equal(envGet({ PATH: undefined }, "PATH", "win32"), undefined);
  });
});

describe("expandVars", () => {
  const env = { HOME: "/home/u", Data: "D:\\data", EMPTY: "" };
  it("expands $NAME and ${NAME} on every platform and %NAME% only on Windows; unknown names stay as written", () => {
    assert.equal(expandVars("$HOME/a ${HOME}/b", env, "linux"), "/home/u/a /home/u/b");
    assert.equal(expandVars("%HOME%/a", env, "linux"), "%HOME%/a");
    assert.equal(expandVars("%HOME%/a $HOME ${HOME}", env, "win32"), "/home/u/a /home/u /home/u");
    assert.equal(expandVars("$NOPE ${NOPE} %NOPE%", env, "win32"), "$NOPE ${NOPE} %NOPE%");
    assert.equal(expandVars("$nope-${also}", env, "linux"), "$nope-${also}");
  });
  it("on Windows names are case-insensitive; on POSIX they are not", () => {
    assert.equal(expandVars("%DATA%\\x $data", env, "win32"), "D:\\data\\x D:\\data");
    assert.equal(expandVars("$DATA", env, "linux"), "$DATA");
  });
  it("an empty value expands to the empty string (it is set), a name ends at the first non-word character", () => {
    assert.equal(expandVars("a${EMPTY}b $EMPTY/c", env, "linux"), "ab /c");
    assert.equal(expandVars("$HOME.bak $HOME-x", env, "linux"), "/home/u.bak /home/u-x");
  });
  it("text without variables, and a lone '$', are unchanged", () => {
    for (const s of ["", "plain", "a$", "$", "${", "${}", "50%", "%%"]) assert.equal(expandVars(s, env, "linux"), s, JSON.stringify(s));
  });
  it(gap("expandVars", "an unknown name is left as written, also when it is the name of an Object.prototype member ($constructor, ${toString})", "the inherited function is substituted: '$constructor' becomes 'function Object() { [native code] }'"), { todo: gap("expandVars", "an unknown name is left as written, also when it is the name of an Object.prototype member ($constructor, ${toString})", "the inherited function is substituted: '$constructor' becomes 'function Object() { [native code] }'") }, () => {
    assert.equal(expandVars("$constructor/x ${toString}", {}, "linux"), "$constructor/x ${toString}");
    assert.equal(expandVars("%valueOf%", {}, "win32"), "%valueOf%");
  });
});

describe("userHome, expandTilde, expandUser", () => {
  it("userHome: HOME on POSIX, USERPROFILE on Windows (HOME ignored there), trimmed; blank or unset falls back to the OS home directory", () => {
    assert.equal(userHome({ HOME: "/x" }, "/os", "linux"), "/x");
    assert.equal(userHome({ HOME: "  /x  " }, "/os", "linux"), "/x");
    assert.equal(userHome({ HOME: "   " }, "/os", "linux"), "/os");
    assert.equal(userHome({}, "/os", "darwin"), "/os");
    assert.equal(userHome({ HOME: "/ignored", USERPROFILE: "C:\\Users\\x" }, "C:\\os", "win32"), "C:\\Users\\x");
    assert.equal(userHome({ HOME: "/ignored" }, "C:\\os", "win32"), "C:\\os");
    assert.equal(userHome({ UserProfile: "C:\\Users\\x" }, "C:\\os", "win32"), "C:\\Users\\x");
  });
  it("expandTilde: '~' and '~/rest'; '~\\rest' only for the Windows flavour; '~user' and '~x' stay as written", () => {
    assert.deepEqual(["~", "~/a/b", "~/", "~\\a", "~user/a", "~x", "a/~", ""].map((p) => expandTilde(p, "/h", "linux")), ["/h", "/h/a/b", "/h", "~\\a", "~user/a", "~x", "a/~", ""]);
    assert.deepEqual(["~", "~/a", "~\\a", "~user"].map((p) => expandTilde(p, "C:\\h", "win32")), ["C:\\h", "C:\\h\\a", "C:\\h\\a", "~user"]);
  });
  it("expandUser combines userHome and expandTilde", () => {
    assert.equal(expandUser("~/proj", { HOME: "/home/j" }, "/os", "linux"), "/home/j/proj");
    assert.equal(expandUser("~\\proj", { USERPROFILE: "C:\\Users\\j" }, "/os", "win32"), "C:\\Users\\j\\proj");
    assert.equal(expandUser("~", {}, "/os", "linux"), "/os");
  });
});

describe("unmapped reasons", () => {
  it("env-var: ${NAME} that the source does not bind; a $VAR/%VAR% left over after expanding the captured environment", () => {
    const m = new SourcePathMapper(posixLoc(), { vars: { KNOWN: "/srv" }, env: { SET: "/set" } });
    assert.equal(show(m.map("${KNOWN}/x", "k")), "native:/srv/x");
    assert.equal(show(m.map("${UNKNOWN}/x", "k")), "unmapped:env-var");
    assert.equal(show(m.map("$SET/x", "k")), "native:/set/x");
    assert.equal(show(m.map("$MISSING/x", "k")), "unmapped:env-var");
    assert.equal(show(m.map("${MISSING}/x", "k")), "unmapped:env-var");
    const w = new SourcePathMapper(winLoc(), { env: { Data: "D:\\data" } });
    assert.equal(show(w.map("%data%\\x", "k")), "native:D:\\data\\x");
    assert.equal(show(w.map("%MISSING%\\x", "k")), "unmapped:env-var");
  });

  it("without a captured environment, $VAR in a path is just a path segment (only ${NAME} is checked)", () => {
    const m = new SourcePathMapper(posixLoc());
    assert.equal(show(m.map("$HOME/x", "k")), "native:/home/u/.openclaw/$HOME/x");
  });

  it("home-unknown: '~' when the source-side home is not known", () => {
    const m = new SourcePathMapper(posixLoc(null));
    assert.equal(show(m.map("~/x", "k")), "unmapped:home-unknown");
    assert.equal(show(m.map("~", "k")), "unmapped:home-unknown");
    assert.equal(show(m.map("rel/x", "k")), "native:/home/u/.openclaw/rel/x", "other paths do not need it");
  });

  it("drive-relative: 'C:x' on any source; '\\x' on a Windows source", () => {
    assert.equal(show(new SourcePathMapper(winLoc()).map("C:x", "k")), "unmapped:drive-relative");
    assert.equal(show(new SourcePathMapper(winLoc()).map("\\x", "k")), "unmapped:drive-relative");
    assert.equal(show(new SourcePathMapper(posixLoc()).map("c:x", "k")), "unmapped:drive-relative");
  });

  it("foreign-path: a path in the other syntax; a POSIX path on a Windows source is never read as C:\\...", () => {
    assert.equal(show(new SourcePathMapper(posixLoc()).map("E:\\data", "k")), "unmapped:foreign-path");
    assert.equal(show(new SourcePathMapper(winLoc()).map("/etc/passwd", "k")), "unmapped:foreign-path");
  });

  it("outside-source-root: a path of a snapshot source that is not below the snapshot root", () => {
    const snap: SourceLocation = { ...posixLoc(), snapshot: true, accessRoot: "/home/h/import/r1/snapshot", sourceRoot: "/home/u/.openclaw", mounts: [] };
    const m = new SourcePathMapper(snap);
    assert.equal(show(m.map("/home/u/.openclaw/ws", "k")), "root:/home/h/import/r1/snapshot/ws");
    assert.equal(show(m.map("/opt/other", "k")), "unmapped:outside-source-root");
    assert.equal(show(m.map("/home/u/elsewhere", "k")), "unmapped:outside-source-root");
  });

  it("every outcome is recorded: non-native mappings under 'mapped', every refusal under 'unmapped', in call order, with the raw value", () => {
    const m = new SourcePathMapper(locateSource({ accessRoot: "\\\\wsl.localhost\\Ubuntu\\home\\u\\.openclaw", platform: "win32", env: {}, home: "C:\\Users\\U" }));
    m.map("workspace", "agents.a.workspace"); m.map("/mnt/d/x", "skills.dir"); m.map("D:\\x", "k3"); m.map("${NOPE}", "k4");
    const r = m.report();
    assert.deepEqual(r.mapped.map((x) => [x.key, x.how]), [["agents.a.workspace", "root"], ["skills.dir", "mount"]]);
    assert.deepEqual(r.unmapped.map((x) => [x.key, x.value, x.reason]), [["k3", "D:\\x", "foreign-path"], ["k4", "${NOPE}", "env-var"]]);
  });
});

describe("'..' and other odd segments (path traversal out of the source root)", () => {
  it("an absolute path is normalised first: '/home/u/.openclaw/a/../b' stays inside the root, '/home/u/.openclaw/../.ssh/id' is the native path outside it", () => {
    const m = new SourcePathMapper(posixLoc());
    assert.equal(show(m.map("/home/u/.openclaw/a/../b", "k")), "native:/home/u/.openclaw/b");
    assert.equal(show(m.map("/home/u/.openclaw/../.ssh/id", "k")), "native:/home/u/.ssh/id");
  });

  it("an absolute path that climbs out of a snapshot root is refused", () => {
    const snap: SourceLocation = { ...posixLoc(), snapshot: true, accessRoot: "/home/h/import/r1/snapshot", sourceRoot: "/home/u/.openclaw", mounts: [] };
    const m = new SourcePathMapper(snap);
    assert.equal(show(m.map("/home/u/.openclaw/../../../etc/passwd", "k")), "unmapped:outside-source-root");
    assert.equal(show(m.map("../../etc/passwd", "k")), "root:/home/h/import/r1/snapshot/etc/passwd", "relative: clamped inside the snapshot (same behaviour as for a native root)");
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert - empty and blank values map to the root itself; '~user/x' is an ordinary relative name; a NUL byte is carried through", () => {
    const m = new SourcePathMapper(posixLoc());
    assert.equal(show(m.map("", "k")), "native:/home/u/.openclaw");
    assert.equal(show(m.map("   ", "k")), "native:/home/u/.openclaw");
    assert.equal(show(m.map("~root/x", "k")), "native:/home/u/.openclaw/~root/x");
    assert.equal(show(m.map("a\0b", "k")), "native:/home/u/.openclaw/a\0b");
  });

  it("property: a relative value never maps outside the access root, however many '..', '.', empty segments and separators it has (seeded, POSIX, Windows, WSL)", () => {
    const SEED = 0x7a7a;
    const rnd = mulberry32(SEED);
    const frag = ["a", "b", "..", "..", ".", "", "dir name", "é", "...", ".hidden", "x.md", "CON", "a b."];
    const cases: [string, SourcePathMapper, typeof path.posix][] = [
      ["posix", new SourcePathMapper(posixLoc()), path.posix],
      ["windows", new SourcePathMapper(winLoc()), path.win32],
      ["wsl-from-windows", new SourcePathMapper(locateSource({ accessRoot: "\\\\wsl.localhost\\Ubuntu\\home\\u\\.openclaw", platform: "win32", env: {}, home: "C:\\Users\\U" })), path.win32],
      ["windows-from-wsl", new SourcePathMapper(locateSource({ accessRoot: "/mnt/c/Users/J/.openclaw", platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu" }, home: "/home/j" })), path.posix],
    ];
    for (let i = 0; i < 4000; i++) {
      const [name, mapper, P] = cases[i % cases.length]!;
      // a POSIX source names files with "/" only; its backslash case is the KNOWN GAP below
      const sep = name === "posix" || name === "wsl-from-windows" ? "/" : rnd() < 0.5 ? "/" : "\\";
      const parts = Array.from({ length: 1 + Math.floor(rnd() * 8) }, () => frag[Math.floor(rnd() * frag.length)]!);
      if (parts[0] === "") parts[0] = "first"; // a leading empty segment would make the value absolute, which is not what this property is about
      const value = parts.join(sep);
      const r = mapper.map(value, "k");
      const ctx = `seed=0x${SEED.toString(16)} case=${i} ${name} value=${JSON.stringify(value)}`;
      if (r.path === null) { assert.ok(["drive-relative", "foreign-path", "outside-source-root"].includes(r.reason), `${ctx}: ${r.reason}`); continue; }
      const rel = P.relative(mapper.loc.accessRoot, r.path);
      assert.ok(rel === "" || (rel.split(/[\\/]/)[0] !== ".." && !P.isAbsolute(rel)), `${ctx}: ${r.path} is outside ${mapper.loc.accessRoot}`);
    }
  });

  it(gap("SourcePathMapper.map (WSL source read from Windows)", "a value from a POSIX (WSL) source that contains backslashes stays below the source root or is unmapped: on Linux '..\\b' is one file name, not a parent reference", "the Windows host joins it with '\\' as separator, so '..\\..\\..\\.ssh\\id_rsa' maps to \\\\wsl.localhost\\Ubuntu\\.ssh\\id_rsa, outside the root (relative, absolute-below-root and '~' forms alike)"), { todo: gap("SourcePathMapper.map (WSL source read from Windows)", "a value from a POSIX (WSL) source that contains backslashes stays below the source root or is unmapped: on Linux '..\\b' is one file name, not a parent reference", "the Windows host joins it with '\\' as separator, so '..\\..\\..\\.ssh\\id_rsa' maps to \\\\wsl.localhost\\Ubuntu\\.ssh\\id_rsa, outside the root (relative, absolute-below-root and '~' forms alike)") }, () => {
    const root = "\\\\wsl.localhost\\Ubuntu\\home\\u\\.openclaw";
    const m = new SourcePathMapper(locateSource({ accessRoot: root, platform: "win32", env: {}, home: "C:\\Users\\U" }));
    const inside = (p: string) => { const rel = path.win32.relative(root, p); return rel === "" || (rel.split("\\")[0] !== ".." && !path.win32.isAbsolute(rel)); };
    for (const value of ["..\\b", "..\\..\\..\\.ssh\\id_rsa", "a\\..\\..\\x", "/home/u/.openclaw/..\\..\\.ssh\\id"]) {
      const r = m.map(value, "k");
      assert.ok(r.path === null || inside(r.path), `${JSON.stringify(value)} -> ${show(r)}`);
    }
  });

  it(gap("SourcePathMapper.map", "a relative value that climbs above the source root is not silently re-rooted ('../../etc/passwd' is unmapped, as 'never guessed' promises)", "it maps to <root>/etc/passwd with how 'native'"), { todo: gap("SourcePathMapper.map", "a relative value that climbs above the source root is not silently re-rooted ('../../etc/passwd' is unmapped, as 'never guessed' promises)", "it maps to <root>/etc/passwd with how 'native'") }, () => {
    const r = new SourcePathMapper(posixLoc()).map("../../etc/passwd", "k");
    assert.equal(r.path, null, show(r));
  });

  it(gap("SourcePathMapper.map", "${NAME} that is not in `vars` is unmapped:env-var, also for names that exist on Object.prototype (${constructor}, ${__proto__}, ${toString})", "the inherited member is substituted: '${constructor}/x' maps to '<root>/function Object() { [native code] }/x'"), { todo: gap("SourcePathMapper.map", "${NAME} that is not in `vars` is unmapped:env-var, also for names that exist on Object.prototype (${constructor}, ${__proto__}, ${toString})", "the inherited member is substituted: '${constructor}/x' maps to '<root>/function Object() { [native code] }/x'") }, () => {
    const m = new SourcePathMapper(posixLoc());
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) assert.equal(show(m.map(`\${${name}}/x`, "k")), "unmapped:env-var", name);
  });
});

describe("--map precedence and whole-segment matching", () => {
  const loc = posixLoc();
  it("the longest source prefix wins, regardless of the order the entries are given in", () => {
    const a = parseMaps(["/home/u/projects=/short", "/home/u/projects/deep=/long"]);
    for (const maps of [a, [...a].reverse()]) {
      const m = new SourcePathMapper(loc, { maps });
      assert.equal(show(m.map("/home/u/projects/deep/x", "k")), "map:/long/x");
      assert.equal(show(m.map("/home/u/projects/other/x", "k")), "map:/short/other/x");
    }
  });
  it("beats the source root: a --map prefix inside the root is applied first", () => {
    const m = new SourcePathMapper(loc, { maps: parseMaps(["/home/u/.openclaw/skills=/srv/skills"]) });
    assert.equal(show(m.map("/home/u/.openclaw/skills/a", "k")), "map:/srv/skills/a");
    assert.equal(show(m.map("/home/u/.openclaw/other", "k")), "native:/home/u/.openclaw/other", "a native source reports an unchanged path as native");
  });
  it("a prefix equal to the value maps to the target itself; prefixes match whole segments only", () => {
    const m = new SourcePathMapper(loc, { maps: parseMaps(["/data=/mnt/data"]) });
    assert.equal(show(m.map("/data", "k")), "map:/mnt/data");
    assert.equal(show(m.map("/data/", "k")), "map:/mnt/data");
    assert.equal(show(m.map("/database/x", "k")), "native:/database/x");
  });
  it("a Windows-syntax prefix matches case-insensitively, a POSIX-syntax one case-sensitively", () => {
    const m = new SourcePathMapper(loc, { maps: parseMaps(["C:\\Data=/mnt/data", "/Srv=/mnt/srv"]) });
    assert.equal(show(m.map("c:/DATA/x", "k")), "map:/mnt/data/x");
    assert.equal(show(m.map("/srv/x", "k")), "native:/srv/x");
    assert.equal(show(m.map("/Srv/x", "k")), "map:/mnt/srv/x");
  });
  it("a relative --map source prefix is ignored (it has no meaning without a root)", () => {
    const m = new SourcePathMapper(loc, { maps: parseMaps(["relative/dir=/elsewhere"]) });
    assert.equal(show(m.map("relative/dir/x", "k")), "native:/home/u/.openclaw/relative/dir/x");
  });
  it("parseMaps splits at the first '=', keeps the rest verbatim and refuses entries without a source or a target", () => {
    assert.deepEqual(parseMaps(["a=b=c", "x==y"]), [{ from: "a", to: "b=c" }, { from: "x", to: "=y" }]);
    assert.deepEqual(parseMaps([]), []);
    for (const bad of ["", "=", "noequals", "=target", "source="]) {
      assert.throws(() => parseMaps([bad]), (e: unknown) => e instanceof ImportError && e.code === "E_INVALID_PARAMS" && e.reason === "map" && e.message.includes(JSON.stringify(bad)), bad);
    }
  });
});

describe("relative values against a base directory, rebasing and the UNC/network cases", () => {
  it("a relative value resolves against relBase when given (a Hermes profile), else against the root", () => {
    const m = new SourcePathMapper(posixLoc());
    assert.equal(show(m.map("sub/x", "k", "/home/u/.openclaw/profiles/work")), "native:/home/u/.openclaw/profiles/work/sub/x");
    assert.equal(show(m.map("sub/x", "k")), "native:/home/u/.openclaw/sub/x");
  });
  it("a Windows network share read on Windows is native to its own syntax; a POSIX path on it is foreign", () => {
    const m = new SourcePathMapper(locateSource({ accessRoot: "\\\\nas\\backup\\.openclaw", platform: "win32", env: {}, home: "C:\\Users\\u" }));
    assert.equal(show(m.map("\\\\nas\\backup\\.openclaw\\ws", "k")), "root:\\\\nas\\backup\\.openclaw\\ws");
    assert.equal(show(m.map("/etc/x", "k")), "unmapped:foreign-path");
  });
  it("rebasing needs a plausible home-directory prefix: /opt/.openclaw is somebody else's, /home/old/.openclaw and /var/home/x/.openclaw and /root/.openclaw are rebased", () => {
    const m = new SourcePathMapper(locateSource({ accessRoot: "/backup/.openclaw", platform: "linux", env: {}, home: "/home/u" }));
    assert.equal(show(m.map("/opt/.openclaw/x", "k")), "native:/opt/.openclaw/x");
    assert.equal(show(m.map("/home/old/.openclaw/x", "k")), "rebased:/backup/.openclaw/x");
    assert.equal(show(m.map("/var/home/old/.openclaw/x", "k")), "rebased:/backup/.openclaw/x");
    assert.equal(show(m.map("/root/.openclaw/x", "k")), "rebased:/backup/.openclaw/x");
    assert.equal(show(m.map("/home/old/deeper/dir/.openclaw/x", "k")), "native:/home/old/deeper/dir/.openclaw/x");
    assert.deepEqual(m.movedFrom, ["/home/old/.openclaw", "/var/home/old/.openclaw", "/root/.openclaw"]);
  });
  it("the same moved root is listed once however often it is seen", () => {
    const m = new SourcePathMapper(locateSource({ accessRoot: "/backup/.openclaw", platform: "linux", env: {}, home: "/home/u" }));
    for (let i = 0; i < 3; i++) m.map(`/home/old/.openclaw/f${i}`, "k");
    assert.deepEqual(m.movedFrom, ["/home/old/.openclaw"]);
  });
});

describe("portabilityOf and problem()", () => {
  it("report() hands out copies: mutating the returned arrays does not change the mapper", () => {
    const m = new SourcePathMapper(posixLoc());
    m.map("C:\\x", "k");
    const r = m.report();
    r.unmapped.length = 0; r.mapped.push({ key: "forged", value: "v", path: "p", how: "root" });
    assert.equal(m.report().unmapped.length, 1);
    assert.equal(m.report().mapped.length, 0);
  });
  it("adds one warning per moved root list, per problem and for unmapped paths, in that order, and none when all is well", () => {
    const quiet: string[] = [];
    portabilityOf(new SourcePathMapper(posixLoc()), quiet);
    assert.deepEqual(quiet, []);
    const m = new SourcePathMapper(locateSource({ accessRoot: "/backup/.openclaw", platform: "linux", env: {}, home: "/home/u" }));
    m.map("/home/old/.openclaw/x", "k1"); m.map("C:\\x", "k2");
    m.problem({ kind: "case-collision", subject: "profiles", names: ["Work", "work"] });
    m.problem({ kind: "unportable-name", subject: "skills", names: ["a:b"] });
    const warnings: string[] = [];
    const report = portabilityOf(m, warnings);
    assert.equal(warnings.length, 4);
    assert.match(warnings[0]!, /moved or copied from \/home\/old\/\.openclaw.*rebased onto \/backup\/\.openclaw/);
    assert.match(warnings[1]!, /^case-collision in profiles: Work, work \(the target volume cannot hold them apart/);
    assert.match(warnings[2]!, /^unportable-name in skills: a:b \(the target volume cannot hold these names/);
    assert.match(warnings[3]!, /^1 config path\(s\) could not be mapped.*--map <source-prefix>=<local-prefix>/);
    assert.deepEqual([report.movedFrom, report.problems.length, report.unmapped.length, report.origin, report.flavour], [["/home/old/.openclaw"], 2, 1, "native", "posix"]);
  });
  it("the report never contains the environment or the vars handed to the mapper", () => {
    const m = new SourcePathMapper(posixLoc(), { vars: { SECRET_VAR: "redact-probe-alpha" }, env: { TOKEN_ENV: "redact-probe-beta" } });
    m.map("${NOPE}/x", "k");
    assert.ok(!JSON.stringify(m.report()).includes("redact-probe"));
  });
});

describe("locateSource: unusual roots", () => {
  const types: [string, string, NodeJS.Platform, Record<string, string>, string][] = [
    ["a /mnt/c root outside WSL", "/mnt/c/Users/J/.openclaw", "linux", {}, "native"],
    ["a /mnt/c root inside WSL (WSL_INTEROP only)", "/mnt/c/Users/J/.openclaw", "linux", { WSL_INTEROP: "/run/WSL/1_interop" }, "windows-from-wsl"],
    ["a /mnt/cc root (two letters) inside WSL", "/mnt/cc/Users/J/.openclaw", "linux", { WSL_DISTRO_NAME: "U" }, "native"],
    ["a UNC share on Linux", "\\\\nas\\backup\\x", "linux", {}, "native"],
    ["a UNC share on Windows", "\\\\nas\\backup\\x", "win32", {}, "network"],
    ["a device path on Windows (\\\\?\\C:\\x)", "\\\\?\\C:\\Users\\u\\x", "win32", {}, "native"],
    ["a wsl$ root with forward slashes on Linux", "//wsl$/Ubuntu/home/u/.openclaw", "linux", {}, "wsl:Ubuntu"],
  ];
  for (const [title, root, platform, env, origin] of types) {
    it(`${title} is ${origin}`, () => assert.equal(locateSource({ accessRoot: root, platform, env, home: null }).origin, origin));
  }
  it("'..' inside a wsl: specification is resolved, and cannot climb above '/'", () => {
    const l = locateSource({ accessRoot: "wsl:Ubuntu:/home/u/../../../../etc/.openclaw", platform: "win32", env: {}, home: null });
    assert.equal(l.sourceRoot, "/etc/.openclaw");
    assert.equal(l.accessRoot, "\\\\wsl.localhost\\Ubuntu\\etc\\.openclaw");
  });
  it("a wsl: specification gets a leading '/' when it has none", () => {
    assert.equal(locateSource({ accessRoot: "wsl:Debian:home/u/.hermes", platform: "win32", env: {}, home: null }).sourceRoot, "/home/u/.hermes");
  });
  it("on a POSIX host the wsl: specification is read through \\\\wsl.localhost/<distro>/... with forward slashes", () => {
    const l = locateSource({ accessRoot: "wsl:Debian:/home/u/.hermes", platform: "linux", env: {}, home: null });
    assert.equal(l.accessRoot, "\\\\wsl.localhost\\Debian/home/u/.hermes");
    assert.equal(l.origin, "wsl:Debian");
  });
});

