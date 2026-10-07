// `permission-eval-e2e` (D109 §11.5, stateful half): the harness for scenarios that run against the REAL stores, the real
// ApprovalService and the real ToolDispatcher (SQLite in a temp dir, fake clock and fake timers) and, for paths, the real
// canonicaliser on the real file system. No mocks of the thing under test.
//
// A row is an attack plus (where it makes sense) its harmless twin. Both return a `Verdict`: `done` says whether the thing the
// attacker wanted happened (a tool executed, a decision was accepted, an RPC answered), `code` says why not. The suite fails
// by NAME on any attack with `done === true` ("ESCAPE"), and on an attack whose `code` is not the expected one.
//
// Path wiring: the production fs tools do not classify yet (a later part), so the harness holds the contract in one place:
// `prep()` runs `canonicalisePath` (requireRoot:false, the credential deny-list, the real roots) and turns the result into the
// tool's `ToolClassification` (`outsideRoots` from the root id, `denyListHit` from a deny-list refusal, targets = the canonical
// path). Any other refusal makes `classify` throw, which the dispatcher turns into a refusal (fail closed).
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createAuditChain, teeAuditSinks, type AuditChain } from "../../src/audit/chain.ts";
import type { ServiceDecideResult } from "../../src/approvals/service.ts";
import { type CreateGrantInput, type StoredGrant } from "../../src/grants/store.ts";
import { createPolicyAudit } from "../../src/policy/audit.ts";
import { canonicalisePath, type DenyEntry, type PathRefusal, type PathRoot } from "../../src/policy/paths-index.ts";
import type { Context, GrantScope, SurfaceTrust } from "../../src/policy/index.ts";
import { memoryAuditSink, type AuditEvent, type AuditSink } from "../../src/rbac/audit.ts";
import { ToolDispatcher, canonicalJson, type DispatchContext, type ToolResult } from "../../src/tools/dispatcher.ts";
import { ToolRegistry, type ToolClassification, type ToolDef } from "../../src/tools/registry.ts";
import { rig, tick, type Rig } from "../approvals/service-helpers.ts";
import { tempDir } from "../helpers/temp-dir.ts";

export { DAY, HOUR, MIN, tick } from "../approvals/service-helpers.ts";

export type Group = "roots" | "lifecycle" | "replay-store" | "timeouts" | "agent-rpc" | "headless" | "handoff" | "audit" | "paths";
export const GROUPS: readonly Group[] = ["roots", "lifecycle", "replay-store", "timeouts", "agent-rpc", "headless", "handoff", "audit", "paths"];

/** `done`: the attacker's goal happened. `code`: the closed reason it did / did not. */
export interface Verdict { done: boolean; code: string }

export interface WorldOpts {
  /** Default true: the service's `policyContext` (denied hashes, prompt cap, verified hand-off) feeds the dispatcher. */
  servicePolicy?: boolean;
  foregroundWaitMs?: number;
  /** Also write every audit line into a real hash-chained audit file. */
  auditChain?: boolean;
}

export interface E2ERow {
  id: string;
  group: Group;
  what: string;
  /** The `code` the attack must end with (string = exact). */
  expect: string | RegExp;
  attack(w: World): Promise<Verdict>;
  /** The harmless twin: must end with `done: true`. */
  benign?(w: World): Promise<Verdict>;
  world?: WorldOpts;
  /** Static skip reason (the OS cannot express this scenario). */
  skip?: string | undefined;
  /** A real gap in the product code, found by this row. The attack is reported as a `todo` (it must not weaken the table) and is
   *  listed by name in the suite; it leaves the zero-escape count only because the owner has to decide the fix. */
  knownGap?: string | undefined;
}

// ---- OS capabilities, probed once (a scenario that the OS cannot express is skipped with its reason, never faked) ----

