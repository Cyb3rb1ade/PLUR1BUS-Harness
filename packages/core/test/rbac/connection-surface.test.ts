import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { UNATTESTED_LOCAL_SURFACE, connectionSurface } from "../../src/rbac/connection-surface.ts";
import type { Principal } from "../../src/rbac/types.ts";

const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);
const person: Principal = { userId: "u1", kind: "person", role: "owner" };

describe("connectionSurface (D109 §5 for a connection the core authenticated itself)", () => {
  it("a person on a token connection without further proof is T2, the documented ceiling", () => {
    assert.equal(UNATTESTED_LOCAL_SURFACE, 2);
    assert.equal(connectionSurface({ principal: person, now: NOW }), 2);
  });

  it("an agent principal is T0 whatever else is claimed, attestation included", () => {
    const agent: Principal = { userId: "a", kind: "agent", role: "owner" };
    assert.equal(connectionSurface({ principal: agent, now: NOW }), 0);
    assert.equal(connectionSurface({ principal: agent, now: NOW, attestation: { kind: "desktop-app" } }), 0);
  });

  it("a principal without a kind, a missing principal and garbage are T0 (fail closed)", () => {
    assert.equal(connectionSurface({ principal: { userId: "u", role: "owner" }, now: NOW }), 0);
    assert.equal(connectionSurface({ principal: null, now: NOW }), 0);
    assert.equal(connectionSurface({ principal: undefined, now: NOW }), 0);
    assert.equal(connectionSurface({ principal: { userId: "u", kind: "Person", role: "owner" } as unknown as Principal, now: NOW }), 0);
    assert.equal(connectionSurface(null as never), 0);
    assert.equal(connectionSurface({ principal: person, now: Number.NaN }), 0);
  });

  it("T3 needs a server-side attestation: desktop app, CLI on a TTY of the owning user, or a fresh step-up", () => {
    assert.equal(connectionSurface({ principal: person, now: NOW, attestation: { kind: "desktop-app" } }), 3);
    assert.equal(connectionSurface({ principal: person, now: NOW, attestation: { kind: "cli", tty: true, osUserIsOwner: true } }), 3);
    assert.equal(connectionSurface({ principal: person, now: NOW, attestation: { kind: "web-step-up", stepUpAt: NOW - 60_000 } }), 3);
  });

  it("an attestation that does not prove enough never lowers a person below T2 and never reaches T3", () => {
    assert.equal(connectionSurface({ principal: person, now: NOW, attestation: { kind: "cli", tty: false, osUserIsOwner: true } }), 2);
    assert.equal(connectionSurface({ principal: person, now: NOW, attestation: { kind: "cli", tty: true, osUserIsOwner: false } }), 2);
    assert.equal(connectionSurface({ principal: person, now: NOW, attestation: { kind: "web-step-up", stepUpAt: NOW - 10 * 60_000 } }), 2);
    assert.equal(connectionSurface({ principal: person, now: NOW, attestation: { kind: "web-step-up", stepUpAt: NOW + 60_000 } }), 2);
    assert.equal(connectionSurface({ principal: person, now: NOW, attestation: { kind: "mcp-client" } as never }), 2);
    assert.equal(connectionSurface({ principal: person, now: NOW, attestation: "desktop-app" as never }), 2);
  });
});
