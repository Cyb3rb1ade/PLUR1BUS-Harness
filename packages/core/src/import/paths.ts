// Platform-aware path helpers for the importer (plugin-distribution spec §B.1, §B.4). Every function takes the
// platform explicitly and uses `path.win32` or `path.posix` accordingly — never the host's `node:path` — so the
// Windows rules are unit-tested on Linux and a Windows host can read a POSIX-flavoured source (and back).
import { posix, win32 } from "node:path";
import { ImportError } from "./types.ts";

export type Flavour = "posix" | "win32";
export type PathModule = typeof posix;

export const flavourOf = (platform: NodeJS.Platform): Flavour => (platform === "win32" ? "win32" : "posix");
export const pathFor = (f: Flavour | NodeJS.Platform): PathModule => (f === "win32" ? win32 : posix);

/** An environment variable, looked up case-insensitively on Windows (as the OS does). */
export function envGet(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== "win32") return env[name];
  if (env[name] !== undefined) return env[name];
  const k = Object.keys(env).find((x) => x.toUpperCase() === name.toUpperCase());
  return k === undefined ? undefined : env[k];
}

const nonEmpty = (v: string | undefined) => (v !== undefined && v.trim() ? v.trim() : undefined);

/** Python's `os.path.expandvars` per flavour: `$NAME` and `${NAME}` everywhere, `%NAME%` on Windows too; an unknown
 *  name is left as written. */
export function expandVars(p: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  const get = (n: string) => envGet(env, n, platform);
  const re = platform === "win32" ? /%([^%]+)%|\$\{([^}]+)\}|\$([A-Za-z0-9_]+)/g : /\$\{([^}]+)\}|\$([A-Za-z0-9_]+)/g;
  return p.replace(re, (m, a?: string, b?: string, c?: string) => {
    const name = a ?? b ?? c ?? "";
    return get(name) ?? m;
  });
}

/** The home `~` stands for: `HOME` (else `homedir`) on POSIX, `USERPROFILE` (else `homedir`) on Windows — Python's
 *  `expanduser`, which on Windows ignores `HOME`. */
export function userHome(env: NodeJS.ProcessEnv, homedir: string, platform: NodeJS.Platform): string {
  return nonEmpty(envGet(env, platform === "win32" ? "USERPROFILE" : "HOME", platform)) ?? homedir;
}

/** `~` and `~/rest` (`~\rest` too on Windows) against [userHome]; `~user` forms are left as written. */
export function expandUser(p: string, env: NodeJS.ProcessEnv, homedir: string, platform: NodeJS.Platform): string {
  return expandTilde(p, userHome(env, homedir, platform), platform);
}

/** `~` / `~/rest` (and `~\rest` for a win32 flavour) against an already chosen home. */
export function expandTilde(p: string, home: string, f: Flavour | NodeJS.Platform): string {
  const w = f === "win32";
  if (p === "~") return home;
  if (p.startsWith("~/") || (w && p.startsWith("~\\"))) return pathFor(f).join(home, p.slice(2));
  return p;
}

// ---- Source location and the SourcePathMapper (§B.4) ----

/** Where a source lives relative to the host that reads it. */
export type Origin = "native" | "network" | "windows-from-wsl" | `wsl:${string}`;

/** A prefix rule from source-side paths to host paths. `*` in both stands for one drive letter (`/mnt/*` ↔ `*:\`). */
export interface Mount { from: string; to: string }

export interface SourceLocation {
  origin: Origin;
  /** The path syntax the source wrote its configs in. */
  flavour: Flavour;
  /** The path syntax of the host reading it. */
  hostFlavour: Flavour;
  /** The root as the host reads it. */
  accessRoot: string;
  /** The root as the source itself names it. */
  sourceRoot: string;
  /** The home `~` means on the source side, when known. */
  sourceHome: string | null;
  /** Where the host reads `sourceHome`, when it can. */
  accessHome: string | null;
  mounts: Mount[];
}

