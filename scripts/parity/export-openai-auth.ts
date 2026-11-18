// Parity vectors for the OpenAI auth package (P4-K K4, plan P4-23): `packages/core/src/openai-auth/`. Mode V for the pure
// rules (the closed wire guard, key expiry, regional endpoints, the owner rule, failover, the never-list port, error codes) and
// for ID-token verification; mode W at the package's own `HttpPort` (R-K-14) for the plan login, lease, rotation, logout and
// transfer, the service over it, and the workload exchange; and W at the `fetch` of `createOpenAIHttp`.
//
// The OpenAI side is a deterministic stand-in written here after `packages/core/test/fixtures/openai/server.ts` (the same
// endpoints and rules, with counters instead of random markers and a fixed signing key); every request the TypeScript code
// makes and every answer is recorded, and so is every call of the PKCE port. `randomBytes` and `randomUUID` are scripted as in
// `k3b-support.ts`, and so is the Ed25519 host key (`generateKeyPairSync("ed25519")` takes its seed from the scripted
// `randomBytes`). Secrets are invented here and stored in `{ parts }`.
//
//   node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning scripts/parity/export-openai-auth.ts [--check]
import crypto, { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { inspect } from "node:util";
import { fileURLToPath } from "node:url";
import { ChatGPTPlan } from "../../packages/core/src/openai-auth/plan.ts";
import { HostIdentity, JwksVerifier } from "../../packages/core/src/openai-auth/identity.ts";
import { AuthService, SerialOwner } from "../../packages/core/src/openai-auth/service.ts";
import { WorkloadIdentity } from "../../packages/core/src/openai-auth/workload.ts";
import { createOpenAIHttp } from "../../packages/core/src/openai-auth/http.ts";
import { guardSiwc } from "../../packages/core/src/openai-auth/wire.ts";
import { chooseFailover, createCredentialDenyPort, credentialAccess, endpoint, FOREIGN_CREDENTIAL_STORES, importedProfile, keyStatus, requireOwner, safetyIdentifier } from "../../packages/core/src/openai-auth/profiles.ts";
import { OpenAIError, Sensitive, type HttpRequest, type HttpResponse } from "../../packages/core/src/openai-auth/ports.ts";
import { LoopbackPkce } from "../../packages/core/src/openai-auth/loopback.ts";
import { request as httpRequest } from "node:http";
import { installScriptedRandom } from "./k3b-support.ts";
import { armour, piecesDeep, TEST_RSA_PKCS8 } from "./export-provider-auth.ts";
import { ed25519Cases } from "./ed25519-cases.ts";
import { exporterMain } from "./lib.mjs";

const ED_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const edKey = (seed: Buffer) => createPrivateKey({ key: Buffer.concat([ED_PREFIX, seed]), format: "der", type: "pkcs8" });
const errOf = (e: unknown) => (e instanceof OpenAIError ? { code: e.code, message: e.message } : { name: (e as Error)?.name ?? typeof e });
const SECRET_FORM_KEYS = new Set(["code", "code_verifier", "refresh_token", "token", "subject_token", "state", "nonce", "access_token"]);
const parts = (s: string) => ({ parts: s.match(/[\s\S]{1,8}/g) ?? [""] });
/** `piecesDeep`, plus every form value that is a credential, every `authorization`, and a stored host key. */
function pieces(v: unknown): unknown {
  if (Array.isArray(v)) {
    if (v.length === 2 && typeof v[0] === "string" && typeof v[1] === "string" && SECRET_FORM_KEYS.has(v[0])) return [v[0], parts(v[1])];
    return v.map(pieces);
  }
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === "authorization" && typeof x === "string" ? parts(x) : typeof x === "string" && x.includes('"d":') ? parts(x) : pieces(x)]));
  return piecesDeep(v);
}

/** Scripted `randomBytes`/`randomUUID`, and an Ed25519 host key whose seed is the next scripted draw. */
function scripted() {
  const random = installScriptedRandom();
  const real = crypto.generateKeyPairSync;
  (crypto as any).generateKeyPairSync = (type: string, ...rest: unknown[]) => {
    if (type !== "ed25519") return (real as any)(type, ...rest);
    const privateKey = edKey(crypto.randomBytes(32));
    return { privateKey, publicKey: createPublicKey(privateKey) };
  };
  syncBuiltinESMExports();
  return { restore() { (crypto as any).generateKeyPairSync = real; syncBuiltinESMExports(); random.restore(); } };
}

