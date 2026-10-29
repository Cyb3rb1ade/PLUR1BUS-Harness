// Hermes source for the importer (docs/import.md §3, §8), cited against hermes-agent @ 743ee72: HERMES_HOME
// resolution and home markers (hermes_constants.py), config version (hermes_cli/config_defaults.py `_config_version`),
// sessions schema (hermes_state_common.py SCHEMA_VERSION), skill dirs (get_skills_dir, skills.external_dirs,
// HERMES_OPTIONAL_SKILLS). Read-only throughout; each profile is its own agent (§3.3).
import { verifySourceSnapshotAsync } from "../snapshot-source.ts";
import { SourceReader } from "../source-reader.ts";
import { envGet, expandTilde, expandUser, expandVars, locateSource, pathFor, portabilityOf, SourcePathMapper, userHome } from "../paths.ts";
import { sqliteTables, sqliteWarning } from "../readonly.ts";

import { caseCollisions, caseInsensitiveTarget, unportableName } from "../skills-scan.ts";

import { readYaml } from "../yaml-lite.ts";
import { ImportError, secretConfigKeys, type AgentInfo, type SecretsReport, type SkillRoot, type SourceCtx, type SourceReport } from "../types.ts";

export const TESTED_CONFIG_VERSION = 45;
export const TESTED_SESSIONS_SCHEMA = 30;
const ROOT_MARKERS = ["config.yaml", ".env", "state.db"];
const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The platform default (hermes_constants.py `_get_platform_default_hermes_home`): `%LOCALAPPDATA%\hermes` on Windows
 *  (else `~\AppData\Local\hermes`), `~/.hermes` elsewhere. */
export function defaultHermesHome(env: NodeJS.ProcessEnv, homedir: string, platform: NodeJS.Platform): string {
  const P = pathFor(platform);
  const home = userHome(env, homedir, platform);
  if (platform !== "win32") return P.join(home, ".hermes");
  const local = envGet(env, "LOCALAPPDATA", platform)?.trim();
  return P.join(local || P.join(home, "AppData", "Local"), "hermes");
}

/** `--source`, else `HERMES_HOME` (expandvars + expanduser, as Hermes does), else the platform default. A
 *  `HERMES_HOME` of `<root>/profiles/<name>` (profile mode) resolves to `<root>` plus that profile
 *  (`get_default_hermes_root`). */
export function resolveHermesRoot(o: { source?: string | undefined; env: NodeJS.ProcessEnv; homedir: string; platform?: NodeJS.Platform | undefined }): { root: string; resolvedFrom: string; profile: string | null } {
  const platform = o.platform ?? process.platform;
  const P = pathFor(platform);
  if (o.source) {
    if (o.source.startsWith("wsl:")) {
      const loc = locateSource({ skipSnapshotCheck: true, accessRoot: o.source, platform, env: o.env, home: o.homedir });
      return { root: loc.accessRoot, resolvedFrom: "flag:--source", profile: null };
    }
    return { root: P.resolve(expandTilde(o.source, o.homedir, platform)), resolvedFrom: "flag:--source", profile: null };
  }
  const env = envGet(o.env, "HERMES_HOME", platform)?.trim();
  if (env) {
    const p = P.resolve(expandUser(expandVars(env, o.env, platform), o.env, o.homedir, platform));
    const parent = P.dirname(p);
    const isProfiles = platform === "win32" ? P.basename(parent).toLowerCase() === "profiles" : P.basename(parent) === "profiles";
    if (isProfiles && P.basename(p)) return { root: P.dirname(parent), resolvedFrom: "env:HERMES_HOME", profile: P.basename(p) };
    return { root: p, resolvedFrom: "env:HERMES_HOME", profile: null };
  }
  return { root: defaultHermesHome(o.env, o.homedir, platform), resolvedFrom: "default", profile: null };
}

interface ProfileFacts { agentId: string; dir: string; config: Record<string, any>; configVersion: number | null; unsupported: string[] }

async function readProfile(agentId: string, dir: string, reader: SourceReader): Promise<ProfileFacts> {
  const { join } = reader.paths;
  const configPath = join(dir, "config.yaml");
  if (!await reader.exists(configPath)) return { agentId, dir, config: {}, configVersion: null, unsupported: [] };
  let text: string;
  try {
    text = await reader.text(configPath, 4 * 1024 * 1024);
  } catch (error) {
    const reason = error instanceof ImportError ? error.reason : "source-unreadable";
    throw new ImportError("E_SOURCE_UNSUPPORTED", reason, `${configPath}: ${reason}`);
  }
  const { value, unsupported } = readYaml(text);
  if (unsupported.some(issue => /not a mapping entry|unexpected indentation/.test(issue))) {
    throw new ImportError("E_SOURCE_UNSUPPORTED", "yaml-unparseable", `${configPath}: yaml-unparseable`);
  }
  const config = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : {};
  const v = config._config_version;
  return { agentId, dir, config, configVersion: Number.isSafeInteger(v) ? (v as number) : null, unsupported };
}

