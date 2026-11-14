// Parity vectors (mode V) for the RBAC decision (P4-12 task 1, R10): the `POLICY` table as data, `policyFor`, `authorize`
// and `canSee` over a grid generated from that table, the surface trust tables (`surfaceTrust`, `surfaceSatisfies`) and
// `connectionSurface`. `crates/plur1bus-core/src/rbac/vectors.rs` replays every case and compares the complete decision.
// Recorded, never edited by hand.
//
// ONE SECURITY DECISION, TWO IMPLEMENTATIONS (R10): `packages/api` keeps importing the TypeScript policy beyond the cut, so
// these vectors are the contract that holds both. Changing a policy row, a deny precedence or a reason on either side fails
// a vector (scripts/parity/README.md, "mutation proof" in the P4-12 task 1 report).
//
// Inputs are stored as JSON *text* (`input`), so a case can carry an own `__proto__` key and values JSON cannot hold:
//   {"$num":"NaN"|"Infinity"|"-Infinity"|"-0"}  a number JSON has no literal for
//   {"$undefined":true}                          an explicit `undefined` (an array element, or a member that is present but undefined)
// An absent member is `undefined` to every function here. The exporter and the Rust replay decode these tags the same way.
// An outcome is `{effect, reason, breakGlassId?}` for `authorize`, `{allowed: [index...]}` for `canSee`, a number for the
// surface functions, or `{throws: "TypeError"}` when the TypeScript function throws on input the types forbid.
//
// THE GRID (generated from POLICY, so a new row enlarges it): for every row, every variant of the resource shape the row
// accepts (matching and mismatching ids, own and foreign, every agent right and project right, the empty id, `__proto__` and
// `constructor` ids, rights for another id, the other family's rights) x every role x principal kind {person, agent, absent}
// with no token scopes (layers `grid-*`); then token scopes {[], exact, every `prefix.*`, near misses, `*`, other action, ...}
// x every role x person, on the resource that would allow and one that would not (`scopes-*`); then, for every row that
// takes a user or a memory-user resource, every break-glass grant state x every role x own/foreign target (`break-glass`), and
// every `now` edge for the rows that list a break-glass grant. Full product within each layer; the layers are not multiplied
// into each other (kind is not crossed with token scopes, scopes are not crossed with grants): the counts are in `index`.
//
//   node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning scripts/parity/export-rbac.ts [--check]
import { fileURLToPath } from "node:url";
import { authorize, canSee } from "../../packages/core/src/rbac/authorize.ts";
import { POLICY, policyFor } from "../../packages/core/src/rbac/policy.ts";
import { surfaceSatisfies, surfaceTrust, STEP_UP_WINDOW_MS } from "../../packages/core/src/rbac/surface.ts";
import { connectionSurface, UNATTESTED_LOCAL_SURFACE } from "../../packages/core/src/rbac/connection-surface.ts";
import { PRINCIPAL_KINDS, ROLES, type ActionSpec } from "../../packages/core/src/rbac/types.ts";
import { exporterMain } from "./lib.mjs";

type Case = { name: string; input: string; expected: unknown };
type Desc = any;

// --- the tagged JSON -----------------------------------------------------------------------------------------------------
const NUM = (s: "NaN" | "Infinity" | "-Infinity" | "-0") => ({ $num: s });
const UNDEF = { $undefined: true };
const own = (k: string, v: unknown): any => JSON.parse(`{${JSON.stringify(k)}:${JSON.stringify(v)}}`); // an own `__proto__` key
function revive(v: any): any {
  if (Array.isArray(v)) { const out: any[] = []; for (let i = 0; i < v.length; i++) out[i] = revive(v[i]); return out; }
  if (v !== null && typeof v === "object") {
    const keys = Object.keys(v);
    if (keys.length === 1 && keys[0] === "$num") return ({ NaN: NaN, Infinity: Infinity, "-Infinity": -Infinity, "-0": -0 } as Record<string, number>)[v.$num];
    if (keys.length === 1 && keys[0] === "$undefined") return undefined;
    const out: any = {};
    for (const k of keys) Object.defineProperty(out, k, { value: revive(v[k]), enumerable: true, writable: true, configurable: true });
    return out;
  }
  return v;
}
function enc(v: any): any {
  if (typeof v === "number") return Number.isNaN(v) ? NUM("NaN") : v === Infinity ? NUM("Infinity") : v === -Infinity ? NUM("-Infinity") : Object.is(v, -0) ? NUM("-0") : v;
  if (v === undefined) return UNDEF;
  if (Array.isArray(v)) return v.map(enc);
  if (v !== null && typeof v === "object") { const out: any = {}; for (const k of Object.keys(v)) Object.defineProperty(out, k, { value: enc(v[k]), enumerable: true, writable: true, configurable: true }); return out; }
  return v;
}
const attempt = (f: () => unknown) => { try { return f(); } catch (e) { return { throws: (e as Error).name }; } };
const encDecision = (d: any) => ({ effect: d.effect, reason: d.reason, ...(d.breakGlassId !== undefined ? { breakGlassId: enc(d.breakGlassId) } : {}) });

const seen = new Set<string>();
function mk(name: string, desc: Desc, run: (input: any) => unknown): Case {
  if (seen.has(name)) throw new Error(`duplicate case name ${name}`);
  seen.add(name);
  const input = JSON.stringify(desc);
  return { name, input, expected: attempt(() => run(revive(JSON.parse(input)))) };
}
const auth = (name: string, desc: { principal?: Desc; action?: Desc; resource?: Desc; ctx?: Desc }) =>
  mk(name, desc, (i) => encDecision(authorize(i.principal, i.action, i.resource, i.ctx)));
const sees = (name: string, desc: { principal?: Desc; action?: Desc; resources?: Desc; ctx?: Desc }) =>
  mk(name, desc, (i) => { const out = canSee(i.principal, i.action, i.resources, i.ctx); return { allowed: out.map((r: any) => i.resources.indexOf(r)) }; });

// --- fixed ids and a principal ---------------------------------------------------------------------------------------------
const SELF = "u-self", OTHER = "u-other", TARGET = "u-target", AG = "a1", AG2 = "a2", PJ = "p1", PJ2 = "p2";
const NOW = 1_000_000, ISS = 900_000, EXP = 1_100_000;
const KINDS: (string | undefined)[] = [...PRINCIPAL_KINDS, undefined];
const kindLabel = (k: string | undefined) => k ?? "no-kind";
const person = (role: string, kind: string | undefined, extra: Desc = {}): Desc => ({ userId: SELF, ...(kind === undefined ? {} : { kind }), role, ...extra });

