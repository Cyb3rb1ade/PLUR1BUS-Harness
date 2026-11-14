// Parity vectors (mode V) for memory exposure and the sensitivity scanner (P4-12 task 2): `channelSwitches`, `readRights`,
// `canCapture` (private in TypeScript: observed as the `capture` of `resolveExposure` with every switch on and no override) and
// `resolveExposure`; the five scanner classifiers, `computeContentHash`; `sensitivityRefusal` and `filterSensitiveBlocks` over a
// stub service; the local-only functions (`localOnlyFor`, `isLocalModel`, `isLocalChatModel`, `localOnlyFindings`,
// `localOnlyCheck`). `crates/plur1bus-core/src/exposure/vectors.rs` replays every file. Recorded, never edited by hand.
//
// GRIDS (counts in `index`). Full product within each layer; layers are not multiplied into each other:
//   resolve-principals  role(5) x kind(person, agent, absent) x agent right(none, use, manage) x token scopes(11) x token variant(6)
//                       = 2970, default configuration (every switch on, no override): what the RBAC table gives, `canCapture` included.
//   resolve-switches    for `collab`: the four switches (recall.workspace, recall.user, recall.agentPrivate, capture) each unset/true/false
//                       (81) x 24 principals (role{owner,member} x kind{person,agent} x right{none,use,manage} x token{none,bound});
//                       SAMPLED for `mcp` and `a2a`: the same 81 switch sets x 4 principals, because the channel is only the key of
//                       the defaults table and of the configuration lookup (`channel` is covered in full by `switches`).
//   resolve-overrides   the token binding's memory override: for an owner person with a bound token the full product disclose(unset,
//                       agent-decides, never) x recall.{workspace,user,agentPrivate}(unset/true/false: 27) x capture(3) x groups(5)
//                       = 1215; SAMPLED for two more principals (member person, owner agent with a bound token): disclose x capture x
//                       groups with recall unset = 45 each. `collab` only (the channel is not read here).
//   switches            channelSwitches: channel(3) x the four switches (81) x four configuration shapes (the agent configured, an
//                       unlisted agent, only another agent configured, an own `__proto__` agent entry) = 972.
// A packed file is `{fields, tables, cases}`: `tables[field]` lists the distinct JSON texts of that argument in order of first use,
// a case is one line `name TAB refs TAB expected`, `refs` one table index per field joined by "." ("-" for an absent argument).
//
//   node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning scripts/parity/export-exposure.ts [--check]
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CHANNEL_DEFAULTS, channelSwitches } from "../../packages/core/src/memory-exposure/config.ts";
import { readRights, resolveExposure } from "../../packages/core/src/memory-exposure/resolve.ts";
import { filterSensitiveBlocks, sensitivityRefusal } from "../../packages/core/src/memory-exposure/sensitivity.ts";
import { SensitivityScanner, computeContentHash } from "../../packages/core/src/memory-sensitivity/scanner.ts";
import { createRedactor } from "../../packages/core/src/logs/redact.ts";
import { isLocalChatModel, isLocalModel, localOnlyFor } from "../../packages/core/src/privacy/local-only.ts";
import { localOnlyCheck, localOnlyFindings } from "../../packages/core/src/privacy/doctor.ts";
import { exporterMain } from "./lib.mjs";

type Desc = any;
type Case = { name: string; desc: Record<string, unknown>; expected: string };
const seen = new Set<string>();
function mk(name: string, desc: Record<string, unknown>, expected: string): Case {
  if (seen.has(name)) throw new Error(`duplicate case name ${name}`);
  seen.add(name);
  if (name.includes("\t")) throw new Error("tab in a case name");
  return { name, desc, expected };
}
function pack(fields: string[], cases: Case[], extra: Record<string, unknown> = {}) {
  const tables: Record<string, string[]> = {}; const index: Record<string, Map<string, number>> = {};
  for (const f of fields) { tables[f] = []; index[f] = new Map(); }
  const lines = cases.map((c) => {
    const ref = fields.map((f) => {
      if (!(f in c.desc)) return "-";
      const text = JSON.stringify(c.desc[f]);
      let i = index[f]!.get(text);
      if (i === undefined) { i = tables[f]!.length; tables[f]!.push(text); index[f]!.set(text, i); }
      return String(i);
    });
    for (const k of Object.keys(c.desc)) if (!fields.includes(k)) throw new Error(`${c.name}: unpacked field ${k}`);
    return `${c.name === "" ? "" : `${c.name}\t`}${ref.join(".")}\t${c.expected}`;
  });
  return { fields, tables, cases: lines, ...extra };
}
export const codec = (s: string): unknown => (s.isWellFormed() ? s : { u16: Array.from({ length: s.length }, (_, i) => s.charCodeAt(i)) });
const tf = (b: boolean) => (b ? "T" : "F");
const bits3 = (a: { workspace: boolean; user: boolean; agentPrivate: boolean }) => tf(a.workspace) + tf(a.user) + tf(a.agentPrivate);
const sw4 = (s: { recall: { workspace: boolean; user: boolean; agentPrivate: boolean }; capture: boolean }) => bits3(s.recall) + tf(s.capture);

// --- configuration and principals --------------------------------------------------------------------------------------------
// The resolve files are stored as dimensions (role, kind, ...), not as the objects: the fixture header holds the one table that needs
// a definition (`scopes`), and `crates/plur1bus-core/src/exposure/vectors.rs` builds the principal and the configuration from the
// dimensions with a builder that mirrors `mkPrincipal` / `exposureConfig` below. A case line is `refs TAB expected`; its name is
// rebuilt from the dimensions when a case fails.
const AG = "a1", OTHER_AG = "a2", SELF = "u-self";
const CHANNELS = ["collab", "mcp", "a2a"] as const;
type Tri = "unset" | true | false;
const TRI: Tri[] = ["unset", true, false];
const triLabel = (t: Tri) => (t === "unset" ? "-" : t ? "T" : "F");
const triOf = (c: string): Tri => (c === "-" ? "unset" : c === "T");
/** The configuration of one agent for one channel from a switch string `wupc` (each `-`, `T` or `F`; the order is recall.workspace, recall.user, recall.agentPrivate, capture). */
function exposureConfig(channel: string, sw: string, agent = AG): Desc {
  const [w, u, p, c] = [...sw].map(triOf) as [Tri, Tri, Tri, Tri];
  const recall: any = {};
  if (w !== "unset") recall.workspace = w; if (u !== "unset") recall.user = u; if (p !== "unset") recall.agentPrivate = p;
  const entry: any = {};
  if (Object.keys(recall).length) entry.recall = recall;
  if (c !== "unset") entry.capture = c;
  return { agents: { [agent]: { memoryExposure: { [channel]: entry } } } };
}
const DEFAULT_CONFIG: Desc = { agents: {} };

