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
});
