// Uses the actual CLI supervisor and Core. No service installation, container or external model is involved.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaults } from "@plur1bus/config-schema";
import { connect, coreAddress, readRunToken, coreTokenPath, readRecordedPid, corePidPath } from "@plur1bus/module-api";
import { createApiServer } from "../src/server.ts";
import { createCoreLink } from "../src/core-link.ts";
import { MemoryUserDirectory } from "../src/memory-stores.ts";
import { hashPassword } from "../src/password.ts";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const bin = resolve(process.env.PLUR1BUS_BIN ?? join(root, "target/debug/plur1bus"));
const coreJs = join(root, "packages/core/dist/core.js");
const unavailable = !existsSync(bin) || !existsSync(coreJs);
if (unavailable && process.env.PLUR1BUS_WEB_TRANSPORT_REQUIRED === "1") throw new Error("config transport acceptance requires built CLI and Core");

test("real supervisor: five config roles, annotation audit, writer identity and invalidated privacy acknowledgment", { skip: unavailable ? "build CLI and Core; force with PLUR1BUS_WEB_TRANSPORT_REQUIRED=1" : false, timeout: 120000 }, async t => {
  const scratch = mkdtempSync(join(tmpdir(), "p1b-config-web-")), home = join(scratch, "home"); mkdirSync(home);
  const cfg = defaults(); cfg.agents.main = {};
  cfg.engine = { neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false }, merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false }, temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false }, reranker: { enabled: false } };
  writeFileSync(join(home, "config.json"), JSON.stringify(cfg));
  let daemon = false;
  t.after(() => { if (daemon) execFileSync(bin, ["--home", home, "daemon", "stop"], { timeout: 30000, stdio: "pipe" }); rmSync(scratch, { recursive: true, force: true }); });
  execFileSync(bin, ["--home", home, "daemon", "start"], { timeout: 30000, stdio: "pipe", env: { ...process.env, PLUR1BUS_NODE: process.execPath, PLUR1BUS_CORE_JS: coreJs, PLUR1BUS_ALLOW_TEST_INTERNALS: "1", PLUR1BUS_TEST_INTERNALS: "flat-embedder" } }); daemon = true;
  const local = await connect({ address: coreAddress(home), token: readRunToken(home, coreTokenPath(home)), ...(readRecordedPid(corePidPath(home)) ? { expectedServerPid: readRecordedPid(corePidPath(home))! } : {}) }); t.after(() => local.close());
  const users = new MemoryUserDirectory(), credentials: { role: string; userId: string; password: string }[] = [];
  for (const role of ["admin", "operator", "member", "viewer"] as const) {
    const invite = await local.call<any>("user.invite.create", { displayName: `Config ${role}`, role, channel: "web", origin: "http://127.0.0.1" });
    const person = await local.call<any>("user.invite.redeem", { token: invite.link.split("/").at(-1) });
    const password = randomBytes(24).toString("base64url");
    users.add({ id: person.userId, username: role, role, passwordHash: await hashPassword(password) }); credentials.push({ role, userId: person.userId, password });
  }
  const link = createCoreLink(home), ownerToken = randomBytes(32).toString("hex");
  const api = createApiServer({ core: link, ownerToken, users }); const { url } = await api.listen(); t.after(async () => { await api.close(); await link.close(); });
  const cookies = new Map<string, string>();
  for (const account of [{ role: "owner", body: { token: ownerToken } }, ...credentials.map(c => ({ role: c.role, body: { username: c.role, password: c.password } }))]) {
    const r = await fetch(url + "/api/v1/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(account.body) }); assert.equal(r.status, 200); await r.text(); cookies.set(account.role, r.headers.get("set-cookie")!.split(";")[0]!);
  }
  const responses: unknown[] = []; let id = 0;
  const write = async (role: string, changes: object[]) => {
    const cookie = cookies.get(role)!;
    const csrf = await (await fetch(url + "/api/v1/csrf", { headers: { cookie } })).json() as any;
    const r = await fetch(url + "/rpc", { method: "POST", headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf.token }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "config.set", params: { changes } }) });
    assert.equal(r.status, 200); const body = await r.json() as any; responses.push(body); return body;
  };
  for (const [i, role] of ["owner", "admin", "operator", "member", "viewer"].entries()) {
    const answer = await write(role, [{ key: "approvals", value: { ...cfg.approvals, maxGrantDays: 30 + i } }]);
    if (role === "owner" || role === "admin") assert.ok(answer.result, JSON.stringify(answer));
    else assert.equal(answer.error.data.error, "E_DENIED", role);
  }
  const rows = () => readFileSync(join(home, "logs", "audit.log"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  const adminId = credentials.find(c => c.role === "admin")!.userId;
  const grantAudit = rows().filter(row => row.action === "audit.config.set" && row.target === "approvals.maxGrantDays");
  assert.deepEqual(grantAudit.map(row => [row.detail.personId, row.detail.oldValue, row.detail.newValue]), [["local-owner", 90, 30], [adminId, 30, 31]]);
  assert.equal(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).approvals.maxGrantDays, 31);
  const marker = randomBytes(24).toString("hex");
  const ack = { provider: "off", acknowledgedAt: new Date().toISOString(), by: "browser-claim", endpoint: `https://caption.invalid/?api_key=${marker}` };
  const ackAnswer = await write("admin", [{ key: "memory.mediaEmbedding.caption.provider", value: "off" }, { key: "memory.mediaEmbedding.caption.privacyAck", value: ack }]);
  assert.ok(ackAnswer.result, JSON.stringify(ackAnswer));
  const saved = JSON.parse(readFileSync(join(home, "config.json"), "utf8")); assert.equal(saved.memory.mediaEmbedding.caption.privacyAck.by, adminId);
  const ackAudit = rows().findLast(row => row.action === "audit.config.set" && row.target === "memory.mediaEmbedding.caption.privacyAck");
  assert.equal(ackAudit.detail.newValue.endpoint, "[REDACTED]");
  assert.ok((await write("owner", [{ key: "providers.transportTest", value: { endpoint: "https://new.invalid" } }])).result);
  assert.equal(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).memory.mediaEmbedding.caption.privacyAck, undefined);
  assert.ok(rows().some(row => row.target === "memory.mediaEmbedding.caption.privacyAck" && row.detail.newValue === null));
  const observed = JSON.stringify(responses) + readFileSync(join(home, "logs", "audit.log"), "utf8") + readFileSync(join(home, "logs", "core.log"), "utf8");
  assert.ok(!observed.includes(marker), "sensitive URI content absent from responses and audit/logs");
  assert.ok(!observed.includes(ownerToken));
});
