import { test } from "node:test";
import assert from "node:assert/strict";
import { assertNoFunnel, detectServe, detectTailscale, parseServeStatus, planServe, planServeOff, runServePlan } from "../src/tailscale.ts";
import type { ExecPort, ExecResult } from "../src/tailscale.ts";

type Script = Record<string, ExecResult | "ENOENT">;
function fakeExec(script: Script): ExecPort & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async run(file, args) {
      const key = `${file} ${args.join(" ")}`.trim();
      calls.push(key);
      const hit = script[key];
      if (hit === undefined || hit === "ENOENT") throw Object.assign(new Error(`spawn ${file} ENOENT`), { code: "ENOENT" });
      return hit;
    },
  };
}
const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: "" });
const RUNNING = JSON.stringify({
  Version: "1.80.0", BackendState: "Running", MagicDNSSuffix: "tail1234.ts.net",
  CurrentTailnet: { Name: "owner@example.com", MagicDNSSuffix: "tail1234.ts.net", MagicDNSEnabled: true },
  Self: { DNSName: "macbooker.tail1234.ts.net.", HostName: "macbooker", Online: true },
});

test("detectTailscale: not installed anywhere", async () => {
  const exec = fakeExec({});
  const s = await detectTailscale(exec);
  assert.equal(s.state, "not-installed");
  assert.equal(s.loggedIn, false);
  assert.ok(exec.calls.length > 1, "tries the known CLI locations, not only PATH");
});

test("detectTailscale: running, with tailnet and MagicDNS name (trailing dot removed), finds the CLI beyond PATH", async () => {
  const app = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
  const exec = fakeExec({
    [`${app} version`]: ok("1.80.0\n  tailscale commit: abc\n"),
    [`${app} status --json`]: ok(RUNNING),
  });
  const s = await detectTailscale(exec);
  assert.deepEqual(s, {
    state: "running", loggedIn: true, cliPath: app, version: "1.80.0",
    tailnetName: "owner@example.com", magicDnsName: "macbooker.tail1234.ts.net", magicDnsSuffix: "tail1234.ts.net",
  });
});

test("detectTailscale: needs login, stopped, daemon down, garbage output", async () => {
  const mk = (statusOut: ExecResult) => fakeExec({ "tailscale version": ok("1.80.0"), "tailscale status --json": statusOut });
  const login = await detectTailscale(mk(ok(JSON.stringify({ BackendState: "NeedsLogin", AuthURL: "https://login.tailscale.com/a/x" }))));
  assert.equal(login.state, "needs-login");
  assert.equal(login.loggedIn, false);
  assert.equal(login.magicDnsName, undefined);
  assert.equal((await detectTailscale(mk(ok(JSON.stringify({ BackendState: "Stopped" }))))).state, "stopped");
  const down = await detectTailscale(mk({ code: 1, stdout: "", stderr: "failed to connect to local Tailscale service; is Tailscale running?" }));
  assert.equal(down.state, "daemon-down");
  assert.equal(down.loggedIn, false);
  const junk = await detectTailscale(mk(ok("<html>")));
  assert.equal(junk.state, "daemon-down");
  assert.match(junk.message ?? "", /unparseable/);
});

test("planServe: tailscale serve over HTTPS to the loopback port, nothing else", () => {
  const plan = planServe({ cli: "tailscale", port: 18700 });
  assert.deepEqual(plan, [{ file: "tailscale", args: ["serve", "--bg", "--https=443", "http://127.0.0.1:18700"] }]);
  assert.deepEqual(planServe({ cli: "/x/ts", port: 18701, httpsPort: 8443 })[0]?.args, ["serve", "--bg", "--https=8443", "http://127.0.0.1:18701"]);
  assert.deepEqual(planServeOff({ cli: "tailscale" }), [{ file: "tailscale", args: ["serve", "--https=443", "off"] }]);
  assert.throws(() => planServe({ cli: "tailscale", port: 0 }), /port/);
  assert.throws(() => planServe({ cli: "tailscale", port: 18700, httpsPort: 80 as 443 }), /httpsPort/);
});

test("Funnel is blocked: assertNoFunnel and runServePlan refuse any funnel command before running anything", async () => {
  for (const args of [["funnel", "443", "on"], ["serve", "--funnel"], ["serve", "--bg", "--https=443", "--set-path=/funnel"], ["FUNNEL", "reset"]]) {
    assert.throws(() => assertNoFunnel([{ file: "tailscale", args }]), /funnel/i, args.join(" "));
  }
  assertNoFunnel(planServe({ cli: "tailscale", port: 18700 }));
  const exec = fakeExec({});
  await assert.rejects(runServePlan(exec, [{ file: "tailscale", args: ["funnel", "443", "on"] }]), /funnel/i);
  assert.equal(exec.calls.length, 0);
});

test("runServePlan: runs in order, stops at the first failing command", async () => {
  const exec = fakeExec({
    "tailscale serve --bg --https=443 http://127.0.0.1:18700": ok("Available within your tailnet:\n"),
    "tailscale serve --https=443 off": { code: 1, stdout: "", stderr: "denied" },
  });
  const good = await runServePlan(exec, planServe({ cli: "tailscale", port: 18700 }));
  assert.deepEqual(good.map((r) => r.code), [0]);
  const bad = await runServePlan(exec, [...planServeOff({ cli: "tailscale" }), ...planServe({ cli: "tailscale", port: 18700 })]);
  assert.deepEqual(bad.map((r) => r.code), [1]);
  assert.equal(exec.calls.length, 2);
});

test("parseServeStatus / detectServe: recognise an active Funnel and the proxy targets", async () => {
  const quiet = JSON.stringify({
    TCP: { "443": { HTTPS: true } },
    Web: { "macbooker.tail1234.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:18700" } } } },
  });
  assert.deepEqual(parseServeStatus(quiet), { funnelActive: false, proxies: ["http://127.0.0.1:18700"] });
  const loud = JSON.stringify({
    TCP: { "443": { HTTPS: true } },
    Web: { "macbooker.tail1234.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:18700" } } } },
    AllowFunnel: { "macbooker.tail1234.ts.net:443": true },
  });
  assert.deepEqual(parseServeStatus(loud), { funnelActive: true, proxies: ["http://127.0.0.1:18700"] });
  assert.deepEqual(parseServeStatus(JSON.stringify({ AllowFunnel: { "a:443": false } })), { funnelActive: false, proxies: [] });
  assert.deepEqual(parseServeStatus(""), { funnelActive: false, proxies: [] });
  assert.equal(parseServeStatus("not json"), undefined);
  const exec = fakeExec({ "tailscale serve status --json": ok(loud) });
  assert.deepEqual(await detectServe(exec, "tailscale"), { funnelActive: true, proxies: ["http://127.0.0.1:18700"] });
  const failing = fakeExec({ "tailscale serve status --json": { code: 1, stdout: "", stderr: "boom" } });
  assert.equal(await detectServe(failing, "tailscale"), undefined);
});
