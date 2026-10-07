import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** The engine contract's `SecurePathResult` (types/engine.d.ts), restated here so module-api does not depend on it. */
/** Result of applying the platform's owner-only permissions to a path. */
export interface SecurePathResult {
  applied: boolean;
  reason?: "not-a-filesystem-path" | "missing" | "unsupported-platform" | "acl-tool-unavailable";
  mechanism?: "chmod" | "acl";
}
/** Function returned by {@link createSecurePath} to secure a filesystem path. */
export type SecurePath = (p: string, options?: { mode?: number }) => SecurePathResult;

/** Runs a tool synchronously and returns its stdout; throws when it cannot run or exits non-zero. */
/** Synchronous executable adapter used by the Windows ACL implementation. */
export type ExecFile = (file: string, args: readonly string[]) => string;

/** Platform, filesystem, and process adapters used to create a secure-path function. */
export interface SecurePathOptions {
  /** Defaults to `process.platform`; a test reaches the win32 branch on any OS. */
  platform?: NodeJS.Platform;
  /** Defaults to `execFileSync` (no window, output captured). */
  execFile?: ExecFile;
  /** Where a failed ACL grant is reported (and, at `debug`, a path the supervisor's `run/` ACL already covers). */
  logger?: { warn(msg: string, fields?: Record<string, unknown>): void; debug?(msg: string, fields?: Record<string, unknown>): void };
  /** The Windows directory the tools are run from; defaults to `%SystemRoot%`, then `C:\Windows`. */
  systemRoot?: string;
  /** Where `PLUR1BUS_RUN_ACL` is read; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** The home's `run/` (`path.join(home, "run")`). Without it `PLUR1BUS_RUN_ACL` changes nothing. */
  runDir?: string;
}

/** Set by the supervisor for every child it spawns once `run/`'s protected, inheritable ACL is in place (HB5). */
export const RUN_ACL_ENV = "PLUR1BUS_RUN_ACL";

/** Whether `p` is `runDir` or directly inside it, compared case-insensitively after `path.resolve` (HB5 c). */
function inRunDir(p: string, runDir: string): boolean {
  const dir = path.resolve(runDir).toLowerCase();
  const target = path.resolve(p).toLowerCase();
  return target === dir || path.dirname(target) === dir;
}

/** `<SystemRoot>\System32\<exe>`: the tools run by absolute path, never whatever a `PATH` lookup finds first. */
export function systemTool(exe: string, systemRoot: string | undefined = process.env.SystemRoot): string {
  return path.win32.join(systemRoot || "C:\\Windows", "System32", exe);
}

const defaultExec: ExecFile = (file, args) =>
  execFileSync(file, args, { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });

/** The SID column of `whoami /user /fo csv /nh` (`"host\user","S-1-5-21-…"`), or null. */
export function parseWhoamiSid(out: string): string | null {
  const m = /"(S-1-\d+(?:-\d+)+)"\s*$/m.exec(out);
  return m ? m[1]! : null;
}

/** SDDL aliases of well-known SIDs that do not depend on a domain (MS-DTYP 2.4.2.4). */
const WELL_KNOWN_ALIASES: Readonly<Record<string, string>> = {
  WD: "S-1-1-0", CO: "S-1-3-0", CG: "S-1-3-1", OW: "S-1-3-4", NU: "S-1-5-2", IU: "S-1-5-4", SU: "S-1-5-6", AN: "S-1-5-7",
  ED: "S-1-5-9", PS: "S-1-5-10", AU: "S-1-5-11", RC: "S-1-5-12", SY: "S-1-5-18", LS: "S-1-5-19", NS: "S-1-5-20",
  WR: "S-1-5-33", BA: "S-1-5-32-544", BU: "S-1-5-32-545", BG: "S-1-5-32-546", PU: "S-1-5-32-547", AO: "S-1-5-32-548",
  SO: "S-1-5-32-549", PO: "S-1-5-32-550", BO: "S-1-5-32-551", RE: "S-1-5-32-552", RU: "S-1-5-32-554",
  RD: "S-1-5-32-555", NO: "S-1-5-32-556", MU: "S-1-5-32-558", LU: "S-1-5-32-559", IS: "S-1-5-32-568",
  CY: "S-1-5-32-569", ER: "S-1-5-32-573", HA: "S-1-5-32-578", AA: "S-1-5-32-579", RM: "S-1-5-32-580",
  AC: "S-1-15-2-1", LW: "S-1-16-4096", ME: "S-1-16-8192", HI: "S-1-16-12288", SI: "S-1-16-16384",
};