// --- resource variants of a row ----------------------------------------------------------------------------------------------
interface Variant { label: string; resource: Desc; extra?: Desc; best?: boolean; worst?: boolean }
const SYSTEM = { kind: "system" };
const userRes = (id: string) => ({ kind: "user", userId: id });
const agentRes = (id: string) => ({ kind: "agent", agentId: id });
const projectRes = (id: string) => ({ kind: "project", projectId: id });
const memUser = (id: string) => ({ kind: "memory", scope: "user", ownerUserId: id });
const memAgent = (scope: string, id: string) => ({ kind: "memory", scope, agentId: id });

function variantsFor(spec: ActionSpec): Variant[] {
  const shape: string = spec.resource;
  const agentRights = (res: (id: string) => Desc): Variant[] => [
    { label: "no-rights-key", resource: res(AG), worst: true },
    { label: "empty-rights", resource: res(AG), extra: { agentRights: {} } },
    { label: "right-use", resource: res(AG), extra: { agentRights: { [AG]: "use" } } },
    { label: "right-manage", resource: res(AG), extra: { agentRights: { [AG]: "manage" } }, best: true },
    { label: "rights-for-another-agent", resource: res(AG), extra: { agentRights: { [AG2]: "manage" } } },
    { label: "project-rights-do-not-count", resource: res(AG), extra: { projectRights: { [AG]: "lead" } } },
    { label: "proto-id-no-own-entry", resource: res("__proto__"), extra: { agentRights: { [AG]: "manage" } } },
    { label: "constructor-id-no-own-entry", resource: res("constructor"), extra: { agentRights: {} } },
    { label: "empty-id", resource: res(""), extra: { agentRights: { [AG]: "manage" } } },
  ];
  switch (shape) {
    case "system": return [
      { label: "system", resource: SYSTEM, best: true, worst: true },
      { label: "wrong-shape-user", resource: userRes(SELF) },
      { label: "wrong-shape-agent", resource: agentRes(AG) },
    ];
    case "user": return [
      { label: "own", resource: userRes(SELF), best: true },
      { label: "foreign", resource: userRes(OTHER), worst: true },
      { label: "empty-id", resource: userRes("") },
      { label: "wrong-shape-system", resource: SYSTEM },
      { label: "wrong-shape-memory-user", resource: memUser(SELF) },
    ];
    case "agent": return [...agentRights(agentRes), { label: "wrong-shape-system", resource: SYSTEM }, { label: "wrong-shape-memory-workspace", resource: memAgent("workspace", AG), extra: { agentRights: { [AG]: "manage" } } }];
    case "project": return [
      { label: "no-rights-key", resource: projectRes(PJ), worst: true },
      { label: "empty-rights", resource: projectRes(PJ), extra: { projectRights: {} } },
      ...["member", "worker", "reviewer", "lead"].map((r) => ({ label: `right-${r}`, resource: projectRes(PJ), extra: { projectRights: { [PJ]: r } }, ...(r === "lead" ? { best: true } : {}) })),
      { label: "right-use-is-not-a-project-right", resource: projectRes(PJ), extra: { projectRights: { [PJ]: "use" } } },
      { label: "rights-for-another-project", resource: projectRes(PJ), extra: { projectRights: { [PJ2]: "lead" } } },
      { label: "agent-rights-do-not-count", resource: projectRes(PJ), extra: { agentRights: { [PJ]: "manage" } } },
      { label: "proto-id-no-own-entry", resource: projectRes("__proto__"), extra: { projectRights: { [PJ]: "lead" } } },
      { label: "empty-id", resource: projectRes(""), extra: { projectRights: { [PJ]: "lead" } } },
      { label: "wrong-shape-system", resource: SYSTEM },
    ];
    case "memory-user": return [
      { label: "own", resource: memUser(SELF), best: true },
      { label: "foreign", resource: memUser(OTHER), worst: true },
      { label: "empty-owner", resource: memUser("") },
      { label: "wrong-shape-workspace", resource: memAgent("workspace", AG) },
      { label: "wrong-shape-user", resource: userRes(SELF) },
    ];
    default: {
      const scope = shape.slice("memory-agent:".length);
      const other = scope === "workspace" ? "agent-private" : "workspace";
      return [
        ...agentRights((id) => memAgent(scope, id)),
        { label: `wrong-scope-${other}`, resource: memAgent(other, AG), extra: { agentRights: { [AG]: "manage" } } },
        { label: "wrong-scope-user", resource: memUser(SELF), extra: { agentRights: { [AG]: "manage" } } },
        { label: "wrong-shape-agent", resource: agentRes(AG), extra: { agentRights: { [AG]: "manage" } } },
      ];
    }
  }
}

// --- the grid --------------------------------------------------------------------------------------------------------------
const familyOf = (spec: ActionSpec) => spec.resource === "system" ? "system" : spec.resource === "agent" ? "agent" : spec.resource === "project" ? "project"
  : spec.resource === "user" || spec.resource === "memory-user" ? "user" : "memory-agent";
function buildGrid(): Record<string, Case[]> {
  const out: Record<string, Case[]> = {};
  for (const spec of POLICY) {
    const fam = familyOf(spec);
    const list = (out[`grid-${fam}`] ??= []);
    for (const v of variantsFor(spec)) for (const role of ROLES) for (const kind of KINDS)
      list.push(auth(`${spec.action} | ${role} | ${kindLabel(kind)} | ${v.label}`, { principal: person(role, kind, v.extra), action: spec.action, resource: v.resource }));
  }
  return out;
}