type Variant = "none" | "tid-only" | "binding-only" | "bound" | "other-agent" | "empty-tid";
const VARIANTS: Variant[] = ["none", "tid-only", "binding-only", "bound", "other-agent", "empty-tid"];
const SCOPE_SETS: Record<string, string[] | null> = {
  absent: null, empty: [], "ws-read": ["memory.workspace.read"], "user-read": ["memory.user.read"], "priv-read": ["memory.agent-private.read"],
  "ws-write": ["memory.workspace.write"], "user-write": ["memory.user.write"], "priv-write": ["memory.agent-private.write"], "memory-star": ["memory.*"], star: ["*"], other: ["chat:read"],
};
const MEMORY_BASES: Record<string, { role: string; kind: string; right: string }> = {
  "owner-person": { role: "owner", kind: "person", right: "manage" }, "member-person": { role: "member", kind: "person", right: "use" }, "owner-agent": { role: "owner", kind: "agent", right: "manage" },
};
/** `groups` dimension: `-` (undefined) or the list joined by `+` (`none` is the empty list). */
const GROUPS: Record<string, string[] | undefined> = { "-": undefined, memory: ["memory"], none: [], other: ["other"], "memory+other": ["memory", "other"] };
function mkPrincipal(o: { role: string; kind?: string; right?: string; scopes?: string[] | null; variant?: Variant; groups?: string[]; memory?: Desc }): Desc {
  const p: any = { userId: SELF, role: o.role };
  if (o.kind) p.kind = o.kind;
  if (o.right && o.right !== "none") p.agentRights = { [AG]: o.right };
  if (o.scopes) p.tokenScopes = o.scopes;
  const v = o.variant ?? "none";
  if (v === "tid-only" || v === "bound" || v === "other-agent") p.tokenId = "tok-1";
  if (v === "empty-tid") p.tokenId = "";
  if (v === "binding-only" || v === "bound" || v === "other-agent" || v === "empty-tid" || o.groups || o.memory) {
    p.binding = { audience: "mcp", agentId: v === "other-agent" ? OTHER_AG : AG, ...(o.groups ? { groups: o.groups } : {}), ...(o.memory ? { memory: o.memory } : {}) };
    if (o.groups || o.memory) { if (!p.tokenId) p.tokenId = "tok-1"; }
  }
  return p;
}
const exposureText = (e: any) => `${bits3(e.rights)}${bits3(e.recall)}${tf(e.capture)}${sw4(e.switches)}`;
function resolveText(channel: string, principal: Desc | undefined, config: Desc): string {
  const e = resolveExposure({ channel: channel as any, agentId: AG, principal, config });
  if (principal !== undefined) { const r = readRights(principal, AG); if (JSON.stringify(r) !== JSON.stringify(e.rights)) throw new Error("rights differ"); }
  return exposureText(e);
}
let dimSeen = new Set<string>();
const dim = (file: string, d: Record<string, unknown>, expected: string): Case => {
  const key = file + JSON.stringify(d);
  if (dimSeen.has(key)) throw new Error(`duplicate case ${key}`);
  dimSeen.add(key);
  return { name: "", desc: d, expected };
};

function buildResolve() {
  dimSeen = new Set();
  const principals: Case[] = [];
  for (const role of ["owner", "admin", "operator", "member", "viewer"]) for (const kind of ["person", "agent", "-"]) for (const right of ["none", "use", "manage"]) for (const sl of Object.keys(SCOPE_SETS)) for (const v of VARIANTS)
    principals.push(dim("p", { role, kind, right, scopes: sl, variant: v }, resolveText("collab", mkPrincipal({ role, kind: kind === "-" ? undefined : kind, right, scopes: SCOPE_SETS[sl], variant: v }), DEFAULT_CONFIG)));
  principals.push(dim("p", { role: "-", kind: "-", right: "-", scopes: "absent", variant: "no-principal" }, resolveText("collab", undefined, DEFAULT_CONFIG)));
  const switches: Case[] = [];
  const P24: Record<string, string>[] = [];
  for (const role of ["owner", "member"]) for (const kind of ["person", "agent"]) for (const right of ["none", "use", "manage"]) for (const variant of ["none", "bound"]) P24.push({ role, kind, right, variant });
  const P4: Record<string, string>[] = [{ role: "owner", kind: "person", right: "manage", variant: "none" }, { role: "member", kind: "person", right: "use", variant: "none" }, { role: "viewer", kind: "person", right: "none", variant: "none" }, { role: "owner", kind: "agent", right: "manage", variant: "bound" }];
  for (const channel of CHANNELS) for (const w of TRI) for (const u of TRI) for (const p of TRI) for (const c of TRI) for (const pr of channel === "collab" ? P24 : P4) {
    const sw = [w, u, p, c].map(triLabel).join("");
    switches.push(dim("s", { channel, sw, ...pr }, resolveText(channel, mkPrincipal({ role: pr.role!, kind: pr.kind, right: pr.right, variant: pr.variant as Variant }), exposureConfig(channel, sw))));
  }
  const overrides: Case[] = [];
  const mem = (d: string, rc: string, c: string): Desc | undefined => {
    const [w, u, p] = [...rc].map(triOf) as [Tri, Tri, Tri];
    const m: any = {}; const recall: any = {};
    if (w !== "unset") recall.workspace = w; if (u !== "unset") recall.user = u; if (p !== "unset") recall.agentPrivate = p;
    if (Object.keys(recall).length) m.recall = recall; if (d !== "-") m.disclose = d; if (c !== "-") m.capture = c === "T";
    return Object.keys(m).length ? m : undefined;
  };
  for (const [base, full] of [["owner-person", true], ["member-person", false], ["owner-agent", false]] as [string, boolean][]) for (const d of ["-", "agent-decides", "never"]) for (const g of Object.keys(GROUPS)) for (const c of ["-", "T", "F"])
    for (const rc of full ? TRI.flatMap((w) => TRI.flatMap((u) => TRI.map((p) => [w, u, p].map(triLabel).join("")))) : ["---"]) {
      const b = MEMORY_BASES[base]!;
      overrides.push(dim("o", { base, disclose: d, recall: rc, capture: c, groups: g }, resolveText("collab", mkPrincipal({ ...b, variant: "bound", groups: GROUPS[g], memory: mem(d, rc, c) }), DEFAULT_CONFIG)));
    }
  const sw: Case[] = [];
  const shapes: Record<string, string> = { configured: AG, "unlisted-agent": AG, "other-channel-only": AG, "proto-agent": "__proto__" };
  const configOf = (shape: string, channel: string, s: string): Desc => {
    if (shape === "configured") return exposureConfig(channel, s);
    if (shape === "unlisted-agent") return exposureConfig(channel, s, "someone-else");
    if (shape === "other-channel-only") return exposureConfig(CHANNELS.find((x) => x !== channel)!, s);
    return JSON.parse(`{"agents":{"__proto__":${JSON.stringify(exposureConfig(channel, s).agents[AG])}}}`);
  };
  for (const channel of CHANNELS) for (const shape of Object.keys(shapes)) for (const w of TRI) for (const u of TRI) for (const p of TRI) for (const c of TRI) {
    const s = [w, u, p, c].map(triLabel).join("");
    sw.push(dim("w", { channel, shape, sw: s }, sw4(channelSwitches(configOf(shape, channel, s), shapes[shape]!, channel as any))));
  }
  sw.push(dim("w", { channel: "mcp", shape: "constructor-agent", sw: "----" }, sw4(channelSwitches({ agents: {} } as any, "constructor", "mcp"))));
  sw.push(dim("w", { channel: "a2a", shape: "empty-agent-id", sw: "---F" }, sw4(channelSwitches({ agents: { "": { memoryExposure: { a2a: { capture: false } } } } } as any, "", "a2a"))));
  for (const c of CHANNELS) if (JSON.stringify(CHANNEL_DEFAULTS[c]) !== JSON.stringify({ recall: { workspace: true, user: true, agentPrivate: true }, capture: true })) throw new Error("defaults changed");
  return { "resolve-principals": principals, "resolve-overrides": overrides, "resolve-switches": switches, switches: sw };
}

