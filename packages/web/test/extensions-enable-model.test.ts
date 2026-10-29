/** Enabling a bundle requires the complete installed children, never only inert wrapper capabilities. */
import assert from "node:assert/strict";
import test from "node:test";
import type { ExtDetail } from "../src/pages/common/surfaces-rpc.ts";
import { enableConsentIdentity, enableConsentReady, enableParameters } from "../src/pages/extensions/enable-model.ts";

type BundleDetail = ExtDetail;
function fixture(): BundleDetail {
  const member = {
    name: "child",
    kind: "skill" as const,
    version: "1.0.0",
    sha256: "a".repeat(64),
    optional: false,
    enabled: false,
    agents: "all" as const,
  };
  return {
    item: {
      name: "bundle",
      id: "test/bundle",
      kind: "bundle",
      version: "1.0.0",
      source: "file",
      trust: "release",
      state: "installed",
      overlays: [],
      enabled: false,
      agents: "all",
      members: [member],
    },
    manifest: { kind: "bundle" },
    capabilities: {},
    scripts: [],
    trust: { tier: "release" },
    files: { count: 1, bytes: 1 },
    dependents: [],
    trash: [],
    members: [member],
    consentSha256: "c".repeat(64),
    memberInspections: [
      {
        name: member.name,
        kind: member.kind,
        version: member.version,
        sha256: member.sha256,
        optional: member.optional,
        manifest: { id: "test/child", kind: "skill", version: "1.0.0" },
        trust: { tier: "unsigned" },
        capabilities: { processes: { spawn: true, commands: ["run"] } },
        scripts: [],
        requires: {},
        checks: [{ id: "integrity", status: "pass", detail: "verified" }],
      },
    ],
  };
}
test("bundle enable fails closed without exact installed member disclosures", () => {
  const detail = fixture();
  assert.equal(enableConsentReady(detail), true);
  for (const change of [
    (value: BundleDetail) => {
      delete value.consentSha256;
    },
    (value: BundleDetail) => {
      value.consentSha256 = "malformed";
    },
    (value: BundleDetail) => {
      delete value.memberInspections;
    },
    (value: BundleDetail) => {
      value.memberInspections = [];
    },
    (value: BundleDetail) => {
      value.memberInspections![0]!.sha256 = "b".repeat(64);
    },
    (value: BundleDetail) => {
      value.memberInspections![0]!.optional = true;
    },
    (value: BundleDetail) => {
      value.memberInspections![0]!.version = "2.0.0";
    },
    (value: BundleDetail) => {
      value.memberInspections!.push(structuredClone(value.memberInspections![0]!));
    },
    (value: BundleDetail) => {
      value.memberInspections![0]!.checks[0]!.status = "fail";
    },
  ]) {
    const changed = structuredClone(detail);
    change(changed);
    assert.equal(enableConsentReady(changed), false);
  }
});
test("fresh enable comparison binds child rights, trust, script metadata and digest", () => {
  const detail = fixture(),
    identity = enableConsentIdentity(detail);
  for (const change of [
    (value: BundleDetail) => {
      value.consentSha256 = "d".repeat(64);
    },
    (value: BundleDetail) => {
      value.memberInspections![0]!.capabilities = { network: "any" };
    },
    (value: BundleDetail) => {
      value.memberInspections![0]!.trust = { tier: "unknown-signer", keyId: "new" };
    },
    (value: BundleDetail) => {
      value.memberInspections![0]!.scripts = [{ path: "run", size: 1, firstLine: "#!/bin/sh" }];
    },
    (value: BundleDetail) => {
      value.memberInspections![0]!.sha256 = "b".repeat(64);
    },
    (value: BundleDetail) => {
      value.members = [];
    },
  ]) {
    const changed = structuredClone(detail);
    change(changed);
    assert.notEqual(enableConsentIdentity(changed), identity);
  }
  assert.equal(enableConsentIdentity(structuredClone(detail)), identity);
  const ordinary = { ...detail, item: { ...detail.item, kind: "skill" as const } };
  delete ordinary.memberInspections;
  assert.equal(enableConsentReady(ordinary), true);
});
test("bundle activation sends the exact consent subject as an atomic native precondition", () => {
  const detail = fixture();
  assert.deepEqual(enableParameters(detail, ["main"]), {
    name: "bundle",
    acknowledge: ["capabilities"],
    agents: ["main"],
    expectedConsentSha256: detail.consentSha256,
  });
  delete detail.consentSha256;
  assert.throws(() => enableParameters(detail));
  detail.item.kind = "skill";
  assert.deepEqual(enableParameters(detail), { name: "bundle", acknowledge: ["capabilities"] });
});
