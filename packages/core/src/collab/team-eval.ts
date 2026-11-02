/** PT-2 data contracts only. K2 owns model execution and verifier/worktree provisioning. */
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

/** Languages supported by the original MIT team corpus. */
export type TeamLanguage = "typescript" | "python" | "rust" | "go";
/** One owned module/stage, its public symbol and private host checker binding. */
export interface TeamPackage {
  id: string;
  entry: string;
  symbol: string;
  owns: string[];
  dependsOn: string[];
  reference: string;
  checker: { path: string; scope: string };
}
/** Closed private task metadata; the kind, oracle and allocation are never candidate input. */
export interface TeamTask {
  schema: "plur1bus.team-task/1";
  id: string;
  title: string;
  kind: "decomposable" | "coupled";
  tier: "team";
  language: TeamLanguage;
  license: "MIT";
  seeds: number[];
  budgets: { tokens: number; maxRounds: number; wallMs: number };
  instruction: string;
  start: string;
  seedGenerator: string;
  packages: TeamPackage[];
  endToEnd: { checker: { path: string; scope: string }; order: string[] };
}

type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("team task must contain objects");
  return value as JsonObject;
}
function closed(value: unknown, keys: string[]): JsonObject {
  const row = object(value);
  if (Object.keys(row).length !== keys.length || keys.some((key) => !Object.hasOwn(row, key)))
    throw new Error("invalid team task fields");
  return row;
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]*$/.test(value)) throw new Error("invalid team task identifier");
  return value;
}
function relativePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9_./-]+$/.test(value) ||
    value.startsWith("/") ||
    value.split("/").some((part) => part === ".." || part === "." || !part)
  )
    throw new Error("invalid team task path");
  return value;
}
function strings(value: unknown, parse: (item: unknown) => string): string[] {
  if (!Array.isArray(value)) throw new Error("team task requires an array");
  const result = value.map(parse);
  if (new Set(result).size !== result.length) throw new Error("duplicate team task value");
  return result;
}
function checker(value: unknown): { path: string; scope: string } {
  const row = closed(value, ["path", "scope"]);
  return { path: relativePath(row.path), scope: identifier(row.scope) };
}
function taskPackage(value: unknown): TeamPackage {
  const row = closed(value, ["id", "entry", "symbol", "owns", "dependsOn", "reference", "checker"]);
  if (typeof row.symbol !== "string" || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(row.symbol))
    throw new Error("invalid team task symbol");
  return {
    id: identifier(row.id),
    entry: relativePath(row.entry),
    symbol: row.symbol,
    owns: strings(row.owns, relativePath),
    dependsOn: strings(row.dependsOn, identifier),
    reference: relativePath(row.reference),
    checker: checker(row.checker),
  };
}

