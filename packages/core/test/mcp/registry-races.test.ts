// Audit b03: a late close notification of a replaced connection must not unhook its successor.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { McpRegistry } from "../../src/mcp/registry.ts";
import { FakeClock } from "./helpers/fake-clock.ts";
import { caller, capturingLogger, NODE, pidAlive, stdioDef, waitDead } from "./helpers/util.ts";

const until = async (fn: () => boolean, ms = 8000) => { const end = Date.now() + ms; while (!fn() && Date.now() < end) await new Promise((r) => setTimeout(r, 10)); return fn(); };

describe("mcp registry: replaced connection", { timeout: 120_000 }, () => {
  it("the slow teardown of a timed-out connection does not orphan the connection started meanwhile", async () => {
    const clock = new FakeClock();
    const reg = new McpRegistry({ clock, logger: capturingLogger(), hostEnv: {}, policy: { allowedCommands: [NODE] } });
    // The wedged fixture needs SIGKILL, so the teardown of the first connection takes about two grace periods.
    const d = stdioDef({}, { FIXTURE_WEDGE: "1" });
    reg.register({ name: d.name, transport: d.transport, timeouts: { ...d.timeouts, callMs: 5_000, closeGraceMs: 1_500 } });
    let second: number | null = null;
    try {
      await reg.listTools("fixture", caller);
      const first = reg.status("fixture", caller.agentId).pid!;
      const hung = reg.callTool("fixture", "hang", {}, caller).catch((e) => e);
      assert.ok(await until(() => reg.status("fixture", caller.agentId).inFlight === 1));
      await new Promise((r) => setTimeout(r, 150));
      await clock.advance(5_000); // deadline fires; the first connection starts its slow hard close
      await new Promise((r) => setTimeout(r, 100));
      const fresh = await reg.callTool("fixture", "pid", {}, caller); // a new connection starts while the old one is still dying
      second = Number((fresh.content[0] as { text: string }).text);
      assert.notEqual(second, first);
      // The process the registry tracks: the server itself on POSIX; on Windows the job launcher that started it, whose pid
      // the transport reports (docs/mcp-client.md), so the server's parent there.
      const owner = process.platform === "win32" ? Number(((await reg.callTool("fixture", "ppid", {}, caller)).content[0] as { text: string }).text) : second;
      assert.equal(((await hung) as { code: string }).code, "call-timeout");
      assert.ok(await waitDead(first));
      const s = reg.status("fixture", caller.agentId);
      assert.equal(s.state, "running", "the registry must still own the second connection");
      assert.equal(s.pid, owner);
      await reg.shutdown();
      assert.ok(await waitDead(second), "shutdown must reap the second connection's process");
    } finally {
      await reg.shutdown();
      if (second !== null && pidAlive(second)) { try { process.kill(-second, "SIGKILL"); } catch { /* gone */ } }
    }
  });
});
