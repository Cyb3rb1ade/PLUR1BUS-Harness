import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:https";
import type { TLSSocket } from "node:tls";
import { bootstrapHash } from "../src/bootstrap.ts";
import { AccountStore } from "../src/account-store.ts";
import { createApiServer } from "../src/server.ts";
import { RemoteCertificates } from "../src/remote-certificates.ts";
import { SessionStore } from "../src/session.ts";
import { LoginChallenges } from "../src/challenge.ts";
import { systemClock } from "../src/clock.ts";
import type { PendingWebAuthn } from "../src/webauthn-routes.ts";
import { registerCredential } from "../src/webauthn.ts";
import { certPin } from "../../remote-access/src/index.ts";
import { fakeCore } from "./helpers.ts";
import { vector } from "./webauthn-vectors.ts";

test("real HTTPS Owner passkey meets remote MFA; shared challenges refuse realm substitution and token bypass", async () => {
  const home = mkdtempSync(join(tmpdir(), "webauthn-remote-")), ownerToken = randomBytes(32).toString("hex");
  const store = new AccountStore({ path: ":memory:", resolve: async userId => ({ userId, kind: "person", role: "owner", disabled: false, version: 1 }) });
  const material = await new RemoteCertificates({ home, names: { hostnames: ["localhost"] } }).ensureSelfSigned();
  store.initializeBootstrap(bootstrapHash(randomBytes(32).toString("base64url")));
  await store.bootstrapOwner("christian", "unused");
  const origin = "https://localhost:9443", v = vector(-7, origin);
  store.putPasskey("local-owner", { ...registerCredential(v.registration, v.context), name: "Remote fixture" });
  const common = { core: fakeCore(), accounts: store, users: store, ownerToken, sharedSessions: new SessionStore(systemClock), sharedLoginChallenges: new LoginChallenges(systemClock), sharedWebauthnChallenges: new Map<string, PendingWebAuthn>() };
  const local = createApiServer({ ...common, webauthnOrigin: "https://local.example" });
  const remote = createApiServer({ ...common, host: "127.0.0.1", tls: { key: material.key, cert: material.cert }, remote: { publish: "network", publicOrigin: origin, noticeAck: { by: "local-owner", at: Date.now(), version: 1 } } });
  try {
    const localAddress = await local.listen(), remoteAddress = await remote.listen();
    const call = (path: string, body?: object, cookie?: string) => new Promise<{ status: number; body: any; cookie: string }>((resolve, reject) => {
      const encoded = body ? JSON.stringify(body) : undefined;
      const req = request({ host: "127.0.0.1", port: remoteAddress.port, servername: "localhost", rejectUnauthorized: false, agent: false, path: "/api/v1" + path, method: body ? "POST" : "GET", headers: { host: "localhost:9443", ...(cookie ? { cookie } : {}), ...(encoded ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(encoded)) } : {}) } }, res => {
        const chunks: Buffer[] = []; res.on("data", c => chunks.push(c)); res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()), cookie: (res.headers["set-cookie"]?.[0] ?? "").split(";")[0]! }));
      });
      req.on("socket", socket => (socket as TLSSocket).once("secureConnect", () => { if (certPin((socket as TLSSocket).getPeerCertificate().raw) !== material.certPin) req.destroy(new Error("pin mismatch")); }));
      req.on("error", reject); if (encoded) req.write(encoded); req.end();
    });
    assert.equal((await call("/session", { token: ownerToken })).status, 401, "consumed bootstrap token cannot authenticate remotely");
    const localOptions = await (await fetch(localAddress.url + "/api/v1/session/passkey/options", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "christian" }) })).json() as { challenge: string };
    v.context.challenge = localOptions.challenge;
    assert.equal((await call("/session/passkey", { ...v.assertion(), challenge: localOptions.challenge })).status, 401, "local challenge cannot mint a remote MFA session");
    const issued = await call("/session/passkey/options", { username: "christian" });
    assert.equal(issued.body.rpId, "localhost"); v.context.challenge = issued.body.challenge;
    const signed = { ...v.assertion(), challenge: issued.body.challenge }, login = await call("/session/passkey", signed);
    assert.equal(login.status, 200); assert.match(login.cookie, /^__Host-plur1bus_session=/);
    assert.equal((await call("/health", undefined, login.cookie)).status, 200, "verified UV passkey satisfies per-request remote Owner factor gate");
    assert.equal((await call("/session/passkey", signed)).status, 401, "remote assertion is one-use");
  } finally { await remote.close(); await local.close(); store.close(); rmSync(home, { recursive: true, force: true }); }
});
