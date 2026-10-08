import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { readYaml } from "../../src/import/yaml-lite.ts";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const templatesDir = join(repo, "docs/ops/zabbix");
const metricsDoc = readFileSync(join(repo, "docs/ops/metrics.md"), "utf8");

function templateFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return templateFiles(path);
    return /\.(?:ya?ml|json)$/i.test(entry.name) ? [path] : [];
  });
}

function parseTemplate(path: string): Record<string, unknown> {
  const text = readFileSync(path, "utf8");
  let value: unknown;
  if (/\.json$/i.test(path)) {
    value = JSON.parse(text);
  } else {
    const parsed = readYaml(text);
    assert.deepEqual(parsed.unsupported, [], `${relative(repo, path)} must parse as YAML`);
    value = parsed.value;
  }
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${relative(repo, path)} must contain an object`);
  return value as Record<string, unknown>;
}

function documentedMetrics(): Set<string> {
  const names = new Set<string>();
  for (const line of metricsDoc.split(/\r?\n/)) {
    const cells = line.split("|").map((cell) => cell.trim());
    if (!/^(counter|gauge|histogram)$/i.test(cells[2] ?? "")) continue;
    const listed = [...(cells[1] ?? "").matchAll(/`([^`]+)`/g)].map((match) => match[1]!);
    if (listed.length === 0) continue;
    const first = listed[0]!;
    for (const listedName of listed) {
      names.add(listedName.startsWith("_") ? `plur1bus_process${listedName}` : listedName);
    }
    if (cells[2]!.toLowerCase() === "histogram") {
      names.add(`${first}_bucket`);
      names.add(`${first}_sum`);
      names.add(`${first}_count`);
    }
  }
  return names;
}

function object(value: unknown, context: string): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${context} must be an object`);
  return value as Record<string, unknown>;
}

function requireFields(value: Record<string, unknown>, fields: string[], context: string): void {
  for (const field of fields) {
    assert.ok(value[field] !== undefined && value[field] !== null && value[field] !== "", `${context} requires ${field}`);
  }
}

function collectItems(value: unknown, items: Record<string, unknown>[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectItems(entry, items);
    return;
  }
  if (!value || typeof value !== "object") return;
  const current = value as Record<string, unknown>;
  if (current.type === "PROMETHEUS_PATTERN") items.push(current);
  for (const nested of Object.values(current)) collectItems(nested, items);
}

describe("Zabbix templates", () => {
  const files = templateFiles(templatesDir);
  const metrics = documentedMetrics();

  it("finds and parses every YAML or JSON template file", () => {
    assert.ok(files.length > 0, "expected at least one template file");
    for (const path of files) {
      const exportRoot = object(parseTemplate(path).zabbix_export, `${relative(repo, path)} zabbix_export`);
      requireFields(exportRoot, ["version", "template_groups", "templates"], relative(repo, path));
      assert.ok(Array.isArray(exportRoot.template_groups) && exportRoot.template_groups.length > 0);
      assert.ok(Array.isArray(exportRoot.templates) && exportRoot.templates.length > 0);

      const uuids = new Set<string>();
      const addUuid = (entry: unknown, context: string) => {
        const item = object(entry, context);
        requireFields(item, ["uuid"], context);
        assert.match(String(item.uuid), /^[0-9a-f]{32}$/i, `${context} uuid must contain 32 hex digits`);
        assert.ok(!uuids.has(String(item.uuid)), `${context} uuid must be unique`);
        uuids.add(String(item.uuid));
      };
      for (const group of exportRoot.template_groups as unknown[]) {
        addUuid(group, "template group");
        requireFields(object(group, "template group"), ["name"], "template group");
      }

      for (const templateValue of exportRoot.templates as unknown[]) {
        const template = object(templateValue, "template");
        addUuid(template, "template");
        requireFields(template, ["template", "name", "groups", "items"], "template");
        assert.ok(Array.isArray(template.groups) && template.groups.length > 0, "template must contain groups");
        assert.ok(Array.isArray(template.items) && template.items.length > 0, "template must contain items");
        for (const groupValue of template.groups as unknown[]) {
          requireFields(object(groupValue, "template group reference"), ["name"], "template group reference");
        }

        for (const itemValue of template.items as unknown[]) {
          const item = object(itemValue, "item");
          requireFields(item, ["uuid", "name", "type", "key"], "item");
          addUuid(item, "item");
          if (item.type === "DEPENDENT") {
            requireFields(item, ["master_item", "preprocessing"], `item ${item.key}`);
            const master = object(item.master_item, `item ${item.key} master_item`);
            requireFields(master, ["key"], `item ${item.key} master_item`);
            assert.ok((template.items as Record<string, unknown>[]).some((candidate) => candidate.key === master.key), `item ${item.key} master must exist`);
            const steps: Record<string, unknown>[] = [];
            collectItems(item.preprocessing, steps);
            assert.ok(steps.length > 0, `dependent item ${item.key} must extract a Prometheus metric`);
          }
        }
        for (const triggerValue of (template.triggers ?? []) as unknown[]) {
          const trigger = object(triggerValue, "trigger");
          addUuid(trigger, "trigger");
          requireFields(trigger, ["expression", "name", "priority"], "trigger");
        }
        for (const macroValue of (template.macros ?? []) as unknown[]) {
          const macro = object(macroValue, "macro");
          requireFields(macro, ["macro"], "macro");
          assert.ok(Object.hasOwn(macro, "value") && macro.value !== null, "macro requires value");
        }
      }
    }
  });

  it("checks each Prometheus preprocessing metric against the metrics documentation", () => {
    assert.ok(metrics.size > 0, "metrics documentation must list metrics");
    for (const path of files) {
      const exportRoot = object(parseTemplate(path).zabbix_export, relative(repo, path));
      for (const templateValue of exportRoot.templates as unknown[]) {
        const template = object(templateValue, "template");
        for (const itemValue of template.items as unknown[]) {
          const item = object(itemValue, "item");
          const steps: Record<string, unknown>[] = [];
          collectItems(item.preprocessing, steps);
          for (const step of steps) {
            const parameters = step.parameters;
            assert.ok(Array.isArray(parameters) && typeof parameters[0] === "string", `${item.key} Prometheus preprocessing requires a metric`);
            const metric = /^([a-zA-Z_:][a-zA-Z0-9_:]*)/.exec(parameters[0] as string)?.[1];
            assert.ok(metric && metrics.has(metric), `${item.key} references undocumented /metrics metric ${metric ?? parameters[0]}`);
          }
        }
      }
    }
  });
});
