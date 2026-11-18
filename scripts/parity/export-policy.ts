// Parity vectors (mode V) for the D109 policy evaluator (P4-K K2, plan P4-21): the capability table and defaults, the effect
// vocabulary, the scope, risk and surface helpers, `decide` with `headlessGate` over a generated grid and the attack/benign
// table of `permission-eval`, and the pure half of the path layer (`checkSyntax` per platform, the deny-list matcher and its
// folding, the root and system-tree rules). `crates/plur1bus-core/src/policy/vectors.rs` replays every case. Recorded,
// never edited by hand.
//
// Platforms: every path function here takes the platform (or `windows`) as an argument, so the exporter records darwin,
// linux and win32 on any machine and the Rust replay runs all of them on every operating system. `canonicalisePath` and
// `openVerified` read the real file system and are not in these vectors.
//
// Encoding: a number JSON cannot hold is the string "NaN", "Infinity" or "-Infinity" where a number is expected (`now`,
// `maxGrantDays`). A grant is recorded as the object the grant source hands back.
//
//   node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning scripts/parity/export-policy.ts [--check]
import { fileURLToPath } from "node:url";
import { CAPABILITIES, DEFAULTS, GRANT_SCOPES, NEVER_CAPABILITIES, RISKS, type GrantScope, type SurfaceTrust } from "../../packages/core/src/policy/capabilities.ts";
import { EFFECTS, effectRank, fromExtensionEffect, fromMcp, fromSideEffects, isEffect, maxEffect, type Effect } from "../../packages/core/src/policy/effects.ts";
import { decide, grantExpiry, grantReviewDue, maxScopeFor, pathCovered, requiredSurface, riskOf, surfaceMayDecide, type CallFlags, type Grant } from "../../packages/core/src/policy/decide.ts";
import { headlessGate } from "../../packages/core/src/policy/headless.ts";
import { checkSyntax, containsExact, foldForDeny, grantReachesSystemTree, invalidDenyEntry, isForbiddenRoot, isReservedDeviceName, isSystemTreePath, matchDeny, type DenyEntry } from "../../packages/core/src/policy/paths.ts";
import { ROWS } from "../../packages/core/test/policy/permission-eval.fixtures.ts";
import { call as baseCall, ctx as baseCtx } from "../../packages/core/test/policy/helpers.ts";
import { exporterMain } from "./lib.mjs";

const tag = (n: number): number | string => (Number.isNaN(n) ? "NaN" : n === Infinity ? "Infinity" : n === -Infinity ? "-Infinity" : n);
const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
/** A JSON copy: what the evaluator sees is what the file holds (an `undefined` member is absent on both sides). */
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

// A small deterministic generator (mulberry32), so the grid is the same on every run.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// --- tables -----------------------------------------------------------------------------------------------------------------
function tables() {
  return { capabilities: [...CAPABILITIES.values()], defaults: DEFAULTS, never: NEVER_CAPABILITIES, scopes: GRANT_SCOPES, risks: RISKS, effects: EFFECTS };
}

// --- effects ----------------------------------------------------------------------------------------------------------------
function effectCases() {
  const values: unknown[] = [...EFFECTS, "bogus", "", "READ", null, 3];
  const pairs = EFFECTS.flatMap((a) => EFFECTS.map((b) => ({ a, b, max: maxEffect(a, b) })));
  const ranks = EFFECTS.map((e) => ({ effect: e, rank: effectRank(e) }));
  const is = values.map((v) => ({ value: v, isEffect: isEffect(v) }));
  const side = (["none", "local", "external", "money", "bogus", "LOCAL"] as const).flatMap((s) => [false, true].map((irr) => ({ side: s, irreversible: irr, effect: fromSideEffects(s as never, irr) })));
  const ext = (["read", "write", "destructive", "bogus", "WRITE"] as const).flatMap((e) => (["none", "declared", undefined, "bogus"] as const).map((n) => ({ effect: e, network: n ?? null, result: fromExtensionEffect(e as never, n as never) })));
  const anns = [{}, { readOnlyHint: true }, { destructiveHint: true }, { openWorldHint: true }, { destructiveHint: true, openWorldHint: true }, { destructiveHint: "true" }, { openWorldHint: 1 }];
  const mcp = [...values, undefined].flatMap((d) => anns.map((ann) => ({ declared: d === undefined ? null : d, declaredAbsent: d === undefined, annotations: ann, effect: fromMcp(d as Effect | undefined, ann as never) })));
  return { pairs, ranks, is, side, ext, mcp };
}