function probe<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(path.join(tmpdir(), "p1b-e2e-probe-"));
  try { return fn(dir); } finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
}
export const CAN_SYMLINK: boolean = probe((d) => {
  try { writeFileSync(path.join(d, "t"), "x"); symlinkSync(path.join(d, "t"), path.join(d, "l")); return true; } catch { return false; }
});
/** Directory links: a symlink on POSIX, a junction on Windows (needs no privilege). */
export const DIR_LINK_TYPE = process.platform === "win32" ? "junction" : "dir";
export const CAN_DIR_LINK: boolean = probe((d) => {
  try { mkdirSync(path.join(d, "t")); symlinkSync(path.join(d, "t"), path.join(d, "l"), DIR_LINK_TYPE); return true; } catch { return false; }
});
export const CAN_HARDLINK: boolean = probe((d) => {
  try { writeFileSync(path.join(d, "t"), "x"); linkSync(path.join(d, "t"), path.join(d, "l")); return true; } catch { return false; }
});
export const CASE_INSENSITIVE_FS: boolean = probe((d) => { writeFileSync(path.join(d, "Probe.txt"), "x"); return existsSync(path.join(d, "pROBE.txt")); });
export const NFC = "café";
export const NFD = "café";
export const NORMALIZATION_INSENSITIVE_FS: boolean = probe((d) => { writeFileSync(path.join(d, NFC), "x"); return existsSync(path.join(d, NFD)); });

// ---- the world ----

export interface Paths {
  tmp: string; ws: string; other: string; evil: string; home: string;
  wsA: string; wsN: string; wsKey: string; wsEnv: string; wsCookies: string;
  otherB: string; otherC: string; evilX: string; chrome: string; appJson: string;
}

export interface Handle { promise: Promise<ToolResult>; ac: AbortController }

export interface World {
  r: Rig;
  f: Paths;
  roots: PathRoot[];
  deny: DenyEntry[];
  /** Tool executions, in order. */
  runs: { tool: string; args: unknown }[];
  /** Every policy-audit line (the sink the service, the stores and the dispatcher share). */
  audit: AuditEvent[];
  /** Flip to make the audit sink throw (the audit trail is down). */
  auditDown: boolean;
  chain: AuditChain | undefined;
  /** Mutable policy context merged over the dispatcher defaults on every call (headless, hand-off, subject kind, overrides …). */
  policy: Partial<Context>;
  /** The last path refusal `prep` saw. */
  lastRefusal: PathRefusal | undefined;
  d: ToolDispatcher;
  opts: WorldOpts;
  prep(tool: string, input: string, access?: "read" | "write", extra?: { platform?: NodeJS.Platform }): Promise<void>;
  start(tool: string, args: unknown, ov?: Partial<DispatchContext>): Handle;
  startPath(tool: string, input: string, extra?: Record<string, unknown>, ov?: Partial<DispatchContext>): Promise<Handle>;
  /** Calls any tool; if it waits for an approval, aborts it and reports `pending`. */
  probeCall(tool: string, args: unknown, ov?: Partial<DispatchContext>): Promise<Verdict>;
  settleProbe(h: Handle, before: number): Promise<Verdict>;
  /** Calls a path tool; if it parks for approval, aborts it and reports `pending`. */
  probe(tool: string, input: string, extra?: Record<string, unknown>, ov?: Partial<DispatchContext>): Promise<Verdict>;
  /** Calls a path tool, has the person decide the request (default approve once, T3), and returns the result. */
  approvedCall(tool: string, input: string, o?: { extra?: Record<string, unknown>; scope?: GrantScope; surface?: SurfaceTrust; ov?: Partial<DispatchContext>; delegable?: boolean }): Promise<ToolResult>;
  decide(o?: { id?: string; decision?: "approve" | "deny"; scope?: GrantScope; surface?: SurfaceTrust; person?: string; delegable?: boolean; nonce?: string }): ServiceDecideResult;
  pendingIds(): string[];
  /** A path grant for the standing-grant scenarios. */
  grant(o: { dir: string; capability?: string; scope?: GrantScope; access?: "read" | "write"; recursive?: boolean; person?: string; agent?: string; taskId?: string; sessionId?: string; jobId?: string; delegable?: boolean; surface?: SurfaceTrust }): StoredGrant;
  hashOf(tool: string, args: unknown, targets: readonly string[]): string;
  /** A second connection to the same file (what a file-level attacker would hold). */
  raw(): DatabaseSync;
  actions(): string[];
  close(): void;
}

