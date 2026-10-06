import { createSecurePath } from "@plur1bus/module-api";
import type { KeyringEntry, KeyringModule } from "../../src/secrets/keyring-backend.ts";

export const MARKER = "p1b-SECRET-MARKER-9f3a7c1e5d2b";

export const secure = createSecurePath({ logger: { warn() {} } });

export function fakeClock(start = Date.UTC(2026, 9, 6, 12, 0, 0)) {
  let t = start;
  const clock = () => t;
  return Object.assign(clock, { advance(ms: number) { t += ms; }, set(v: number) { t = v; } });
}

/** A stand-in for `@napi-rs/keyring`: an in-memory credential store. The real keychain is never touched in tests. */
export function fakeKeyring(): KeyringModule & { items: Map<string, string>; down: boolean } {
  const items = new Map<string, string>();
  const state = { down: false };
  class Entry implements KeyringEntry {
    service: string; user: string;
    constructor(service: string, user: string) { this.service = service; this.user = user; }
    k() { if (state.down) throw new Error("fake keyring: no secret service"); return `${this.service}\u0000${this.user}`; }
    getPassword() { return items.get(this.k()) ?? null; }
    setPassword(p: string) { items.set(this.k(), p); }
    deletePassword() { return items.delete(this.k()); }
  }
  return Object.assign({ Entry }, { items, get down() { return state.down; }, set down(v: boolean) { state.down = v; } }) as never;
}
