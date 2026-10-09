import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runHostTool } from "../../src/host-tools/index.ts";
import { makeCtx, ok } from "./helpers.ts";

describe("sys.*", () => {
  it("info is read-only OS/arch/cpu/ram/uptime from the injected OS layer", async () => {
    const { ctx, exec } = makeCtx("darwin");
    const v = ok<{ os: string; version: string; arch: string; cpu: { model: string; count: number }; ramBytes: number; uptimeSeconds: number }>(
      await runHostTool("sys.info", {}, ctx),
    );
    assert.equal(v.os, "darwin");
    assert.equal(v.arch, "arm64");
    assert.equal(v.cpu.count, 1);
    assert.equal(v.ramBytes, 16 * 1024 * 1024 * 1024);
    assert.equal(v.uptimeSeconds, 12_345);
    assert.equal(exec.calls.length, 0);
  });

  it("disks parses POSIX df and Windows wmic without secrets", async () => {
    const mac = ok<{ disks: Array<{ mount: string; totalBytes: number; freeBytes: number }> }>(
      await runHostTool("sys.disks", {}, makeCtx("darwin").ctx),
    );
    assert.ok(mac.disks.some((d) => d.mount === "/" && d.totalBytes > 0 && d.freeBytes > 0));
    const win = ok<{ disks: Array<{ mount: string; totalBytes: number; freeBytes: number }> }>(
      await runHostTool("sys.disks", {}, makeCtx("win32").ctx),
    );
    assert.ok(win.disks.some((d) => d.mount.startsWith("C") && d.totalBytes > d.freeBytes));
  });

  it("network omits MAC addresses and any secret-looking data", async () => {
    const v = ok<{ interfaces: Array<Record<string, unknown>> }>(await runHostTool("sys.network", {}, makeCtx("linux").ctx));
    assert.ok(v.interfaces.some((i) => i.name === "eth0" && i.address === "10.0.0.8"));
    const dump = JSON.stringify(v);
    assert.ok(!dump.toLowerCase().includes("aa:bb:cc"));
    assert.ok(!dump.toLowerCase().includes("mac"));
  });

  it("battery reports charge when the platform has one", async () => {
    const mac = ok<{ available: boolean; percent?: number; charging?: boolean }>(await runHostTool("sys.battery", {}, makeCtx("darwin").ctx));
    assert.equal(mac.available, true);
    assert.equal(mac.percent, 80);
    assert.equal(mac.charging, false);
    const lin = ok<{ available: boolean; percent?: number }>(await runHostTool("sys.battery", {}, makeCtx("linux").ctx));
    assert.equal(lin.available, true);
    assert.equal(lin.percent, 80);
    const win = ok<{ available: boolean; percent?: number }>(await runHostTool("sys.battery", {}, makeCtx("win32").ctx));
    assert.equal(win.available, true);
    assert.equal(win.percent, 80);
  });
});
