// OpenClaw source for the importer (docs/import.md §2, §8). Every path and rule here is cited against the OpenClaw
// checkout the spec was written from (b9421f4): state-dir resolution (src/config/state-dir.ts, paths.ts,
// src/cli/profile-utils.ts), the agent roster (src/agents/agent-roster.ts, agent-scope-config.ts), skill roots
// (src/skills/loading/workspace-skill-sources.ts), plugin install dirs (src/plugins/install-paths.ts), the state DB
// schema marker (src/state/openclaw-state-db-maintenance.ts). Read-only throughout.
import { readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { classifyReranker, compareReranker } from "../identity.ts";
import { parseJson5 } from "../json5.ts";
import { envKeyNames, isDir, isFile, openSqliteReadOnly, readBounded, sqliteTables } from "../readonly.ts";
import { scanStoreRoot, subdirs } from "../store-scan.ts";
import { ImportError, secretConfigKeys, type AgentInfo, type SecretsReport, type SkillRoot, type SourceCtx, type SourceReport } from "../types.ts";

export const PLUGIN_ID = "memory-lancedb-namespaced";
const ENGINE_PACKAGE = "@cyb3rb1ade/plur1bus-memory";
/** The state DB schema version of the OpenClaw release the spec was verified against (b9421f4). */
export const TESTED_STATE_SCHEMA = 17;
const PROFILE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export function resolveOpenclawRoot(o: { source?: string | undefined; env: NodeJS.ProcessEnv; homedir: string }): { root: string; resolvedFrom: string; configPath: string } {
  const env = o.env;
  const home = env.OPENCLAW_HOME?.trim() ? resolve(expandHome(env.OPENCLAW_HOME.trim(), o.homedir)) : o.homedir;
  let root: string; let resolvedFrom: string;
  if (o.source) { root = resolve(expandHome(o.source, o.homedir)); resolvedFrom = "flag:--source"; }
  else if (env.OPENCLAW_STATE_DIR?.trim()) { root = resolve(expandHome(env.OPENCLAW_STATE_DIR.trim(), home)); resolvedFrom = "env:OPENCLAW_STATE_DIR"; }
  else if (env.OPENCLAW_PROFILE?.trim() && env.OPENCLAW_PROFILE.trim().toLowerCase() !== "default") {
    const p = env.OPENCLAW_PROFILE.trim();
    if (!PROFILE_RE.test(p)) throw new ImportError("E_INVALID_PARAMS", "invalid-profile", `OPENCLAW_PROFILE ${JSON.stringify(p)} is not a valid profile name`);
    root = join(home, `.openclaw-${p}`); resolvedFrom = "env:OPENCLAW_PROFILE";
  } else { root = join(home, ".openclaw"); resolvedFrom = env.OPENCLAW_HOME?.trim() ? "env:OPENCLAW_HOME" : "default"; }
  const configPath = !o.source && env.OPENCLAW_CONFIG_PATH?.trim() ? resolve(expandHome(env.OPENCLAW_CONFIG_PATH.trim(), home)) : join(root, "openclaw.json");
  return { root, resolvedFrom, configPath };
}

function expandHome(p: string, homedir: string): string {
  return p === "~" ? homedir : p.startsWith("~/") || p.startsWith("~\\") ? join(homedir, p.slice(2)) : p;
}

/** A path from the source's config: `~`, `${OPENCLAW_HOME}` (the state dir, as the plugin binds it) and relative paths
 *  (against the state dir) are resolved; any other `${VAR}` is left unresolved (null) — the environment is not read. */
export function expandConfigPath(p: unknown, root: string, homedir: string): string | null {
  if (typeof p !== "string" || !p.trim()) return null;
  const s = p.trim().replaceAll("${OPENCLAW_HOME}", root);
  if (/\$\{[^}]*\}/.test(s)) return null;
  const e = expandHome(s, homedir);
  return isAbsolute(e) ? resolve(e) : resolve(root, e);
}

const obj = (v: unknown): Record<string, any> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : undefined);

