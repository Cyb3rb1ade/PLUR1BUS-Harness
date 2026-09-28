// SourcePathMapper (plugin-distribution spec §B.4, gaps G3/G4): paths read from a source's config are parsed with the
// source's flavour, expanded against the source-side home and rebased onto where the source is read from — or
// reported unmapped with a named reason, never guessed. Pure string logic with the platform injected: every case runs
// on every CI OS.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { locateSource, parseMaps, SourcePathMapper, type MapResult } from "../../src/import/paths.ts";

const path = (r: MapResult) => (r.path === null ? `unmapped:${r.reason}` : `${r.how}:${r.path}`);

describe("locateSource", () => {
  it("treats a plain root as native, in the host's flavour", () => {
    assert.deepEqual(locateSource({ accessRoot: "/home/u/.openclaw", platform: "linux", env: {}, home: "/home/u" }), {
      origin: "native", flavour: "posix", hostFlavour: "posix", accessRoot: "/home/u/.openclaw", sourceRoot: "/home/u/.openclaw", sourceHome: "/home/u", accessHome: "/home/u", mounts: [],
    });
    const w = locateSource({ accessRoot: "C:\\Users\\u\\.openclaw", platform: "win32", env: {}, home: "C:\\Users\\u" });
    assert.deepEqual([w.origin, w.flavour, w.sourceRoot], ["native", "win32", "C:\\Users\\u\\.openclaw"]);
  });
  it("reads a \\\\wsl$ or \\\\wsl.localhost root as a POSIX source inside that distro", () => {
    for (const unc of ["\\\\wsl.localhost\\Ubuntu-24.04\\home\\j\u00fcrgen\\.openclaw", "\\\\wsl$\\Ubuntu-24.04\\home\\j\u00fcrgen\\.openclaw", "//wsl.localhost/Ubuntu-24.04/home/j\u00fcrgen/.openclaw"]) {
      const l = locateSource({ accessRoot: unc, platform: "win32", env: {}, home: "C:\\Users\\J" });
      assert.deepEqual([l.origin, l.flavour, l.sourceRoot, l.sourceHome], ["wsl:Ubuntu-24.04", "posix", "/home/j\u00fcrgen/.openclaw", "/home/j\u00fcrgen"], unc);
      assert.match(l.accessHome!, /^(\\\\|\/\/)wsl(\$|\.localhost)[\\/]Ubuntu-24\.04[\\/]home[\\/]j\u00fcrgen$/);
    }
    const root = locateSource({ accessRoot: "\\\\wsl.localhost\\OpenClawGateway\\root\\.openclaw", platform: "win32", env: {}, home: "C:\\Users\\J" });
    assert.deepEqual([root.sourceRoot, root.sourceHome], ["/root/.openclaw", "/root"]);
  });
  it("reads /mnt/<drive> inside WSL as a Windows source", () => {
    const l = locateSource({ accessRoot: "/mnt/c/Users/J\u00fcrgen/AppData/Local/hermes", platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu" }, home: "/home/j" });
    assert.deepEqual([l.origin, l.flavour, l.sourceRoot, l.sourceHome, l.accessHome], ["windows-from-wsl", "win32", "C:\\Users\\J\u00fcrgen\\AppData\\Local\\hermes", "C:\\Users\\J\u00fcrgen", "/mnt/c/Users/J\u00fcrgen"]);
    assert.equal(locateSource({ accessRoot: "/mnt/c/Users/J/.openclaw", platform: "linux", env: {}, home: "/home/j" }).origin, "native", "/mnt/c outside WSL is just a directory");
  });
  it("marks a UNC share on Windows as a network source", () => {
    assert.equal(locateSource({ accessRoot: "\\\\nas\\backup\\.openclaw", platform: "win32", env: {}, home: "C:\\Users\\u" }).origin, "network");
  });
});

describe("SourcePathMapper — native sources", () => {
  const linux = new SourcePathMapper(locateSource({ accessRoot: "/home/u/.openclaw", platform: "linux", env: {}, home: "/home/u" }), { vars: { OPENCLAW_HOME: "/home/u/.openclaw" } });
  it("resolves relative paths against the root, ~ against the home and ${OPENCLAW_HOME}", () => {
    assert.equal(path(linux.map("ws", "k")), "native:/home/u/.openclaw/ws");
    assert.equal(path(linux.map("~/proj", "k")), "native:/home/u/proj");
    assert.equal(path(linux.map("${OPENCLAW_HOME}/memory", "k")), "native:/home/u/.openclaw/memory");
    assert.equal(path(linux.map("/srv/skills/", "k")), "native:/srv/skills");
  });
  it("leaves other variables unresolved", () => assert.equal(path(linux.map("${DATA}/x", "k")), "unmapped:env-var"));
  it("reports a Windows path in a POSIX-read config as foreign instead of resolving it under the root", () => {
    assert.equal(path(linux.map("C:\\Users\\u\\projects\\ws", "k")), "unmapped:foreign-path");
    assert.equal(path(linux.map("D:/data/skills", "k")), "unmapped:foreign-path");
  });
  it("rebases a path under the root's original location when the root was copied or moved", () => {
    const copied = new SourcePathMapper(locateSource({ accessRoot: "/backup/.openclaw", platform: "linux", env: {}, home: "/home/u" }));
    assert.equal(path(copied.map("C:\\Users\\J\u00fcrgen\\.openclaw\\ws-alpha", "agents.list[0].workspace")), "rebased:/backup/.openclaw/ws-alpha");
    assert.equal(path(copied.map("/home/old/.openclaw/memory/lancedb", "k")), "rebased:/backup/.openclaw/memory/lancedb");
    assert.equal(path(copied.map("/opt/.openclaw/x", "k")), "native:/opt/.openclaw/x", "only a root that sat in a home directory is rebased by name");
    assert.deepEqual(copied.movedFrom, ["C:\\Users\\J\u00fcrgen\\.openclaw", "/home/old/.openclaw"]);
  });
  it("on Windows: POSIX paths are foreign (never C:\\home\\...), backslash-relative paths join the root, \\x is drive-relative", () => {
    const win = new SourcePathMapper(locateSource({ accessRoot: "C:\\Users\\u\\.openclaw", platform: "win32", env: {}, home: "C:\\Users\\u" }));
    assert.equal(path(win.map("/opt/skills", "k")), "unmapped:foreign-path");
    assert.equal(path(win.map("/home/u/.openclaw/workspace", "k")), "rebased:C:\\Users\\u\\.openclaw\\workspace");
    assert.equal(path(win.map("skills\\extra", "k")), "native:C:\\Users\\u\\.openclaw\\skills\\extra");
    assert.equal(path(win.map("~\\ws", "k")), "native:C:\\Users\\u\\ws");
    assert.equal(path(win.map("\\ws", "k")), "unmapped:drive-relative");
    assert.equal(path(win.map("D:ws", "k")), "unmapped:drive-relative");
    assert.equal(path(win.map("d:\\Data\\ws", "k")), "native:d:\\Data\\ws");
  });
  it("records every non-native mapping and every unmapped path with its config key", () => {
    const m = new SourcePathMapper(locateSource({ accessRoot: "/home/u/.openclaw", platform: "linux", env: {}, home: "/home/u" }));
    m.map("C:\\x", "skills.load.extraDirs[0]"); m.map("ws", "agents.defaults.workspace");
    assert.deepEqual(m.report().unmapped, [{ key: "skills.load.extraDirs[0]", value: "C:\\x", reason: "foreign-path" }]);
    assert.deepEqual(m.report().mapped, []);
  });
});

describe("SourcePathMapper — WSL-hosted source read from Windows", () => {
  const m = new SourcePathMapper(locateSource({ accessRoot: "\\\\wsl.localhost\\Ubuntu\\home\\u\\.openclaw", platform: "win32", env: {}, home: "C:\\Users\\U" }), { vars: { OPENCLAW_HOME: "/home/u/.openclaw" } });
  it("maps the root, the WSL home, /mnt/<drive> and the rest of the distro", () => {
    assert.equal(path(m.map("/home/u/.openclaw/workspace", "k")), "root:\\\\wsl.localhost\\Ubuntu\\home\\u\\.openclaw\\workspace");
    assert.equal(path(m.map("${OPENCLAW_HOME}/memory", "k")), "root:\\\\wsl.localhost\\Ubuntu\\home\\u\\.openclaw\\memory");
    assert.equal(path(m.map("~/projects/ws", "k")), "home:\\\\wsl.localhost\\Ubuntu\\home\\u\\projects\\ws");
    assert.equal(path(m.map("/mnt/d/Data/skills", "k")), "mount:D:\\Data\\skills");
    assert.equal(path(m.map("/opt/skills", "k")), "mount:\\\\wsl.localhost\\Ubuntu\\opt\\skills");
    assert.equal(path(m.map("workspace", "k")), "root:\\\\wsl.localhost\\Ubuntu\\home\\u\\.openclaw\\workspace");
  });
  it("still reports a Windows path in the Linux config as foreign", () => assert.equal(path(m.map("C:\\Users\\U\\ws", "k")), "unmapped:foreign-path"));
});

describe("SourcePathMapper — Windows source read from WSL", () => {
  const m = new SourcePathMapper(locateSource({ accessRoot: "/mnt/c/Users/J/.openclaw", platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu" }, home: "/home/j" }));
  it("maps drive paths case-insensitively onto /mnt/<drive>", () => {
    assert.equal(path(m.map("c:\\users\\j\\.OPENCLAW\\ws", "k")), "root:/mnt/c/Users/J/.openclaw/ws");
    assert.equal(path(m.map("C:\\Users\\J\\projects", "k")), "home:/mnt/c/Users/J/projects");
    assert.equal(path(m.map("E:/skills", "k")), "mount:/mnt/e/skills");
    assert.equal(path(m.map("~\\x", "k")), "home:/mnt/c/Users/J/x");
    assert.equal(path(m.map("skills\\extra", "k")), "root:/mnt/c/Users/J/.openclaw/skills/extra");
  });
  it("reports a POSIX path in the Windows config as foreign", () => assert.equal(path(m.map("/opt/x", "k")), "unmapped:foreign-path"));
});

describe("--map prefixes", () => {
  it("parses <source-prefix>=<local-prefix> and wins over every other rule", () => {
    const maps = parseMaps(["/home/u/projects=/srv/projects", "C:\\Data=/mnt/data"]);
    assert.deepEqual(maps, [{ from: "/home/u/projects", to: "/srv/projects" }, { from: "C:\\Data", to: "/mnt/data" }]);
    const m = new SourcePathMapper(locateSource({ accessRoot: "/home/u/.openclaw", platform: "linux", env: {}, home: "/home/u" }), { maps });
    assert.equal(path(m.map("/home/u/projects/ws", "k")), "map:/srv/projects/ws");
    assert.equal(path(m.map("c:\\data\\skills", "k")), "map:/mnt/data/skills");
    assert.equal(path(m.map("/home/u/projectsX", "k")), "native:/home/u/projectsX", "prefixes match whole segments");
  });
  it("refuses a malformed entry", () => {
    for (const bad of ["nope", "=x", "x="]) assert.throws(() => parseMaps([bad]), /--map/);
  });
});
