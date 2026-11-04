// Installed module privacy declarations supplement the embedded config schema. Loading never reads the secret store.
import { watch, type FSWatcher } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { configurationWarnings, configTextSecretEntries, type ConfigSchemaNode, type ConfigWarning } from "@plur1bus/config-schema";
import { supportsConfigDisclosurePolicy } from "@plur1bus/config-schema/policy";
import { validateManifest } from "@plur1bus/module-api";

interface ModulePolicy {
  name: string;
  schema?: ConfigSchemaNode;
  unavailable?: true;
}

/** Immutable policy snapshot. Module manifests are read in bulk at startup and before accepted module changes. */
export interface ConfigDisclosurePolicy {
  values(config: unknown): readonly string[];
  /** Module-only notices; the configuration source already reports the Harness schema's warnings. */
  warnings(config: unknown): readonly ConfigWarning[];
}

const POLICY_POLL_MS = 1000;
const MAX_POLICY_READ_ATTEMPTS = 3;
const MAX_WARNINGS = 50;
const PRIVATE_MODULE_SCHEMA: ConfigSchemaNode = { "x-sensitive": true };

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

function privateModuleValues(value: unknown): string[] {
  const module = object(value);
  // enabled is a Harness boolean control; damaged module metadata cannot turn every logged false into a secret.
  const privateValue = module === value && typeof module.enabled === "boolean"
    ? Object.fromEntries(Object.entries(module).filter(([name]) => name !== "enabled")) : value;
  return configTextSecretEntries(privateValue, PRIVATE_MODULE_SCHEMA).map((entry) => entry.value);
}

async function modulePolicy(directory: string, name: string): Promise<ModulePolicy> {
  try {
    const result = validateManifest(JSON.parse(await readFile(join(directory, name, "module.json"), "utf8")));
    if (!result.ok || result.manifest.name !== name) return { name, unavailable: true };
    const schema = result.manifest.configSchema;
    if (schema && !supportsConfigDisclosurePolicy(schema)) return { name, unavailable: true };
    // Harness owns enabled even if the module omits it. Keep the module's root and local definitions intact.
    return { name, ...(schema ? { schema: { ...schema,
      properties: { ...(schema.properties as Record<string, ConfigSchemaNode> | undefined), enabled: { type: "boolean" } },
    } as ConfigSchemaNode } : {}) };
  } catch {
    return { name, unavailable: true };
  }
}

function policySnapshot(policies: readonly ModulePolicy[], unavailable = false): ConfigDisclosurePolicy {
  return {
    values(config) {
      const root = object(config);
      const configured = object(root.modules);
      const known = new Map(policies.filter((policy) => policy.schema || policy.unavailable)
        .map((policy) => [policy.name, policy]));
      if (unavailable) {
        for (const name of Object.keys(configured)) known.set(name, { name, unavailable: true });
      }
      // The base pass must never register a known module's public values before its own schema grants exemptions.
      const base = root !== config || configured !== root.modules ? config : { ...root,
        modules: Object.fromEntries(Object.entries(configured).filter(([name]) => !known.has(name))),
      };
      const values = new Set(configTextSecretEntries(base).map(({ value }) => value));
      for (const [name, policy] of known) {
        if (!Object.hasOwn(configured, name)) continue;
        if (policy.unavailable) {
          for (const value of privateModuleValues(configured[name])) values.add(value);
          continue;
        }
        try {
          for (const { value } of configTextSecretEntries(configured[name], policy.schema)) values.add(value);
        } catch {
          // A damaged declaration cannot disable logging or release a literal. Repairs are loaded by the watcher.
          for (const value of privateModuleValues(configured[name])) values.add(value);
        }
      }
      return [...values];
    },
    warnings(config) {
      const configured = object(object(config).modules);
      const warnings: ConfigWarning[] = [];
      if (unavailable && Object.keys(configured).length) warnings.push({ key: "modules",
        message: "Module sensitivity metadata is unavailable; values remain private. Repair the installed module registry." });
      for (const policy of policies) {
        if (!Object.hasOwn(configured, policy.name) || warnings.length >= MAX_WARNINGS) continue;
        if (policy.unavailable) {
          warnings.push({ key: `modules.${policy.name}`,
            message: "Module sensitivity metadata is unavailable; values remain private. Repair its module.json manifest." });
        } else if (policy.schema) {
          for (const warning of configurationWarnings(configured[policy.name], policy.schema)) {
            if (warnings.length >= MAX_WARNINGS) break;
            warnings.push({ ...warning, key: `modules.${policy.name}${warning.key ? `.${warning.key}` : ""}` });
          }
        }
      }
      return warnings;
    },
  };
}