function readStateSchema(root: string, warnings: string[]): { schema: number | null; cronJobs: number | null } {
  const p = join(root, "state", "openclaw.sqlite");
  if (!isFile(p)) return { schema: null, cronJobs: null };
  try {
    const h = openSqliteReadOnly(p);
    try {
      const tables = sqliteTables(h.db);
      let schema: number | null = null;
      if (tables.includes("schema_meta")) {
        const row = h.db.prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary' LIMIT 1").get() as { schema_version?: unknown } | undefined;
        schema = Number.isSafeInteger(Number(row?.schema_version)) && row?.schema_version !== null && row?.schema_version !== undefined ? Number(row.schema_version) : null;
      }
      const cronJobs = tables.includes("cron_jobs") ? Number((h.db.prepare("SELECT COUNT(*) AS n FROM cron_jobs").get() as { n: number }).n) : null;
      return { schema, cronJobs };
    } finally { h.close(); }
  } catch (e) {
    warnings.push(`state/openclaw.sqlite unreadable (${(e as Error).message})`);
    return { schema: null, cronJobs: null };
  }
}

function pluginVersion(root: string, cfg: Record<string, any>): { version: string | null; versionSource: string | null; path: string | null } {
  const candidates: string[] = [];
  for (const d of subdirs(join(root, "extensions"))) candidates.push(join(root, "extensions", d));
  for (const d of subdirs(join(root, "npm", "projects"))) candidates.push(join(root, "npm", "projects", d, "node_modules", ...ENGINE_PACKAGE.split("/")));
  candidates.push(join(root, "npm", "node_modules", ...ENGINE_PACKAGE.split("/")));
  for (const dir of candidates) {
    const text = readBounded(join(dir, "package.json"), 1024 * 1024);
    if (!text) continue;
    try {
      const pkg = JSON.parse(text) as { name?: string; version?: string };
      if (pkg.name === ENGINE_PACKAGE && typeof pkg.version === "string") return { version: pkg.version, versionSource: "package.json", path: dir };
    } catch { /* not a package */ }
  }
  const rec = obj(obj(cfg.plugins)?.installs)?.[PLUGIN_ID];
  if (typeof rec?.version === "string") return { version: rec.version, versionSource: "config:plugins.installs", path: null };
  return { version: null, versionSource: null, path: null };
}

function agents(root: string, cfg: Record<string, any>, homedir: string): AgentInfo[] {
  const a = obj(cfg.agents);
  const found = new Map<string, { entry: Record<string, any>; foundIn: Set<string> }>();
  const add = (id: unknown, entry: Record<string, any>, where: string) => {
    if (typeof id !== "string" || !id.trim()) return;
    const key = id.trim().toLowerCase();
    const cur = found.get(key) ?? { entry: {}, foundIn: new Set<string>() };
    cur.entry = { ...entry, ...cur.entry }; cur.foundIn.add(where); found.set(key, cur);
  };
  const entries = obj(a?.entries);
  if (entries) for (const [id, e] of Object.entries(entries)) add(obj(e)?.id ?? id, obj(e) ?? {}, "config");
  else if (Array.isArray(a?.list)) for (const e of a!.list) add(obj(e)?.id, obj(e) ?? {}, "config");
  else add("main", {}, "implicit");
  for (const d of subdirs(join(root, "agents"))) add(d, {}, "directory");
  const defaultsWs = expandConfigPath(obj(a?.defaults)?.workspace, root, homedir);
  const ids = [...found.keys()].sort();
  return ids.map((id) => {
    const { entry, foundIn } = found.get(id)!;
    const configured = expandConfigPath(entry.workspace, root, homedir);
    let workspace: string; let workspaceSource: string;
    if (configured) { workspace = configured; workspaceSource = "config"; }
    else if (defaultsWs) { workspace = id === "main" ? defaultsWs : join(defaultsWs, id); workspaceSource = "config:agents.defaults.workspace"; }
    else { workspace = id === "main" ? join(root, "workspace") : join(root, `workspace-${id}`); workspaceSource = "default"; }
    const agentDir = expandConfigPath(entry.agentDir, root, homedir) ?? join(root, "agents", id, "agent");
    return { agentId: id, workspace, workspaceSource, agentDir, foundIn: [...foundIn].sort() };
  });
}

