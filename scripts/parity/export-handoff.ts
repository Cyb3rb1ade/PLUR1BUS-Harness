// Parity vectors (mode V) for the channel hand-off (P4-K K3b, plan P4-22): the rules that decide whether the text of a
// channel conversation may become visible in Web: which messages make a session tainted for good, who counts as the same
// person, the lifetime and the number of the one-use links, and the shape of the Web address. The real `ChannelHandoff` and
// `webBase` run over a temporary `channel-handoff.sqlite` with a scripted clock, scripted randomness and a scripted session
// store; `crates/plur1bus-core/src/handoff/vectors.rs` replays every scenario and must give the same answers, the same audit
// lines and the same rows. Recorded, never edited by hand.
//
// A scenario is `{ name, world, ops }`; the answer to each op is `{ ok }` or `{ err }` (an RPC error carries its `code`), with
// the audit lines that op wrote. `final` is the rows of the four tables and the sessions the scripted store holds at the end.
//
//   node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning scripts/parity/export-handoff.ts [--check]
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { exporterMain } from "./lib.mjs";
import { dumpTables, errOf, installScriptedRandom, schemaOf } from "./k3b-support.ts";

let random: ReturnType<typeof installScriptedRandom>;
const { ChannelHandoff, webBase } = await import("../../packages/core/src/channel-handoff/service.ts");
const { deriveUserPrincipal } = await import("../../packages/core/src/identity/principals.ts");
const { activeSummaries } = await import("../../packages/core/src/session/rewind-path.ts");

const TABLES = { channel_taint: [], channel_direct: ["value"], channel_handoffs: [], channel_continuations: ["source"] };
type Msg = { channel: string; chatId: string; chatKind: "direct" | "group" | "broadcast"; senderId: string; accountId?: string; text: string };
const dm = (over: Partial<Msg> = {}): Msg => ({ channel: "telegram", chatId: "dm", chatKind: "direct", senderId: "sender", accountId: "bot", text: "hello", ...over });
const session = (id: string, over: Record<string, unknown> = {}) => ({ id, kind: "channel", ownerPerson: "alice", chatKey: "telegram:dm", agentId: "main", title: "Private DM", updatedAt: 500, messages: [] as unknown[], summaries: [] as unknown[], rewinds: [] as unknown[], ...over });
const LINK = { channel: "telegram", accountId: "bot", userId: "sender", human: "alice" };
const PRINCIPALS = { alice: { role: "owner", kind: "person" }, bob: { role: "member", kind: "person" }, vera: { role: "viewer", kind: "person", agentRights: { main: "use" } } };
const world = (over: Record<string, unknown> = {}) => ({ now: 1_000_000, baseUrl: "https://web.example", agentId: "main", links: [LINK], principals: PRINCIPALS, sessions: [session("s1")], storeAvailable: true, ...over });
const turns = (n: number) => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `${i % 2 ? "reply" : "question"}-${Math.floor(i / 2)}`, createdAt: 600 + i }));

// A scripted session store: the methods `ChannelHandoff` calls, answering from the world.
function fakeStore(w: any) {
  const c = (w.counters ??= { created: 0, continued: 0 });
  const view = (s: any) => ({ id: s.id, kind: s.kind, owner: deriveUserPrincipal(s.ownerPerson), chatKey: s.chatKey, agentId: s.agentId, title: s.title, updatedAt: s.updatedAt, archivedAt: s.archived ? 1 : null });
  const find = (id: string) => w.sessions.find((s: any) => s.id === id);
  return {
    getSession: (id: string) => { const s = find(id); return s ? view(s) : undefined; },
    listMessages: (id: string, o?: { limit?: number }) => { const m = find(id)?.messages ?? []; return o?.limit === 1 ? m.slice(0, 1) : m.slice(-(o?.limit ?? 50)); },
    activeForChat: (key: string) => { const s = w.sessions.find((x: any) => x.chatKey === key && !x.archived); return s ? { ...view(s), turnCount: s.messages.length / 2 } : undefined; },
    createSession: (i: any) => { const s = session(`new-${++c.created}`, { kind: i.kind, ownerPerson: personOf(w, i.owner), chatKey: i.chatKey, agentId: i.agentId, title: i.title, updatedAt: w.now }); w.sessions.push(s); return view(s); },
    listSummaries: (id: string) => find(id)?.summaries ?? [],
    summaryRewinds: (id: string) => find(id)?.rewinds ?? [],
    contextMessages: (id: string) => find(id)?.messages ?? [],
    createContinuation: (i: any) => {
      const s = session(`cont-${++c.continued}`, { kind: "direct", ownerPerson: personOf(w, i.owner), chatKey: null, agentId: i.agentId, title: i.title, updatedAt: w.now, messages: [{ role: "user", text: i.context, createdAt: w.now }] });
      w.sessions.push(s);
      return { id: s.id };
    },
  };
}
const personOf = (w: any, owner: string) => Object.keys(w.principals).concat(["alice", "bob", "vera"]).find((p) => deriveUserPrincipal(p) === owner) ?? owner;

