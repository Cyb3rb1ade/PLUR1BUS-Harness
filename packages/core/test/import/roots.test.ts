// Source-root resolution per OS (docs/import.md §8.3, plugin-distribution spec §B.1, gaps G1/G2). The platform, the
// environment and the existence check are injected, so the Windows and macOS rules run on every CI OS.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { expandUser, expandVars } from "../../src/import/paths.ts";
import { resolveHermesRoot } from "../../src/import/sources/hermes.ts";
import { resolveOpenclawRoot } from "../../src/import/sources/openclaw.ts";

const none = () => false;
const only = (...dirs: string[]) => (p: string) => dirs.includes(p);

describe("expandVars / expandUser (Python's expandvars + expanduser, per flavour)", () => {
  it("expands $VAR and ${VAR} on POSIX, leaves %VAR% and unknown names alone", () => {
    const env = { A: "/a", B: "b" };
    assert.equal(expandVars("$A/x/${B}/%B%/$NOPE", env, "linux"), "/a/x/b/%B%/$NOPE");
  });
  it("expands %VAR%, $VAR and ${VAR} on Windows, case-insensitively", () => {
    const env = { LOCALAPPDATA: "C:\\Users\\J\u00fcrgen\\AppData\\Local", user: "j" };
    assert.equal(expandVars("%localappdata%\\hermes", env, "win32"), "C:\\Users\\J\u00fcrgen\\AppData\\Local\\hermes");
    assert.equal(expandVars("$USER-${User}-%NOPE%", env, "win32"), "j-j-%NOPE%");
  });
  it("expands ~ against HOME on POSIX and USERPROFILE on Windows", () => {
    assert.equal(expandUser("~/x", { HOME: "/home/u" }, "/fallback", "linux"), "/home/u/x");
    assert.equal(expandUser("~", {}, "/fallback", "darwin"), "/fallback");
    assert.equal(expandUser("~\\x", { USERPROFILE: "C:\\Users\\u", HOME: "/c/ignored" }, "C:\\fb", "win32"), "C:\\Users\\u\\x");
    assert.equal(expandUser("~/x", {}, "C:\\fb", "win32"), "C:\\fb\\x");
    assert.equal(expandUser("~\\x", {}, "/fb", "linux"), "~\\x", "a backslash is a file-name character on POSIX");
    assert.equal(expandUser("~other/x", {}, "/fb", "linux"), "~other/x");
  });
});

describe("Hermes root per OS (G1)", () => {
  it("defaults to ~/.hermes on Linux and macOS", () => {
    for (const platform of ["linux", "darwin"] as const) {
      assert.deepEqual(resolveHermesRoot({ env: {}, homedir: "/home/u", platform }), { root: "/home/u/.hermes", resolvedFrom: "default", profile: null });
    }
  });
  it("defaults to %LOCALAPPDATA%\\hermes on Windows, else %USERPROFILE%\\AppData\\Local\\hermes", () => {
    assert.equal(resolveHermesRoot({ env: { LOCALAPPDATA: "D:\\Local" }, homedir: "C:\\Users\\u", platform: "win32" }).root, "D:\\Local\\hermes");
    assert.equal(resolveHermesRoot({ env: { LOCALAPPDATA: "  ", USERPROFILE: "C:\\Users\\J\u00fcrgen" }, homedir: "C:\\x", platform: "win32" }).root, "C:\\Users\\J\u00fcrgen\\AppData\\Local\\hermes");
    assert.equal(resolveHermesRoot({ env: {}, homedir: "C:\\Users\\u", platform: "win32" }).root, "C:\\Users\\u\\AppData\\Local\\hermes");
  });
  it("expands variables and ~ in HERMES_HOME", () => {
    assert.equal(resolveHermesRoot({ env: { HERMES_HOME: "$XDG_DATA_HOME/hermes", XDG_DATA_HOME: "/data" }, homedir: "/home/u", platform: "linux" }).root, "/data/hermes");
    assert.equal(resolveHermesRoot({ env: { HERMES_HOME: "~/hh" }, homedir: "/home/u", platform: "linux" }).root, "/home/u/hh");
    assert.equal(resolveHermesRoot({ env: { HERMES_HOME: "%LOCALAPPDATA%\\hermes-alt", LOCALAPPDATA: "C:\\L" }, homedir: "C:\\Users\\u", platform: "win32" }).root, "C:\\L\\hermes-alt");
    assert.equal(resolveHermesRoot({ env: { HERMES_HOME: "~\\hh", USERPROFILE: "C:\\Users\\u" }, homedir: "C:\\x", platform: "win32" }).root, "C:\\Users\\u\\hh");
  });
  it("turns a HERMES_HOME of <root>/profiles/<name> into the root plus that profile", () => {
    assert.deepEqual(resolveHermesRoot({ env: { HERMES_HOME: "/srv/h/profiles/work" }, homedir: "/home/u", platform: "linux" }), { root: "/srv/h", resolvedFrom: "env:HERMES_HOME", profile: "work" });
    assert.deepEqual(resolveHermesRoot({ env: { HERMES_HOME: "C:\\L\\hermes\\Profiles\\Work" }, homedir: "C:\\x", platform: "win32" }), { root: "C:\\L\\hermes", resolvedFrom: "env:HERMES_HOME", profile: "Work" });
  });
  it("--source wins and is ~-expanded", () => {
    assert.deepEqual(resolveHermesRoot({ source: "~/copy", env: { HERMES_HOME: "/h" }, homedir: "/home/u", platform: "linux" }), { root: "/home/u/copy", resolvedFrom: "flag:--source", profile: null });
  });
});

