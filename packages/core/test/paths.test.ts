import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { coreAddress, layout, resolveHome, supervisorAddress } from "../src/paths.ts";

describe("paths", () => {
  it("prefers --home, then PLUR1BUS_HOME, then the platform default", () => {
    assert.equal(resolveHome({ home: "/x", env: { PLUR1BUS_HOME: "/y" }, platform: "linux", homedir: "/h" }), resolve("/x"));
    assert.equal(resolveHome({ env: { PLUR1BUS_HOME: "/y" }, platform: "linux", homedir: "/h" }), resolve("/y"));
    assert.equal(resolveHome({ env: {}, platform: "darwin", homedir: "/Users/c" }), "/Users/c/.plur1bus");
    assert.equal(resolveHome({ env: {}, platform: "win32", homedir: "C:\\Users\\c", localAppData: "C:\\Users\\c\\AppData\\Local" }), "C:\\Users\\c\\AppData\\Local\\PLUR1BUS");
  });
  it("lays out the spec directories", () => {
    const l = layout("/h/.plur1bus");
    assert.equal(l.configPath, "/h/.plur1bus/config.json");
    assert.equal(l.lancedb, "/h/.plur1bus/state/lancedb");
    assert.equal(l.journal, "/h/.plur1bus/state/journal");
    assert.equal(l.workspaceDir("bernd"), "/h/.plur1bus/agents/bernd/workspace");
    assert.equal(l.coreSocket, "/h/.plur1bus/run/core.sock");
    assert.equal(l.coreLock, "/h/.plur1bus/state/core.lock");
    assert.equal(l.logFile("core"), "/h/.plur1bus/logs/core.log");
  });
  it("lays out the model catalog and the system-job state", () => {
    const l = layout("/h");
    assert.equal(l.catalog, "/h/catalog");
    assert.equal(l.catalogModels, "/h/catalog/models.json");
    assert.equal(l.systemJobs, "/h/state/system-jobs");
  });
  it("names a per-home pipe on windows and the socket elsewhere", () => {
    assert.equal(coreAddress("/h/.plur1bus", "linux"), "/h/.plur1bus/run/core.sock");
    assert.match(coreAddress("C:\\Users\\c\\AppData\\Local\\PLUR1BUS", "win32"), /^\\\\\.\\pipe\\plur1bus-[0-9a-f]{16}-core$/);
  });
  it("names the supervisor's token, pid and address next to the core's", () => {
    const l = layout("/h/.plur1bus");
    assert.equal(l.supervisorToken, "/h/.plur1bus/run/supervisor.token");
    assert.equal(l.supervisorPid, "/h/.plur1bus/run/supervisor.pid");
    assert.equal(supervisorAddress("/h/.plur1bus", "linux"), "/h/.plur1bus/run/supervisor.sock");
    const home = "C:\\Users\\c\\AppData\\Local\\PLUR1BUS";
    const sup = supervisorAddress(home, "win32");
    assert.match(sup, /^\\\\\.\\pipe\\plur1bus-[0-9a-f]{16}-supervisor$/);
    assert.equal(sup.replace(/-supervisor$/, "-core"), coreAddress(home, "win32"), "same per-home hash as the core pipe");
  });
  it("audit: a layout rooted at a POSIX home with a backslash in its name keeps POSIX semantics", () => {
    const l = layout("/srv/we\\ird");
    assert.equal(l.configPath, "/srv/we\\ird/config.json");
    assert.equal(l.workspaceDir("a"), "/srv/we\\ird/agents/a/workspace");
  });
  it("audit: a Windows home with forward slashes or a UNC prefix gets Windows joins", () => {
    assert.equal(layout("C:/Users/c/h").configPath, "C:\\Users\\c\\h\\config.json");
    assert.equal(layout("\\\\srv\\share\\h").configPath, "\\\\srv\\share\\h\\config.json");
  });
  it("audit: agent ids and log roles that would leave their directory are refused", () => {
    const l = layout("/h");
    for (const bad of ["..", ".", "", "../x", "a/b", "a\\b", "a\0b", "C:evil"]) {
      assert.throws(() => l.agentDir(bad), /invalid path segment/, `agentDir(${JSON.stringify(bad)})`);
      assert.throws(() => l.workspaceDir(bad), /invalid path segment/, `workspaceDir(${JSON.stringify(bad)})`);
      assert.throws(() => l.logFile(bad), /invalid path segment/, `logFile(${JSON.stringify(bad)})`);
    }
    assert.equal(l.agentDir("a b"), "/h/agents/a b", "spaces and non-ASCII letters stay legal");
    assert.equal(l.agentDir("\u00e9t\u00e9"), "/h/agents/\u00e9t\u00e9");
  });
  it("audit: an empty LOCALAPPDATA or an empty home directory never yields a relative home", () => {
    assert.equal(resolveHome({ env: { LOCALAPPDATA: "" }, platform: "win32", homedir: "C:\\Users\\c" }), "C:\\Users\\c\\AppData\\Local\\PLUR1BUS");
    assert.throws(() => resolveHome({ env: {}, platform: "linux", homedir: "" }), /home directory/);
    assert.throws(() => resolveHome({ env: {}, platform: "linux", homedir: "rel/home" }), /home directory/);
    assert.throws(() => resolveHome({ env: {}, platform: "win32", homedir: "C:\\Users\\c", localAppData: "AppData" }), /home directory/);
  });
  it("audit: a blank PLUR1BUS_HOME is unset, and ~ is expanded instead of creating a directory named ~", () => {
    assert.equal(resolveHome({ env: { PLUR1BUS_HOME: "   " }, platform: "linux", homedir: "/h" }), "/h/.plur1bus");
    assert.equal(resolveHome({ env: { PLUR1BUS_HOME: "~/p1b" }, platform: "linux", homedir: "/h" }), "/h/p1b");
    assert.equal(resolveHome({ home: "~", platform: "linux", homedir: "/h" }), "/h");
  });
  it("audit: a Windows --home is resolved with Windows rules even when run elsewhere", () => {
    assert.equal(resolveHome({ home: "D:\\Data\\..\\p1b", platform: "win32", homedir: "C:\\Users\\c" }), "D:\\p1b");
    assert.equal(resolveHome({ env: { PLUR1BUS_HOME: "\\\\srv\\share\\p1b" }, platform: "win32", homedir: "C:\\Users\\c" }), "\\\\srv\\share\\p1b");
  });
});