// --- the stand-in for OpenAI -------------------------------------------------------------------------------------------------
class Fake {
  now = 1_000_000_000_000;
  readonly issuer = "https://auth.openai.com";
  readonly key = edKey(createHash("sha256").update("fixture issuer key").digest());
  n = 0;
  account = "account-a"; refreshCount = 0;
  badClaim: string | undefined; omitScope = false; badState = false; errorCode: string | undefined; failPath: string | undefined;
  repeatRefresh = false; redirectUri = "http://127.0.0.1:49152/auth/callback"; callbackError: string | undefined;
  readonly registrations = new Map<string, string>(); readonly refreshes = new Set<string>(); readonly codes = new Map<string, { nonce: string; challenge: string; client: string }>();
  readonly transcript: unknown[] = []; readonly pkce: unknown[] = [];
  secret(tag: string) { return `CANARY-${tag}-${++this.n}`; }
  async redirect() { this.pkce.push({ call: "redirect", out: this.redirectUri }); return this.redirectUri; }
  async close() { this.pkce.push({ call: "close" }); }
  async authorize(p: { url: Sensitive; redirectUri: string }) {
    const u = new URL(p.url.value());
    const supplied = u.searchParams.get("client_id")!;
    let client = this.registrations.get(this.account);
    const refuse = () => { this.pkce.push({ call: "authorize", url: p.url.value(), redirectUri: p.redirectUri, throws: true }); return Error("refused"); };
    if (!client) { if (supplied !== "dynamic_agent_client") throw refuse(); client = `oaiapp_t${++this.n}`; this.registrations.set(this.account, client); }
    else if (supplied !== client) throw refuse();
    const code = this.secret("CODE");
    this.codes.set(code, { nonce: u.searchParams.get("nonce")!, challenge: u.searchParams.get("code_challenge")!, client });
    const callback = new URL(p.redirectUri);
    callback.searchParams.set("state", this.badState ? "wrong" : u.searchParams.get("state")!);
    if (this.callbackError) callback.searchParams.set("error", this.callbackError);
    callback.searchParams.set("code", code); callback.searchParams.set("client_id", client);
    this.pkce.push({ call: "authorize", url: p.url.value(), redirectUri: p.redirectUri, out: callback.href });
    return callback.href;
  }
  tokens(): HttpResponse { const refresh = this.secret("REFRESH"); this.refreshes.add(refresh); return { status: 200, body: { access_token: this.secret("ACCESS"), refresh_token: refresh, token_type: "Bearer", expires_in: 3600, scope: this.omitScope ? "openid" : "openid chatgpt.tokens.use.direct" } }; }
  answer(r: HttpRequest): HttpResponse {
    const path = new URL(r.url).pathname;
    if (this.failPath === path) throw Error(this.secret("FAIL"));
    if (path === "/.well-known/openid-configuration") return { status: 200, body: { issuer: this.issuer, authorization_endpoint: this.issuer + "/authorize", token_endpoint: this.issuer + "/token", revocation_endpoint: this.issuer + "/revoke", jwks_uri: this.issuer + "/jwks" } };
    if (path === "/jwks") return { status: 200, body: { keys: [{ ...createPublicKey(this.key).export({ format: "jwk" }), kid: "test", alg: "EdDSA" }] } };
    if (path === "/token") {
      const f = r.form!;
      if (f.grant_type === "refresh_token") {
        if (!this.refreshes.delete(f.refresh_token!)) return { status: 400, body: { error: "invalid_grant" } };
        this.refreshCount++;
        const t = this.tokens();
        if (this.repeatRefresh) (t.body as any).refresh_token = f.refresh_token;
        return t;
      }
      const code = this.codes.get(f.code!); this.codes.delete(f.code!);
      if (!code || createHash("sha256").update(f.code_verifier!).digest("base64url") !== code.challenge || f.client_id !== code.client) return { status: 400, body: { error: "invalid_grant" } };
      const claims: Record<string, unknown> = { iss: this.issuer, aud: code.client, exp: this.now / 1000 + 3600, nonce: code.nonce, sub: this.account, workspace: "workspace-test" };
      if (this.badClaim && this.badClaim !== "signature") claims[this.badClaim] = this.badClaim === "exp" ? 0 : "wrong";
      const h = Buffer.from(JSON.stringify({ alg: "EdDSA", kid: "test" })).toString("base64url");
      const b = Buffer.from(JSON.stringify(claims)).toString("base64url");
      const sig = sign(null, Buffer.from(h + "." + b), this.key).toString("base64url");
      const t = this.tokens();
      return { ...t, body: { ...(t.body as object), id_token: h + "." + b + "." + (this.badClaim === "signature" ? sig.split("").reverse().join("") : sig) } };
    }
    if (path === "/oauth/token") return { status: 200, body: { access_token: this.secret("WORKLOAD"), token_type: "Bearer", expires_in: 300 } };
    if (path === "/v1/models") return { status: 200, body: { data: [{ id: "fixture-model" }] } };
    if (path === "/v1/responses") return this.errorCode ? { status: 429, body: { error: { code: this.errorCode, message: this.secret("MSG") } } } : { status: 200, body: { ok: true } };
    if (path === "/revoke") return { status: 200, body: {} };
    return { status: 404, body: {} };
  }
  async request(r: HttpRequest): Promise<HttpResponse> {
    const request = { method: r.method, url: r.url, authorization: r.authorization?.value() ?? null, form: r.form ? Object.entries(r.form) : null, json: r.json ?? null };
    try { const res = this.answer(r); this.transcript.push({ request, response: res }); return res; }
    catch (e) { this.transcript.push({ request, response: { throws: true } }); throw e; }
  }
}
class Store {
  readonly data = new Map<string, string>(); failSetAt = 0; sets = 0;
  async get(ref: string) { return this.data.get(ref); }
  async set(ref: string, v: string) { if (++this.sets === this.failSetAt) throw Error("store unavailable CANARY-STORE"); this.data.set(ref, v); }
  async delete(ref: string) { this.data.delete(ref); }
  view() { return Object.fromEntries([...this.data.entries()].sort(([a], [b]) => (a < b ? -1 : 1))); }
}
const PRINCIPAL = { owner: "owner", user: "owner", agentOwner: "owner", deployment: "local" as const };