// --- the scanner -------------------------------------------------------------------------------------------------------------------
const SCANNER_SRC = readFileSync(fileURLToPath(new URL("../../packages/core/src/memory-sensitivity/scanner.ts", import.meta.url)), "utf8");
/** The source text of the regular expression literal assigned to `name` (the text between the slashes, without flags). */
function literalOf(name: string): { src: string; flags: string } {
  const m = new RegExp(`const ${name}\\s*=\\s*\\n?\\s*/(.+)/([a-z]*);`).exec(SCANNER_SRC);
  if (!m) throw new Error(`pattern ${name} not found in scanner.ts`);
  return { src: m[1]!, flags: m[2]! };
}
/** Expands the keyword alternation of a pattern `\b(?:a|b(?:c|d)?|e\s*f)\b` into its literal variants (`\s*` becomes one space). */
function expandKeywords(src: string): string[] {
  const body = /^\\b\(\?:(.*)\)\\b$/.exec(src)?.[1];
  if (body === undefined) throw new Error(`not a keyword alternation: ${src}`);
  let i = 0;
  const parseAlt = (stop: string): string[] => {
    const out: string[] = []; let cur: string[] = [""];
    const flush = () => { out.push(...cur); cur = [""]; };
    while (i < body.length && !stop.includes(body[i]!)) {
      if (body[i] === "|") { i++; flush(); continue; }
      let options: string[];
      if (body.startsWith("(?:", i)) { i += 3; options = parseAlt(")"); i++; }
      else if (body[i] === "[") { const end = body.indexOf("]", i); options = [...body.slice(i + 1, end)]; i = end + 1; }
      else if (body.startsWith("\\s*", i)) { options = [" "]; i += 3; }
      else if (body[i] === "\\") { throw new Error(`unsupported escape at ${i} in ${body}`); }
      else { options = [body[i]!]; i++; }
      if (body[i] === "?") { options = ["", ...options]; i++; }
      cur = cur.flatMap((c) => options.map((o) => c + o));
    }
    flush();
    return out;
  };
  const variants = parseAlt("");
  if (i !== body.length) throw new Error("parse stopped early");
  return variants;
}
const PATTERNS = { health: "HEALTH_RE", financial: "FINANCIAL_KEYWORDS_RE", identity: "IDENTITY_RE", personal: "PERSONAL_RE" } as const;
const KEYWORDS: Record<string, string[]> = {};
for (const [cat, name] of Object.entries(PATTERNS)) {
  const { src, flags } = literalOf(name);
  if (flags !== "i") throw new Error(`${name} flags ${flags}`);
  const vs = expandKeywords(src);
  const re = new RegExp(src, flags);
  for (const v of vs) if (!re.test(v) && !re.test(`x${v}`)) throw new Error(`variant ${JSON.stringify(v)} of ${name} does not match`);
  KEYWORDS[cat] = vs;
}
const OTHER_PATTERNS = ["IBAN_RE", "CARD_RE"].map((n) => ({ name: n, ...literalOf(n) }));

