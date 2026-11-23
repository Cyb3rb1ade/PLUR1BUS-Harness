import { buildCodingCheckVectors } from "./export-coding-checks.ts";
import { buildChatPromotionVectors } from "./export-chat-promotion.ts";
import { buildCodingGitViewVectors } from "./export-coding-git-view.ts";
import { buildCodingSessionVectors } from "./export-coding-sessions.ts";
import { buildCodingRootVectors } from "./export-coding-root.ts";
import { buildCodingRunnerVectors } from "./export-coding-runner.ts";
import { buildCodingVerifierVectors } from "./export-coding-verifier.ts";
import { buildCodingSurfaceVectors } from "./export-coding-surface.ts";
import { buildCodingGateVectors } from "./export-coding-gate.ts";
import { buildCollabRunVectors } from "./export-collab-run.ts";
import { buildCollabDelegationVectors } from "./export-collab-delegations.ts";
import { buildCollabServiceVectors } from "./export-collab-service.ts";
import { buildCollabHandoffVectors } from "./export-collab-handoff.ts";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXTURE_ROOT, exporterMain, fixtureText, fixturePath, writeFixture } from "./lib.mjs";
import { buildDispatcherVectors } from "./export-dispatcher.ts";
import { buildWireFixtures } from "./export-wire.ts";
import { buildProviderFixtures } from "./export-providers.ts";
import { buildChannelFixtures } from "./export-channels.ts";
import { buildVoiceFixtures } from "./export-voice.ts";
import { buildLocalProbeFixtures, buildLocalProviderFixtures } from "./export-provider-local.ts";
import { buildProviderCacheFixtures } from "./export-provider-cache.ts";
import { buildProviderRouterFixtures } from "./export-provider-router.ts";
import { buildFormatVectors } from "./export-formats.ts";
import { buildAuthVectors, credentials, substitute } from "./export-auth.ts";
import { buildConfigVectors } from "./export-config.ts";
import { buildEndpointVectors } from "./export-endpoint.ts";
import { buildLogsVectors } from "./export-logs.ts";
import { buildDoctorVectors } from "./export-doctor.ts";
import { buildMetricsVectors } from "./export-metrics.ts";
import { buildRbacVectors } from "./export-rbac.ts";
import { buildJsVectors } from "./export-js.ts";
import { buildExposureVectors } from "./export-exposure.ts";
import { buildIdentityVectors } from "./export-identity.ts";
import { randomBytes } from "node:crypto";
import { buildIdentityStoreVectors } from "./export-identity-store.ts";
import { buildIdentityAdminVectors } from "./export-identity-admin.ts";
import { buildRbacGuardVectors } from "./export-rbac-guard.ts";
import { buildSensitivityVectors } from "./export-sensitivity.ts";
import { buildSecretsVectors } from "./export-secrets.ts";
import { buildAcpVectors } from "./export-acp.ts";
import { buildSecretsStoreVectors } from "./export-secrets-store.ts";
import { buildBudgetVectors } from "./export-budget.ts";
import { buildHandoffVectors } from "./export-handoff.ts";
import { buildDeliveryVectors } from "./export-delivery.ts";
import { buildInboxVectors } from "./export-inbox.ts";
import { buildJobsVectors } from "./export-jobs.ts";
import { buildEgressVectors } from "./export-egress.ts";
import { buildPolicyVectors } from "./export-policy.ts";
import { buildAttestationVectors } from "./export-attestation.ts";
import { buildApprovalsVectors } from "./export-approvals.ts";
import { RECORDED_ON as POLICY_FS_OS, buildPolicyFsVectors } from "./export-policy-fs.ts";
import { RECORDED_ON as TOOLS_OS, buildToolsPureVectors, buildToolsRecordedVectors } from "./export-tools.ts";
import { buildProviderAuthVectors } from "./export-provider-auth.ts";
import { buildOpenAIAuthVectors } from "./export-openai-auth.ts";
import { buildSessionVectors } from "./export-sessions.ts";
import { buildCollabVectors } from "./export-collab.ts";
import { buildMaintenanceVectors } from "./export-session-maintenance.ts";
import { buildRewindVectors } from "./export-session-rewind.ts";
import { buildPromptVectors } from "./export-prompt.ts";
import { buildTriageVectors } from "./export-triage.ts";
import { buildDecisionVectors } from "./export-decision.ts";
import { buildToolcallVectors } from "./export-toolcall.ts";
import { buildSkillTools } from "./export-skill-tools.ts";
import { buildLiveIndex } from "./export-live-index.ts";
import { buildModelToolError } from "./export-model-tool-error.ts";
import { buildCapabilityVectors, fdlibmLog, logArguments } from "./export-capabilities.ts";
import { POLICY } from "../../packages/core/src/rbac/policy.ts";
import { canonicalJson } from "../../packages/core/src/tools/dispatcher.ts";