const WSL_UNC = /^(?:\\\\|\/\/)(wsl\$|wsl\.localhost)[\\/]+([^\\/]+)((?:[\\/].*)?)$/i;

/** The origin, flavour and source-side names of a root the host reads at `accessRoot`: a `\\wsl$\<distro>\…` or
 *  `\\wsl.localhost\<distro>\…` root is a POSIX source inside that distro; `/mnt/<drive>/…` read inside WSL
 *  (`WSL_DISTRO_NAME`/`WSL_INTEROP` set) is a Windows source; a UNC share read on Windows is `network`; anything else
 *  is `native` with `home` as its home. */
export function locateSource(o: { accessRoot: string; platform: NodeJS.Platform; env: NodeJS.ProcessEnv; home: string | null }): SourceLocation {
  const hostFlavour = flavourOf(o.platform);
  const H = pathFor(hostFlavour);
  const base = { hostFlavour, accessRoot: o.accessRoot };
  const wsl = WSL_UNC.exec(o.accessRoot);
  if (wsl && hostFlavour === "win32") {
    const prefix = `\\\\${wsl[1]}\\${wsl[2]}`;
    const parts = normParts(wsl[3]!.split(/[\\/]+/).filter(Boolean));
    const sourceRoot = `/${parts.join("/")}`;
    const homeParts = parts[0] === "home" && parts.length >= 2 ? parts.slice(0, 2) : parts[0] === "root" ? ["root"] : null;
    return {
      origin: `wsl:${wsl[2]}`, flavour: "posix", ...base, sourceRoot,
      sourceHome: homeParts ? `/${homeParts.join("/")}` : null, accessHome: homeParts ? H.join(prefix, ...homeParts) : null,
      mounts: [{ from: "/mnt/*", to: "*:\\" }, { from: "/", to: prefix }],
    };
  }
  const drive = /^\/mnt\/([a-zA-Z])((?:\/.*)?)$/.exec(o.accessRoot);
  if (drive && hostFlavour === "posix" && (o.env.WSL_DISTRO_NAME || o.env.WSL_INTEROP)) {
    const letter = drive[1]!.toUpperCase();
    const parts = normParts(drive[2]!.split("/").filter(Boolean));
    const homeParts = parts[0]?.toLowerCase() === "users" && parts.length >= 2 ? parts.slice(0, 2) : null;
    return {
      origin: "windows-from-wsl", flavour: "win32", ...base, sourceRoot: `${letter}:\\${parts.join("\\")}`,
      sourceHome: homeParts ? `${letter}:\\${homeParts.join("\\")}` : null, accessHome: homeParts ? H.join(`/mnt/${drive[1]}`, ...homeParts) : null,
      mounts: [{ from: "*:\\", to: "/mnt/*" }],
    };
  }
  const network = hostFlavour === "win32" && /^\\\\[^\\?.]/.test(o.accessRoot);
  return { origin: network ? "network" : "native", flavour: hostFlavour, ...base, sourceRoot: o.accessRoot, sourceHome: o.home, accessHome: o.home, mounts: [] };
}

function normParts(parts: readonly string[]): string[] {
  const out: string[] = [];
  for (const p of parts) { if (p === "" || p === ".") continue; if (p === "..") out.pop(); else out.push(p); }
  return out;
}

type Syntax = "win32" | "posix";
interface AbsPath { syntax: Syntax; root: string; parts: string[] }
type Classified = { kind: "abs"; path: AbsPath } | { kind: "relative"; parts: string[] } | { kind: "drive-relative" };

/** Classifies one path string. A drive letter or `\\server\share` is Windows syntax on any source; a leading `/` is
 *  POSIX syntax (on a Windows source that makes it foreign, never `C:\…`); `\x` and `C:x` are drive-relative. */