/** Validate every metadata field before paths, symbols or allocations are used. Throws on an invalid task. */
export function parseTeamTask(value: unknown): TeamTask {
  const row = closed(value, [
    "schema",
    "id",
    "title",
    "kind",
    "tier",
    "language",
    "license",
    "seeds",
    "budgets",
    "instruction",
    "start",
    "seedGenerator",
    "packages",
    "endToEnd",
  ]);
  if (row.schema !== "plur1bus.team-task/1" || row.license !== "MIT")
    throw new Error("invalid team task schema or license");
  if (row.kind !== "decomposable" && row.kind !== "coupled") throw new Error("invalid team task kind");
  if (row.tier !== "team") throw new Error("invalid team task tier");
  if (typeof row.language !== "string" || !["typescript", "python", "rust", "go"].includes(row.language))
    throw new Error("invalid team task language");
  if (typeof row.title !== "string" || !row.title.trim()) throw new Error("invalid team task title");
  if (
    !Array.isArray(row.seeds) ||
    row.seeds.length !== 3 ||
    row.seeds.some((seed) => !Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) ||
    new Set(row.seeds).size !== 3
  )
    throw new Error("team task requires three distinct uint32 seeds");
  const budgets = closed(row.budgets, ["tokens", "maxRounds", "wallMs"]);
  if (
    Object.values(budgets).some((value) => !Number.isSafeInteger(value) || Number(value) <= 0) ||
    Number(budgets.wallMs) > 0x7fffffff
  )
    throw new Error("invalid team task budgets");
  if (!Array.isArray(row.packages) || row.packages.length < 3 || row.packages.length > 5)
    throw new Error("team task requires three to five packages");
  const packages = row.packages.map(taskPackage);
  const ids = packages.map((item) => item.id);
  if (new Set(ids).size !== ids.length) throw new Error("duplicate team package");
  for (const [index, item] of packages.entries()) {
    if (
      item.owns.length !== 1 ||
      !item.owns.includes(item.entry) ||
      item.checker.scope !== item.id ||
      item.dependsOn.some((id) => !ids.slice(0, index).includes(id))
    )
      throw new Error("invalid team package ownership, scope or dependency order");
    const extension = { typescript: "ts", python: "py", rust: "rs", go: "go" }[row.language as TeamLanguage];
    const pattern =
      row.language === "go"
        ? /^src\/[a-z][a-z0-9-]*__SEED__\/solution__SEED__\.go$/
        : new RegExp(`^src/[a-z][a-z0-9-]*\\.__SEED__\\.${extension}$`);
    if (item.owns.some((path) => !pattern.test(path)))
      throw new Error("team ownership must name exact seeded source files");
  }
  if (row.kind === "decomposable") {
    const owners = packages.flatMap((item) => item.owns);
    if (new Set(owners).size !== owners.length) throw new Error("decomposable ownership cannot overlap");
  }
  const end = closed(row.endToEnd, ["checker", "order"]);
  const order = strings(end.order, identifier);
  if (JSON.stringify(order) !== JSON.stringify(ids)) throw new Error("integration order must include every package");
  const task: TeamTask = {
    schema: row.schema,
    id: identifier(row.id),
    title: row.title,
    kind: row.kind,
    tier: row.tier,
    language: row.language as TeamLanguage,
    license: row.license,
    seeds: row.seeds as number[],
    budgets: budgets as TeamTask["budgets"],
    instruction: relativePath(row.instruction),
    start: relativePath(row.start),
    seedGenerator: relativePath(row.seedGenerator),
    packages,
    endToEnd: { checker: checker(end.checker), order },
  };
  if (task.endToEnd.checker.scope !== "e2e") throw new Error("integration checker must use e2e scope");
  if (task.kind === "decomposable" && new Set(packages.map((item) => item.entry)).size !== packages.length)
    throw new Error("decomposable packages must have distinct entry files");
  if (task.kind === "coupled" && new Set(packages.map((item) => item.entry)).size !== 1)
    throw new Error("coupled references must share an entry file");
  return task;
}

/** Read the explicit corpus catalog from a directory file URL and validate every manifest. */
export async function loadTeamTasks(root: URL): Promise<TeamTask[]> {
  if (root.protocol !== "file:" || !root.pathname.endsWith("/"))
    throw new Error("team fixtures require an explicit directory file URL");
  const catalog: unknown = JSON.parse(await readFile(new URL("catalog.json", root), "utf8"));
  const ids = strings(catalog, identifier);
  return Promise.all(
    ids.map(async (id) => {
      const task = parseTeamTask(JSON.parse(await readFile(new URL(`${id}/task.json`, root), "utf8")));
      if (task.id !== id) throw new Error("team task directory does not match its id");
      return task;
    }),
  );
}

/** Bounded finite JSON data used for portable arm identities. */
export type ArmParameter =
  | null
  | boolean
  | number
  | string
  | readonly ArmParameter[]
  | { readonly [key: string]: ArmParameter };
/** An arm identity is a family plus canonicalizable JSON parameters. */
export interface EvaluationArmSpec {
  family: string;
  params: Readonly<Record<string, ArmParameter>>;
}
/** Portable canonical key used by budget maps and the K2 adapter. */
export type EvaluationArmId = string;
/** Runtime bindings own capabilities; metadata never grants authority. */
export type ArmCapability = string;
/** Planned roles and implementation requirements for a registered arm. */
export interface EvaluationArm extends EvaluationArmSpec {
  id: EvaluationArmId;
  roles: readonly string[];
  requires: readonly ArmCapability[];
}
/** Per-task allocation, expressed with the D124 task field names. */
export type TaskAllocation = TeamTask["budgets"];
/** Matched limits come only from the task; natural limits are explicit configured allocations. */
export type EvaluationBudget = { regime: "matched" } | { regime: "natural"; limits: TaskAllocation };