/** The scope lists tried against one action: nothing, exact, every prefix, near misses, wildcards, the neighbours. */
function scopeSets(action: string): [string, Desc][] {
  const prefixes: string[] = [];
  for (let i = 0; i < action.length; i++) if (action[i] === "." ) prefixes.push(`${action.slice(0, i)}.*`);
  const sets: [string, Desc][] = [
    ["empty", []], ["exact", [action]], ["other-action", ["zz.other"]], ["star", ["*"]], ["dot-star", [".*"]],
    ["exact-plus-other", ["zz.other", action]], ["truncated-action", [action.slice(0, -1)]], ["action-plus-suffix", [`${action}x`]],
    ["action-dot-star", [`${action}.*`]], ["upper-case", [action.toUpperCase()]], ["padded", [` ${action}`]],
    ["colon-star", [`${action.split(/[.:]/)[0]}:*`]],
  ];
  prefixes.forEach((p, i) => sets.push([`prefix-${i}-${p}`, [p]]));
  return sets;
}
function buildScopes(): Record<string, Case[]> {
  const out: Record<string, Case[]> = {};
  for (const spec of POLICY) {
    const list = (out[spec.resource === "system" ? "scopes-system" : "scopes-object"] ??= []);
    const vs = variantsFor(spec);
    const best = vs.find((v) => v.best)!, worst = vs.find((v) => v.worst)!;
    for (const role of ROLES) {
      for (const [label, scopes] of scopeSets(spec.action)) for (const v of [best, worst].filter((x, i, a) => a.indexOf(x) === i))
        list.push(auth(`${spec.action} | ${role} | person | ${v.label} | scopes ${label}`, { principal: person(role, "person", { ...v.extra, tokenScopes: scopes }), action: spec.action, resource: v.resource }));
    }
  }
  return out;
}

// --- break-glass ---------------------------------------------------------------------------------------------------------------
const grant = (o: Desc = {}): Desc => ({ id: "bg-1", holderUserId: SELF, targetUserId: TARGET, reason: "fixture reason text", issuedAt: ISS, expiresAt: EXP, ...o });
const without = (k: string): Desc => { const g = grant(); delete g[k]; return g; };
const GLASS: [string, Desc | "absent"][] = [
  ["absent", "absent"], ["null", null], ["empty", []], ["valid", [grant()]],
  ["other-holder", [grant({ holderUserId: OTHER })]], ["other-target", [grant({ targetUserId: "u-z" })]], ["target-is-self", [grant({ targetUserId: SELF })]],
  ["revoked", [grant({ revokedAt: 950_000 })]], ["revoked-null", [grant({ revokedAt: null })]], ["revoked-zero", [grant({ revokedAt: 0 })]], ["revoked-explicit-undefined", [grant({ revokedAt: UNDEF })]],
  ["expires-at-now", [grant({ expiresAt: NOW })]], ["expired-by-one", [grant({ expiresAt: NOW - 1 })]], ["expires-after-now-by-one", [grant({ expiresAt: NOW + 1 })]],
  ["issued-at-now", [grant({ issuedAt: NOW })]], ["not-yet-valid", [grant({ issuedAt: NOW + 1 })]], ["empty-window", [grant({ issuedAt: NOW, expiresAt: NOW })]],
  ["first-other-target-second-valid", [grant({ targetUserId: "u-z" }), grant({ id: "bg-2" })]], ["first-valid-second-null", [grant(), null]], ["first-null-second-valid", [null, grant()]],
  ["two-valid-first-wins", [grant({ id: "bg-a" }), grant({ id: "bg-b" })]],
  ["id-number", [grant({ id: 7 })]], ["id-missing", [without("id")]], ["id-null", [grant({ id: null })]], ["id-object", [grant({ id: { a: 1 } })]], ["id-nan", [grant({ id: NUM("NaN") })]],
  ["issued-string", [grant({ issuedAt: "900000" })]], ["issued-string-padded", [grant({ issuedAt: " 900000\n" })]], ["issued-hex", [grant({ issuedAt: "0xdbba0" })]], ["issued-exponent", [grant({ issuedAt: "9e5" })]],
  ["issued-empty-string", [grant({ issuedAt: "" })]], ["issued-garbage", [grant({ issuedAt: "yesterday" })]], ["issued-neg-infinity-string", [grant({ issuedAt: "-Infinity" })]],
  ["issued-null", [grant({ issuedAt: null })]], ["issued-true", [grant({ issuedAt: true })]], ["issued-false", [grant({ issuedAt: false })]], ["issued-missing", [without("issuedAt")]],
  ["issued-array-one", [grant({ issuedAt: [900_000] })]], ["issued-array-two", [grant({ issuedAt: [1, 2] })]], ["issued-array-empty", [grant({ issuedAt: [] })]], ["issued-nested-array", [grant({ issuedAt: [["900000"]] })]],
  ["issued-object", [grant({ issuedAt: {} })]], ["issued-nan", [grant({ issuedAt: NUM("NaN") })]], ["issued-neg-infinity", [grant({ issuedAt: NUM("-Infinity") })]],
  ["expires-string-infinity", [grant({ expiresAt: "Infinity" })]], ["expires-garbage", [grant({ expiresAt: "abc" })]], ["expires-null", [grant({ expiresAt: null })]], ["expires-missing", [without("expiresAt")]],
  ["expires-object", [grant({ expiresAt: {} })]], ["expires-infinity", [grant({ expiresAt: NUM("Infinity") })]], ["expires-array-one", [grant({ expiresAt: ["1100000"] })]], ["expires-true", [grant({ expiresAt: true })]],
  ["holder-number", [grant({ holderUserId: 5 })]], ["target-array", [grant({ targetUserId: [TARGET] })]], ["holder-missing", [without("holderUserId")]],
  ["element-number", [5]], ["element-string", ["x"]], ["element-array", [[]]], ["element-empty-object", [{}]], ["element-undefined", [UNDEF]],
  ["container-string", "grants"], ["container-number", 5], ["container-true", true], ["container-object", {}], ["container-object-with-find", { find: 1 }],
];
function glassPrincipal(role: string, kind: string, g: Desc | "absent"): Desc {
  return person(role, kind, g === "absent" ? {} : { breakGlass: g });
}
function buildBreakGlass(): Record<string, Case[]> {
  const list: Case[] = [];
  const objectSpecs = POLICY.filter((s) => s.resource === "user" || s.resource === "memory-user");
  for (const spec of objectSpecs) for (const role of ROLES) for (const [label, g] of GLASS) for (const [tl, res] of [["own", spec.resource === "user" ? userRes(SELF) : memUser(SELF)], ["foreign", spec.resource === "user" ? userRes(TARGET) : memUser(TARGET)]] as [string, Desc][])
    list.push(auth(`${spec.action} | ${role} | person | ${tl} | glass ${label}`, { principal: glassPrincipal(role, "person", g), action: spec.action, resource: res, ctx: { now: NOW } }));
  const CTX: [string, Desc | "absent"][] = [
    ["absent", "absent"], ["undefined", UNDEF], ["empty", {}], ["now", { now: NOW }], ["now-before-issue", { now: ISS - 1 }], ["now-at-issue", { now: ISS }], ["now-last-ms", { now: EXP - 1 }],
    ["now-at-expiry", { now: EXP }], ["now-after-expiry", { now: EXP + 1 }], ["now-nan", { now: NUM("NaN") }], ["now-infinity", { now: NUM("Infinity") }], ["now-neg-infinity", { now: NUM("-Infinity") }],
    ["now-negative-zero", { now: NUM("-0") }], ["now-string", { now: String(NOW) }], ["now-null", { now: null }], ["now-true", { now: true }], ["now-array", { now: [NOW] }], ["now-explicit-undefined", { now: UNDEF }],
    ["ctx-null", null], ["ctx-number", 5], ["ctx-string", "ctx"], ["ctx-array", []], ["ctx-with-extra", { now: NOW, extra: 1 }],
  ];
  for (const spec of POLICY.filter((s) => Object.values(s.grants).some((g) => g?.includes("break-glass")))) for (const role of ROLES) for (const kind of ["person", "agent"]) for (const [cl, ctx] of CTX)
    for (const [tl, res] of [["foreign", spec.resource === "user" ? userRes(TARGET) : memUser(TARGET)], ["own", spec.resource === "user" ? userRes(SELF) : memUser(SELF)]] as [string, Desc][])
      list.push(auth(`${spec.action} | ${role} | ${kind} | ${tl} | ctx ${cl}`, { principal: glassPrincipal(role, kind, [grant()]), action: spec.action, resource: res, ...(ctx === "absent" ? {} : { ctx }) }));
  return { "break-glass": list };
}