// --- scope, risk and surface helpers ----------------------------------------------------------------------------------------
const FLAG_SETS: CallFlags[] = [
  { outsideRoots: false, denyListHit: false }, { outsideRoots: true, denyListHit: false }, { outsideRoots: false, denyListHit: false, irreversible: true },
  { outsideRoots: false, denyListHit: false, privileged: true }, { outsideRoots: true, denyListHit: false, privileged: true, irreversible: true },
  { outsideRoots: false, denyListHit: false, batch: true }, { outsideRoots: false, denyListHit: false, systemTree: true }, { outsideRoots: false, denyListHit: false, publishPublic: true },
  { outsideRoots: true, denyListHit: false, systemTree: true, batch: true },
];
function helperCases() {
  const rows: unknown[] = [];
  for (const def of CAPABILITIES.values()) for (const flags of FLAG_SETS) {
    rows.push({
      capability: def.id, flags, maxScope: maxScopeFor(def, flags), risk: riskOf(def, flags),
      surfaces: GRANT_SCOPES.map((s) => requiredSurface(def, s, flags)),
      mayDecide: GRANT_SCOPES.map((scope) => ([0, 1, 2, 3] as SurfaceTrust[]).map((surface) => surfaceMayDecide({ capability: def.id, risk: riskOf(def, flags), flags }, surface, scope))),
    });
  }
  // A request whose risk is given apart from the flags (surface 1 reads the risk field itself), and an unknown capability.
  const odd = (["fs.read", "fs.write", "clipboard.read", "shell.exec", "nope"] as const).flatMap((capability) => RISKS.map((risk) => ({
    capability, risk, mayDecide: GRANT_SCOPES.map((scope) => ([0, 1, 2, 3] as SurfaceTrust[]).map((surface) => surfaceMayDecide({ capability, risk, flags: FLAG_SETS[0]! }, surface, scope))),
  })));
  const expiry: unknown[] = [];
  const base = { id: "g", capability: "shell.exec", person: "p", agent: "a", match: { kind: "capability" }, surface: 3 } as const;
  const variants: Partial<Grant>[] = [
    {}, { lastUsedAt: NOW - DAY }, { expiresAt: NOW + MIN }, { expiresAt: NOW + 400 * DAY }, { lastUsedAt: NOW - 100 * DAY, expiresAt: NOW },
    { capability: "memory.jobs.run", lastJobTurnAt: NOW - 10 * DAY, lastUsedAt: NOW - 50 * DAY }, { capability: "memory.jobs.run", lastUsedAt: NOW - 50 * DAY },
  ];
  for (const scope of GRANT_SCOPES) for (const v of variants) for (const days of [undefined, 30, 0, 1.5, Number.NaN]) {
    const g = { ...base, scope, createdAt: NOW - 2 * HOUR, ...v } as Grant;
    expiry.push({ grant: g, maxGrantDays: days === undefined ? null : tag(days), expiry: tag(days === undefined ? grantExpiry(g) : grantExpiry(g, days)) });
  }
  const review = GRANT_SCOPES.flatMap((scope) => [0, 89 * DAY, 90 * DAY - 1, 90 * DAY, 400 * DAY].map((age) => {
    const g = { ...base, scope, createdAt: NOW - age } as Grant;
    return { grant: g, now: NOW, due: grantReviewDue(g, NOW) };
  }));
  const PATHS = ["/data", "/data/", "/data/a", "/data/a/b", "/data2/a", "/Data/a", "/data//a", "/data/./a", "/data/../a", "data/a", "", "/", "/data\\a", "C:\\data", "C:\\data\\a",
    "c:/data/a", "C:/data\\a\\b", "\\\\srv\\share", "\\\\srv\\share\\a", "C:", "C:x", "/data\0/a", "/data/a\\..\\b", "C:\\data\\.\\a"];
  const covered = PATHS.flatMap((g) => [false, true].map((recursive) => ({ grant: g, recursive, targets: PATHS.map((t) => pathCovered(g, recursive, t)) })));
  return { rows, odd, expiry, review, paths: PATHS, covered };
}