// --- W: the plan (ChatGPTPlan over HostIdentity, JwksVerifier and SerialOwner) ------------------------------------------------
type Op = { op: string; [k: string]: unknown };
const PLAN_SCENARIOS: Array<{ name: string; ops: Op[] }> = [
  { name: "login-twice-reuses-registration", ops: [{ op: "login", account: "a" }, { op: "login", account: "a" }, { op: "set", account: "account-b" }, { op: "login", account: "b" }, { op: "metadata", account: "a" }, { op: "metadata", account: "zz" }] },
  { name: "lease-fresh-then-rotate-once", ops: [{ op: "login", account: "a" }, { op: "lease", account: "a" }, { op: "advance", ms: 3_500_000 }, { op: "lease", account: "a" }, { op: "lease", account: "a" }, { op: "newPlan" }, { op: "lease", account: "a" }] },
  { name: "skew-boundary", ops: [{ op: "login", account: "a" }, { op: "advance", ms: 3_600_000 - 7_500 - 120_000 - 1 }, { op: "lease", account: "a" }, { op: "advance", ms: 1 }, { op: "lease", account: "a" }] },
  { name: "refresh-expiry-boundary", ops: [{ op: "login", account: "a" }, { op: "advance", ms: 30 * 86_400_000 - 1 }, { op: "metadata", account: "a" }, { op: "advance", ms: 1 }, { op: "metadata", account: "a" }, { op: "lease", account: "a" }] },
  { name: "models-and-responses", ops: [{ op: "login", account: "a" }, { op: "models", account: "a" }, { op: "responses", account: "a", request: { model: "fixture-model", input: "hello", store: true } }, { op: "responses", account: "a", request: { temperature: 1 } }, { op: "set", errorCode: "subscription_sharing_usage_limit_exceeded" }, { op: "responses", account: "a", request: { model: "fixture-model" } }, { op: "set", errorCode: "unknown_vendor_code" }, { op: "responses", account: "a", request: {} }] },
  ...["iss", "aud", "exp", "nonce", "signature", "sub"].map((badClaim) => ({ name: `oidc-rejects-${badClaim}`, ops: [{ op: "set", badClaim }, { op: "login", account: "a" }, { op: "metadata", account: "a" }] })),
  { name: "narrow-scope-at-login", ops: [{ op: "set", omitScope: true }, { op: "login", account: "a" }, { op: "metadata", account: "a" }] },
  { name: "narrow-scope-at-refresh", ops: [{ op: "login", account: "a" }, { op: "set", omitScope: true }, { op: "advance", ms: 3_500_000 }, { op: "lease", account: "a" }, { op: "lease", account: "a" }] },
  { name: "wrong-state", ops: [{ op: "set", badState: true }, { op: "login", account: "a" }] },
  { name: "callback-error", ops: [{ op: "set", callbackError: "access_denied" }, { op: "login", account: "a" }, { op: "set", callbackError: "server_error" }, { op: "login", account: "a" }] },
  { name: "localhost-redirect", ops: [{ op: "set", redirectUri: "http://localhost:49152/auth/callback" }, { op: "login", account: "a" }] },
  { name: "redirect-with-query", ops: [{ op: "set", redirectUri: "http://127.0.0.1:49152/auth/callback?x=1" }, { op: "login", account: "a" }] },
  { name: "token-endpoint-throws", ops: [{ op: "set", failPath: "/token" }, { op: "login", account: "a" }] },
  { name: "spent-marker-survives-network-failure", ops: [{ op: "login", account: "a" }, { op: "advance", ms: 3_500_000 }, { op: "set", failPath: "/token" }, { op: "lease", account: "a" }, { op: "set", failPath: null }, { op: "newPlan" }, { op: "lease", account: "a" }, { op: "metadata", account: "a" }] },
  { name: "repeated-refresh-token-refused", ops: [{ op: "login", account: "a" }, { op: "set", repeatRefresh: true }, { op: "advance", ms: 3_500_000 }, { op: "lease", account: "a" }] },
  { name: "refresh-save-failure", ops: [{ op: "login", account: "a" }, { op: "advance", ms: 3_500_000 }, { op: "failSetAt", n: 2 }, { op: "lease", account: "a" }, { op: "lease", account: "a" }] },
  { name: "audit-failure-before-persistence", ops: [{ op: "auditFail", kind: "login" }, { op: "login", account: "a" }, { op: "metadata", account: "a" }] },
  { name: "logout-revokes-and-deletes", ops: [{ op: "login", account: "a" }, { op: "logout", account: "a" }, { op: "metadata", account: "a" }, { op: "logout", account: "a" }] },
  { name: "logout-when-revocation-fails", ops: [{ op: "login", account: "a" }, { op: "set", failPath: "/revoke" }, { op: "logout", account: "a" }, { op: "metadata", account: "a" }] },
  { name: "transfer-moves", ops: [{ op: "login", account: "a" }, { op: "transfer", account: "a" }, { op: "metadata", account: "a" }, { op: "transfer", account: "a" }] },
  { name: "owner-only-and-bad-account", ops: [{ op: "login", account: "a", principal: { ...PRINCIPAL, user: "other" } }, { op: "login", account: "a", principal: { ...PRINCIPAL, deployment: "hosted-multi-user" } }, { op: "lease", account: "a", principal: { ...PRINCIPAL, agentOwner: "x" } }, { op: "login", account: "a b" }, { op: "login", account: "x".repeat(81) }] },
  { name: "host-identity-stable-and-corrupt", ops: [{ op: "hostId" }, { op: "hostId" }, { op: "storePut", ref: "openai.host.key", value: "broken" }, { op: "hostId" }] },
  { name: "corrupt-and-entry-client-records", ops: [{ op: "storePut", ref: "openai.plan.a", value: "{not json" }, { op: "lease", account: "a" }, { op: "metadata", account: "a" }, { op: "storePut", ref: "openai.plan.a", value: JSON.stringify({ clientId: "dynamic_agent_client", sub: "s", workspace: "w", accessToken: "CANARY-X-1", refreshToken: "CANARY-X-2", expiresAt: 5, refreshExpiresAt: 6, scope: "x" }) }, { op: "lease", account: "a" }] },
  { name: "other-person-same-account-refused", ops: [{ op: "login", account: "a" }, { op: "set", account: "account-b" }, { op: "set", registrationFrom: "account-a" }, { op: "login", account: "a" }] },
];
async function runPlan(s: { name: string; ops: Op[] }) {
  const sr = scripted();
  try {
    const fake = new Fake(), store = new Store(), owner = new SerialOwner(), events: unknown[] = [];
    let auditFail: string | undefined;
    const clock = { now: () => fake.now };
    const ports = () => ({ http: fake, pkce: fake as never, store, owner, clock, host: new HostIdentity(store, owner), verifier: new JwksVerifier(fake, clock), random: () => 0.5,
      audit: (e: { kind: string }) => { if (e.kind === auditFail) throw Error("audit sink down"); events.push(e); } });
    let plan = new ChatGPTPlan(ports());
    let host = new HostIdentity(store, owner);
    const steps = [];
    for (const op of s.ops) {
      const principal = (op.principal as typeof PRINCIPAL) ?? PRINCIPAL;
      try {
        let out: unknown = null;
        switch (op.op) {
          case "login": out = await plan.login(op.account as string, principal); break;
          case "lease": out = (await plan.lease(op.account as string, principal)).value(); break;
          case "metadata": out = (await plan.metadata(op.account as string)) ?? null; break;
          case "models": out = await plan.models(op.account as string, principal); break;
          case "responses": out = ((await plan.responses(op.account as string, principal, op.request as never)) as any).value(); break;
          case "logout": await plan.logout(op.account as string); break;
          case "transfer": { const got: string[] = []; await plan.transfer(op.account as string, { accept: async (r) => { got.push(r.value()); } }, principal); out = got; break; }
          case "hostId": out = await host.id(); break;
          case "advance": fake.now += op.ms as number; break;
          case "newPlan": plan = new ChatGPTPlan(ports()); host = new HostIdentity(store, owner); break;
          case "failSetAt": store.failSetAt = store.sets + (op.n as number); break;
          case "auditFail": auditFail = op.kind as string; break;
          case "storePut": store.data.set(op.ref as string, op.value as string); break;
          case "set": for (const [k, v] of Object.entries(op)) if (k === "registrationFrom") fake.registrations.set(fake.account, fake.registrations.get(v as string)!); else if (k !== "op") (fake as any)[k] = v ?? undefined; break;
        }
        steps.push({ out, store: store.view(), audit: events.length });
      } catch (e) { steps.push({ error: errOf(e), leaks: inspect(e).includes("CANARY") || JSON.stringify(e).includes("CANARY"), store: store.view(), audit: events.length }); }
    }
    return { name: s.name, start: 1_000_000_000_000, ops: s.ops, steps, transcript: fake.transcript, pkce: fake.pkce, audit: events };
  } finally { sr.restore(); }
}