// --- odd input ----------------------------------------------------------------------------------------------------------------
// Everything the TypeScript types forbid but a caller (a JSON-RPC handler, a JS plugin) can still hand over.
function buildOdd(): Record<string, Case[]> {
  const list: Case[] = [];
  const ok = person("owner", "person");
  const sys = { action: "chat:read", resource: SYSTEM };
  const principals: [string, Desc | "absent"][] = [
    ["undefined", "absent"], ["explicit-undefined", UNDEF], ["null", null], ["string", "owner"], ["number", 5], ["true", true], ["empty-array", []], ["array-with-user", [{ userId: SELF, role: "owner" }]], ["empty-object", {}],
    ["user-id-empty", { userId: "", role: "owner" }], ["user-id-number", { userId: 5, role: "owner" }], ["user-id-null", { userId: null, role: "owner" }], ["user-id-array", { userId: [SELF], role: "owner" }], ["user-id-missing", { role: "owner" }],
    ["role-unknown", { userId: SELF, role: "root" }], ["role-capitalised", { userId: SELF, role: "Owner" }], ["role-array", { userId: SELF, role: ["owner"] }], ["role-null", { userId: SELF, role: null }], ["role-missing", { userId: SELF }],
    ["role-constructor", { userId: SELF, role: "constructor" }], ["role-proto", { userId: SELF, role: "__proto__" }], ["role-padded", { userId: SELF, role: "owner " }], ["role-to-string", { userId: SELF, role: "toString" }],
    ["kind-robot", { userId: SELF, role: "owner", kind: "robot" }], ["kind-null", { userId: SELF, role: "owner", kind: null }], ["kind-number", { userId: SELF, role: "owner", kind: 5 }], ["kind-array", { userId: SELF, role: "owner", kind: ["person"] }],
    ["kind-constructor", { userId: SELF, role: "owner", kind: "constructor" }], ["kind-empty", { userId: SELF, role: "owner", kind: "" }], ["kind-capitalised", { userId: SELF, role: "owner", kind: "Person" }], ["kind-explicit-undefined", { userId: SELF, role: "owner", kind: UNDEF }],
    ["extra-members-ignored", { userId: SELF, role: "owner", kind: "person", surprise: { deep: [1] }, binding: { x: 1 } }],
  ];
  for (const [l, p] of principals) for (const a of ["chat:read", "inbox.read"]) list.push(auth(`odd principal ${l} | ${a}`, { ...(p === "absent" ? {} : { principal: p }), action: a, resource: SYSTEM }));
  const actions: [string, Desc][] = [
    ["null", null], ["explicit-undefined", UNDEF], ["number", 5], ["true", true], ["object", {}], ["array", []], ["array-with-action", ["chat:read"]], ["empty", ""], ["leading-space", " chat:read"], ["trailing-space", "chat:read "],
    ["upper-case", "CHAT:READ"], ["proto", "__proto__"], ["constructor", "constructor"], ["to-string", "toString"], ["has-own-property", "hasOwnProperty"], ["value-of", "valueOf"], ["nul-suffix", "chat:read\u0000"],
    ["unknown-dotted", "zz.unknown"], ["prefix-of-real", "chat"], ["real-plus-suffix", "chat:readx"],
  ];
  for (const [l, a] of actions) for (const p of [ok, person("owner", "agent")]) list.push(auth(`odd action ${l} | ${p.kind}`, { principal: p, action: a, resource: SYSTEM }));
  list.push(auth("odd action missing", { principal: ok, resource: SYSTEM }));
  // humanOnly first: an unknown principal kind never reaches it, an agent never reaches the resource check.
  list.push(auth("humanOnly agent with a bad resource", { principal: person("owner", "agent"), action: "inbox.read", resource: 5 }));
  list.push(auth("humanOnly no kind with a bad resource", { principal: person("owner", undefined), action: "inbox.read", resource: null }));
  list.push(auth("humanOnly person with a bad resource", { principal: person("owner", "person"), action: "inbox.read", resource: 5 }));
  list.push(auth("unknown action with an agent", { principal: person("owner", "agent"), action: "zz.unknown", resource: 5 }));
  list.push(auth("invalid principal before unknown action", { principal: { userId: "", role: "owner" }, action: "zz.unknown", resource: SYSTEM }));
  list.push(auth("token scope after resource mismatch", { principal: person("viewer", "person", { tokenScopes: [] }), action: "chat:read", resource: userRes(SELF) }));
  list.push(auth("token scope before role", { principal: person("viewer", "person", { tokenScopes: [] }), action: "chat:write", resource: SYSTEM }));
  list.push(auth("token scope garbage before role", { principal: person("viewer", "person", { tokenScopes: 5 }), action: "chat:write", resource: SYSTEM }));
  list.push(auth("humanOnly before token scope", { principal: person("owner", "agent", { tokenScopes: [5] }), action: "inbox.read", resource: SYSTEM }));
  list.push(auth("resource before token scope throw", { principal: person("owner", "person", { tokenScopes: 5 }), action: "chat:read", resource: userRes(SELF) }));
  // resources
  const resources: [string, Desc | "absent"][] = [
    ["undefined", "absent"], ["explicit-undefined", UNDEF], ["null", null], ["string", "system"], ["number", 5], ["true", true], ["empty-array", []], ["array-with-system", [SYSTEM]], ["empty-object", {}],
    ["kind-null", { kind: null }], ["kind-number", { kind: 5 }], ["kind-array", { kind: ["system"] }], ["kind-capitalised", { kind: "System" }], ["kind-padded", { kind: "system " }], ["system-with-extras", { kind: "system", userId: SELF, agentId: AG }],
    ["kind-memory-without-scope", { kind: "memory" }], ["kind-memory-user-literal", { kind: "memory-user", ownerUserId: SELF }], ["kind-memory-agent-literal", { kind: "memory-agent:workspace", agentId: AG }],
  ];
  for (const [l, r] of resources) for (const a of ["chat:read", "my.read", "agent.read"]) list.push(auth(`odd resource ${l} | ${a}`, { principal: ok, action: a, ...(r === "absent" ? {} : { resource: r }) }));
  const ids: [string, Desc][] = [["number", 5], ["null", null], ["array", [SELF]], ["object", {}], ["true", true], ["explicit-undefined", UNDEF], ["empty", ""], ["padded-self", ` ${SELF}`], ["upper-case-self", SELF.toUpperCase()]];
  for (const [l, id] of ids) {
    list.push(auth(`odd id user ${l}`, { principal: person("member", "person"), action: "my.read", resource: { kind: "user", userId: id } }));
    list.push(auth(`odd id agent ${l}`, { principal: person("member", "person", { agentRights: { [AG]: "use" } }), action: "agent.use", resource: { kind: "agent", agentId: id } }));
    list.push(auth(`odd id project ${l}`, { principal: person("member", "person", { projectRights: { [PJ]: "lead" } }), action: "project.write", resource: { kind: "project", projectId: id } }));
    list.push(auth(`odd id memory user ${l}`, { principal: person("member", "person"), action: "memory.user.read", resource: { kind: "memory", scope: "user", ownerUserId: id } }));
    list.push(auth(`odd id memory workspace ${l}`, { principal: person("member", "person", { agentRights: { [AG]: "use" } }), action: "memory.workspace.read", resource: { kind: "memory", scope: "workspace", agentId: id } }));
  }
  const scopes: [string, Desc][] = [
    ["string", "chat:read"], ["number", 5], ["true", true], ["null", null], ["object", {}], ["object-with-length", { length: 1, 0: "chat:read" }], ["explicit-undefined", UNDEF], ["empty", []], ["star", ["*"]], ["dot-star", [".*"]],
    ["chat-colon-star", ["chat:*"]], ["exact", ["chat:read"]], ["number-element", [5]], ["null-element", [null]], ["undefined-element", [UNDEF]], ["array-element", [["chat:read"]]], ["object-element", [{}]],
    ["match-then-garbage", ["chat:read", 5]], ["garbage-then-match", [5, "chat:read"]], ["miss-then-garbage", ["zz.other", null]], ["wildcard-then-garbage", ["chat.*", null]], ["exact-then-null", ["chat:read", null]],
    ["empty-string", [""]], ["dot", ["."]], ["double-star", ["chat:read.*"]], ["long-prefix", ["inbox.*"]],
  ];
  for (const [l, s] of scopes) for (const a of ["chat:read", "inbox.read"]) list.push(auth(`odd tokenScopes ${l} | ${a}`, { principal: person("owner", "person", { tokenScopes: s }), action: a, resource: SYSTEM }));
  // rights tables and their values
  const tables: [string, Desc][] = [
    ["null", null], ["string-manage", "manage"], ["string-long", "manage-manage-manage"], ["number", 5], ["true", true], ["empty-array", []], ["array-index-0", ["manage"]], ["array-index-1", ["use", "manage"]], ["array-use-at-0", ["use"]],
    ["empty-object", {}], ["explicit-undefined", UNDEF], ["own-proto-manage", own("__proto__", "manage")], ["own-constructor-manage", { constructor: "manage" }], ["own-length-manage", { length: "manage" }], ["own-to-string-manage", { toString: "manage" }],
    ["own-has-own-property-manage", { hasOwnProperty: "manage" }],
  ];
  const tableIds = ["0", "1", "length", "__proto__", "constructor", "toString", "hasOwnProperty", "valueOf", AG];
  for (const [l, t] of tables) for (const id of tableIds) list.push(auth(`odd agentRights ${l} | id ${id}`, { principal: person("member", "person", { agentRights: t }), action: "agent.use", resource: agentRes(id) }));
  for (const [l, t] of tables) for (const id of ["0", "__proto__", "constructor", PJ]) list.push(auth(`odd projectRights ${l} | id ${id}`, { principal: person("member", "person", { projectRights: t }), action: "project.write", resource: projectRes(id) }));
  const values: [string, Desc][] = [
    ["use", "use"], ["manage", "manage"], ["member", "member"], ["lead", "lead"], ["worker", "worker"], ["reviewer", "reviewer"], ["capitalised", "Manage"], ["padded", "manage "], ["empty", ""], ["root", "root"], ["constructor", "constructor"],
    ["to-string", "toString"], ["proto", "__proto__"], ["has-own-property", "hasOwnProperty"], ["number", 2], ["null", null], ["true", true], ["explicit-undefined", UNDEF], ["array-manage", ["manage"]], ["nested-array-manage", [["manage"]]],
    ["array-two", ["use", "manage"]], ["empty-array", []], ["object", {}], ["object-manage", { manage: 1 }],
  ];
  for (const [l, v] of values) {
    list.push(auth(`odd agent right ${l} | needs use`, { principal: person("member", "person", { agentRights: { [AG]: v } }), action: "agent.use", resource: agentRes(AG) }));
    list.push(auth(`odd agent right ${l} | needs manage`, { principal: person("member", "person", { agentRights: { [AG]: v } }), action: "agent.manage", resource: agentRes(AG) }));
    list.push(auth(`odd project right ${l} | needs member`, { principal: person("member", "person", { projectRights: { [PJ]: v } }), action: "project.write", resource: projectRes(PJ) }));
    list.push(auth(`odd project right ${l} | needs lead`, { principal: person("member", "person", { projectRights: { [PJ]: v } }), action: "project.manage", resource: projectRes(PJ) }));
  }
  list.push(auth("own proto key as an agent id with a right", { principal: person("member", "person", { agentRights: own("__proto__", "manage") }), action: "agent.manage", resource: agentRes("__proto__") }));
  list.push(auth("own constructor key as a project id with a right", { principal: person("member", "person", { projectRights: { constructor: "lead" } }), action: "project.manage", resource: projectRes("constructor") }));
  // memory scopes
  const scopesOfMemory: [string, Desc][] = [
    ["user", "user"], ["workspace", "workspace"], ["agent-private", "agent-private"], ["array-workspace", ["workspace"]], ["nested-array-workspace", [["workspace"]]], ["array-user", ["user"]], ["array-agent-private", ["agent-private"]],
    ["capitalised", "Workspace"], ["empty", ""], ["null", null], ["number", 5], ["true", true], ["object", {}], ["explicit-undefined", UNDEF], ["missing", "absent"], ["two-element-array", ["workspace", "x"]],
  ];
  for (const [l, s] of scopesOfMemory) for (const a of ["memory.workspace.read", "memory.agent-private.read", "memory.user.read"]) {
    const r: any = { kind: "memory", ownerUserId: SELF, agentId: AG };
    if (s !== "absent") r.scope = s;
    list.push(auth(`odd memory scope ${l} | ${a}`, { principal: person("owner", "person"), action: a, resource: r }));
  }
  list.push(auth("memory user scope with only an agentId", { principal: person("owner", "person"), action: "memory.user.read", resource: { kind: "memory", scope: "user", agentId: SELF } }));
  list.push(auth("memory workspace scope with only an ownerUserId", { principal: person("owner", "person"), action: "memory.workspace.read", resource: { kind: "memory", scope: "workspace", ownerUserId: AG } }));
  // break-glass container and ctx oddities with every role that could reach them
  for (const role of ["owner", "admin"]) for (const [l, g] of [["null", null], ["string", "g"], ["number", 5], ["object", {}], ["null-element", [null]], ["valid-then-null", [grant(), null]], ["null-then-valid", [null, grant()]]] as [string, Desc][])
    for (const [cl, ctx] of [["now", { now: NOW }], ["null", null], ["absent", "absent"]] as [string, Desc][])
      list.push(auth(`odd breakGlass ${l} | ${role} | ctx ${cl}`, { principal: person(role, "person", { breakGlass: g }), action: "memory.user.read", resource: memUser(TARGET), ...(ctx === "absent" ? {} : { ctx }) }));
  list.push(auth("odd breakGlass is not read for an own resource", { principal: person("owner", "person", { breakGlass: "g" }), action: "memory.user.read", resource: memUser(SELF), ctx: null }));
  list.push(auth("odd breakGlass is not read for a role without the grant", { principal: person("member", "person", { breakGlass: "g" }), action: "memory.user.read", resource: memUser(TARGET), ctx: { now: NOW } }));
  list.push(auth("odd breakGlass is not read without a finite now", { principal: person("owner", "person", { breakGlass: "g" }), action: "memory.user.read", resource: memUser(TARGET), ctx: { now: NUM("NaN") } }));
  return { "odd-authorize": list };
}

