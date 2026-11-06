/** Regressions: infrastructure errors never become measured model losses, and paid work cannot lose its report path. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { access, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { realTempDir } from "../helpers/real-temp-dir.ts";
import { verifyCodingCandidate } from "../../src/toolcall/coding-bench-verify.ts";
import { reserveCodingPublication } from "../../src/toolcall/coding-bench-publication.ts";
import { createCodingBox, CodingIsolationUnavailable } from "../../src/toolcall/coding-bench-box.ts";

test("verifier provisioning or cleanup failures propagate instead of becoming invalid-image results", async () => {
  const root = await realTempDir("p1b-coding-verification-");
  try {
    await writeFile(join(root, "solution.ts"), "public source");
    for (const phase of ["provision", "cleanup"]) {
      const failure = new Error(`trusted ${phase} failed`);
      await assert.rejects(
        verifyCodingCandidate(
          root,
          async () => { throw failure; },
          "solution.ts",
        ),
        (error) => error === failure,
      );
    }
    const neverVerify = async (): Promise<never> => { throw new Error("invalid candidates must not invoke the verifier"); };
    await assert.rejects(verifyCodingCandidate(join(root, "missing"), neverVerify, "solution.ts"), { code: "ENOENT" });
    await assert.rejects(verifyCodingCandidate(join(root, "solution.ts"), neverVerify, "solution.ts"), /snapshot root/u);
    assert.equal((await verifyCodingCandidate(root, neverVerify, "missing.ts")).checker, "invalid-image");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("live verification requires an explicitly configured capped verifier, with no default backend", () => {
  assert.throws(
    () =>
      createCodingBox({
        mode: "live",
        node: process.execPath,
        environment: {},
        captureSource: "",
        signal: new AbortController().signal,
      }),
    CodingIsolationUnavailable,
  );
});

test("report reservations reject duplicates before work and delete uncommitted captures", async () => {
  const root = await realTempDir("p1b-coding-publication-");
  try {
    const output = join(root, "capture.json");
    const first = await reserveCodingPublication(output);
    await assert.rejects(reserveCodingPublication(output));
    await first.close();
    await assert.rejects(access(output));
    const second = await reserveCodingPublication(output);
    try {
      await second.commit('{"complete":true}\n');
    } finally {
      await second.close();
    }
    assert.equal(await readFile(output, "utf8"), '{"complete":true}\n');
    await assert.rejects(reserveCodingPublication(output));
    assert.deepEqual(await readdir(root), ["capture.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
