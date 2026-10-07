import { createServer } from "node:http";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { createEgress } from "../../src/egress/service.ts";
import { validateProfile } from "../../src/auth/profile.ts";
import { MARK } from "./helpers.ts";

/** Only a random-port IPv4 loopback server; no DNS or external network in this fixture. */
export async function mockOAuth() {
  const requests: Array<{ path: string; form: URLSearchParams }> = [];
  const codes = new Map<string, { challenge: string; redirect: string }>();
  const refreshes = new Set<string>([MARK.refresh]);
  const polls: string[] = [];
  let failure: { status: number; error: string } | undefined;
  let n = 0; let staticRefresh = false;
  let assertionCheck: ((assertion: string) => void) | undefined;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const form = new URLSearchParams(Buffer.concat(chunks).toString());
    requests.push({ path: url.pathname, form });
    const reply = (body: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (failure) return reply({ error: failure.error, error_description: Object.values(MARK).join(" ") }, failure.status);
    if (url.pathname === "/authorize") {
      assert.equal(url.searchParams.get("code_challenge_method"), "S256");
      const code = `CANARY-CODE-${++n}`;
      codes.set(code, { challenge: url.searchParams.get("code_challenge")!, redirect: url.searchParams.get("redirect_uri")! });
      const callback = new URL(url.searchParams.get("redirect_uri")!);
      callback.searchParams.set("code", code); callback.searchParams.set("state", url.searchParams.get("state")!);
      res.writeHead(302, { location: callback.href }); res.end(); return;
    }
    if (url.pathname === "/device") return reply({ device_code: "CANARY-DEVICE", user_code: "CANARY-USER", verification_uri: `${base}/verify`, expires_in: 120, interval: 1 });
    if (url.pathname !== "/token") return reply({}, 404);
    const grant = form.get("grant_type");
    if (grant === "authorization_code") {
      const saved = codes.get(form.get("code")!); codes.delete(form.get("code")!);
      if (!saved || saved.redirect !== form.get("redirect_uri") || saved.challenge !== createHash("sha256").update(form.get("code_verifier")!).digest("base64url")) return reply({ error: "invalid_grant" }, 400);
    } else if (grant === "refresh_token") {
      const old = form.get("refresh_token")!;
      if (!(staticRefresh ? refreshes.has(old) : refreshes.delete(old))) return reply({ error: "invalid_grant" }, 400);
    } else if (grant === "urn:ietf:params:oauth:grant-type:device_code") {
      assert.equal(form.get("device_code"), "CANARY-DEVICE");
      const error = polls.shift(); if (error) return reply({ error, error_description: MARK.access }, 400);
    } else if (grant === "urn:ietf:params:oauth:grant-type:jwt-bearer") {
      assertionCheck?.(form.get("assertion")!);
    }
    const refresh = `${MARK.refresh}-${++n}`; refreshes.add(refresh);
    return reply({ access_token: `${MARK.access}-${n}`, ...(staticRefresh ? {} : { refresh_token: refresh }), token_type: "Bearer", expires_in: 3600 });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const egress = createEgress({ config: () => ({ allowHosts: ["127.0.0.1"], allowPorts: [port], allowLoopback: true }) });
  return {
    base, requests, polls, egress,
    staticRefresh() { staticRefresh = true; },
    fail(f?: { status: number; error: string }) { failure = f; },
    checkAssertion(f: (assertion: string) => void) { assertionCheck = f; },
    profile(over: Record<string, unknown> = {}) { return validateProfile({ id: "test:oauth", display_name: "Test", kind: "oauth_pkce", capabilities: ["chat"], auth_header_scheme: "Authorization: Bearer {token}", authorizeUrl: `${base}/authorize`, tokenUrl: `${base}/token`, client_id: "test-harness-client", pkce: "S256", scopes: ["test.read"], redirect: { type: "loopback" }, refresh: { mode: "rotating" }, secret_ref: "auth/test", policy_status: "allowed", policy_source: "https://example.test/policy", policy_checked: "2026-10-07", ...over }); },
    async callback(authorizeUrl: string) { const res = await fetch(authorizeUrl, { redirect: "manual" }); return res.headers.get("location")!; },
    async close() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); },
  };
}
