// Platform-aware path helpers for the importer (plugin-distribution spec §B.1, §B.4). Every function takes the
// platform explicitly and uses `path.win32` or `path.posix` accordingly — never the host's `node:path` — so the
// Windows rules are unit-tested on Linux and a Windows host can read a POSIX-flavoured source (and back).
import { posix, win32 } from "node:path";

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
