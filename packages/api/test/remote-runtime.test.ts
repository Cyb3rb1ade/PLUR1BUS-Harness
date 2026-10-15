import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as reservePort } from "node:net";
import { request as httpsRequest } from "node:https";
import { randomBytes } from "node:crypto";
import { certPin, pinsEqual, type ExecPort, type RemoteConfig } from "../../remote-access/src/index.ts";
import { startRemoteRuntime, loadRemoteStartup } from "../src/remote-runtime.ts";
import { createApiServer } from "../src/server.ts";
import { fakeCore } from "./helpers.ts";
import type { TLSSocket } from "node:tls";
const wide = { auth: { capacity: 1000, refillPerSec: 1000 }, read: { capacity: 1000, refillPerSec: 1000 }, write: { capacity: 1000, refillPerSec: 1000 } };
const home = (t: TestContext) => { const dir = mkdtempSync(join(tmpdir(), "remote-runtime-")); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const config = (publish: RemoteConfig["publish"], allowSubnets: string[] = []): RemoteConfig => ({ publish, tls: "self-signed", bind: {}, allowSubnets });
const ack = { by: "local-owner", at: Date.now(), version: 1 };
function execFixture(state = "Running", options: { missing?: boolean; funnel?: boolean; conflict?: boolean; serveFailure?: boolean } = {}) {
  const calls: { file: string; args: readonly string[] }[] = [];
  const exec: ExecPort = { async run(file, args) {
    calls.push({ file, args }); if (options.missing) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    if (args[0] === "version") return { code: 0, stdout: "test-version", stderr: "" };
    if (args[0] === "status") return { code: 0, stdout: JSON.stringify({ BackendState: state, Self: { DNSName: "machine.example.ts.net." } }), stderr: "" };
    if (args[0] === "serve" && args[1] === "status") return { code: 0, stdout: JSON.stringify({ ...(options.funnel ? { AllowFunnel: { "machine.example.ts.net:443": true } } : {}), ...(options.conflict ? { Web: { "machine.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } } } : {}) }), stderr: "" };
    return { code: options.serveFailure && args.includes("--bg") ? 1 : 0, stdout: "", stderr: "" };
  } }; return { calls, exec };
}
const edge = () => Promise.resolve({ fingerprint: "sha256:" + randomBytes(32).toString("base64url"), notAfter: Date.now() + 86400000 });
async function unusedPort(): Promise<number> { const server = reservePort(); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const port = (server.address() as { port: number }).port; await new Promise<void>(resolve => server.close(() => resolve())); return port; }
function pinnedGet(port: number, pin: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest({ hostname: "127.0.0.1", port, servername: "localhost", rejectUnauthorized: false, agent: false, path: "/api/v1/health", headers: { host: `localhost:${port}` } }, res => { res.resume(); resolve(res.statusCode!); });
    req.once("socket", socket => (socket as TLSSocket).once("secureConnect", () => { if (!pinsEqual(certPin((socket as TLSSocket).getPeerCertificate().raw), pin)) req.destroy(new Error("certificate pin mismatch")); })); req.once("error", reject); req.end();
  });
}
test("local mode opens no extra listener; missing or signed-out Tailscale records clear Doctor failure", async t => {
  for (const [mode, fixture] of [["local", execFixture()], ["tailnet", execFixture("Running", { missing: true })], ["tailnet", execFixture("NeedsLogin")]] as const) {
    const dir = home(t); let creates = 0;
    const runtime = await startRemoteRuntime({ home: dir, config: config(mode), localPort: 3001, exec: fixture.exec, createApi: () => { creates++; throw new Error("unexpected remote listener"); } });
    assert.equal(creates, 0); assert.equal(runtime.state.phase, mode === "local" ? "inactive" : "failed");
    const stored = JSON.parse(readFileSync(join(dir, "state", "remote-status.json"), "utf8")); if (mode === "tailnet") { assert.equal(stored.doctor[0].severity, "warn"); assert.match(stored.doctor[0].message, /Tailscale/); }
  }
});
test("tailnet uses only a dedicated loopback backend, fixed serve argv and verified edge fingerprint", async t => {
  const dir = home(t), fixture = execFixture(); let bound: unknown;
  const runtime = await startRemoteRuntime({ home: dir, config: config("tailnet"), localPort: 3001, exec: fixture.exec, probeEdge: edge, createApi: bind => { bound = bind; return createApiServer({ ...bind, core: fakeCore(), ownerToken: randomBytes(32).toString("hex"), rateClasses: wide }); } });
  try {
  assert.equal(runtime.state.phase, "active"); assert.match(runtime.state.fingerprint!, /^sha256:/); assert.equal((bound as { host: string }).host, "127.0.0.1");
  const serve = fixture.calls.find(c => c.args.includes("--bg")); assert.ok(serve); assert.match(serve.args.at(-1)!, /^http:\/\/127\.0\.0\.1:\d+$/); assert.equal(fixture.calls.some(c => c.args.some(a => /funnel/i.test(a))), false);
  } finally { await runtime.close(); }
});
test("tailnet refuses subnet allowlist, public publication, foreign Serve rule and failed edge verification", async t => {
  for (const variant of ["allowlist", "public", "conflict", "probe"] as const) {
    const dir = home(t), fixture = execFixture("Running", { funnel: variant === "public", conflict: variant === "conflict" }); let creates = 0;
    const runtime = await startRemoteRuntime({ home: dir, config: config("tailnet", variant === "allowlist" ? ["100.64.0.0/10"] : []), localPort: 3001, exec: fixture.exec, probeEdge: async () => { throw new Error("unverified"); }, createApi: bind => { creates++; return createApiServer({ ...bind, core: fakeCore(), ownerToken: randomBytes(32).toString("hex") }); } });
    assert.equal(runtime.state.phase, "failed"); assert.equal(runtime.api, undefined); assert.equal(creates, variant === "probe" ? 1 : 0); if (variant === "probe") assert.ok(fixture.calls.some(c => c.args.includes("off")));
  }
});
test("real network TLS enforces certificate pin, socket allowlist and live staged rotation", async t => {
  const dir = home(t), port = await unusedPort();
  const runtime = await startRemoteRuntime({ home: dir, config: config("network", ["127.0.0.1/32"]), publicOrigin: `https://localhost:${port}`, noticeAck: ack, localPort: 3001, hostInterfaces: [{ name: "fixture", address: "192.168.1.20" }], createApi: bind => createApiServer({ ...bind, core: fakeCore(), ownerToken: randomBytes(32).toString("hex"), rateClasses: wide }) });
  try {
  assert.equal(runtime.state.phase, "active"); const first = runtime.state.fingerprint!; assert.equal(await pinnedGet(port, first), 401); await assert.rejects(pinnedGet(port, "sha256:" + randomBytes(32).toString("base64url")), /pin mismatch/);
  const next = await runtime.certificates!.stageSelfSigned(); assert.equal(runtime.state.fingerprint, first); await runtime.activateStaged(); assert.equal(await pinnedGet(port, next.certPin), 401); await assert.rejects(pinnedGet(port, first), /pin mismatch/);
  } finally { await runtime.close(); }
  const denied = await startRemoteRuntime({ home: home(t), config: config("network", ["10.0.0.0/8"]), publicOrigin: `https://localhost:${port}`, noticeAck: ack, localPort: 3001, hostInterfaces: [{ name: "fixture", address: "192.168.1.20" }], createApi: bind => createApiServer({ ...bind, core: fakeCore(), ownerToken: randomBytes(32).toString("hex") }) });
  try { assert.equal(denied.state.phase, "active"); await assert.rejects(pinnedGet(port, denied.state.fingerprint!)); } finally { await denied.close(); }
});
test("network without current notice or valid TLS never invokes bind; invalid config cannot broaden exposure", async t => {
  for (const variant of ["notice", "http", "company", "public"] as const) {
    let creates = 0; const c = config("network"); const runtime = await startRemoteRuntime({ home: home(t), config: variant === "company" ? { ...c, tls: "company-ca" } : c, publicOrigin: variant === "http" ? "http://localhost:9443" : "https://localhost:9443", ...(variant === "notice" ? {} : { noticeAck: ack }), localPort: 3001, hostInterfaces: [{ name: "fixture", address: variant === "public" ? "203.0.113.1" : "192.168.1.20" }], createApi: () => { creates++; throw new Error("unexpected listener"); } }); assert.equal(creates, 0); assert.equal(runtime.state.phase, "failed");
  }
  await assert.rejects(startRemoteRuntime({ home: home(t), config: { ...config("network"), publish: "funnel" } as unknown as RemoteConfig, localPort: 3001, createApi: () => { throw new Error("unexpected listener"); } }), /invalid remote exposure/);
});
test("startup config uses tailnet and remote MFA defaults; rejects unknown exposure keys", t => {
  const dir = home(t); assert.equal(loadRemoteStartup(dir).config.publish, "tailnet"); assert.equal(loadRemoteStartup(dir).requireSecondFactor, "remote");
  writeFileSync(join(dir, "config.json"), JSON.stringify({ remote: { publish: "local" }, auth: { requireSecondFactor: "always" } })); assert.equal(loadRemoteStartup(dir).requireSecondFactor, "always");
  writeFileSync(join(dir, "config.json"), JSON.stringify({ remote: { publish: "network", funnel: true } })); assert.throws(() => loadRemoteStartup(dir), /invalid remote exposure/);
});
