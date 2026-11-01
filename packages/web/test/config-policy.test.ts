// The browser policy must interpret the schema generator's array paths and literal map member names.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { configHasPastedKey, configNeedsReplacement, configPolicyOf, configReferenceWarning, isConfigReference, redactConfigView } from "../src/config-policy.ts";
import { CONFIG_POLICY_SCHEMA } from "../src/palette/settings-index.ts";

// Run the real consumers with cloned generated metadata so an omitted annotation needs no canonical-schema fixture change.
for (const boundary of ["projection", "replacement", "palette-load", "palette-index"] as const) {
  test(`reference declarations protect ${boundary} when x-sensitive is absent`, () => {
    execFileSync(process.execPath, ["--experimental-strip-types", "--conditions=source", "--no-warnings=ExperimentalWarning", "--input-type=module", "--eval", `
      import assert from "node:assert/strict";
      import { randomBytes, randomUUID } from "node:crypto";
      const metadata = await import(${JSON.stringify(new URL("../src/palette/settings-index.ts", import.meta.url).href)});
      const key = "voice.providers.elevenlabs.apiKeyRef";
      const stripSensitivity = node => {
        if (!node || typeof node !== "object") return;
        delete node["x-sensitive"];
        for (const child of Object.values(node)) stripSensitivity(child);
      };
      const schema = metadata.CONFIG_POLICY_SCHEMA;
      stripSensitivity(schema);
      schema.properties.referenceEndpoint = {
        type: "string", "x-url-credentials": true, "x-secret-reference": { $ref: "#/$defs/backupSecretName" },
      };
      const settings = metadata.SETTINGS.map(({ sensitive, ...row }) => row);
      const policy = await import(${JSON.stringify(new URL("../src/config-policy.ts", import.meta.url).href)});
      const palette = await import(${JSON.stringify(new URL("../src/palette/index-build.ts", import.meta.url).href)});
      const literal = "sk-" + randomBytes(24).toString("base64url");
      const name = "voice.elevenlabs." + randomUUID().slice(0, 8);
      assert.equal(policy.configPolicyOf(key).sensitive, false);
      switch (${JSON.stringify(boundary)}) {
        case "projection": {
          assert.equal(policy.redactConfigView(literal, key), "••••");
          assert.equal(policy.redactConfigView(name, key), name);
          assert.deepEqual(policy.redactConfigView({ source: "store", provider: "default", id: literal }, "engine.embedding.apiKey"),
            { source: "••••", provider: "••••", id: "••••" });
          assert.equal(policy.redactConfigView(123, key), 0);
          assert.equal(policy.redactConfigView(true, key), false);
          assert.equal(policy.redactConfigView("https://public.example/path?ordinary=" + literal, "referenceEndpoint"),
            "https://public.example/path?ordinary=••••");
          break;
        }
        case "replacement":
          assert.equal(policy.configContainsCredentials(key), true);
          const model = await import(${JSON.stringify(new URL("../src/pages/settings/config/model.ts", import.meta.url).href)});
          assert.deepEqual(model.initialDraft([{ key, kind: "string", value: literal, def: undefined, restartClass: "live", readOnly: false }]), {});
          break;
        case "palette-load": {
          const config = value => ({ voice: { providers: { elevenlabs: { apiKeyRef: value } } } });
          assert.equal(palette.settingValues(config(literal), settings)[key], undefined);
          assert.equal(palette.settingValues(config(name), settings)[key], name);
          break;
        }
        case "palette-index":
          assert.equal(palette.buildIndex({ lang: "en", settings, values: { [key]: literal } }).find(row => row.key === key).value, undefined);
          assert.equal(palette.buildIndex({ lang: "en", settings, values: { [key]: name } }).find(row => row.key === key).value, name);
          break;
      }
    `], { stdio: "pipe" });
  });
}

