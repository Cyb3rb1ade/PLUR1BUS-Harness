import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { coreAddress, layout, resolveHome } from "../src/paths.ts";

describe("paths", () => {
  it("prefers --home, then PLUR1BUS_HOME, then the platform default", () => {
    assert.equal(resolveHome({ home: "/x", env: { PLUR1BUS_HOME: "/y" }, platform: "linux", homedir: "/h" }), "/x");
    assert.equal(resolveHome({ env: { PLUR1BUS_HOME: "/y" }, platform: "linux", homedir: "/h" }), "/y");
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
  it("names a per-home pipe on windows and the socket elsewhere", () => {
    assert.equal(coreAddress("/h/.plur1bus", "linux"), "/h/.plur1bus/run/core.sock");
    assert.match(coreAddress("C:\\Users\\c\\AppData\\Local\\PLUR1BUS", "win32"), /^\\\\\.\\pipe\\plur1bus-[0-9a-f]{16}-core$/);
  });
});