const scanner = new SensitivityScanner();
const redactor = createRedactor();
// The two halves of the credential branch, recomputed here from the same sources `scan` uses, so a fixture line says which half fired.
const TOKEN_RE = /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{36,}|Bearer\s+\S+)\b/i;
if (!SCANNER_SRC.includes(String.raw`/\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{36,}|Bearer\s+\S+)\b/i`)) throw new Error("the token pattern of scanner.ts changed: update TOKEN_RE");
function viaRedactor(combined: string): boolean {
  const r = redactor.text(combined);
  return r.includes("[REDACTED:key]") || r.includes("[REDACTED:pattern]") || r.includes("[REDACTED:secret]") || r.includes("<deny:");
}
interface Line { text: string; summary?: string }
const corpus: Line[] = [];
const addLine = (text: string, summary?: string) => { corpus.push(summary === undefined ? { text } : { text, summary }); };
const WS_KINDS = ["", " ", "\t", "\n", "\r\n", "\u00a0", "\u2028", "\ufeff", "\u3000", "\u2003", "\u200b", "\u0085", "\u180e", "  \t "];
const fill = (kw: string, ws = " ") => kw.replaceAll(" ", ws);
const mixed = (s: string) => [...s].map((c, i) => (i % 2 ? c.toLowerCase() : c.toUpperCase())).join("");
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
for (const [cat, vs] of Object.entries(KEYWORDS)) for (const kw of vs) {
  const k = fill(kw);
  addLine(k);                                  // keyword is the whole text (start and end of text)
  addLine(k.toUpperCase()); addLine(capital(k)); addLine(mixed(k));
  addLine(`about ${k} today`);                 // inside a sentence
  addLine("", k); addLine(k, ""); addLine("note", k); addLine(k, "note");   // text and summary
  addLine(`1${k}`); addLine(`${k}1`); addLine(`_${k}`); addLine(`${k}_`);   // glued to a digit and an underscore (word characters)
  addLine(`ü${k}`); addLine(`${k}ü`); addLine(`ß${k}`); addLine(`${k}é`); addLine(`é${k}`); addLine(`${k}-x`); addLine(`${k}.`); // non-word neighbours
  addLine(`x${k}`); addLine(`${k}x`);          // letters glued on
  addLine(k.slice(0, -1)); addLine(k.slice(1));  // near misses: one letter short on either side
  if (/[äöüß]/.test(k)) { addLine(k.replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")); addLine(k.replace(/ä/g, "a").replace(/ö/g, "o").replace(/ü/g, "u")); addLine(k.toUpperCase().replace("ß", "ẞ")); }
  void cat;
}
for (const [cat, vs] of Object.entries(KEYWORDS)) for (const kw of vs) if (kw.includes(" ")) {
  for (const ws of WS_KINDS) addLine(`x ${fill(kw, ws)} y`);
  const [a, ...rest] = kw.split(" "); const b = rest.join(" ");
  addLine(a!, b); addLine(`${a} `, b); addLine(a!, ` ${b}`); addLine(`${a}\n`, b);   // split across text and summary: the "\n" of the join is `\s*`
  void cat;
}
// Keywords with a capital Ü or a Kelvin sign, the long s, dotless i: only ASCII case folding and ü/Ü apply.
for (const t of ["ÜBERWEISUNG", "xÜBERWEISUNG", "x Überweisung", "überweisung", "xüberweisung", "Führerschein", "FÜHRERSCHEIN", "führerschein", "f\u00dcrerschein", "\u212arankheit", "krankheit", "KRANKHEIT", "ſalary", "salary", "SALARY", "sa\u1e9eary", "ıban", "İBAN", "IBAN", "iban", "straße", "Strasse", "weiß", "ssn", "SSN", "ſsn", "S\u017fN", "religıon", "RELIGION", "relıgion", "pAsSpOrT", "sociaL\tsecuritY", "tax\u00a0id", "tax\u200bid", "tax\u2028id", "drıver's license", "Driver’s license", "driver's license", "drivers license", "DRIVER'S\u3000LICENSE"]) addLine(t);
// IBAN shapes
for (const t of ["DE89370400440532013000", "DE89 3704 0044 0532 0130 00", "de89 3704 0044 0532 0130 00", "GB29NWBK60161331926819", "GB29 NWBK 6016 1331 9268 19", "AB12 1234 5678", "AB12 1234 567", "AB121234", "AB12 1234", "AB12 1234 5678 9", "AB12123456789012345678901234567890", "xxDE89370400440532013000yy", "A112 1234 5678", "AB1 1234 5678", "ab12 abcd ABCD", "AB12-1234-5678", "AB12\t1234\t5678", "AB12  1234 5678", "AB12 123 4567 8", "ſB12 1234 5678", "\u212aB12 1234 5678", "ÄB12 1234 5678", "AB１２ 1234 5678", "AB12 1234 5678\n", "see AB12 1234 5678 for details", "AB12 ÄÄÄÄ 5678", "ZZ00 0000 0000 0000 0000 0000 0000 0000 0000 000", "AB12 1234 5678", "AB12 12345 678"]) addLine(t);
// card shapes: Visa, Mastercard, Mastercard 2-series, Amex, Discover, groups of four
for (const t of ["4111111111111111", "4111 1111 1111 1111", "4111-1111-1111-1111", "4111 1111 1111 1111 123", "4111111111111", "411111111111111", "4111 1111 1111 111", "4 111 1111 1111 1111",
  "5500000000000004", "5500 0000 0000 0004", "5100 0000 0000 0000", "5000 0000 0000 0000", "5600 0000 0000 0000", "5500-0000-0000-0004",
  "2221000000000009", "2720 0000 0000 0000", "2221 0000 0000 0009", "2800 0000 0000 0000", "2100 0000 0000 0000",
  "378282246310005", "3782 822463 10005", "3782-822463-10005", "3782 822463 1000", "340000000000009", "370000000000002", "380000000000000", "3782822463100", "3782 82246 310005",
  "6011111111111117", "6011 1111 1111 1117", "6500 0000 0000 0002", "6511 1111 1111 1111", "6600 0000 0000 0000", "6011 1111 1111 111",
  "1234 5678 9012 3456", "1234-5678-9012-3456", "1234 5678-9012 3456", "1234 5678 9012 345", "1234  5678 9012 3456", "1234 5678 9012", "1234 1234 1234 1234 1234", "9999 9999 9999 9999",
  "order 4111111111111111 shipped", "x4111111111111111", "4111111111111111x", "１２３４ 5678 9012 3456", "1234 5678 9012 3456".replaceAll(" ", "\u00a0"), "00004111111111111111", "4111 1111 1111 1111 12", "card: 5500 0000 0000 0004."]) addLine(t);
// credentials: the redactor's rules, the token expression, and what neither sees
const T20 = "a".repeat(20), T19 = "a".repeat(19), G36 = "a1".repeat(18), G35 = G36.slice(1);
for (const t of ["password=hunter2", "password: hunter2", "\"password\": \"hunter2\"", "api_key=abc123", "API_KEY: abc", "token=abc", "access_token=abc", "id_token_hint=abc", "refresh=abc", "secret=x", "client_secret: x", "authorization: Bearer abc.def", "Authorization: Basic dXNlcjpwYXNz", "Cookie: a=b; c=d", "Set-Cookie: sid=abc; Path=/", "credential=abc", "credential: \"abc\"",
  "input_tokens=5", "max_tokens: 100", "outputTokens=3", "tokenizer=bpe", "my_token_count=2", "passwordless", "the password is hunter2", "ask for a password", "tokens: 1,2,3",
  "AKIAIOSFODNN7EXAMPLE", "AKIAIOSFODNN7EXAMPL", "ghp_" + "A".repeat(36), "gho_" + "b".repeat(36), "github_pat_" + "a".repeat(22), "xoxb-1234567890-abcdef", "AIza" + "a".repeat(35), "ek_" + "a".repeat(16), "123456789:" + "a".repeat(20),
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk", "PLUR1BUS_TOKEN=abc123", "Basic dXNlcjpwYXNzd29yZA==", "Basic abc",
  "a".repeat(42), "a".repeat(43), "a".repeat(44), "a-".repeat(21), "a-".repeat(22), "word ".repeat(30), "This is a normal sentence.", "version 1.2.3", "id 1234567890123456789012345678901234567890123",
  "see ~/.ssh/id_rsa", "/home/u/.ssh/config", "C:\\Users\\u\\.aws\\credentials", "~/.gnupg/pubring.kbx", "cat .env", "cat .env.local", "/Users/u/Library/Keychains/login.keychain", "/etc/hosts", "/home/u/docs/readme.md", "~/.config/gcloud/creds.db", ".npmrc",
  "https://user:pw@example.com/path", "https://example.com/path?token=abc", "https://api.telegram.org/bot123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11/getMe", "https://example.com/",
  "Bearer abc", "bearer abc", "BEARER abc", "Bearer\tabc", "Bearer \n abc", "Bearer  \u00a0abc", "Bearer", "Bearer ", "Bearer\n", "Bearer !!!", "Bearer abc!!!", "Bearer !abc", "Bearer a.b", "Bearer \u00e9\u00e9", "Bearer é1", "xBearer abc", "_Bearer abc", "1Bearer abc", "éBearer abc", "Bearer_ abc", "Bearer: abc", "Bearer\u200babc", "Bearer \ud83d\ude00", "Bearer x\ud83d\ude00", "Bearer abc,def", "Bearer \"quoted token\"", "Bearer 'single'",
  "sk-" + T20, "sk-" + T19, "SK-" + T20, "sk-ant-" + T20, "sk-ant-" + T19, "sk-proj-" + T20, "sk-proj-" + "a".repeat(15), "sk-" + T20 + "-", "sk-" + T20 + "!", "sk-" + T20 + "é", "sk-" + T20 + "_", "sk-" + T19 + "!", "sk-" + T19 + "-", "sk-" + "-".repeat(20), "sk-" + "-".repeat(19), "sk-" + "_".repeat(20), "sk-" + "_".repeat(25) + "!", "sk-" + "a".repeat(19) + "-" + "a".repeat(5),
  "xsk-" + T20, "_sk-" + T20, "1sk-" + T20, "ésk-" + T20, "-sk-" + T20, "(sk-" + T20 + ")", "sk-ant-api03-" + "a".repeat(30), "ſk-" + T20, "\u212a-" + T20, "sk\u2010" + T20,
  "ghp_" + G36, "ghp_" + G35, "GHP_" + G36, "ghp_" + G36 + "_", "ghp_" + G36 + "-", "ghp_" + G36 + "é", "ghp_" + G36 + "_x", "ghp_" + "a".repeat(40), "xghp_" + G36, "_ghp_" + G36, "ghp-" + G36, "ghp_" + G36.slice(0, 20) + "-" + G36.slice(20),
  "ghp_" + G36 + "\n", "token ghp_" + G36 + " end", "ghp_" + "é".repeat(36)]) addLine(t);
// categories together: every subset of one keyword per category, in two orders (the result is sorted, not in detection order)
const REP: [string, string][] = [["health", "doctor"], ["financial", "salary"], ["credential", "password=x"], ["identity", "passport"], ["personal", "religion"]];
for (let mask = 1; mask < 32; mask++) {
  const parts = REP.filter((_, i) => mask & (1 << i)).map(([, k]) => k);
  addLine(parts.join(" and ")); addLine(parts.slice().reverse().join(" and ")); if (mask % 3 === 0) addLine(parts[0]!, parts.slice(1).join(" "));
}
// shape, size and the empty text
addLine(""); addLine("", ""); addLine(" "); addLine("\n"); addLine("\n\n", "\n"); addLine("   ", "   "); addLine("ordinary text without anything of note"); addLine("Zahlung per Überweisung an Konto"); addLine("Gehalt\nüberweisung"); addLine("ÜBERWEISUNG"); addLine("x".repeat(10)); addLine("a ".repeat(5000)); addLine(" ".repeat(10000));
addLine("a".repeat(10000)); addLine("a".repeat(9990) + " doctor"); addLine("doctor " + "b".repeat(9993)); addLine("word ".repeat(2000)); addLine("1234 ".repeat(2000)); addLine("Bearer " + "z".repeat(9993)); addLine("sk-" + "a".repeat(9997)); addLine("ab12 ".repeat(2000)); addLine("1".repeat(10000)); addLine("é".repeat(10000)); addLine("password=" + "x".repeat(9990));
addLine("x".repeat(5000) + "iban" + "y".repeat(5000)); addLine("x ".repeat(4990) + "blood \t\n pressure"); addLine("\u00a0".repeat(10000) + "krebs");
addLine("😀 doctor 😀"); addLine("😀doctor😀"); addLine("\ud83ddoctor"); addLine("doctor\ude00"); addLine("\ud83d", "\ude00"); addLine("blood\ud83d pressure"); addLine("ba\ud83dnk account"); addLine("Bearer \ud83d"); addLine("sk-" + T20 + "\ud83d"); addLine("e\u0301 doctor"); addLine("doctor\u0301"); addLine("é".normalize("NFD") + "doctor"); addLine("doctor", "\u200b"); addLine("\u200bdoctor\u200b"); addLine("\ufeffdoctor\ufeff"); addLine("doctor\u2028", "religion\u2029");

function buildScanner() {
  const lines = corpus.map((l, i) => {
    const text = l.text, summary = l.summary;
    const combined = `${text ?? ""}\n${summary ?? ""}`;
    const cats = scanner.scan(text, summary);
    const tok = TOKEN_RE.test(combined), red = viaRedactor(combined);
    const tag = `${red ? "R" : "-"}${tok ? "T" : "-"}`;
    return mk(`line ${i}`, { text: codec(text), ...(summary === undefined ? {} : { summary: codec(summary) }) }, `${cats.join(",") || "-"}/${tag}`);
  });
  return lines;
}

// --- computeContentHash ----------------------------------------------------------------------------------------------------------------
const SPACE_KINDS = ["\t", "\n", "\v", "\f", "\r", " ", " ", " ", ...Array.from({ length: 11 }, (_, i) => String.fromCharCode(0x2000 + i)), " ", " ", " ", " ", "　", "﻿"];
function buildHashes() {
  const cases: Case[] = [];
  const add = (name: string, text: string, summary?: string) => cases.push(mk(`hash ${name}`, { text: codec(text), ...(summary === undefined ? {} : { summary: codec(summary) }) }, computeContentHash(text, summary)));
  add("empty", ""); add("empty with empty summary", "", ""); add("abc", "abc"); add("abc summary", "abc", "def");
  for (const [i, ws] of SPACE_KINDS.entries()) { add(`text padded by space kind ${i}`, `${ws}abc${ws}`); add(`summary padded by space kind ${i}`, "abc", `${ws}def${ws}`); add(`only space kind ${i}`, ws, ws); }
  for (const ws of ["​", "\u0085", "᠎", "⁠", "­", "\u0000"]) add(`not trimmed ${JSON.stringify(ws)}`, `${ws}abc${ws}`, `${ws}d${ws}`);
  add("inner whitespace kept", "a  b\tc\n d", "e \n f"); add("newline inside text", "a\nb"); add("text and summary swap", "d", "abc"); add("summary is the newline join", "a", "b"); add("text holds the join", "a\nb");
  add("summary undefined equals empty", "abc"); add("summary whitespace only", "abc", "  \n "); add("trailing newline in text", "abc\n"); add("crlf", "abc\r\n", "x\r\n");
  add("NFC", "é".normalize("NFC")); add("NFD", "é".normalize("NFD")); add("NFC sentence", "Café Müller".normalize("NFC")); add("NFD sentence", "Café Müller".normalize("NFD")); add("Hangul NFC", "한글".normalize("NFC")); add("Hangul NFD", "한글".normalize("NFD"));
  add("astral", "😀 x 😀"); add("lone high surrogate", "a\ud83d"); add("lone low surrogate", "\ude00a"); add("lone high then low in summary", "a", "\ud83d"); add("swapped surrogates", "\ude00\ud83d"); add("lone surrogate at both ends", "\ud83dx\ude00");
  add("lone surrogate vs replacement char", "a�"); add("lone surrogate padded", " \ud83d "); add("long", "x".repeat(10000), "y".repeat(10000)); add("long whitespace", " ".repeat(10000) + "x" + " ".repeat(10000));
  add("umlauts", "Überweisung für ÄÖÜß"); add("nul", "a\u0000b"); add("key", "password=x");
  return cases;
}

// --- sensitivityRefusal and filterSensitiveBlocks over a stub ------------------------------------------------------------------------------
type Manual = "never" | "always" | "after-assess" | "throws" | "throws-second";
type Assess = { table: Record<string, string[]> } | "throws" | { throwsOn: string; table: Record<string, string[]> };
interface StubDesc { manual: Manual; assess: Assess }
function makeStub(d: StubDesc | null | "undefined"): any {
  if (d === null) return null; if (d === "undefined") return undefined;
  let assessed = 0, manualCalls = 0;
  return {
    hasManualCategories(_filter: readonly string[]) {
      manualCalls++;
      switch (d.manual) {
        case "never": return false; case "always": return true; case "after-assess": return assessed > 0;
        case "throws": throw new Error("manual failed"); case "throws-second": if (manualCalls > 1) throw new Error("manual failed again"); return false;
      }
    },
    async assessAggregate(text: string) {
      assessed++;
      if (d.assess === "throws") throw new Error("assess failed");
      if ("throwsOn" in d.assess && text === d.assess.throwsOn) throw new Error("assess failed on one block");
      return (d.assess as any).table[text] ?? [];
    },
  };
}
async function buildSensitivity() {
  const filters: string[][] = [[], ["health"], ["health", "financial"], ["credential"], ["personal", "identity"]];
  const table = { "doc text": ["health"], "money text": ["financial"], "both text": ["health", "financial"], "key text": ["credential"], "plain text": [], "id text": ["identity"], "odd text": ["unknown-category"] };
  const services: [string, StubDesc | null | "undefined"][] = [
    ["null", null], ["undefined", "undefined"],
    ["manual-never", { manual: "never", assess: { table } }], ["manual-always", { manual: "always", assess: { table } }], ["manual-after-assess", { manual: "after-assess", assess: { table } }],
    ["manual-throws", { manual: "throws", assess: { table } }], ["manual-throws-second", { manual: "throws-second", assess: { table } }],
    ["assess-throws", { manual: "never", assess: "throws" }], ["assess-throws-on-one", { manual: "never", assess: { throwsOn: "key text", table } }],
  ];
  const blockSets: [string, { name: string; text: string }[]][] = [
    ["none", []], ["plain", [{ name: "p1", text: "plain text" }, { name: "p2", text: "unclassified" }]],
    ["mixed", [{ name: "b1", text: "doc text" }, { name: "b2", text: "plain text" }, { name: "b3", text: "money text" }, { name: "b4", text: "both text" }, { name: "b5", text: "key text" }, { name: "b6", text: "id text" }, { name: "b7", text: "odd text" }]],
    ["order", [{ name: "z", text: "plain text" }, { name: "a", text: "plain text" }, { name: "m", text: "id text" }, { name: "b", text: "plain text" }]],
  ];
  const refusal: Case[] = [], filter: Case[] = [];
  for (const [sl, sd] of services) for (const f of filters) {
    let exp: string;
    try { exp = sensitivityRefusal(f, makeStub(sd)) ?? "none"; } catch (e) { exp = `throws/${(e as Error).message}`; }
    refusal.push(mk(`refusal | ${sl} | filter ${f.join("+") || "empty"}`, { filter: f, service: sd }, exp));
    for (const [bl, blocks] of blockSets) {
      try { exp = `kept/${(await filterSensitiveBlocks(blocks, f, makeStub(sd))).map((b) => b.name).join(",")}`; } catch (e) { exp = `throws/${(e as Error).message}`; }
      filter.push(mk(`filter | ${sl} | filter ${f.join("+") || "empty"} | blocks ${bl}`, { filter: f, service: sd, blocks }, exp));
    }
  }
  return { refusal, filter };
}

// --- local-only ----------------------------------------------------------------------------------------------------------------------------
const URLS: [string, unknown][] = [["loopback-ip", "http://127.0.0.1:11434/v1"], ["localhost", "http://localhost:8080"], ["ipv6", "http://[::1]:1234/v1"], ["https-local", "https://localhost"], ["127-other", "http://127.5.5.5"], ["cloud", "https://api.openai.com/v1"], ["lan", "http://192.168.1.20:11434"],
  ["spoof", "http://127.0.0.1.evil.com"], ["userinfo", "http://user:pw@127.0.0.1"], ["not-url", "not a url"], ["empty", ""], ["ftp", "ftp://localhost"], ["number", 5], ["null", null], ["upper", "HTTP://LOCALHOST:1"], ["trailing-dot", "http://localhost./"], ["decimal-ip", "http://2130706433"], ["octal-ish", "http://0x7f.0.0.1"], ["short-ip", "http://127.1"], ["lan-listed", "http://192.168.1.20:11434/v1"], ["lan-other-port", "http://192.168.1.20:8080"]];
function buildLocalOnly() {
  const cases: Case[] = [];
  const cfgs: [string, unknown][] = [["empty", {}], ["null", null], ["string", "cfg"], ["number", 5], ["array", []], ["on", { privacy: { localOnly: true } }], ["off", { privacy: { localOnly: false } }], ["string-true", { privacy: { localOnly: "true" } }], ["one", { privacy: { localOnly: 1 } }], ["null-switch", { privacy: { localOnly: null } }], ["privacy-string", { privacy: "on" }],
    ["agent-on", { agents: { alice: { privacy: { localOnly: true } } } }], ["agent-off-under-on", { privacy: { localOnly: true }, agents: { alice: { privacy: { localOnly: false } } } }], ["agent-off", { agents: { alice: { privacy: { localOnly: false } } } }], ["agent-string", { privacy: { localOnly: true }, agents: { alice: { privacy: { localOnly: "false" } } } }],
    ["agent-null-entry", { privacy: { localOnly: true }, agents: { alice: null } }], ["agent-empty", { privacy: { localOnly: true }, agents: { alice: {} } }], ["agent-privacy-null", { agents: { alice: { privacy: null } } }], ["agents-array", { privacy: { localOnly: true }, agents: [{ privacy: { localOnly: false } }, { privacy: { localOnly: true } }] }], ["agents-string", { privacy: { localOnly: true }, agents: "alice" }],
    ["two-agents", { privacy: { localOnly: false }, agents: { alice: { privacy: { localOnly: true } }, bob: { privacy: { localOnly: false } }, carol: {} } }], ["own-proto-agent", JSON.parse('{"privacy":{"localOnly":false},"agents":{"__proto__":{"privacy":{"localOnly":true}}}}')], ["constructor-agent", { agents: { constructor: { privacy: { localOnly: true } } } }], ["empty-id-agent", { agents: { "": { privacy: { localOnly: true } } } }]];
  const ids: [string, string | undefined][] = [["undefined", undefined], ["alice", "alice"], ["bob", "bob"], ["carol", "carol"], ["unknown", "zed"], ["__proto__", "__proto__"], ["constructor", "constructor"], ["toString", "toString"], ["empty", ""], ["0", "0"], ["1", "1"], ["length", "length"]];
  for (const [cl, cfg] of cfgs) for (const [il, id] of ids) cases.push(mk(`localOnlyFor | ${cl} | ${il}`, { fn: "for", cfg, ...(id === undefined ? {} : { agentId: id }) }, localOnlyFor(cfg, id) ? "T" : "F"));
  const providers = ["apple-fm", "apple-fm ", "Apple-FM", "", "openai", "pcc", "apple-fm-pcc"], models = ["system", "System", "pcc", "", "system "];
  for (const p of providers) for (const m of models) cases.push(mk(`isLocalModel | ${p || "empty"} | ${m || "empty"}`, { fn: "model", provider: p, model: m }, isLocalModel(p, m) ? "T" : "F"));
  const listed = { privacy: { localEndpoints: ["http://192.168.1.20:11434", "https://models.example", "garbage", 5, null] } };
  for (const p of ["apple-fm", "openai", "pcc", ""]) for (const m of ["system", "pcc"]) for (const [ul, url] of [["undefined", undefined] as [string, unknown], ...URLS]) for (const [cl, cfg] of [["none", {}], ["listed", listed], ["null", null]] as [string, unknown][])
    cases.push(mk(`isLocalChatModel | ${p || "empty"} | ${m} | ${ul} | ${cl}`, { fn: "chat", provider: p, model: m, ...(url === undefined ? {} : { endpoint: url }), cfg }, (() => { try { return isLocalChatModel(p, m, url as any, cfg) ? "T" : "F"; } catch (e) { return `throws/${(e as Error).name}`; } })()));
  return cases;
}
function findingsConfigs(): [string, unknown][] {
  const out: [string, unknown][] = [["empty", {}], ["null", null], ["string", "x"], ["array", []]];
  for (const [ul, u] of URLS) out.push([`chat-provider ${ul}`, { providers: { p1: { wireFormat: "openai", profile: { base_url: u } } } }]);
  out.push(["chat-provider no-profile", { providers: { p1: { wireFormat: "openai" } } }], ["chat-provider profile-null", { providers: { p1: { wireFormat: "openai", profile: null } } }], ["chat-provider profile-array", { providers: { p1: { wireFormat: "openai", profile: [] } } }],
    ["chat-provider wireFormat-null", { providers: { p1: { wireFormat: null, profile: { base_url: "https://x.example" } } } }], ["not-a-chat-provider", { providers: { p1: { profile: { base_url: "https://x.example" } } } }],
    ["provider-entries-odd", { providers: { a: "x", b: null, c: [], d: 5, e: { wireFormat: 1, profile: { base_url: "https://x.example" } } } }],
    ["providers-array", { providers: [{ wireFormat: "openai" }] }], ["providers-string", { providers: "x" }],
    ["two-providers-sorted", { providers: { alpha: { wireFormat: "a", profile: { base_url: "https://a.example" } }, beta: { wireFormat: "a", profile: { base_url: "http://localhost" } }, gamma: { wireFormat: "a" } } }],
    ["integer-keys", JSON.parse('{"providers":{"a":{"wireFormat":"a"},"b":{"wireFormat":"a"},"10":{"wireFormat":"a"},"2":{"wireFormat":"a"},"1":{"wireFormat":"a"}}}')],
    ["own-proto-provider", JSON.parse('{"providers":{"__proto__":{"wireFormat":"a"}}}')]);
  const adapters = (list: unknown) => ({ providers: { media: { adapters: list } } });
  for (const [label, a] of [["openai-images", { id: "openai-images" }], ["draw-things", { id: "draw-things" }], ["draw-things-evil", { id: "draw-things", baseUrl: "http://evil.example" }], ["draw-things-null-url", { id: "draw-things", baseUrl: null }], ["draw-things-empty-url", { id: "draw-things", baseUrl: "" }],
    ["coreml-local", { id: "coreml-local" }], ["coreml-local-cloud-url", { id: "coreml-local", baseUrl: "https://x.example" }], ["local-url", { id: "x", baseUrl: "http://localhost:7860" }], ["no-id", {}], ["id-number", { id: 5 }], ["id-float", { id: 1.5 }], ["id-big", { id: 1e21 }], ["id-null", { id: null }],
    ["id-array", { id: ["a", "b"] }], ["id-nested-array", { id: [1, [2, 3], null] }], ["id-object", { id: {} }], ["id-true", { id: true }], ["id-constructor", { id: "constructor" }], ["id-proto", { id: "__proto__" }], ["id-url-number", { id: "x", baseUrl: 5 }], ["id-empty", { id: "" }]] as [string, unknown][])
    out.push([`media-adapter ${label}`, adapters([a])]);
  out.push(["media-adapters-null-entries", adapters([null, "x", 5, []])], ["media-adapters-object", adapters({ id: "x" })], ["media-adapters-two", adapters([{ id: "b" }, { id: "a", baseUrl: "http://127.0.0.1" }, { id: "c" }])]);
  const voice = (p: unknown) => ({ voice: { providers: p } });
  out.push(["voice enabled cloud", voice({ v: { enabled: true, baseUrl: "https://x.example" } })], ["voice enabled local", voice({ v: { enabled: true, baseUrl: "http://localhost" } })], ["voice enabled no url", voice({ v: { enabled: true } })], ["voice disabled", voice({ v: { enabled: false, baseUrl: "https://x.example" } })],
    ["voice enabled string", voice({ v: { enabled: "true", baseUrl: "https://x.example" } })], ["voice two", voice({ b: { enabled: true }, a: { enabled: true, baseUrl: "http://[::1]:1" } })], ["voice odd", voice({ a: null, b: "x", c: [] })], ["voice providers array", voice([{ enabled: true }])]);
  const media = (m: unknown) => ({ memory: { mediaEmbedding: m } });
  for (const p of ["openai", "local", "local-transformers", "egemma2", "off", "coreml-local", "draw-things", "", "Local"]) out.push([`media-index ${p || "empty"}`, media({ provider: p })]);
  out.push(["media-index enabled false", media({ enabled: false, provider: "openai" })], ["media-index enabled null", media({ enabled: null, provider: "openai" })], ["media-index provider number", media({ provider: 5 })], ["media-index none", media({})], ["media-index string", { memory: { mediaEmbedding: "x" } }]);
  for (const [p, src] of [["openai", undefined], ["openai", "off"], ["openai", "image"], ["local", undefined], ["off", undefined], ["egemma2", "image"], ["", undefined], [5, undefined]] as [unknown, unknown][])
    out.push([`caption ${String(p) || "empty"} source ${String(src)}`, media({ provider: "local", caption: { provider: p, ...(src === undefined ? {} : { source: src }) } })]);
  out.push(["media-index and caption cloud", media({ provider: "openai", caption: { provider: "anthropic" } })], ["caption string", media({ caption: "x" })]);
  // the engine: every configuration of the existing local-only fixture (tests/fixtures/privacy-local-only.json), plus shapes of the engine's LLM features
  const known = JSON.parse(readFileSync(fileURLToPath(new URL("../../tests/fixtures/privacy-local-only.json", import.meta.url)), "utf8")) as { name: string; config: unknown }[];
  for (const k of known) out.push([`fixture ${k.name}`, k.config]);
  out.push(["engine odd", { engine: "x" }], ["engine array", { engine: [] }], ["engine embedding odd", { engine: { embedding: "x" } }], ["engine embedding cloud and reranker", { engine: { embedding: { provider: "openai", baseUrl: "https://x.example/v1" }, reranker: { provider: "cohere" } } }],
    ["engine local both", { engine: { embedding: { provider: "tei", baseUrl: "http://localhost:8080" }, reranker: { provider: "tei", baseUrl: "http://127.0.0.1:8081" } } }]);
  // everything at once, in the order the findings are produced
  out.push(["everything", { providers: { p1: { wireFormat: "a", profile: { base_url: "https://x.example" } }, media: { adapters: [{ id: "openai-images" }] } }, voice: { providers: { v: { enabled: true } } }, memory: { mediaEmbedding: { provider: "openai", caption: { provider: "anthropic" } } }, engine: { embedding: { provider: "openai" } } }]);
  const many: any = { providers: {} }; for (let i = 0; i < 12; i++) many.providers[`p${String(i).padStart(2, "0")}`] = { wireFormat: "a", profile: { base_url: `https://h${i}.example` } };
  out.push(["twelve providers", many]);
  return out;
}
/** The configuration a `doctor-check` case runs: the base configuration, with the installation switch on, or with agents pinned (the Rust replay mirrors this). */
function checkConfig(cfg: unknown, variant: string): unknown {
  const base = cfg !== null && typeof cfg === "object" && !Array.isArray(cfg) ? (cfg as any) : {};
  if (variant === "switch-off") return cfg;
  if (variant === "installation-on") return { ...base, privacy: { localOnly: true } };
  return { ...base, privacy: { localOnly: false }, agents: { zed: { privacy: { localOnly: true } }, alice: { privacy: { localOnly: true } }, bob: { privacy: { localOnly: false } } } };
}
function buildDoctor() {
  const find: Case[] = [], check: Case[] = [];
  for (const [label, cfg] of findingsConfigs()) {
    for (const shared of [false, true]) find.push(mk(`findings | ${label} | shared ${shared}`, { cfg, sharedOnly: shared }, JSON.stringify(localOnlyFindings(cfg, shared))));
    for (const variant of ["switch-off", "installation-on", "agent-pins"]) check.push(mk(`check | ${label} | ${variant}`, { cfg, variant }, JSON.stringify(localOnlyCheck(checkConfig(cfg, variant)))));
  }
  return { find, check };
}

// --- main --------------------------------------------------------------------------------------------------------------------------------------
export async function buildExposureVectors(): Promise<Record<string, any>> {
  seen.clear();
  const r = buildResolve();
  const files: Record<string, any> = {};
  const counts: Record<string, number> = {};
  const put = (name: string, fields: string[], cases: Case[]) => { files[name] = pack(fields, cases); counts[name] = cases.length; };
  const named = (name: string, fields: string[], cases: Case[], extra: Record<string, unknown> = {}) => { files[name] = pack(fields, cases, extra); counts[name] = cases.length; };
  named("resolve-principals", ["role", "kind", "right", "scopes", "variant"], r["resolve-principals"], { scopeSets: SCOPE_SETS, agent: AG, userId: SELF });
  named("resolve-switches", ["channel", "sw", "role", "kind", "right", "variant"], r["resolve-switches"], { agent: AG, userId: SELF });
  named("resolve-overrides", ["base", "disclose", "recall", "capture", "groups"], r["resolve-overrides"], { agent: AG, userId: SELF, bases: MEMORY_BASES, groupSets: GROUPS });
  named("switches", ["channel", "shape", "sw"], r.switches, { agent: AG });
  put("scanner", ["text", "summary"], buildScanner());
  put("hash", ["text", "summary"], buildHashes());
  const s = await buildSensitivity();
  put("sensitivity-refusal", ["filter", "service"], s.refusal);
  put("sensitivity-filter", ["filter", "service", "blocks"], s.filter);
  put("local-only", ["fn", "cfg", "agentId", "provider", "model", "endpoint"], buildLocalOnly());
  const d = buildDoctor();
  put("doctor-findings", ["cfg", "sharedOnly"], d.find);
  put("doctor-check", ["cfg", "variant"], d.check);
  files.keywords = { note: "the literal variants of the four keyword alternations, expanded from the pattern source text of scanner.ts (a space stands for `\\s*`)", variants: KEYWORDS, otherPatterns: OTHER_PATTERNS };
  files.index = { counts, total: Object.values(counts).reduce((a, b) => a + b, 0), grids: { "resolve-principals": "role5 x kind3 x right3 x scopes11 x token6 (+1)", "resolve-switches": "collab: 81 x 24 principals; mcp, a2a: 81 x 4 (sampled)", "resolve-overrides": "owner person full 1215; two more principals 45 each (sampled)", switches: "channel3 x shape4 x 81 (+2)" } };
  return files;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await exporterMain({ area: "exposure", build: buildExposureVectors });
}