test("browser disclosure resolves generated array policy paths", () => {
  for (const key of ["providers.media.adapters.0.secretRef", "providers.mcp.servers.0.authSecret",
    "engine.embedding.routes.0.provider.apiKey"])
    assert.equal(configPolicyOf(key).sensitive, true, key);
  for (const key of ["providers.media.adapters.0.baseUrl", "providers.mcp.servers.0.transport.url",
    "engine.embedding.routes.0.provider.baseUrl"])
    assert.equal(configPolicyOf(key).urlCredentials, true, key);
});

test("browser projection conceals array members and dotted map names without changing public hosts or types", () => {
  const secret = `sk-${randomBytes(24).toString("base64url")}`, query = randomUUID();
  const endpoint = `https://provider.example/public/path?ordinary=${query}`;
  const value = { providers: {
    "vendor.with.dots": { profile: { secret_ref: secret, extra_headers: { ordinary: secret }, base_url: endpoint } },
    media: { adapters: [{ secretRef: secret, baseUrl: endpoint, model: "public-model" }] },
    mcp: { servers: [{ authSecret: secret, transport: { headers: { ordinary: secret }, url: endpoint } }] },
  }, maxTokens: 4096, password: "public-label" };
  const projected = redactConfigView(value) as typeof value;
  const text = JSON.stringify(projected);
  for (const canary of [secret, query]) assert.ok(!text.includes(canary), "a declared value escaped browser projection");
  assert.ok(text.includes("https://provider.example/public/path?ordinary="));
  assert.equal(projected.providers.media.adapters[0]!.model, "public-model");
  assert.equal(projected.maxTokens, 4096);
  assert.equal(projected.password, "••••");
  assert.equal(Array.isArray(projected.providers.mcp.servers), true);
});

test("pasted-key hints follow reference scope and keep valid source paths free of warnings", () => {
  const literal = `sk-${randomBytes(24).toString("base64url")}`;
  assert.equal(configHasPastedKey(literal, "voice.providers.elevenlabs.apiKeyRef"), true);
  assert.equal(configHasPastedKey({ providers: { "vendor.with.dots": { profile: { secret_ref: literal } } } }), true);
  assert.equal(configHasPastedKey({ provider: { apiKeyRef: literal } }, "engine.embedding.routes[]"), true);
  assert.equal(configHasPastedKey(literal, "engine.merging.headers.ordinary"), false);
  assert.equal(configHasPastedKey({ unknown: { token: literal } }), false);

  const path = `/var/lib/${randomUUID()}/${randomUUID()}/${randomUUID()}/federated-token.json`;
  assert.equal(configHasPastedKey(path, "auth.openai.federated.file"), false);
  assert.equal(configHasPastedKey({ source: "file", provider: "default", id: path }, "engine.embedding.apiKey"), false);
  assert.equal(configHasPastedKey(`voice.elevenlabs.${randomUUID().slice(0, 8)}`, "voice.providers.elevenlabs.apiKeyRef"), false);
});

test("structured browser paths distinguish literal dotted members from nested public fields", () => {
  const name = `voice.elevenlabs.${randomUUID().slice(0, 8)}`;
  assert.equal(redactConfigView(name, ["providers", "vendor.with.dots", "profile", "secret_ref"]), name);
  const schema = { type: "object", properties: {
    "public.with.dots": { type: "string" }, public: { type: "object", properties: { with: {
      type: "object", properties: { dots: { type: "string", "x-sensitive": true } },
    } } },
  } };
  assert.equal(redactConfigView("public-model", ["public.with.dots"], schema), "public-model");
  assert.equal(redactConfigView("public-model", ["public", "with", "dots"], schema), "••••");
});

