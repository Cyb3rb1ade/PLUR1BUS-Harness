import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { helperFromEnv, helperPinned } from "../../src/attestation/index.ts";

const dir = mkdtempSync(join(tmpdir(), "att-res-"));
const exe = (name: string, mode: number): string => { const p = join(dir, name); writeFileSync(p, "#!/bin/sh\n"); chmodSync(p, mode); return p; };
const posix = { skip: process.platform === "win32" };

describe("attestation helper resolution and pinning", () => {
  it("uses PLUR1BUS_ATTEST_BIN when it is an absolute, owner-only regular file", posix, () => {
    const p = exe("ok", 0o755);
    assert.deepEqual(helperFromEnv({ PLUR1BUS_ATTEST_BIN: p }), { path: p });
  });
  it("is no helper when unset, empty, relative, missing, a directory, a link, or group/world-writable", posix, () => {
    const link = join(dir, "link"); symlinkSync(exe("target", 0o755), link);
    for (const v of [undefined, "", "attest", "./attest", join(dir, "nope"), dir, link, exe("loose", 0o775), exe("open", 0o757)]) {
      assert.equal(helperFromEnv(v === undefined ? {} : { PLUR1BUS_ATTEST_BIN: v }), null, String(v));
    }
    assert.equal(helperPinned(link), false);
  });
  it("is no helper in container mode, whatever the variable says", posix, () => {
    assert.equal(helperFromEnv({ PLUR1BUS_ATTEST_BIN: exe("c", 0o755), PLUR1BUS_CONTAINER: "1" }), null);
  });
});
