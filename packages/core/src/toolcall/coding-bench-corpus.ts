/** Original B1 corpus loading; only seeded starting files and instructions enter agent worktrees. */
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { join, posix } from "node:path";
import { pathToFileURL } from "node:url";

/** Fixed original-set tiers; each contributes eight tasks. */
export type CodingTier = "easy" | "medium" | "hard";
/** Original-set runtimes use only their standard libraries. */
export type CodingLanguage = "rust" | "typescript" | "python" | "go" | "shell";
/** Per-task admission and execution bounds, unchanged between compared runs. */
export interface CodingBudgets {
  tokens: number;
  rounds: number;
  wallMs: number;
}
/** Closed task format; a generator/checker is trusted corpus code, never supplied by a model. */
export interface CodingTaskMeta {
  schema: "plur1bus.coding-task/1";
  id: string;
  tier: CodingTier;
  language: CodingLanguage;
  kind: "repository" | "terminal";
  license: "MIT";
  origin: "self-authored";
  entry: string;
  signature: string;
  instruction: string;
  network: false;
  budgets: CodingBudgets;
  generator: "generate.mjs";
  checker: "checker.mjs";
  introduced: string;
}
/** Private corpus location; never passed to an agent subject or its tools. */
export interface CodingTask {
  meta: CodingTaskMeta;
  directory: string;
}
/** Deterministic task data; the seed is not a claim about model sampling. */
export interface CodingVariant {
  seed: number;
  tag: string;
  symbol: string;
  constant: number;
  entry: string;
}
/** Public source file; shell entries are executable, every other generated file is private. */
export interface CodingSourceFile {
  text: string;
  mode: number;
}
/** Everything needed to provision the public tree, with no reference/checker paths. */
export interface CodingInstance {
  variant: CodingVariant;
  instruction: string;
  files: Map<string, CodingSourceFile>;
}
/** A content-addressed, balanced original set, including its hidden checker and reference versions. */
export interface CodingCorpus {
  root: string;
  fingerprint: string;
  seeds: number[];
  tasks: CodingTask[];
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid coding object");
  return value as Record<string, unknown>;
}
function closed(row: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(row).length !== keys.length || Object.keys(row).some((key) => !keys.includes(key))) {
    throw new Error("invalid coding fields");
  }
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value || value.length > maximum || !value.isWellFormed()) {
    throw new Error("invalid coding text");
  }
  return value;
}
function path(value: unknown): string {
  const result = text(value, 256);
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(result) ||
    result.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("invalid coding path");
  return result;
}
function count(value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
    throw new Error("invalid coding budget");
  }
  return value as number;
}

/** Parse the closed original task contract; unknown fields, paths, licences and network declarations refuse. */
export function parseCodingTask(value: unknown): CodingTaskMeta {
  const row = object(value);
  closed(row, [
    "schema",
    "id",
    "tier",
    "language",
    "kind",
    "license",
    "origin",
    "entry",
    "signature",
    "instruction",
    "network",
    "budgets",
    "generator",
    "checker",
    "introduced",
  ]);
  if (
    row.schema !== "plur1bus.coding-task/1" ||
    row.license !== "MIT" ||
    row.origin !== "self-authored" ||
    row.network !== false ||
    row.generator !== "generate.mjs" ||
    row.checker !== "checker.mjs" ||
    typeof row.tier !== "string" ||
    !["easy", "medium", "hard"].includes(row.tier) ||
    typeof row.language !== "string" ||
    !["rust", "typescript", "python", "go", "shell"].includes(row.language) ||
    typeof row.kind !== "string" ||
    !["repository", "terminal"].includes(row.kind)
  )
    throw new Error("invalid coding task contract");
  const id = text(row.id, 64);
  if (!/^[a-z][a-z0-9-]+$/u.test(id)) throw new Error("invalid coding id");
  const budgets = object(row.budgets);
  closed(budgets, ["tokens", "rounds", "wallMs"]);
  const introduced = text(row.introduced, 7);
  if (!/^20[0-9]{2}-Q[1-4]$/u.test(introduced)) throw new Error("invalid coding quarter");
  return {
    schema: row.schema,
    id,
    tier: row.tier as CodingTier,
    language: row.language as CodingLanguage,
    kind: row.kind as CodingTaskMeta["kind"],
    license: row.license,
    origin: row.origin,
    network: false,
    generator: row.generator,
    checker: row.checker,
    introduced,
    entry: path(row.entry),
    signature: text(row.signature, 2048),
    instruction: text(row.instruction, 8192),
    budgets: {
      tokens: count(budgets.tokens, 1_000_000),
      rounds: count(budgets.rounds, 100),
      wallMs: count(budgets.wallMs, 600_000),
    },
  };
}

async function files(root: string): Promise<Map<string, Buffer>> {
  const result = new Map<string, Buffer>();
  let total = 0;
  async function walk(relative: string): Promise<void> {
    for (const name of (await readdir(join(root, relative))).sort()) {
      const rel = relative ? `${relative}/${name}` : name;
      const file = join(root, rel);
      const stat = await lstat(file);
      if (stat.isSymbolicLink()) throw new Error("coding corpus link refused");
      if (stat.isDirectory()) await walk(rel);
      else {
        if (!stat.isFile() || stat.size > 1_048_576 || result.size >= 1024 || total + stat.size > 16_777_216) {
          throw new Error("coding corpus limit");
        }
        const data = await readFile(file);
        total += data.length;
        result.set(rel, data);
      }
    }
  }
  await walk("");
  return result;
}