/** Exact JSON values: preserve strings and array order, sort object keys, refuse non-data inputs. */
function armJson(value: unknown, seen = new Set<object>(), depth = 0, visited = { count: 0 }): string {
  if (++visited.count > 4096) throw new Error("arm parameters exceed node limit");
  if (depth > 32) throw new Error("arm parameters exceed nesting limit");
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (!value || typeof value !== "object") throw new Error("arm parameters require finite JSON data");
  if (seen.has(value)) throw new Error("arm parameters cannot contain cycles");
  const array = Array.isArray(value);
  if (!array && ![null, Object.prototype].includes(Object.getPrototypeOf(value)))
    throw new Error("arm parameters require plain objects");
  const keys = Reflect.ownKeys(value);
  const properties = Object.getOwnPropertyDescriptors(value);
  if (array && keys.length !== value.length + 1) throw new Error("arm parameter arrays must be dense");
  for (const key of keys) {
    if (array && key === "length") continue;
    const property = Object.getOwnPropertyDescriptor(value, key)!;
    if (
      typeof key !== "string" ||
      !property.enumerable ||
      !Object.hasOwn(property, "value") ||
      (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))
    )
      throw new Error("arm parameters require JSON data properties");
  }
  seen.add(value);
  try {
    return array
      ? `[${Array.from(
          { length: value.length },
          (_, index) => armJson(properties[index]!.value, seen, depth + 1, visited),
        ).join(",")}]`
      : `{${(keys as string[])
          .sort()
          .map((key) => `${JSON.stringify(key)}:${armJson(properties[key]!.value, seen, depth + 1, visited)}`)
          .join(",")}}`;
  } finally {
    seen.delete(value);
  }
}
/** Portable <=64-character identity. The empty single control retains B1's existing baseline ID. */
export function canonicalArmId(arm: EvaluationArmSpec): EvaluationArmId {
  if (!arm || typeof arm !== "object") throw new Error("invalid evaluation arm definition");
  const properties = Object.getOwnPropertyDescriptors(arm);
  const family: unknown = properties.family?.value;
  const parameters: unknown = properties.params?.value;
  if (
    typeof family !== "string" ||
    !/^[a-z][a-z0-9+-]{0,30}$/.test(family) ||
    !parameters ||
    typeof parameters !== "object" ||
    Array.isArray(parameters)
  ) {
    throw new Error("invalid evaluation arm definition");
  }
  const params = armJson(parameters);
  if (Buffer.byteLength(params, "utf8") > 16384) throw new Error("arm parameters exceed byte limit");
  if (family === "single" && params === "{}") return "single";
  const descriptor = `{"family":${JSON.stringify(family)},"params":${params}}`;
  const digest = createHash("sha256").update(descriptor, "utf8").digest("hex").slice(0, 32);
  return `${family.replaceAll("+", "-")}-${digest}`;
}
const ARMS: readonly Omit<EvaluationArm, "id">[] = [
  { family: "single", params: {}, roles: ["writer"], requires: ["b1-runner"] },
  { family: "single", params: { effort: "highest" }, roles: ["writer"], requires: ["b1-runner", "highest-effort"] },
  {
    family: "single",
    params: { review: true },
    roles: ["writer", "reviewer"],
    requires: ["b1-runner", "independent-review"],
  },
  { family: "explore+single", params: {}, roles: ["writer", "read-helper"], requires: ["b1-runner", "async-consult"] },
];
/** Unknown definitions and reserved extension points are different planning failures. */
export class EvaluationArmError extends Error {
  readonly code: "arm-unknown" | "arm-not-executable";

  constructor(code: "arm-unknown" | "arm-not-executable", id: string) {
    super(`${code}: ${id}`);
    this.name = "EvaluationArmError";
    this.code = code;
  }
}

function copyArm(arm: EvaluationArm): EvaluationArm {
  return { ...arm, params: structuredClone(arm.params), roles: [...arm.roles], requires: [...arm.requires] };
}

/** Caller-owned registry; future packages register data explicitly without extending global ID unions. */
export class EvaluationArmRegistry {
  readonly #arms = new Map<EvaluationArmId, EvaluationArm>();
  readonly #extensions = new Set<string>();

  /** Reserve a known family without claiming a runnable or fully planned arm. */
  registerExtension(family: string): void {
    canonicalArmId({ family, params: {} });
    this.#extensions.add(family);
  }