function classify(p: string, flavour: Flavour): Classified {
  const drive = /^([A-Za-z]:)(.*)$/.exec(p);
  if (drive) {
    if (!/^[\\/]/.test(drive[2]!)) return { kind: "drive-relative" };
    return { kind: "abs", path: { syntax: "win32", root: drive[1]!, parts: normParts(drive[2]!.split(/[\\/]+/)) } };
  }
  const unc = /^(?:\\\\|\/\/)([^\\/]+)[\\/]+([^\\/]+)(.*)$/.exec(p);
  if (unc && (p.startsWith("\\\\") || flavour === "win32")) return { kind: "abs", path: { syntax: "win32", root: `\\\\${unc[1]}\\${unc[2]}`, parts: normParts(unc[3]!.split(/[\\/]+/)) } };
  if (p.startsWith("/")) return { kind: "abs", path: { syntax: "posix", root: "/", parts: normParts(p.split("/")) } };
  if (flavour === "win32" && p.startsWith("\\")) return { kind: "drive-relative" };
  return { kind: "relative", parts: normParts(p.split(flavour === "win32" ? /[\\/]+/ : "/")) };
}

const fold = (s: string, syntax: Syntax) => (syntax === "win32" ? s.toLowerCase() : s);
const format = (a: AbsPath) => (a.syntax === "posix" ? `/${a.parts.join("/")}` : `${a.root}\\${a.parts.join("\\")}`);

/** The parts of `a` below `base` (whole segments; case-insensitive for Windows syntax), else null. */
function below(a: AbsPath, base: AbsPath): string[] | null {
  if (a.syntax !== base.syntax || fold(a.root, a.syntax) !== fold(base.root, a.syntax) || a.parts.length < base.parts.length) return null;
  for (let i = 0; i < base.parts.length; i++) if (fold(a.parts[i]!, a.syntax) !== fold(base.parts[i]!, a.syntax)) return null;
  return a.parts.slice(base.parts.length);
}

/** Directory shapes a source root sits in when it is a user's default install: only a root found there is rebased by
 *  name (a `.openclaw` under `/opt` is somebody else's). */
function plausibleHome(prefix: readonly string[], syntax: Syntax): boolean {
  const p = prefix.map((x) => fold(x, syntax));
  if (syntax === "win32") return p[0] === "users" && (p.length === 2 || (p.length === 4 && p[2] === "appdata" && (p[3] === "local" || p[3] === "roaming")));
  return (p.length === 2 && (p[0] === "home" || p[0] === "users")) || (p.length === 1 && p[0] === "root") || (p.length === 3 && p[0] === "var" && p[1] === "home");
}

export type MapHow = "native" | "root" | "home" | "rebased" | "mount" | "map";
export type UnmappedReason = "env-var" | "foreign-path" | "drive-relative" | "home-unknown" | "outside-source-root";
export type MapResult = { path: string; how: MapHow } | { path: null; reason: UnmappedReason };

export interface PortabilityReport {
  origin: Origin;
  flavour: Flavour;
  sourceRoot: string;
  sourceHome: string | null;
  movedFrom: string[];
  mapped: { key: string; value: string; path: string; how: MapHow }[];
  unmapped: { key: string; value: string; reason: UnmappedReason }[];
}

/** `--map <source-prefix>=<local-prefix>` entries (split at the first `=`). */
export function parseMaps(values: readonly string[]): Mount[] {
  return values.map((v) => {
    const i = v.indexOf("=");
    if (i <= 0 || i === v.length - 1) throw new ImportError("E_INVALID_PARAMS", "map", `--map expects <source-prefix>=<local-prefix>, got ${JSON.stringify(v)}`);
    return { from: v.slice(0, i), to: v.slice(i + 1) };
  });
}

/**
 * Maps paths read from a source's config onto host paths (§B.4): parsed with the source's flavour, `~` against the
 * source-side home, `${VAR}` only from `vars`; then, in order, an explicit `--map` prefix, the source root, the root's
 * original location when it was copied or moved (a path through a same-named root in a home directory), the source
 * home, the location's mounts, and a same-syntax path as written on a native source. Anything else is unmapped with a
 * reason — never guessed. Every non-identity mapping and every unmapped path is recorded for the report.
 */
