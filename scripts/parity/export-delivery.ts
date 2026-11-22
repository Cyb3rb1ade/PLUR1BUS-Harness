// Parity vectors (mode V) for delivery (P4-K K3b, plan P4-22): which channel destinations may receive what (`deliveryAllowed`
// over the configuration's allowlists) and the rules of the delivery targets: who may add a destination, what confirms it (the
// code, once, in the exact DM, within ten minutes and five tries), when it stops being valid, who may deliver to it and who may
// subscribe to what. The real `deliveryAllowed` and `DeliveryTargets` run over a temporary `delivery.sqlite` with a scripted
// clock, scripted randomness and scripted channel ports; `crates/plur1bus-core/src/delivery/vectors.rs` replays every case and
// must give the same answers, the same audit lines, the same messages and the same rows. Recorded, never edited by hand.
//
// The Buzz public key is the channel's own business (a bech32 decoder in `channels-buzz`): the policy vectors record what the
// real `publicKey` answered for every string they use (`buzzKeys`), and the replay hands those answers to the port.
//
// A scenario is `{ name, world, ops }`; the answer to each op is `{ ok }` or `{ err }`, with the audit lines and the messages sent
// by that op. The async ports are replaced by scripted ones; a `hook` runs inside the next port call, which is where TypeScript's
// awaits let another caller in.
//
//   node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning scripts/parity/export-delivery.ts [--check]
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { exporterMain } from "./lib.mjs";
import { dumpTables, errOf, installScriptedRandom, schemaOf } from "./k3b-support.ts";

let random: ReturnType<typeof installScriptedRandom>;
const { DeliveryTargets } = await import("../../packages/core/src/delivery/service.ts");
const { deliveryAllowed } = await import("../../packages/core/src/delivery/policy.ts");
const { publicKey } = await import("../../packages/channels-buzz/src/config.ts");

const TABLES = { delivery_targets: ["value"] };
const TG = { channel: "telegram", accountId: "bot", userId: "sender" };
const PRINCIPALS = { alice: { role: "owner", kind: "person" }, bob: { role: "owner", kind: "person" }, mia: { role: "member", kind: "person" }, ada: { role: "admin", kind: "person" }, vera: { role: "viewer", kind: "person", agentRights: { main: "use" } } };
const world = (over: Record<string, unknown> = {}) => ({ now: 1_000_000, links: [{ ...TG, human: "alice" }], principals: PRINCIPALS, allowed: null as unknown, chat: "dm", sendOk: true, ...over });
const caller = (userId = "alice", over: Record<string, unknown> = {}) => ({ userId, ...(PRINCIPALS as any)[userId], ...over });
const dmText = (code: string) => `/delivery ${code}`;
const confirmMsg = (text: string, over: Record<string, unknown> = {}) => ({ channel: "telegram", chatId: "dm", chatKind: "direct", accountId: "bot", senderId: "sender", text, ...over });

