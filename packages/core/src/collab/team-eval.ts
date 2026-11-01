// PT-2 definitions only. K2 owns model execution and verifier/worktree provisioning.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export type TeamLanguage = 'typescript' | 'python' | 'rust' | 'go';
export interface TeamPackage {
  id: string;
  entry: string;
  symbol: string;
  owns: string[];
  dependsOn: string[];
  reference: string;
  checker: { path: string; scope: string };
}
export interface TeamTask {
  schema: 'plur1bus.team-task/1';
  id: string;
  title: string;
  kind: 'decomposable' | 'coupled';
  tier: 'team';
  language: TeamLanguage;
  license: 'MIT';
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
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('team task must contain objects');
  return value as JsonObject;
}
function closed(value: unknown, keys: string[]): JsonObject {
  const row = object(value);
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) throw new Error('invalid team task fields');
  return row;
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]*$/.test(value)) throw new Error('invalid team task identifier');
  return value;
}
function relativePath(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_./-]+$/.test(value) || value.startsWith('/') || value.split('/').some(part => part === '..' || part === '.' || !part)) throw new Error('invalid team task path');
  return value;
}
function strings(value: unknown, parse: (item: unknown) => string): string[] {
  if (!Array.isArray(value)) throw new Error('team task requires an array');
  const result = value.map(parse);
  if (new Set(result).size !== result.length) throw new Error('duplicate team task value');
  return result;
}
function checker(value: unknown): { path: string; scope: string } {
  const row = closed(value, ['path', 'scope']);
  return { path: relativePath(row.path), scope: identifier(row.scope) };
}
function taskPackage(value: unknown): TeamPackage {
  const row = closed(value, ['id', 'entry', 'symbol', 'owns', 'dependsOn', 'reference', 'checker']);
  if (typeof row.symbol !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(row.symbol)) throw new Error('invalid team task symbol');
  return { id: identifier(row.id), entry: relativePath(row.entry), symbol: row.symbol, owns: strings(row.owns, relativePath), dependsOn: strings(row.dependsOn, identifier), reference: relativePath(row.reference), checker: checker(row.checker) };
}

export function parseTeamTask(value: unknown): TeamTask {
  const row = closed(value, ['schema', 'id', 'title', 'kind', 'tier', 'language', 'license', 'seeds', 'budgets', 'instruction', 'start', 'seedGenerator', 'packages', 'endToEnd']);
  if (row.schema !== 'plur1bus.team-task/1' || row.license !== 'MIT') throw new Error('invalid team task schema or license');
  if (row.kind !== 'decomposable' && row.kind !== 'coupled') throw new Error('invalid team task kind');
  if (row.tier !== 'team') throw new Error('invalid team task tier');
  if (typeof row.language !== 'string' || !['typescript', 'python', 'rust', 'go'].includes(row.language)) throw new Error('invalid team task language');
  if (typeof row.title !== 'string' || !row.title.trim()) throw new Error('invalid team task title');
  if (!Array.isArray(row.seeds) || row.seeds.length !== 3 || row.seeds.some(seed => !Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) || new Set(row.seeds).size !== 3) throw new Error('team task requires three distinct uint32 seeds');
  const budgets = closed(row.budgets, ['tokens', 'maxRounds', 'wallMs']);
  if (Object.values(budgets).some(value => !Number.isSafeInteger(value) || Number(value) <= 0) || Number(budgets.wallMs) > 0x7fffffff) throw new Error('invalid team task budgets');
  if (!Array.isArray(row.packages) || row.packages.length < 3 || row.packages.length > 5) throw new Error('team task requires three to five packages');
  const packages = row.packages.map(taskPackage), ids = packages.map(item => item.id);
  if (new Set(ids).size !== ids.length) throw new Error('duplicate team package');
  for (const [index, item] of packages.entries()) {
    if (item.owns.length !== 1 || !item.owns.includes(item.entry) || item.checker.scope !== item.id || item.dependsOn.some(id => !ids.slice(0, index).includes(id))) throw new Error('invalid team package ownership, scope or dependency order');
    const extension = { typescript: 'ts', python: 'py', rust: 'rs', go: 'go' }[row.language as TeamLanguage];
    const pattern = row.language === 'go' ? /^src\/[a-z][a-z0-9-]*__SEED__\/solution__SEED__\.go$/ : new RegExp(`^src/[a-z][a-z0-9-]*\\.__SEED__\\.${extension}$`);
    if (item.owns.some(path => !pattern.test(path))) throw new Error('team ownership must name exact seeded source files');
  }
  if (row.kind === 'decomposable') {
    const owners = packages.flatMap(item => item.owns);
    if (new Set(owners).size !== owners.length) throw new Error('decomposable ownership cannot overlap');
  }
  const end = closed(row.endToEnd, ['checker', 'order']), order = strings(end.order, identifier);
  if (JSON.stringify(order) !== JSON.stringify(ids)) throw new Error('integration order must include every package');
  const task: TeamTask = { schema: row.schema, id: identifier(row.id), title: row.title, kind: row.kind, tier: row.tier, language: row.language as TeamLanguage, license: row.license, seeds: row.seeds as number[], budgets: budgets as TeamTask['budgets'], instruction: relativePath(row.instruction), start: relativePath(row.start), seedGenerator: relativePath(row.seedGenerator), packages, endToEnd: { checker: checker(end.checker), order } };
  if (task.endToEnd.checker.scope !== 'e2e') throw new Error('integration checker must use e2e scope');
  if (task.kind === 'decomposable' && new Set(packages.map(item => item.entry)).size !== packages.length) throw new Error('decomposable packages must have distinct entry files');
  if (task.kind === 'coupled' && new Set(packages.map(item => item.entry)).size !== 1) throw new Error('coupled references must share an entry file');
  return task;
}

