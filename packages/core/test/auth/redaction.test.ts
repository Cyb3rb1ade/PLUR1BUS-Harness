import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { createCredentialsProvider } from "../../src/auth/credentials.ts";
import { RefreshRejected, type Refresher } from "../../src/auth/refresh.ts";
import { InMemorySecretStore, encodeRecord } from "../../src/auth/secret-store.ts";
import { validateProfile } from "../../src/auth/profile.ts";
import { scrub, safeFields } from "../../src/auth/redact.ts";
import { FakeClock, MARK } from "./helpers.ts";

const oauth = validateProfile({ id: "e:oauth", display_name: "Example", kind: "oauth_pkce", capabilities: ["chat"], auth_header_scheme: "Authorization: Bearer {token}", authorization_endpoint: "https://e.test/a", token_endpoint: "https://e.test/t", refresh: { mode: "rotating" }, policy_status: "allowed", policy_source: "https://e.test", policy_checked: "2026-09-22" });
const MARKERS = [MARK.access, MARK.refresh, MARK.key, "CANARY-NEW", "CANARY-NEW-R"];

describe("no token value in logs or errors (marker test)", () => {
  it("across success, refresh, rejection, hostile refresher messages and pool failures", async () => {
    const clock = new FakeClock(), store = new InMemorySecretStore(); const logs: string[] = []; const errors: unknown[] = []; const leases: unknown[] = [];
    await store.set("o/1", encodeRecord({ v: 1, accessToken: MARK.access, refreshToken: MARK.refresh, expiresAt: clock.now() + 1000, generation: 0 }));
    await store.set("o/2", "{not json " + MARK.key);
    let mode: "ok" | "hostile" | "dead" = "ok";
    const refresher: Refresher = { async refresh({ refreshToken }) {
      if (mode === "hostile") throw new Error(`upstream said: bad token ${refreshToken} ${MARK.access}`);
      if (mode === "dead") throw new RefreshRejected("invalid_grant");
      return { accessToken: "CANARY-NEW", refreshToken: "CANARY-NEW-R", expiresInSeconds: 3600 };
    } };
    const log = (e: string, f: Record<string, unknown>) => logs.push(JSON.stringify({ e, f }));
    const mkp = (entries: Array<{ id: string; secretRef: string }>) => createCredentialsProvider({ profiles: [{ profile: oauth, entries }], store, clock, refresher, log });
    const attempt = async (p: ReturnType<typeof mkp>, result?: any) => {
      try { const l = await p.getAuthorization({ profileId: "e:oauth" }); leases.push(l); if (result) await p.reportResult(l, result); }
      catch (e) { errors.push(e); }
    };
    const p = mkp([{ id: "a", secretRef: "o/1" }]);
    mode = "hostile"; await attempt(p);                // transient, hostile message
    mode = "ok"; await attempt(p, { ok: false, status: 429 }); await attempt(p, { ok: false, status: 401 });
    clock.advance(10_000_000); mode = "dead"; await attempt(mkp([{ id: "a", secretRef: "o/1" }]));
    await attempt(mkp([{ id: "x", secretRef: "o/2" }])); // corrupt record containing a marker
    await attempt(mkp([{ id: "y", secretRef: "o/missing" }]));
    assert.ok(errors.length >= 3, "the scenarios produced errors");
    const blob = [
      ...logs,
      ...errors.map((e: any) => JSON.stringify(e) + String(e.message) + String(e.stack) + inspect(e, { depth: 5 })),
      ...leases.map((l) => JSON.stringify(l) + String(l) + inspect(l, { depth: 5 }) + JSON.stringify({ l })),
    ].join("\n");
    for (const m of MARKERS) assert.ok(!blob.includes(m), `leaked ${m}`);
    assert.ok(logs.length > 0);
  });

  it("scrub and safeFields remove known secrets and bearer-shaped text", () => {
    assert.equal(scrub(`oops ${MARK.key} here`, [MARK.key]), "oops [redacted] here");
    assert.ok(!scrub("Authorization: Bearer abcdef1234567890").includes("abcdef1234567890"));
    assert.deepEqual(safeFields({ a: `x ${MARK.key}`, n: 3, u: undefined }, [MARK.key]), { a: "x [redacted]", n: 3 });
  });
});