function countFiles(dir: string): number {
  try { return readdirSync(dir).length; } catch { return 0; }
}

export async function detectOpenclaw(ctx: SourceCtx): Promise<SourceReport> {
  const { root, resolvedFrom, configPath } = resolveOpenclawRoot({ source: ctx.source, env: ctx.env, homedir: ctx.homedir });
  const warnings: string[] = [];
  if (ctx.profile) throw new ImportError("E_INVALID_PARAMS", "profile-not-supported", "--profile applies to Hermes; select an OpenClaw profile with --source <state-dir> or OPENCLAW_PROFILE");
  if (!isDir(root)) throw new ImportError("E_SOURCE_NOT_FOUND", "source-missing", `no directory at ${root}`);
  const hasConfig = isFile(configPath);
  if (!hasConfig && !isFile(join(root, "state", "openclaw.sqlite"))) {
    throw new ImportError("E_SOURCE_NOT_FOUND", "not-an-openclaw-state-dir", `${root} has neither openclaw.json nor state/openclaw.sqlite`);
  }
  let cfg: Record<string, any> = {};
  if (hasConfig) {
    const text = readBounded(configPath, 16 * 1024 * 1024);
    if (text === null) throw new ImportError("E_SOURCE_UNSUPPORTED", "config-unreadable", `${configPath} is not a readable file under 16 MiB`);
    try { cfg = obj(parseJson5(text)) ?? {}; } catch (e) { throw new ImportError("E_SOURCE_UNSUPPORTED", "config-unparseable", `${configPath}: ${(e as Error).message}`); }
    if (/["']?\$include["']?\s*:/.test(text)) warnings.push("openclaw.json uses $include; included files were not followed");
  }
  const release = typeof obj(cfg.meta)?.lastTouchedVersion === "string" ? cfg.meta.lastTouchedVersion as string : null;
  const state = readStateSchema(root, warnings);
  if (release === null && state.schema === null) throw new ImportError("E_SOURCE_UNSUPPORTED", "version-undeterminable", `${root}: neither meta.lastTouchedVersion in openclaw.json nor a state schema version in state/openclaw.sqlite`);
  const versionWarnings: string[] = [];
  if (state.schema !== null && state.schema > TESTED_STATE_SCHEMA) versionWarnings.push(`state schema ${state.schema} is newer than the tested ${TESTED_STATE_SCHEMA}`);

  const agentList = agents(root, cfg, ctx.homedir);
  const entry = obj(obj(obj(cfg.plugins)?.entries)?.[PLUGIN_ID]);
  const pcfg = obj(entry?.config) ?? {};
  const pv = pluginVersion(root, cfg);
  const baseFromCfg = expandConfigPath(pcfg.baseDbPath, root, ctx.homedir);
  if (pcfg.baseDbPath && !baseFromCfg) warnings.push("PLUR1BUS baseDbPath uses an environment variable; the default path was scanned instead");
  const baseDbPath = baseFromCfg ?? join(root, "memory", "lancedb-namespaced");
  const installed = !!entry || pv.version !== null || isDir(baseDbPath);
  let plur1bus: SourceReport["plur1bus"] = { installed, plugin: null, storeRoot: null, embeddingCache: null, reembedding: null, stores: [] };
  if (installed) {
    const emb = obj(pcfg.embedding);
    const cacheDirCfg = emb?.local?.cacheDir ?? emb?.cacheDir;
    const modelCacheDir = cacheDirCfg ? expandConfigPath(cacheDirCfg, root, ctx.homedir) : join(root, "models", "plur1bus");
    const scan = await scanStoreRoot({ baseDbPath, baseDbPathSource: baseFromCfg ? "config" : "default", config: pcfg, modelCacheDir, target: ctx.target.embedding });
    warnings.push(...scan.warnings);
    plur1bus = {
      installed,
      plugin: { id: PLUGIN_ID, configured: !!entry, enabled: typeof entry?.enabled === "boolean" ? entry.enabled : null, version: pv.version, versionSource: pv.versionSource, path: pv.path },
      storeRoot: scan.storeRoot, embeddingCache: scan.embeddingCache, reembedding: scan.reembedding, stores: scan.stores,
    };
  }
  const rerankers = installed ? [(() => { const r = classifyReranker(obj(pcfg.reranker), "default"); return { ...r, comparison: compareReranker(r, ctx.target.reranker), plannedAction: "report-only" as const }; })()] : [];

  // Skill roots, low → high precedence (workspace-skill-sources.ts).
  const skillRoots: SkillRoot[] = [];
  const extra = obj(obj(cfg.skills)?.load)?.extraDirs;
  if (Array.isArray(extra)) for (const d of extra) { const p = expandConfigPath(d, root, ctx.homedir); if (p) skillRoots.push({ dir: p, tier: "extra", agentId: null, precedence: 1 }); }
  const bundled = ctx.env.OPENCLAW_BUNDLED_SKILLS_DIR?.trim();
  if (bundled) skillRoots.push({ dir: resolve(expandHome(bundled, ctx.homedir)), tier: "bundled", agentId: null, precedence: 2 });
  for (const a of agentList) if (a.agentDir) skillRoots.push({ dir: join(a.agentDir, "workshop-skills"), tier: "workshop", agentId: a.agentId, precedence: 3 });
  skillRoots.push({ dir: join(root, "skills"), tier: "managed", agentId: null, precedence: 4 });
  if (resolvedFrom === "default") skillRoots.push({ dir: join(ctx.homedir, ".agents", "skills"), tier: "personal", agentId: null, precedence: 5 });
  for (const a of agentList) if (a.workspace) {
    skillRoots.push({ dir: join(a.workspace, ".agents", "skills"), tier: "project", agentId: a.agentId, precedence: 6 });
    skillRoots.push({ dir: join(a.workspace, "skills"), tier: "workspace", agentId: a.agentId, precedence: 7 });
  }

  const secrets: SecretsReport = { files: [], envKeys: [], configKeys: secretConfigKeys(cfg) };
  if (isFile(join(root, ".env"))) { secrets.files.push({ path: ".env", kind: "dotenv", present: true }); secrets.envKeys.push({ file: ".env", keys: envKeyNames(join(root, ".env")) }); }
  if (isDir(join(root, "credentials"))) secrets.files.push({ path: "credentials/", kind: "credential-store", present: true, entries: countFiles(join(root, "credentials")) });
  if (isFile(join(root, "auth-profiles.json"))) secrets.files.push({ path: "auth-profiles.json", kind: "legacy-auth-profiles", present: true });
  for (const a of subdirs(join(root, "agents"))) {
    if (isFile(join(root, "agents", a, "agent", "openclaw-agent.sqlite"))) secrets.files.push({ path: `agents/${a}/agent/openclaw-agent.sqlite`, kind: "auth-store", present: true });
    if (isFile(join(root, "agents", a, "agent", "auth-profiles.json"))) secrets.files.push({ path: `agents/${a}/agent/auth-profiles.json`, kind: "legacy-auth-profiles", present: true });
  }

  const ws = agentList.map((a) => a.workspace).filter((w): w is string => !!w);
  const other = {
    soul: ws.filter((w) => isFile(join(w, "SOUL.md"))).length,
    memoryFiles: ws.reduce((n, w) => n + (isFile(join(w, "MEMORY.md")) ? 1 : 0) + (isFile(join(w, "USER.md")) ? 1 : 0), 0),
    dreamsFiles: ws.filter((w) => isFile(join(w, "DREAMS.md")) || isFile(join(w, "dreams.md"))).length,
    cronJobs: state.cronJobs,
    note: "presence only; imported by M7",
  };
  return {
    sourceType: "openclaw",
    source: { root, resolvedFrom, configPath: hasConfig ? configPath : null, profile: null },
    version: { release, stateSchema: state.schema, configVersion: null, sessionsSchema: null, supported: versionWarnings.length === 0, warnings: versionWarnings },
    agents: agentList, plur1bus, rerankers, skillRoots, secrets, other, warnings,
  };
}