// --- decide -----------------------------------------------------------------------------------------------------------------
type Case = { name: string; call: unknown; ctx: unknown; grants: unknown[]; now: number | string; maxGrantDays?: number | string };

let gid = 0;
function grant(capability: string, scope: GrantScope, o: Record<string, unknown> = {}): Record<string, unknown> {
  const g: Record<string, unknown> = { id: `g${++gid}`, capability, person: "christian", agent: "bernd", scope, match: { kind: "capability" }, createdAt: NOW - HOUR, surface: 3 };
  if (scope === "task") g.taskId = "t1";
  if (scope === "session") g.sessionId = "s1";
  if (scope === "once") { g.actionHash = "h1"; g.match = { kind: "action" }; g.createdAt = NOW - MIN; }
  return { ...g, ...o };
}

function runCase(c: Case) {
  const grants = c.grants as Grant[];
  const queries: unknown[] = [];
  const now = typeof c.now === "string" ? Number(c.now) : c.now;
  const days = c.maxGrantDays === undefined ? undefined : typeof c.maxGrantDays === "string" ? Number(c.maxGrantDays) : c.maxGrantDays;
  const source = {
    ...(c.maxGrantDays !== undefined ? { maxGrantDays: () => days! } : {}),
    list(q: { person: string; agent: string; capability: string }) { queries.push(q); return grants.filter((g) => g.person === q.person && g.agent === q.agent && g.capability === q.capability); },
    get(id: string) { return grants.find((g) => g.id === id); },
  };
  let decision: unknown;
  try { decision = decide(c.call as never, c.ctx as never, { grants: source, clock: { now: () => now } }); }
  catch (e) { return { ...c, threw: (e as Error).name }; }
  return { ...c, decision, headless: headlessGate(decision as never, c.ctx as never), queries };
}

function rowCases(): Case[] {
  const out: Case[] = [];
  for (const row of ROWS) for (const [side, sc] of [["attack", row.attack], ["benign", row.benign]] as const) {
    out.push({ name: `${row.id}:${side}`, call: plain(baseCall(sc.call)), ctx: plain(baseCtx(sc.ctx)), grants: plain(sc.grants ?? []), now: NOW });
  }
  return out;
}