// --- canSee ----------------------------------------------------------------------------------------------------------------------
function resourceList(spec: ActionSpec): Desc[] {
  switch (spec.resource) {
    case "system": return [SYSTEM, userRes(SELF), agentRes(AG)];
    case "user": return [userRes(SELF), userRes(OTHER), userRes(TARGET), userRes(""), SYSTEM];
    case "agent": return [agentRes("a0"), agentRes(AG), agentRes(AG2), agentRes("__proto__"), agentRes(""), SYSTEM];
    case "project": return [projectRes("p0"), projectRes(PJ), projectRes(PJ2), projectRes("constructor"), SYSTEM];
    case "memory-user": return [memUser(SELF), memUser(OTHER), memUser(TARGET), memUser(""), memAgent("workspace", AG)];
    default: { const s = spec.resource.slice("memory-agent:".length); return [memAgent(s, "a0"), memAgent(s, AG), memAgent(s, AG2), memAgent(s === "workspace" ? "agent-private" : "workspace", AG), memAgent(s, "__proto__"), memUser(SELF)]; }
  }
}
function buildCanSee(): Record<string, Case[]> {
  const list: Case[] = [];
  for (const spec of POLICY) for (const role of ROLES)
    list.push(sees(`${spec.action} | ${role}`, {
      principal: person(role, "person", { agentRights: { [AG]: "use", [AG2]: "manage" }, projectRights: { [PJ]: "member", [PJ2]: "lead" }, breakGlass: [grant()] }),
      action: spec.action, resources: resourceList(spec), ctx: { now: NOW },
    }));
  const rs = [SYSTEM, userRes(SELF)];
  for (const [l, r] of [["null", null], ["undefined", "absent"], ["string", "abc"], ["number", 5], ["object", {}], ["object-with-filter", { filter: 1 }]] as [string, Desc][])
    list.push(sees(`odd resources ${l}`, { principal: person("owner", "person"), action: "chat:read", ...(r === "absent" ? {} : { resources: r }) }));
  list.push(sees("empty list", { principal: person("owner", "person"), action: "chat:read", resources: [] }));
  list.push(sees("null principal", { principal: null, action: "chat:read", resources: rs }));
  list.push(sees("unknown action", { principal: person("owner", "person"), action: "zz.unknown", resources: rs }));
  list.push(sees("non-object elements", { principal: person("owner", "person"), action: "chat:read", resources: [null, UNDEF, 5, "x", [], SYSTEM] }));
  list.push(sees("a throwing principal over a list", { principal: person("owner", "person", { tokenScopes: 5 }), action: "chat:read", resources: rs }));
  list.push(sees("a throwing principal over an empty list", { principal: person("owner", "person", { tokenScopes: 5 }), action: "chat:read", resources: [] }));
  list.push(sees("a throwing principal and a mismatching first element", { principal: person("owner", "person", { tokenScopes: 5 }), action: "chat:read", resources: [userRes(SELF), SYSTEM] }));
  list.push(sees("break-glass null element throws on the foreign one only", { principal: person("owner", "person", { breakGlass: [null] }), action: "memory.user.read", resources: [memUser(SELF), memUser(TARGET)], ctx: { now: NOW } }));
  list.push(sees("break-glass null element is not reached for own ones", { principal: person("owner", "person", { breakGlass: [null] }), action: "memory.user.read", resources: [memUser(SELF)], ctx: { now: NOW } }));
  list.push(sees("ctx null throws on the foreign one", { principal: person("owner", "person", { breakGlass: [grant()] }), action: "memory.user.read", resources: [memUser(TARGET)], ctx: null }));
  return { cansee: list };
}

