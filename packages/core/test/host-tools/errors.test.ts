import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { HostFailure, runHostTool } from "../../src/host-tools/index.ts";
import { makeCtx } from "./helpers.ts";

describe("host-tools errors", () => {
  it("unknown tools and malformed input are invalid_input", async () => {
    const { ctx } = makeCtx("darwin");
    const missing = await runHostTool("proc.explode", {}, ctx);
    assert.equal(missing.isError, true);
    if (missing.isError) assert.equal(missing.error.code, "invalid_input");
    const bad = await runHostTool("proc.info", { pid: "nope" }, ctx);
    assert.equal(bad.isError, true);
    if (bad.isError) assert.equal(bad.error.code, "invalid_input");
  });

  it("HostFailure carries the closed code set", () => {
    const codes = [
      "not_supported_on_platform", "not_found", "permission_denied",
      "timeout", "aborted", "denied_by_denylist", "invalid_input", "too_large",
    ] as const;
    for (const c of codes) {
      const e = new HostFailure(c, c);
      assert.equal(e.code, c);
      assert.equal(e.toResult().error.code, c);
    }
  });

  it("aborted signal is reported as aborted without spawning", async () => {
    const ac = new AbortController();
    ac.abort();
    const { ctx, exec } = makeCtx("darwin", { signal: ac.signal });
    const r = await runHostTool("proc.list", {}, ctx);
    assert.equal(r.isError, true);
    if (r.isError) assert.equal(r.error.code, "aborted");
    assert.equal(exec.calls.length, 0);
  });
});
