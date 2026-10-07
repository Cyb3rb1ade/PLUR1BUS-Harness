// D109 §5: the surface level of an RPC connection, derived by the core from facts the core established itself. Never from
// a parameter, a header or anything the peer says about itself.
//
// THE LIMIT (reported to the controller, decision pending): a connection that passed `core.auth` proves one thing, that its
// peer could read `run/core.token` (a 0600 file of the owning OS user). The core cannot prove that the peer is a terminal
// with a human at it (no TTY attestation travels over the socket), nor that it is the desktop app, nor that it is not a
// process an agent started as the same OS user. So the conservative reading of the §5 table is:
//
//   - a person principal on a token connection without further proof is `UNATTESTED_LOCAL_SURFACE` = T2 (the row "web
//     session without step-up": an authenticated session of a person, nothing more). That decides medium/high risk
//     requests and standing grants up to T2 capabilities; it never decides T3 requests (money.spend, os.privilege,
//     remote.control, `always` grants outside roots, ...).
//   - T3 needs an attestation: a server-side fact the embedder supplies (`CoreOptions.rbac.attest`), e.g. a desktop app
//     that proved itself over a channel the core controls, or a CLI whose TTY and owning OS user the core verified.
//     The attestation function runs in the core process; no field of a request can reach it.
//   - an agent principal, an absent principal and a principal without `kind: "person"` are T0, with or without attestation.
//
// Known residual risk of T2: an agent that can run commands as the same OS user and read `run/core.token` could present
// itself as the local owner. The mitigation is outside this function (the exec sandbox must deny `run/` and `state/`
// to agent processes, and the dispatcher must never hand out the token); an unattested T1 default would close it for
// every capability above low risk, at the price that no medium-risk approval is decidable over RPC until an
// attestation exists. That choice is the controller's.
import { surfaceTrust, type SurfaceTrustLevel } from "./surface.ts";
import type { Principal } from "./types.ts";

/** What the core grants a person on a token-authenticated local connection that has no attestation. */
export const UNATTESTED_LOCAL_SURFACE: SurfaceTrustLevel = 2;

/** A fact about the connection that the core verified itself. Anything else is ignored. */
export type ConnectionAttestation =
  | { kind: "desktop-app" }
  | { kind: "cli"; tty: boolean; osUserIsOwner: boolean }
  /** `stepUpAt`: epoch ms of a WebAuthn/TOTP step-up the core verified; valid for STEP_UP_WINDOW_MS. */
  | { kind: "web-step-up"; stepUpAt: number };

export interface ConnectionFacts {
  principal: Principal | null | undefined;
  /** Epoch ms, from the core's clock. */
  now: number;
  attestation?: ConnectionAttestation | undefined;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const get = (o: Record<string, unknown>, k: string): unknown => (Object.hasOwn(o, k) ? o[k] : undefined);

export function connectionSurface(facts: ConnectionFacts): SurfaceTrustLevel {
  if (!isObj(facts)) return 0;
  const principal = get(facts, "principal");
  if (!isObj(principal) || get(principal, "kind") !== "person") return 0;
  const now = get(facts, "now");
  if (typeof now !== "number" || !Number.isFinite(now)) return 0;
  const att = get(facts, "attestation");
  if (isObj(att)) {
    let level: SurfaceTrustLevel = 0;
    switch (get(att, "kind")) {
      case "desktop-app": level = surfaceTrust({ kind: "desktop-app" }); break;
      case "cli": level = surfaceTrust({ kind: "cli", tty: get(att, "tty") === true, osUserIsOwner: get(att, "osUserIsOwner") === true }); break;
      case "web-step-up": {
        const up = get(att, "stepUpAt");
        level = surfaceTrust({ kind: "web", authenticated: true, now, ...(typeof up === "number" ? { stepUpAt: up } : {}) });
        break;
      }
      default: break;
    }
    // An attestation can only raise a person above the unattested level, never lower it.
    if (level === 3) return 3;
  }
  return UNATTESTED_LOCAL_SURFACE;
}