describe("parity fixture writer (mode V)", () => {
  it("writes sorted keys at every depth, two-space indent and one trailing newline", () => {
    assert.equal(fixtureText({ b: [{ z: 1, a: 2 }], a: null }), '{\n  "a": null,\n  "b": [\n    {\n      "a": 2,\n      "z": 1\n    }\n  ]\n}\n');
  });

  it("is deterministic: the same data in another key order gives the same bytes, and a second write changes nothing", () => {
    const root = mkdtempSync(join(tmpdir(), "p1b-parity-fx-"));
    try {
      const first = writeFixture("demo", "one", { x: 1, y: { b: 1, a: 2 } }, { root });
      assert.equal(first.changed, true);
      const bytes = readFileSync(first.path, "utf8");
      const second = writeFixture("demo", "one", { y: { a: 2, b: 1 }, x: 1 }, { root });
      assert.equal(second.changed, false);
      assert.equal(readFileSync(second.path, "utf8"), bytes);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("--check writes nothing and reports a missing or hand-edited fixture", async () => {
    const root = mkdtempSync(join(tmpdir(), "p1b-parity-fx-"));
    const lines: string[] = [];
    try {
      const build = async () => ({ one: { v: 1 } });
      assert.equal(await exporterMain({ area: "demo", build, argv: ["--check"], root, log: (l: string) => lines.push(l) }), 1, "missing file is stale");
      assert.throws(() => readFileSync(fixturePath("demo", "one", root)), /ENOENT/);
      assert.equal(await exporterMain({ area: "demo", build, argv: [], root, log: () => {} }), 0);
      assert.equal(await exporterMain({ area: "demo", build, argv: ["--check"], root, log: () => {} }), 0);
      writeFileSync(fixturePath("demo", "one", root), '{"v":1}\n');
      assert.equal(await exporterMain({ area: "demo", build, argv: ["--check"], root, log: (l: string) => lines.push(l) }), 1, "hand edit is stale");
      assert.match(lines.join("\n"), /never edit them by hand/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects an area or name that could leave the fixture root", () => {
    assert.throws(() => fixturePath("../x", "a"), /parity area/);
    assert.throws(() => fixturePath("a", "A b"), /fixture name/);
  });
});

describe("dispatcher vectors (D120 T1 parity vectors)", () => {
  it("the committed fixtures are exactly what the exporter records", async () => {
    const built = await buildDispatcherVectors();
    for (const [name, data] of Object.entries(built)) {
      assert.equal(readFileSync(fixturePath("dispatcher", name), "utf8"), fixtureText(data), `fixtures/parity/dispatcher/${name}.json is stale: run scripts/parity/export-dispatcher.ts`);
    }
    assert.ok(FIXTURE_ROOT.endsWith("fixtures/parity/"));
  });

  it("canonical JSON: every expected string is what canonicalJson returns for the parsed input", async () => {
    const { "canonical-json": v } = await buildDispatcherVectors() as any;
    assert.ok(v.cases.length >= 20);
    for (const c of v.cases) assert.equal(canonicalJson(JSON.parse(c.inputJson)), c.canonical, c.name);
    const names = v.cases.map((c: any) => c.name);
    for (const must of ["astral-vs-bmp-key-order", "integer-above-2-pow-53", "negative-zero", "exponent-forms", "control-characters"]) assert.ok(names.includes(must), must);
    const astral = v.cases.find((c: any) => c.name === "astral-vs-bmp-key-order");
    assert.ok(astral.canonical.indexOf("\u{1F600}") < astral.canonical.indexOf("～"), "UTF-16 order puts the emoji before U+FF5E; UTF-8 byte order does not");
  });

  it("action hash: produced by the real dispatcher, stable across key order, bound to every input", async () => {
    const { "action-hash": v } = await buildDispatcherVectors() as any;
    assert.ok(v.cases.length >= 8);
    for (const c of v.cases) assert.match(c.actionHash, /^[0-9a-f]{64}$/, c.name);
    const byName = Object.fromEntries(v.cases.map((c: any) => [c.name, c.actionHash]));
    assert.equal(byName["args-key-order-a"], byName["args-key-order-b"]);
    assert.notEqual(byName["args-key-order-a"], byName["args-value-differs"]);
    assert.notEqual(byName["plain"], byName["with-targets"]);
    assert.notEqual(byName["plain"], byName["with-hash-extra"]);
    assert.equal(byName["empty-targets"], byName["plain"], "absent targets hash as []");
    assert.notEqual(byName["with-targets"], byName["targets-order-differs"]);
    assert.notEqual(byName["plain"], byName["tool-name-differs"]);
    assert.equal(new Set(v.cases.map((c: any) => c.actionHash)).size, v.cases.length - 2, "exactly two pairs share a hash: the key-order variants and absent/empty targets");
  });
});

describe("wire fixtures (mode W, P4-03)", () => {
  it("the committed fixtures are exactly what the exporter records, and no minted secret survives", async () => {
    const built = await buildWireFixtures();
    assert.deepEqual(Object.keys(built).sort(), ["openai-http", "openai-sse", "voice-ws", "voice-ws-server-first"]);
    for (const [name, data] of Object.entries(built)) {
      const text = readFileSync(fixturePath("wire", name), "utf8");
      assert.equal(text, fixtureText(data), `fixtures/parity/wire/${name}.json is stale: run scripts/parity/export-wire.ts`);
      // The fake's client-id prefix is assembled the way the fake assembles it, so no credential-like literal sits here.
      assert.ok(!text.includes(["oai", "app_"].join("")), `${name}: a minted client id`);
      assert.doesNotMatch(text, /_token":\s*"(?!\[REDACTED)/, `${name}: an unredacted token value`);
    }
  });
});

describe("cloud voice wire fixtures (W3)", () => {
  it("commits each recording with credential placeholders", async () => {
    for (const [name, data] of Object.entries(await buildVoiceFixtures())) {
      const text = readFileSync(fixturePath("voice", name), "utf8");
      assert.equal(text, fixtureText(data), `voice/${name}: committed recording is stale`);
      assert.doesNotMatch(text, /synthetic-voice-credential/);
    }
  });
});

describe("channel wire fixtures (W2)", () => {
  it("commits every recorded exchange with credential placeholders", async () => {
    const recordings = await buildChannelFixtures();
    assert.equal(Object.keys(recordings).length, 16);
    for (const [name, data] of Object.entries(recordings)) {
      const text = readFileSync(fixturePath("channels", name), "utf8");
      assert.equal(text, fixtureText(data), `channels/${name}: committed recording is stale`);
      assert.doesNotMatch(text, /synthetic-(?:telegram|discord(?:-interaction)?|slack(?:-app)?|mail|relay)-marker/);
    }
  });
});

describe("provider wire fixtures (P4-41)", () => {
  function assertRecorded(area: string, built: Record<string, unknown>, count: number): void {
    assert.equal(Object.keys(built).length, count);
    for (const [name, data] of Object.entries(built)) {
      const text = readFileSync(fixturePath(area, name), "utf8");
      assert.equal(text, fixtureText(data), `${area}/${name}: committed recording is stale`);
      assert.doesNotMatch(text, /fixture-credential/, `${area}/${name}: unredacted credential`);
    }
  }

  it("records each vendor and its bodyless cases", async () => {
    assertRecorded("providers", await buildProviderFixtures(), 8);
  });

  it("records keyless local model probing over HTTP", async () => {
    assertRecorded("provider-local", await buildLocalProbeFixtures(), 1);
  });

  it("records AF1 over Unix HTTP", { skip: process.platform === "win32" }, async () => {
    assertRecorded("provider-local", await buildLocalProviderFixtures(), 1);
  });

  it("records cache emission, routing and reasoning", async () => {
    assertRecorded("provider-cache", buildProviderCacheFixtures(), 1);
    assertRecorded("provider-router", await buildProviderRouterFixtures(), 2);
  });
});

describe("format vectors (P4-03 review F6)", () => {
  it("the committed fixtures are exactly what ajv-formats says today, with valid and invalid probes per format", async () => {
    const built = await buildFormatVectors();
    for (const [name, data] of Object.entries(built)) {
      assert.equal(readFileSync(fixturePath("formats", name), "utf8"), fixtureText(data), `fixtures/parity/formats/${name}.json is stale: run scripts/parity/export-formats.ts`);
    }
    const cases = (built["ajv-formats"] as any).cases as Array<{ format: string; valid: boolean }>;
    for (const format of ["date", "date-time", "uri", "uuid"]) {
      assert.ok(cases.some((c) => c.format === format && c.valid), `${format}: a valid probe`);
      assert.ok(cases.some((c) => c.format === format && !c.valid), `${format}: an invalid probe`);
    }
  });
});

describe("auth vectors (P4-10 task review L9)", () => {
  it("the committed fixture is exactly what the exporter records, and holds markers, never a credential", async () => {
    const built = await buildAuthVectors();
    for (const [name, data] of Object.entries(built)) {
      const text = readFileSync(fixturePath("auth", name), "utf8");
      assert.equal(text, fixtureText(data), `fixtures/parity/auth/${name}.json is stale: run scripts/parity/export-auth.ts`);
      // The only long hex runs are the length probes (one repeated letter, e.g. a 256-character userId).
      const runs = text.match(/[0-9a-f]{64,}/gi) ?? [];
      assert.ok(runs.every((r) => new Set(r.toLowerCase()).size === 1), "no credential-like value is recorded");
    }
  });

  it("pins module-api's String() coercion of role and kind (P4D-8) and nothing more", async () => {
    const v = (await buildAuthVectors())["module-api"] as any;
    const noted = v["api-delegation"].filter((c: any) => c.note?.startsWith("P4D-8"));
    assert.deepEqual(noted.map((c: any) => c.name), ["principal-role-in-an-array", "principal-kind-in-an-array", "principal-role-in-nested-arrays"]);
    for (const c of noted) assert.equal(c.valid, true, c.name);
    const twoRoles = v["api-delegation"].find((c: any) => c.name === "principal-role-two-element-array");
    assert.equal(twoRoles.valid, false, "String([a, b]) is \"a,b\": refused on both sides");
    for (const section of ["api-delegation", "engine-delegation", "adoption-nonce"]) assert.ok(v[section].length >= 10, section);
  });

  it("records module-api's request-id rule: integers as JSON.parse reads them, strings, nothing else (fix round 1b F8)", async () => {
    const v = (await buildAuthVectors())["module-api"] as any;
    const valid = (idJson: string) => v["request-id"].find((c: any) => c.idJson === idJson)?.valid;
    for (const id of ["1", "-0", "1.0", "1e3", "\"a\""]) assert.equal(valid(id), true, id);
    for (const id of ["1.5", "1e400", "null", "true", "{}", "[1]"]) assert.equal(valid(id), false, id);
    const infinity = v["request-id"].find((c: any) => c.idJson === "1e400");
    assert.equal(infinity.echoed, "null", "Infinity goes back as null");
    assert.match(v["request-id"].find((c: any) => c.idJson === "{}").detail, /^\/id /);
  });

  it("puts a fresh value in place of every marker", () => {
    const values = credentials();
    const text = substitute('{"a":"@api@","b":"@API@","c":"@other@"}', values);
    assert.doesNotMatch(text, /@[a-zA-Z]+@/);
    const parsed = JSON.parse(text);
    assert.equal(parsed.b, parsed.a.toUpperCase());
    assert.notEqual(parsed.a, parsed.c);
    assert.notEqual(credentials()["@api@"], values["@api@"], "fresh on every run");
  });
});

describe("logs vectors (P4-11 tasks 1 to 3)", () => {
  it("the committed fixtures are exactly what the exporter records, and no credential is recorded in one piece", async () => {
    const built = await buildLogsVectors();
    assert.deepEqual(Object.keys(built).sort(), ["files", "levels", "lines", "methods", "output", "query", "records", "redact", "secret-matcher", "trace"]);
    for (const [name, data] of Object.entries(built)) {
      const text = readFileSync(fixturePath("logs", name), "utf8");
      assert.equal(text, fixtureText(data), `fixtures/parity/logs/${name}.json is stale: run scripts/parity/export-logs.ts`);
      // The canaries of the TypeScript tests are stored as the fragments the tests assemble them from (`{ parts }`).
      assert.doesNotMatch(text, /sk-[A-Za-z0-9-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|xox[baprs]-[0-9A-Za-z-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.eyJ/);
    }
  });

  it("records every divergence between JavaScript and Rust with a note, and covers the cases of the TypeScript tests", async () => {
    const built = await buildLogsVectors() as any;
    const noted = built.redact.text.filter((c: any) => c.note).map((c: any) => c.name);
    for (const name of ["unicode-fold-kelvin-sign-in-a-header-name", "js-whitespace-bom-after-bearer", "js-whitespace-nel-after-bearer", "lone-surrogates-in-the-input-become-replacement-characters"])
      assert.ok(noted.includes(name), name);
    assert.ok(built.redact.value.some((c: any) => c.name === "secrets-only-repeated-key-numbering" && c.note), "the key order of a serde_json::Map is pinned");
    assert.ok(built.redact.maskJson.some((c: any) => c.loneSurrogate && c.note), "a JSON text with a lone surrogate escape is pinned");
    assert.ok(built.redact.text.length > 80 && built.redact.value.length >= 10 && built["secret-matcher"].text.length >= 15);
    // Task 3: the log query and the handlers.
    assert.ok(built.query.scans.length >= 60 && built.query.fingerprint.length > 0 && built.query.mint.length > 0 && built.query.decode.length > 0);
    assert.ok(built.methods.query.length > 0 && built.methods.levels.length > 0 && Object.keys(built.methods.time).length > 0);
    assert.ok(built.query.scans.some((c: any) => c.name === "a-budget-smaller-than-the-first-read"));
    // The residual case (a registered value held by a number) must throw, not mask.
    assert.equal(built.redact.maskJson.find((c: any) => c.name === "number-holds-the-secret").result, "error");
  });

  it("pins the write path: attribute-order differences carry a note and the canonical Rust line, and the cases of the TypeScript tests are covered", async () => {
    const built = await buildLogsVectors() as any;
    const cases = new Map<string, any>(built.records.cases.map((c: any) => [c.name, c]));
    for (const name of ["attributes-in-caller-order", "legacy-line-field-order", "oversized-text-is-cut", "level-change-records", "rate-limit-reports-drops"]) {
      assert.ok(cases.get(name)?.note, `${name} differs from the Rust bytes in attribute order and says so`);
      assert.equal(cases.get(name).canonical.length, cases.get(name).lines.length);
    }
    for (const name of ["started-record", "dedup-then-summary", "legacy-too-long-is-summarised", "legacy-message-cut"]) assert.equal(cases.get(name)?.note, undefined, `${name} is byte-identical`);
    assert.ok(built.levels.cases.length >= 8 && built.trace.parse.length >= 16 && built.output.sanitise.length >= 16 && built.files.cases.length >= 14 && built.lines.cases.length >= 9);
    assert.ok(built.lines.cases.find((c: any) => c.name === "stamped-lines").seek.length >= 13, "seekByTs binary search is exercised on a file above 64 KiB");
  });
});

describe("config vectors (P4-11 task 4a)", () => {
  it("the committed fixtures are exactly what the exporter records, and they cover every area", async () => {
    const built = await buildConfigVectors() as any;
    assert.deepEqual(Object.keys(built).sort(), ["disclosure", "engine", "patch", "validate", "warnings"]);
    for (const [name, data] of Object.entries(built)) {
      const text = readFileSync(fixturePath("config", name), "utf8");
      assert.equal(text, fixtureText(data), `fixtures/parity/config/${name}.json is stale: run scripts/parity/export-config.ts`);
      assert.doesNotMatch(text, /sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|xox[baprs]-[0-9A-Za-z-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.eyJ/);
    }
    assert.ok(built.validate.length >= 60 && built.warnings.some((c: any) => c.warnings.length === 50));
    assert.ok(built.engine.some((c: any) => c.ok) && built.engine.some((c: any) => !c.ok && c.error.reason === "local-only") && built.engine.some((c: any) => c.catalog));
    assert.ok(built.patch.some((c: any) => !c.ok) && built.disclosure.length >= 10);
  });
});

describe("endpoint vectors (the small URL reader of the Rust configuration policy)", () => {
  it("the committed fixture is exactly what Node's URL constructor reads today, with refused and accepted address spellings", async () => {
    const built = await buildEndpointVectors() as any;
    assert.deepEqual(Object.keys(built), ["url"]);
    assert.equal(readFileSync(fixturePath("endpoint", "url"), "utf8"), fixtureText(built.url), "fixtures/parity/endpoint/url.json is stale: run scripts/parity/export-endpoint.ts");
    const cases: Array<{ url: string; ok: boolean; hostname?: string }> = built.url.cases;
    const read = (url: string) => cases.find((c) => c.url === url);
    // A sign is no digit of an IPv4 part: the constructor refuses it before the last part and reads a domain when it is in the last.
    for (const url of ["https://+1.2.3.4/", "https://1.+2.3.4/", "https://%2b1.2.3.4/", "https://0x+7f.1/", "https://-1.2.3.4/"]) assert.equal(read(url)?.ok, false, url);
    assert.equal(read("https://1.2.3.+4/")?.hostname, "1.2.3.+4");
    assert.equal(read("https://0x7f.1/")?.hostname, "127.0.0.1");
    assert.ok(cases.filter((c) => !c.ok).length >= 100 && cases.filter((c) => c.ok).length >= 100);
  });
});

describe("metrics vectors (P4-11 task 5b)", () => {
  it("the committed fixtures are exactly what the exporter records, and they cover refusals, number printing and collation", async () => {
    const built = await buildMetricsVectors() as any;
    assert.deepEqual(Object.keys(built).sort(), ["metrics", "registry"]);
    for (const [name, data] of Object.entries(built)) {
      const text = readFileSync(fixturePath("metrics", name), "utf8");
      assert.equal(text, fixtureText(data), `fixtures/parity/metrics/${name}.json is stale: run scripts/parity/export-metrics.ts`);
      assert.doesNotMatch(text, /sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|xox[baprs]-[0-9A-Za-z-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.eyJ/);
    }
    const cases = new Map<string, any>(built.registry.cases.map((c: any) => [c.name, c]));
    assert.ok(built.registry.cases.length >= 25 && built.metrics.cases.length >= 15 && built.metrics.methods.length > 100);
    assert.ok(cases.get("number-formatting-of-gauge-values").results.at(-1).text.includes("1e+21"));
    assert.ok(cases.get("series-order-follows-icu-locale-compare").results.at(-1).text.includes("a_b"));
    assert.ok(cases.get("refusals-of-the-series-cap").results.some((r: any) => /maxSeries must be an integer/.test(r.error)));
    assert.ok(built.registry.cases.every((c: any) => c.results.length === c.ops.length));
  });
});

describe("doctor vectors (P4-11 task 6)", () => {
  it("the committed fixture is exactly what the exporter records, and it covers refusals, path cleaning and every platform", async () => {
    const built = await buildDoctorVectors() as any;
    assert.deepEqual(Object.keys(built), ["report"]);
    const text = readFileSync(fixturePath("doctor", "report"), "utf8");
    assert.equal(text, fixtureText(built.report), "fixtures/parity/doctor/report.json is stale: run scripts/parity/export-doctor.ts");
    assert.doesNotMatch(text, /sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|xox[baprs]-[0-9A-Za-z-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.eyJ/);
    const cases: any[] = built.report.cases;
    assert.ok(cases.length >= 100);
    assert.ok(cases.some((c) => c.expected.error?.reason === "firstaid-invalid") && cases.some((c) => c.expected.error?.reason === "firstaid-unavailable"));
    for (const platform of ["linux", "darwin", "win32"]) assert.ok(cases.some((c) => c.platform === platform && c.expected.ok));
    const paths = cases.find((c) => c.name === "path-cleaning-foreign-homes-and-mail");
    for (const leak of ["bob", "Carol", "anna", "dave"]) assert.equal(JSON.stringify(paths.expected).includes(leak), false, leak);
    assert.equal(process.env.HOME === "/fake-user", false, "the exporter restores HOME");
  });
});

describe("rbac vectors (P4-12 task 1, R10)", () => {
  it("the committed fixtures are exactly what the exporter records, and the grid covers every policy row", async () => {
    const built = await buildRbacVectors() as any;
    assert.deepEqual(Object.keys(built).sort(), ["break-glass", "cansee", "connection-surface", "grid-agent", "grid-memory-agent", "grid-project", "grid-system", "grid-user", "index", "odd-authorize", "policy", "scopes-object", "scopes-system", "surface-satisfies", "surface-trust"]);
    for (const [name, data] of Object.entries(built)) {
      const text = readFileSync(fixturePath("rbac", name), "utf8");
      assert.equal(text, fixtureText(data), `fixtures/parity/rbac/${name}.json is stale: run scripts/parity/export-rbac.ts`);
      assert.ok(text.length < 5_000_000, `${name}: a fixture file stays under about 5 MB (split it)`);
    }
    assert.equal(built.policy.rows.length, POLICY.length);
    assert.deepEqual(built.policy.actions, POLICY.map((s) => s.action));
    // Packed files: `{fields, tables, cases}`, one `name TAB in TAB expected` line per case.
    const lines = (n: string): string[] => built[n].cases;
    const grids = ["grid-agent", "grid-memory-agent", "grid-project", "grid-system", "grid-user"].flatMap(lines);
    const scopes = [...lines("scopes-system"), ...lines("scopes-object")];
    const glass = lines("break-glass");
    const ROLES = ["owner", "admin", "operator", "member", "viewer"];
    for (const spec of POLICY) for (const role of ROLES) {
      const head = `${spec.action} | ${role} | `;
      assert.ok(grids.some((c) => c.startsWith(head)), `${spec.action} x ${role} is in the grid`);
      // Every row is covered in a full-product class or by its smoke set: token scopes (exact, empty, star, other) ...
      for (const label of ["exact", "empty", "star", "other-action"])
        assert.ok(scopes.some((c) => c.startsWith(`${head}person | `) && c.split("\t")[0].endsWith(` | scopes ${label}`)), `${spec.action} x ${role}: scopes ${label}`);
      // ... and, for user and memory-user rows, break-glass (absent, valid, expired, other target).
      if (spec.resource === "user" || spec.resource === "memory-user")
        for (const label of ["absent", "valid", "expired-by-one", "other-target"])
          assert.ok(glass.some((c) => c.startsWith(`${head}person | own | glass ${label}\t`)), `${spec.action} x ${role}: glass ${label}`);
    }
    // Signature classes: every row in exactly one, the first row of each class runs the full product.
    const classes: { full: string; rows: string[] }[] = built.index.signatureClasses;
    assert.deepEqual(classes.flatMap((c) => c.rows).sort(), POLICY.map((s) => s.action).sort());
    for (const c of classes) {
      assert.equal(c.full, c.rows[0]);
      const ran = (action: string) => scopes.some((l) => l.startsWith(`${action} | owner | person | `) && l.split("\t")[0].endsWith(" | scopes upper-case"));
      assert.ok(ran(c.full), `${c.full}: full scope product`);
      for (const other of c.rows.slice(1)) assert.ok(!ran(other), `${other}: smoke set only`);
    }
    // The deny reasons the decision can end in are each pinned by at least one case.
    const decisionFiles = ["grid-agent", "grid-memory-agent", "grid-project", "grid-system", "grid-user", "scopes-system", "scopes-object", "break-glass", "odd-authorize"];
    const outcomes = decisionFiles.flatMap(lines).map((l) => l.split("\t")[2]!);
    const reasons = new Set(outcomes.map((o) => o.split("/")[1]).filter(Boolean));
    for (const r of ["unauthenticated", "invalid-principal", "unknown-action", "resource-mismatch", "token-scope", "role-denied", "not-owner", "object-right-required", "break-glass-required", "agent-principal", "role", "own", "object-right", "break-glass"])
      assert.ok(reasons.has(r), r);
    assert.ok(!reasons.has("audit-failed"), "audit-failed is the guard's reason, not authorize's (break-glass audit is T6)");
    assert.ok(outcomes.filter((o) => o.startsWith("throws/")).length >= 50);
    const total = Object.values(built.index.files as Record<string, number>).reduce((n, c) => n + c, 0) - built.index.files.policy;
    assert.equal(total, built.index.totalDecisionAndSurfaceCases);
    const bytes = Object.keys(built).reduce((n, name) => n + readFileSync(fixturePath("rbac", name), "utf8").length, 0);
    assert.ok(bytes <= 4_000_000, `fixtures/parity/rbac/ stays within 4 MB, now ${bytes}`);
    assert.ok(built.index.totalDecisionAndSurfaceCases >= 20000);
  });
});

describe("js semantics vectors (P4-12 task 2, R5)", () => {
  it("the committed fixtures are exactly what the exporter records, within 2 MB with the exposure vectors", async () => {
    const built = await buildJsVectors();
    assert.deepEqual(Object.keys(built).sort(), ["array-index", "classes", "digests", "sort", "strings"]);
    for (const [name, data] of Object.entries(built)) {
      assert.equal(readFileSync(fixturePath("js", name), "utf8"), fixtureText(data), `fixtures/parity/js/${name}.json is stale: run scripts/parity/export-js.ts`);
    }
    assert.ok((built as any).classes.space.length === 25 && (built as any).classes.probes["k"].length === 2, "Kelvin does not fold to k");
  });
});

describe("exposure vectors (P4-12 task 2)", () => {
  it("the committed fixtures are exactly what the exporter records, and exposure plus js stay within 2 MB", async () => {
    const built = await buildExposureVectors() as any;
    assert.deepEqual(Object.keys(built).sort(), ["doctor-check", "doctor-findings", "hash", "index", "keywords", "local-only", "resolve-overrides", "resolve-principals", "resolve-switches", "scanner", "sensitivity-filter", "sensitivity-refusal", "switches"]);
    let bytes = 0;
    for (const [name, data] of Object.entries(built)) {
      const text = readFileSync(fixturePath("exposure", name), "utf8");
      assert.equal(text, fixtureText(data), `fixtures/parity/exposure/${name}.json is stale: run scripts/parity/export-exposure.ts`);
      bytes += text.length;
    }
    for (const name of ["array-index", "classes", "digests", "sort", "strings"]) bytes += readFileSync(fixturePath("js", name), "utf8").length;
    assert.ok(bytes <= 2_000_000, `fixtures/parity/{exposure,js}/ stay within 2 MB, now ${bytes}`);
    // The grids: counts pinned, so a shrinking grid is a visible change.
    assert.deepEqual(built.index.counts["resolve-principals"], 5 * 3 * 3 * 11 * 6 + 1);
    assert.equal(built.index.counts["resolve-switches"], 81 * 24 + 2 * 81 * 4);
    assert.equal(built.index.counts["resolve-overrides"], 3 * 5 * 3 * 27 + 2 * 3 * 5 * 3);
    assert.equal(built.index.counts.switches, 3 * 4 * 81 + 2);
    assert.ok(built.index.counts.scanner >= 2500);
    // Each of the five categories has positive lines, and every subset of categories occurs.
    const outcomes = built.scanner.cases.map((l: string) => l.split("\t")[2]!.split("/")[0]!);
    for (const c of ["health", "financial", "credential", "identity", "personal"]) assert.ok(outcomes.some((o: string) => o.split(",").includes(c)), c);
    assert.equal(new Set(outcomes.filter((o: string) => o !== "-")).size >= 31, true);
  });
});

describe("identity vectors (P4-12 task 3)", () => {
  it("the committed fixtures are exactly what the exporter records, within 1 MB", async () => {
    const built = await buildIdentityVectors() as any;
    assert.deepEqual(Object.keys(built).sort(), ["authorization", "channel-names", "code-equal", "code-hash", "code-normalize", "code-normalize-sweep", "code-random", "constants", "identity-validation", "index", "invite-origin", "invite-token", "limiter", "principal-derive", "principal-shape", "principal-v1", "recall"]);
    let bytes = 0;
    for (const [name, data] of Object.entries(built)) {
      const text = readFileSync(fixturePath("identity", name), "utf8");
      assert.equal(text, fixtureText(data), `fixtures/parity/identity/${name}.json is stale: run scripts/parity/export-identity.ts`);
      bytes += Buffer.byteLength(text);
    }
    assert.ok(bytes <= 1_000_000, `fixtures/parity/identity/ stays within 1 MB, now ${bytes}`);
    // The grids: counts pinned, so a shrinking grid is a visible change.
    assert.equal(built.index.counts.authorization, 6 * 6 * 3 * 2 * 10 + 6 * 2 * 6 + 6 * 3 * 3 * 3 * 2);
    assert.ok(built.index.counts["invite-origin"] >= 3000 && built.index.counts.limiter >= 1000 && built.index.counts["code-normalize"] >= 800);
    assert.equal(built["code-normalize-sweep"].scalars, 0x110000 - 0x800);
    // Every limiter sequence ends in a state the table dump shows, and the lock thresholds are exercised in both directions.
    const lines: string[] = built.limiter.sequences.flatMap((q: any) => q.steps);
    assert.ok(lines.some((l) => l.startsWith("locked\t") && !l.split("\t")[4]!.startsWith("0")) && lines.some((l) => l.startsWith("release\t")) && lines.some((l) => l.startsWith("prune\t")));
    // Randomness is scripted, never recorded: the exporter run twice gives the same bytes (the --check above) and the draws cover every symbol.
    assert.equal(new Set(built["code-random"].generate.cases.flatMap((c: string) => JSON.parse(c)[1].split(""))).size, 32);
  });
});

describe("identity store, admin store and guard sequences (P4-12 tasks 4 to 6, R9)", () => {
  const stale = (area: string, built: Record<string, unknown>, exporter: string): number => {
    let bytes = 0;
    for (const [name, data] of Object.entries(built)) {
      const text = readFileSync(fixturePath(area, name), "utf8");
      assert.equal(text, fixtureText(data), `fixtures/parity/${area}/${name}.json is stale: run scripts/parity/${exporter}`);
      bytes += Buffer.byteLength(text);
    }
    return bytes;
  };
  const ops = (scenarios: any[]): Set<string> => new Set(scenarios.flatMap((s) => s.steps.map((line: string) => JSON.parse(line).op)));

  it("identity store: the committed sequences are what the exporter records, cover every method and stay within 1 MB", async () => {
    const built = await buildIdentityStoreVectors() as any;
    assert.deepEqual(Object.keys(built).sort(), ["scenarios", "schema"]);
    assert.ok(stale("identity-store", built, "export-identity-store.ts") <= 1_000_000);
    const scenarios = built.scenarios.scenarios;
    assert.ok(scenarios.length >= 16 && scenarios.reduce((n: number, s: any) => n + s.steps.length, 0) >= 640);
    for (const op of ["open", "close", "createHuman", "link", "revokePairing", "startPairing", "claim", "confirm", "unlink", "list", "resolve", "linkedV1Principals", "jobLink", "resolvePrincipals", "getLink", "backfillRecord", "reserveBackfill", "finishBackfill", "authorizeAction", "emit", "backfill.run", "backfill.reverse"])
      assert.ok(ops(scenarios).has(op), `no step calls ${op}`);
    // Every refusal of the service's vocabulary is recorded at least once, and the scripted random source restored node:crypto.
    const codes = new Set(scenarios.flatMap((s: any) => s.steps.map((line: string) => JSON.parse(line).out.err?.code)));
    for (const code of ["invalid-params", "not-found", "invalid-code", "expired", "rate-limited", "conflict", "limit", "storage", "denied"]) assert.ok(codes.has(code), `no step is refused as ${code}`);
    assert.notEqual(randomBytes(16).toString("hex"), randomBytes(16).toString("hex"));
    // The back-fill is recorded over a scripted port and over the real engine port on a scripted `engine.memory`.
    const steps = scenarios.flatMap((s: any) => s.steps.map((line: string) => JSON.parse(line)));
    assert.ok(steps.some((s: any) => s.engine?.[0]?.operator?.trust === "proved") && steps.some((s: any) => s.engine?.[0]?.operationId?.endsWith(":reverse")));
  });

  it("admin store and desktop attach: the committed sequences are what the exporter records and cover every method", () => {
    const built = buildIdentityAdminVectors() as any;
    assert.deepEqual(Object.keys(built).sort(), ["admin", "attach", "schema"]);
    assert.ok(stale("identity-admin", built, "export-identity-admin.ts") <= 400_000);
    for (const op of ["open", "role", "users", "person", "resolvePerson", "setDisabled", "validateInvite", "setRole", "rights", "setRight", "resolve", "invite", "notice", "notices", "allNotices", "invites", "revoke", "redeem"])
      assert.ok(ops(built.admin.scenarios).has(op), `no admin step calls ${op}`);
    for (const op of ["open", "issue", "redeem", "authenticate", "resolve"]) assert.ok(ops(built.attach.scenarios).has(op), `no attach step calls ${op}`);
    // "Audit before effect": a failing hook and a failing sink are part of the script.
    const errs = (scenarios: any[]) => scenarios.flatMap((s) => s.steps.map((line: string) => JSON.parse(line).out.err)).filter(Boolean);
    assert.ok(errs(built.admin.scenarios).some((e) => e.hook) && errs(built.attach.scenarios).some((e) => e.audit));
  });

  it("guard, break-glass and audit lines: the committed vectors are what the exporter records, and every rule is in them", async () => {
    const built = await buildRbacGuardVectors() as any;
    assert.deepEqual(Object.keys(built).sort(), ["audit", "break-glass", "guard", "rules"]);
    assert.ok(stale("rbac-guard", built, "export-rbac-guard.ts") <= 1_000_000);
    const methods: string[] = built.rules.methods.map((m: any) => m.method);
    assert.ok(methods.length >= 290);
    // Every method that is not API-service-only is run in layer `method`, every API-service-only one in layer `service`.
    const ran = (layer: string) => new Set(built.guard.layers[layer].map((line: string) => built.guard.tables.method[Number(line.split(".")[0])]));
    for (const m of built.rules.methods) assert.ok(ran(m.apiServiceOnly ? "service" : "method").has(m.method), `${m.method} is in no case`);
    assert.ok(built.guard.index.total >= 15_000 && built["break-glass"].scenarios.length >= 6 && built.audit.rbac.length >= 6);
  });
});

describe("card sensitivity store and service sequences (P4-12 task 7, R9)", () => {
  it("the committed sequences are what the exporter records, cover every method, stay within 300 KB, and leave Date.now alone", async () => {
    const realNow = Date.now;
    const built = await buildSensitivityVectors() as any;
    assert.equal(Date.now, realNow, "the scripted clock was restored");
    assert.deepEqual(Object.keys(built).sort(), ["scenarios", "schema"]);
    let bytes = 0;
    for (const [name, data] of Object.entries(built)) {
      const text = readFileSync(fixturePath("sensitivity", name), "utf8");
      assert.equal(text, fixtureText(data), `fixtures/parity/sensitivity/${name}.json is stale: run scripts/parity/export-sensitivity.ts`);
      bytes += Buffer.byteLength(text);
    }
    assert.ok(bytes <= 300_000);
    const scenarios: any[] = built.scenarios.scenarios;
    assert.ok(scenarios.length >= 12 && scenarios.reduce((n, s) => n + s.steps.length, 0) >= 200);
    const ops = new Set(scenarios.flatMap((s) => s.steps.map((line: string) => JSON.parse(line).op)));
    for (const op of ["open", "close", "store.get", "store.getByHash", "store.set", "store.clear", "store.hasManualCategories", "assessCard", "assessAggregate", "setSensitivity", "clearSensitivity", "hasManualCategories", "getSensitivity"])
      assert.ok(ops.has(op), `no step calls ${op}`);
    // The scanner's five categories each come out of the service at least once.
    const seen = new Set(scenarios.flatMap((s) => s.steps.flatMap((line: string) => { const o = JSON.parse(line); return o.op === "assessCard" && Array.isArray(o.out.ok) ? o.out.ok : []; })));
    for (const c of ["health", "financial", "credential", "identity", "personal"]) assert.ok(seen.has(c), `no assessCard result has ${c}`);
    assert.deepEqual(built.schema.pragmas, { busy_timeout: 5000, foreign_keys: 1, journal_mode: "wal", synchronous: 2, user_version: 0 });
  });
});

describe("secrets-store vectors (P4-20, mode V)", () => {
  it("the committed fixtures are exactly what the exporter records, within 1 MB, and cover the registry, the two backends and the store", async () => {
    const built = await buildSecretsStoreVectors() as any;
    assert.deepEqual(Object.keys(built).sort(), ["file-backend", "keyring-backend", "registry", "store"]);
    let bytes = 0;
    for (const [name, data] of Object.entries(built)) {
      const text = readFileSync(fixturePath("secrets-store", name), "utf8");
      assert.equal(text, fixtureText(data), `fixtures/parity/secrets-store/${name}.json is stale: run scripts/parity/export-secrets-store.ts`);
      bytes += Buffer.byteLength(text);
    }
    assert.ok(bytes <= 1_000_000, `fixtures/parity/secrets-store/ stays within 1 MB, now ${bytes}`);
    // Registry: every kind of step is recorded, the bound is crossed, and exactly one scenario is a noted divergence.
    const steps = built.registry.scenarios.flatMap((s: any) => s.steps);
    for (const kind of ["register", "many", "rotate", "group", "mask", "contains", "subscribe", "unsubscribe"]) assert.ok(steps.some((s: any) => s.op[0] === kind), `no ${kind} step`);
    assert.ok(steps.some((s: any) => s.values.length > built.registry.maxRegistered), "no step holds more values than the bound of retired ones");
    assert.deepEqual(built.registry.scenarios.filter((s: any) => s.note).map((s: any) => s.name), ["a-retired-value-registered-again"]);
    assert.ok(steps.length > 80, `the registry grid shrank: ${steps.length}`);
    // File backend: every way a file can be corrupt is recorded, and the files are compared after every step.
    const fileSteps = built["file-backend"].scenarios.flatMap((s: any) => s.steps);
    const whys = new Set(fileSteps.map((s: any) => s.result.err?.detail?.why).filter(Boolean));
    for (const why of ["unreadable-store", "bad-schema", "bad-entry", "bad-tombstones", "bad-key", "key-missing", "authentication-failed"]) assert.ok(whys.has(why), `no step is corrupt as ${why}`);
    assert.ok(fileSteps.some((s: any) => s.result.err?.detail?.cause === "error"), "no step fails without a code (an invalid time)");
    assert.ok(fileSteps.every((s: any) => "store" in s && "key" in s && Array.isArray(s.draws)), "a step without its files or draws");
    assert.ok(fileSteps.some((s: any) => typeof s.store === "string" && s.store.includes('"future"') && s.op[0] === "put"), "no write keeps a member this version does not know");
    assert.ok(fileSteps.length > 350 && built["file-backend"].base64.length >= 30, `the file backend grid shrank: ${fileSteps.length}`);
    // Keyring backend: every kind of step and of scripted failure, each refusal, both shapes of entry, and exactly two noted divergences.
    const keyring = built["keyring-backend"];
    const keyringSteps = keyring.scenarios.flatMap((s: any) => s.steps);
    for (const kind of ["probe", "get", "list", "delete", "put", "describe", "seed", "fail"]) assert.ok(keyringSteps.some((s: any) => s.op[0] === kind), `no keyring ${kind} step`);
    for (const op of ["load", "new", "get", "set", "delete"]) assert.ok(keyringSteps.some((s: any) => s.op[0] === "fail" && s.op[1] === op), `no failing ${op}`);
    for (const code of ["backend-unavailable", "storage", "corrupt", "not-found", "invalid-description"]) assert.ok(keyringSteps.some((s: any) => s.result.err?.code === code), `no keyring step is refused with ${code}`);
    for (const why of ["unreadable-index", "bad-schema", "bad-entry"]) assert.ok(keyringSteps.some((s: any) => s.result.err?.message.includes(`(${why})`)), `no index is ${why}`);
    for (const reason of ["keyring-unavailable", "keyring-error"]) assert.ok(keyringSteps.some((s: any) => s.result.ok?.reason === reason), `no probe answers ${reason}`);
    assert.ok(keyringSteps.some((s: any) => s.op[0] === "put" && s.result.err && /set:\S+ (new|set):\S+ (set|delete):/.test(s.calls)), "no put is undone after the index could not be written");
    assert.ok(keyring.scenarios.some((s: any) => s.variant === "credential"), "no scenario over entries that offer deleteCredential");
    assert.deepEqual(keyring.scenarios.filter((s: any) => s.note).map((s: any) => s.name), ["foreign-members-in-an-answer", "a-time-no-date-can-hold"]);
    assert.ok(keyringSteps.length > 270, `the keyring grid shrank: ${keyringSteps.length}`);
    assert.ok(!JSON.stringify(keyring).includes("platform text"), "platform text of a failing keyring reached an answer");
    // Store: every refusal it raises itself, the sync of the two backends as the core's own audit records, and every warning.
    const storeSteps = built.store.scenarios.flatMap((s: any) => s.steps);
    const storeCodes = new Set(storeSteps.map((s: any) => s.result.err?.code).filter(Boolean));
    for (const code of ["denied", "not-found", "invalid-name", "invalid-value", "invalid-description", "invalid-ttl", "lease-invalid", "no-backend", "backend-unavailable", "audit-unavailable", "storage"]) assert.ok(storeCodes.has(code), `no store step is refused as ${code}`);
    const records = storeSteps.flatMap((s: any) => s.audit);
    for (const action of ["secret.set", "secret.describe", "secret.get", "secret.reveal", "secret.delete", "secret.list", "secret.lease", "secret.lease.read", "secret.lease.revoke", "secret.denied"]) assert.ok(records.some((r: any) => r.action === action), `no audit record ${action}`);
    assert.ok(records.some((r: any) => r.principal.kind === "core" && r.detail.reason === "keyring-sync" && r.action === "secret.set") && records.some((r: any) => r.detail.reason === "keyring-sync" && r.action === "secret.delete"), "the sync of the two backends is not recorded");
    const warnings = new Set(storeSteps.flatMap((s: any) => s.logs).filter((l: any) => l[0] === "warn").map((l: any) => l[1]));
    for (const message of ["secret access denied", "stale secret copy could not be removed", "secret tombstones could not be read", "secret copies could not be brought in line", "a secret tombstone could not be cleared", "file backend copy could not be checked"]) assert.ok(warnings.has(message), `no step warns "${message}"`);
    assert.ok(storeSteps.some((s: any) => s.marks.includes("cancel")) && storeSteps.some((s: any) => s.marks.includes("close")), "no outage and no close");
    assert.ok(storeSteps.length > 400 && built.store.dates.length >= 25, `the store grid shrank: ${storeSteps.length}`);
  });
});

describe("secrets vectors (P4-20, mode V)", () => {
  it("the committed fixtures are exactly what the exporter records, within 1 MB, and cover every rule of the slice", async () => {
    const built = await buildSecretsVectors() as any;
    assert.deepEqual(Object.keys(built).sort(), ["audit-detail", "constants", "leases", "memory-backend", "name-order", "validation"]);
    let bytes = 0;
    for (const [name, data] of Object.entries(built)) {
      const text = readFileSync(fixturePath("secrets", name), "utf8");
      assert.equal(text, fixtureText(data), `fixtures/parity/secrets/${name}.json is stale: run scripts/parity/export-secrets.ts`);
      bytes += Buffer.byteLength(text);
    }
    assert.ok(bytes <= 1_000_000, `fixtures/parity/secrets/ stays within 1 MB, now ${bytes}`);
    // Every refusal this slice can raise is recorded at least once (the other codes belong to the file backend and the store).
    const codes = new Set<string>();
    const walk = (v: any): void => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") { if (typeof v.err?.code === "string") codes.add(v.err.code); Object.values(v).forEach(walk); } };
    walk([built.validation, built.leases, built["memory-backend"], built["audit-detail"]]);
    for (const code of ["invalid-name", "invalid-value", "invalid-description", "invalid-ttl", "lease-invalid", "not-found", "backend-unavailable", "audit-unavailable", "storage", "corrupt", "denied"]) assert.ok(codes.has(code), `no case is refused as ${code}`);
    // Grids pinned, so a shrinking one is a visible change.
    assert.ok(built.validation.checkName.cases.length >= 600 && built.validation.checkDescription.cases.length >= 550 && built.validation.checkValue.cases.length >= 50);
    assert.ok(built["name-order"].sorted.length >= 800 && built["name-order"].pairs.cases.length >= 300);
    assert.ok(built.leases.scenarios.reduce((n: number, s: any) => n + s.steps.length, 0) >= 80);
    assert.ok(built["memory-backend"].scenarios.reduce((n: number, s: any) => n + s.steps.length, 0) >= 140);
    assert.ok(built["audit-detail"].sanitize.cases.length >= 200 && built["audit-detail"].actor.cases.length >= 35);
    // Both sides of every limit: a 64 KiB value and one byte more, 200 and 201 code points, a lease read at the instant it expires.
    const checkValue: [any, any][] = built.validation.checkValue.cases;
    assert.ok(checkValue.some(([i, o]) => JSON.stringify(i) === JSON.stringify({ rep: ["a", 65536] }) && o.ok === true) && checkValue.some(([i, o]) => JSON.stringify(i) === JSON.stringify({ rep: ["a", 65537] }) && o.err?.code === "invalid-value"));
    const lease = built.leases.scenarios[0].steps;
    assert.ok(lease[2].out.ok && lease[3].now === lease[0].now + 60_000 && lease[3].out.err?.code === "lease-invalid");
    // Strings JSON cannot hold are in the vectors, and randomness is scripted, never recorded (the real source is restored).
    assert.ok(JSON.stringify(built.validation).includes('"u16"'));
    assert.notEqual(randomBytes(16).toString("hex"), randomBytes(16).toString("hex"));
  });
});

describe("budget vectors (P4-K K1, plan P4-24)", () => {
  it("the committed fixtures are exactly what the exporter records", async () => {
    const built = await buildBudgetVectors() as any;
    assert.deepEqual(Object.keys(built).sort(), ["breach", "context", "media", "period", "retry", "subagent", "weight"]);
    for (const [name, data] of Object.entries(built)) {
      const text = readFileSync(fixturePath("budget", name), "utf8");
      assert.equal(text, fixtureText(data), `fixtures/parity/budget/${name}.json is stale: run scripts/parity/export-budget.ts`);
      assert.ok(text.length < 5_000_000, `${name}: a fixture file stays under about 5 MB (split it)`);
    }
    // The zones the Rust replay cannot model without a time-zone database are in the vectors, so the replay names what it skips.
    assert.ok(built.period.rows.some((r: unknown[]) => r[0] === "Pacific/Apia"));
  });
});

describe("handoff vectors (P4-K K3b, plan P4-22)", () => {
  it("the committed fixtures are exactly what the exporter records", async () => {
    const built = await buildHandoffVectors() as any;
    assert.deepEqual(Object.keys(built).sort(), ["rules", "web-base"]);
    for (const [name, data] of Object.entries(built)) {
      const text = readFileSync(fixturePath("handoff", name), "utf8");
      assert.equal(text, fixtureText(data), `fixtures/parity/handoff/${name}.json is stale: run scripts/parity/export-handoff.ts`);
      assert.ok(text.length < 1_048_576, `${name}: a fixture file stays under 1 MiB`);
    }
    // The boundaries of the security rule are scenarios, and randomness is scripted, never recorded.
    const names = built.rules.map((s: any) => s.name);
    for (const n of ["redeem-lifetime-boundary", "taint-for-good", "taint-by-kind", "link-limit-per-person", "audit-before-effect"]) assert.ok(names.includes(n), n);
  });
});

describe("delivery vectors (P4-K K3b, plan P4-22)", () => {
  it("the committed fixtures are exactly what the exporter records", async () => {
    const built = await buildDeliveryVectors() as any;
    assert.deepEqual(Object.keys(built).sort(), ["policy", "rules"]);
    for (const [name, data] of Object.entries(built)) {
      const text = readFileSync(fixturePath("delivery", name), "utf8");
      assert.equal(text, fixtureText(data), `fixtures/parity/delivery/${name}.json is stale: run scripts/parity/export-delivery.ts`);
      assert.ok(text.length < 1_048_576, `${name}: a fixture file stays under 1 MiB`);
    }
    const names = built.rules.map((s: any) => s.name);
    for (const n of ["code-boundaries-time", "code-boundaries-tries", "confirm-text-shapes", "quota-race-across-the-dm-lookup", "remove-and-revocation-during-delivery"]) assert.ok(names.includes(n), n);
    // Both answers of the allowlist rule are recorded, and the Buzz key answers the replay hands to its port.
    assert.ok(built.policy.cases.some((c: any) => c.allowed) && built.policy.cases.some((c: any) => !c.allowed));
    assert.ok(Object.keys(built.policy.buzzKeys).length > 0);
  });
});

describe("inbox vectors (P4-K K3b, plan P4-22)", () => {
  it("the committed fixtures are exactly what the exporter records", async () => {
    const built = await buildInboxVectors() as any;
    assert.deepEqual(Object.keys(built).sort(), ["producers", "service", "store"]);
    for (const [name, data] of Object.entries(built)) {
      const text = readFileSync(fixturePath("inbox", name), "utf8");
      assert.equal(text, fixtureText(data), `fixtures/parity/inbox/${name}.json is stale: run scripts/parity/export-inbox.ts`);
      assert.ok(text.length < 1_048_576, `${name}: a fixture file stays under 1 MiB`);
    }
    const names = built.store.map((s: any) => s.name);
    for (const n of ["rate-limit-boundary", "retention-by-age", "retention-by-count", "cursor-decoding", "validation"]) assert.ok(names.includes(n), n);
    // The strings JSON cannot hold (a clip that cut an emoji in two, K3-D4) are recorded as unit lists.
    assert.ok(JSON.stringify(built.producers).includes('"$u16"'));
  });
});

describe("sessions vectors (P4-K K5a, plan P4-40)", () => {
  it("the committed fixtures are exactly what the exporter records", async () => {
    const built = await buildSessionVectors() as any;
    assert.deepEqual(Object.keys(built).sort(), ["fts", "overlays", "pure", "schema", "sessions", "turns"]);
    for (const [name, data] of Object.entries(built)) {
      const text = readFileSync(fixturePath("sessions", name), "utf8");
      assert.equal(text, fixtureText(data), `fixtures/parity/sessions/${name}.json is stale: run scripts/parity/export-sessions.ts`);
      assert.ok(text.length < 1_048_576, `${name}: a fixture file stays under 1 MiB`);
    }
    assert.equal(built.schema.version, 11);
    assert.ok(built.sessions.some((s: any) => s.name === "chat-pages"));
  });
});

describe("collab vectors (P4-K K6a, plan P4-50)", () => {
  it("the committed fixtures are exactly what the exporter records", async () => {
    const built = await buildCollabVectors() as any;
    assert.deepEqual(Object.keys(built).sort(), ["board", "pure", "schema", "store"]);
    for (const [name, data] of Object.entries(built)) {
      const text = readFileSync(fixturePath("collab", name), "utf8");
      assert.equal(text, fixtureText(data), `fixtures/parity/collab/${name}.json is stale: run scripts/parity/export-collab.ts`);
      assert.ok(text.length < 1_048_576, `${name}: a fixture file stays under 1 MiB`);
    }
    assert.equal(built.schema.version, 9);
    assert.ok(built.pure.guardrails.length >= 60 && built.pure.limits.length >= 100);
  });
});

describe("session maintenance vectors (P4-K K5b, plan P4-40)", () => {
  it("the committed fixtures are exactly what the exporter records", async () => {
    const built = await buildMaintenanceVectors() as any;
    assert.deepEqual(Object.keys(built).sort(), ["chat-models", "compaction-1", "compaction-2", "compaction-3", "compaction-4", "context-fit", "maintenance", "pruning-1", "pruning-2", "pruning-3", "pruning-4", "pruning-5", "pure", "role-routing", "summarizer", "telemetry"]);
    for (const [name, data] of Object.entries(built)) {
      const text = readFileSync(fixturePath("session-maintenance", name), "utf8");
      assert.equal(text, fixtureText(data), `fixtures/parity/session-maintenance/${name}.json is stale: run scripts/parity/export-session-maintenance.ts`);
      assert.ok(text.length <= 1024 * 1024, `${name}: a vector file stays at or under 1 MiB`);
    }
  });
});

describe("session rewind vectors (P4-K K5c, plan P4-40)", () => {
  // The vectors record the argument lists of real git runs with unix paths; Windows spells the null device and the paths otherwise.
  it("the committed fixture is exactly what the exporter records", { skip: process.platform === "win32" }, async () => {
    const built = await buildRewindVectors() as any;
    assert.deepEqual(Object.keys(built), ["cases"]);
    const text = readFileSync(fixturePath("session-rewind", "cases"), "utf8");
    assert.equal(text, fixtureText(built.cases), "fixtures/parity/session-rewind/cases.json is stale: run scripts/parity/export-session-rewind.ts");
    assert.ok(text.length <= 1024 * 1024, "a vector file stays at or under 1 MiB");
  });
});

describe("egress vectors (P4-K K2, plan P4-21)", () => {
  it("the committed fixtures are exactly what the exporter records", async () => {
    const built = await buildEgressVectors() as any;
    assert.deepEqual(Object.keys(built).sort(), ["decide", "gate", "model", "policy", "urls"]);
    for (const [name, data] of Object.entries(built)) {
      const text = readFileSync(fixturePath("egress", name), "utf8");
      assert.equal(text, fixtureText(data), `fixtures/parity/egress/${name}.json is stale: run scripts/parity/export-egress.ts`);
      assert.ok(text.length < 5_000_000, `${name}: a fixture file stays under about 5 MB (split it)`);
    }
    // The cases the Rust side refuses for want of IDNA are in the vectors, with their note.
    assert.ok(built.policy.some((c: any) => c.note !== undefined));
    assert.ok(built.gate.cases.some((c: any) => c.note !== undefined && c.urlError === undefined));
    // The hostile URL corpus (review A of K2): every named class holds at least two URLs, and the file stays under 1 MiB.
    assert.ok(Object.values(built.urls.classes).every((rows: any) => rows.length >= 2));
    assert.ok(fixtureText(built.urls).length < 1_048_576);
  });
});

describe("policy vectors (P4-K K2, plan P4-21)", () => {
  it("the committed fixtures are exactly what the exporter records", async () => {
    const built = await buildPolicyVectors() as any;
    assert.deepEqual(Object.keys(built).sort(), ["audit", "decide", "effects", "helpers", "paths", "tables", "values"]);
    for (const [name, data] of Object.entries(built)) {
      const text = readFileSync(fixturePath("policy", name), "utf8");
      assert.equal(text, fixtureText(data), `fixtures/parity/policy/${name}.json is stale: run scripts/parity/export-policy.ts`);
      assert.ok(text.length < 5_000_000, `${name}: a fixture file stays under about 5 MB (split it)`);
    }
    // Every platform is recorded, whatever machine records them, and the attack/benign table is in.
    assert.deepEqual(built.paths.platforms.map((p: any) => p.platform), ["darwin", "linux", "win32", "win32", "darwin", "win32", "freebsd"]);
    assert.ok(built.decide.some((c: any) => c.name === "ssh-read:attack"));
    // JavaScript value semantics (review A of K2): some conversions throw, and `decide` records the K2-D8 rows.
    assert.ok(built.values.coerce.some((c: any) => c.number.threw === "TypeError"));
    assert.ok(built.values.decide.some((g: any) => g.rows.some((r: any) => r.divergence === "K2-D8")));
  });
});

describe("attestation vectors (P4-K K2, plan P4-21)", () => {
  it("the committed fixtures are exactly what the exporter records", async () => {
    const built = await buildAttestationVectors() as any;
    assert.deepEqual(Object.keys(built), ["service"]);
    const text = readFileSync(fixturePath("attestation", "service"), "utf8");
    assert.equal(text, fixtureText(built.service), "fixtures/parity/attestation/service.json is stale: run scripts/parity/export-attestation.ts");
    assert.ok(built.service.some((s: any) => s.name === "replay"));
  });
});

// The grant paths in these vectors are POSIX spellings, which the Windows path rules refuse: compared on POSIX only.
describe("approvals vectors (P4-K K3a, plan P4-22)", { skip: process.platform === "win32" ? "the grant paths are POSIX spellings; the Windows rules refuse them" : false }, () => {
  it("the committed fixtures are exactly what the exporter records", async () => {
    const built = await buildApprovalsVectors() as any;
    assert.deepEqual(Object.keys(built), ["canonical", "cells", "cells-grants", "chain", "ed25519", "regex", "rules", "semantic", "signing"]);
    for (const name of Object.keys(built)) {
      const text = readFileSync(fixturePath("approvals", name), "utf8");
      assert.equal(text, fixtureText(built[name]), `fixtures/parity/approvals/${name}.json is stale: run scripts/parity/export-approvals.ts`);
      assert.ok(text.length <= 1024 * 1024, `${name}: R-K-10, a vector file stays at or under 1 MiB`);
    }
    assert.ok(built.chain.tampers.some((t: any) => t.name === "signature-byte"));
    // Review B, RB-1: every group of Ed25519 edge cases is on record, Node accepts none where the equation does not hold,
    // and it refuses every key and every R of small order although the equation holds for them.
    const ed = built.ed25519;
    for (const g of ["honest", "small-a", "small-r", "mixed-a", "mixed-r", "s-range", "noncanonical"]) assert.ok(ed.verify.some((c: any) => c.group === g), g);
    assert.equal(ed.smallOrder.length, 14);
    assert.ok(ed.verify.every((c: any) => c.equation || !c.ok));
    assert.ok(ed.verify.filter((c: any) => c.group === "small-a" || c.group === "small-r").every((c: any) => !c.ok));
    assert.ok(ed.verify.filter((c: any) => c.group === "small-a" && c.equation).length >= 28);
    assert.ok(ed.verify.some((c: any) => c.group === "mixed-a" && c.ok));
    assert.deepEqual([...ed.spellings, ...ed.keys].filter((c: any) => c.divergence).map((c: any) => c.divergence).sort(), ["K3-D5", "K3-D5", "K3-D5", "K3-D6", "K3-D6", "K3-D6"]);
  });
});

// The file-system answers are those of the system the vectors were recorded on; elsewhere this one file is not compared
// (the Rust replay plays its portable cases there and counts the rest).
describe("policy file-system vectors (P4-K K2, plan P4-21)", { skip: process.platform === POLICY_FS_OS ? false : `fixtures/parity/policy-fs/${POLICY_FS_OS}.json is recorded on ${POLICY_FS_OS}; this is ${process.platform}, so it is not compared` }, () => {
  it("the committed fixture is exactly what the exporter records on the recording system", async () => {
    const built = await buildPolicyFsVectors() as any;
    assert.deepEqual(Object.keys(built), [POLICY_FS_OS]);
    const text = readFileSync(fixturePath("policy-fs", POLICY_FS_OS), "utf8");
    assert.equal(text, fixtureText(built[POLICY_FS_OS]), `fixtures/parity/policy-fs/${POLICY_FS_OS}.json is stale: run scripts/parity/export-policy-fs.ts on ${POLICY_FS_OS}`);
    assert.ok(text.length <= 1024 * 1024, "R-K-10: a vector file stays at or under 1 MiB");
    // Since P4D-43 the truncation follows the identity check (formerly K2-D5): the other file keeps its contents, and a
    // target missing at the check is not opened without a create. The file-system-dependent cases are marked.
    const fsCase = (n: string) => built[POLICY_FS_OS].cases.find((c: any) => c.name === n);
    assert.deepEqual(fsCase("swap-write-for-hard-link").results.at(-1), { text: "outside-secret" });
    assert.equal(fsCase("late-hard-link-without-create").results[2].reason, "not-found");
    assert.ok(built[POLICY_FS_OS].cases.every((c: any) => c.divergence === undefined));
    assert.ok(built[POLICY_FS_OS].cases.some((c: any) => c.portable === false));
  });
});

describe("provider auth vectors (P4-K K4, plan P4-23)", () => {
  it("the committed fixtures are exactly what the exporter records, in pieces where they hold a secret", async () => {
    const built = await buildProviderAuthVectors() as any;
    assert.deepEqual(Object.keys(built).sort(), ["adc", "credentials", "http", "ladder", "login", "pem", "pool", "profile", "records", "redact", "refresh"]);
    for (const [name, data] of Object.entries(built)) {
      const text = readFileSync(fixturePath("provider-auth", name), "utf8");
      assert.equal(text, fixtureText(data), `fixtures/parity/provider-auth/${name}.json is stale: run scripts/parity/export-provider-auth.ts`);
      assert.ok(text.length <= 1024 * 1024, `${name}: R-K-10, a vector file stays at or under 1 MiB`);
      // Every invented secret is stored in pieces: no whole marker, no whole key header.
      assert.ok(!/CANARY-[A-Z]+-/.test(text) && !/BEGIN [A-Z ]*PRIVATE KEY/.test(text), `${name}: a secret is stored whole`);
    }
    const names = built.refresh.scenarios.map((s: any) => s.name);
    for (const n of ["concurrent-callers-share-one-refresh", "invalid-grant-is-reauth-and-stops", "skew-boundary-no-jitter", "backoff-boundary", "clock-jumps-back-and-forward"]) assert.ok(names.includes(n), n);
    assert.equal(built.refresh.scenarios.find((s: any) => s.name === "concurrent-callers-share-one-refresh").requests.length, 1);
  });
});

describe("OpenAI auth vectors (P4-K K4, plan P4-23)", () => {
  it("the committed fixtures are exactly what the exporter records, in pieces where they hold a secret", async () => {
    const built = await buildOpenAIAuthVectors() as any;
    assert.deepEqual(Object.keys(built).sort(), ["http", "jwks", "listener", "plan", "pure", "service", "workload"]);
    // Review B: a target that is no URL is answered 404 (P4D-45, formerly K4-D4), and no request divergence remains.
    const unparsable = built.listener.requests.filter((r: any) => r.target === "//[" || r.target === "http://[");
    assert.equal(unparsable.length, 2);
    assert.ok(unparsable.every((r: any) => r.response.status === 404 && r.threw === undefined));
    assert.ok(built.listener.requests.every((r: any) => r.divergence === undefined));
    // P4D-44 closed K4-D5 and K4-D6; of the identity divergences only K4-D7 (a key carrying `d`) remains.
    assert.deepEqual([...new Set(built.jwks.members.filter((c: any) => c.divergence).map((c: any) => c.divergence))], ["K4-D7"]);
    for (const [name, data] of Object.entries(built)) {
      const text = readFileSync(fixturePath("openai-auth", name), "utf8");
      assert.equal(text, fixtureText(data), `fixtures/parity/openai-auth/${name}.json is stale: run scripts/parity/export-openai-auth.ts`);
      assert.ok(text.length <= 1024 * 1024, `${name}: R-K-10, a vector file stays at or under 1 MiB`);
      assert.ok(!/CANARY-[A-Z]+-/.test(text) && !/BEGIN [A-Z ]*PRIVATE KEY/.test(text), `${name}: a secret is stored whole`);
    }
    assert.equal(built.jwks.eddsa.length, 200);
    assert.ok(built.jwks.eddsa.filter((c: any) => c.group === "small-a" || c.group === "small-r").every((c: any) => !c.ok));
    const names = built.plan.scenarios.map((s: any) => s.name);
    for (const n of ["spent-marker-survives-network-failure", "repeated-refresh-token-refused", "narrow-scope-at-refresh", "wrong-state", "oidc-rejects-signature"]) assert.ok(names.includes(n), n);
  });
});

describe("prompt vectors (P4-K K9a, plan P4-42)", () => {
  it("the committed fixtures are exactly what the exporter records", async () => {
    const built = await buildPromptVectors() as any;
    assert.deepEqual(Object.keys(built).sort(), ["canonical", "join", "model-table", "render", "session", "skills", "telemetry"]);
    for (const [name, data] of Object.entries(built)) {
      const text = readFileSync(fixturePath("prompt", name), "utf8");
      assert.equal(text, fixtureText(data), `fixtures/parity/prompt/${name}.json is stale: run scripts/parity/export-prompt.ts`);
      assert.ok(text.length <= 1024 * 1024, `${name}: R-K-10, a vector file stays at or under 1 MiB`);
    }
    // Every rendered prompt carries the digest of its whole JSON text; refusals are recorded with what was emitted before them.
    const steps = built.render.scenarios.flatMap((s: any) => s.steps);
    assert.ok(steps.filter((s: any) => typeof s.digest === "string").length > 200);
    assert.ok(steps.some((s: any) => s.error !== undefined && s.emitted.length > 0));
    const names = built.render.scenarios.map((s: any) => s.name);
    for (const n of ["b6-corpus-2", "prefix-stability", "interior-all-zones", "ttl-warmth-5m", "memory-cap-surrogate-5", "conversation-refused-tool-result-assistant"]) assert.ok(names.includes(n), n);
    // A description cut inside a surrogate pair is recorded as code units (K9a-D1).
    assert.ok(JSON.stringify(built.skills.describe).includes('"$u16"'));
  });
});

describe("triage vectors (P4-K K9a, plan P4-42)", () => {
  it("the committed fixtures are exactly what the exporter records", async () => {
    const built = await buildTriageVectors() as any;
    assert.deepEqual(Object.keys(built).sort(), ["classes", "message-eval", "rules", "runtime", "triage"]);
    for (const [name, data] of Object.entries(built)) {
      const text = readFileSync(fixturePath("triage", name), "utf8");
      assert.equal(text, fixtureText(data), `fixtures/parity/triage/${name}.json is stale: run scripts/parity/export-triage.ts`);
      assert.ok(text.length <= 1024 * 1024, `${name}: R-K-10, a vector file stays at or under 1 MiB`);
    }
    // Every threshold has a case on each side: the class tails, the confidence bump, the evaluation gates.
    assert.ok(built.classes.choose.some((c: any) => c.error !== undefined) && built.classes.choose.some((c: any) => c.result === "frontier"));
    assert.deepEqual(built["message-eval"].sets.filter((s: any) => s.result.passed).map((s: any) => s.name), ["all-good-60", "extra-13-of-60", "under-3-of-60", "wrong-category", "prototype-category"]);
    assert.ok(built.runtime.scenarios.some((s: any) => s.steps.some((x: any) => x.aborted === true)));
  });
});

describe("decision vectors (P4-K K9a, plan P4-42)", () => {
  it("the committed fixtures are exactly what the exporter records, the credential in pieces", async () => {
    const built = await buildDecisionVectors() as any;
    assert.deepEqual(Object.keys(built).sort(), ["adapters", "client", "role", "skills", "system-one"]);
    for (const [name, data] of Object.entries(built)) {
      const text = readFileSync(fixturePath("decision", name), "utf8");
      assert.equal(text, fixtureText(data), `fixtures/parity/decision/${name}.json is stale: run scripts/parity/export-decision.ts`);
      assert.ok(text.length <= 1024 * 1024, `${name}: R-K-10, a vector file stays at or under 1 MiB`);
      // The credential of the System One cases is never stored as one literal, and no request id is a real UUID.
      assert.ok(!text.includes(built["system-one"].secret.parts.join("")), `${name}: the test credential is stored whole`);
    }
    const reasons = new Set(built.client.scenarios.flatMap((s: any) => s.calls.map((c: any) => JSON.parse(c.json).reason ?? "accepted")));
    for (const r of ["accepted", "unavailable", "timeout", "invalid", "low-confidence", "privacy", "cancelled"]) assert.ok(reasons.has(r), r);
    assert.ok(built["system-one"].cases.some((c: any) => c.name === "lease-value-with-a-line-break" && c.error.reason === "unavailable"));
    assert.ok(built.role.runs.some((r: any) => r.name === "tool-call" && r.error.reason === "invalid"));
  });
});

describe("tool-call runtime vectors (P4-K K9b, plan P4-42)", () => {
  it("the committed fixtures are exactly what the exporter records", async () => {
    const built = await buildToolcallVectors() as any;
    for (const [name, data] of Object.entries(built)) {
      const text = readFileSync(fixturePath("toolcall", name), "utf8");
      assert.equal(text, fixtureText(data), `fixtures/parity/toolcall/${name}.json is stale: run scripts/parity/export-toolcall.ts`);
      assert.ok(text.length < 1_048_576, `${name}: a fixture file stays under 1 MiB`);
    }
    // The hostile corpus is large enough to matter and carries its seed.
    assert.ok(built.arguments.fuzz.cases.length >= 2000);
    assert.equal(built.arguments.fuzz.seed, "0x70011c");
    // Every repair kind and every refusal text of the decoder appears in a named case with its full answer.
    const named = JSON.stringify(built.arguments.named);
    for (const needle of ["trailing-comma", "unwrap-json-string", "numeric-string", "JSON parse failed", "arguments too large", "invalid JSON arguments", "required property missing", "unknown property"]) assert.ok(named.includes(needle), needle);
  });
  it("the model-tool-error fixture is exactly what its exporter records", () => {
    const text = readFileSync(fixturePath("toolcall", "model-tool-error"), "utf8");
    assert.equal(text, fixtureText(buildModelToolError()), "fixtures/parity/toolcall/model-tool-error.json is stale: run scripts/parity/export-model-tool-error.ts");
    assert.ok(text.length < 1_048_576, "a fixture file stays under 1 MiB");
  });
  it("the Rust table of shipped tools is the one generated from the vector", () => {
    const rows = JSON.parse(readFileSync(fixturePath("toolcall", "tables"), "utf8")).firstParty as string[][];
    const rust = readFileSync(new URL("../../crates/plur1bus-core/src/toolcall/first_party_table.rs", import.meta.url), "utf8");
    assert.ok(rows.length > 50);
    for (const row of rows) assert.ok(rust.includes(`    (${row.slice(0, 5).map(x => JSON.stringify(x)).join(", ")}),\n`), `${row[0]}: run scripts/parity/toolcall-first-party.mjs`);
    assert.equal(rust.split("\n").filter(line => line.startsWith("    (")).length, rows.length);
  });
});

describe("skill tool vectors (P4-K K9b, plan P4-42)", { skip: process.platform === "win32" ? "the skill-tools scenarios need symlinks and FIFOs to record" : false }, () => {
  it("the committed fixture is exactly what the exporter records", async () => {
    const text = readFileSync(fixturePath("toolcall", "skill-tools"), "utf8");
    assert.equal(text, fixtureText(await buildSkillTools()), "fixtures/parity/toolcall/skill-tools.json is stale: run scripts/parity/export-skill-tools.ts");
    assert.ok(text.length < 1_048_576, "a fixture file stays under 1 MiB");
  });
});

describe("capability index vectors (P4-K K9b, plan P4-42)", () => {
  it("the committed fixtures are exactly what the exporter records", async () => {
    const built = await buildCapabilityVectors() as any;
    for (const [name, data] of Object.entries(built)) {
      const text = readFileSync(fixturePath("capabilities", name), "utf8");
      assert.equal(text, fixtureText(data), `fixtures/parity/capabilities/${name}.json is stale: run scripts/parity/export-capabilities.ts`);
      assert.ok(text.length < 1_048_576, `${name}: a fixture file stays under 1 MiB`);
    }
  });
  it("the live-index fixture is exactly what its exporter records", async () => {
    const text = readFileSync(fixturePath("capabilities", "live-index"), "utf8");
    assert.equal(text, fixtureText(await buildLiveIndex()), "fixtures/parity/capabilities/live-index.json is stale: run scripts/parity/export-live-index.ts");
    assert.ok(text.length < 1_048_576, "a fixture file stays under 1 MiB");
  });
  it("Math.log of this machine is the recorded routine to within one unit in the last place (K9b-D1)", () => {
    // The vector holds fdlibm's routine with every operation rounded on its own. A V8 compiled with fused multiply-add
    // (arm64) differs from it in the last place for a few arguments in a hundred; no V8 may differ by more.
    const bits = (x: number) => new BigUint64Array(new Float64Array([x]).buffer)[0]!;
    let differ = 0;
    for (const x of logArguments()) {
      const a = Math.log(x), b = fdlibmLog(x);
      if (Object.is(a, b)) continue;
      differ++;
      const distance = bits(a) - bits(b);
      assert.ok(distance === 1n || distance === -1n, `Math.log(${x}) is ${a}, the routine gives ${b}`);
    }
    assert.ok(differ < logArguments().length / 10, `${differ} arguments differ`);
  });
});

describe("ACP server transcripts (P4-K K8, plan P4-71)", () => {
  it("the committed transcripts are exactly what the exporter records, and every file stays under 1 MiB", async () => {
    const built = await buildAcpVectors() as Record<string, { scenarios: { name: string; transcript: string[] }[] }>;
    let scenarios = 0;
    for (const [name, data] of Object.entries(built)) {
      const text = readFileSync(fixturePath("acp", name), "utf8");
      assert.equal(text, fixtureText(data), `fixtures/parity/acp/${name}.json is stale: run scripts/parity/export-acp.ts`);
      assert.ok(Buffer.byteLength(text) < 1_048_576, `${name}: a fixture file stays under 1 MiB`);
      scenarios += data.scenarios.length;
      // Only the scenario about a turn that never ends after the end of input is meant to leave `run()` pending.
      for (const sc of data.scenarios) assert.equal(sc.transcript.includes("HUNG"), sc.name === "end-of-input-with-a-turn-that-ignores-cancel", `${sc.name}: the server finished`);
    }
    assert.ok(scenarios >= 400, `${scenarios} scenarios`);
  });
});

describe("tool vectors (P4-K K10a, plan P4-30)", () => {
  it("the pure fixtures are exactly what the exporter records", () => {
    const built = buildToolsPureVectors() as any;
    assert.deepEqual(Object.keys(built), ["exec-rules", "fs-meta"]);
    for (const name of Object.keys(built)) {
      assert.equal(readFileSync(fixturePath("tools", name), "utf8"), fixtureText(built[name]), `fixtures/parity/tools/${name}.json is stale: run scripts/parity/export-tools.ts`);
    }
    assert.ok(built["exec-rules"].patterns.some((p: any) => !p.subset && p.matches.some(Boolean)), "a pattern outside the Rust subset that TypeScript reads");
  });
  it("the fixtures recorded against real files are exactly what the exporter records", { skip: process.platform === TOOLS_OS ? false : `fixtures/parity/tools/{exec-runs,fs}.json are recorded on ${TOOLS_OS}; this is ${process.platform}, so they are not compared` }, async () => {
    const built = await buildToolsRecordedVectors() as any;
    assert.deepEqual(Object.keys(built), ["exec-runs", "fs"]);
    for (const name of Object.keys(built)) {
      assert.equal(readFileSync(fixturePath("tools", name), "utf8"), fixtureText(built[name]), `fixtures/parity/tools/${name}.json is stale: run scripts/parity/export-tools.ts on ${TOOLS_OS}`);
    }
    assert.ok(built.fs.cases.some((c: any) => c.divergence === "K10-D2"));
  });
});

describe("jobs vectors (P4-K K7a, plan P4-51)", () => {
  it("the committed fixtures are exactly what the exporter records, and every file stays under 1 MiB", async () => {
    const built = await buildJobsVectors() as { cron: any; user: any[]; rpc: any[]; system: any[] };
    assert.deepEqual(Object.keys(built).sort(), ["cron", "rpc", "system", "user"]);
    for (const [name, data] of Object.entries(built)) {
      const text = readFileSync(fixturePath("jobs", name), "utf8");
      assert.equal(text, fixtureText(data), `fixtures/parity/jobs/${name}.json is stale: run scripts/parity/export-jobs.ts`);
      assert.ok(Buffer.byteLength(text) < 1_048_576, `${name}: a fixture file stays under 1 MiB`);
    }
    // The boundaries the port must keep are scenarios, and randomness is scripted, never recorded.
    const user = built.user.map((s: any) => s.name);
    for (const n of ["create-rights", "update", "rights-lost-since-the-job-was-saved", "skipped-runs-switch-the-job-off", "concurrency-through-the-turn", "restart-abandons-interrupted-runs"]) assert.ok(user.includes(n), n);
    assert.deepEqual(built.rpc.map((s: any) => s.name), ["rpc-list", "rpc-history", "rpc-run"]);
    const system = built.system.map((s: any) => s.name);
    for (const n of ["exclusive-lock", "ledger-lenient-reader", "ledger-rotation", "arm-and-fire"]) assert.ok(system.includes(n), n);
    assert.ok(built.cron.next.some((c: any) => c.tz === "Europe/Berlin" && c.next !== null) && built.cron.parse.some((c: any) => c.err !== undefined));
  });
});

describe("collab handoff vectors (P4-K K6a, plan P4-50)", () => {
  it("the fixture is current and under 1 MiB", async () => {
    const { handoff } = await buildCollabHandoffVectors();
    const committed = readFileSync(fixturePath("collab", "handoff"), "utf8");
    assert.equal(committed, fixtureText(handoff), "collab/handoff.json is stale: run scripts/parity/export-collab-handoff.ts");
    assert.ok(Buffer.byteLength(committed) < 1_048_576);
  });
});

describe("collab service vectors (P4-K K6a, plan P4-50)", () => {
  it("the fixtures are current and under 1 MiB", async () => {
    for (const [name, fixture] of Object.entries(await buildCollabServiceVectors())) {
      const committed = readFileSync(fixturePath("collab", name), "utf8");
      assert.equal(committed, fixtureText(fixture), "collab/" + name + ".json is stale: run scripts/parity/export-collab-service.ts");
      assert.ok(Buffer.byteLength(committed) < 1_048_576, name);
    }
  });
});

describe("collab turn-local delegation vectors (P4-K K6a, plan P4-50)", () => {
  it("the fixture is current and under 1 MiB", async () => {
    const { delegations } = await buildCollabDelegationVectors();
    const committed = readFileSync(fixturePath("collab", "delegations"), "utf8");
    assert.equal(committed, fixtureText(delegations), "collab/delegations.json is stale: run scripts/parity/export-collab-delegations.ts");
    assert.ok(Buffer.byteLength(committed) < 1_048_576);
  });
});

describe("collab delegate run vectors (P4-K K6a, plan P4-50)", () => {
  it("the fixture is current and under 1 MiB", async () => {
    const { run } = await buildCollabRunVectors();
    const committed = readFileSync(fixturePath("collab", "run"), "utf8");
    assert.equal(committed, fixtureText(run), "collab/run.json is stale: run scripts/parity/export-collab-run.ts");
    assert.ok(Buffer.byteLength(committed) < 1_048_576);
  });
});

describe("coding parity vectors (P4-K K6b, plan P4-50)", () => {
  const exporters = [
    ["the verifier plan", buildCodingVerifierVectors],
    ["the gate", buildCodingGateVectors],
    ["the card surface", buildCodingSurfaceVectors],
    ["chat promotion", buildChatPromotionVectors],
    ["the runner", buildCodingRunnerVectors],
    ["coding roots", buildCodingRootVectors],
    ["coding sessions", buildCodingSessionVectors],
    ["the profile and tool diffs", async () => {
      const { buildCodingActionVectors } = await import("./export-coding-actions.ts");
      return buildCodingActionVectors();
    }],
    ["the Git view", buildCodingGitViewVectors],
    ["advisory checks", buildCodingCheckVectors],
  ] as const;
  for (const [label, build] of exporters) {
    it(label + " fixtures are current and under 1 MiB", async () => {
      for (const [name, fixture] of Object.entries(await build())) {
        const committed = readFileSync(fixturePath("coding", name), "utf8");
        assert.equal(committed, fixtureText(fixture), "coding/" + name + ".json is stale");
        assert.ok(Buffer.byteLength(committed) < 1_048_576, name);
      }
    });
  }
});

describe("dreaming candidate vectors (P4-K K7b, plan P4-51)", () => {
  it("the recorded candidate guards are current and under 1 MiB", async () => {
    const { buildDreamCandidateVectors } = await import("./export-dream-candidates.ts");
    const { candidates } = buildDreamCandidateVectors();
    const actual = readFileSync(fixturePath("dreams", "candidates"), "utf8");
    assert.equal(actual, fixtureText(candidates), "dreams/candidates.json is stale");
    assert.ok(Buffer.byteLength(actual) < 1_048_576);
  });
});

describe("dreaming store vectors (P4-K K7b, plan P4-51)", () => {
  it("the recorded SQLite transitions are current and under 1 MiB", async () => {
    const { buildDreamStoreVectors } = await import("./export-dream-store.ts");
    const { store } = buildDreamStoreVectors();
    const actual = readFileSync(fixturePath("dreams", "store"), "utf8");
    assert.equal(actual, fixtureText(store), "dreams/store.json is stale");
    assert.ok(Buffer.byteLength(actual) < 1_048_576);
  });
});

describe("dreaming schedule plans (P4-K K7b, plan P4-51)", () => {
  it("the recorded plans are current and under 1 MiB", async () => {
    const { buildDreamPlanVectors } = await import("./export-dream-plans.ts");
    const actual = readFileSync(fixturePath("dreams", "plans"), "utf8");
    assert.equal(actual, fixtureText(buildDreamPlanVectors().plans), "dreams/plans.json is stale");
    assert.ok(Buffer.byteLength(actual) < 1_048_576);
  });
});

describe("dreaming run outcomes (P4-K K7b, plan P4-51)", () => {
  it("the recorded run outcomes are current and under 1 MiB", async () => {
    const { buildDreamRunVectors } = await import("./export-dream-runs.ts");
    const actual = readFileSync(fixturePath("dreams", "runs"), "utf8");
    assert.equal(actual, fixtureText((await buildDreamRunVectors()).runs), "dreams/runs.json is stale");
    assert.ok(Buffer.byteLength(actual) < 1_048_576);
  });
});

describe("learning transcript selection (P4-K K7b, plan P4-51)", () => {
  it("the recorded selections are current and under 1 MiB", async () => {
    const { buildLearnSelectionVectors } = await import("./export-learn-selection.ts");
    const actual = readFileSync(fixturePath("learn", "selection"), "utf8");
    assert.equal(actual, fixtureText(buildLearnSelectionVectors().selection), "learn/selection.json is stale");
    assert.ok(Buffer.byteLength(actual) < 1_048_576);
  });
});

describe("dreaming lifecycle (P4-K K7b, plan P4-51)", () => {
  it("the recorded lifecycle is current and under 1 MiB", async () => {
    const { buildDreamLifecycleVectors } = await import("./export-dream-lifecycle.ts");
    const actual = readFileSync(fixturePath("dreams", "lifecycle"), "utf8");
    assert.equal(actual, fixtureText((await buildDreamLifecycleVectors()).lifecycle), "dreams/lifecycle.json is stale");
    assert.ok(Buffer.byteLength(actual) < 1_048_576);
  });
});

describe("learning run store (P4-K K7b, plan P4-51)", () => {
  it("the recorded learn store transitions are current and under 1 MiB", async () => {
    const { buildLearnStoreVectors } = await import("./export-learn-store.ts");
    const actual = readFileSync(fixturePath("learn", "store"), "utf8");
    assert.equal(actual, fixtureText(buildLearnStoreVectors().store), "learn/store.json is stale");
    assert.ok(Buffer.byteLength(actual) < 1_048_576);
  });
});

describe("dreaming promotion receipts (P4-K K7b, plan P4-51)", () => {
  it("the recorded promotion receipts are current and under 1 MiB", async () => {
    const { buildDreamPromotionVectors } = await import("./export-dream-promotions.ts");
    const actual = readFileSync(fixturePath("dreams", "promotions"), "utf8");
    assert.equal(actual, fixtureText((await buildDreamPromotionVectors()).promotions), "dreams/promotions.json is stale");
    assert.ok(Buffer.byteLength(actual) < 1_048_576);
  });
});

describe("learning finding extraction and shadow scoring (P4-K K7b, plan P4-51)", () => {
  it("the recorded learning rules are current and under 1 MiB", async () => {
    const { buildLearnFindingVectors } = await import("./export-learn-findings.ts");
    const actual = readFileSync(fixturePath("learn", "findings"), "utf8");
    assert.equal(actual, fixtureText(buildLearnFindingVectors().findings), "learn/findings.json is stale");
    assert.ok(Buffer.byteLength(actual) < 1_048_576);
  });
});

describe("learning finding lifecycle (P4-K K7b, plan P4-51)", () => {
  it("the recorded decisions and predictions are current and under 1 MiB", async () => {
    const { buildLearnFindingStoreVectors } = await import("./export-learn-finding-store.ts");
    const actual = readFileSync(fixturePath("learn", "finding-store"), "utf8");
    assert.equal(actual, fixtureText(buildLearnFindingStoreVectors()["finding-store"]), "learn/finding-store.json is stale");
    assert.ok(Buffer.byteLength(actual) < 1_048_576);
  });
});

describe("learning evidence review (P4-K K7b, plan P4-51)", () => {
  it("the recorded review rules are current and under 1 MiB", async () => {
    const { buildLearnReviewVectors } = await import("./export-learn-review.ts");
    const actual = readFileSync(fixturePath("learn", "review"), "utf8");
    assert.equal(actual, fixtureText((await buildLearnReviewVectors()).review), "learn/review.json is stale");
    assert.ok(Buffer.byteLength(actual) < 1_048_576);
  });
});

describe("learning runs (P4-K K7b, plan P4-51)", () => {
  it("the recorded run workflow is current and under 1 MiB", async () => {
    const { buildLearnRunVectors } = await import("./export-learn-runs.ts");
    const actual = readFileSync(fixturePath("learn", "runs"), "utf8");
    assert.equal(actual, fixtureText((await buildLearnRunVectors()).runs), "learn/runs.json is stale");
    assert.ok(Buffer.byteLength(actual) < 1_048_576);
  });
});

describe("content-free installation learning (P4-K K7b, plan P4-51)", () => {
  it("the recorded installation rules are current and under 1 MiB", async () => {
    const { buildLearnInstallationVectors } = await import("./export-learn-installation.ts");
    const actual = readFileSync(fixturePath("learn", "installation"), "utf8");
    assert.equal(actual, fixtureText(buildLearnInstallationVectors().installation), "learn/installation.json is stale");
    assert.ok(Buffer.byteLength(actual) < 1_048_576);
  });
});

describe("explicit learning decisions (P4-K K7b, plan P4-51)", () => {
  it("the recorded review actions are current and under 1 MiB", async () => {
    const { buildLearnDecisionVectors } = await import("./export-learn-decisions.ts");
    const actual = readFileSync(fixturePath("learn", "decisions"), "utf8");
    assert.equal(actual, fixtureText((await buildLearnDecisionVectors()).decisions), "learn/decisions.json is stale");
    assert.ok(Buffer.byteLength(actual) < 1_048_576);
  });
});

describe("learning settings and UTC schedules (P4-K K7b, plan P4-51)", () => {
  it("the recorded settings are current and under 1 MiB", async () => {
    const { buildLearnConfigVectors } = await import("./export-learn-config.ts");
    const actual = readFileSync(fixturePath("learn", "config"), "utf8");
    assert.equal(actual, fixtureText(buildLearnConfigVectors().config), "learn/config.json is stale");
    assert.ok(Buffer.byteLength(actual) < 1_048_576);
  });
});

describe("procedural learning handoff (P4-K K7b, plan P4-51)", () => {
  it("the recorded handoff is current and under 1 MiB", async () => {
    const { buildLearnHandoffVectors } = await import("./export-learn-handoff.ts");
    const actual = readFileSync(fixturePath("learn", "handoff"), "utf8");
    assert.equal(actual, fixtureText((await buildLearnHandoffVectors()).handoff), "learn/handoff.json is stale");
    assert.ok(Buffer.byteLength(actual) < 1_048_576);
  });
});

describe("dreaming candidate source (P4-K K7b, plan P4-51)", () => {
  it("the recorded candidate source is current and under 1 MiB", async () => {
    const { buildDreamSourceVectors } = await import("./export-dream-source.ts");
    const actual = readFileSync(fixturePath("dreams", "source"), "utf8");
    assert.equal(actual, fixtureText((await buildDreamSourceVectors()).source), "dreams/source.json is stale");
    assert.ok(Buffer.byteLength(actual) < 1_048_576);
  });
});

describe("skill mining execution evidence (P4-K K7c, plan P4-51)", () => {
  it("the recorded execution proofs are current and under 1 MiB", async () => {
    const { buildSkillEvidenceVectors } = await import("./export-skill-evidence.ts");
    const actual = readFileSync(fixturePath("skills", "evidence"), "utf8");
    assert.equal(actual, fixtureText(buildSkillEvidenceVectors().evidence), "skills/evidence.json is stale");
    assert.ok(Buffer.byteLength(actual) < 1_048_576);
  });
});

describe("scoped skill mining (P4-K K7c, plan P4-51)", () => {
  it("the recorded mining workflows are current and under 1 MiB", async () => {
    const { buildSkillMiningVectors } = await import("./export-skill-mining.ts");
    const actual = readFileSync(fixturePath("skills", "mining"), "utf8");
    assert.equal(actual, fixtureText(buildSkillMiningVectors().mining), "skills/mining.json is stale");
    assert.ok(Buffer.byteLength(actual) < 1_048_576);
  });
});

describe("human skill review (P4-K K7c, plan P4-51)", () => {
  it("the recorded skill approvals are current and under 1 MiB", async () => {
    const { buildSkillReviewVectors } = await import("./export-skill-review.ts");
    const actual = readFileSync(fixturePath("skills", "review"), "utf8");
    assert.equal(actual, fixtureText((await buildSkillReviewVectors()).review), "skills/review.json is stale");
    assert.ok(Buffer.byteLength(actual) < 1_048_576);
  });
});

describe("skill proposal queue (P4-K K7c, plan P4-51)", () => {
  it("the recorded proposal-only workflow is current and under 1 MiB", async () => {
    const { buildSkillProposalVectors } = await import("./export-skill-proposals.ts");
    const actual = readFileSync(fixturePath("skills", "proposals"), "utf8");
    assert.equal(actual, fixtureText((await buildSkillProposalVectors()).proposals), "skills/proposals.json is stale");
    assert.ok(Buffer.byteLength(actual) < 1_048_576);
  });
});

describe("self-knowledge artifact provenance (P4-K K7c, plan P4-51)", () => {
  it("the recorded attribution and approval rules are current and under 1 MiB", async () => {
    const { buildArtifactProvenanceVectors } = await import("./export-artifact-provenance.ts");
    const actual = readFileSync(fixturePath("skills", "artifact-provenance"), "utf8");
    assert.equal(actual, fixtureText((await buildArtifactProvenanceVectors())["artifact-provenance"]), "skills/artifact-provenance.json is stale");
    assert.ok(Buffer.byteLength(actual) < 1_048_576);
  });
});

describe("knowledge file migration (P4-K K7c, plan P4-51)", () => {
  it("the recorded knowledge transitions are current and under 1 MiB", async () => {
    const { buildKnowledgeFileVectors } = await import("./export-knowledge-file.ts");
    const actual = readFileSync(fixturePath("knowledge", "file"), "utf8");
    assert.equal(actual, fixtureText(buildKnowledgeFileVectors().file), "knowledge/file.json is stale");
    assert.ok(Buffer.byteLength(actual) < 1_048_576);
  });
});

describe("knowledge update scheduling (P4-K K7c, plan P4-51)", () => {
  it("the recorded job state transitions are current and under 1 MiB", async () => {
    const { buildKnowledgeJobVectors } = await import("./export-knowledge-job.ts");
    const actual = readFileSync(fixturePath("knowledge", "job"), "utf8");
    assert.equal(actual, fixtureText((await buildKnowledgeJobVectors()).job), "knowledge/job.json is stale");
    assert.ok(Buffer.byteLength(actual) < 1_048_576);
  });
});

describe("media reference search (P4-K K7c, plan P4-51)", () => {
  it("the recorded scope and rank rules are current and under 1 MiB", async () => {
    const { buildMediaIndexVectors } = await import("./export-media-index.ts");
    const actual = readFileSync(fixturePath("media", "index"), "utf8");
    assert.equal(actual, fixtureText((await buildMediaIndexVectors()).index), "media/index.json is stale");
    assert.ok(Buffer.byteLength(actual) < 1_048_576);
  });
});

describe("media encoding admission (P4-K K7c, plan P4-51)", () => {
  it("the recorded policy and reservations are current and under 1 MiB", async () => {
    const { buildMediaAdmissionVectors } = await import("./export-media-admission.ts");
    const actual = readFileSync(fixturePath("media", "admission"), "utf8");
    assert.equal(actual, fixtureText((await buildMediaAdmissionVectors()).admission), "media/admission.json is stale");
    assert.ok(Buffer.byteLength(actual) < 1_048_576);
  });
});

describe("media captions (P4-K K7c, plan P4-51)", () => {
  it("the recorded caption choices and fake cloud wire are current and under 1 MiB", async () => {
    const { buildMediaCaptionVectors } = await import("./export-media-caption.ts");
    const actual = readFileSync(fixturePath("media", "caption"), "utf8");
    assert.equal(actual, fixtureText((await buildMediaCaptionVectors()).caption), "media/caption.json is stale");
    assert.ok(Buffer.byteLength(actual) < 1_048_576);
  });
});

describe("media backfill (P4-K K7c, plan P4-51)", () => {
  it("the recorded backfill controls and fingerprint state are current and under 1 MiB", async () => {
    const { buildMediaBackfillVectors } = await import("./export-media-backfill.ts");
    const actual = readFileSync(fixturePath("media", "backfill"), "utf8");
    assert.equal(actual, fixtureText((await buildMediaBackfillVectors()).backfill), "media/backfill.json is stale");
    assert.ok(Buffer.byteLength(actual) < 1_048_576);
  });
});

describe("media codec limits (P4-K K7c, plan P4-51)", () => {
  it("the recorded codec plans and fake outputs are current and under 1 MiB", async () => {
    const { buildMediaCodecVectors } = await import("./export-media-codec.ts");
    const actual = readFileSync(fixturePath("media", "codec"), "utf8");
    assert.equal(actual, fixtureText((await buildMediaCodecVectors()).codec), "media/codec.json is stale");
    assert.ok(Buffer.byteLength(actual) < 1_048_576);
  });
});

describe("stored media work (P4-K K7c, plan P4-51)", () => {
  it("the recorded queue outcomes are current and under 1 MiB", async () => {
    const { buildMediaHookVectors } = await import("./export-media-hook.ts");
    const actual = readFileSync(fixturePath("media", "hook"), "utf8");
    assert.equal(actual, fixtureText((await buildMediaHookVectors()).hook), "media/hook.json is stale");
    assert.ok(Buffer.byteLength(actual) < 1_048_576);
  });
});

describe("media model configuration (P4-K K7c, plan P4-51)", () => {
  it("the recorded catalog and validation vectors are current and under 1 MiB", async () => {
    const { buildMediaConfigVectors } = await import("./export-media-config.ts");
    const actual = readFileSync(fixturePath("media", "config"), "utf8");
    assert.equal(actual, fixtureText((await buildMediaConfigVectors()).config), "media/config.json is stale");
    assert.ok(Buffer.byteLength(actual) < 1_048_576);
  });
});

describe("federation loan model (P4-K K6c, plan P4-50)", () => {
  it("the recorded deadline and lease state vectors are current and under 1 MiB", async () => {
    const { buildFederationLoanVectors } = await import("./export-federation-loan.ts");
    const actual = readFileSync(fixturePath("federation", "loan"), "utf8");
    assert.equal(actual, fixtureText(buildFederationLoanVectors().loan), "federation/loan.json is stale");
    assert.ok(Buffer.byteLength(actual) < 1_048_576);
  });
});

describe("federation memory descriptors (P4-K K6c, plan P4-50)", () => {
  it("the recorded descriptors and replay receipts are current and under 1 MiB", async () => {
    const { buildFederationMemoryVectors } = await import("./export-federation-memory.ts");
    const actual = readFileSync(fixturePath("federation", "memory"), "utf8");
    assert.equal(actual, fixtureText(buildFederationMemoryVectors().memory), "federation/memory.json is stale");
    assert.ok(Buffer.byteLength(actual) < 1_048_576);
  });
});

describe("external turn library (P4-K K6c, plan P4-50)", () => {
  it("the recorded scoped turns are current and under 1 MiB", async () => {
    const { buildExternalTurnVectors } = await import("./export-external-turn.ts");
    const actual = readFileSync(fixturePath("external-turn", "turn"), "utf8");
    assert.equal(actual, fixtureText((await buildExternalTurnVectors()).turn), "external-turn/turn.json is stale");
    assert.ok(Buffer.byteLength(actual) < 1_048_576);
  });
});

describe("Hostctl contract (P4-K K10b)", () => {
  it("keeps the catalog, configuration and literal vectors current", async () => {
    const { buildHostctl } = await import("./export-hostctl.ts");
    const actual = readFileSync(fixturePath("host", "hostctl"), "utf8");
    assert.equal(actual, fixtureText(await buildHostctl()), "host/hostctl.json is stale");
    assert.ok(Buffer.byteLength(actual) < 1_048_576);
  });
});

describe("media video codec process port (P4-W W4)", () => {
  it("matches the production TypeScript process calls", async () => {
    const { recordVideoProcess } = await import("./export-media-video.ts");
    const expected = fixtureText((await recordVideoProcess())["video-process"]);
    assert.equal(readFileSync(fixturePath("media", "video-process"), "utf8"), expected);
  });
});

describe("media image codecs (P4-W W4)", () => {
  it("matches the production TypeScript metadata and verification recordings", async () => {
    const { recordMediaImages } = await import("./export-media-images.ts");
    const expected = fixtureText(recordMediaImages()["image-codecs"]);
    assert.equal(readFileSync(fixturePath("media", "image-codecs"), "utf8"), expected);
  });
});

describe("media output publication (P4-W W4)", () => {
  it("matches the TypeScript manifest, charge, refusal and pruning recording", async () => {
    const { recordMediaStore } = await import("./export-media-store.ts");
    const expected = fixtureText((await recordMediaStore())["output-store"]);
    assert.equal(readFileSync(fixturePath("media", "output-store"), "utf8"), expected);
  });
});

describe("media upload publication (P4-W W4)", () => {
  it("matches the TypeScript upload, charge, raw bytes and deletion recording", async () => {
    const { recordMediaUpload } = await import("./export-media-upload.ts");
    const expected = fixtureText((await recordMediaUpload())["upload-store"]);
    assert.equal(readFileSync(fixturePath("media", "upload-store"), "utf8"), expected);
  });
});

describe("media video publication (P4-W W4)", () => {
  it("matches the TypeScript video store, processor and byte accounting", async () => {
    const { recordMediaVideoStore } = await import("./export-media-video-store.ts");
    const expected = fixtureText((await recordMediaVideoStore())["video-store"]);
    assert.equal(readFileSync(fixturePath("media", "video-store"), "utf8"), expected);
  });
});

describe("media job orchestration (P4-W W4)", () => {
  it("matches the production TypeScript job and budget port calls", async () => {
    const { recordMediaJobs } = await import("./export-media-jobs.ts");
    const expected = fixtureText((await recordMediaJobs())["job-runner"]);
    assert.equal(readFileSync(fixturePath("media", "job-runner"), "utf8"), expected);
  });
});

describe("document template assembly (P4-W W4)", () => {
  it("matches the authored TypeScript layouts before embedded fonts", async () => {
    const { recordDocumentTemplates } = await import("./export-document-templates.ts");
    const expected = fixtureText(recordDocumentTemplates().templates);
    assert.equal(readFileSync(fixturePath("documents", "templates"), "utf8"), expected);
  });
  it("matches the full HTML with all shipped font faces", async () => {
    const { recordDocumentTemplates } = await import("./export-document-templates.ts");
    const expected = fixtureText(recordDocumentTemplates()["render-html"]);
    assert.equal(readFileSync(fixturePath("documents", "render-html"), "utf8"), expected);
  });
});

describe("document checks (P4-W W4)", () => {
  it("matches the generated findings and authored Chromium check script", async () => {
    const { recordDocumentChecks } = await import("./export-document-checks.ts");
    assert.equal(readFileSync(fixturePath("documents", "checks"), "utf8"),
      fixtureText(recordDocumentChecks().checks));
  });
});

describe("Chromium rendering commands (P4-W W4)", () => {
  it("matches the TypeScript PDF and screenshot command parameters", async () => {
    const { recordDocumentCdp } = await import("./export-document-cdp.ts");
    const expected = fixtureText((await recordDocumentCdp()).cdp);
    assert.equal(readFileSync(fixturePath("documents", "cdp"), "utf8"), expected);
  });
});
