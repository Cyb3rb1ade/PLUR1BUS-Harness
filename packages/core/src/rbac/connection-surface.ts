// D109 §5: the surface level of an RPC connection, derived by the core from facts the core established itself. Never from
// a parameter, a header or anything the peer says about itself.
//
// THE LIMIT (owner decision 2026-10-08, issue #192: option A now, attestation (option C) to follow): a connection that passed `core.auth` proves one thing, that its
// peer could read `run/core.token` (a 0600 file of the owning OS user). The core cannot prove that the peer is a terminal
// with a human at it (no TTY attestation travels over the socket), nor that it is the desktop app, nor that it is not a
// process an agent started as the same OS user. So the conservative reading of the §5 table is:
//
//   - a person principal on a token connection without further proof is `UNATTESTED_LOCAL_SURFACE` = T1. Reading the
//     token proves only same-OS-user access, which an agent process also has; so an unattested connection decides
//     low-risk requests only (fs.read, fs.write within roots, clipboard.read) and can create no standing grant above T1 –
//     in particular no long-lived (up to 90 days) blanket grant. T2/T3 decisions need an attestation.
//   - T3 needs an attestation: a server-side fact the embedder supplies (`CoreOptions.rbac.attest`), e.g. a desktop app
//     that proved itself over a channel the core controls, or a CLI whose TTY and owning OS user the core verified.
//     The attestation function runs in the core process; no field of a request can reach it.
//   - an agent principal, an absent principal and a principal without `kind: "person"` are T0, with or without attestation.
//
// Why T1 and not T2 (#192): an agent that can run commands as the same OS user and read `run/core.token` could present
// itself as the local owner and, at T2, approve shell.exec/fs.delete/proc.signal/pkg.change/net.submit for itself or mint
// a 90-day standing grant. T1 closes that for every capability above low risk. The price – no medium-risk approval over
// RPC/CLI without attestation – is paid down by OS-backed attestation (Touch ID / Windows Hello / UAC / polkit, bound to the
// request; `../attestation/`): ONE confirmation lifts ONE approval to T2 and so allows a grant up to 90 days. That lift is not
// a property of the connection: this function still answers T1 for it, the approval handler decides that single request at
// surface 2 (approvals/rpc.ts) and the connection stays T1 for its next call. T3 remains the embedder's `rbac.attest`.
import { surfaceTrust, type SurfaceTrustLevel } from "./surface.ts";
import type { Principal } from "./types.ts";

/** What the core grants a person on a token-authenticated local connection that has no attestation. */
export const UNATTESTED_LOCAL_SURFACE: SurfaceTrustLevel = 1;

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