// --- policy dump ---------------------------------------------------------------------------------------------------------------------
function buildPolicy() {
  const cases: Case[] = [];
  const names: [string, Desc][] = [...POLICY.map((s): [string, Desc] => [s.action, s.action]), ["empty", ""], ["unknown-dotted", "zz.unknown"], ["upper-case", "CHAT:READ"], ["trailing-space", "chat:read "], ["proto", "__proto__"],
    ["constructor", "constructor"], ["to-string", "toString"], ["has-own-property", "hasOwnProperty"], ["value-of", "valueOf"], ["trailing-dot", "a2a.peers.manage."], ["null", null], ["number", 5], ["true", true],
    ["object", {}], ["array", []], ["array-with-action", ["chat:read"]], ["undefined", UNDEF]];
  for (const [l, a] of names) cases.push(mk(`policyFor ${l}`, { action: a }, (i) => { const s = policyFor(i.action); return s === undefined ? { found: false } : { found: true, spec: JSON.parse(JSON.stringify(s)) }; }));
  const actions = POLICY.map((s) => s.action);
  return {
    policy: {
      roles: [...ROLES], principalKinds: [...PRINCIPAL_KINDS], stepUpWindowMs: STEP_UP_WINDOW_MS, unattestedLocalSurface: UNATTESTED_LOCAL_SURFACE,
      frozen: Object.isFrozen(POLICY), actions, rows: JSON.parse(JSON.stringify(POLICY)), policyFor: cases,
    },
  };
}

