import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createMetrics } from "../../src/metrics/metrics.ts";
import { parseExposition } from "./exposition-parser.ts";

// No YAML library is a dependency of the harness; the template is checked structurally, line by line.
const text = readFileSync(fileURLToPath(new URL("../../../../docs/ops/zabbix/plur1bus-template.yaml", import.meta.url)), "utf8");

describe("Zabbix 7 template", () => {
  it("is a 7.0 export with one template, valid unique v4 uuids", () => {
    assert.match(text, /^zabbix_export:\n {2}version: '7\.0'\n/);
    assert.equal((text.match(/^ {4}- uuid:/gm) ?? []).length, 2); // the template group and the template
    const uuids = [...text.matchAll(/uuid: ([0-9a-f]{32})\b/g)].map((m) => m[1]!);
    assert.equal(uuids.length, (text.match(/uuid:/g) ?? []).length, "every uuid is 32 hex chars");
    assert.equal(new Set(uuids).size, uuids.length);
    for (const u of uuids) assert.match(u, /^[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}$/);
  });

  it("has one HTTP agent master item with a bearer header from a macro, and only dependent items besides", () => {
    assert.equal((text.match(/type: HTTP_AGENT/g) ?? []).length, 1);
    assert.match(text, /url: 'http:\/\/\{\$PLUR1BUS\.METRICS\.HOST\}:\{\$PLUR1BUS\.METRICS\.PORT\}\/metrics'/);
    assert.match(text, /value: 'Bearer \{\$PLUR1BUS\.METRICS\.TOKEN\}'/);
    const dependents = (text.match(/type: DEPENDENT/g) ?? []).length;
    assert.ok(dependents >= 8);
    assert.equal((text.match(/master_item:\n\s+key: plur1bus\.metrics\.get/g) ?? []).length, dependents);
    assert.equal((text.match(/type: PROMETHEUS_PATTERN/g) ?? []).length, dependents);
  });

  it("has exactly three triggers", () => {
    const section = text.slice(text.indexOf("      triggers:"), text.indexOf("      macros:"));
    assert.equal((section.match(/^ {8}- uuid:/gm) ?? []).length, 3);
  });

  it("the token macro is a secret and ships empty", () => {
    assert.match(text, /macro: '\{\$PLUR1BUS\.METRICS\.TOKEN\}'\n\s+type: SECRET_TEXT\n\s+value: ''/);
    assert.equal(/Bearer [0-9a-f]{20,}/.test(text), false);
  });

  it("every metric a preprocessing step reads exists in the exposition", () => {
    const rendered = parseExposition(createMetrics({ connections: () => 0 }).render());
    const names = new Set(rendered.flatMap((f) => [f.name, ...f.samples.map((s) => s.name)]));
    const wanted = [...text.matchAll(/^ {16}- '(plur1bus_[a-z_]+)(?:\{[^']*\})?'$/gm)].map((m) => m[1]!);
    assert.ok(wanted.length >= 8);
    for (const n of wanted) assert.ok(names.has(n), `${n} is not exposed`);
  });

  it("every item key a trigger uses is an item of the template", () => {
    const keys = new Set([...text.matchAll(/^ {10}key: (\S+)$/gm)].map((m) => m[1]!));
    for (const m of text.matchAll(/\/PLUR1BUS Harness by HTTP\/([a-z0-9_.]+)[,)]/g)) assert.ok(keys.has(m[1]!), m[1]);
  });
});
