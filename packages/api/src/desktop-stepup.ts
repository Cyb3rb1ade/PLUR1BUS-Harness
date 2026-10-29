/** Same-person browser approval of already-enrolled native scopes. No credential is persisted. */
import { createHash, randomBytes } from "node:crypto";
import type { ApiPrincipal } from "@plur1bus/module-api";
import type { CorePerson } from "./account-store.ts";
import type { Clock } from "./clock.ts";
import type { CoreRpc } from "./core-rpc.ts";
import type { DesktopIdentity } from "./desktop-attach-routes.ts";
import { errors, fromCoreError } from "./errors.ts";
import type { UserDirectory } from "./ports.ts";
import type { Session, SessionStore } from "./session.ts";

export type DesktopPurpose = "session" | "extensions" | "imports";
export type DesktopProofScope = "session" | "extensions.manage" | "imports.manage";
export const DESKTOP_STEPUP_HEADER = "x-plur1bus-desktop-step-up";
const TTL = 300_000, MAX_CHALLENGES = 32, MAX_PER_DEVICE = 4, MAX_PROOFS = 256, MAX_PER_GRANT = 8;
const SECRET = /^[A-Za-z0-9_-]{43}$(?![\s\S])/;
const CODE = /^[A-Z2-9]{4}-[A-Z2-9]{4}$(?![\s\S])/;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const scopesDigest = (scopes: readonly string[]) => digest(JSON.stringify([...scopes].sort()));
const denied = () => errors.forbidden("second-factor-required");
interface Options {
  core: CoreRpc; clock: Clock; sessions: SessionStore; users?: UserDirectory;
  /** Local invalidation metadata only; never a Core role or grant fallback. */
  credentialVersion?(userId: string): number | undefined;
}
interface Binding {
  deviceId: string; userId: string; scopesDigest: string; credentialDigest: string;
  coreVersion: number; role: CorePerson["role"]; deviceExpiresAt: number;
}
interface Challenge {
  hash: string; userCode: string; purpose: DesktopPurpose; binding: Binding; expiresAt: number;
  state: "pending" | "approved" | "declined";
  approvingSession?: Session; credentialVersion?: number; stepUpAt?: number;
  proofs: Set<string>;
}
export interface VerifiedDeviceStepUp {
  readonly identity: DesktopIdentity; readonly person: CorePerson; readonly grantedScopes: string[];
  readonly stepUpAt: number; readonly expiresAt: number; readonly purpose: DesktopPurpose;
}
/** Returned only by the private session map. Object identity, rather than these fields, is the authority. */
export interface DesktopSessionProof {
  readonly deviceId: string; readonly userId: string; readonly purpose: DesktopPurpose;
  readonly scopesDigest: string; readonly credentialDigest: string;
  readonly coreVersion: number; readonly credentialVersion: number; readonly stepUpAt: number;
  readonly role: CorePerson["role"]; readonly deviceExpiresAt: number;
}
export type DesktopPoll = { state: "pending" | "declined" | "expired"; expiresAt: number }
  | { state: "approved"; purpose: DesktopPurpose; proofToken: string; expiresAt: number };

