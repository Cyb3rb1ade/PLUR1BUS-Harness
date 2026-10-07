// D109 §5 "Surfaces and channel trust": the level of the surface a decision arrives on, as a pure function of facts the
// core itself established. Anything not listed in the table is T0, and so is any input that is not well formed.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { STEP_UP_WINDOW_MS, surfaceSatisfies, surfaceTrust, type SurfaceFacts } from "../../src/rbac/surface.ts";

const NOW = 10_000_000;
const channel = (over: Partial<Extract<SurfaceFacts, { kind: "channel" }>> = {}): SurfaceFacts =>
  ({ kind: "channel", firstParty: true, optedIntoT2: false, chat: "private", identityLinked: true, nonceValid: true, ...over });
const web = (over: Partial<Extract<SurfaceFacts, { kind: "web" }>> = {}): SurfaceFacts =>
  ({ kind: "web", authenticated: true, now: NOW, ...over });

describe("surface trust (T0-T3)", () => {
  it("T3: the desktop app, and the CLI on a TTY of the owning OS user", () => {
    assert.equal(surfaceTrust({ kind: "desktop-app" }), 3);
    assert.equal(surfaceTrust({ kind: "cli", tty: true, osUserIsOwner: true }), 3);
  });

  it("the CLI is T0 without a TTY or when the OS user is not the owner", () => {
    assert.equal(surfaceTrust({ kind: "cli", tty: false, osUserIsOwner: true }), 0);
    assert.equal(surfaceTrust({ kind: "cli", tty: true, osUserIsOwner: false }), 0);
    assert.equal(surfaceTrust({ kind: "cli", tty: false, osUserIsOwner: false }), 0);
  });

  it("web: T2 for a session, T3 within five minutes of a step-up, T2 again after, T0 without a session", () => {
    assert.equal(surfaceTrust(web()), 2);
    assert.equal(surfaceTrust(web({ stepUpAt: NOW - 1 })), 3);
    assert.equal(surfaceTrust(web({ stepUpAt: NOW - STEP_UP_WINDOW_MS })), 3);
    assert.equal(surfaceTrust(web({ stepUpAt: NOW - STEP_UP_WINDOW_MS - 1 })), 2);
    assert.equal(STEP_UP_WINDOW_MS, 5 * 60_000);
    assert.equal(surfaceTrust(web({ authenticated: false })), 0);
    assert.equal(surfaceTrust(web({ authenticated: false, stepUpAt: NOW - 1 })), 0);
  });

  it("web: a step-up in the future, or one that is not a finite number, does not count", () => {
    assert.equal(surfaceTrust(web({ stepUpAt: NOW + 1 })), 2);
    assert.equal(surfaceTrust(web({ stepUpAt: Number.NaN })), 2);
    assert.equal(surfaceTrust(web({ stepUpAt: Number.POSITIVE_INFINITY })), 2);
    assert.equal(surfaceTrust(web({ now: Number.NaN, stepUpAt: 1 })), 0);
  });

  it("T2: a private chat with a linked identity and a valid nonce on a first-party channel", () => {
    assert.equal(surfaceTrust(channel()), 2);
  });

  it("a third-party channel module is T2 only when the person opted that module in", () => {
    assert.equal(surfaceTrust(channel({ firstParty: false })), 0);
    assert.equal(surfaceTrust(channel({ firstParty: false, optedIntoT2: true })), 2);
  });

  it("channel: a group chat, an unlinked identity or a missing or wrong nonce is T0", () => {
    assert.equal(surfaceTrust(channel({ chat: "group" })), 0);
    assert.equal(surfaceTrust(channel({ chat: "group", optedIntoT2: true })), 0);
    assert.equal(surfaceTrust(channel({ identityLinked: false })), 0);
    assert.equal(surfaceTrust(channel({ nonceValid: false })), 0);
  });

  it("T1: only the inbound ACP editor that started the session", () => {
    assert.equal(surfaceTrust({ kind: "acp-editor", startedSession: true }), 1);
    assert.equal(surfaceTrust({ kind: "acp-editor", startedSession: false }), 0);
  });

  it("T0: MCP clients, A2A peers, agents, model output, tool results and anything unknown", () => {
    for (const kind of ["mcp-client", "a2a-peer", "agent", "model-output", "tool-result", "unknown"] as const) assert.equal(surfaceTrust({ kind }), 0, kind);
  });

  it("is total: garbage in, T0 out", () => {
    for (const v of [null, undefined, 3, "cli", "desktop-app", [], {}, { kind: 7 }, { kind: "cli" }, { kind: "web" }, { kind: "channel" }, { kind: "acp-editor" }]) {
      assert.equal(surfaceTrust(v as never), 0, JSON.stringify(v));
    }
    assert.equal(surfaceTrust({ kind: "cli", tty: "yes", osUserIsOwner: 1 } as never), 0);
    assert.equal(surfaceTrust({ kind: "channel", firstParty: "true", optedIntoT2: false, chat: "private", identityLinked: true, nonceValid: true } as never), 0);
    assert.equal(surfaceTrust({ kind: "toString" } as never), 0);
    assert.equal(surfaceTrust(JSON.parse('{"kind":"__proto__"}') as never), 0);
  });

  it("is pure: the same facts give the same level, and the input is not changed", () => {
    const f = Object.freeze(web({ stepUpAt: NOW - 10 }));
    assert.equal(surfaceTrust(f), surfaceTrust(f));
  });

  it("surfaceSatisfies: a level meets a requirement at or below it, and T0 never satisfies anything", () => {
    assert.equal(surfaceSatisfies(3, 3), true);
    assert.equal(surfaceSatisfies(3, 1), true);
    assert.equal(surfaceSatisfies(2, 3), false);
    assert.equal(surfaceSatisfies(1, 2), false);
    assert.equal(surfaceSatisfies(0, 0), false);
    assert.equal(surfaceSatisfies(0, 1), false);
    assert.equal(surfaceSatisfies(3, null), false); // a capability that never asks cannot be decided anywhere
    assert.equal(surfaceSatisfies(9 as never, 1), false);
  });
});
