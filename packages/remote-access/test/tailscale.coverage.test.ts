import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLI_CANDIDATES, assertNoFunnel, detectServe, detectTailscale, parseServeStatus, planServe, planServeOff, runServePlan,
} from "../src/tailscale.ts";
import type { Command, ExecPort, ExecResult } from "../src/tailscale.ts";

// Coverage for the Tailscale glue beyond the happy paths in tailscale.test.ts: candidate order and non-ENOENT errors,
// the empty-field fallbacks of the status JSON, the serve-status parser on odd shapes, and the port/https validation.
// Nothing here runs a process: every ExecPort is a fake, and it records the calls it receives.

type Reply = ExecResult | Error;
function fakeExec(script: Record<string, Reply>): ExecPort & { calls: Array<{ key: string; timeoutMs: number | undefined }> } {
  const calls: Array<{ key: string; timeoutMs: number | undefined }> = [];
  return {
    calls,
    async run(file, args, opts) {
      const key = `${file} ${args.join(" ")}`.trim();
      calls.push({ key, timeoutMs: opts?.timeoutMs });
      const hit = script[key];
      if (hit === undefined) throw Object.assign(new Error(`spawn ${file} ENOENT`), { code: "ENOENT" });
      if (hit instanceof Error) throw hit;
      return hit;
    },
  };
}
const ok = (stdout: string, stderr = ""): ExecResult => ({ code: 0, stdout, stderr });
const VERSION = { "tailscale version": ok("1.80.0\n") };
const status = (body: unknown): Record<string, Reply> => ({ ...VERSION, "tailscale status --json": ok(typeof body === "string" ? body : JSON.stringify(body)) });

// --- CLI discovery ------------------------------------------------------------------------------------------------------

test("CLI_CANDIDATES: PATH first, then the macOS app bundle, both Homebrew prefixes, /usr/bin, and the Windows install", () => {
  assert.equal(CLI_CANDIDATES[0], "tailscale");
  for (const p of [
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    "/opt/homebrew/bin/tailscale",
    "/usr/local/bin/tailscale",
    "/usr/bin/tailscale",
    "tailscale.exe",
    "C:\\Program Files\\Tailscale\\tailscale.exe",
  ]) assert.ok(CLI_CANDIDATES.includes(p), p);
});

test("detectTailscale: the first candidate that answers wins, a Windows path is used as given, and probing stops there", async () => {
  const winPath = "C:\\Program Files\\Tailscale\\tailscale.exe";
  const exec = fakeExec({
    [`${winPath} version`]: ok("1.82.0\n"),
    [`${winPath} status --json`]: ok(JSON.stringify({ BackendState: "Stopped" })),
  });
  const s = await detectTailscale(exec, ["/missing/tailscale", "tailscale.exe", winPath]);
  assert.equal(s.cliPath, winPath);
  assert.equal(s.state, "stopped");
  assert.equal(exec.calls[0]?.key, "/missing/tailscale version");
  assert.equal(exec.calls.length, 4, "the two misses, the hit, then status");
});

test("detectTailscale: a probe that fails with a non-ENOENT error is an error for the caller, not 'not installed'", async () => {
  const eacces = Object.assign(new Error("permission denied"), { code: "EACCES" });
  await assert.rejects(detectTailscale(fakeExec({ "tailscale version": eacces })), /permission denied/);
  await assert.rejects(detectTailscale(fakeExec({ "tailscale version": new Error("no code property") })), /no code property/);
});

test("detectTailscale: every exec call carries the 8 s timeout", async () => {
  const exec = fakeExec(status({ BackendState: "Running" }));
  await detectTailscale(exec);
  assert.deepEqual(exec.calls.map((c) => c.timeoutMs), [8000, 8000]);
});