export class DesktopStepUp {
  readonly #o: Options;
  readonly #challenges = new Map<string, Challenge>();
  readonly #codes = new Map<string, Challenge>();
  readonly #proofs = new Map<string, Challenge>();
  readonly #verified = new WeakMap<VerifiedDeviceStepUp, Challenge>();
  readonly #sessions = new WeakMap<Session, DesktopSessionProof>();
  readonly #off: () => void;
  constructor(options: Options) {
    this.#o = options;
    this.#off = options.sessions.onEnd(session => {
      this.#sessions.delete(session);
      for (const challenge of this.#challenges.values()) if (challenge.approvingSession === session) this.#decline(challenge);
    });
  }
  close(): void { this.#off(); this.#challenges.clear(); this.#codes.clear(); this.#proofs.clear(); }

  async #service<T>(method: string, params: object): Promise<T> {
    if (!this.#o.core.serviceCall) throw denied();
    try { return await this.#o.core.serviceCall<T>(method, params); } catch (error) { throw fromCoreError(error); }
  }
  async #person(identity: DesktopIdentity): Promise<CorePerson> {
    const { person } = await this.#service<{ person: CorePerson | null }>("admin.api.person.resolve", { userId: identity.userId });
    if (!person || person.disabled || person.userId !== identity.userId || !Number.isSafeInteger(person.version)
      || !["owner", "admin", "operator", "member", "viewer"].includes(person.role)) throw denied();
    return person;
  }
  #identity(identity: DesktopIdentity): void {
    if (!identity || typeof identity.deviceId !== "string" || !identity.deviceId || identity.deviceId.length > 512
      || typeof identity.userId !== "string" || !identity.userId || identity.userId.length > 512
      || !Number.isSafeInteger(identity.expiresAt) || identity.expiresAt <= this.#o.clock.now()
      || !Array.isArray(identity.scopes) || identity.scopes.length > 256
      || identity.scopes.some(scope => typeof scope !== "string" || !scope || scope.length > 128 || /[\x00-\x20\x7f]/.test(scope))
      || new Set(identity.scopes).size !== identity.scopes.length) throw denied();
  }
  async #live(token: string) {
    if (!SECRET.test(token)) throw errors.unauthenticated("invalid-device-token");
    const identity = await this.#service<DesktopIdentity>("admin.api.desktop.token", { token });
    this.#identity(identity);
    return { identity, person: await this.#person(identity) };
  }
  #binding(identity: DesktopIdentity, person: CorePerson, token: string): Binding {
    return { deviceId: identity.deviceId, userId: identity.userId, scopesDigest: scopesDigest(identity.scopes),
      credentialDigest: digest(token), coreVersion: person.version, role: person.role, deviceExpiresAt: identity.expiresAt };
  }
  #matches(binding: Binding, identity: DesktopIdentity, person: CorePerson, token?: string): boolean {
    return binding.deviceId === identity.deviceId && binding.userId === identity.userId
      && binding.scopesDigest === scopesDigest(identity.scopes) && binding.coreVersion === person.version
      && binding.role === person.role && binding.deviceExpiresAt === identity.expiresAt
      && (token === undefined || binding.credentialDigest === digest(token));
  }
  #scopes(identity: DesktopIdentity, purpose: DesktopPurpose): string[] {
    return identity.scopes.filter(scope => scope.startsWith("extensions.") ? purpose === "extensions"
      : scope.startsWith("imports.") ? purpose === "imports" : true);
  }
  #purpose(identity: DesktopIdentity, person: CorePerson, purpose: DesktopPurpose): void {
    if (!["session", "extensions", "imports"].includes(purpose)) throw errors.badRequest("body", "invalid approval purpose");
    if (purpose !== "session" && (!["owner", "admin"].includes(person.role)
      || !identity.scopes.includes(`${purpose}.manage`) || !identity.scopes.includes(`${purpose}.read`))) throw denied();
  }
  #prune(): void {
    const now = this.#o.clock.now();
    for (const [hash, challenge] of this.#challenges) if (challenge.expiresAt <= now) {
      this.#decline(challenge); this.#challenges.delete(hash); this.#codes.delete(challenge.userCode);
    }
  }
  #decline(challenge: Challenge): void {
    challenge.state = "declined";
    for (const proof of challenge.proofs) this.#proofs.delete(proof);
    challenge.proofs.clear();
  }
  async start(token: string, purpose: DesktopPurpose) {
    const { identity, person } = await this.#live(token);
    this.#purpose(identity, person, purpose); this.#prune();
    let own = 0;
    for (const challenge of this.#challenges.values()) if (challenge.binding.deviceId === identity.deviceId) own++;
    if (this.#challenges.size >= MAX_CHALLENGES || own >= MAX_PER_DEVICE) throw errors.rateLimited(30);
    const challengeId = randomBytes(32).toString("base64url");
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let userCode: string;
    do {
      const chars = [...randomBytes(8)].map(byte => alphabet[byte & 31]!).join("");
      userCode = `${chars.slice(0, 4)}-${chars.slice(4)}`;
    } while (this.#codes.has(userCode));
    const challenge: Challenge = { hash: digest(challengeId), userCode, purpose, binding: this.#binding(identity, person, token),
      expiresAt: Math.min(this.#o.clock.now() + TTL, identity.expiresAt), state: "pending", proofs: new Set() };
    this.#challenges.set(challenge.hash, challenge); this.#codes.set(userCode, challenge);
    return { challengeId, userCode, purpose, expiresAt: challenge.expiresAt, intervalMs: 1500 };
  }
  async #actor(session: Session, challenge: Challenge, fresh = false): Promise<number> {
    if (!session || !this.#o.sessions.isLive(session) || session.device || session.principal.kind !== "user"
      || session.principal.id !== challenge.binding.userId || session.mustRotate) throw denied();
    const user = await this.#o.users?.findById(session.principal.id);
    if (!user || user.disabled || user.version !== session.authVersion || user.role !== challenge.binding.role) throw denied();
    if (fresh && (session.stepUpAt === undefined || session.stepUpAt > this.#o.clock.now()
      || session.stepUpAt + TTL <= this.#o.clock.now())) throw denied();
    if (!this.#o.sessions.isLive(session)) throw denied();
    return this.#o.credentialVersion?.(user.id) ?? user.version;
  }
  #code(userCode: string): Challenge {
    if (!CODE.test(userCode)) throw denied();
    const challenge = this.#codes.get(userCode);
    if (!challenge || challenge.expiresAt <= this.#o.clock.now()) throw denied();
    return challenge;
  }
  #public(challenge: Challenge) {
    return { userCode: challenge.userCode, deviceId: challenge.binding.deviceId, purpose: challenge.purpose,
      state: challenge.state, expiresAt: challenge.expiresAt };
  }
  async lookup(session: Session, userCode: string) {
    const challenge = this.#code(userCode); await this.#actor(session, challenge);
    return this.#public(challenge);
  }
  async decision(session: Session, userCode: string, decision: "approve" | "decline") {
    const challenge = this.#code(userCode);
    const version = await this.#actor(session, challenge, decision === "approve");
    if (decision === "decline") { this.#decline(challenge); return this.#public(challenge); }
    if (decision !== "approve" || challenge.state === "declined") throw denied();
    if (challenge.state === "approved") return this.#public(challenge);
    challenge.approvingSession = session; challenge.credentialVersion = version; challenge.stepUpAt = session.stepUpAt!;
    challenge.expiresAt = Math.min(challenge.expiresAt, session.stepUpAt! + TTL, session.absoluteExpiresAt, session.idleExpiresAt);
    challenge.state = "approved";
    return this.#public(challenge);
  }
  async #grant(challenge: Challenge): Promise<void> {
    if (challenge.state !== "approved" || challenge.expiresAt <= this.#o.clock.now()
      || !challenge.approvingSession || challenge.credentialVersion === undefined) throw denied();
    const version = await this.#actor(challenge.approvingSession, challenge);
    if (version !== challenge.credentialVersion || challenge.state !== "approved" || challenge.expiresAt <= this.#o.clock.now()) throw denied();
  }
  async poll(token: string, challengeId: string): Promise<DesktopPoll> {
    const live = await this.#live(token);
    if (!SECRET.test(challengeId)) throw denied();
    const challenge = this.#challenges.get(digest(challengeId));
    if (!challenge || challenge.expiresAt <= this.#o.clock.now()) return { state: "expired", expiresAt: this.#o.clock.now() };
    if (!this.#matches(challenge.binding, live.identity, live.person, token)) throw denied();
    if (challenge.state !== "approved") return { state: challenge.state, expiresAt: challenge.expiresAt };
    await this.#grant(challenge);
    if (this.#proofs.size >= MAX_PROOFS || challenge.proofs.size >= MAX_PER_GRANT) throw errors.rateLimited(2);
    const proofToken = randomBytes(32).toString("base64url"), hash = digest(proofToken);
    challenge.proofs.add(hash); this.#proofs.set(hash, challenge);
    return { state: "approved", purpose: challenge.purpose, proofToken, expiresAt: challenge.expiresAt };
  }
  async cancel(token: string, challengeId: string): Promise<void> {
    const live = await this.#live(token), challenge = this.#challenges.get(digest(challengeId));
    if (!challenge || !this.#matches(challenge.binding, live.identity, live.person, token)) throw denied();
    this.#decline(challenge);
  }
  async verify(token: string, header: unknown, scope: DesktopProofScope): Promise<VerifiedDeviceStepUp> {
    if (typeof header !== "string" || !SECRET.test(header)) throw denied();
    const hash = digest(header), challenge = this.#proofs.get(hash);
    if (!challenge || scope !== "session" && `${challenge.purpose}.manage` !== scope) throw denied();
    const { identity, person } = await this.#live(token);
    if (!this.#matches(challenge.binding, identity, person, token)) throw denied();
    this.#purpose(identity, person, challenge.purpose); await this.#grant(challenge);
    if (this.#proofs.get(hash) !== challenge || challenge.state !== "approved") throw denied();
    this.#proofs.delete(hash); challenge.proofs.delete(hash);
    const grantedScopes = this.#scopes(identity, challenge.purpose);
    Object.freeze(grantedScopes); Object.freeze(identity.scopes); Object.freeze(identity); Object.freeze(person);
    const result = Object.freeze({ identity, person, grantedScopes,
      purpose: challenge.purpose, stepUpAt: challenge.stepUpAt!, expiresAt: challenge.expiresAt });
    this.#verified.set(result, challenge);
    return result;
  }
  async revalidateTicket(proof: VerifiedDeviceStepUp, identity: DesktopIdentity): Promise<void> {
    const challenge = this.#verified.get(proof);
    this.#identity(identity);
    if (!challenge || !this.#matches(challenge.binding, identity, await this.#person(identity))) throw denied();
    await this.#grant(challenge);
  }
  bindSession(session: Session, verified: VerifiedDeviceStepUp): void {
    const grant = this.#verified.get(verified);
    if (!grant || grant.state !== "approved" || grant.expiresAt <= this.#o.clock.now() || !this.#o.sessions.isLive(session)
      || session.principal.kind !== "user" || session.principal.id !== verified.identity.userId
      || session.principal.role !== verified.person.role || session.authVersion !== verified.person.version
      || session.stepUpAt !== verified.stepUpAt || session.device?.deviceId !== verified.identity.deviceId
      || session.device.userId !== verified.identity.userId || session.device.expiresAt !== verified.identity.expiresAt
      || scopesDigest(session.device.scopes) !== scopesDigest(verified.grantedScopes)) throw denied();
    this.#sessions.set(session, Object.freeze({ deviceId: verified.identity.deviceId, userId: verified.identity.userId,
      purpose: verified.purpose, scopesDigest: scopesDigest(verified.grantedScopes), credentialDigest: grant.binding.credentialDigest,
      coreVersion: grant.binding.coreVersion, credentialVersion: grant.credentialVersion!, stepUpAt: verified.stepUpAt,
      role: grant.binding.role, deviceExpiresAt: grant.binding.deviceExpiresAt }));
  }
  sessionProof(session: Session, principal: ApiPrincipal): DesktopSessionProof | undefined {
    const proof = this.#sessions.get(session);
    if (!proof || !this.#o.sessions.isLive(session) || session.mustRotate || !session.device
      || session.device.deviceId !== proof.deviceId || session.device.userId !== proof.userId
      || session.principal.id !== proof.userId || principal.userId !== proof.userId || principal.kind !== "person"
      || session.principal.kind !== "user" || session.principal.role !== proof.role || principal.role !== proof.role
      || session.authVersion !== proof.coreVersion || session.stepUpAt !== proof.stepUpAt
      || session.device.expiresAt !== proof.deviceExpiresAt || session.device.expiresAt <= this.#o.clock.now()
      || scopesDigest(session.device.scopes) !== proof.scopesDigest || scopesDigest(principal.tokenScopes ?? []) !== proof.scopesDigest
      || this.#o.credentialVersion?.(proof.userId) !== proof.credentialVersion) return undefined;
    return proof;
  }
  importSessionProof(session: Session, principal: ApiPrincipal): DesktopSessionProof | undefined {
    const proof = this.sessionProof(session, principal);
    return proof?.purpose === "imports" && session.device?.scopes.includes("imports.manage") ? proof : undefined;
  }
}