/**
 * SDDL aliases relative to an account domain (MS-DTYP 2.4.2.4): `LA` is `<domain>-500`, and so on. The domain is taken
 * from the user's own SID, which is right for a local account (the CI runner's built-in Administrator prints as `LA`).
 * For a domain account the local `LA` resolves to a SID that is not the user's: it then counts as another account, and
 * a removal that cannot take is caught by the final check (fail safe).
 */
const DOMAIN_ALIASES: Readonly<Record<string, number>> = {
  LA: 500, LG: 501, DA: 512, DU: 513, DG: 514, DC: 515, DD: 516, CA: 517, SA: 518, EA: 519, PA: 520, CN: 522, RS: 553,
};

/** One ACE of an SDDL DACL: its type (`A`, `D`, …), flags, rights and trustee as written (alias or SID). */
export interface SddlAce { type: string; flags: string; rights: string; trustee: string }

/** The SDDL line of an `icacls /save` file (UTF-16LE, optional BOM): the first line that starts with `D:`. */
export function savedSddlLine(bytes: Buffer): string | null {
  const lines = bytes.toString("utf16le").replace(/^\uFEFF/, "").split(/\r?\n/).map((l) => l.trim());
  return lines.find((l) => l.startsWith("D:")) ?? null;
}

/** The ACEs of the `D:` part of an SDDL string (as `icacls /save` writes it). */
export function parseSddlDacl(sddl: string): SddlAce[] {
  const at = sddl.indexOf("D:");
  if (at < 0) return [];
  const dacl = sddl.slice(at + 2).split(/\b[OGS]:/)[0]!;
  return [...dacl.matchAll(/\(([^)]*)\)/g)].map(([, body]) => {
    const f = body!.split(";");
    return { type: f[0] ?? "", flags: f[1] ?? "", rights: f[2] ?? "", trustee: f[5] ?? "" };
  });
}

/** The SID an SDDL trustee names: a literal SID as is, an alias through the tables above; null for an unknown alias. */
export function resolveSddlTrustee(trustee: string, userSid: string): string | null {
  if (/^S-1-\d+(-\d+)*$/.test(trustee)) return trustee;
  const known = WELL_KNOWN_ALIASES[trustee];
  if (known) return known;
  const rid = DOMAIN_ALIASES[trustee];
  const domain = /^(S-1-5-21-\d+-\d+-\d+)-\d+$/.exec(userSid)?.[1];
  return rid !== undefined && domain ? `${domain}-${rid}` : null;
}

/** The SIDs of `sddl`'s DACL entries other than the user and SYSTEM (unknown aliases as written). Sorted, each once. */
export function othersInDacl(sddl: string, userSid: string): string[] {
  const others = new Set<string>();
  for (const ace of parseSddlDacl(sddl)) {
    const sid = resolveSddlTrustee(ace.trustee, userSid) ?? ace.trustee;
    if (sid !== userSid && sid !== "S-1-5-18") others.add(sid);
  }
  return [...others].sort();
}

/** The user's SID through the default tool, asked once per process; `null` once that failed. */
let processSid: string | null | undefined;

/**
 * Restricts a path to the current user (the engine's `PlatformCapabilities.securePath`, and every run file a harness
 * process writes: tokens, pid files, H3B-R12):
 * `chmod` on POSIX. On Windows (ruling S11) the DACL ends up exactly "user + SYSTEM, full control, protected":
 *   1. `icacls <p> /inheritance:r /grant:r *<user SID>:(F) *S-1-5-18:(F)` (`(OI)(CI)(F)` on a directory, H3-R15);
 *   2. `icacls <p> /save` reads the DACL back as SDDL; `/grant:r` only replaces the named SIDs' entries, so explicit
 *      entries of other accounts (the CI runner showed `BA`) survive step 1;
 *   3. every other SID is dropped with `icacls <p> /remove *<SID>…`, and a second `/save` must show only the two.
 * The SID comes from `whoami /user`, memoised (a failed lookup too). Both tools run from `%SystemRoot%\System32` by
 * absolute path. Why icacls and not PowerShell `Set-Acl` from SDDL in one step: PowerShell adds about a second per
 * call to the core's start (three calls), and Constrained Language Mode or AppLocker can block it where icacls runs.
 * Anything that does not end in exactly user + SYSTEM is `{ applied: false, reason: "acl-tool-unavailable" }` plus a
 * warning (`reason: "icacls-failed"`): the engine contract's closed unions name the mechanism `"acl"` and have no
 * separate failure reason.
 * Under the supervisor (HB5, DS36): the supervisor sets `run/`'s DACL once at start (protected, user + SYSTEM, inherited
 * by every file and directory created in it) and then passes `PLUR1BUS_RUN_ACL=inherited` to its children. With that
 * variable and a `runDir`, `run/` and the files directly inside it need no tool: `{ applied: true, mechanism: "acl" }`
 * plus one `debug` line. The supervisor checks each child's token and pid files natively after it is ready. Any other
 * path, and every path of a process started by hand (no variable), takes the icacls path above unchanged.
 */