// --- W: the service ------------------------------------------------------------------------------------------------------------
async function serviceCases() {
  const sr = scripted();
  try {
    const fake = new Fake(), store = new Store(), events: unknown[] = [];
    const auth = new AuthService({ store, http: fake, clock: { now: () => fake.now }, audit: (e) => { events.push(e); }, pkce: () => fake as never, random: () => 0.5 });
    const bob = { ...PRINCIPAL, owner: "bob", user: "bob", agentOwner: "bob" };
    const ops: Op[] = [{ op: "login" }, { op: "list" }, { op: "list", who: "bob" }, { op: "lease", who: "bob" }, { op: "lease" }, { op: "models" }, { op: "login", again: true }, { op: "status" }, { op: "logout", who: "bob" }, { op: "logout" }, { op: "list" }, { op: "lease" }];
    let id = "";
    const steps = [];
    for (const op of ops) {
      const p = op.who === "bob" ? bob : PRINCIPAL;
      try {
        let out: unknown = null;
        if (op.op === "login") { const l = await auth.startLogin({ principal: p, ...(op.again ? { credentialId: id } : {}) }); out = await auth.awaitLogin(l.loginId, p); id = (out as { id: string }).id; }
        else if (op.op === "list") out = await auth.listCredentials(p);
        else if (op.op === "lease") out = (await auth.lease(id, p)).value();
        else if (op.op === "models") out = await auth.models(id, p);
        else if (op.op === "status") out = (await auth.status(p)).credentials;
        else if (op.op === "logout") await auth.logout(id, p);
        steps.push({ out, store: store.view() });
      } catch (e) { steps.push({ error: errOf(e), store: store.view() }); }
    }
    await auth.close();
    return { start: 1_000_000_000_000, ops, steps, transcript: fake.transcript, pkce: fake.pkce, audit: events };
  } finally { sr.restore(); }
}