const PATH_SCHEMA = { type: "object", additionalProperties: false, required: ["path"], properties: { path: { type: "string" }, content: { type: "string" }, note: { type: "string" } } };
const BASE_CTX = { agentId: "bernd", principal: "christian", sessionId: "s1", taskId: "t1", surface: 3 as SurfaceTrust };

export async function makeWorld(o: WorldOpts = {}): Promise<World> {
  const tmp = realpathSync.native(tempDir("p1b-e2e-"));
  const put = (p: string, body = "x"): string => { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, body); return p; };
  const j = (...s: string[]): string => path.join(tmp, ...s);
  const f: Paths = {
    tmp, ws: j("ws"), other: j("other"), evil: j("ws-evil"), home: j("home"),
    wsA: put(j("ws", "a.txt")), wsN: put(j("ws", "sub", "n.txt")), wsKey: put(j("ws", ".ssh", "id_ed25519"), "PRIVATE-KEY"), wsEnv: put(j("ws", "sub", ".env"), "TOKEN=1"),
    wsCookies: put(j("ws", "browser-profile", "Default", "Cookies")), otherB: put(j("other", "b.txt")), otherC: put(j("other", "sub", "c.txt")),
    evilX: put(j("ws-evil", "x.txt")), chrome: put(j("home", ".config", "chrome", "Default", "Cookies")), appJson: put(j("home", ".config", "app", "app.json")),
  };
  const roots: PathRoot[] = [{ id: "ws", path: f.ws }];
  const deny: DenyEntry[] = [{ name: ".ssh" }, { name: ".env" }, { name: "tresor-é" }, { path: path.join(f.ws, "browser-profile") }, { path: path.join(f.home, ".config", "chrome") }];

  const mem = memoryAuditSink();
  const chain = o.auditChain ? createAuditChain({ dir: tempDir("p1b-e2e-audit-") }) : undefined;
  const state = { down: false };
  const downable: AuditSink = { append(e) { if (state.down) throw new Error("audit trail is down"); mem.append(e); } };
  const sink: AuditSink = chain ? teeAuditSinks(downable, chain) : downable;
  const r = await rig({ auditSink: sink, ...(o.foregroundWaitMs !== undefined ? { foregroundWaitMs: o.foregroundWaitMs } : {}) });

  const cls = new Map<string, ToolClassification | PathRefusal>();
  const key = (tool: string, p: string): string => `${tool}\0${p}`;
  const classify = (tool: string) => (args: unknown): ToolClassification => {
    const p = (args as { path: string }).path;
    const hit = cls.get(key(tool, p));
    if (!hit) throw new Error(`unprepared path ${p}`);
    if ("reason" in hit) throw new Error(`path refused: ${hit.reason}`);
    return hit;
  };
  const runs: World["runs"] = [];
  const exec = (tool: string): ToolDef["execute"] => async (a) => { runs.push({ tool, args: a }); return { ok: true }; };
  const reg = new ToolRegistry();
  const pathTool = (name: string, capability: string, effect: ToolDef["effect"], risk: ToolDef["risk"]): void =>
    reg.register({ name, description: name, inputSchema: PATH_SCHEMA, capability, effect, risk, trust: "first-party", classify: classify(name), execute: exec(name) });
  pathTool("fs.read", "fs.read", "read", "low");
  pathTool("fs.write", "fs.write", "local-write", "low");
  pathTool("fs.delete", "fs.delete", "local-destructive", "high");
  for (const [name, capability, effect, risk] of [["shell.run", "shell.exec", "local-write", "medium"], ["grant.create", "harness.admin", "local-write", "critical"], ["approval.decide", "harness.admin", "local-write", "critical"], ["pay", "money.spend", "money", "critical"]] as const) {
    reg.register({ name, description: name, inputSchema: { type: "object", additionalProperties: true, properties: {} }, capability, effect, risk, trust: "first-party", classify: () => ({ flags: { outsideRoots: false, sandboxed: true } }), execute: exec(name) });
  }

  const w = {} as World;
  const policyHook = (): Partial<Context> => w.policy;
  const d = new ToolDispatcher({
    registry: reg, approvals: r.service, grants: r.stores.grants, grantUse: r.stores.grants, clock: r.clock, timers: r.timers,
    audit: createPolicyAudit({ sink, clock: r.clock, host: "h" }),
    policyContext: o.servicePolicy === false ? policyHook : r.service.policyContext(policyHook),
  });
  const extraDbs: DatabaseSync[] = [];
  let n = 0;

  const requested = (): { id: string; nonce: string }[] =>
    r.events.filter((e) => e.name === "approval.requested").map((e) => ({ id: e.payload.approval.id as string, nonce: e.payload.nonce as string }));

  Object.assign(w, {
    r, f, roots, deny, runs, audit: mem.events, chain, policy: {}, lastRefusal: undefined, d, opts: o,
    async prep(tool: string, input: string, access?: "read" | "write", extra: { platform?: NodeJS.Platform } = {}) {
      const acc = access ?? (tool === "fs.read" ? "read" : "write");
      const res = await canonicalisePath(input, { roots, deny, access: acc, requireRoot: false, home: f.home, ...(extra.platform ? { platform: extra.platform } : {}) });
      if (res.ok) {
        w.lastRefusal = undefined;
        cls.set(key(tool, input), { flags: { outsideRoots: res.rootId === null, denyListHit: false }, targets: [res.canonical], access: acc });
      } else {
        w.lastRefusal = res;
        // A deny-list refusal is the policy's own `deny-list` rule; every other refusal makes classify throw (fail closed).
        cls.set(key(tool, input), res.reason === "deny-listed" ? { flags: { outsideRoots: true, denyListHit: true }, targets: [input], access: acc } as ToolClassification : res);
      }
    },

    start(tool: string, args: unknown, ov: Partial<DispatchContext> = {}): Handle {
      const ac = new AbortController();
      const promise = d.call({ id: `c${++n}`, name: tool, args }, { ...BASE_CTX, signal: ac.signal, ...ov });
      return { promise, ac };
    },
    async startPath(tool: string, input: string, extra: Record<string, unknown> = {}, ov: Partial<DispatchContext> = {}) {
      await w.prep(tool, input);
      return w.start(tool, { path: input, ...(tool === "fs.write" ? { content: "x" } : {}), ...extra }, ov);
    },
    async probeCall(tool: string, args: unknown, ov: Partial<DispatchContext> = {}): Promise<Verdict> {
      const before = runs.length;
      const h = w.start(tool, args, ov);
      return w.settleProbe(h, before);
    },
    async settleProbe(h: Handle, before: number): Promise<Verdict> {
      const first = await Promise.race([h.promise, tick().then(() => tick()).then(() => "waiting" as const)]);
      if (first === "waiting") {
        h.ac.abort();
        await h.promise;
        return { done: runs.length > before, code: "pending" };
      }
      return { done: runs.length > before, code: codeOf(first) };
    },
    async probe(tool: string, input: string, extra: Record<string, unknown> = {}, ov: Partial<DispatchContext> = {}): Promise<Verdict> {
      const before = runs.length;
      const h = await w.startPath(tool, input, extra, ov);
      return w.settleProbe(h, before);
    },
    async approvedCall(tool, input, o2 = {}) {
      const h = await w.startPath(tool, input, o2.extra ?? {}, o2.ov ?? {});
      await tick(); await tick();
      const ids = w.pendingIds();
      if (ids.length === 0) return h.promise; // no approval was needed
      const res = w.decide({ id: ids[ids.length - 1]!, ...(o2.scope ? { scope: o2.scope } : {}), ...(o2.surface !== undefined ? { surface: o2.surface } : {}), ...(o2.delegable ? { delegable: true } : {}) });
      if (!res.ok) { h.ac.abort(); await h.promise; throw new Error(`approvedCall: decision refused (${res.reason})`); }
      return h.promise;
    },
    decide(o2 = {}) {
      const all = requested();
      const hit = o2.id ? all.find((x) => x.id === o2.id) : all[all.length - 1];
      if (!hit) throw new Error("no approval request to decide");
      return r.service.decide({
        requestId: hit.id, nonce: o2.nonce ?? hit.nonce, decision: o2.decision ?? "approve", person: o2.person ?? "christian", surface: o2.surface ?? 3,
        ...(o2.scope ? { scope: o2.scope } : {}), ...(o2.delegable ? { delegable: true } : {}),
      });
    },
    pendingIds: () => r.stores.approvals.list({ status: "pending" }).map((x) => x.id),
    grant(g) {
      const scope = g.scope ?? "always";
      const input: CreateGrantInput = {
        capability: g.capability ?? "fs.write", person: g.person ?? "christian", agent: g.agent ?? "bernd", scope,
        match: { kind: "path", path: g.dir, access: g.access ?? "write", recursive: g.recursive ?? true }, createdBy: "christian", surface: g.surface ?? 3,
        ...(scope === "task" ? { taskId: g.taskId ?? "t1" } : g.taskId ? { taskId: g.taskId } : {}),
        ...(scope === "session" ? { sessionId: g.sessionId ?? "s1" } : g.sessionId ? { sessionId: g.sessionId } : {}),
        ...(g.jobId ? { jobId: g.jobId } : {}), ...(g.delegable ? { delegable: true } : {}),
      };
      return r.stores.grants.create(input);
    },
    hashOf: (tool, args, targets) => {
      const t = reg.get(tool);
      return createHash("sha256").update(canonicalJson({ capability: t ? t.capability : tool, tool, args, targets })).digest("hex");
    },
    raw() { const db = new DatabaseSync(r.path); db.exec("PRAGMA busy_timeout = 5000"); extraDbs.push(db); return db; },
    actions: () => mem.events.map((e) => e.action),
    close() {
      try { r.service.dispose(); } catch { /* closing */ }
      for (const db of extraDbs) { try { db.close(); } catch { /* closing */ } }
      try { r.stores.close(); } catch { /* closing */ }
    },
  } satisfies Partial<World>);
  Object.defineProperty(w, "auditDown", { get: () => state.down, set: (v: boolean) => { state.down = v; }, enumerable: true });
  return w;
}

/** The closed reason of a tool result, as the scenario tables spell it. */
export function codeOf(res: ToolResult): string {
  if (!res.isError) return "ran";
  const m = res.error.message;
  const pol = /^refused by policy \(([a-z-]+): (.*)\)$/.exec(m);
  if (pol) return `denied:${pol[2]}`;
  const cls = /^the call could not be classified: path refused: (\S+)$/.exec(m);
  if (cls) return `path-refused:${cls[1]}`;
  if (res.error.code === "tool-not-approved") {
    if (/parked/.test(m)) return "parked";
    if (/expired/.test(m)) return "expired";
    if (/denied by the person/.test(m)) return "denied-by-person";
    if (/cancelled/.test(m)) return "cancelled";
    if (/shutting down/.test(m)) return "shutdown";
    if (/integrity|unavailable/.test(m)) return "store-unavailable";
    if (/already used/.test(m)) return "grant-used";
    return "not-approved";
  }
  return res.error.code;
}

/** Settles whatever is still parked on the world (so no promise outlives its row). */
export async function settle(h: Handle[]): Promise<void> {
  for (const x of h) x.ac.abort();
  await Promise.all(h.map((x) => x.promise));
}
