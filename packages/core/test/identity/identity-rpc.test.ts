import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { type CoreClient, RpcCallError } from "@plur1bus/module-api";
import { connect } from "../helpers/connect.ts";
import { createLogger } from "../../src/logger.ts";
import { createPlatformCapabilities } from "../../src/platform.ts";
import { createRpcServer, type RpcServer } from "../../src/rpc/server.ts";
import { buildMethods } from "../../src/rpc/methods.ts";
import { createIdentityService, type IdentityService } from "../../src/identity/service.ts";
import { createAuditWriter } from "../../src/identity/audit.ts";
import { tempDir } from "../helpers/temp-dir.ts";

const TOKEN = "i".repeat(64);
const CALLER = { channel: "cli", accountId: "box", userId: "owner" } as const;
const TG = { channel: "telegram", accountId: "bot1", userId: "4242", displayName: "Alex" };

describe("identity RPC", () => {
  let dir: string; let server: RpcServer; let client: CoreClient; let svc: IdentityService; let now = 1_800_000_000_000;
  let logFile: string; let auditFile: string;

  before(async () => {
    dir = tempDir("p1b-identity-rpc-");
    logFile = join(dir, "core.log"); auditFile = join(dir, "logs", "audit.log");
    const log = createLogger({ file: logFile, level: "debug", role: "core" });
    const platform = createPlatformCapabilities({ platform: process.platform });
    const audit = createAuditWriter({ file: auditFile, securePath: platform.securePath, clock: () => now });
    svc = createIdentityService({ dbPath: join(dir, "state", "identity.sqlite"), clock: () => now, audit });
    const methods = buildMethods({
      engine: { contract: "1.0.0", jobs: { list: () => [] } } as any, config: () => ({}) as any, agents: { list: () => [], workspaceOf: () => null } as any,
      activity: {} as any, logger: log, status: () => ({}) as any, shutdown: () => {}, journalBacklog: () => 0, clock: () => now,
      captureSignal: new AbortController().signal, isStopping: () => false, adopt: () => ({}) as any, onMigrated: () => {}, identity: svc,
    });
    const address = process.platform === "win32" ? `\\\\.\\pipe\\plur1bus-identity-rpc-${process.pid}` : join(dir, "core.sock");
    server = createRpcServer({ address, token: TOKEN, hello: () => ({ contract: "1.0.0", rpc: "1.5.0", instanceId: "i", pid: process.pid }), methods, logger: log });
    await server.listen();
    client = await connect({ address, token: TOKEN });
  });
  after(async () => { await client?.close(); await server?.close(); svc?.close(); });

  const call = (m: string, p: object) => client.call(m, p as any) as Promise<any>;
  const denied = async (p: Promise<unknown>, error: string, reason?: string) =>
    assert.rejects(p, (e: unknown) => e instanceof RpcCallError && e.error === error && (reason === undefined || e.reason === reason), `${error} ${reason ?? ""}`);

  it("pairing end to end over the socket; list never shows the code", async () => {
    const h = await call("identity.human.create", { caller: CALLER, displayName: "Alex" });
    const s = await call("identity.pair.start", { caller: CALLER, humanId: h.id, channel: "telegram" });
    assert.match(s.code, /^[A-Z2-9]{8}$/);
    const listed = await call("identity.list", { caller: CALLER });
    assert.equal(listed.pairings.length, 1);
    assert.equal(JSON.stringify(listed).includes(s.code), false);
    const c = await call("identity.pair.claim", { caller: CALLER, code: s.code.toLowerCase().replace(/^(....)/, "$1-"), identity: TG });
    assert.equal(c.state, "awaiting-confirmation");
    const done = await call("identity.pair.confirm", { caller: CALLER, pairingId: s.pairingId, approve: true });
    assert.equal(done.state, "confirmed");
    assert.equal(done.link.proofMethod, "pairing_code");
    assert.equal((await call("identity.list", { caller: CALLER })).humans[0].identities.length, 1);
    const gone = await call("identity.unlink", { caller: CALLER, linkId: done.link.id });
    assert.equal(typeof gone.revokedAt, "number");
    assert.equal((await call("identity.list", { caller: CALLER })).humans[0].identities.length, 0);
  });

  it("errors map onto the closed codes", async () => {
    const h = await call("identity.human.create", { caller: CALLER, displayName: "B" });
    await denied(call("identity.pair.claim", { caller: CALLER, code: "NOPENOPE", identity: { ...TG, userId: "x1" } }), "E_DENIED", "invalid-code");
    await denied(call("identity.pair.start", { caller: CALLER, humanId: "nope", channel: "telegram" }), "E_NOT_FOUND");
    await call("identity.link", { caller: CALLER, humanId: h.id, identity: { ...TG, userId: "linked" } });
    await denied(call("identity.link", { caller: CALLER, humanId: h.id, identity: { ...TG, userId: "linked" } }), "E_CONFLICT");
    await denied(call("identity.human.create", { caller: CALLER, displayName: "bad\u0000name" }), "E_INVALID_PARAMS");
    await denied(call("identity.unlink", { caller: CALLER, linkId: "nope" }), "E_NOT_FOUND");
  });

  it("owner only: a caller that is not the cli owner never reaches the service (schema), and params are closed", async () => {
    await denied(call("identity.list", { caller: { channel: "telegram", accountId: "a", userId: "u" } }), "E_INVALID_PARAMS");
    await denied(call("identity.list", {}), "E_INVALID_PARAMS");
    await denied(call("identity.list", { caller: CALLER, extra: 1 }), "E_INVALID_PARAMS");
  });

  it("brute force over the socket: rate-limited with retry hint", async () => {
    for (let i = 0; i < 5; i++) await denied(call("identity.pair.claim", { caller: CALLER, code: "ZZZZZZZZ", identity: { ...TG, userId: "brute" } }), "E_DENIED", "invalid-code");
    await assert.rejects(call("identity.pair.claim", { caller: CALLER, code: "ZZZZZZZZ", identity: { ...TG, userId: "brute" } }),
      (e: unknown) => e instanceof RpcCallError && e.error === "E_DENIED" && e.reason === "rate-limited" && /retryAfterMs=\d+/.test(e.detail ?? ""));
  });

  it("codes never reach the log, the audit file or the database files", async () => {
    const h = await call("identity.human.create", { caller: CALLER, displayName: "C" });
    const s = await call("identity.pair.start", { caller: CALLER, humanId: h.id, channel: "discord" });
    await call("identity.pair.claim", { caller: CALLER, code: s.code, identity: { channel: "discord", accountId: "g", userId: "7" } });
    await call("identity.pair.claim", { caller: CALLER, code: "SECRET99", identity: { channel: "discord", accountId: "g", userId: "8" } }).catch(() => {});
    svc.close(); // flush the WAL into the main file so the scan below sees everything
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else files.push(p); } };
    walk(dir);
    for (const f of files) {
      if (f.endsWith(".sock")) continue;
      const b = readFileSync(f);
      assert.equal(b.includes(s.code), false, `${f} holds the pairing code`);
      assert.equal(b.includes("SECRET99"), false, `${f} holds a presented code`);
    }
    const audit = readFileSync(auditFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(audit.length >= 5);
    for (const l of audit) { assert.equal(typeof l.at, "number"); assert.equal(typeof l.action, "string"); assert.equal(typeof l.actor.user, "string"); }
    assert.ok(audit.some((l) => l.action === "identity.pair.start" && l.actor.user.length === 64 && l.actor.host.length === 64));
  });
});
