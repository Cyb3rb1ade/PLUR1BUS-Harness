// Hermes source for the importer (docs/import.md §3, §8), cited against hermes-agent @ 743ee72: HERMES_HOME
// resolution and home markers (hermes_constants.py), config version (hermes_cli/config_defaults.py `_config_version`),
// sessions schema (hermes_state_common.py SCHEMA_VERSION), skill dirs (get_skills_dir, skills.external_dirs,
// HERMES_OPTIONAL_SKILLS). Read-only throughout; each profile is its own agent (§3.3).
import { join, resolve } from "node:path";
import { envKeyNames, isDir, isFile, openSqliteReadOnly, readBounded, sqliteTables } from "../readonly.ts";
import { subdirs } from "../store-scan.ts";
import { readYaml } from "../yaml-lite.ts";
import { ImportError, secretConfigKeys, type AgentInfo, type SecretsReport, type SkillRoot, type SourceCtx, type SourceReport } from "../types.ts";

export const TESTED_CONFIG_VERSION = 45;
export const TESTED_SESSIONS_SCHEMA = 30;
const ROOT_MARKERS = ["config.yaml", ".env", "state.db"];
const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const expandHome = (p: string, h: string) => (p === "~" ? h : p.startsWith("~/") ? join(h, p.slice(2)) : p);

export function resolveHermesRoot(o: { source?: string | undefined; env: NodeJS.ProcessEnv; homedir: string }): { root: string; resolvedFrom: string } {
  if (o.source) return { root: resolve(expandHome(o.source, o.homedir)), resolvedFrom: "flag:--source" };
  if (o.env.HERMES_HOME?.trim()) return { root: resolve(expandHome(o.env.HERMES_HOME.trim(), o.homedir)), resolvedFrom: "env:HERMES_HOME" };
  return { root: join(o.homedir, ".hermes"), resolvedFrom: "default" };
}

interface ProfileFacts { agentId: string; dir: string; config: Record<string, any>; configVersion: number | null; unsupported: string[] }

function readProfile(agentId: string, dir: string): ProfileFacts {
  const text = readBounded(join(dir, "config.yaml"), 4 * 1024 * 1024);
  if (text === null) return { agentId, dir, config: {}, configVersion: null, unsupported: [] };
  const { value, unsupported } = readYaml(text);
  const config = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : {};
  const v = config._config_version;
  return { agentId, dir, config, configVersion: Number.isSafeInteger(v) ? (v as number) : null, unsupported };
}

function sessionsSchema(dir: string, warnings: string[]): number | null {
  const p = join(dir, "state.db");
  if (!isFile(p)) return null;
  try {
    const h = openSqliteReadOnly(p);
    try {
      if (!sqliteTables(h.db).includes("schema_version")) return null;
      const row = h.db.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version?: unknown } | undefined;
      if (h.mode === "immutable") warnings.push("state.db is larger than the copy limit; read without its WAL");
      return Number.isSafeInteger(Number(row?.version)) && row?.version !== null ? Number(row!.version) : null;
    } finally { h.close(); }
  } catch (e) {
    warnings.push(`state.db unreadable (${(e as Error).message})`);
    return null;
  }
}

