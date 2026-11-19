import { CONFIG_SCHEMA, secretReferenceOf } from "@plur1bus/config-schema";
import { isSecretName } from "../secrets/types.ts";

/**
 * The secret names the engine may resolve (P4D-29, R-20-35, R-20-36): one definition, read from the configuration schema.
 *
 * - Every value of the engine's part of the configuration (`engine`) that sits in a field marked `x-secret-reference`
 *   and is a valid secret name. A store reference of the object form (`{ source: "store", provider, id }`) names its `id`;
 *   an environment, file or exec reference names nothing the store holds.
 * - The names a block falls back to without a reference of its own: the schema marks the block `x-secret-default`, and
 *   the names are allowed exactly while that block is an object in the configuration. Neither the provider nor the host
 *   of the block is judged here; whichever name the engine falls back to is on the list.
 *
 * Nothing here knows a field name, a block name or a name pattern. The Rust front door builds the same set
 * (`crates/plur1bus-core/src/engine_scope.rs`); `fixtures/parity/secrets/engine-scope.json` is what both must give.
 */
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function referenceName(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (isObject(value) && value.source === "store" && typeof value.id === "string") return value.id;
  return undefined;
}

function referencedNames(engine: Record<string, unknown>, names: Set<string>): void {
  const visit = (value: unknown, path: string[]): void => {
    if (!value || typeof value !== "object") return;
    for (const [key, member] of Object.entries(value)) {
      const at = [...path, key];
      if (secretReferenceOf(at, member)) {
        const name = referenceName(member);
        if (name !== undefined && isSecretName(name)) names.add(name);
      } else visit(member, at);
    }
  };
  visit(engine, ["engine"]);
}

function defaultNames(schema: unknown, value: unknown, names: Set<string>): void {
  if (!isObject(schema) || !isObject(value)) return;
  // A node can carry its members beside `x-value-schema` (the `engine` node does); both views count.
  for (const view of [schema, schema["x-value-schema"]]) {
    if (!isObject(view)) continue;
    const marked = view["x-secret-default"];
    if (Array.isArray(marked)) for (const name of marked) if (isSecretName(name)) names.add(name);
    if (!isObject(view.properties)) continue;
    for (const [key, child] of Object.entries(view.properties)) if (Object.hasOwn(value, key)) defaultNames(child, value[key], names);
  }
}

/** The set for one configuration; a configuration without an engine part gives the empty set. Throws on a broken schema. */
export function engineSecretNames(config: unknown): ReadonlySet<string> {
  const names = new Set<string>();
  const engine = isObject(config) && Object.hasOwn(config, "engine") ? config.engine : undefined;
  if (!isObject(engine)) return names;
  referencedNames(engine, names);
  defaultNames(CONFIG_SCHEMA.properties?.engine, engine, names);
  return names;
}

/** What the engine's port asks: whether a name may be resolved now. */
export interface EngineSecretScope { has(name: string): boolean }

/**
 * The scope the engine's port asks at every request (`createEngineSecrets`): the names of the configuration that holds
 * now, and the names of the planned target of an embedding migration that is under way (R-20-38,
 * `embedding-migrate/secret-names.ts`).
 *
 * The configuration's set is built once for each configuration and kept for as long as that configuration is the one
 * `config` gives: the key is the configuration object itself, never a time, so the first request after a change builds
 * the set of the new configuration and a reference that was taken out is gone with it. A source that gives a new object
 * for every request (a file read at each one) builds the set at each. The planned target is asked only for a name the
 * configuration does not have, and at every such request.
 */
export function engineSecretScope(config: () => unknown, planned?: () => ReadonlySet<string>): () => EngineSecretScope {
  let built: { of: unknown; names: ReadonlySet<string> } | undefined;
  return () => {
    const now = config();
    if (!built || built.of !== now) built = { of: now, names: engineSecretNames(now) };
    const names = built.names;
    return { has: name => names.has(name) || (planned !== undefined && planned().has(name)) };
  };
}
