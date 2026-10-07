import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { ALL_ITEMS } from "../src/nav.ts";
import { catalogues } from "../src/i18n.ts";
import { buildIndex, humanize, settingsHref, settingValues } from "../src/palette/index-build.ts";
import { search } from "../src/palette/match.ts";
import { SETTINGS, type SettingSpec } from "../src/palette/settings-index.ts";

const schema = JSON.parse(readFileSync(new URL("../../config-schema/schema/config.schema.json", import.meta.url), "utf8")) as { properties: Record<string, SchemaNode> };
type SchemaNode = { type?: string; enum?: unknown[]; description?: string; properties?: Record<string, SchemaNode>; "x-tier"?: "basic" | "advanced" };

/** The rule documented in settings-index.ts, applied to the real schema. */
function fromSchema(): SettingSpec[] {
  const rows: SettingSpec[] = [];
  const walk = (props: Record<string, SchemaNode>, prefix: string, inherited: string | undefined): void => {
    for (const [k, v] of Object.entries(props)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (key === "$schema" || key === "schemaVersion") continue;
      const help = v.description ?? inherited;
      if (!v.properties || v["x-tier"]) rows.push({ key, type: v.type ?? (v.enum ? "enum" : ""), tier: v["x-tier"] ?? "advanced", ...(help ? { help } : {}) });
      if (v.properties) walk(v.properties, key, help);
    }
  };
  walk(schema.properties, "", undefined);
  return rows;
}

describe("settings catalogue", () => {
  test("is exactly the settings of config.schema.json (key, type, tier, help): no invented settings, no drift", () => {
    assert.deepEqual([...SETTINGS], fromSchema());
  });
});

describe("humanize", () => {
  test("last key segment, camelCase split, first letter upper-case", () => {
    assert.equal(humanize("core.recall.softBudgetMs"), "Soft budget ms");
    assert.equal(humanize("embedding.acceptedNcLicenceAt"), "Accepted nc licence at");
    assert.equal(humanize("agents"), "Agents");
  });
});

describe("buildIndex", () => {
  const nav = (lang: "en" | "de") => buildIndex({ lang }).filter((x) => x.group === "nav");

  test("every nav item has an entry that links to its path, labelled in the current language and searchable in both", () => {
    for (const lang of ["en", "de"] as const) {
      const index = nav(lang);
      for (const item of ALL_ITEMS) {
        const entry = index.find((x) => x.to === item.path);
        assert.ok(entry, `${lang}: ${item.id}`);
        assert.equal(entry.label, catalogues[lang][item.label]);
        assert.ok(entry.labels.includes(catalogues.en[item.label]) && entry.labels.includes(catalogues.de[item.label]));
      }
    }
  });
  test("sub-route Memories > Dreams is an entry", () => {
    const d = nav("en").find((x) => x.to === "/memories/dreams");
    assert.ok(d);
    assert.equal(d.label, "Dreams");
    assert.equal(nav("de").find((x) => x.to === "/memories/dreams")?.label, "Träume");
    assert.equal(search(buildIndex({ lang: "en" }), "traume")[0]?.entry.to, "/memories/dreams"); // German label found from English UI
  });
  test("every setting has an entry that links to #/settings/<section>?focus=<key> (the agents key goes to the Agents page)", () => {
    const index = buildIndex({ lang: "en" }).filter((x) => x.group === "setting");
    assert.equal(index.length, SETTINGS.length);
    for (const s of SETTINGS) assert.equal(index.find((x) => x.key === s.key)?.to, settingsHref(s.key));
    assert.equal(settingsHref("core.recall.softBudgetMs"), "/settings/general?focus=core.recall.softBudgetMs");
    assert.equal(settingsHref("a b&c"), "/settings/general?focus=a%20b%26c");
  });
  test("entry ids are unique", () => {
    const ids = buildIndex({ lang: "de" }).map((x) => x.id);
    assert.equal(new Set(ids).size, ids.length);
  });
  test("without values there is no value and no error", () => {
    assert.ok(buildIndex({ lang: "en", values: null }).every((x) => x.value === undefined));
  });
  test("values come from a config.get result by dotted path; objects and null are skipped, lists are joined", () => {
    const values = settingValues({ metrics: { port: 9464, enabled: true }, egress: { allowHosts: ["a.example", "b.example"] }, agents: { x: {} }, core: { logLevel: null } });
    assert.deepEqual(values, { "metrics.port": "9464", "metrics.enabled": "true", "egress.allowHosts": "a.example, b.example" });
    const hit = search(buildIndex({ lang: "en", values }), "9464");
    assert.deepEqual(hit.map((h) => h.entry.key), ["metrics.port"]);
    assert.equal(hit[0]?.entry.value, "9464");
  });
  test("settingValues tolerates anything", () => {
    for (const v of [null, undefined, 3, "x", [], { value: 1 }]) assert.deepEqual(settingValues(v), {});
  });
  test("values of sensitive keys never enter the index, whatever the source", () => {
    const specs: SettingSpec[] = [
      { key: "providers.openai.apiKey", type: "string", tier: "basic" }, { key: "x.accessToken", type: "string", tier: "basic" },
      { key: "secrets.store", type: "string", tier: "advanced" }, { key: "auth.password", type: "string", tier: "basic" },
      { key: "oauth.credentials", type: "string", tier: "advanced" }, { key: "core.logLevel", type: "enum", tier: "advanced" },
    ];
    const values = Object.fromEntries(specs.map((s) => [s.key, s.key === "core.logLevel" ? "debug" : "sk-TOPSECRET-123"]));
    const index = buildIndex({ lang: "en", settings: specs, values });
    assert.equal(JSON.stringify(index).includes("TOPSECRET"), false);
    assert.equal(index.find((x) => x.key === "core.logLevel")?.value, "debug");
    assert.deepEqual(search(index, "TOPSECRET"), []);
    // The entry itself stays findable by label and key.
    assert.equal(search(index, "apikey")[0]?.entry.key, "providers.openai.apiKey");
  });
  test("settingValues drops sensitive keys itself when given specs", () => {
    const specs: SettingSpec[] = [{ key: "a.apiKey", type: "string", tier: "basic" }, { key: "a.name", type: "string", tier: "basic" }];
    assert.deepEqual(settingValues({ a: { apiKey: "sk-1", name: "n" } }, specs), { "a.name": "n" });
  });
});