test("detectTailscale: the version is the first line only, CRLF-trimmed; an empty version is left out", async () => {
  const crlf = fakeExec({ "tailscale version": ok("1.80.0\r\ncommit: abc\r\n"), "tailscale status --json": ok("{\"BackendState\":\"Stopped\"}") });
  assert.equal((await detectTailscale(crlf)).version, "1.80.0");
  const blank = fakeExec({ "tailscale version": ok("\n1.80.0\n"), "tailscale status --json": ok("{\"BackendState\":\"Stopped\"}") });
  const s = await detectTailscale(blank);
  assert.equal(s.version, undefined, "the first line is empty, so there is no version");
  assert.equal("version" in s, false);
});

// --- status ----------------------------------------------------------------------------------------------------------------

test("detectTailscale: a failed status call reports its stderr, else stdout, else a fixed sentence", async () => {
  const mk = (r: ExecResult) => detectTailscale(fakeExec({ ...VERSION, "tailscale status --json": r }));
  assert.equal((await mk({ code: 1, stdout: "", stderr: "  daemon gone \n" })).message, "daemon gone");
  assert.equal((await mk({ code: 1, stdout: "stdout text\n", stderr: "" })).message, "stdout text");
  assert.equal((await mk({ code: 2, stdout: "", stderr: "" })).message, "tailscale status failed");
  assert.equal((await mk({ code: 2, stdout: "   ", stderr: "" })).message, "tailscale status failed");
});

test("detectTailscale: status output that is valid JSON but not an object is unparseable", async () => {
  for (const body of ["null", "[1,2]", "42", "\"text\"", "true"]) {
    const s = await detectTailscale(fakeExec(status(body)));
    assert.equal(s.state, "daemon-down", body);
    assert.equal(s.message, "unparseable status output", body);
  }
});

test("detectTailscale: backend states map to needs-login, stopped (with and without a message), and running", async () => {
  const state = async (body: unknown) => detectTailscale(fakeExec(status(body)));
  assert.equal((await state({ BackendState: "NeedsMachineAuth" })).state, "needs-login");
  const starting = await state({ BackendState: "Starting" });
  assert.equal(starting.state, "stopped");
  assert.equal(starting.message, "backend state Starting");
  const none = await state({});
  assert.equal(none.state, "stopped");
  assert.equal("message" in none, false, "no backend state at all: nothing to say");
  const numeric = await state({ BackendState: 3 });
  assert.equal(numeric.state, "stopped");
  assert.equal("message" in numeric, false, "a non-string backend state is ignored");
});

test("detectTailscale: a running node with nothing else in the status still reports running", async () => {
  const s = await detectTailscale(fakeExec(status({ BackendState: "Running" })));
  assert.deepEqual(s, { state: "running", loggedIn: true, cliPath: "tailscale", version: "1.80.0" });
});

test("detectTailscale: the MagicDNS name loses only its trailing dot; a bare dot or empty name is absent", async () => {
  const withDot = await detectTailscale(fakeExec(status({ BackendState: "Running", Self: { DNSName: "node.tail.ts.net." } })));
  assert.equal(withDot.magicDnsName, "node.tail.ts.net");
  const noDot = await detectTailscale(fakeExec(status({ BackendState: "Running", Self: { DNSName: "node.tail.ts.net" } })));
  assert.equal(noDot.magicDnsName, "node.tail.ts.net");
  const bareDot = await detectTailscale(fakeExec(status({ BackendState: "Running", Self: { DNSName: "." } })));
  assert.equal("magicDnsName" in bareDot, false);
  const empty = await detectTailscale(fakeExec(status({ BackendState: "Running", Self: { DNSName: "" } })));
  assert.equal("magicDnsName" in empty, false);
});