export function createSecurePath(o: SecurePathOptions = {}): SecurePath {
  const platform = o.platform ?? process.platform;
  const exec = o.execFile ?? defaultExec;
  const tool = (exe: string) => systemTool(exe, o.systemRoot);
  // A failed lookup is remembered as null (per process for the default tool): it is not retried on every call.
  let sid: string | null | undefined;
  const userSid = (): string | null => {
    if (exec === defaultExec && processSid !== undefined) return processSid;
    if (sid !== undefined) return sid;
    let found: string | null;
    try { found = parseWhoamiSid(exec(tool("whoami.exe"), ["/user", "/fo", "csv", "/nh"])); } catch { found = null; }
    sid = found;
    if (exec === defaultExec) processSid = found;
    return found;
  };

  function securePath(p: string, options: { mode?: number } = {}): SecurePathResult {
    if (typeof p !== "string" || !path.isAbsolute(p)) return { applied: false, reason: "not-a-filesystem-path" };
    let isDir: boolean;
    try { isDir = statSync(p).isDirectory(); } catch { return { applied: false, reason: "missing" }; }
    if (platform === "win32") {
      if (o.runDir !== undefined && (o.env ?? process.env)[RUN_ACL_ENV] === "inherited" && inRunDir(p, o.runDir)) {
        o.logger?.debug?.("securePath: covered by the supervisor's run/ ACL", { path: p });
        return { applied: true, mechanism: "acl" };
      }
      const failed = (err: unknown): SecurePathResult => {
        o.logger?.warn("securePath: icacls grant failed", { path: p, reason: "icacls-failed", err: String((err as Error)?.message ?? err) });
        return { applied: false, reason: "acl-tool-unavailable" };
      };
      const user = userSid();
      if (user === null) return failed(new Error("whoami /user named no SID"));
      // H3-R15: on a directory the grant is inherited ((OI)(CI)), so files created in it later are owner-only too.
      const inherit = isDir ? "(OI)(CI)" : "";
      const icacls = tool("icacls.exe");
      const scratch = mkdtempSync(path.join(tmpdir(), "p1b-acl-"));
      /** The DACL of `p` as SDDL (`icacls /save` writes UTF-16LE: a line with the name, then the SDDL line). */
      const saved = (): string => {
        const file = path.join(scratch, "acl.txt");
        exec(icacls, [p, "/save", file]);
        const sddl = savedSddlLine(readFileSync(file));
        if (sddl === null) throw new Error("icacls /save wrote no DACL");
        return sddl;
      };
      try {
        exec(icacls, [p, "/inheritance:r", "/grant:r", `*${user}:${inherit}(F)`, `*S-1-5-18:${inherit}(F)`]);
        let others = othersInDacl(saved(), user);
        if (others.some((sid) => !sid.startsWith("S-1-"))) throw new Error(`unknown SDDL alias in the DACL: ${others.join(" ")}`);
        if (others.length > 0) {
          exec(icacls, [p, "/remove", ...others.map((sid) => `*${sid}`)]);
          others = othersInDacl(saved(), user);
          if (others.length > 0) throw new Error(`still granted after /remove: ${others.join(" ")}`);
        }
        return { applied: true, mechanism: "acl" };
      } catch (err) {
        return failed(err);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    }
    chmodSync(p, options.mode ?? 0o600);
    return { applied: true, mechanism: "chmod" };
  }

  return securePath;
}