function run(name: string, w0: any, ops: any[]) {
  const dir = mkdtempSync(join(tmpdir(), "p4k-handoff-"));
  const path = join(dir, "state", "handoff.sqlite");
  const w = structuredClone(w0);
  const audit: any[] = [];
  let auditFail = false;
  const tokens: string[] = [];
  random.reset();
  const options = () => ({
    path, store: () => (w.storeAvailable ? fakeStore(w) : null) as any,
    identity: () => ({ resolve: (i: any) => { const l = w.links.find((x: any) => x.channel === i.channel && x.accountId === i.accountId && x.userId === i.userId); return l ? { humanId: l.human } : null; } }) as any,
    clock: () => w.now,
    audit: { append: (e: any) => { if (auditFail) throw new Error("audit unavailable"); audit.push(e); } },
    resolve: (id: string) => { const p = w.principals[id]; return p ? { userId: id, ...p } : null; },
    agentId: () => w.agentId, baseUrl: () => w.baseUrl,
  });
  let h = new ChannelHandoff(options() as any);
  const steps: unknown[] = [];
  try {
    for (const op of ops) {
      audit.length = 0;
      let out: unknown;
      try {
        switch (op.op) {
          case "observe": h.observe(op.msg, op.person, op.sessionId); out = { ok: null }; break;
          case "observeMany": { for (let i = 0; i < op.count; i++) { w.sessions.push(session(`b${i}`, { chatKey: `telegram:c${i}`, ownerPerson: op.person })); h.observe(dm({ chatId: `c${i}` }), op.person, `b${i}`); } out = { ok: null }; break; }
          case "issue": { const r = h.issue(op.id, op.person); tokens.push(r.token); out = { ok: r }; break; }
          case "issueMessage": { const r = h.issueMessage(op.msg, op.person); const t = r.split("/").at(-1)!; tokens.push(t); out = { ok: r }; break; }
          case "redeem": out = { ok: h.redeem(op.token ?? tokens[op.nth ?? tokens.length - 1]!, op.person) }; break;
          case "list": out = { ok: h.list(op.person) }; break;
          case "get": out = { ok: h.get(op.id, op.person) }; break;
          case "advance": w.now += op.ms; out = { ok: w.now }; break;
          case "unlink": w.links = w.links.filter((l: any) => !(l.channel === op.channel && l.accountId === op.accountId && l.userId === op.userId)); out = { ok: null }; break;
          case "link": w.links.push(op.link); out = { ok: null }; break;
          case "principal": if (op.principal === null) delete w.principals[op.person]; else w.principals[op.person] = op.principal; out = { ok: null }; break;
          case "addMessages": w.sessions.find((s: any) => s.id === op.sessionId).messages.push(...op.messages); out = { ok: null }; break;
          case "patchSession": Object.assign(w.sessions.find((s: any) => s.id === op.sessionId), op.patch); out = { ok: null }; break;
          case "addSession": w.sessions.push(session(op.id, op.over ?? {})); out = { ok: null }; break;
          case "base": w.baseUrl = op.baseUrl; out = { ok: null }; break;
          case "store": w.storeAvailable = op.available; out = { ok: null }; break;
          case "auditFail": auditFail = op.fail; out = { ok: null }; break;
          case "reopen": h.close(); h = new ChannelHandoff(options() as any); out = { ok: null }; break;
          default: throw new Error(`unknown op ${op.op}`);
        }
      } catch (e) { out = { err: errOf(e) }; }
      steps.push({ op, out, ...(audit.length ? { audit: audit.map((a) => ({ at: a.at, user: a.actor.user, host: a.actor.host, action: a.action, target: a.target, detail: a.detail })) } : {}) });
    }
    h.close();
    return {
      name, world: w0, ops: steps,
      final: { tables: dumpTables(path, TABLES), sessions: w.sessions.map((s: any) => ({ id: s.id, kind: s.kind, owner: s.ownerPerson, messages: s.messages.length, firstText: s.messages[0]?.text })), schema: schemaOf(path) },
    };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const issue = (id = "s1", person = "alice") => ({ op: "issue", id, person });
const redeem = (over: Record<string, unknown> = {}) => ({ op: "redeem", person: "alice", ...over });
const base = world({ sessions: [session("s1", { messages: [] })] });
const observeS1 = { op: "observe", msg: dm(), person: "alice", sessionId: "s1" };
const long = (n: number, ch = "a") => ch.repeat(n);

function scenarios() {
  const out: unknown[] = [];
  out.push(run("issue-redeem-roundtrip", world(), [
    observeS1, { op: "addMessages", sessionId: "s1", messages: turns(18) }, issue(), redeem({ person: "bob" }), redeem(), redeem(), { op: "list", person: "alice" }, { op: "get", id: "s1", person: "alice" }, { op: "list", person: "bob" }, { op: "get", id: "s1", person: "bob" },
  ]));
  out.push(run("redeem-lifetime-boundary", base, [
    observeS1, issue(), { op: "advance", ms: 599_999 }, redeem({ nth: 0 }),
    issue(), { op: "advance", ms: 600_000 }, redeem({ nth: 1 }), issue(), { op: "advance", ms: 599_999 }, redeem({ nth: 2 }),
  ]));
  out.push(run("link-limit", base, [
    observeS1, issue(), issue(), issue(), issue(), issue(), issue(), { op: "advance", ms: 599_999 }, issue(), { op: "advance", ms: 1 }, issue(), issue(), { op: "list", person: "alice" },
  ]));
  out.push(run("link-limit-per-person", world({ sessions: [session("s1"), session("s2", { ownerPerson: "bob", chatKey: "telegram:bob" })], links: [LINK, { channel: "telegram", accountId: "bot", userId: "bobby", human: "bob" }], principals: { ...PRINCIPALS, bob: { role: "owner", kind: "person" } } }), [
    observeS1, { op: "observe", msg: dm({ chatId: "bob", senderId: "bobby" }), person: "bob", sessionId: "s2" },
    issue(), issue(), issue(), issue(), issue(), issue("s2", "bob"), issue(), issue("s2", "bob"),
  ]));
  const tokenForms = ["", "a".repeat(42), "a".repeat(44), "A".repeat(43), "a+".repeat(21) + "a", "a/".repeat(21) + "a", "a=".repeat(21) + "a", "-_".repeat(21) + "a", "é".repeat(43), "a".repeat(42) + "\n", " " + "a".repeat(42)];
  out.push(run("token-shape", base, [observeS1, issue(), ...tokenForms.map((t) => redeem({ token: t })), redeem({ nth: 0 })]));
  out.push(run("taint-for-good", world({ sessions: [session("s1", { messages: turns(2) }), session("s2", { chatKey: "telegram:dm2", messages: [] })] }), [
    // An old session with messages was never observed as direct: the first direct message taints it, it is never visible.
    observeS1, { op: "get", id: "s1", person: "alice" }, { op: "list", person: "alice" }, issue(),
    // A session without history is direct; it stays direct while it grows.
    { op: "observe", msg: dm({ chatId: "dm2" }), person: "alice", sessionId: "s2" }, { op: "addMessages", sessionId: "s2", messages: turns(2) },
    { op: "observe", msg: dm({ chatId: "dm2", text: "again" }), person: "alice", sessionId: "s2" }, { op: "list", person: "alice" }, issue("s2"),
    // One group message taints it for good and removes the direct record; a later direct message does not undo it.
    { op: "observe", msg: dm({ chatId: "dm2", chatKind: "group" }), person: "alice", sessionId: "s2" }, { op: "list", person: "alice" }, issue("s2"), { op: "get", id: "s2", person: "alice" },
    { op: "observe", msg: dm({ chatId: "dm2" }), person: "alice", sessionId: "s2" }, { op: "list", person: "alice" }, issue("s2"),
  ]));
  out.push(run("taint-by-kind", world({ sessions: [session("s1"), session("s2", { chatKey: "telegram:b" }), session("s3", { chatKey: "telegram:c" })] }), [
    observeS1, { op: "observe", msg: dm({ chatId: "b", chatKind: "broadcast" }), person: "alice", sessionId: "s2" }, { op: "observe", msg: dm({ chatId: "c", chatKind: "group" }), person: "alice", sessionId: "s3" },
    { op: "list", person: "alice" }, { op: "observe", msg: dm({ chatId: "b" }), person: "alice", sessionId: "s2" }, { op: "list", person: "alice" },
  ]));
  out.push(run("observe-guards", world({ sessions: [session("s1"), session("k1", { kind: "direct", chatKey: "telegram:k" }), session("o1", { chatKey: "telegram:o", ownerPerson: "bob" }), session("c1", { chatKey: "telegram:dm" }), session("x1", { chatKey: "telegram:x" }), session("n1", { chatKey: "telegram:n" })], links: [LINK, { channel: "telegram", accountId: "bot", userId: "other", human: "bob" }] }), [
    { op: "observe", msg: dm({ accountId: undefined }), person: "alice", sessionId: "s1" },
    { op: "observe", msg: dm({ accountId: "" }), person: "alice", sessionId: "s1" },
    { op: "observe", msg: dm({ chatId: "k" }), person: "alice", sessionId: "k1" },
    { op: "observe", msg: dm({ chatId: "o" }), person: "alice", sessionId: "o1" },
    { op: "observe", msg: dm({ chatId: "elsewhere" }), person: "alice", sessionId: "s1" },
    { op: "observe", msg: dm({ senderId: "other" }), person: "alice", sessionId: "s1" },
    { op: "observe", msg: dm({ senderId: "nobody" }), person: "alice", sessionId: "s1" },
    { op: "observe", msg: dm({ accountId: "other-bot" }), person: "alice", sessionId: "s1" },
    { op: "observe", msg: dm(), person: "alice", sessionId: "missing" },
    { op: "observe", msg: dm({ chatId: "x" }), person: "", sessionId: "x1" },
    { op: "list", person: "alice" }, { op: "list", person: "bob" },
    observeS1, { op: "list", person: "alice" },
  ]));
  out.push(run("rights-and-identity-at-use", world({ principals: { ...PRINCIPALS, alice: { role: "owner", kind: "person" } } }), [
    observeS1, { op: "get", id: "s1", person: "alice" }, { op: "unlink", channel: "telegram", accountId: "bot", userId: "sender" }, { op: "get", id: "s1", person: "alice" }, { op: "list", person: "alice" }, issue(),
    { op: "link", link: LINK }, { op: "get", id: "s1", person: "alice" },
    { op: "principal", person: "alice", principal: null }, { op: "get", id: "s1", person: "alice" }, { op: "list", person: "alice" },
    { op: "principal", person: "alice", principal: { role: "owner" } }, { op: "get", id: "s1", person: "alice" },
    { op: "principal", person: "alice", principal: { role: "owner", kind: "agent" } }, { op: "get", id: "s1", person: "alice" },
    { op: "principal", person: "alice", principal: { role: "member", kind: "person" } }, { op: "get", id: "s1", person: "alice" }, issue(),
    { op: "principal", person: "alice", principal: { role: "member", kind: "person", agentRights: { main: "use" } } }, { op: "get", id: "s1", person: "alice" }, issue(),
    { op: "principal", person: "alice", principal: { role: "viewer", kind: "person", agentRights: { main: "use" } } }, { op: "get", id: "s1", person: "alice" }, issue(),
    { op: "principal", person: "alice", principal: { role: "operator", kind: "person", agentRights: { other: "use" } } }, { op: "get", id: "s1", person: "alice" }, issue(),
    { op: "principal", person: "alice", principal: { role: "owner", kind: "person" } }, { op: "patchSession", sessionId: "s1", patch: { kind: "direct" } }, { op: "get", id: "s1", person: "alice" },
    { op: "patchSession", sessionId: "s1", patch: { kind: "channel", ownerPerson: "bob" } }, { op: "get", id: "s1", person: "alice" },
    { op: "patchSession", sessionId: "s1", patch: { ownerPerson: "alice" } }, { op: "get", id: "s1", person: "alice" },
    { op: "store", available: false }, { op: "get", id: "s1", person: "alice" }, { op: "list", person: "alice" }, { op: "store", available: true }, { op: "list", person: "alice" },
  ]));
  out.push(run("redeem-needs-rights-and-identity", base, [
    observeS1, issue(), { op: "unlink", channel: "telegram", accountId: "bot", userId: "sender" }, redeem(), { op: "link", link: LINK }, redeem(),
    issue(), { op: "principal", person: "alice", principal: { role: "viewer", kind: "person", agentRights: { main: "use" } } }, redeem(),
    { op: "principal", person: "alice", principal: PRINCIPALS.alice }, redeem({ nth: 1 }),
  ]));
  out.push(run("issue-message", world({ sessions: [session("s1")], links: [LINK, { channel: "telegram", accountId: "bot", userId: "newbie", human: "bob" }], principals: { ...PRINCIPALS, bob: { role: "owner", kind: "person" } } }), [
    { op: "issueMessage", msg: dm({ chatKind: "group" }), person: "alice" },
    { op: "issueMessage", msg: dm({ accountId: undefined }), person: "alice" },
    { op: "issueMessage", msg: dm({ accountId: "wrong" }), person: "alice" },
    { op: "issueMessage", msg: dm({ chatId: "fresh", senderId: "stranger" }), person: "alice" },
    { op: "issueMessage", msg: dm({ chatId: "fresh", senderId: "newbie" }), person: "alice" },
    { op: "issueMessage", msg: dm({ chatId: "fresh", senderId: "newbie" }), person: "bob" },
    { op: "issueMessage", msg: dm({ chatId: "fresh", senderId: "newbie" }), person: "bob" },
    { op: "issueMessage", msg: dm({ chatId: "fresh", senderId: "newbie", accountId: "bot" }), person: "alice" },
    redeem({ person: "bob" }), { op: "list", person: "bob" }, { op: "list", person: "alice" },
    { op: "issueMessage", msg: dm(), person: "alice" }, { op: "observe", msg: dm(), person: "alice", sessionId: "s1" }, { op: "issueMessage", msg: dm(), person: "alice" },
    { op: "principal", person: "bob", principal: { role: "member", kind: "person" } }, { op: "issueMessage", msg: dm({ chatId: "fresh2", senderId: "newbie" }), person: "bob" },
    { op: "base", baseUrl: "http://web.example" }, { op: "issueMessage", msg: dm(), person: "alice" },
    { op: "base", baseUrl: "https://web.example/app/" }, { op: "issueMessage", msg: dm(), person: "alice" },
    { op: "store", available: false }, { op: "issueMessage", msg: dm(), person: "alice" },
  ]));
  const summaries = [{ text: "KEPT-A", fromSeq: 1, toSeq: 4 }, { text: "DISCARDED", fromSeq: 5, toSeq: 12 }, { text: "KEPT-B", fromSeq: 13, toSeq: 14 }, { text: "TOUCHED-AT-EDGE", fromSeq: 9, toSeq: 10 }, { text: "UNDONE-REWIND-OVERLAP", fromSeq: 20, toSeq: 22 }];
  const rewinds = [{ hiddenFromSeq: 10, hiddenToSeq: 12, undoneAt: null }, { hiddenFromSeq: 20, hiddenToSeq: 22, undoneAt: 7 }];
  void activeSummaries;
  const edged = turns(26).map((m, i) => (i === 15 ? { ...m, text: long(398) + "😀😀" } : i === 17 ? { ...m, text: long(401) } : i === 19 ? { ...m, text: long(399) + "é" } : m));
  out.push(run("context-for-the-continuation", world({ sessions: [session("s1", { summaries, rewinds })] }), [
    observeS1, { op: "addMessages", sessionId: "s1", messages: edged }, issue(), redeem(), { op: "get", id: "cont-1", person: "alice" },
  ]));
  out.push(run("context-limits", world({ sessions: [session("s1", { summaries: [{ text: long(2999) + "Z", fromSeq: 1, toSeq: 2 }, { text: long(1, "Y"), fromSeq: 3, toSeq: 4 }, { text: long(2000, "W"), fromSeq: 5, toSeq: 6 }] })] }), [
    observeS1, { op: "addMessages", sessionId: "s1", messages: turns(30).map((m, i) => ({ ...m, text: long(400, "m") + i })) }, issue(), redeem(),
  ]));
  out.push(run("context-nothing-to-quote", world({ sessions: [session("s1", { messages: [] })] }), [observeS1, issue(), redeem()]));
  out.push(run("list-and-get-limits-200", world({ sessions: [] }), [{ op: "observeMany", count: 200, person: "alice" }, { op: "list", person: "alice" }]));
  out.push(run("list-and-get-limits-201", world({ sessions: [] }), [{ op: "observeMany", count: 201, person: "alice" }, { op: "list", person: "alice" }]));
  out.push(run("audit-before-effect", base, [
    observeS1, { op: "auditFail", fail: true }, issue(), { op: "list", person: "alice" }, { op: "auditFail", fail: false }, issue(),
    { op: "auditFail", fail: true }, redeem(), { op: "auditFail", fail: false }, redeem(), redeem(),
  ]));
  out.push(run("restart", base, [observeS1, issue(), { op: "reopen" }, { op: "list", person: "alice" }, redeem(), { op: "reopen" }, redeem(), { op: "list", person: "alice" }]));
  return out;
}

function webBaseCases() {
  const inputs = ["https://web.example", "https://web.example/", "https://web.example//", "https://web.example/app", "https://web.example/app/", "http://web.example", "http://localhost", "http://LOCALHOST:8080/", "http://127.0.0.1:1234/", "http://127.1", "http://0x7f.1", "http://[::1]", "http://[::1]:9/x/", "http://[0:0:0:0:0:0:0:1]", "http://127.0.0.2", "http://localhost.", "http://localhost.example",
    "https://u:p@web.example", "https://u@web.example", "https://:p@web.example", "https://:@web.example", "https://web.example/?a=b", "https://web.example/?", "https://web.example?", "https://web.example/#x", "https://web.example/#", "https://web.example#", "https://web.example/a?b#c",
    "", " ", "web.example", "//web.example", "ftp://web.example", "wss://web.example", "javascript:alert(1)", "https://", "https:///x", "https://web example", "https://WEB.EXAMPLE/Path", "https://web.example:443/", "https://web.example:8443", "https://web.example:99999", " https://web.example", "https://web.example ", "https://web.example\n", "HTTPS://web.example", "https://xn--bcher-kva.example", "https://bücher.example", "https://web.example/é", "https://web.example/%2F/", "https://web.example/a b"];
  return inputs.map((input) => { try { return { input, ok: webBase(input) }; } catch (e) { return { input, err: errOf(e) }; } });
}

export async function buildHandoffVectors() {
  random = installScriptedRandom();
  try {
    return { "web-base": webBaseCases(), rules: scenarios() };
  } finally { random.restore(); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await exporterMain({ area: "handoff", build: buildHandoffVectors });
}