  /** Register one validated definition; duplicate identities and empty/duplicate role requirements are refused. */
  registerArm(definition: Omit<EvaluationArm, "id">): EvaluationArmId {
    const id = canonicalArmId(definition);
    for (const values of [definition.roles, definition.requires]) {
      if (
        !values.length ||
        new Set(values).size !== values.length ||
        values.some((value) => typeof value !== "string" || !/^[a-z][a-z0-9-]*$/.test(value))
      )
        throw new Error("invalid arm metadata");
    }
    if (this.#arms.has(id)) throw new Error("duplicate canonical arm");
    this.#arms.set(id, copyArm({ ...definition, id }));
    return id;
  }

  /** Return isolated metadata; changing the result never mutates later plans. */
  list(): EvaluationArm[] {
    return [...this.#arms.values()].map(copyArm);
  }

  /** Resolve only an explicitly registered identity, preserving the extension-point diagnostic. */
  resolve(definition: EvaluationArmSpec | EvaluationArmId): EvaluationArm {
    const id = typeof definition === "string" ? definition : canonicalArmId(definition);
    const arm = this.#arms.get(id);
    if (arm) return copyArm(arm);
    const slug = typeof definition === "string" ? (/^(.+)-[0-9a-f]{32}$/.exec(definition)?.[1] ?? definition) : "";
    const reserved =
      typeof definition === "string"
        ? [...this.#extensions].some((extension) => extension.replaceAll("+", "-") === slug)
        : this.#extensions.has(definition.family);
    throw new EvaluationArmError(reserved ? "arm-not-executable" : "arm-unknown", id);
  }
}

/** Build the initial controls and named future families; no registry entry invokes a model. */
export function createEvaluationArmRegistry(): EvaluationArmRegistry {
  const registry = new EvaluationArmRegistry();
  for (const definition of ARMS) registry.registerArm(definition);
  registry.registerExtension("team");
  registry.registerExtension("best-of-n");
  return registry;
}

/** Enumerate fresh copies of the registered planning definitions. */
export function evaluationArms(registry = createEvaluationArmRegistry()): EvaluationArm[] {
  return registry.list();
}

function allocation(value: unknown): TaskAllocation {
  const limits = closed(value, ["tokens", "maxRounds", "wallMs"]);
  if (
    Object.values(limits).some((item) => !Number.isSafeInteger(item) || Number(item) < 1) ||
    Number(limits.wallMs) > 0x7fffffff
  ) {
    throw new Error("evaluation allocation requires positive safe integers");
  }
  return { tokens: Number(limits.tokens), maxRounds: Number(limits.maxRounds), wallMs: Number(limits.wallMs) };
}

/** Bind every matched axis to the declared task; natural allocations must be explicit. */
export function planArm(
  task: Pick<TeamTask, "budgets">,
  definition: EvaluationArmSpec | EvaluationArmId,
  budget: EvaluationBudget,
  registry = createEvaluationArmRegistry(),
): {
  arm: EvaluationArm;
  budget: TaskAllocation & { regime: "matched" | "natural"; accounting: "all-model-calls"; pool: "shared-task" };
} {
  const arm = registry.resolve(definition);
  if (budget.regime === "matched") closed(budget, ["regime"]);
  else if (budget.regime === "natural") closed(budget, ["regime", "limits"]);
  else throw new Error("invalid evaluation budget regime");
  const limits = allocation(budget.regime === "matched" ? task.budgets : budget.limits);
  return { arm, budget: { ...limits, regime: budget.regime, accounting: "all-model-calls", pool: "shared-task" } };
}

/** Describe missing implementation capabilities; metadata does not grant tool authority. */
export function missingArmCapabilities(arm: EvaluationArm, capabilities: ReadonlySet<ArmCapability>): ArmCapability[] {
  return arm.requires.filter((capability) => !capabilities.has(capability));
}

/** Matched comparisons use task limits; natural maps name a complete allocation for every canonical ID. */
export type ComparisonBudget =
  | { regime: "matched" }
  | { regime: "natural"; caps: Partial<Record<EvaluationArmId, TaskAllocation>> };

/** Plan one task across distinct registered identities without multiplying a shared allocation by role count. */
export function planComparison(
  task: Pick<TeamTask, "budgets">,
  definitions: readonly (EvaluationArmSpec | EvaluationArmId)[],
  budget: ComparisonBudget,
  registry = createEvaluationArmRegistry(),
): ReturnType<typeof planArm>[] {
  const arms = definitions.map((definition) => registry.resolve(definition));
  const ids = arms.map((arm) => arm.id);
  if (!ids.length || new Set(ids).size !== ids.length) throw new Error("comparison requires distinct arms");
  if (budget.regime === "matched") closed(budget, ["regime"]);
  else if (budget.regime === "natural") {
    closed(budget, ["regime", "caps"]);
    const known = new Set(registry.list().map((arm) => arm.id));
    if (Object.keys(object(budget.caps)).some((key) => !known.has(key))) throw new Error("unknown natural budget arm");
  } else throw new Error("invalid comparison regime");
  return arms.map((arm) => {
    if (budget.regime === "matched") return planArm(task, arm, budget, registry);
    if (!Object.hasOwn(budget.caps, arm.id)) throw new Error(`missing natural budget for ${arm.id}`);
    return planArm(task, arm, { regime: "natural", limits: budget.caps[arm.id]! }, registry);
  });
}

/** Required capacity trial axes; this declaration contains no measured model throughput. */
export function localCapacityTrials(): { requestConcurrency: number[]; writerCapacityMultipliers: number[] } {
  return { requestConcurrency: [1, 2, 4], writerCapacityMultipliers: [1, 1.5, 2] };
}