async function run(name: string, w0: any, ops: any[]) {
  const dir = mkdtempSync(join(tmpdir(), "p4k-delivery-"));
  const path = join(dir, "state", "delivery.sqlite");
  const w = structuredClone(w0);
  const audit: any[] = [], sent: any[] = [], codes: string[] = [], ids: string[] = [];
  let auditFail = false;
  const hooks: any[] = [];
  random.reset();
  const active = () => w.links.filter((l: any) => !l.revoked);
  const options = () => ({
    path, clock: () => w.now,
    identity: () => ({
      resolve: (i: any) => { const l = active().find((x: any) => x.channel === i.channel && x.accountId === i.accountId && x.userId === i.userId); return l ? { humanId: l.human } : null; },
      list: () => ({ humans: [...new Set(w.links.map((l: any) => l.human))].map((h) => ({ identities: w.links.filter((l: any) => l.human === h).map((l: any) => ({ channel: l.channel, accountId: l.accountId, userId: l.userId, humanId: l.human, revokedAt: l.revoked ? 1 : null })) })) }),
    }) as any,
    resolve: (id: string) => { const p = w.principals[id]; return p ? { userId: id, ...p } : null; },
    audit: { append: (e: any) => { if (auditFail) throw new Error("audit unavailable"); audit.push(e); } },
    allowed: (i: any) => w.allowed === null || w.allowed.some((a: any) => a.channel === i.channel && a.accountId === i.accountId && a.userId === i.userId),
    target: async (i: any) => { runHooks(); return w.chat === null ? "" : typeof w.chat === "string" ? w.chat : w.chat[i.channel] ?? ""; },
    send: async (channel: string, chatId: string, text: string) => { sent.push({ channel, chatId, text }); if (w.sendThrows) throw new Error("send failed"); return w.sendOk; },
  });
  const side = () => new DatabaseSync(path);
  const runHooks = () => {
    const h = hooks.shift();
    if (!h) return;
    if (h.kind === "delete-row") { const db = side(); db.prepare("DELETE FROM delivery_targets WHERE id=?").run(ids[h.nth] ?? h.id); db.close(); }
    else if (h.kind === "fill-quota") { const db = side(); for (let i = 0; i < h.count; i++) db.prepare("INSERT INTO delivery_targets VALUES (?,?)").run(`filler-${i}`, JSON.stringify({ id: `filler-${i}`, person: h.person, identity: { channel: "telegram", accountId: "bot", userId: `f${i}` }, chatId: "dm", validated: false, createdAt: 1 })); db.close(); }
    else if (h.kind === "world") Object.assign(w, h.patch);
    else if (h.kind === "unlink") w.links = w.links.filter((l: any) => !(l.channel === h.channel && l.accountId === h.accountId && l.userId === h.userId));
  };
  let d = new DeliveryTargets(options() as any);
  const steps: unknown[] = [];
  const codeOf = (n?: number) => codes[n ?? codes.length - 1]!;
  const text = (t: string) => t.replace("{code}", codeOf()).replace(/\{code(\d+)\}/, (_, n) => codeOf(Number(n)));
  const idOf = (op: any) => op.nth !== undefined ? ids[op.nth]! : op.id;
  const pub = (r: any) => (r && typeof r === "object" && !Array.isArray(r) && "id" in r ? r : r);
  const note = (r: any) => { if (r && typeof r === "object" && "id" in r && typeof r.id === "string" && !ids.includes(r.id)) ids.push(r.id); return r; };
  const ingest = () => { for (const s of sent) { const m = /\/delivery ([a-f0-9]{32})$/.exec(s.text); if (m && !codes.includes(m[1]!)) codes.push(m[1]!); } };
  try {
    for (const op of ops) {
      audit.length = 0; sent.length = 0;
      let out: unknown;
      try {
        switch (op.op) {
          case "add": out = { ok: note(await d.add(op.identity ?? TG, op.caller)) }; break;
          case "challenge": out = { ok: await d.challenge(idOf(op), op.caller) }; break;
          case "confirm": out = { ok: d.confirmMessage(confirmMsg(text(op.text), op.msg ?? {}) as any, op.person) }; break;
          case "list": out = { ok: d.list(op.caller) }; break;
          case "eligible": out = { ok: d.eligible(op.caller) }; break;
          case "remove": out = { ok: d.remove(idOf(op), op.caller) }; break;
          case "validate": out = { ok: pub(d.validate(idOf(op), op.person, op.agentId)) }; break;
          case "deliver": out = { ok: await d.deliver(idOf(op), op.person, op.agentId, op.text) }; break;
          case "subscribe": out = { ok: d.subscribe(idOf(op), op.source, op.job, op.agentId, op.caller) }; break;
          case "notify": out = { ok: await d.notify(op.source, op.job, op.agentId, op.outcome) ?? null }; break;
          case "advance": w.now += op.ms; out = { ok: w.now }; break;
          case "world": Object.assign(w, op.patch); out = { ok: null }; break;
          case "link": w.links.push(op.link); out = { ok: null }; break;
          case "unlink": w.links = w.links.filter((l: any) => !(l.channel === op.channel && l.accountId === op.accountId && l.userId === op.userId)); out = { ok: null }; break;
          case "principal": if (op.principal === null) delete w.principals[op.person]; else w.principals[op.person] = op.principal; out = { ok: null }; break;
          case "hook": hooks.push(op.hook); out = { ok: null }; break;
          case "auditFail": auditFail = op.fail; out = { ok: null }; break;
          case "reopen": d.close(); d = new DeliveryTargets(options() as any); out = { ok: null }; break;
          default: throw new Error(`unknown op ${op.op}`);
        }
      } catch (e) { out = { err: errOf(e) }; }
      ingest();
      steps.push({ op, out, ...(audit.length ? { audit: audit.map((a) => ({ at: a.at, user: a.actor.user, host: a.actor.host, action: a.action, target: a.target, detail: a.detail })) } : {}), ...(sent.length ? { sent: sent.map((s) => ({ ...s })) } : {}) });
    }
    d.close();
    return { name, world: w0, ops: steps, final: { tables: dumpTables(path, TABLES), schema: schemaOf(path), ids, codes } };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const add = (person = "alice", over: Record<string, unknown> = {}) => ({ op: "add", caller: caller(person), ...over });
const confirm = (over: Record<string, unknown> = {}) => ({ op: "confirm", person: "alice", text: "/delivery {code}", ...over });
const validate = (over: Record<string, unknown> = {}) => ({ op: "validate", nth: 0, person: "alice", agentId: "main", ...over });
const deliver = (over: Record<string, unknown> = {}) => ({ op: "deliver", nth: 0, person: "alice", agentId: "main", text: "result", ...over });
const challenge = (over: Record<string, unknown> = {}) => ({ op: "challenge", nth: 0, caller: caller(), ...over });
const subscribe = (over: Record<string, unknown> = {}) => ({ op: "subscribe", nth: 0, source: "dreams", job: "light", agentId: "main", caller: caller(), ...over });
const list = (person = "alice") => ({ op: "list", caller: caller(person) });

async function scenarios() {
  const out: unknown[] = [];
  out.push(await run("confirm-validate-deliver", world({ principals: { ...PRINCIPALS, bob: { role: "owner", kind: "person" } } }), [
    add(), validate(), list(), confirm({ msg: { chatId: "wrong" } }), validate(), confirm(), validate(), deliver(), deliver({ person: "bob" }), list(), list("bob"),
  ]));
  out.push(await run("fail-closed-paths", world(), [
    add(), confirm({ msg: { accountId: "other-bot" } }), validate(), { op: "advance", ms: 600_000 }, confirm(), validate(), challenge(), confirm({ text: "/delivery {code1}" }), validate(),
    { op: "world", patch: { allowed: [] } }, deliver(), { op: "world", patch: { allowed: null } }, { op: "remove", nth: 0, caller: caller() }, deliver(), validate(), list(),
  ]));
  out.push(await run("one-use-and-subscriptions", world(), [
    add(), confirm(), subscribe(), { op: "notify", source: "dreams", job: "light", agentId: "main", outcome: "completed" }, challenge(), confirm({ text: "/delivery {code0}" }), validate(),
  ]));
  out.push(await run("code-boundaries-tries", world(), [
    add(), ...Array.from({ length: 4 }, () => confirm({ text: "/delivery " + "0".repeat(32) })), confirm(), validate(),
    challenge(), ...Array.from({ length: 5 }, () => confirm({ text: "/delivery " + "0".repeat(32) })), confirm({ text: "/delivery {code1}" }), validate(),
    challenge(), confirm({ text: "/delivery {code2}", msg: { chatKind: "group" } }), confirm({ text: "/delivery {code2}", msg: { chatKind: "broadcast" } }), confirm({ text: "/delivery {code2}" }), validate(),
  ]));
  out.push(await run("code-boundaries-time", world(), [
    add(), { op: "advance", ms: 599_999 }, confirm(), validate(), challenge(), { op: "advance", ms: 600_000 }, confirm({ text: "/delivery {code1}" }), validate(), challenge(), { op: "advance", ms: 1 }, confirm({ text: "/delivery {code2}" }), validate(),
  ]));
  const code = "0123456789abcdef0123456789abcdef";
  const shapes = ["/delivery", "/delivery ", "/DELIVERY {code}", "/Delivery {code}", "  /delivery   {code}  ", " /delivery {code} ", "﻿/delivery {code}", " /delivery　{code}", "/delivery\t{code}", "/delivery\n{code}", "/deliveryX {code}", "/delivery{code}", "/delivery {code} extra", "/delivery {code}\nmore", "/delivery 0123456789ABCDEF0123456789ABCDEF", "/delivery " + code.slice(0, 31), "/delivery " + code + "0", "/delivery " + "g".repeat(32), "/delivery " + "０".repeat(32), "/delivery ı" + code.slice(1), "/ıſdelivery {code}", "/delivery\u0085{code}", "/delivery​{code}", "delivery {code}", "/ delivery {code}", "//delivery {code}", "hello", "", "/delivery   ", "/DELİVERY {code}", "/delivery ſ" + code.slice(1)];
  out.push(await run("confirm-text-shapes", world(), [add(), ...shapes.map((t) => confirm({ text: t })), validate(), confirm()]));
  out.push(await run("confirm-who-and-where", world({ links: [{ ...TG, human: "alice" }, { ...TG, userId: "other", human: "bob" }] }), [
    add(), confirm({ person: "bob" }), confirm({ msg: { senderId: "other" } }), confirm({ msg: { channel: "slack" } }), confirm({ msg: { chatId: "elsewhere" } }), confirm({ msg: { accountId: null } }), validate(),
    confirm({ person: "nobody" }), validate(), confirm(), validate(), { op: "unlink", ...TG }, validate(),
  ]));
  out.push(await run("add-guards", world({ links: [{ ...TG, human: "alice" }, { ...TG, userId: "bobby", human: "bob" }] }), [
    add("nobody"), add("alice", { caller: caller("alice", { kind: "agent" }) }), add("alice", { caller: { userId: "alice", role: "owner" } }), add("alice", { identity: { ...TG, userId: "stranger" } }), add("alice", { identity: { ...TG, userId: "bobby" } }), add(),
    { op: "world", patch: { allowed: [] } }, add(), { op: "world", patch: { allowed: null, chat: "" } }, add(), { op: "world", patch: { chat: "dm", sendOk: false } }, add(), list(), { op: "world", patch: { sendOk: true } }, challenge(), list(),
    { op: "world", patch: { sendOk: true, sendThrows: true } }, challenge(), { op: "world", patch: { sendThrows: false } },
    challenge({ nth: 7 }), challenge({ id: "nope" }), challenge({ caller: caller("bob") }), challenge({ caller: caller("mia") }), { op: "auditFail", fail: true }, challenge(), add(), { op: "auditFail", fail: false }, list(),
  ]));
  const many = Array.from({ length: 33 }, (_, i) => ({ ...TG, userId: `u${i}`, human: "alice" }));
  out.push(await run("quota-32", world({ links: many }), [...many.map((l) => add("alice", { identity: { channel: l.channel, accountId: l.accountId, userId: l.userId } })), list(), { op: "remove", nth: 0, caller: caller() }, add("alice", { identity: { ...TG, userId: "u32" } }), list()]));
  out.push(await run("quota-race-across-the-dm-lookup", world(), [
    { op: "hook", hook: { kind: "fill-quota", person: "alice", count: 32 } }, add(), list(),
  ]));
  out.push(await run("remove-and-revocation-during-delivery", world(), [
    add(), confirm(), { op: "hook", hook: { kind: "delete-row", nth: 0 } }, deliver(), list(),
    add(), confirm({ text: "/delivery {code1}" }), { op: "hook", hook: { kind: "world", patch: { allowed: [] } } }, deliver({ nth: 1 }), { op: "world", patch: { allowed: null } },
    { op: "hook", hook: { kind: "unlink", ...TG } }, deliver({ nth: 1 }), { op: "link", link: { ...TG, human: "alice" } }, { op: "hook", hook: { kind: "world", patch: { chat: "other-dm" } } }, deliver({ nth: 1 }),
  ]));
  out.push(await run("deliver-guards", world({ links: [{ ...TG, human: "alice" }], principals: { ...PRINCIPALS, alice: { role: "member", kind: "person" } } }), [
    add("alice", { caller: caller("alice") }), confirm(), validate(), deliver(),
    { op: "principal", person: "alice", principal: { role: "member", kind: "person", agentRights: { main: "use" } } }, validate(), deliver(), deliver({ agentId: "other" }), validate({ agentId: "" }),
    { op: "principal", person: "alice", principal: { role: "viewer", kind: "person", agentRights: { main: "use" } } }, validate(), deliver(),
    { op: "principal", person: "alice", principal: { role: "owner" } }, validate(), { op: "principal", person: "alice", principal: null }, validate(),
    { op: "principal", person: "alice", principal: PRINCIPALS.alice }, { op: "world", patch: { sendOk: false } }, deliver(), { op: "world", patch: { sendOk: true, sendThrows: true } }, deliver(), { op: "world", patch: { sendThrows: false } },
    validate({ id: "missing", nth: undefined }), deliver({ id: "missing", nth: undefined }),
    { op: "hook", hook: { kind: "world", patch: { chat: "" } } }, deliver(),
  ]));
  out.push(await run("subscribe-and-notify", world({ links: [{ ...TG, human: "alice" }, { ...TG, userId: "adas", human: "ada" }, { ...TG, userId: "mias", human: "mia" }], principals: { ...PRINCIPALS, mia: { role: "member", kind: "person", agentRights: { main: "use" } } } }), [
    add(), confirm(),
    add("ada", { identity: { ...TG, userId: "adas" } }), confirm({ person: "ada", msg: { senderId: "adas" }, text: "/delivery {code1}" }),
    add("mia", { identity: { ...TG, userId: "mias" } }), confirm({ person: "mia", msg: { senderId: "mias" }, text: "/delivery {code2}" }),
    subscribe({ source: "system", job: "models.scan" }), subscribe({ nth: 1, source: "system", job: "models.scan", caller: caller("ada"), person: "ada" }), subscribe({ nth: 2, source: "system", job: "models.scan", caller: caller("mia") }),
    subscribe({ nth: 2, source: "dreams", job: "light", caller: caller("mia") }), subscribe({ source: "other" }), subscribe({ job: "" }), subscribe({ job: "a".repeat(65) }), subscribe({ job: "a".repeat(64) }), subscribe({ job: "bad job" }), subscribe({ job: "bad\n" }), subscribe({ job: "ok._-9" }), subscribe({ agentId: "" }),
    subscribe({ job: "heavy" }), subscribe({ job: "heavy" }),
    { op: "notify", source: "system", job: "models.scan", outcome: "failed" }, { op: "notify", source: "system", job: "models.scan", agentId: "main", outcome: "completed" }, { op: "notify", source: "system", job: "models.scan", agentId: "other", outcome: "completed" },
    { op: "notify", source: "dreams", job: "light", outcome: "done" }, { op: "notify", source: "dreams", job: "nothing", outcome: "done" },
    { op: "principal", person: "ada", principal: { role: "member", kind: "person", agentRights: { main: "use" } } }, { op: "notify", source: "system", job: "models.scan", outcome: "after demotion" },
    { op: "world", patch: { allowed: [] } }, { op: "notify", source: "dreams", job: "light", outcome: "nobody allowed" },
  ]));
  const subs = Array.from({ length: 34 }, (_, i) => subscribe({ job: `job${i}` }));
  out.push(await run("subscription-list-keeps-the-last-32", world(), [add(), confirm(), ...subs, subscribe({ job: "job5" }), { op: "notify", source: "dreams", job: "job0", outcome: "x" }, { op: "notify", source: "dreams", job: "job2", outcome: "x" }, { op: "notify", source: "dreams", job: "job33", outcome: "x" }]));
  out.push(await run("eligible-and-list", world({ links: [{ ...TG, human: "alice" }, { ...TG, userId: "second", human: "alice" }, { ...TG, userId: "gone", human: "alice", revoked: true }, { ...TG, userId: "bobs", human: "bob" }] }), [
    { op: "eligible", caller: caller() }, { op: "eligible", caller: caller("bob") }, { op: "world", patch: { allowed: [{ ...TG, userId: "second" }] } }, { op: "eligible", caller: caller() }, { op: "eligible", caller: caller("nobody") },
    { op: "world", patch: { allowed: null } }, add(), confirm(), list(), { op: "unlink", ...TG }, list(), { op: "link", link: { ...TG, human: "alice" } }, list(), { op: "world", patch: { allowed: [] } }, list(),
  ]));
  out.push(await run("restart-and-audit", world(), [
    { op: "auditFail", fail: true }, add(), list(), { op: "auditFail", fail: false }, add(), confirm(), { op: "reopen" }, validate(), deliver(), { op: "auditFail", fail: true }, confirm({ text: "/delivery {code}" }), { op: "remove", nth: 0, caller: caller() }, list(), { op: "auditFail", fail: false }, { op: "remove", nth: 0, caller: caller("bob") }, { op: "remove", nth: 0, caller: caller() }, { op: "remove", nth: 0, caller: caller() },
  ]));
  return out;
}

// --- deliveryAllowed -----------------------------------------------------------------------------------------------
function policyCases() {
  const lists: unknown[][] = [[], ["123456789"], [123456789], [987654321, "42"], [{ toString: () => "123456789" }], [null], [true], [["123456789"]], [1e21], [0.5], [12345678901234567890], [1.5e300], [0], ["0"], [" 123456789"], ["123456789 "], ["abc", 5, "U1", 7],
    ["U1"], ["u1"], ["@u:hs"], ["0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"], ["0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF"], ["npub1notreal"], [""], ["x".repeat(64)]];
  const ids = ["123456789", "42", "U1", "1e+21", "0.5", "12345678901234567000", "1.5e+300", "0", "", "u1", "@u:hs", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "NaN", "[object Object]", "1,2"];
  const out: any[] = [];
  const buzz: Record<string, string | null> = {};
  const record = (v: unknown) => { if (typeof v === "string" && !(v in buzz)) { try { buzz[v] = publicKey(v); } catch { buzz[v] = null; } } };
  const channels = ["telegram", "discord", "matrix", "slack", "buzz", "signal", "email", "mattermost", "constructor", "__proto__", "toString", "hasOwnProperty", ""];
  const shapes = (list: unknown[]) => [{ enabled: true, allowlist: list }, { enabled: true, dmAllowlist: list }, { enabled: true, senderAllowlist: list }, { enabled: true, allowlist: ["x"], dmAllowlist: list, senderAllowlist: list }, { enabled: false, allowlist: list, dmAllowlist: list, senderAllowlist: list }, { enabled: "true", allowlist: list, dmAllowlist: list, senderAllowlist: list }, { allowlist: list, dmAllowlist: list, senderAllowlist: list }];
  for (const channel of channels) for (const list of lists) for (const cfg of shapes(list)) for (const userId of ids) {
    // The grid is thinned: telegram gets every id, slack and buzz a few, every other channel two ids and the three list shapes.
    const main = ["telegram", "slack", "buzz"].includes(channel);
    if (channel === "telegram" ? !["123456789", "42", "U1", "1e+21", "0.5", "0", ""].includes(userId) : channel === "buzz" ? !["0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "U1"].includes(userId) : main ? !["U1", "123456789"].includes(userId) : userId !== "123456789") continue;
    if (!main && !(cfg as any).enabled) continue;
    if (!main && !(cfg as any).allowlist && !(cfg as any).dmAllowlist && !(cfg as any).senderAllowlist) continue;
    if (!main && (cfg as any).allowlist && (cfg as any).dmAllowlist && (cfg as any).senderAllowlist) continue;
    out.push({ channels: { [channel]: cfg }, identity: { channel, accountId: "acct", userId } });
  }
  out.push({ channels: {}, identity: { channel: "telegram", accountId: "a", userId: "1" } }, { channels: { telegram: null }, identity: { channel: "telegram", accountId: "a", userId: "1" } }, { channels: { telegram: "x" }, identity: { channel: "telegram", accountId: "a", userId: "1" } }, { channels: { telegram: [] }, identity: { channel: "telegram", accountId: "a", userId: "1" } }, { channels: { telegram: { enabled: true, allowlist: "1" } }, identity: { channel: "telegram", accountId: "a", userId: "1" } }, { channels: { telegram: { enabled: true, allowlist: { 0: "1", length: 1 } } }, identity: { channel: "telegram", accountId: "a", userId: "1" } });
  for (const c of out) for (const cfg of Object.values(c.channels as Record<string, any>)) for (const k of ["allowlist", "dmAllowlist", "senderAllowlist"]) if (Array.isArray(cfg?.[k])) cfg[k].forEach(record);
  const cases = out.map((c) => ({ ...c, allowed: deliveryAllowed({ channels: c.channels } as any, c.identity) }));
  return { buzzKeys: buzz, cases };
}

export async function buildDeliveryVectors() {
  random = installScriptedRandom();
  try {
    return { policy: policyCases(), rules: await scenarios() };
  } finally { random.restore(); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await exporterMain({ area: "delivery", build: buildDeliveryVectors });
}