test("invalid reference shapes warn without revealing values and complete safe references remain readable", () => {
  const key = "engine.embedding.apiKey";
  const valid = { source: "env", provider: "default", id: "OPENAI_API_KEY" };
  assert.equal(configReferenceWarning(valid, key), undefined);
  for (const value of ["bad reference!", { source: "env", id: "OPENAI_API_KEY" }, { ...valid, extra: "opaque" }]) {
    assert.equal(isConfigReference(value, key), false);
    assert.equal(configReferenceWarning(value, key), "invalidReference");
    assert.ok(!JSON.stringify(redactConfigView(value, key)).includes("OPENAI_API_KEY"));
  }
  assert.equal(configReferenceWarning(`sk-${randomBytes(24).toString("base64url")}`, key), "pastedKey");
  assert.equal(configReferenceWarning("", key), undefined);
});

test("browser backstops protect declared credential leaves and endpoint components without hiding public maps", () => {
  const secret = randomBytes(24).toString("base64url");
  const schema = { type: "object", properties: {
    password: { type: "string" }, endpoint: { type: "string" },
    labels: { type: "object", properties: { title: { type: "string" } },
      additionalProperties: { type: "string" } },
    metadata: { type: "object", additionalProperties: true, "x-unknown-members": "public" as const },
  } };
  assert.deepEqual(redactConfigView({ password: secret, endpoint: `https://u:${secret}@host/public?q=${secret}#${secret}`,
    labels: { token: "public-label" }, metadata: { $id: `https://public.example/schema?version=${secret}#${secret}`,
      properties: { password: { type: "string" } } } }, [], schema), {
    password: "••••", endpoint: "https://••••@host/public?q=••••#••••",
    labels: { token: "public-label" }, metadata: { $id: `https://public.example/schema?version=${secret}#${secret}`,
      properties: { password: { type: "string" } } },
  });
});


test("explicit public workspace keys and peer hashes survive the browser credential-name backstop", () => {
  const workspace = `workspace-${randomUUID().slice(0, 8)}`;
  const hash = randomBytes(32).toString("hex");
  const controls = [
    ["engine.neo.corpusDefaultWorkspaceKey", workspace],
    ["engine.neo.workspaces.0.workspaceKey", workspace],
    ["a2a.peers.0.keySha256", hash],
  ] as const;
  for (const [key, value] of controls) {
    assert.equal(configPolicyOf(key).sensitive, false, key);
    assert.equal(redactConfigView(value, key), value, key);
    assert.equal(configNeedsReplacement(value, key), false, key);
  }
  const value = { engine: { neo: { corpusDefaultWorkspaceKey: workspace, workspaces: [{ workspaceKey: workspace }] } },
    a2a: { peers: [{ keySha256: hash }] } };
  assert.deepEqual(redactConfigView(value), value);
});

test("custom schemas cannot weaken canonical reference-name safety or pasted-key warnings", () => {
  const canonical = CONFIG_POLICY_SCHEMA["x-secret-reference-policy"];
  assert.ok(canonical);
  const schema = { type: "object", properties: {
    ref: { type: "string", "x-secret-reference": true },
  }, "x-secret-reference-policy": {
    ...canonical, storeNamePattern: ".*", tokenPrefixPattern: "(?!)", maxNameLength: Number.MAX_SAFE_INTEGER,
    entropyMinLength: Number.MAX_SAFE_INTEGER, hexMinLength: Number.MAX_SAFE_INTEGER,
  } };
  const token = `sk-${randomBytes(24).toString("base64url")}`;
  assert.equal(isConfigReference(token, ["ref"], schema), false);
  assert.equal(redactConfigView(token, ["ref"], schema), "••••");
  assert.deepEqual(redactConfigView({ ref: token }, [], schema), { ref: "••••" });
  assert.equal(configReferenceWarning(token, ["ref"], schema), "pastedKey");
  assert.equal(isConfigReference("curated-key", ["ref"], schema), true);
  assert.equal(redactConfigView("curated-key", ["ref"], schema), "curated-key");
  assert.equal(configReferenceWarning("curated-key", ["ref"], schema), undefined);
});