export class SourcePathMapper {
  readonly loc: SourceLocation;
  readonly movedFrom: string[] = [];
  private readonly H: PathModule;
  private readonly root: AbsPath | null;
  private readonly home: AbsPath | null;
  private readonly names: string[];
  private readonly maps: { from: AbsPath; to: string }[];
  private readonly vars: Record<string, string>;
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly mapped: PortabilityReport["mapped"] = [];
  private readonly unmapped: PortabilityReport["unmapped"] = [];

  /** `vars`: `${NAME}` values the source binds itself; `env`: the source-side environment, for sources that expand
   *  `$VAR`/`${VAR}` (and `%VAR%` on Windows) in paths — only ever the environment captured on the source side. */
  constructor(loc: SourceLocation, o: { maps?: readonly Mount[] | undefined; vars?: Record<string, string>; rootNames?: readonly string[]; env?: NodeJS.ProcessEnv | undefined } = {}) {
    this.loc = loc;
    this.H = pathFor(loc.hostFlavour);
    const abs = (p: string | null) => { if (p === null) return null; const c = classify(p, loc.flavour); return c.kind === "abs" ? c.path : null; };
    this.root = abs(loc.sourceRoot);
    this.home = abs(loc.sourceHome);
    this.names = [...new Set([...(this.root?.parts.length ? [this.root.parts.at(-1)!] : []), ...(o.rootNames ?? [])])];
    this.maps = (o.maps ?? []).flatMap((m) => { const c = classify(m.from, loc.flavour); return c.kind === "abs" ? [{ from: c.path, to: m.to }] : []; })
      .sort((a, b) => b.from.parts.length - a.from.parts.length);
    this.vars = o.vars ?? {};
    this.env = o.env;
  }

  /** One config value; `key` names it in the report. A relative value resolves against `relBase` (a source-side
   *  directory, e.g. a Hermes profile), else against the root. */
  map(raw: string, key: string, relBase?: string): MapResult {
    const r = this.resolve(raw.trim(), relBase);
    if (r.path === null) this.unmapped.push({ key, value: raw, reason: r.reason });
    else if (r.how !== "native") this.mapped.push({ key, value: raw, path: r.path, how: r.how });
    return r;
  }

  report(): PortabilityReport {
    const l = this.loc;
    return { origin: l.origin, flavour: l.flavour, sourceRoot: l.sourceRoot, sourceHome: l.sourceHome, movedFrom: [...this.movedFrom], mapped: [...this.mapped], unmapped: [...this.unmapped] };
  }

  private access(base: string, rel: readonly string[], how: MapHow, source: string): MapResult {
    const path = rel.length ? this.H.join(base, ...rel) : this.H.normalize(base);
    return { path, how: this.loc.origin === "native" && path === this.H.normalize(source) ? "native" : how };
  }