export async function loadTeamTasks(root: URL): Promise<TeamTask[]> {
  if (root.protocol !== 'file:' || !root.pathname.endsWith('/')) throw new Error('team fixtures require an explicit directory file URL');
  const catalog: unknown = JSON.parse(await readFile(new URL('catalog.json', root), 'utf8'));
  const ids = strings(catalog, identifier);
  return Promise.all(ids.map(async id => {
    const task = parseTeamTask(JSON.parse(await readFile(new URL(`${id}/task.json`, root), 'utf8')));
    if (task.id !== id) throw new Error('team task directory does not match its id');
    return task;
  }));
}

export type ArmParameter = null | boolean | number | string | readonly ArmParameter[] | { readonly [key: string]: ArmParameter };
export interface EvaluationArmSpec { family: string; params: Readonly<Record<string, ArmParameter>> }
export type EvaluationArmId = string;
export type FutureArmFamily = 'team' | 'best-of-n';
export type ArmCapability = 'b1-runner' | 'highest-effort' | 'independent-review' | 'async-consult';
export interface EvaluationArm extends EvaluationArmSpec {
  id: EvaluationArmId;
  roles: readonly ('writer' | 'reviewer' | 'read-helper')[];
  requires: readonly ArmCapability[];
}
// Later packages supply their own binding; declaring a family never enables execution.
export type EvaluationArmExtension = EvaluationArmSpec & ({ family: 'team'; package: 'PT-4b' } | { family: 'best-of-n'; package: 'PT-10' });
export type EvaluationBudget = { regime: 'matched' | 'natural'; capTokens: number };