test("detectTailscale: the MagicDNS suffix comes from the tailnet, else the top level, and an empty tailnet value falls through", async () => {
  const tailnet = await detectTailscale(fakeExec(status({ BackendState: "Running", CurrentTailnet: { MagicDNSSuffix: "a.ts.net" }, MagicDNSSuffix: "b.ts.net" })));
  assert.equal(tailnet.magicDnsSuffix, "a.ts.net");
  const top = await detectTailscale(fakeExec(status({ BackendState: "Running", MagicDNSSuffix: "b.ts.net" })));
  assert.equal(top.magicDnsSuffix, "b.ts.net");
  const emptyTailnet = await detectTailscale(fakeExec(status({ BackendState: "Running", CurrentTailnet: { MagicDNSSuffix: "" }, MagicDNSSuffix: "c.ts.net" })));
  assert.equal(emptyTailnet.magicDnsSuffix, "c.ts.net");
  const none = await detectTailscale(fakeExec(status({ BackendState: "Running" })));
  assert.equal("magicDnsSuffix" in none, false);
});

test("detectTailscale: a tailnet that is not an object or has an empty name yields no tailnet name", async () => {
  const str = await detectTailscale(fakeExec(status({ BackendState: "Running", CurrentTailnet: "owner@example.com" })));
  assert.equal("tailnetName" in str, false);
  const empty = await detectTailscale(fakeExec(status({ BackendState: "Running", CurrentTailnet: { Name: "" } })));
  assert.equal("tailnetName" in empty, false);
  const arr = await detectTailscale(fakeExec(status({ BackendState: "Running", CurrentTailnet: ["x"] })));
  assert.equal("tailnetName" in arr, false);
});

// UNKLAR: the version probe succeeds, then `status --json` fails with ENOENT (the binary vanishes between the two calls).
// detectTailscale() currently lets that error escape. Should it report not-installed, or is throwing the intended contract?
test.skip("detectTailscale: a CLI that disappears between the probe and the status call", async () => {
  const exec = fakeExec({ "tailscale version": ok("1.80.0"), "tailscale status --json": Object.assign(new Error("ENOENT"), { code: "ENOENT" }) });
  const s = await detectTailscale(exec);
  assert.equal(s.state, "not-installed");
});

// --- serve plan ---------------------------------------------------------------------------------------------------------

test("planServe: port bounds and the https port set", () => {
  assert.equal(planServe({ cli: "tailscale", port: 1 })[0]?.args.at(-1), "http://127.0.0.1:1");
  assert.equal(planServe({ cli: "tailscale", port: 65535 })[0]?.args.at(-1), "http://127.0.0.1:65535");
  for (const port of [65536, 1.5, Number.NaN, -1]) assert.throws(() => planServe({ cli: "tailscale", port }), /port must be an integer/, String(port));
  assert.deepEqual(planServe({ cli: "tailscale", port: 18700, httpsPort: 10000 })[0]?.args, ["serve", "--bg", "--https=10000", "http://127.0.0.1:18700"]);
  assert.throws(() => planServe({ cli: "tailscale", port: 18700, httpsPort: 4443 as 443 }), /httpsPort must be 443, 8443 or 10000/);
});

test("planServeOff: default https port, the other two ports, and refusal of any other port", () => {
  assert.deepEqual(planServeOff({ cli: "tailscale" }), [{ file: "tailscale", args: ["serve", "--https=443", "off"] }]);
  assert.deepEqual(planServeOff({ cli: "tailscale", httpsPort: 8443 })[0]?.args, ["serve", "--https=8443", "off"]);
  assert.deepEqual(planServeOff({ cli: "tailscale", httpsPort: 10000 })[0]?.args, ["serve", "--https=10000", "off"]);
  assert.throws(() => planServeOff({ cli: "tailscale", httpsPort: 80 as 443 }), /httpsPort must be 443, 8443 or 10000/);
});

test("assertNoFunnel: matches in the program name too, and an empty plan passes", () => {
  assert.throws(() => assertNoFunnel([{ file: "/opt/tools/funnel-helper", args: ["status"] }]), /refusing a funnel command/);
  assert.throws(() => assertNoFunnel([{ file: "tailscale", args: ["serve", "--set-path=/funnelish"] }]), /funnel/i);
  assert.doesNotThrow(() => assertNoFunnel([]));
  assert.doesNotThrow(() => assertNoFunnel([{ file: "tailscale", args: ["serve", "status", "--json"] }]));
});

