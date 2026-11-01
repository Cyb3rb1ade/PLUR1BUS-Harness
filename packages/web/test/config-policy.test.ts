// The browser policy must interpret the schema generator's array paths and literal map member names.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { configHasPastedKey, configPolicyOf, redactConfigView } from "../src/config-policy.ts";

// Run the real consumers with cloned generated metadata so an omitted annotation needs no canonical-schema fixture change.
for (const boundary of ["projection", "replacement", "palette-load", "palette-index"] as const) {
  test(`reference declarations protect ${boundary} when x-sensitive is absent`, () => {
    execFileSync(process.execPath, ["--experimental-strip-types", "--conditions=source", "--no-warnings=ExperimentalWarning", "--input-type=module", "--eval", `
      import assert from "node:assert/strict";
      import { randomBytes, randomUUID } from "node:crypto";
      const metadata = await import(${JSON.stringify(new URL("../src/palette/settings-index.ts", import.meta.url).href)});
      const key = "voice.providers.elevenlabs.apiKeyRef";
      const ref = metadata.CONFIG_POLICY.find(row => row.key === key).referenceSchema;
      const rows = metadata.CONFIG_POLICY.map(({ sensitive, ...row }) => row);
      rows.push({ key: "referenceEndpoint", urlCredentials: true, referenceSchema: ref });
      metadata.CONFIG_POLICY.splice(0, metadata.CONFIG_POLICY.length, ...rows);
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
  assert.equal(projected.password, "public-label");
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
