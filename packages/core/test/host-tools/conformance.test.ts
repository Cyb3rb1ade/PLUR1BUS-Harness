import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runHostTool, type HostPlatform } from "../../src/host-tools/index.ts";
import { makeCtx, ok } from "./helpers.ts";

const PLATFORMS: HostPlatform[] = ["darwin", "win32", "linux"];

describe("per-OS conformance (fake exec fixtures)", () => {
  for (const platform of PLATFORMS) {
    describe(platform, () => {
      it("proc.list / sys.info / pkg.detect / clipboard.read share the same result shape", async () => {
        const { ctx } = makeCtx(platform);
        const procs = ok<{ processes: Array<{ pid: number; name: string; user: string; cpu: number; mem: number }> }>(
          await runHostTool("proc.list", {}, ctx), `${platform} proc.list`,
        );
        assert.ok(procs.processes.some((p) => p.pid === 400));
        const sys = ok<{ os: string; arch: string; ramBytes: number }>(await runHostTool("sys.info", {}, ctx), `${platform} sys.info`);
        assert.equal(sys.os, platform);
        const pkg = ok<{ managers: string[] }>(await runHostTool("pkg.detect", {}, ctx), `${platform} pkg.detect`);
        assert.ok(pkg.managers.length >= 1, platform);
        const clip = ok<{ text: string }>(await runHostTool("clipboard.read", {}, ctx), `${platform} clipboard.read`);
        assert.equal(typeof clip.text, "string");
        const disks = ok<{ disks: Array<{ mount: string; totalBytes: number; freeBytes: number }> }>(
          await runHostTool("sys.disks", {}, ctx), `${platform} sys.disks`,
        );
        assert.ok(disks.disks.length >= 1);
        const net = ok<{ interfaces: unknown[] }>(await runHostTool("sys.network", {}, ctx), `${platform} sys.network`);
        assert.ok(net.interfaces.length >= 1);
      });

      it("proc.kill still refuses pid 1 and the harness pid", async () => {
        const { ctx } = makeCtx(platform);
        for (const pid of [1, 400]) {
          const r = await runHostTool("proc.kill", { pid }, ctx);
          assert.equal(r.isError, true, `${platform} pid ${pid}`);
          if (r.isError) assert.equal(r.error.code, "permission_denied");
        }
      });

      it("pkg.install is a plan with pkg.change / high and does not run the manager's install", async () => {
        const { ctx, exec } = makeCtx(platform);
        const before = exec.calls.length;
        const r = ok<{ plan: { args: string[]; capability: string; riskClass: string } }>(
          await runHostTool("pkg.install", { name: "ripgrep" }, ctx), `${platform} pkg.install`,
        );
        assert.equal(r.plan.capability, "pkg.change");
        assert.equal(r.plan.riskClass, "high");
        assert.ok(r.plan.args.includes("ripgrep"));
        const extra = exec.calls.slice(before).filter((c) => c.args[0] === "install");
        assert.equal(extra.length, 0);
      });
    });
  }
});