function gridCases(): Case[] {
  const r = rng(0x5eed2026);
  const pick = <T>(a: readonly T[]): T => a[Math.floor(r() * a.length)]!;
  const caps = [...CAPABILITIES.keys(), "FS.Read", " fs.write ", "unknown.cap", "memory.jobs.run", "shell.exec", "fs.delete", "net.publish"];
  const flagVariants: unknown[] = [
    ...FLAG_SETS, { outsideRoots: false, denyListHit: true }, { outsideRoots: false, denyListHit: false, shellAllowlisted: true },
    { outsideRoots: false, denyListHit: false, shellAllowlisted: true, sandboxed: true }, { outsideRoots: true, denyListHit: false, shellAllowlisted: true },
    { outsideRoots: false, denyListHit: false, secretSlotDeclared: true }, { outsideRoots: false, denyListHit: false, sandboxed: true },
    { outsideRoots: false, denyListHit: false, sandboxed: true, extra: "kept" },
  ];
  const badFlags: unknown[] = [{ denyListHit: false }, { outsideRoots: "no", denyListHit: false }, { outsideRoots: false, denyListHit: false, batch: "yes" }, { outsideRoots: false, denyListHit: false, privileged: null }, null];
  const effects: unknown[] = [undefined, ...EFFECTS, "bogus", null];
  const targetSets: unknown[] = [undefined, [], ["/work/proj/a.txt"], ["/work/proj/a.txt", "/data/x"], Array.from({ length: 21 }, (_, i) => `/work/proj/f${i}`),
    Array.from({ length: 20 }, (_, i) => `/data/f${i}`), ["data/rel"], ["C:\\data\\x"]];
  const accesses: unknown[] = [undefined, "read", "write", "write"];
  const ctxVariants: Record<string, unknown>[] = [
    {}, { subject: { kind: "subagent", agentId: "sub" }, handoff: { scope: ["fs.delete", "fs.read", "shell.exec"], taskId: "t1", approvalsHeld: ["held"] } },
    { subject: { kind: "subagent", agentId: "sub" } }, { subject: { kind: "a2a-peer", agentId: "peer" } }, { subject: { kind: "mcp-client", agentId: "bernd" }, surface: 0 },
    { subject: { kind: "acp-editor", agentId: "bernd" }, surface: 1 }, { subject: { kind: "remote-harness", agentId: "bernd" } }, { subject: { kind: "robot", agentId: "bernd" } },
    { subject: { kind: "agent", agentId: "" } }, { principal: { person: "" } }, { principal: null }, { toolsDeny: ["fs.*"] }, { toolsDeny: ["*"] }, { toolsDeny: ["FS.READ"] },
    { toolsDeny: [""] }, { toolsDeny: ["  "] }, { toolsDeny: "fs.read" }, { toolsDeny: [null] }, { toolsDeny: ["shell*", "x"] }, { toolsDeny: ["fs.re*d"] }, { toolsDeny: null }, { toolsDeny: [] },
    { overrides: { "fs.write": "approval" } }, { overrides: { "FS.DELETE": "allowed" } }, { overrides: { "shell.exec": "allowed", "Shell.Exec": "approval" } }, { overrides: { " shell.exec": "allowed" } },
    { overrides: { "net.submit": "allowed", "fs.read": "never" } }, { overrides: ["allowed"] }, { overrides: "allowed" },
    { taint: { tainted: true, readPrivate: true } }, { taint: { tainted: true, readPrivate: false } }, { taint: { tainted: "yes", readPrivate: true } },
    { tokenScopes: [] }, { tokenScopes: ["fs.read", "SHELL.EXEC"] }, { tokenScopes: "fs.read" }, { headless: { jobId: "j1" } }, { headless: { jobId: "engine:dream" } }, { headless: { jobId: "" } }, { headless: null },
    { deniedActionHashes: ["h1"] }, { deniedActionHashes: "h1" }, { promptsThisHour: 9 }, { promptsThisHour: 10 }, { promptsThisHour: null }, { promptsThisHour: "3" }, { promptsThisHour: -1 },
    { projectId: "p1" }, { taskId: undefined, sessionId: undefined }, { handoff: { scope: ["fs.read"], taskId: "", approvalsHeld: [] } },
  ];
  const grantPool = (): Record<string, unknown>[] => {
    const cap = pick(caps.slice(0, 40));
    const scope = pick([...GRANT_SCOPES, "forever"] as const) as GrantScope;
    const tweaks: Record<string, unknown>[] = [
      {}, { revoked: true }, { revoked: 1 }, { revoked: false }, { revoked: null }, { createdAt: NOW + MIN }, { lastUsedAt: NOW + MIN }, { lastUsedAt: NOW - 95 * DAY, createdAt: NOW - 200 * DAY },
      { expiresAt: NOW - 1 }, { expiresAt: NOW + 1 }, { expiresAt: null }, { surface: 0 }, { surface: 1 }, { surface: 2 }, { surface: 4 }, { consumedAt: NOW - MIN }, { consumedAt: null },
      { actionHash: "other" }, { jobId: "j1" }, { jobId: "engine:*" }, { jobId: "engine:*", origin: "auto-agent-owner", surface: 1 }, { projectId: "p1" }, { projectId: "p2" },
      { delegable: true, id: "held" }, { delegable: true, id: "held", taskId: "t9" }, { delegable: true, id: "held", person: "other" }, { acknowledgedUnsandboxed: true },
      { lastJobTurnAt: NOW - DAY }, { lastJobTurnAt: NOW + DAY }, { lastJobTurnAt: "5" }, { agent: "other" }, { person: "other" }, { capability: String(cap).toUpperCase() },
      { match: { kind: "path", path: "/work/proj", access: "write", recursive: true } }, { match: { kind: "path", path: "/work/proj", access: "read", recursive: true } },
      { match: { kind: "path", path: "/data", access: "write", recursive: false } }, { match: { kind: "path", path: "/data", access: "write", recursive: "yes" } },
      { match: { kind: "action" } }, { match: { kind: "bogus" } }, { match: null }, { createdAt: "1" }, { id: "" }, { sessionId: "s2" }, { taskId: "t2" },
      { scope: "always", createdAt: NOW - 100 * DAY }, { scope: "session", sessionId: "s1", lastUsedAt: NOW - 8 * DAY },
    ];
    const t = { ...pick(tweaks), ...(r() < 0.3 ? pick(tweaks) : {}) };
    return [grant(cap, scope, t)];
  };
  const out: Case[] = [];
  for (let i = 0; i < 2200; i++) {
    const capability = pick(caps);
    const cl: Record<string, unknown> = { capability, tool: r() < 0.8 ? String(capability).trim().toLowerCase() : pick(["fs.read", "shell.run", "FS.Write", "x"]), flags: pick(flagVariants), actionHash: "h1" };
    const effect = pick(effects); if (effect !== undefined) cl.effect = effect;
    const targets = pick(targetSets); if (targets !== undefined) cl.targets = targets;
    const access = pick(accesses); if (access !== undefined) cl.access = access;
    // About one call in ten is malformed in one way: the evaluator must refuse it before any rule runs.
    if (r() < 0.04) cl.flags = pick(badFlags);
    if (r() < 0.02) cl.targets = [5];
    if (r() < 0.02) cl.access = "rw";
    if (r() < 0.02) cl.tool = 7;
    if (r() < 0.02) cl.actionHash = undefined;
    if (r() < 0.05) cl.capability = 7;
    const x = { ...baseCtx(), ...pick(ctxVariants), ...(r() < 0.25 ? pick(ctxVariants) : {}) };
    const grants: Record<string, unknown>[] = [];
    const n = Math.floor(r() * 4);
    for (let k = 0; k < n; k++) grants.push(...grantPool());
    // Grants of the call's own capability make most cases reach the grant rules.
    if (r() < 0.6 && typeof capability === "string") grants.push(grant(capability.trim().toLowerCase(), pick(GRANT_SCOPES), r() < 0.5 ? {} : { match: { kind: "path", path: pick(["/work/proj", "/data", "/"]), access: pick(["read", "write"]), recursive: r() < 0.5 } }));
    const now: number | string = r() < 0.01 ? "NaN" : NOW;
    const c: Case = { name: `grid-${i}`, call: plain(cl), ctx: plain(x), grants: plain(grants), now };
    if (r() < 0.1) c.maxGrantDays = pick([30, 0, 365, "NaN"]);
    out.push(c);
  }
  return out;
}

