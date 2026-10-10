import { randomBytes } from "node:crypto";
import type { PolicyAudit } from "../policy/audit.ts";
import { runHelper, type HelperSpec } from "./helper.ts";
import type { AttestFailure, AttestInput, AttestProbe, AttestResult, Attester, HelperRequest } from "./types.ts";

/** A confirmation is asked for at most this long (the helper's dialog and the core's deadline). */
export const MAX_ATTEST_TTL_MS = 60_000;
const DEFAULT_TTL_MS = 60_000;
const PROBE_DEADLINE_MS = 5_000;
/** The helper's clock and the core's are the same machine's; this much skew is tolerated, no more. */
const SKEW_MS = 2_000;
const CONSUMED_KEPT = 4096;

export interface AttestationServiceOptions {
  /** `null`: no helper (container mode, no graphical session, not shipped): every attempt is `unavailable` and nothing breaks. */
  helper: HelperSpec | null;
  audit?: PolicyAudit;
  now?: () => number;
  ttlMs?: number;
  newNonce?: () => string;
}

const OUTCOME: Record<AttestFailure | "ok", string> = {
  ok: "confirmed", cancelled: "cancelled", timeout: "timeout", unavailable: "unavailable", failed: "failed", replay: "replay", mismatch: "mismatch",
};

export function createAttestationService(o: AttestationServiceOptions): Attester {
  const now = o.now ?? Date.now;
  const newNonce = o.newNonce ?? (() => randomBytes(24).toString("hex"));
  const baseTtl = Math.min(Math.max(1, o.ttlMs ?? DEFAULT_TTL_MS), MAX_ATTEST_TTL_MS);
  const issued = new Set<string>();
  const consumed = new Set<string>();

  function consume(nonce: string): void {
    issued.delete(nonce);
    consumed.add(nonce);
    if (consumed.size > CONSUMED_KEPT) consumed.delete(consumed.values().next().value as string);
  }

  async function attest(input: AttestInput): Promise<AttestResult> {
    const fields = { ...(input.person ? { person: input.person } : {}), ...(input.requestId ? { requestId: input.requestId } : {}), ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.scope ? { scope: input.scope } : {}), actionHash: input.actionHash };
    const result = (r: AttestResult, method?: string, why?: string): AttestResult => {
      try { o.audit?.record("attestation.result", { ...fields, attestationOutcome: OUTCOME[r.ok ? "ok" : r.reason], ...(method ? { method } : {}), ...(why ? { reason: why } : {}) }); } catch { /* the outcome stands */ }
      return r;
    };
    const fail = (reason: AttestFailure, why?: string): AttestResult => result({ ok: false, reason }, undefined, why);

    if (o.helper === null) return fail("unavailable");
    const nonce = newNonce();
    const ttlMs = Math.min(Math.max(1, input.ttlMs ?? baseTtl), MAX_ATTEST_TTL_MS);
    const issuedAt = now();
    try { o.audit?.record("attestation.requested", { ...fields }); }
    catch { return { ok: false, reason: "failed" }; } // never ask unrecorded
    issued.add(nonce);
    const req: HelperRequest = { v: 1, nonce, actionHash: input.actionHash, text: input.text, ttlMs };
    const out = await runHelper(o.helper, "--attest", req, ttlMs);
    // Whatever the helper says, this nonce is spent: one attempt, one answer.
    consume(nonce);
    switch (out.kind) {
      case "timeout": return fail("timeout");
      case "missing": return fail("unavailable");
      case "refused": return fail("unavailable", out.reason); // a helper that fails its pin is no helper; the reason is for the audit log
      case "broken": return fail("failed");
      case "reply": break;
    }
    const v = out.value;
    if (v.v !== 1) return fail("failed");
    const echoed = v.nonce;
    if (typeof echoed === "string" && echoed !== nonce) return fail(consumed.has(echoed) ? "replay" : "mismatch");
    if (v.ok !== true) {
      const r = v.reason;
      return fail(r === "cancelled" ? "cancelled" : r === "unavailable" ? "unavailable" : r === "timeout" ? "timeout" : "failed");
    }
    if (echoed !== nonce) return fail("mismatch");
    if (v.actionHash !== input.actionHash) return fail("mismatch");
    const at = v.at;
    const method = v.method;
    if (typeof method !== "string" || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(method)) return fail("failed");
    if (typeof at !== "number" || !Number.isFinite(at) || at < issuedAt - SKEW_MS || at > now() + SKEW_MS) return fail("mismatch");
    return result({ ok: true, method, at }, method);
  }

  async function probe(): Promise<AttestProbe> {
    if (o.helper === null) return { available: false, reason: "unavailable" };
    const out = await runHelper(o.helper, "--probe", undefined, PROBE_DEADLINE_MS);
    if (out.kind !== "reply" || out.value.v !== 1 || out.value.available !== true) return { available: false, reason: "unavailable" };
    const m = out.value.method;
    return typeof m === "string" && /^[a-z0-9][a-z0-9-]{0,31}$/.test(m) ? { available: true, method: m } : { available: false, reason: "unavailable" };
  }

  return { attest, probe };
}
