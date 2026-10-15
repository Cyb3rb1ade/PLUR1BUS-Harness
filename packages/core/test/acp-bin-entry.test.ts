import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/temp-dir.ts";

const entry = fileURLToPath(new URL("../src/acp-bin.ts", import.meta.url));
const NODE_ARGS = ["--experimental-strip-types", "--conditions=source", "--no-warnings=ExperimentalWarning"];
// HOME and PLUR1BUS_HOME point at an empty directory: a run that ignores `--home=` must not find (or touch) a real core.
const run = (args: string[]) => {
  const dir = tempDir("p1b-acp-bin-");
  return spawnSync(process.execPath, [...NODE_ARGS, entry, ...args], { encoding: "utf8", input: "", timeout: 30_000, env: { ...process.env, HOME: dir, USERPROFILE: dir, LOCALAPPDATA: dir, PLUR1BUS_HOME: dir } });
};
const REQUIRED = ["--agent", "a", "--account", "h", "--user", "u"];

describe("acp-bin.ts arguments", () => {
  it("an empty --home= is a usage error (exit 2), not 'use the default home'", () => {
    const r = run(["--home=", ...REQUIRED]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /--home/);
    assert.equal(r.stdout, "", "stdout is ACP JSON-RPC only");
  });
  it("an unknown flag is a usage error (exit 2) with no stack on stderr", () => {
    const r = run(["--bogus", ...REQUIRED]);
    assert.equal(r.status, 2, r.stderr);
    assert.doesNotMatch(r.stderr, /^\s+at /m);
    assert.equal(r.stdout, "");
  });
});