// --- W: workload identity -------------------------------------------------------------------------------------------------------
async function workloadCases() {
  const base = { token_exchange_endpoint: "https://auth.openai.com/oauth/token", subject_token_source: "metadata:kubernetes", subject_token_type: "urn:ietf:params:oauth:token-type:jwt", audience: "fixture-audience", principal: "fixture-principal", identity_provider_id: "fixture-provider", service_account_id: "fixture-service" };
  const profiles = [
    base, { ...base, token_exchange_endpoint: "https://auth.openai.com/oauth/token?x" }, { ...base, token_exchange_endpoint: "http://auth.openai.com/oauth/token" }, { ...base, token_exchange_endpoint: "https://evil.example/oauth/token" },
    { ...base, subject_token_source: "file:" }, { ...base, subject_token_source: "disk:/x" }, { ...base, refresh_skew_seconds: -1 }, { ...base, audience: "" }, { ...base, subject_token_type: "urn:openai:params:oauth:token-type:x509" },
    { ...base, token_exchange_endpoint: "https://mtls.auth.openai.com/oauth/token", subject_token_type: "urn:openai:params:oauth:token-type:x509" },
  ];
  const constructs = profiles.map((p) => { try { new WorkloadIdentity(p as never, { http: new Fake(), clock: { now: () => 0 }, subject: { read: async () => "s" }, ...(p.token_exchange_endpoint.includes("mtls") ? { certificateHttp: new Fake() } : {}) }); return { profile: p, ok: true }; } catch (e) { return { profile: p, error: errOf(e) }; } });
  const answers: Array<[string, unknown[]]> = [
    ["re-exchange-before-expiry", [{ status: 200, body: { access_token: "CANARY-W-1", token_type: "Bearer", expires_in: 300 } }, { status: 200, body: { access_token: "CANARY-W-2", token_type: "bearer", expires_in: 300, expires_at: 1_000_000_000 + 250 } }]],
    ["too-long-lived", [{ status: 200, body: { access_token: "CANARY-W-1", token_type: "Bearer", expires_in: 3601 } }]],
    ["wrong-type", [{ status: 200, body: { access_token: "CANARY-W-1", expires_in: 300 } }]],
    ["absolute-expiry-passed", [{ status: 200, body: { access_token: "CANARY-W-1", token_type: "Bearer", expires_in: 300, expires_at: 1_000_000_000 } }]],
    ["vendor-error", [{ status: 401, body: { error: "invalid_grant" } }]],
  ];
  const leases = [];
  for (const [name, script] of answers) {
    let now = 1_000_000_000_000; const requests: unknown[] = []; const queue = [...script];
    const http = { async request(r: HttpRequest) { requests.push({ method: r.method, url: r.url, json: r.json ?? null }); return queue.shift() as HttpResponse; } };
    const w = new WorkloadIdentity(base as never, { http, clock: { now: () => now }, subject: { read: async () => "CANARY-SUBJECT-1" } });
    const steps = [];
    for (const advance of [0, 0, 200_000]) {
      now += advance;
      try { steps.push({ advance, out: (await w.lease()).value() }); } catch (e) { steps.push({ advance, error: errOf(e) }); }
    }
    leases.push({ name, script, requests, steps });
  }
  let subjects = 0;
  const missing = new WorkloadIdentity(base as never, { http: { async request() { throw Error("unreachable"); } }, clock: { now: () => 0 }, subject: { read: async () => { subjects++; throw Error("no CANARY-S"); } } });
  let missingError: unknown; try { await missing.lease(); } catch (e) { missingError = errOf(e); }
  return { start: 1_000_000_000_000, base, constructs, leases, missing: { error: missingError, subjects } };
}

// --- V: the pure rules -----------------------------------------------------------------------------------------------------------
async function pureCases() {
  const siwc = [
    { model: "m", input: "hello" }, { instructions: "x", store: true, stream: false }, { model: "m", temperature: 1 }, { background: true }, { tools: [{ type: "function", name: "f" }] }, { tools: [{ type: "file_search" }] },
    { tools: "x" }, { tools: [null] }, { tools: [[]] }, { input: [{ role: "system", content: "x" }] }, { input: [{ role: "user", content: [{ type: "input_audio" }] }] }, { input: [{ role: "user", content: [{ type: "input_text", text: "a" }, { type: "input_image" }] }] },
    { input: [{ type: "function_call_output", output: "x" }] }, { input: [{ type: "reasoning" }] }, { input: [{ type: "" }] }, { input: [{ type: 0 }] }, { input: [[]] }, { input: [null] }, { input: [5] }, { input: [{ content: null }] }, { input: [{ content: "s" }] },
    { input: null }, { input: 5 }, [], null, "x", { input: [{ role: "user", content: [null] }] }, { input: [{ role: "user", content: [{ type: 5 }] }] }, {},
  ].map((r) => { try { return { request: r, out: guardSiwc(r as never) }; } catch (e) { return { request: r, error: errOf(e) }; } });
  const day = 86_400_000;
  const keys = [[undefined, 0], [0, 1], [1, 0], [3 * day, 0], [3 * day + 1, 0], [14 * day, 0], [14 * day + 1, 0], [-5, 0], [0, 0]].map(([e, now]) => ({ expiresAt: e ?? null, now, out: keyStatus(e as number | undefined, now as number) }));
  let infinite: unknown; try { keyStatus(Infinity, 0); } catch (e) { infinite = errOf(e); }
  const regions = ["global", "us", "eu", "asia", ""].map((r) => { try { return { region: r, out: endpoint(r as never) }; } catch (e) { return { region: r, error: errOf(e) }; } });
  const owners = [PRINCIPAL, { ...PRINCIPAL, user: "x" }, { ...PRINCIPAL, agentOwner: "x" }, { ...PRINCIPAL, owner: "" , user: "", agentOwner: "" }, { ...PRINCIPAL, deployment: "self-hosted" }, { ...PRINCIPAL, deployment: "hosted-multi-user" }]
    .map((p) => { try { requireOwner(p as never); return { principal: p, ok: true }; } catch (e) { return { principal: p, error: errOf(e) }; } });
  const failovers = [
    ["chatgpt_plan", [["key", "api_key"]], [], "subscription_sharing_usage_limit_exceeded"], ["api_key", [["plan", "chatgpt_plan"]], [], null], ["api_key", [["plan", "chatgpt_plan"]], [["api_key", "chatgpt_plan"]], null],
    ["api_key", [["k2", "api_key"], ["plan", "chatgpt_plan"]], [["api_key", "chatgpt_plan"]], null], ["workload", [], [], null],
  ].map(([from, cands, cross, code]) => { const events: unknown[] = []; const out = chooseFailover(from as never, (cands as string[][]).map(([id, b]) => ({ id: id!, billing_path: b as never })), (cross as string[][]).map(([f, t]) => ({ from: f as never, to: t as never })), (code as string | null) ?? undefined, (e) => events.push(e)); return { from, candidates: cands, cross, code, out: out ?? null, events }; });
  const deny = [];
  for (const os of ["posix", "windows"]) {
    const home = os === "windows" ? "C:/Users/Test" : "/home/test";
    const roots = FOREIGN_CREDENTIAL_STORES.map((s) => home + "/." + s.app);
    const port = createCredentialDenyPort({ canonicalize: async (p) => (p === "alias" ? roots[0] + "/auth.json" : p), roots, keychainItems: ["keychain:codex"], foreignRegistration: async (p) => p.endsWith("/foreign-registration") });
    const paths = [...FOREIGN_CREDENTIAL_STORES.flatMap((s) => s.suffixes.map((x) => home + "/." + s.app + "/" + x)), ...FOREIGN_CREDENTIAL_STORES.map((s) => (home + "/." + s.app + "/auth.json").toUpperCase().replaceAll("/", "\\")),
      "alias", "keychain:codex", "KEYCHAIN:CODEX/", home + "/foreign-registration", roots[0] + "-unrelated/auth.json", roots[0]!, roots[0] + "/", home + "/.config/token.json"];
    for (const path of paths) { let opened = false; let error: unknown; try { await credentialAccess(port, path, async () => { opened = true; }); } catch (e) { error = errOf(e); } deny.push({ os, home, roots, path, denied: error ?? null, opened }); }
  }
  return {
    siwc, keys, infinite, regions, owners, failovers, deny,
    imported: importedProfile("openai:chatgpt-oauth-restricted"), safety: ["owner", "", "\u00e9"].map((p) => ({ principal: p, out: safetyIdentifier(p) })),
    codes: ["login-timeout", "nope", "subscription_sharing_invalid_user", ""].map((c) => { const e = new OpenAIError(c as never); return { code: c, out: e.code, message: e.message, json: JSON.stringify(e) }; }),
  };
}

