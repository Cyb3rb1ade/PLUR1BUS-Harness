// Pure logic of the config sections, and a drift check of the static field metadata against the config schema.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { SETTINGS } from "../src/palette/settings-index.ts";
import { SECTIONS, sectionById, sectionOf } from "../src/settings-sections.ts";
import { fieldId, META } from "../src/pages/settings/config/meta.ts";
import { buildFields, collectChanges, initialDraft, mapInvalid, parseDraft, redact } from "../src/pages/settings/config/model.ts";

const schema = JSON.parse(readFileSync(new URL("../../config-schema/schema/config.schema.json", import.meta.url), "utf8")) as Record<string, unknown>;
const node = (key: string): Record<string, unknown> | undefined => key.split(".").reduce<unknown>((n, s) => (n as { properties?: Record<string, unknown> } | undefined)?.properties?.[s], schema) as Record<string, unknown> | undefined;

describe("field metadata", () => {
  test("matches the schema: enum, bounds, default, restart class", () => {
    for (const m of META) {
      const n = node(m.key); assert.ok(n, `${m.key} missing from the schema`);
      assert.equal(n["x-restart"], m.restart, `${m.key} restart`);
      if (m.kind === "json") continue;
      assert.deepEqual(n["default"], m.def, `${m.key} default`);
      if (m.kind === "enum") assert.deepEqual(n["enum"], m.options, `${m.key} enum`);
      const b = m.kind === "ints" ? (n["items"] as Record<string, unknown>) : n;
      assert.equal(b["minimum"], m.min, `${m.key} minimum`); assert.equal(b["maximum"], m.max, `${m.key} maximum`);
    }
  });
});

describe("buildFields", () => {
  test("every config section has fields, secrets sections none, and no sensitive key appears", () => {
    for (const s of SECTIONS.filter((x) => x.kind === "config")) assert.ok(buildFields({}, s).length > 0, s.id);
    assert.deepEqual(buildFields({}, { id: "x", kind: "config", label: "settings.title", keys: ["nothing."] }), []);
    const f = buildFields({ models: { scan: { apiKey: "x" } } }, sectionById("models")!);
    assert.ok(!f.some((x) => /key/i.test(x.key)));
  });
  test("restart class comes from the lookup, then the metadata", () => {
    const f = buildFields({}, sectionById("general")!, { "core.logLevel": "module:x" });
    assert.equal(f.find((x) => x.key === "core.logLevel")!.restartClass, "module:x");
    assert.equal(f.find((x) => x.key === "metrics.port")!.restartClass, "core");
  });
});

describe("drafts", () => {
  const g = (cfg: unknown, id = "general") => buildFields(cfg, sectionById(id)!);
  test("no edit, no change; edits become typed values", () => {
    const fields = g({ core: { logLevel: "warn" } });
    const d = initialDraft(fields);
    assert.deepEqual(collectChanges(fields, d).changes, []);
    const r = collectChanges(fields, { ...d, "core.logLevel": "debug", "metrics.port": "2000", "metrics.enabled": true });
    assert.deepEqual(r.changes.map((c) => [c.key, c.old, c.value]), [["core.logLevel", "warn", "debug"], ["metrics.enabled", false, true], ["metrics.port", 9464, 2000]]);
  });
  test("bounds and formats", () => {
    const f = g({}).find((x) => x.key === "metrics.port")!;
    assert.equal(parseDraft(f, "80").ok, false);
    assert.equal(parseDraft(f, "70000").ok, false);
    assert.equal(parseDraft(f, "1.5").ok, false);
    assert.deepEqual(parseDraft(f, "2048"), { ok: true, value: 2048 });
    const ports = g({}, "network").find((x) => x.key === "egress.allowPorts")!;
    assert.equal(parseDraft(ports, "443\nx").ok, false);
  });
});

describe("integers without an upper bound", () => {
  const g = (config: unknown, id = "general") => buildFields(config, sectionById(id)!);
  test("a number that is not exactly representable is refused, not rounded", () => {
    // logs.maxBytes has a schema maximum now; drop it here (as for the port list below) so the unsafe-integer guard alone is tested.
    const { max: _max, ...f } = g({}).find((x) => x.key === "logs.maxBytes")!;
    for (const huge of ["99999999999999999999", "9007199254740993", "-9007199254740993", "1".repeat(400)]) {
      const r = parseDraft(f, huge);
      assert.equal(r.ok, false, huge);
    }
    assert.deepEqual(parseDraft(f, "9007199254740991"), { ok: true, value: 9007199254740991 });
  });
  test("the schema maximum of a field is enforced on its own", () => {
    const f = g({}).find((x) => x.key === "logs.maxBytes")!;
    assert.equal(f.max, 10737418240);
    assert.deepEqual(parseDraft(f, "10737418240"), { ok: true, value: 10737418240 });
    assert.equal(parseDraft(f, "10737418241").ok, false);
  });
  test("the same holds per line of an integer list", () => {
    const ports = g({}, "network").find((x) => x.key === "egress.allowPorts")!;
    const { max: _max, ...unbounded } = ports;
    assert.equal(parseDraft(unbounded, "443\n99999999999999999999").ok, false);
  });
});

describe("secrets under names the key heuristic does not know", () => {
  test("redact masks authorization headers, cookies, passphrases and credentials inside URLs", () => {
    const out = redact({
      providers: { a: { headers: { Authorization: "Bearer swordfish", Cookie: "sid=swordfish", "X-Api-Passphrase": "swordfish" }, baseUrl: "https://ann:swordfish@llm.example.com/v1", note: "plain" } },
      list: ["Bearer swordfish", "https://llm.example.com/v1"],
    });
    const text = JSON.stringify(out);
    assert.ok(!text.includes("swordfish"), text);
    assert.match(text, /"note":"plain"/);
    assert.match(text, /https:\/\/llm\.example\.com\/v1/);
  });
  test("buildFields keeps such keys out of the editable fields", () => {
    const fields = buildFields({ extensions: { registry: { authorization: "Bearer swordfish", cookie: "x", endpoint: "https://r.example.com" } } }, sectionById("extensions")!);
    assert.deepEqual(fields.filter((f) => f.key.startsWith("extensions.registry")).map((f) => f.key), ["extensions.registry.endpoint"]);
  });
});

describe("helpers", () => {
  test("redact masks sensitive keys at depth", () => {
    assert.deepEqual(redact({ a: { apiKey: "s", b: [{ token: "t", ok: 1 }] } }), { a: { apiKey: "••••", b: [{ token: "••••", ok: 1 }] } });
  });
  test("mapInvalid assigns segments by dotted key or JSON pointer", () => {
    const r = mapInvalid("/core/logLevel must be one of; metrics.port too low; something else", ["core.logLevel", "metrics.port"]);
    assert.deepEqual(Object.keys(r.byKey).sort(), ["core.logLevel", "metrics.port"]);
    assert.deepEqual(r.rest, ["something else"]);
  });
});

describe("palette alignment", () => {
  test("every catalogued setting of a config section has a field with the id the deep link targets (engine is the one documented gap)", () => {
    const gaps: string[] = [];
    for (const { key } of SETTINGS) {
      const sec = sectionOf(key);
      if (!sec || sec.kind !== "config") continue;
      if (!buildFields({}, sec).some((f) => f.key === key)) gaps.push(key);
    }
    assert.deepEqual(gaps, ["engine"]);
    assert.equal(fieldId("core.recall.softBudgetMs"), "cfg-core-recall-softBudgetMs");
  });
});
