// Installed module privacy declarations supplement the embedded config schema. Loading never reads the secret store.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { configTextSecretEntries, supportsConfigDisclosurePolicy, type ConfigSchemaNode } from "@plur1bus/config-schema";
import { validateManifest } from "@plur1bus/module-api";

interface ModulePolicy {
  name: string;
  schema?: ConfigSchemaNode;
  unavailable?: true;
}

/** Value-free metadata error: callers retain the last accepted configuration instead of exposing a raw fallback. */
export class ConfigDisclosureUnavailable extends Error {
  constructor(module?: string) {
    super(module
      ? `sensitivity metadata for module ${module} is unavailable; repair its manifest and restart`
      : "configuration sensitivity metadata is unavailable; repair the installed module registry and restart");
    this.name = "ConfigDisclosureUnavailable";
  }
}

/** Immutable policy snapshot. Module manifests are read in bulk at startup and before accepted module changes. */
export interface ConfigDisclosurePolicy {
  values(config: unknown): readonly string[];
}

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

async function modulePolicy(directory: string, name: string): Promise<ModulePolicy> {
  try {
    const result = validateManifest(JSON.parse(await readFile(join(directory, name, "module.json"), "utf8")));
    if (!result.ok || result.manifest.name !== name) return { name, unavailable: true };
    const schema = result.manifest.configSchema;
    if (schema && !supportsConfigDisclosurePolicy(schema)) return { name, unavailable: true };
    return { name, ...(schema ? { schema: schema as ConfigSchemaNode } : {}) };
  } catch {
    return { name, unavailable: true };
  }
}

/** Load local module manifests without retrieval; unconfigured bad manifests do not block unrelated configuration. */
export async function loadConfigDisclosurePolicy(home: string): Promise<ConfigDisclosurePolicy> {
  const directory = join(home, "modules");
  let policies: ModulePolicy[];
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    policies = await Promise.all(entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !entry.name.includes(".tmp-"))
      .map((entry) => modulePolicy(directory, entry.name)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new ConfigDisclosureUnavailable();
    policies = [];
  }
  return {
    values(config) {
      const values = new Set(configTextSecretEntries(config).map(({ value }) => value));
      const configured = object(object(config).modules);
      for (const policy of policies) {
        if (!Object.hasOwn(configured, policy.name)) continue;
        if (policy.unavailable) throw new ConfigDisclosureUnavailable(policy.name);
        if (policy.schema) {
          for (const { value } of configTextSecretEntries(configured[policy.name], policy.schema)) values.add(value);
        }
      }
      return [...values];
    },
  };
}