async function sessionsSchema(dir: string, warnings: string[], reader: SourceReader): Promise<number | null> {
  const { join } = reader.paths;
  const p = join(dir, "state.db");
  if (!await reader.isFile(p)) return null;
  try {
    return await reader.sqlite(p, h => {
      if (!sqliteTables(h.db).includes("schema_version")) return null;
      const row = h.db.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version?: unknown } | undefined;
      const w = sqliteWarning(h, "state.db"); if (w) warnings.push(w);
      return Number.isSafeInteger(Number(row?.version)) && row?.version !== null ? Number(row!.version) : null;
    });
  } catch (e) {
    SourceReader.refuseFatal(e);
    warnings.push(`state.db unreadable (${(e as Error).message})`);
    return null;
  }
}

export async function detectHermes(ctx: SourceCtx): Promise<SourceReport> {
  const reader = ctx.reader ?? await SourceReader.local();
  const { join, resolve } = reader.paths;
  const { root, resolvedFrom, profile: envProfile } = resolveHermesRoot({ source: ctx.source, env: ctx.env, homedir: ctx.homedir, platform: reader.remote ? "linux" : ctx.platform });
  const warnings: string[] = [];
  const snapshot = await verifySourceSnapshotAsync(root, ctx.home, reader);
  if (envProfile !== null && ctx.profile !== undefined && ctx.profile !== envProfile) {
    throw new ImportError("E_INVALID_PARAMS", "profile-conflict", `HERMES_HOME selects profile ${JSON.stringify(envProfile)} but --profile says ${JSON.stringify(ctx.profile)}`);
  }
  ctx = envProfile !== null ? { ...ctx, profile: envProfile } : ctx;
  if (!await reader.isDir(root)) throw new ImportError("E_SOURCE_NOT_FOUND", "source-missing", `no directory at ${root}`);
  if (!(await Promise.all(ROOT_MARKERS.map(m => reader.isFile(join(root, m))))).some(Boolean)) throw new ImportError("E_SOURCE_NOT_FOUND", "not-a-hermes-home", `${root} has none of ${ROOT_MARKERS.join(", ")}`);
  if (ctx.profile !== undefined && (!PROFILE_RE.test(ctx.profile) || !await reader.isDir(join(root, "profiles", ctx.profile)))) {
    throw new ImportError("E_SOURCE_NOT_FOUND", "profile-missing", `no profile ${JSON.stringify(ctx.profile)} under ${join(root, "profiles")}`);
  }
  const rootFacts = await readProfile("default", root, reader);
  if (rootFacts.configVersion === null) {
    throw new ImportError("E_SOURCE_UNSUPPORTED", "config-version-unreadable", `${join(root, "config.yaml")}: _config_version is missing or not an integer`);
  }
  const names = ctx.profile !== undefined ? [ctx.profile] : (await reader.subdirs(join(root, "profiles"))).filter((n) => PROFILE_RE.test(n) && !n.startsWith("."));
  const profiles: ProfileFacts[] = ctx.profile !== undefined ? [] : [rootFacts];
  const errors: Array<{ sourceRef: string; reason: string }> = snapshot?.skippedFiles.map(file => ({ sourceRef: file.path, reason: file.reason })) ?? [];
  for (const n of names) {
    try { profiles.push(await readProfile(n, join(root, "profiles", n), reader)); }
    catch (error) {
      const reason = error instanceof ImportError ? error.reason : "config-unparseable";
      errors.push({ sourceRef: `profiles/${n}/config.yaml`, reason });
      warnings.push(`profiles/${n}/config.yaml: skipped (${reason})`);
    }
  }
  for (const p of profiles) if (p.unsupported.length) warnings.push(`${p.agentId}/config.yaml: unsupported YAML (${p.unsupported.join("; ")}); those keys are unknown`);
  for (const profile of profiles) ctx.onSourceConfig?.(profile.config, profile.agentId);

  const versionWarnings: string[] = [];
  if (rootFacts.configVersion > TESTED_CONFIG_VERSION) versionWarnings.push(`config version ${rootFacts.configVersion} is newer than the tested ${TESTED_CONFIG_VERSION}`);
  const sessions = await sessionsSchema(root, warnings, reader);
  if (sessions !== null && sessions !== TESTED_SESSIONS_SCHEMA) versionWarnings.push(`sessions schema ${sessions} differs from the tested ${TESTED_SESSIONS_SCHEMA} (sessions are not imported yet)`);

  const agents: AgentInfo[] = profiles.map((p) => ({ agentId: p.agentId, workspace: p.dir, workspaceSource: p.agentId === "default" ? "root" : "profile", agentDir: p.dir, foundIn: [p.agentId === "default" ? "root" : "profiles"] }));

  const loc = await reader.location({ accessRoot: root, platform: ctx.platform ?? process.platform, env: ctx.env, home: ctx.homedir, harnessHome: ctx.home });
  const SP = pathFor(loc.flavour);
  const base = SP.basename(loc.sourceRoot);
  const mapper = new SourcePathMapper(loc, { maps: ctx.maps, rootNames: base === ".hermes" || base === "hermes" ? [".hermes", "hermes"] : [], env: loc.origin === "native" && !loc.snapshot ? ctx.env : undefined });
  // Profile names become agent ids on the target: a case-insensitive volume (Windows, default macOS) merges `Work`
  // and `work`; Windows cannot hold `con` or `work.` at all (§B.6).
  const target = ctx.targetPlatform ?? ctx.platform ?? process.platform;
  if (caseInsensitiveTarget(target)) for (const [a, b] of caseCollisions(names)) mapper.problem({ kind: "case-collision", subject: "profiles", names: [a, b] });
  if (target === "win32") { const bad = names.filter((n) => unportableName(n)); if (bad.length) mapper.problem({ kind: "unportable-name", subject: "profiles", names: bad }); }
  const skillRoots: SkillRoot[] = [];
  for (const p of profiles) {
    skillRoots.push({ dir: join(p.dir, "skills"), tier: "profile", agentId: p.agentId, precedence: 3 });
    const ext = p.config.skills?.external_dirs;
    const rel = p.agentId === "default" ? "" : `profiles/${p.agentId}/`;
    const sourceDir = p.agentId === "default" ? loc.sourceRoot : SP.join(loc.sourceRoot, "profiles", p.agentId);
    if (Array.isArray(ext)) ext.forEach((d, i) => {
      if (typeof d !== "string" || !d.trim()) return;
      const m = mapper.map(d, `${rel}config.yaml:skills.external_dirs[${i}]`, sourceDir);
      if (m.path !== null) skillRoots.push({ dir: m.path, tier: "external", agentId: p.agentId, precedence: 2 });
    });
  }
  // A host environment variable describes the host's Hermes, not one read over WSL or from a copy on another OS.
  const optional = ctx.env.HERMES_OPTIONAL_SKILLS?.trim();
  if (optional && loc.origin === "native" && !loc.snapshot) skillRoots.push({ dir: resolve(expandTilde(optional, ctx.homedir, process.platform)), tier: "optional", agentId: null, precedence: 1 });
  skillRoots.sort((a, b) => a.precedence - b.precedence);

  const secrets: SecretsReport = { files: [], envKeys: [], configKeys: [] };
  for (const p of profiles) {
    const rel = p.agentId === "default" ? "" : `profiles/${p.agentId}/`;
    if (await reader.isFile(join(p.dir, ".env"))) { secrets.files.push({ path: `${rel}.env`, kind: "dotenv", present: true }); secrets.envKeys.push({ file: `${rel}.env`, keys: await reader.envKeys(join(p.dir, ".env")) }); }
    if (await reader.isFile(join(p.dir, "auth.json"))) secrets.files.push({ path: `${rel}auth.json`, kind: "auth-store", present: true });
    for (const k of secretConfigKeys(p.config)) secrets.configKeys.push({ ...k, path: `${rel}config.yaml:${k.path}` });
  }

  const memProvider = rootFacts.config.memory?.provider;
  const has = async (name: string) => (await Promise.all(profiles.map(profile => reader.isFile(join(profile.dir, name))))).filter(Boolean).length;
  const other = {
    soul: await has("SOUL.md"),
    memoryFiles: await has("memories/MEMORY.md") + await has("memories/USER.md"),
    cronFiles: await has("cron/jobs.json"),
    sessionsDb: await reader.isFile(join(root, "state.db")),
    note: "presence only; imported by M7",
  };
  if (snapshot) {
    for (const entry of snapshot.configKeys ?? []) if (!secrets.configKeys.some(existing => existing.path === entry.path && existing.form === entry.form)) secrets.configKeys.push(entry);
    for (const path of snapshot.omittedCredentials) secrets.files.push({ path, kind: "found-not-imported", present: true });
    for (const [file, keys] of Object.entries(snapshot.envKeys)) secrets.envKeys.push({ file, keys });
  }
  return {
    sourceType: "hermes",
    ...(errors.length ? { errors } : {}),
    source: { root, resolvedFrom, configPath: join(root, "config.yaml"), profile: ctx.profile ?? null },
    version: { release: null, stateSchema: null, configVersion: rootFacts.configVersion, sessionsSchema: sessions, supported: versionWarnings.length === 0, warnings: versionWarnings },
    agents,
    plur1bus: {
      installed: memProvider === "plur1bus", plugin: typeof memProvider === "string" && memProvider ? { memoryProvider: memProvider } : null,
      storeRoot: null, embeddingCache: null, reembedding: null, stores: [],
      note: "Hermes keeps no PLUR1BUS store (the Hermes MemoryProvider adapter is M8); stores and reranker are not applicable",
    },
    rerankers: [],
    skillRoots, secrets, other, portability: portabilityOf(mapper, warnings), warnings,
  };
}
