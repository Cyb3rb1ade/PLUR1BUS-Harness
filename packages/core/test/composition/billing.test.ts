import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { billingClassOf } from "../../src/composition/auth.ts";
import type { BillingClass } from "../../src/composition/provider.ts";

type Input = Parameters<typeof billingClassOf>[0];
const def = (profile: Record<string, unknown> | undefined, billingPath?: string): Input => ({ profile: profile as unknown as Input["profile"], ...(billingPath === undefined ? {} : { billingPath }) });

describe("composition billingClassOf (ADR-005: plan vs paid)", () => {
  // The documented vocabulary (comment on ProviderDefinition + docs/architecture/turn-pipeline.md): plan/paid come from the
  // explicit billing path first, then from the credential kind. Keys and ADC are metered, interactive logins are a plan.
  const explicit: [string, BillingClass][] = [
    ["chatgpt_plan", "plan"], ["cli_login", "plan"], ["plan", "plan"],
    ["api_key", "paid"], ["workload", "paid"], ["paid", "paid"],
  ];
  for (const [path, cls] of explicit) it(`explicit billingPath ${path} -> ${cls}`, () => assert.equal(billingClassOf(def({ kind: "api_key" }, path)), cls));

  it("an explicit billingPath beats the credential kind in both directions", () => {
    assert.equal(billingClassOf(def({ kind: "api_key" }, "plan")), "plan");
    assert.equal(billingClassOf(def({ kind: "oauth_pkce" }, "paid")), "paid");
  });

  it("profile.billing_path is used when the definition has no billingPath, and the definition wins when both exist", () => {
    assert.equal(billingClassOf(def({ kind: "api_key", billing_path: "plan" })), "plan");
    assert.equal(billingClassOf(def({ kind: "oauth_pkce", billing_path: "api_key" })), "paid");
    assert.equal(billingClassOf(def({ kind: "api_key", billing_path: "plan" }, "paid")), "paid");
  });

  const byKind: [string, BillingClass][] = [
    ["api_key", "paid"], ["adc", "paid"], ["federated_token", "paid"],
    ["oauth_pkce", "plan"], ["device_code", "plan"], ["external_cli", "plan"],
  ];
  for (const [kind, cls] of byKind) it(`credential kind ${kind} -> ${cls}`, () => assert.equal(billingClassOf(def({ kind })), cls));

  it("dynamic_on_authorize registration is always a plan, even with a stale paid label or a key kind", () => {
    assert.equal(billingClassOf(def({ kind: "api_key", client_registration: "dynamic_on_authorize" }, "paid")), "plan");
    assert.equal(billingClassOf(def({ kind: "federated_token", client_registration: "dynamic_on_authorize", billing_path: "api_key" })), "plan");
  });

  it("other client registrations do not force a class", () => {
    for (const reg of ["none", "static", "dynamic"]) assert.equal(billingClassOf(def({ kind: "api_key", client_registration: reg })), "paid");
  });

  // billingClassOf answers "unknown" (undefined) and never guesses: an unknown explicit path does NOT fall back to the
  // credential kind. composeAuth turns "unknown" into a refusal at load (fail closed, auth.test.ts > fail closed: ...).
  it("an unknown explicit billing path is unknown (undefined), never a fallback to the kind", () => {
    assert.equal(billingClassOf(def({ kind: "api_key" }, "enterprise")), undefined);
    assert.equal(billingClassOf(def({ kind: "api_key" }, "")), undefined);
    assert.equal(billingClassOf(def({ kind: "api_key" }, "PLAN")), undefined, "case-sensitive");
  });

  it("an unknown credential kind and a missing profile are unknown (undefined)", () => {
    assert.equal(billingClassOf(def({ kind: "mystery" })), undefined);
    assert.equal(billingClassOf(def({})), undefined);
    assert.equal(billingClassOf(def(undefined)), undefined);
  });
});