  private resolve(input: string, relBase?: string): MapResult {
    const l = this.loc;
    let s = input.replace(/\$\{([^}]*)\}/g, (m, n: string) => this.vars[n] ?? m);
    if (this.env) {
      const platform = l.flavour === "win32" ? "win32" : "linux";
      s = expandVars(s, this.env, platform);
      if (/\$\{[^}]*\}|\$[A-Za-z_]/.test(s) || (platform === "win32" && /%[^%]+%/.test(s))) return { path: null, reason: "env-var" };
    }
    if (/\$\{[^}]*\}/.test(s)) return { path: null, reason: "env-var" };
    if (s === "~" || s.startsWith("~/") || (l.flavour === "win32" && s.startsWith("~\\"))) {
      if (l.sourceHome === null) return { path: null, reason: "home-unknown" };
      s = expandTilde(s, l.sourceHome, l.flavour);
    }
    const c = classify(s, l.flavour);
    if (c.kind === "drive-relative") return { path: null, reason: "drive-relative" };
    if (c.kind === "relative" && relBase === undefined) return this.access(l.accessRoot, c.parts, "root", pathFor(l.flavour).join(l.sourceRoot, ...c.parts));
    const cc = c.kind === "relative" ? classify(pathFor(l.flavour).join(relBase!, ...c.parts), l.flavour) : c;
    if (cc.kind !== "abs") return { path: null, reason: "drive-relative" };
    const a = cc.path; const src = format(a);
    for (const m of this.maps) { const rel = below(a, m.from); if (rel) return { path: rel.length ? this.H.join(m.to, ...rel) : this.H.normalize(m.to), how: "map" }; }
    if (this.root) { const rel = below(a, this.root); if (rel) return this.access(l.accessRoot, rel, "root", src); }
    const moved = this.rebase(a);
    if (moved) return moved;
    if (this.home) {
      const rel = below(a, this.home);
      if (rel) return l.accessHome === null ? { path: null, reason: "outside-source-root" } : this.access(l.accessHome, rel, "home", src);
    }
    for (const m of l.mounts) { const r = this.viaMount(a, m); if (r) return r; }
    if (a.syntax === l.hostFlavour && a.syntax === l.flavour && (l.origin === "native" || l.origin === "network")) return { path: this.H.normalize(src), how: "native" };
    return { path: null, reason: a.syntax !== l.flavour || a.syntax !== l.hostFlavour ? "foreign-path" : "outside-source-root" };
  }

  private rebase(a: AbsPath): MapResult | null {
    const names = this.names.map((n) => fold(n, a.syntax));
    for (let k = a.parts.length - 1; k >= 1; k--) {
      if (!names.includes(fold(a.parts[k]!, a.syntax)) || !plausibleHome(a.parts.slice(0, k), a.syntax)) continue;
      const from = format({ ...a, parts: a.parts.slice(0, k + 1) });
      if (this.root && below(a, this.root)) return null;
      if (!this.movedFrom.includes(from)) this.movedFrom.push(from);
      const rel = a.parts.slice(k + 1);
      return { path: rel.length ? this.H.join(this.loc.accessRoot, ...rel) : this.H.normalize(this.loc.accessRoot), how: "rebased" };
    }
    return null;
  }

  private viaMount(a: AbsPath, m: Mount): MapResult | null {
    if (m.from === "/mnt/*" && a.syntax === "posix" && a.parts[0] === "mnt" && /^[a-zA-Z]$/.test(a.parts[1] ?? "")) {
      return { path: this.H.join(m.to.replace("*", a.parts[1]!.toUpperCase()), ...a.parts.slice(2)), how: "mount" };
    }
    if (m.from === "*:\\" && a.syntax === "win32" && /^[A-Za-z]:$/.test(a.root)) {
      return { path: this.H.join(m.to.replace("*", a.root[0]!.toLowerCase()), ...a.parts), how: "mount" };
    }
    if (!m.from.includes("*")) {
      const c = classify(m.from, this.loc.flavour);
      if (c.kind === "abs") { const rel = below(a, c.path); if (rel) return { path: rel.length ? this.H.join(m.to, ...rel) : this.H.normalize(m.to), how: "mount" }; }
    }
    return null;
  }
}

/** The mapper's report for `SourceReport.portability`; a moved or copied root adds a warning. */
export function portabilityOf(m: SourcePathMapper, warnings: string[]): PortabilityReport {
  const r = m.report();
  if (r.movedFrom.length) warnings.push(`the source root was moved or copied from ${r.movedFrom.join(", ")}; config paths under it were rebased onto ${m.loc.accessRoot}`);
  if (r.unmapped.length) warnings.push(`${r.unmapped.length} config path(s) could not be mapped to a local path (portability.unmapped); pass --map <source-prefix>=<local-prefix>`);
  return r;
}