/** Load local manifests without retrieval; missing or unreadable metadata keeps module values private. */
export async function loadConfigDisclosurePolicy(home: string): Promise<ConfigDisclosurePolicy> {
  const directory = join(home, "modules");
  for (let attempt = 0; attempt < MAX_POLICY_READ_ATTEMPTS; attempt++) {
    const before = await registryStamp(directory);
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      const policies = await Promise.all(entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !entry.name.includes(".tmp-"))
        .map((entry) => modulePolicy(directory, entry.name)));
      if (before === await registryStamp(directory)) return policySnapshot(policies);
    } catch (error) {
      return policySnapshot([], (error as NodeJS.ErrnoException).code !== "ENOENT");
    }
  }
  // Repeated concurrent installs cannot publish a mixture of old and new declarations.
  return policySnapshot([], true);
}

async function registryStamp(directory: string): Promise<string> {
  try {
    const root = await stat(directory);
    const entries = await readdir(directory, { withFileTypes: true });
    const files = await Promise.all(entries.filter((entry) => entry.isDirectory() &&
      !entry.name.startsWith(".") && !entry.name.includes(".tmp-")).map(async (entry) => {
      try {
        const file = await stat(join(directory, entry.name, "module.json"));
        return `${entry.name}:${file.ino}:${file.mtimeMs}:${file.ctimeMs}:${file.size}`;
      } catch { return `${entry.name}:unavailable`; }
    }));
    return `${root.ino}|${files.sort().join("|")}`;
  } catch { return "unavailable"; }
}

/** Observe install, update, removal and manifest repair independently of process children or config edits.
 * Directory events make reloads prompt; a bounded stat poll covers absent directories and missed/coalesced events. */
export function watchConfigDisclosurePolicy(home: string, changed: () => void): () => void {
  const directory = join(home, "modules");
  let closed = false, pending = false, checking = false;
  let stamp: string | undefined;
  let moduleWatch: FSWatcher | undefined, homeWatch: FSWatcher | undefined;
  const reload = (): void => {
    if (pending || closed) return;
    pending = true;
    queueMicrotask(() => { pending = false; if (!closed) changed(); });
  };
  const watchModules = (): void => {
    if (closed || moduleWatch) return;
    try {
      moduleWatch = watch(directory, { recursive: true }, (_event, filename) => {
        if (filename === null || String(filename).split(/[\\/]/).at(-1) === "module.json" ||
          !String(filename).match(/[\\/]/)) reload();
      });
      moduleWatch.unref();
      moduleWatch.on("error", () => { moduleWatch?.close(); moduleWatch = undefined; reload(); });
    } catch { /* The poll remains active when the directory is absent or watching is unsupported. */ }
  };
  const check = async (): Promise<void> => {
    if (closed || checking) return;
    checking = true;
    try {
      const next = await registryStamp(directory);
      if (!closed && stamp !== next) { stamp = next; watchModules(); reload(); }
    } finally { checking = false; }
  };
  try {
    homeWatch = watch(home, (_event, filename) => {
      if (filename === null || String(filename) === "modules") {
        moduleWatch?.close(); moduleWatch = undefined;
        watchModules(); reload();
      }
    });
    homeWatch.unref();
    homeWatch.on("error", () => { homeWatch?.close(); homeWatch = undefined; });
  } catch { /* The stat poll also observes creation of modules/ when no home watcher is available. */ }
  watchModules();
  const poll = setInterval(() => { void check(); }, POLICY_POLL_MS); poll.unref();
  void check();
  return () => {
    closed = true; pending = false;
    clearInterval(poll); homeWatch?.close(); moduleWatch?.close();
  };
}
