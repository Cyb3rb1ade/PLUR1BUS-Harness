// Shared helpers for the new identity tests (new file, new identity tests only).
import { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createIdentityService, IdentityError, type Actor, type AuditEvent, type IdentityOptions, type IdentityService, type ChannelIdentity } from "../../src/identity/service.ts";

/** Seeded PRNG (mulberry32): the only source of randomness in these tests. The seed is part of every failure message. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The exact title of a documented-behaviour deviation: used as test name and as the `todo` reason. */
export function gap(fn: string, expected: string, actual: string): string {
  return `KNOWN GAP: core/identity ${fn}: erwartet ${expected}, tatsächlich ${actual}`;
}

export const OWNER: Actor = { user: "owner-user", host: "test-box", role: "owner", kind: "person" };
export const ADMIN: Actor = { user: "admin-user", host: "test-box", role: "admin", kind: "person" };
export const T0 = 1_800_000_000_000;
export const MIN = 60_000;

export interface Fixture {
  dir: string; file: string; svc: IdentityService; events: AuditEvent[]; now(): number; advance(ms: number): void;
  /** Opens another service on the same database file (a restart); it is closed after the test. */
  reopen(over?: Partial<IdentityOptions>): IdentityService;
  human(displayName?: string): { id: string; self: Actor };
  /** Full flow with a pairing code and an owner confirmation: the identity ends up linked to `humanId`. */
  pairAndLink(humanId: string, identity: ChannelIdentity): { linkId: string };
}

/** Registers cleanup in the calling scope: every service opened through the fixture is closed and its directory removed after each test. */
export function useIdentity() {
  const dirs: string[] = []; const open: IdentityService[] = [];
  afterEach(() => {
    for (const s of open.splice(0)) s.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return function fixture(over: Partial<IdentityOptions> = {}): Fixture {
    const dir = mkdtempSync(path.join(tmpdir(), "p1b-identity-new-")); dirs.push(dir);
    const file = path.join(dir, "identity.sqlite");
    let now = T0; const events: AuditEvent[] = [];
    const mk = (extra: Partial<IdentityOptions> = {}) => { const s = createIdentityService({ dbPath: file, clock: () => now, audit: (e) => { events.push(e); }, ...over, ...extra }); open.push(s); return s; };
    const svc = mk();
    const f: Fixture = {
      dir, file, svc, events, now: () => now, advance: (ms) => { now += ms; }, reopen: (extra) => mk(extra),
      human(displayName = "Person") { const h = svc.createHuman({ displayName }, OWNER); return { id: h.id, self: { user: h.id, host: "test-box", role: "member", kind: "person" } }; },
      pairAndLink(humanId, identity) {
        const p = svc.startPairing({ humanId, channel: identity.channel }, OWNER);
        const c = svc.claim({ code: p.code, identity });
        const done = svc.confirm({ pairingId: c.pairingId, approve: true }, OWNER);
        return { linkId: done.link!.id };
      },
    };
    return f;
  };
}

/** Asserts that `fn` throws an IdentityError with `code` (and optionally the offending `field`). */
export function refuses(fn: () => unknown, code: string, field?: string, why = ""): void {
  assert.throws(fn, (e: unknown) => e instanceof IdentityError && e.code === code && (field === undefined || e.field === field), `${why} expected IdentityError ${code}${field ? ` (${field})` : ""}`);
}