export async function detectHermes(ctx: SourceCtx): Promise<SourceReport> {
  const { root, resolvedFrom } = resolveHermesRoot({ source: ctx.source, env: ctx.env, homedir: ctx.homedir });
  const warnings: string[] = [];
  if (!isDir(root)) throw new ImportError("E_SOURCE_NOT_FOUND", "source-missing", `no directory at ${root}`);
  if (!ROOT_MARKERS.some((m) => isFile(join(root, m)))) throw new ImportError("E_SOURCE_NOT_FOUND", "not-a-hermes-home", `${root} has none of ${ROOT_MARKERS.join(", ")}`);
  if (ctx.profile !== undefined && (!PROFILE_RE.test(ctx.profile) || !isDir(join(root, "profiles", ctx.profile)))) {
    throw new ImportError("E_SOURCE_NOT_FOUND", "profile-missing", `no profile ${JSON.stringify(ctx.profile)} under ${join(root, "profiles")}`);
  }
  const rootFacts = readProfile("default", root);
  if (rootFacts.configVersion === null) {
    throw new ImportError("E_SOURCE_UNSUPPORTED", "config-version-unreadable", `${join(root, "config.yaml")}: _config_version is missing or not an integer`);
  }
  const names = ctx.profile !== undefined ? [ctx.profile] : subdirs(join(root, "profiles")).filter((n) => PROFILE_RE.test(n) && !n.startsWith("."));
  const profiles: ProfileFacts[] = ctx.profile !== undefined ? [] : [rootFacts];
  for (const n of names) profiles.push(readProfile(n, join(root, "profiles", n)));
  for (const p of profiles) if (p.unsupported.length) warnings.push(`${p.agentId}/config.yaml: unsupported YAML (${p.unsupported.join("; ")}); those keys are unknown`);

  const versionWarnings: string[] = [];
  if (rootFacts.configVersion > TESTED_CONFIG_VERSION) versionWarnings.push(`config version ${rootFacts.configVersion} is newer than the tested ${TESTED_CONFIG_VERSION}`);
  const sessions = sessionsSchema(root, warnings);
  if (sessions !== null && sessions !== TESTED_SESSIONS_SCHEMA) versionWarnings.push(`sessions schema ${sessions} differs from the tested ${TESTED_SESSIONS_SCHEMA} (sessions are not imported yet)`);

  const agents: AgentInfo[] = profiles.map((p) => ({ agentId: p.agentId, workspace: p.dir, workspaceSource: p.agentId === "default" ? "root" : "profile", agentDir: p.dir, foundIn: [p.agentId === "default" ? "root" : "profiles"] }));

  const skillRoots: SkillRoot[] = [];
  for (const p of profiles) {
    skillRoots.push({ dir: join(p.dir, "skills"), tier: "profile", agentId: p.agentId, precedence: 3 });
    const ext = p.config.skills?.external_dirs;
    if (Array.isArray(ext)) for (const d of ext) if (typeof d === "string" && d.trim() && !/\$\{/.test(d)) skillRoots.push({ dir: resolve(p.dir, expandHome(d.trim(), ctx.homedir)), tier: "external", agentId: p.agentId, precedence: 2 });
  }
  const optional = ctx.env.HERMES_OPTIONAL_SKILLS?.trim();
  if (optional) skillRoots.push({ dir: resolve(expandHome(optional, ctx.homedir)), tier: "optional", agentId: null, precedence: 1 });
  skillRoots.sort((a, b) => a.precedence - b.precedence);

  const secrets: SecretsReport = { files: [], envKeys: [], configKeys: [] };
  for (const p of profiles) {
    const rel = p.agentId === "default" ? "" : `profiles/${p.agentId}/`;
    if (isFile(join(p.dir, ".env"))) { secrets.files.push({ path: `${rel}.env`, kind: "dotenv", present: true }); secrets.envKeys.push({ file: `${rel}.env`, keys: envKeyNames(join(p.dir, ".env")) }); }
    if (isFile(join(p.dir, "auth.json"))) secrets.files.push({ path: `${rel}auth.json`, kind: "auth-store", present: true });
    for (const k of secretConfigKeys(p.config)) secrets.configKeys.push({ ...k, path: `${rel}config.yaml:${k.path}` });
  }

  const memProvider = rootFacts.config.memory?.provider;
  const other = {
    soul: profiles.filter((p) => isFile(join(p.dir, "SOUL.md"))).length,
    memoryFiles: profiles.reduce((n, p) => n + (isFile(join(p.dir, "memories", "MEMORY.md")) ? 1 : 0) + (isFile(join(p.dir, "memories", "USER.md")) ? 1 : 0), 0),
    cronFiles: profiles.filter((p) => isFile(join(p.dir, "cron", "jobs.json"))).length,
    sessionsDb: isFile(join(root, "state.db")),
    note: "presence only; imported by M7",
  };
  return {
    sourceType: "hermes",
    source: { root, resolvedFrom, configPath: join(root, "config.yaml"), profile: ctx.profile ?? null },
    version: { release: null, stateSchema: null, configVersion: rootFacts.configVersion, sessionsSchema: sessions, supported: versionWarnings.length === 0, warnings: versionWarnings },
    agents,
    plur1bus: {
      installed: memProvider === "plur1bus", plugin: typeof memProvider === "string" && memProvider ? { memoryProvider: memProvider } : null,
      storeRoot: null, embeddingCache: null, reembedding: null, stores: [],
      note: "Hermes keeps no PLUR1BUS store (the Hermes MemoryProvider adapter is M8); stores and reranker are not applicable",
    },
    rerankers: [],
    skillRoots, secrets, other, warnings,
  };
}