describe("Hermes root vectors shared with the Hermes provider and installer (HM2 F11)", () => {
  it("hosts/hermes/tests/fixtures/hermes-home-vectors.json matches resolveHermesRoot", () => {
    const url = new URL("../../../../hosts/hermes/tests/fixtures/hermes-home-vectors.json", import.meta.url);
    const doc = JSON.parse(readFileSync(url, "utf8")) as { cases: { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; homedir: string; root: string; resolvedFrom: string; profile: string | null }[] };
    assert.ok(doc.cases.length >= 10);
    for (const c of doc.cases) {
      assert.deepEqual(resolveHermesRoot({ env: c.env, homedir: c.homedir, platform: c.platform }), { root: c.root, resolvedFrom: c.resolvedFrom, profile: c.profile }, JSON.stringify(c));
    }
  });
});

describe("OpenClaw root per OS (G2)", () => {
  it("uses OPENCLAW_HOME, then HOME, then USERPROFILE, then os.homedir() on every OS", () => {
    const r = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform, homedir: string) => resolveOpenclawRoot({ env, homedir, platform, exists: none }).root;
    assert.equal(r({ HOME: "C:\\Users\\gitbash", USERPROFILE: "C:\\Users\\u" }, "win32", "C:\\Users\\os"), "C:\\Users\\gitbash\\.openclaw");
    assert.equal(r({ USERPROFILE: "C:\\Users\\J\u00fcrgen" }, "win32", "C:\\Users\\os"), "C:\\Users\\J\u00fcrgen\\.openclaw");
    assert.equal(r({}, "win32", "C:\\Users\\os"), "C:\\Users\\os\\.openclaw");
    assert.equal(r({ HOME: "/Users/u" }, "darwin", "/Users/os"), "/Users/u/.openclaw");
    assert.equal(r({ OPENCLAW_HOME: "~/alt", HOME: "/home/u" }, "linux", "/os"), "/home/u/alt/.openclaw");
    assert.equal(r({ OPENCLAW_HOME: "~\\alt", USERPROFILE: "C:\\Users\\u" }, "win32", "C:\\os"), "C:\\Users\\u\\alt\\.openclaw");
  });
  it("falls back to the legacy .clawdbot dir only when it alone exists", () => {
    const home = "C:\\Users\\u";
    const legacy = resolveOpenclawRoot({ env: { USERPROFILE: home }, homedir: home, platform: "win32", exists: only("C:\\Users\\u\\.clawdbot") });
    assert.deepEqual([legacy.root, legacy.resolvedFrom], ["C:\\Users\\u\\.clawdbot", "default-legacy"]);
    const both = resolveOpenclawRoot({ env: {}, homedir: "/home/u", platform: "linux", exists: only("/home/u/.clawdbot", "/home/u/.openclaw") });
    assert.deepEqual([both.root, both.resolvedFrom], ["/home/u/.openclaw", "default"]);
  });
  it("takes a legacy clawdbot.json config when openclaw.json is missing", () => {
    const r = resolveOpenclawRoot({ env: {}, homedir: "/home/u", platform: "linux", exists: none, isFile: only("/home/u/.openclaw/clawdbot.json") });
    assert.equal(r.configPath, "/home/u/.openclaw/clawdbot.json");
    assert.equal(resolveOpenclawRoot({ env: {}, homedir: "/home/u", platform: "linux", exists: none, isFile: none }).configPath, "/home/u/.openclaw/openclaw.json");
  });
  it("keeps the documented override order with Windows paths", () => {
    const env = { OPENCLAW_STATE_DIR: "~\\state", OPENCLAW_HOME: "D:\\oc", OPENCLAW_CONFIG_PATH: "D:\\cfg\\oc.json" };
    const r = resolveOpenclawRoot({ env, homedir: "C:\\Users\\u", platform: "win32", exists: none });
    assert.deepEqual(r, { root: "D:\\oc\\state", resolvedFrom: "env:OPENCLAW_STATE_DIR", configPath: "D:\\cfg\\oc.json" });
    assert.equal(resolveOpenclawRoot({ env: { OPENCLAW_PROFILE: "work", USERPROFILE: "C:\\Users\\u" }, homedir: "C:\\x", platform: "win32", exists: none }).root, "C:\\Users\\u\\.openclaw-work");
  });
});