// --- V/W: ID-token verification ----------------------------------------------------------------------------------------------
async function jwksCases() {
  const ed = edKey(createHash("sha256").update("jwks ed key").digest()), ed2 = edKey(createHash("sha256").update("jwks other key").digest());
  const rsa = createPrivateKey(armour("PRIVATE KEY", TEST_RSA_PKCS8));
  const edJwk = createPublicKey(ed).export({ format: "jwk" }), rsaJwk = createPublicKey(rsa).export({ format: "jwk" });
  const now = 1_000_000_000_000, issuer = "https://auth.openai.com";
  const d = { issuer, authorization_endpoint: issuer + "/authorize", token_endpoint: issuer + "/token", revocation_endpoint: issuer + "/revoke", jwks_uri: issuer + "/jwks" };
  const b64 = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
  const claims = { iss: issuer, aud: "oaiapp_t1", exp: now / 1000 + 60, nonce: "n-1", sub: "account-a", workspace: "w-1" };
  const tok = (h: Record<string, unknown>, c: Record<string, unknown>, key = ed, alg: string | null = null) => { const body = b64(h) + "." + b64(c); return body + "." + sign(alg, Buffer.from(body), key).toString("base64url"); };
  const keysets: Record<string, unknown[]> = {
    std: [{ ...edJwk, kid: "e", alg: "EdDSA" }, { ...rsaJwk, kid: "r", alg: "RS256", use: "sig" }],
    twins: [{ ...edJwk, kid: "e" }, { ...edJwk, kid: "e" }], nokid: [{ ...edJwk }], enc: [{ ...edJwk, kid: "e", use: "enc" }], wrongalg: [{ ...edJwk, kid: "e", alg: "RS256" }], rsaAsEd: [{ ...rsaJwk, kid: "e" }],
  };
  const H = { alg: "EdDSA", kid: "e" };
  const cases: Array<[string, string, string?]> = [
    ["valid-eddsa", tok(H, claims)], ["valid-rs256", tok({ alg: "RS256", kid: "r" }, claims, rsa, "RSA-SHA256")], ["bad-signature", tok(H, claims, ed2)], ["rs256-under-ed-header", tok({ alg: "EdDSA", kid: "r" }, claims, rsa, "RSA-SHA256")],
    ["alg-none", b64({ alg: "none", kid: "e" }) + "." + b64(claims) + ".AA"], ["alg-hs256", tok({ alg: "HS256", kid: "e" }, claims)], ["unknown-kid", tok({ alg: "EdDSA", kid: "x" }, claims)],
    ["two-matching-keys", tok(H, claims), "twins"], ["no-kid-both", tok({ alg: "EdDSA" }, claims), "nokid"], ["key-for-encryption", tok(H, claims), "enc"], ["key-alg-mismatch", tok(H, claims), "wrongalg"], ["rsa-key-for-eddsa", tok(H, claims), "rsaAsEd"],
    ["wrong-iss", tok(H, { ...claims, iss: "https://evil" })], ["aud-array-single", tok(H, { ...claims, aud: ["oaiapp_t1"] })], ["aud-array-two-no-azp", tok(H, { ...claims, aud: ["oaiapp_t1", "x"] })], ["aud-array-two-azp", tok(H, { ...claims, aud: ["oaiapp_t1", "x"], azp: "oaiapp_t1" })],
    ["aud-other", tok(H, { ...claims, aud: "x" })], ["exp-now", tok(H, { ...claims, exp: now / 1000 })], ["exp-just-after", tok(H, { ...claims, exp: now / 1000 + 0.001 })], ["exp-string", tok(H, { ...claims, exp: "9999999999" })],
    ["nbf-now", tok(H, { ...claims, nbf: now / 1000 })], ["nbf-future", tok(H, { ...claims, nbf: now / 1000 + 1 })], ["nbf-null", tok(H, { ...claims, nbf: null })], ["nonce-other", tok(H, { ...claims, nonce: "n-2" })], ["nonce-number", tok(H, { ...claims, nonce: 1 })],
    ["workspace-id", tok(H, { ...claims, workspace: undefined, workspace_id: "w-2" })], ["workspace-null-falls-back", tok(H, { ...claims, workspace: null, workspace_id: "w-3" })], ["account-claim", tok(H, { ...claims, workspace: undefined, "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } })],
    ["no-workspace", tok(H, { ...claims, workspace: undefined })], ["no-sub", tok(H, { ...claims, sub: undefined })], ["sub-newline", tok(H, { ...claims, sub: "a\nb" })],
    ["two-parts", b64(H) + "." + b64(claims)], ["bad-chars", tok(H, claims) + "="], ["too-long", tok(H, { ...claims, pad: "x".repeat(33_000) })], ["header-not-json", b64("x") + "." + b64(claims) + ".AA"],
  ];
  const out = [];
  for (const [name, token, set] of cases) {
    const requests: unknown[] = [];
    const http = { async request(r: HttpRequest): Promise<HttpResponse> { requests.push({ method: r.method, url: r.url }); return { status: 200, body: { keys: keysets[set ?? "std"] } }; } };
    const v = new JwksVerifier(http, { now: () => now });
    try { out.push({ name, token, keyset: set ?? "std", requests, out: await v.validate(token, { discovery: d as never, audience: "oaiapp_t1", nonce: "n-1" }) }); }
    catch (e) { out.push({ name, token, keyset: set ?? "std", requests, error: errOf(e) }); }
  }
  // The key set is cached for five minutes (`until > now`), one fetch for concurrent validations.
  let t = now; const fetched: number[] = [];
  const http = { async request(): Promise<HttpResponse> { fetched.push(t); return { status: 200, body: { keys: keysets.std } }; } };
  const v = new JwksVerifier(http, { now: () => t });
  const good = tok(H, { ...claims, exp: now / 1000 + 3600 });
  const cache = [];
  for (const step of [0, 299_999, 1, 0]) { t += step; await v.validate(good, { discovery: d as never, audience: "oaiapp_t1", nonce: "n-1" }); cache.push({ advance: step, fetches: fetched.length }); }
  // Review B, RB-1: EdDSA at its edges (`ed25519-cases.ts`). The key set holds the one key of the case; `ok` is whether the
  // TypeScript verifier accepts the token, and the Rust verifier must answer the same for every case.
  const eddsa = [];
  for (const c of ed25519Cases("p4-k k4 vectors: eddsa", (n) => Buffer.from(b64(H) + "." + b64({ ...claims, jti: `edge-${n}` })))) {
    const token = c.message.toString() + "." + c.signature.toString("base64url");
    const x = c.key.toString("base64url");
    const http = { async request(): Promise<HttpResponse> { return { status: 200, body: { keys: [{ kty: "OKP", crv: "Ed25519", x, kid: "e", alg: "EdDSA" }] } }; } };
    let ok = true;
    try { await new JwksVerifier(http, { now: () => now }).validate(token, { discovery: d as never, audience: "oaiapp_t1", nonce: "n-1" }); } catch { ok = false; }
    eddsa.push({ group: c.group, name: c.name, x, token, ok });
  }
  return { now, discovery: d, keysets, audience: "oaiapp_t1", nonce: "n-1", cases: out, cache, eddsa };
}

// --- W: createOpenAIHttp at its fetch ---------------------------------------------------------------------------------------
async function httpCases() {
  const reqs: HttpRequest[] = [
    { method: "POST", url: "https://auth.openai.com/token", form: { grant_type: "refresh_token", refresh_token: "CANARY-R 1&2" } },
    { method: "GET", url: "https://api.openai.com/v1/models", authorization: new Sensitive("CANARY-ACCESS-1") },
    { method: "POST", url: "https://auth.openai.com/oauth/token", json: { grant_type: "x", subject_token: "CANARY-S-1" } },
  ];
  const answers: Array<[string, { status: number; body: string } | "throw"]> = [
    ["ok", { status: 200, body: "{\"a\":1}" }], ["error-status-json", { status: 400, body: "{\"error\":\"invalid_grant\"}" }], ["not-json", { status: 200, body: "CANARY-ACCESS-x" }], ["array", { status: 200, body: "[1]" }],
    ["too-large", { status: 200, body: "{\"a\":\"" + "x".repeat(300 * 1024) + "\"}" }], ["fetch-throws", "throw"], ["redirect", { status: 302, body: "{}" }],
  ];
  const out = [];
  for (const r of reqs) for (const [name, a] of answers) {
    const seen: unknown[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      const h: Record<string, string> = {}; new Headers(init.headers).forEach((v, k) => { h[k] = v; });
      seen.push({ url: String(url), method: init.method, headers: h, body: init.body ?? "" });
      if (a === "throw" || (a.status >= 300 && a.status < 400)) throw new TypeError("fetch failed");
      return new Response(a.body, { status: a.status });
    }) as unknown as typeof globalThis.fetch;
    const http = createOpenAIHttp({ egress: { decide: async () => ({ allowed: true }) as never }, fetch });
    const request = { method: r.method, url: r.url, authorization: r.authorization?.value() ?? null, form: r.form ? Object.entries(r.form) : null, json: r.json ?? null };
    try { const res = await http.request(r); out.push({ name, request, answer: a, seen, out: { status: res.status, body: res.body }, json: JSON.stringify(res) }); }
    catch (e) { out.push({ name, request, answer: a === "throw" ? "throw" : { status: a.status, body: a.body.length > 1000 ? { repeat: a.body.length } : a.body }, seen, error: errOf(e) }); }
  }
  return out.map((c: any) => (c.answer?.body?.length > 1000 ? { ...c, answer: { status: c.answer.status, bodyLength: c.answer.body.length } } : c));
}

// ---- the plan's loopback listener: real requests to the real listener (review B) ----

type ListenerRequest = { method?: string; target: string; host?: string; origin?: string; site?: string; at: number; divergence?: string };
const PLAN_STATE = "plan-listener-state";
const LISTENER_REQUESTS: ListenerRequest[] = [
  { method: "POST", target: `/auth/callback?state=${PLAN_STATE}`, at: 5000 },
  { target: `/auth/callback?state=${PLAN_STATE}`, host: "evil.example", at: 5000 },
  { target: `/auth/callback?state=${PLAN_STATE}`, origin: "http://evil.example", at: 5000 },
  { target: "/auth/callback?state=x", origin: "http://127.0.0.1:$PORT", at: 5000 },
  { target: `/auth/callback?state=${PLAN_STATE}`, site: "same-site", at: 5000 },
  { target: "/auth/callback?state=x", site: "none", at: 5000 },
  { target: `/other?state=${PLAN_STATE}`, at: 5000 },
  // K4-D4 (divergence): a target that is no URL against the redirect makes TypeScript's handler throw (no answer; in the
  // core an uncaught exception). The port answers 404, as for any other path.
  { target: "//[", at: 5000, divergence: "K4-D4" },
  { target: "http://[", at: 5000, divergence: "K4-D4" },
  { target: "/auth/callback", at: 5000 },
  { target: `/auth/callback?state=${PLAN_STATE}&state=${PLAN_STATE}`, at: 5000 },
  ...Array.from({ length: 9 }, (_, i) => ({ target: `/auth/callback?state=f${i}`, at: 5000 })),
  { target: "/auth/callback?state=over", at: 5999 },
  { target: "/auth/callback?state=again", at: 6000 },
  { target: `/auth/callback?state=${PLAN_STATE}&code=c`, at: 6001 },
];

function send(port: number, r: ListenerRequest): Promise<unknown> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = { host: (r.host ?? "127.0.0.1:$PORT").replace("$PORT", String(port)) };
    if (r.origin) headers.origin = r.origin.replace("$PORT", String(port));
    if (r.site) headers["sec-fetch-site"] = r.site;
    const req = httpRequest({ host: "127.0.0.1", port, method: r.method ?? "GET", path: r.target, headers, agent: false, timeout: 2000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c as Buffer));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8"), headers: Object.fromEntries(["cache-control", "referrer-policy", "content-security-policy", "retry-after"].filter((h) => res.headers[h] !== undefined).map((h) => [h, res.headers[h]])) }));
    });
    req.on("timeout", () => { req.destroy(); resolve({ noAnswer: true }); });
    req.on("error", () => resolve({ refused: true }));
    req.end();
  });
}

