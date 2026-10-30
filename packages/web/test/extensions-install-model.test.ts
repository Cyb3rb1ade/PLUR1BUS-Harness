import test from "node:test";
import assert from "node:assert/strict";
import type { ExtInspection } from "../src/pages/common/surfaces-rpc.ts";
import {
  installationRequirements,
  installationParams,
  installationButton,
} from "../src/pages/extensions/install-model.ts";

const fixture = (tier: ExtInspection["trust"]["tier"]): ExtInspection => ({
  inspectionId: "i",
  expiresAt: "2099-01-01T00:00:00Z",
  sha256: "a".repeat(64),
  manifest: { id: "test/package", version: "1.0.0", kind: "skill" },
  trust: { tier },
  checks: [{ id: "signature", status: "pass", detail: "checked" }],
  capabilities: { network: "none" },
  scripts: [],
  requires: {},
});
test("unsigned, unknown-signer and replacement disclosures require their own explicit acknowledgements", () => {
  const inspected = fixture("unsigned");
  assert.equal(installationButton(inspected), "extensions.install.unsigned");
  assert.throws(() => installationParams(inspected, { capabilities: true, trust: false, replacement: false }));
  assert.deepEqual(installationParams(inspected, { capabilities: true, trust: true, replacement: false }), {
    inspectionId: "i",
    acknowledge: ["capabilities", "unsigned"],
  });
  inspected.trust.tier = "unknown-signer";
  inspected.replaces = { version: "2.0.0", capabilityDiff: { changed: ["network"] } };
  assert.equal(installationButton(inspected), "extensions.install.unknownSigner");
  assert.throws(() => installationParams(inspected, { capabilities: true, trust: true, replacement: false }));
  assert.deepEqual(installationParams(inspected, { capabilities: true, trust: true, replacement: true }, ["main"]), {
    inspectionId: "i",
    acknowledge: ["capabilities", "unknown-signer", "downgrade"],
    enable: { agents: ["main"] },
  });
});
test("first-party install has automatic activation notice and no separate activation choice", () => {
  const inspected = fixture("first-party");
  assert.equal(installationRequirements(inspected).firstParty, true);
  assert.equal(installationButton(inspected), "extensions.install.normal");
  assert.throws(() => installationParams(inspected, { capabilities: true, trust: false, replacement: false }, "all"));
  assert.deepEqual(installationParams(inspected, { capabilities: true, trust: false, replacement: false }), {
    inspectionId: "i",
    acknowledge: ["capabilities"],
  });
});
test("failed checks, missing rights consent and empty agent selection block mutation", () => {
  const inspected = fixture("release");
  assert.throws(() => installationParams(inspected, { capabilities: false, trust: false, replacement: false }));
  assert.throws(() => installationParams(inspected, { capabilities: true, trust: false, replacement: false }, []));
  inspected.checks[0]!.status = "fail";
  assert.throws(() => installationParams(inspected, { capabilities: true, trust: false, replacement: false }));
});

test("bundle selection is explicit, retains every required member and unions only selected member trust/replacement consent", () => {
  const bundle = fixture("release");
  bundle.manifest = { id: "test/bundle", kind: "bundle", version: "1.0.0" };
  const child = (
    name: string,
    tier: ExtInspection["trust"]["tier"],
    optional: boolean,
  ): NonNullable<ExtInspection["members"]>[number] => {
    const { inspectionId: _id, expiresAt: _expiry, ...disclosure } = fixture(tier);
    return { ...disclosure, name, kind: "skill", version: "1.0.0", optional };
  };
  bundle.members = [
    child("required", "release", false),
    child("optional", "unsigned", true),
    {
      ...child("replacement", "unknown-signer", true),
      replaces: { version: "2.0.0", capabilityDiff: { changed: ["network"] } },
    },
  ];
  const accepted = { capabilities: true, trust: false, replacement: false };
  assert.throws(() => installationParams(bundle, accepted));
  assert.deepEqual(installationParams(bundle, accepted, undefined, ["required"]), {
    inspectionId: "i",
    acknowledge: ["capabilities"],
    members: ["required"],
  });
  for (const selection of [[], ["optional"], ["required", "unknown"], ["required", "required"]])
    assert.throws(() => installationParams(bundle, accepted, undefined, selection));
  assert.throws(() => installationParams(bundle, accepted, undefined, ["required", "optional"]));
  assert.deepEqual(
    installationParams(bundle, { capabilities: true, trust: true, replacement: true }, "all", [
      "required",
      "optional",
      "replacement",
    ]),
    {
      inspectionId: "i",
      acknowledge: ["capabilities", "unsigned", "unknown-signer", "downgrade"],
      enable: { agents: "all" },
      members: ["required", "optional", "replacement"],
    },
  );
  bundle.trust.tier = "first-party";
  assert.throws(() => installationParams(bundle, accepted, undefined, ["required", "optional"]));
  assert.deepEqual(
    installationParams(bundle, { ...accepted, trust: true }, undefined, ["required", "optional"]).acknowledge,
    ["capabilities", "unsigned"],
  );
});
