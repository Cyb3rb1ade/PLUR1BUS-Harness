import { randomBytes } from "node:crypto";
import type { AccountStore } from "./account-store.ts";
import { ApiError, errors } from "./errors.ts";
import { assertCredential, registerCredential, WebAuthnError, type CredentialResponse, type WebAuthnContext } from "./webauthn.ts";
import type { Handler, HandlerDeps, RouteSpec } from "./routes.ts";
const fields: Record<string, readonly string[]> = {
  "passkeys.options": [], "passkeys.register": ["challenge", "name", "id", "clientDataJSON", "attestationObject"],
  "passkeys.change": ["id", "name"], "passkeys.login.options": ["username", "challenge"],
  "passkeys.login": ["challenge", "id", "clientDataJSON", "authenticatorData", "signature"],
};
const specs = [
  ["passkeys.list", "GET", "/me/passkeys", false], ["passkeys.options", "POST", "/me/passkeys/options", true], ["passkeys.register", "POST", "/me/passkeys/register", true], ["passkeys.change", "POST", "/me/passkeys/change", true],
  ["passkeys.login.options", "POST", "/session/passkey/options", false], ["passkeys.login", "POST", "/session/passkey", false],
] as const;
export const WEBAUTHN_ROUTES: readonly RouteSpec[] = specs.map(([id, method, path, write]) => ({ id, method, path: "/api/v1" + path, summary: id, tag: "passkeys", auth: id.includes("login") ? "none" : "session", authz: id.includes("login") ? "public" : { action: write ? "my.write" : "my.read", resource: "self" }, csrf: write, rate: id.includes("login") ? "auth" : write ? "write" : "read", stability: "experimental", since: "1.0.0", ...(method === "POST" ? { requestBody: { type: "object", additionalProperties: false, properties: Object.fromEntries(fields[id]!.map(k => [k, { type: "string", maxLength: 24000 }])) } } : {}), successStatus: 200, success: { description: id, schema: { type: "object", additionalProperties: true } } }));
export type PendingWebAuthn = WebAuthnContext & { userId: string; version: number; expires: number; registration: boolean };
export function buildWebAuthnHandlers(d: HandlerDeps, accounts: AccountStore | undefined, origin: (requestOrigin?: string) => string, pending = new Map<string, PendingWebAuthn>()): Record<string, Handler> {
  const needStore = () => { if (!accounts || !d.users) throw new ApiError(503, "E_NOT_AVAILABLE", "passkeys unavailable"); return accounts; };
  const issue = (userId: string, version: number, registration: boolean, requestOrigin?: string) => {
    for (const [key, value] of pending) if (value.expires <= d.clock.now()) pending.delete(key);
    while (pending.size >= 256) pending.delete(pending.keys().next().value!);
    const challenge = randomBytes(32).toString("base64url"), configured = new URL(origin(requestOrigin));
    if (configured.protocol !== "https:" && !["127.0.0.1", "localhost", "[::1]"].includes(configured.hostname)) throw errors.forbidden("webauthn-insecure-origin");
    const entry = { challenge, origin: configured.origin, rpId: configured.hostname, userId, version, expires: d.clock.now() + 300000, registration }; pending.set(challenge, entry); return entry;
  };
  const body = (input: unknown): Record<string, unknown> => { if (!input || typeof input !== "object" || Array.isArray(input)) throw errors.badRequest("body", "invalid passkey request"); return input as Record<string, unknown>; };
  const take = (b: Record<string, unknown>, registration: boolean, requestOrigin?: string): PendingWebAuthn => {
    const p = typeof b.challenge === "string" ? pending.get(b.challenge) : undefined;
    if (typeof b.challenge === "string") pending.delete(b.challenge);
    if (!p || p.registration !== registration || p.expires <= d.clock.now() || p.origin !== new URL(origin(requestOrigin)).origin) throw errors.unauthenticated("webauthn-challenge"); return p;
  };
  const user = async (id: string) => { const u = await d.users?.findById(id); if (!u || u.disabled) throw errors.unauthenticated("invalid-credentials"); return u; };
  const handlers: Record<string, Handler> = {
    "passkeys.list": async i => ({ body: { keys: (accounts?.passkeysFor(i.principal!.id) ?? []).map(({ id, name }) => ({ id, name })) } }),
    "passkeys.options": async i => {
      const store = needStore(), u = await user(i.principal!.id), p = issue(u.id, u.version, true, i.origin);
      return { body: { challenge: p.challenge, rp: { id: p.rpId, name: "PLUR1BUS" }, user: { id: Buffer.from(u.id).toString("base64url"), name: u.username, displayName: u.username }, pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -8 }], timeout: 300000, attestation: "none", authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" }, excludeCredentials: store.passkeysFor(u.id).map(k => ({ type: "public-key", id: k.id })) } };
    },
    "passkeys.register": async i => {
      const store = needStore(), b = body(i.body), p = take(b, true, i.origin), u = await user(p.userId);
      if (u.id !== i.principal!.id || u.version !== p.version || typeof b.name !== "string" || !b.name.trim() || b.name.length > 80) throw errors.forbidden("webauthn-binding");
      const key = registerCredential(b as unknown as CredentialResponse, p); store.putPasskey(u.id, { ...key, name: b.name.trim() });
      d.audit.emit("auth.passkey.registered", u.id, "account", {}); return { body: { registered: true } };
    },
    "passkeys.change": async i => {
      const store = needStore(), b = body(i.body); if (typeof b.id !== "string" || b.name !== undefined && (typeof b.name !== "string" || !b.name.trim() || b.name.length > 80)) throw errors.badRequest("body", "invalid passkey change");
      store.changePasskey(i.principal!.id, b.id, typeof b.name === "string" ? b.name.trim() : undefined); d.audit.emit("auth.passkey.changed", i.principal!.id, "account", {}); return { body: { changed: true } };
    },
    "passkeys.login.options": async i => {
      const b = body(i.body); if (typeof b.username !== "string" || b.username.length > 128) throw errors.badRequest("username", "invalid username");
      needStore(); const u = await d.users!.findByUsername(b.username);
      if (b.challenge !== undefined) { const ch = d.challenges?.get(b.challenge); if (!u || !ch || ch.userId !== u.id || ch.version !== u.version || !d.challenges!.consume(b.challenge as string)) throw errors.unauthenticated("webauthn-challenge"); }
      const p = issue(u && !u.disabled ? u.id : "", u?.version ?? 0, false, i.origin);
      // Do not enumerate accounts or credentials in the public options response; authenticator discovery selects the key.
      return { body: { challenge: p.challenge, rpId: p.rpId, timeout: 300000, userVerification: "required" } };
    },
    "passkeys.login": async i => {
      const b = body(i.body), p = take(b, false, i.origin), store = needStore(), u = await user(p.userId);
      const key = store.passkeysFor(u.id).find(k => k.id === b.id); if (!key || u.version !== p.version) throw errors.unauthenticated("invalid-credentials");
      const count = assertCredential(b as unknown as CredentialResponse, p, key);
      if (!store.advancePasskey(u.id, key.id, key.signCount, count)) throw errors.unauthenticated("webauthn-race");
      const current = await user(u.id); if (current.version !== p.version) throw errors.unauthenticated("webauthn-binding");
      d.sessions.destroy(i.presentedSessionId); const { id, session } = d.sessions.create({ kind: "user", id: u.id, role: current.role }, { authVersion: current.version, stepUpAt: d.clock.now() });
      d.audit.emit("auth.login.success", u.id, "account", { via: "passkey" }); return { body: { schema: "session.create/1", principal: session.principal, createdAt: new Date(session.createdAt).toISOString(), expiresAt: new Date(session.absoluteExpiresAt).toISOString(), idleExpiresAt: new Date(session.idleExpiresAt).toISOString() }, headers: { "Set-Cookie": `${d.tls ? "__Host-plur1bus_session" : "plur1bus_session"}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor((session.absoluteExpiresAt - session.createdAt) / 1000)}${d.tls ? "; Secure" : ""}` } };
    },
  };
  return Object.fromEntries(Object.entries(handlers).map(([id, handler]) => [id, async (i: Parameters<Handler>[0]) => { try { if (id !== "passkeys.list") { const input = body(i.body); if (Object.keys(input).some(k => !fields[id]!.includes(k))) throw errors.badRequest("body", "unknown passkey fields"); } return await handler(i); } catch (e) { if (e instanceof WebAuthnError) { d.audit.emit(e.reason === "credential-clone" ? "auth.passkey.clone-warning" : "auth.passkey.failure", i.principal?.id ?? "anonymous", "account", { reason: e.reason }); throw errors.unauthenticated(e.reason); } throw e; } }]));
}