function decideCases() {
  gid = 0;
  return [...rowCases(), ...gridCases()].map(runCase);
}

// --- paths ------------------------------------------------------------------------------------------------------------------
const SYNTAX_INPUTS: unknown[] = [
  "", "/", "/a/b", "a/b", "./a", "a/../b", "..", "/a/./b//c/", "/a\\b", "C:\\Users\\x", "c:/x", "C:x", "C:", "C:\\", "\\\\server\\share\\x", "\\\\?\\C:\\x", "\\\\.\\pipe\\x", "\\\\?",
  "//?/C:/x", "\\??\\C:\\x", "\\x", "//server/share", "/a/b:c", "a:b", "C:\\a\\b:stream", "C:\\a<b", "C:\\a>b", "C:\\a\"b", "C:\\a|b", "C:\\a?b", "C:\\a*b", "C:\\a\\b.", "C:\\a\\b ",
  "C:\\con", "C:\\CON.txt", "C:\\con .txt", "C:\\com1", "C:\\COM9.log", "C:\\com0", "C:\\com¹.txt", "C:\\lpt³", "C:\\lpt10", "C:\\conin$", "C:\\CONOUT$", "C:\\clock$", "C:\\aux.tar.gz",
  "C:\\PROGRA~1", "C:\\abcdef~12.txt", "C:\\abcdefg~1", "C:\\a~1.long", "C:\\a~1.", "C:\\~1", "C:\\a~b", "C:\\ä~1.txt", "/a\u0001b", "/a\u007fb", "/a\u0085b", "/a\tb", "/a\u202eb",
  "/a\u200fb", "/a\u2066b", "/a\u200bb", "/über/ß", "/u\u0308ber", "/😀/x", "/a\u00a0b", "/a/" + "x".repeat(255), "/a/" + "x".repeat(256), "/a/" + "é".repeat(128), "/" + "a/".repeat(2048),
  "/" + "a/".repeat(2047) + "bb", "a/b/./c/.", "C:\\a\\..\\b", "C:\\a\\.\\b", "C:/a/b", "\\\\srv", "\\\\srv\\", "relative\\win", 5, null, ["x"],
];
const PLATFORM_OPTS = [
  { platform: "darwin" }, { platform: "linux" }, { platform: "win32" }, { platform: "win32", allowUnc: true }, { platform: "darwin", windowsRules: true },
  { platform: "win32", windowsRules: false }, { platform: "freebsd" },
] as const;