/** Load exactly the original 24-task distribution and hash every corpus byte in path order. */
export async function loadCodingCorpus(directory: string): Promise<CodingCorpus> {
  if (!(await lstat(directory)).isDirectory() || (await lstat(directory)).isSymbolicLink()) {
    throw new Error("invalid coding corpus root");
  }
  const root = await realpath(directory);
  const all = await files(root);
  const tasks: CodingTask[] = [];
  for (const [name, data] of all) {
    if (!/^[a-z0-9-]+\/task\.json$/u.test(name)) continue;
    const meta = parseCodingTask(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)));
    if (name !== `${meta.id}/task.json`) throw new Error("coding id and directory disagree");
    for (const required of [meta.generator, meta.checker, `start/${meta.entry}`, `reference/${meta.entry}`]) {
      if (!all.has(`${meta.id}/${required}`)) throw new Error("incomplete coding task");
    }
    tasks.push({ meta, directory: join(root, meta.id) });
  }
  tasks.sort((a, b) => (a.meta.id < b.meta.id ? -1 : a.meta.id > b.meta.id ? 1 : 0));
  if (
    tasks.length !== 24 ||
    new Set(tasks.map((task) => task.meta.id)).size !== 24 ||
    ["easy", "medium", "hard"].some((tier) => tasks.filter((task) => task.meta.tier === tier).length !== 8) ||
    tasks.filter((task) => task.meta.kind === "repository").length !== 12 ||
    new Set(tasks.map((task) => task.meta.language)).size !== 5
  )
    throw new Error("unbalanced coding corpus");
  const hash = createHash("sha256");
  for (const [name, data] of [...all].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    hash.update(JSON.stringify([name, data.length]));
    hash.update(data);
  }
  const seedModule: unknown = await import(pathToFileURL(join(root, "seed.mjs")).href);
  const seeds = object(seedModule).CODING_SEEDS;
  if (
    !Array.isArray(seeds) ||
    seeds.length !== 3 ||
    new Set(seeds).size !== 3 ||
    seeds.some((seed) => !Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff)
  ) {
    throw new Error("invalid canonical coding seeds");
  }
  return { root, fingerprint: hash.digest("hex"), tasks, seeds: [...seeds] as number[] };
}

async function variant(task: CodingTask, seed: number): Promise<CodingVariant> {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error("invalid coding seed");
  const imported: unknown = await import(pathToFileURL(join(task.directory, task.meta.generator)).href);
  const generator = object(imported).generate;
  if (typeof generator !== "function") throw new Error("missing coding generator");
  const value = object(await generator(seed));
  closed(value, ["seed", "tag", "symbol", "constant", "entry"]);
  const tag = text(value.tag, 32);
  if (value.seed !== seed || !/^[a-z0-9]+_[a-f0-9]{6}$/u.test(tag) || value.symbol !== `solve_${tag}`) {
    throw new Error("invalid coding variant");
  }
  const entry = path(value.entry);
  const extension = posix.extname(task.meta.entry);
  const expected = posix.join(
    posix.dirname(task.meta.entry),
    `${posix.basename(task.meta.entry, extension)}_${tag}${extension}`,
  );
  if (entry !== expected) throw new Error("invalid seeded coding entry");
  return { seed, tag, symbol: value.symbol as string, constant: count(value.constant, 18), entry };
}

/** Render start or trusted reference data; the live runner provisions only `start` for model subjects. */
export async function renderCodingTask(
  task: CodingTask,
  seed: number,
  stage: "start" | "reference",
): Promise<CodingInstance> {
  if (stage !== "start" && stage !== "reference") throw new Error("invalid coding stage");
  const generated = await variant(task, seed);
  const replace = (value: string): string =>
    value
      .replaceAll("BENCH_FN", generated.symbol)
      .replaceAll("BENCH_CONST", String(generated.constant))
      .replaceAll("BENCH_ENTRY", generated.entry)
      .replaceAll("{{symbol}}", generated.symbol)
      .replaceAll("{{entry}}", generated.entry)
      .replaceAll("{{constant}}", String(generated.constant));
  const rendered = new Map<string, CodingSourceFile>();
  for (const [name, data] of await files(join(task.directory, stage))) {
    const target = name === task.meta.entry ? generated.entry : name;
    rendered.set(target, {
      text: replace(new TextDecoder("utf-8", { fatal: true }).decode(data)),
      mode: name.endsWith(".sh") ? 0o700 : 0o600,
    });
  }
  const instruction = replace(task.meta.instruction);
  rendered.set("README.md", {
    mode: 0o600,
    text:
      `# Original coding task: ${task.meta.id}\n\n${instruction}\n\n` +
      `API: ${replace(task.meta.signature)}\n\nTask seed: ${seed}. Standard libraries only; no network.\n`,
  });
  return { variant: generated, instruction, files: rendered };
}
