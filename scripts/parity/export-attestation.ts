// Parity vectors (mode V) for the core side of OS attestation (P4-K K2, plan P4-21): `createAttestationService` driven
// against the scripted stand-in helper of the TypeScript tests (`test/attestation/fixtures/scripted-attest.mjs`, a real
// process), with a fixed clock and scripted nonces; every step records the result and the audit lines. The replay in
// `crates/plur1bus-core/src/attestation/vectors.rs` answers each request from the same template (the double fills
// `$nonce` and `$hash` from the request the Rust service built). Recorded, never edited by hand.
//
// Not in the vectors: the process and file work of `helper.ts` (spawn, deadline kill, the descriptor-bound hash, the
// signature checks), which belongs to the production helper host of the flip, and `helperFromEnv`, whose answer depends on
// real file owners and modes (Rust tests with a probe double cover it).
//
//   node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning scripts/parity/export-attestation.ts [--check]
import { fileURLToPath } from "node:url";
import { createAttestationService, type AttestInput } from "../../packages/core/src/attestation/index.ts";
import type { PolicyAuditAction, PolicyAuditFields } from "../../packages/core/src/policy/audit.ts";
import { scriptedHelper } from "../../packages/core/test/attestation/fixtures/scripted-pinned.ts";
import { exporterMain } from "./lib.mjs";

const NOW = Date.UTC(2026, 10, 18, 6, 0, 0);
const HASH = "ab".padEnd(64, "0");
const OK = { v: 1, ok: true, nonce: "$nonce", actionHash: "$hash", method: "touch-id", at: NOW };
const input: AttestInput = { actionHash: HASH, text: "Allow agent bernd to run shell.exec for this session", person: "christian" };

type Scenario = { name: string; template: Record<string, unknown> | null; steps: AttestInput[]; probe?: boolean };
const one = (name: string, template: Record<string, unknown>, step: AttestInput = input): Scenario => ({ name, template, steps: [step] });
const SCENARIOS: Scenario[] = [
  one("confirmed", OK),
  one("at-before-issue-minus-skew", { ...OK, at: NOW - 2001 }), one("at-at-issue-minus-skew", { ...OK, at: NOW - 2000 }),
  one("at-at-now-plus-skew", { ...OK, at: NOW + 2000 }), one("at-after-now-plus-skew", { ...OK, at: NOW + 2001 }),
  one("at-string", { ...OK, at: String(NOW) }), one("at-missing", { ...OK, $omit: ["at"] }), one("at-fraction", { ...OK, at: NOW + 0.5 }),
  one("method-upper", { ...OK, method: "Touch-ID" }), one("method-empty", { ...OK, method: "" }), one("method-32", { ...OK, method: "a".repeat(32) }),
  one("method-33", { ...OK, method: "a".repeat(33) }), one("method-dash-first", { ...OK, method: "-x" }), one("method-number", { ...OK, method: 7 }),
  one("nonce-other", { ...OK, nonce: "other" }), one("nonce-missing", { ...OK, $omit: ["nonce"] }), one("nonce-number", { ...OK, nonce: 5 }),
  one("cancelled", { v: 1, ok: false, reason: "cancelled", nonce: "$nonce" }), one("unavailable", { v: 1, ok: false, reason: "unavailable", nonce: "$nonce" }),
  one("timeout", { v: 1, ok: false, reason: "timeout" }), one("other-reason", { v: 1, ok: false, reason: "boom", nonce: "$nonce" }),
  one("ok-string", { ...OK, ok: "true" }), one("not-ok-other-nonce", { v: 1, ok: false, reason: "cancelled", nonce: "zzz" }),
  one("version-2", { ...OK, v: 2 }), one("version-string", { ...OK, v: "1" }), one("version-missing", { ...OK, $omit: ["v"] }),
  one("hash-other", { ...OK, actionHash: "cd".padEnd(64, "0") }), one("hash-missing", { ...OK, $omit: ["actionHash"] }),
  { name: "replay", template: { ...OK, nonce: "n1" }, steps: [input, input, input] },
  one("audit-fields", OK, { ...input, person: "", requestId: "r1", agentId: "bernd", scope: "session" }),
  { name: "no-helper", template: null, steps: [input] },
  { name: "probe-default", template: OK, steps: [], probe: true },
  { name: "probe-unavailable", template: { ...OK, $probe: { v: 1, available: false } }, steps: [], probe: true },
  { name: "probe-bad-method", template: { ...OK, $probe: { v: 1, available: true, method: "Bad" } }, steps: [], probe: true },
  { name: "probe-version", template: { ...OK, $probe: { v: 2, available: true, method: "polkit" } }, steps: [], probe: true },
  { name: "probe-ok", template: { ...OK, $probe: { v: 1, available: true, method: "windows-hello" } }, steps: [], probe: true },
];

async function scenario(sc: Scenario) {
  const audit: { action: PolicyAuditAction; fields: PolicyAuditFields }[] = [];
  let n = 0;
  const svc = createAttestationService({
    helper: sc.template === null ? null : scriptedHelper(sc.template),
    audit: { record: (action, fields) => { audit.push({ action, fields: { ...fields } }); } },
    now: () => NOW,
    newNonce: () => `n${++n}`,
  });
  const steps: unknown[] = [];
  for (const step of sc.steps) {
    audit.length = 0;
    const result = await svc.attest(step);
    steps.push({ input: step, result, audit: [...audit] });
  }
  const probe = sc.probe ? await svc.probe() : undefined;
  return { name: sc.name, template: sc.template, now: NOW, steps, ...(probe ? { probe } : {}) };
}

export async function buildAttestationVectors() {
  const service: unknown[] = [];
  for (const sc of SCENARIOS) service.push(await scenario(sc));
  return { service };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await exporterMain({ area: "attestation", build: buildAttestationVectors });
}