const FOLD_INPUTS = ["abc", "ABC", "Straße", "STRASSE", "İstanbul", "istanbul", "K", "k", "ǰ", "J̌", "ﬁ", "FI", "ŉ", "ʼN", "Σ", "ς", "σ", "ΣΑΣ", "u\u0308ber", "über", "Å", "Å", "Å",
  "ﬀ", "ẞ", "ß", "ᾳ", "ΑΙ", "ა", "Ა", "ǅ", "ǆ", "Ǆ", "ı", "I", "ſ", "S", "ﬆ", "ΐ", "ΐ", "Ω", "ω", "ℌ", "ℎ", "Ⓐ", "ⓐ", "𐐀", "𐐨", ".ENV", ".env", "Id_RSA", "café", "cafe\u0301", "한국", "한국", "e\u0301\u0301"];

const DENY_LISTS: DenyEntry[][] = [
  [{ name: ".env" }], [{ name: ".ssh" }, { path: "/home/c/.aws" }], [{ path: "/Users/C/Secrets" }], [{ path: "C:\\Users\\c\\.ssh" }], [{ name: "id_rsa" }, { name: "Straße" }],
  [{ path: "/" }], [{ name: "İ" }], [{ path: "/data/K" }], [{ name: "café" }], [],
];
const DENY_PATHS = ["/home/c/.env", "/home/c/.ENV", "/home/c/.envrc", "/home/c/.ssh/id_rsa", "/home/c/.SSH", "/home/c/.aws/creds", "/home/c/.awsx/creds", "/Users/c/secrets/x", "/users/C/SECRETS",
  "C:\\Users\\C\\.SSH\\id", "c:/users/c/.ssh", "/x/STRASSE", "/x/strasse/y", "/x/i̇", "/x/I", "/data/k", "/data/K/z", "/data/k2", "/x/cafe\u0301", "/x/CAFÉ", "/", "", "//home//c//.env", "/x\\.env"];

const DENY_ENTRY_INPUTS: unknown[] = [
  undefined, [], "x", null, [{ name: ".env" }], [{ name: "" }], [{ name: "." }], [{ name: ".." }], [{ name: "a/b" }], [{ name: "a\\b" }], [{ name: "a\0b" }], [{ name: 5 }],
  [{ path: "/a" }], [{ path: "a" }], [{ path: "C:\\a" }], [{ path: "C:a" }], [{ path: "\\\\srv\\s" }], [{ path: "/a/../b" }], [{ path: "/a/./b" }], [{ path: "/a\0" }], [{ path: "" }],
  [{ name: "x", path: "/a" }], [{}], [null], ["x"], [[]], [{ name: ".env" }, { path: "rel" }], [{ path: "c:/a" }], [{ path: "/a/..." }],
];