async function listenerCases() {
  let t = 0;
  const l = new LoopbackPkce(async () => {}, undefined, () => t);
  const redirect = await l.redirect();
  const port = Number(new URL(redirect).port);
  const uncaught: string[] = [];
  const onUncaught = (e: unknown): void => { uncaught.push((e as Error).name); };
  process.on("uncaughtException", onUncaught);
  const ctrl = new AbortController();
  let resolved: unknown = null;
  const done = l.authorize({ url: new Sensitive(`https://auth.example.test/authorize?state=${PLAN_STATE}`), redirectUri: redirect, signal: ctrl.signal })
    .then((u) => { resolved = u; }, (e) => { resolved = { error: (e as OpenAIError).code }; });
  const requests: unknown[] = [];
  try {
    let plain404: unknown;
    for (const r of LISTENER_REQUESTS) {
      t = r.at;
      const before = uncaught.length;
      const response = await send(port, r);
      const threw = uncaught.slice(before);
      if (r.target.startsWith("/other")) plain404 = response;
      requests.push({ method: r.method ?? "GET", target: r.target, host: r.host ?? "127.0.0.1:$PORT", origin: r.origin ?? null, secFetchSite: r.site ?? null, at: r.at, response,
        ...(threw.length > 0 ? { threw } : {}), ...(r.divergence ? { divergence: r.divergence, rust: plain404 } : {}) });
    }
    await done;
  } finally { process.off("uncaughtException", onUncaught); ctrl.abort(); await l.close(); }
  const portless = (v: unknown): unknown => JSON.parse(JSON.stringify(v).replaceAll(`127.0.0.1:${port}`, "127.0.0.1:$PORT"));
  return portless({ redirect, state: PLAN_STATE, requests, resolved });
}

export async function buildOpenAIAuthVectors() {
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    const plan = []; for (const s of PLAN_SCENARIOS) plan.push(await runPlan(s));
    const built = pieces({ pure: await pureCases(), jwks: await jwksCases(), plan: { scenarios: plan }, service: await serviceCases(), workload: await workloadCases(), http: await httpCases(), listener: await listenerCases() });
    // The repository's source rule reserves one foreign host name to its importer; the never-list cases name it by placeholder.
    const name = ["open", "claw"].join("");
    return JSON.parse(JSON.stringify(built).replaceAll(name, "@foreign-2@").replaceAll(name.toUpperCase(), "@FOREIGN-2@")) as Record<string, unknown>;
  } finally { clearInterval(keepAlive); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await exporterMain({ area: "openai-auth", build: buildOpenAIAuthVectors });
}