test("runServePlan: an empty plan runs nothing and returns nothing; the timeout is passed on each run", async () => {
  const none = fakeExec({});
  assert.deepEqual(await runServePlan(none, []), []);
  assert.equal(none.calls.length, 0);
  const exec = fakeExec({ "tailscale serve --https=443 off": ok("") });
  const [r] = await runServePlan(exec, planServeOff({ cli: "tailscale" }));
  assert.equal(r?.code, 0);
  assert.deepEqual(exec.calls, [{ key: "tailscale serve --https=443 off", timeoutMs: 8000 }]);
});

// --- serve status -----------------------------------------------------------------------------------------------------------

test("parseServeStatus: whitespace-only output is 'nothing served'; non-object JSON is undefined", () => {
  assert.deepEqual(parseServeStatus("  \n\t"), { funnelActive: false, proxies: [] });
  for (const text of ["[]", "42", "null", "\"x\"", "{"]) assert.equal(parseServeStatus(text), undefined, text);
});

test("parseServeStatus: only a boolean true in AllowFunnel counts as an active funnel", () => {
  assert.equal(parseServeStatus(JSON.stringify({ AllowFunnel: {} }))?.funnelActive, false);
  assert.equal(parseServeStatus(JSON.stringify({ AllowFunnel: { "a:443": "true" } }))?.funnelActive, false);
  assert.equal(parseServeStatus(JSON.stringify({ AllowFunnel: { "a:443": 1 } }))?.funnelActive, false);
  assert.equal(parseServeStatus(JSON.stringify({ AllowFunnel: "yes" }))?.funnelActive, false);
  assert.equal(parseServeStatus(JSON.stringify({ AllowFunnel: { "a:443": false, "b:8443": true } }))?.funnelActive, true);
});

test("parseServeStatus: proxies are collected from every site and handler; malformed entries are skipped", () => {
  const text = JSON.stringify({
    Web: {
      "a:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:18700" }, "/x": { Proxy: "" }, "/y": "not-an-object" } },
      "b:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:18701" }, "/z": { Proxy: 7 } } },
      "c:10000": null,
      "d:443": { Handlers: "none" },
      "e:443": {},
    },
  });
  assert.deepEqual(parseServeStatus(text), { funnelActive: false, proxies: ["http://127.0.0.1:18700", "http://127.0.0.1:18701"] });
  assert.deepEqual(parseServeStatus(JSON.stringify({ Web: ["not", "a", "map"] })), { funnelActive: false, proxies: [] });
});

test("detectServe: exit 0 with empty output is 'nothing served'; exit 0 with junk is undefined; the timeout is passed", async () => {
  const empty = fakeExec({ "tailscale serve status --json": ok("") });
  assert.deepEqual(await detectServe(empty, "tailscale"), { funnelActive: false, proxies: [] });
  assert.deepEqual(empty.calls, [{ key: "tailscale serve status --json", timeoutMs: 8000 }]);
  const junk = fakeExec({ "tailscale serve status --json": ok("not json") });
  assert.equal(await detectServe(junk, "tailscale"), undefined);
});

test("detectServe: a CLI that cannot be spawned rejects; there is no fallback search here", async () => {
  const exec = fakeExec({});
  await assert.rejects(detectServe(exec, "/opt/none/tailscale"), /ENOENT/);
});

test("runServePlan: a plan with a funnel in a later command is refused before the first command runs", async () => {
  const exec = fakeExec({});
  const plan: Command[] = [...planServe({ cli: "tailscale", port: 18700 }), { file: "tailscale", args: ["funnel", "443", "on"] }];
  await assert.rejects(runServePlan(exec, plan), /refusing a funnel command/);
  assert.equal(exec.calls.length, 0);
});