const ROOT_REALS = ["/", "/Users", "/Users/c", "/Users/c/work", "/home", "/home/c", "/home/c/proj", "/etc", "/etc/x", "/usr/local/bin", "/System/Library", "/Library/x", "/private/etc/hosts",
  "/private/var/db", "/private/var/folders/x", "/private", "/proc", "/opt/x", "/bin", "/binx", "/Users/c/", "C:\\", "C:\\Users", "C:\\Users\\c", "C:\\Users\\c\\proj", "c:\\windows\\system32",
  "C:\\Program Files", "C:\\Program Files (x86)\\x", "C:\\ProgramData", "C:\\Programs", "D:\\data", "\\\\srv\\share", "\\\\srv\\share\\x", "D:\\"];
// Homes in the spelling of their platform only: `path.resolve` of anything else depends on the recording machine's directory.
const HOMES = { posix: ["/Users/c", "/home/c", "", "/Users/c/", "/Users/c/../d", "/", "/Users//c/./"], win32: ["C:\\Users\\c", "", "c:/users/c/", "C:\\Users\\c\\..\\d", "\\\\srv\\share", "C:\\"] };

const TREE_PATHS = [...ROOT_REALS, "/USERS/C", "/users/c/work", "/ETC/x", "/Etc", "/library", "C:\\WINDOWS\\x", "c:/program files/x", "C:/Users/c", "\\\\srv", "\\\\srv\\share\\a\\b", "",
  "/Users/C/Work", "/Users/ç", "/Users/c\u0327"];
const TREE_HOMES: string[][] = [["/Users/c"], ["/home/c", "/private/home/c"], ["C:\\Users\\c"], [], ["/Users/C"], [""], ["/"]];

function pathCases() {
  const syntax = SYNTAX_INPUTS.map((input) => ({ input, results: PLATFORM_OPTS.map((o) => checkSyntax(input, o as never)) }));
  const reserved = ["con", "CON", "con.txt", "con .txt", "con  ", "prn", "aux", "nul", "conin$", "conout$", "clock$", "com1", "com9", "com0", "com10", "lpt1", "lpt¹", "lpt²", "com³", "comx", "console",
    "", ".", "nul.tar.gz", "Nul", "lpt1.", " con", "COM1:"].map((s) => ({ segment: s, reserved: isReservedDeviceName(s) }));
  const fold = FOLD_INPUTS.map((s) => ({ input: s, folded: foldForDeny(s) }));
  const deny = DENY_LISTS.map((list) => ({ deny: list, matches: DENY_PATHS.map((p) => matchDeny(p, list)) }));
  const invalid = DENY_ENTRY_INPUTS.map((d) => ({ deny: d === undefined ? null : d, absent: d === undefined, result: invalidDenyEntry(d) }));
  const contains = [["/a", "/a"], ["/a", "/a/b"], ["/a", "/ab"], ["/a/", "/a/b"], ["/", "/x"], ["C:\\a", "C:\\a\\b"], ["C:\\a", "C:\\ab"], ["C:\\", "C:\\x"], ["/a", "/A/b"]]
    .flatMap(([root, p]) => ["/", "\\"].map((sep) => ({ root, path: p, sep, contains: containsExact(root!, p!, sep) })));
  const forbidden = ROOT_REALS.flatMap((real) => [false, true].flatMap((windows) => (windows ? HOMES.win32 : HOMES.posix).map((home) => ({ real, windows, home, forbidden: isForbiddenRoot(real, windows, home) }))));
  const tree = TREE_PATHS.flatMap((p) => [false, true].flatMap((windows) => TREE_HOMES.map((homes) => ({ path: p, windows, homes, tree: isSystemTreePath(p, { windows, homes }) }))));
  const reach = TREE_PATHS.flatMap((p) => [false, true].flatMap((recursive) => [false, true].flatMap((windows) => TREE_HOMES.map((homes) => ({ path: p, recursive, windows, homes, reaches: grantReachesSystemTree(p, recursive, { windows, homes }) })))));
  return { syntax, platforms: PLATFORM_OPTS, reserved, fold, deny, denyPaths: DENY_PATHS, invalid, contains, forbidden, tree, reach };
}

export async function buildPolicyVectors() {
  return { tables: tables(), effects: effectCases(), helpers: helperCases(), decide: decideCases(), paths: pathCases() };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await exporterMain({ area: "policy", build: buildPolicyVectors });
}