// --- surface ---------------------------------------------------------------------------------------------------------------------------
const trust = (name: string, facts?: Desc) => mk(name, facts === undefined ? {} : { facts }, (i) => surfaceTrust(i.facts));
function buildSurface(): Record<string, Case[]> {
  const t: Case[] = [];
  t.push(trust("desktop-app", { kind: "desktop-app" }), trust("desktop-app with extras", { kind: "desktop-app", tty: false, authenticated: false }));
  const flag: [string, Desc | "absent"][] = [["true", true], ["false", false], ["absent", "absent"], ["string-true", "true"], ["one", 1], ["null", null], ["array-true", [true]]];
  for (const [tl, tty] of flag) for (const [ol, owner] of flag)
    t.push(trust(`cli tty ${tl} owner ${ol}`, { kind: "cli", ...(tty === "absent" ? {} : { tty }), ...(owner === "absent" ? {} : { osUserIsOwner: owner }) }));
  const N = NOW;
  const nows: [string, Desc | "absent"][] = [["now", N], ["zero", 0], ["negative", -5], ["nan", NUM("NaN")], ["infinity", NUM("Infinity")], ["neg-infinity", NUM("-Infinity")], ["string", String(N)], ["null", null], ["absent", "absent"], ["true", true], ["array", [N]], ["negative-zero", NUM("-0")]];
  const ups = (n: number): [string, Desc | "absent"][] => [["absent", "absent"], ["equal", n], ["one-before", n - 1], ["window-minus-one", n - STEP_UP_WINDOW_MS + 1], ["window", n - STEP_UP_WINDOW_MS], ["window-plus-one", n - STEP_UP_WINDOW_MS - 1],
    ["one-after", n + 1], ["zero", 0], ["nan", NUM("NaN")], ["infinity", NUM("Infinity")], ["neg-infinity", NUM("-Infinity")], ["string", String(n)], ["null", null], ["true", true], ["array", [n]], ["explicit-undefined", UNDEF], ["negative-zero", NUM("-0")]];
  for (const [al, authd] of flag) for (const [nl, now] of nows) for (const [ul, up] of ups(N))
    t.push(trust(`web authenticated ${al} now ${nl} stepUpAt ${ul}`, { kind: "web", ...(authd === "absent" ? {} : { authenticated: authd }), ...(now === "absent" ? {} : { now }), ...(up === "absent" ? {} : { stepUpAt: up }) }));
  for (const [nl, now] of [["tiny-zero", 0], ["tiny-1000", 1000]] as [string, number][]) for (const [ul, up] of ups(now))
    t.push(trust(`web authenticated true now ${nl} stepUpAt ${ul}`, { kind: "web", authenticated: true, now, ...(up === "absent" ? {} : { stepUpAt: up }) }));
  t.push(trust("web at the float edge", { kind: "web", authenticated: true, now: 1.7976931348623157e308, stepUpAt: -1.7976931348623157e308 }));
  t.push(trust("web at 2^53", { kind: "web", authenticated: true, now: 9007199254740992, stepUpAt: 9007199254740992 - STEP_UP_WINDOW_MS }));
  const chats: [string, Desc | "absent"][] = [["private", "private"], ["group", "group"], ["capitalised", "Private"], ["absent", "absent"], ["array", ["private"]], ["null", null]];
  const b: [string, Desc | "absent"][] = [["true", true], ["false", false], ["absent", "absent"], ["string", "true"]];
  for (const [fl, fp] of b) for (const [ol, op] of b) for (const [cl, ch] of chats) for (const [il, il2] of b.slice(0, 3)) for (const [nl, nv] of b.slice(0, 3))
    t.push(trust(`channel firstParty ${fl} opted ${ol} chat ${cl} linked ${il} nonce ${nl}`, { kind: "channel", ...(fp === "absent" ? {} : { firstParty: fp }), ...(op === "absent" ? {} : { optedIntoT2: op }), ...(ch === "absent" ? {} : { chat: ch }), ...(il2 === "absent" ? {} : { identityLinked: il2 }), ...(nv === "absent" ? {} : { nonceValid: nv }) }));
  for (const [sl, s] of flag) t.push(trust(`acp-editor startedSession ${sl}`, { kind: "acp-editor", ...(s === "absent" ? {} : { startedSession: s }) }));
  for (const k of ["mcp-client", "a2a-peer", "agent", "model-output", "tool-result", "unknown", "weird", "", "Desktop-App", "desktop-app "]) t.push(trust(`kind ${JSON.stringify(k)}`, { kind: k }));
  t.push(trust("kind missing", {}), trust("kind null", { kind: null }), trust("kind number", { kind: 5 }), trust("kind array", { kind: ["desktop-app"] }), trust("kind object", { kind: {} }), trust("kind explicit undefined", { kind: UNDEF }),
    trust("kind proto-looking", { kind: "__proto__" }), trust("kind constructor", { kind: "constructor" }));
  for (const [l, f] of [["undefined", "absent"], ["null", null], ["string", "desktop-app"], ["number", 3], ["true", true], ["array", [{ kind: "desktop-app" }]], ["empty-array", []]] as [string, Desc][])
    t.push(trust(`facts ${l}`, f === "absent" ? undefined : f));
  t.push(trust("facts with an own proto key", own("__proto__", { kind: "desktop-app" })));

  const s: Case[] = [];
  const haves: [string, Desc][] = [["0", 0], ["1", 1], ["2", 2], ["3", 3], ["4", 4], ["-1", -1], ["1.5", 1.5], ["negative-zero", NUM("-0")], ["nan", NUM("NaN")], ["infinity", NUM("Infinity")], ["string-1", "1"], ["null", null], ["undefined", UNDEF], ["true", true], ["array-1", [1]], ["object", {}]];
  const reqs: [string, Desc][] = [["null", null], ["0", 0], ["1", 1], ["2", 2], ["3", 3], ["4", 4], ["-1", -1], ["1.5", 1.5], ["negative-zero", NUM("-0")], ["nan", NUM("NaN")], ["infinity", NUM("Infinity")], ["string-2", "2"], ["undefined", UNDEF], ["true", true], ["array-2", [2]], ["object", {}]];
  for (const [hl, h] of haves) for (const [rl, r] of reqs) s.push(mk(`satisfies have ${hl} required ${rl}`, { have: h, required: r }, (i) => surfaceSatisfies(i.have, i.required)));
  s.push(mk("satisfies have missing", { required: 1 }, (i) => surfaceSatisfies(i.have, i.required)), mk("satisfies required missing", { have: 3 }, (i) => surfaceSatisfies(i.have, i.required)));

  const c: Case[] = [];
  const conn = (name: string, facts?: Desc) => c.push(mk(`connection ${name}`, facts === undefined ? {} : { facts }, (i) => connectionSurface(i.facts)));
  const principals: [string, Desc | "absent"][] = [["person", person("owner", "person")], ["kind-only", { kind: "person" }], ["agent", person("owner", "agent")], ["no-kind", person("owner", undefined)], ["kind-array", { kind: ["person"] }], ["kind-capitalised", { kind: "Person" }],
    ["null", null], ["absent", "absent"], ["string", "person"], ["array", [{ kind: "person" }]], ["empty-object", {}], ["own-proto", own("__proto__", { kind: "person" })], ["role-invalid-person", { userId: "", role: "root", kind: "person" }]];
  const flags: [string, Desc | "absent"][] = [["true", true], ["false", false], ["absent", "absent"], ["string-true", "true"]];
  const atts: [string, Desc | "absent"][] = [["absent", "absent"], ["null", null], ["string", "desktop-app"], ["array", [{ kind: "desktop-app" }]], ["empty", {}], ["desktop-app", { kind: "desktop-app" }], ["desktop-app-extras", { kind: "desktop-app", tty: false }],
    ["unknown-kind", { kind: "mcp-client" }], ["kind-number", { kind: 5 }], ["kind-array", { kind: ["desktop-app"] }], ["kind-capitalised", { kind: "Desktop-App" }], ["web-no-step-up", { kind: "web-step-up" }], ["web-kind-web", { kind: "web", stepUpAt: NOW }],
    ["own-proto", own("__proto__", { kind: "desktop-app" })]];
  for (const [tl, tty] of flags) for (const [ol, owner] of flags) atts.push([`cli tty ${tl} owner ${ol}`, { kind: "cli", ...(tty === "absent" ? {} : { tty }), ...(owner === "absent" ? {} : { osUserIsOwner: owner }) }]);
  for (const [ul, up] of ups(NOW)) atts.push([`web-step-up ${ul}`, { kind: "web-step-up", ...(up === "absent" ? {} : { stepUpAt: up }) }]);
  for (const [pl, p] of principals) for (const [nl, now] of nows.slice(0, 6).concat(nows.slice(8, 9))) for (const [al, a] of atts)
    if (pl === "person" || (nl === "now" && ["absent", "desktop-app", "web-step-up equal"].includes(al)) || (nl === "now" && al.startsWith("cli tty true owner true")))
      conn(`principal ${pl} now ${nl} attestation ${al}`, { principal: p === "absent" ? undefined : p, now: now === "absent" ? undefined : now, ...(a === "absent" ? {} : { attestation: a }) });
  conn("facts undefined"); conn("facts null", null); conn("facts string", "x"); conn("facts array", []); conn("facts number", 5);
  conn("stepUpAt window edge with a stale now", { principal: person("owner", "person"), now: 5 * 60_000, attestation: { kind: "web-step-up", stepUpAt: 0 } });
  conn("stepUpAt one past the window", { principal: person("owner", "person"), now: 5 * 60_000 + 1, attestation: { kind: "web-step-up", stepUpAt: 0 } });
  return { "surface-trust": t, "surface-satisfies": s, "connection-surface": c };
}

// --- main -------------------------------------------------------------------------------------------------------------------------------
export async function buildRbacVectors(): Promise<Record<string, any>> {
  seen.clear();
  const files: Record<string, any> = {
    ...buildPolicy(), ...buildGrid(), ...buildScopes(), ...buildBreakGlass(), ...buildOdd(), ...buildCanSee(), ...buildSurface(),
  };
  const counts: Record<string, number> = {};
  for (const [name, data] of Object.entries(files)) counts[name] = Array.isArray(data) ? data.length : data.policyFor.length + data.rows.length;
  const total = Object.entries(files).reduce((n, [name, d]) => n + (Array.isArray(d) ? d.length : 0), 0);
  return { ...files, index: { policyRows: POLICY.length, files: counts, totalDecisionAndSurfaceCases: total } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await exporterMain({ area: "rbac", build: buildRbacVectors });
}
