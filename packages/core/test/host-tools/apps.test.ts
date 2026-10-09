import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runHostTool } from "../../src/host-tools/index.ts";
import { makeCtx, ok } from "./helpers.ts";

describe("apps.*", () => {
  it("lists installed applications per OS", async () => {
    const mac = ok<{ apps: Array<{ name: string; path?: string }> }>(await runHostTool("apps.list", {}, makeCtx("darwin").ctx));
    assert.ok(mac.apps.some((a) => a.name === "Safari"));
    const lin = ok<{ apps: Array<{ name: string }> }>(await runHostTool("apps.list", {}, makeCtx("linux").ctx));
    assert.ok(lin.apps.some((a) => a.name === "Firefox"));
    const win = ok<{ apps: Array<{ name: string }> }>(await runHostTool("apps.list", {}, makeCtx("win32").ctx));
    assert.ok(win.apps.some((a) => /Safari|Visual Studio Code/.test(a.name)));
  });

  it("open allows http/https/mailto and refuses other URL schemes", async () => {
    const { ctx, exec } = makeCtx("darwin");
    for (const target of ["https://example.com", "http://example.com", "mailto:a@b.c"]) {
      const r = await runHostTool("apps.open", { target, kind: "url" }, ctx);
      assert.equal(r.isError, false, target);
    }
    const file = await runHostTool("apps.open", { target: "javascript:alert(1)", kind: "url" }, ctx);
    assert.equal(file.isError, true);
    if (file.isError) assert.equal(file.error.code, "denied_by_denylist");
    const ftp = await runHostTool("apps.open", { target: "ftp://x", kind: "url" }, ctx);
    assert.equal(ftp.isError, true);
    const open = exec.calls.filter((c) => c.program === "open");
    assert.ok(open.every((c) => c.args.every((a) => typeof a === "string")));
    assert.ok(open[0] && !open[0].args.join(" ").includes("&&"));
  });

  it("running returns GUI app names when the platform can list them", async () => {
    const mac = ok<{ apps: Array<{ name: string }> }>(await runHostTool("apps.running", {}, makeCtx("darwin").ctx));
    assert.ok(mac.apps.some((a) => a.name === "Safari"));
    const lin = ok<{ apps: Array<{ name: string }> }>(await runHostTool("apps.running", {}, makeCtx("linux").ctx));
    assert.ok(lin.apps.some((a) => /firefox/i.test(a.name)));
    const win = ok<{ apps: Array<{ name: string }> }>(await runHostTool("apps.running", {}, makeCtx("win32").ctx));
    assert.ok(win.apps.some((a) => /explorer/i.test(a.name)));
  });
});