/** Exact JSON values: preserve strings and array order, sort object keys, refuse non-data inputs. */
function armJson(value: unknown, seen = new Set<object>(), depth = 0, visited = { count: 0 }): string {
  if (++visited.count > 4096) throw new Error('arm parameters exceed node limit');
  if (depth > 32) throw new Error('arm parameters exceed nesting limit');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (!value || typeof value !== 'object') throw new Error('arm parameters require finite JSON data');
  if (seen.has(value)) throw new Error('arm parameters cannot contain cycles');
  const array = Array.isArray(value);
  if (!array && ![null, Object.prototype].includes(Object.getPrototypeOf(value))) throw new Error('arm parameters require plain objects');
  const keys = Reflect.ownKeys(value);
  if (array && keys.length !== value.length + 1) throw new Error('arm parameter arrays must be dense');
  for (const key of keys) {
    if (array && key === 'length') continue;
    const property = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== 'string' || !property.enumerable || !Object.hasOwn(property, 'value') ||
        (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))) throw new Error('arm parameters require JSON data properties');
  }
  seen.add(value);
  try {
    return array ? `[${Array.from(value, item => armJson(item, seen, depth + 1, visited)).join(',')}]`
      : `{${(keys as string[]).sort().map(key => `${JSON.stringify(key)}:${armJson((value as Record<string, unknown>)[key], seen, depth + 1, visited)}`).join(',')}}`;
  } finally { seen.delete(value); }
}
/** Portable <=64-character identity. The empty single control retains B1's existing baseline ID. */
export function canonicalArmId(arm: EvaluationArmSpec): EvaluationArmId {
  if (!arm || typeof arm.family !== 'string' || !/^[a-z][a-z0-9+-]{0,30}$/.test(arm.family) || !arm.params || typeof arm.params !== 'object' || Array.isArray(arm.params)) throw new Error('invalid evaluation arm definition');
  const params = armJson(arm.params);
  if (arm.family === 'single' && params === '{}') return 'single';
  const descriptor = `{"family":${JSON.stringify(arm.family)},"params":${params}}`;
  const digest = createHash('sha256').update(descriptor, 'utf8').digest('hex').slice(0, 32);
  return `${arm.family.replaceAll('+', '-')}-${digest}`;
}
const ARMS: readonly Omit<EvaluationArm, 'id'>[] = [
  { family: 'single', params: {}, roles: ['writer'], requires: ['b1-runner'] },
  { family: 'single', params: { effort: 'highest' }, roles: ['writer'], requires: ['b1-runner', 'highest-effort'] },
  { family: 'single', params: { review: true }, roles: ['writer', 'reviewer'], requires: ['b1-runner', 'independent-review'] },
  { family: 'explore+single', params: {}, roles: ['writer', 'read-helper'], requires: ['b1-runner', 'async-consult'] },
];
export function evaluationArms(): EvaluationArm[] {
  return ARMS.map(arm => ({ ...arm, id: canonicalArmId(arm), params: structuredClone(arm.params), roles: [...arm.roles], requires: [...arm.requires] }));
}
const armId = (arm: EvaluationArmSpec | EvaluationArmId): EvaluationArmId => typeof arm === 'string' ? arm : canonicalArmId(arm);
export function planArm(definition: EvaluationArmSpec | EvaluationArmId, budget: EvaluationBudget): { arm: EvaluationArm; budget: EvaluationBudget & { accounting: 'all-model-calls'; pool: 'shared-task' } } {
  const id = armId(definition), arm = evaluationArms().find(candidate => candidate.id === id);
  if (!arm) throw new Error(`evaluation arm unavailable: ${id}`);
  if (!Number.isSafeInteger(budget.capTokens) || budget.capTokens <= 0) throw new Error('evaluation budget requires a positive safe integer token cap');
  if (budget.regime !== 'matched' && budget.regime !== 'natural') throw new Error('invalid evaluation budget regime');
  return { arm, budget: { regime: budget.regime, capTokens: budget.capTokens, accounting: 'all-model-calls', pool: 'shared-task' } };
}
export function missingArmCapabilities(arm: EvaluationArm, capabilities: ReadonlySet<ArmCapability>): ArmCapability[] {
  return arm.requires.filter(capability => !capabilities.has(capability));
}
export type ComparisonBudget = { regime: 'matched'; capTokens: number } | { regime: 'natural'; caps: Partial<Record<EvaluationArmId, number>> };
export function planComparison(definitions: readonly (EvaluationArmSpec | EvaluationArmId)[], budget: ComparisonBudget): ReturnType<typeof planArm>[] {
  const ids = definitions.map(armId);
  if (!ids.length || new Set(ids).size !== ids.length) throw new Error('comparison requires distinct arms');
  const value = object(budget);
  if (value.regime === 'matched') {
    if (!Object.hasOwn(value, 'capTokens') || Object.keys(value).some(key => !['regime', 'capTokens'].includes(key))) throw new Error('matched comparison requires one capTokens');
  } else if (value.regime === 'natural') {
    if (!Object.hasOwn(value, 'caps') || Object.keys(value).some(key => !['regime', 'caps'].includes(key))) throw new Error('natural comparison requires explicit caps');
    const caps = object(value.caps), known = new Set<string>(evaluationArms().map(arm => arm.id));
    if (Object.keys(caps).some(key => !known.has(key))) throw new Error('unknown natural budget arm');
  } else throw new Error('invalid comparison regime');
  return ids.map(id => {
    const capTokens = budget.regime === 'matched' ? budget.capTokens : Object.hasOwn(budget.caps, id) ? budget.caps[id] : undefined;
    if (capTokens === undefined) throw new Error(`missing natural budget for ${id}`);
    return planArm(id, { regime: budget.regime, capTokens });
  });
}
export function localCapacityTrials(): { requestConcurrency: number[]; writerCapacityMultipliers: number[] } {
  return { requestConcurrency: [1, 2, 4], writerCapacityMultipliers: [1, 1.5, 2] };
}
