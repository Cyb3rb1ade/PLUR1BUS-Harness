// Inbox, delivery and channel hand-off store round trip, parity mode B (P4-K K3b, plan P4-22): the TypeScript side that
// `crates/plur1bus-core/tests/k3b_mode_b.rs` drives.
//
//   node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning tests/core-parity/k3b-b-driver.ts prepare <dir>
//   node ... tests/core-parity/k3b-b-driver.ts verify <dir>
//
// `prepare` writes real TypeScript files into <dir>, with the product code of each store:
//   handoff-ts.sqlite    a direct session observed and one link issued, a group session tainted
//   delivery-ts.sqlite   a confirmed target and an unconfirmed one
//   inbox-ts.sqlite      two entries, one of them read
//   *-ref.sqlite         the same stores opened and closed with no data: the reference for the schema text of a fresh Rust file
//   manifest.json        the clock, the ids and the token the Rust test needs
// The Rust test reads and writes copies (`*-rust.sqlite`) and creates fresh files (`*-fresh-rust.sqlite`); `verify` opens those
// with the product code (on copies) and prints one JSON object. Test tooling only; no product code imports it.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StoreCopy } from "./store-roundtrip.ts";
import { ChannelHandoff } from "../../packages/core/src/channel-handoff/service.ts";
import { DeliveryTargets } from "../../packages/core/src/delivery/service.ts";
import { InboxStore } from "../../packages/core/src/inbox/store.ts";
import { deriveUserPrincipal } from "../../packages/core/src/identity/principals.ts";

const session = (id: string, over: Record<string, unknown> = {}) => ({ id, kind: "channel", ownerPerson: "alice", chatKey: "telegram:dm", agentId: "main", title: "Private DM", updatedAt: 500, messages: [] as unknown[], ...over });
/** The session store `ChannelHandoff` calls, answering from the world (the same shape `scripts/parity/export-handoff.ts` scripts). */
function fakeStore(w: any) {
  const c = (w.counters ??= { continued: 0 });
  const view = (s: any) => ({ id: s.id, kind: s.kind, owner: deriveUserPrincipal(s.ownerPerson), chatKey: s.chatKey, agentId: s.agentId, title: s.title, updatedAt: s.updatedAt, archivedAt: null });
  const find = (id: string) => w.sessions.find((s: any) => s.id === id);
  return {
    getSession: (id: string) => { const s = find(id); return s ? view(s) : undefined; },
    listMessages: (id: string, o?: { limit?: number }) => { const m = find(id)?.messages ?? []; return o?.limit === 1 ? m.slice(0, 1) : m.slice(-(o?.limit ?? 50)); },
    activeForChat: (key: string) => { const s = w.sessions.find((x: any) => x.chatKey === key); return s ? { ...view(s), turnCount: s.messages.length / 2 } : undefined; },
    listSummaries: () => [],
    summaryRewinds: () => [],
    contextMessages: (id: string) => find(id)?.messages ?? [],
    createContinuation: (i: any) => { const s = session(`cont-${++c.continued}`, { kind: "direct", chatKey: null }); w.sessions.push(s); return { id: s.id }; },
  };
}

const NOW = 1_000_000;
const LINK = { channel: "telegram", accountId: "bot", userId: "sender", human: "alice" };
const PRINCIPALS: Record<string, any> = { alice: { role: "owner", kind: "person" } };
const ALICE = { userId: "alice", ...PRINCIPALS.alice };
const TG = { channel: "telegram", accountId: "bot", userId: "sender" };
const dm = (over: Record<string, unknown> = {}) => ({ channel: "telegram", chatId: "dm", chatKind: "direct", senderId: "sender", accountId: "bot", text: "hello", ...over });
const turns = [{ role: "user", text: "question-0", createdAt: 600 }, { role: "assistant", text: "reply-0", createdAt: 601 }];

function handoffWorld(): any {
  return { now: NOW, baseUrl: "https://web.example", agentId: "main", links: [LINK], principals: PRINCIPALS, storeAvailable: true,
    sessions: [session("s1"), session("s2", { chatKey: "telegram:grp", messages: turns }), session("s3", { chatKey: "telegram:dm3" })] };
}
function handoff(path: string, w: any): ChannelHandoff {
  return new ChannelHandoff({
    path, store: () => fakeStore(w) as any,
    identity: () => ({ resolve: (i: any) => { const l = w.links.find((x: any) => x.channel === i.channel && x.accountId === i.accountId && x.userId === i.userId); return l ? { humanId: l.human } : null; } }) as any,
    clock: () => w.now, audit: { append: () => {} } as any,
    resolve: (id: string) => { const p = w.principals[id]; return p ? { userId: id, ...p } : null; },
    agentId: () => w.agentId, baseUrl: () => w.baseUrl,
  } as any);
}

function deliveryOptions(path: string, sent: any[]): any {
  return {
    path, clock: () => NOW,
    identity: () => ({
      resolve: (i: any) => (i.channel === LINK.channel && i.accountId === LINK.accountId && ["sender", "sender2"].includes(i.userId) ? { humanId: "alice" } : null),
      list: () => ({ humans: [{ identities: [{ ...TG, humanId: "alice", revokedAt: null }, { ...TG, userId: "sender2", humanId: "alice", revokedAt: null }] }] }),
    }),
    resolve: (id: string) => { const p = PRINCIPALS[id]; return p ? { userId: id, ...p } : null; },
    audit: { append: () => {} },
    allowed: () => true,
    target: async () => "dm",
    send: async (channel: string, chatId: string, text: string) => { sent.push({ channel, chatId, text }); return true; },
  };
}

async function prepare(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  // The hand-off.
  const w = handoffWorld();
  const h = handoff(join(dir, "handoff-ts.sqlite"), w);
  h.observe(dm() as any, "alice", "s1");
  h.observe(dm({ chatKind: "group", chatId: "grp" }) as any, "alice", "s2");
  const issued = h.issue("s1", "alice");
  h.close();
  handoff(join(dir, "handoff-ref.sqlite"), handoffWorld()).close();
  // Delivery.
  const sent: any[] = [];
  const d = new DeliveryTargets(deliveryOptions(join(dir, "delivery-ts.sqlite"), sent));
  const t1 = await d.add(TG as any, ALICE as any);
  // `add` sends the first code.
  const code = /\/delivery ([a-f0-9]{32})$/.exec(sent[0].text)![1]!;
  if (d.confirmMessage({ ...dm(), text: `/delivery ${code}` } as any, "alice") !== true) throw new Error("setup: the code was refused");
  const t2 = await d.add({ ...TG, userId: "sender2" } as any, ALICE as any);
  d.close();
  new DeliveryTargets(deliveryOptions(join(dir, "delivery-ref.sqlite"), [])).close();
  // The inbox.
  let n = 0;
  const inbox = new InboxStore({ path: join(dir, "inbox-ts.sqlite"), clock: () => NOW, idGen: () => `ts-${++n}` });
  inbox.publish({ userId: "alice", kind: "approval", severity: "warning", titleKey: "inbox.approval", params: { n: 1 }, ref: { route: "/approvals", objectId: "a1" }, dedupeKey: "approval:a1" });
  inbox.publish({ userId: "alice", kind: "update", severity: "info", titleKey: "inbox.update", dedupeKey: "update:u1" });
  inbox.markRead("alice", ["ts-1"]);
  inbox.close();
  new InboxStore({ path: join(dir, "inbox-ref.sqlite"), clock: () => NOW }).close();
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ now: NOW, handoffToken: issued.token, deliveryTarget: t1.id, secondTarget: t2.id }));
}

/** `sqlite_master` without the rows SQLite generates itself, in a stable order: what the code that made the file produced. */
function schemaOf(copy: StoreCopy): string {
  return JSON.stringify(copy.read("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"));
}
const tryOf = <T>(f: () => T): { ok: T } | { err: string } => { try { return { ok: f() }; } catch (e) { return { err: String((e as any)?.code ?? (e as Error).message) }; } };

async function verify(dir: string): Promise<Record<string, unknown>> {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const rust = JSON.parse(readFileSync(join(dir, "rust-results.json"), "utf8"));
  const names = ["handoff-rust", "handoff-fresh-rust", "handoff-ref", "delivery-rust", "delivery-fresh-rust", "delivery-ref", "inbox-rust", "inbox-fresh-rust", "inbox-ref"];
  const c: Record<string, StoreCopy> = {};
  for (const n of names) c[n] = StoreCopy.open(join(dir, `${n}.sqlite`));
  try {
    const out: Record<string, unknown> = {
      sameSchema: {
        handoff: schemaOf(c["handoff-fresh-rust"]!) === schemaOf(c["handoff-ref"]!),
        delivery: schemaOf(c["delivery-fresh-rust"]!) === schemaOf(c["delivery-ref"]!),
        inbox: schemaOf(c["inbox-fresh-rust"]!) === schemaOf(c["inbox-ref"]!),
        handoffWritten: schemaOf(c["handoff-rust"]!) === schemaOf(c["handoff-ref"]!),
        deliveryWritten: schemaOf(c["delivery-rust"]!) === schemaOf(c["delivery-ref"]!),
        inboxWritten: schemaOf(c["inbox-rust"]!) === schemaOf(c["inbox-ref"]!),
      },
    };
    // The product code reads what Rust wrote.
    const w = handoffWorld();
    w.sessions[0].messages = turns;
    const h = handoff(c["handoff-rust"]!.path, w);
    out.handoff = {
      redeemRustLink: tryOf(() => !!h.redeem(rust.handoffRustToken, "alice").sessionId),
      redeemTsLinkAgain: tryOf(() => h.redeem(manifest.handoffToken, "alice").sessionId),
      issueTainted: tryOf(() => h.issue("s2", "alice").token),
      list: tryOf(() => h.list("alice").sessions.map((s: any) => s.id).sort()),
    };
    h.close();
    const sent: any[] = [];
    const d = new DeliveryTargets(deliveryOptions(c["delivery-rust"]!.path, sent));
    const listed = d.list(ALICE as any).map((t: any) => [t.id, t.validated]);
    const delivered = await d.deliver(manifest.secondTarget, "alice", "main", "hello from ts");
    await d.notify("system", "job1", "main", "done");
    d.close();
    out.delivery = { listed, delivered, sent: sent.map((s) => [s.channel, s.chatId, s.text]) };
    const inbox = new InboxStore({ path: c["inbox-rust"]!.path, clock: () => NOW });
    const page = inbox.list("alice", { includeDismissed: true } as any);
    out.inbox = {
      entries: page.entries.map((e: any) => [e.id, e.kind, e.titleKey, e.readAt !== null, e.dismissedAt !== null, e.params, e.ref]),
      unread: inbox.count("alice").total,
      again: inbox.publish({ userId: "alice", kind: "update", severity: "info", titleKey: "inbox.update", dedupeKey: "update:u1" }).created,
    };
    inbox.close();
    return out;
  } finally { for (const x of Object.values(c)) x.dispose(); }
}

const [command, dir] = process.argv.slice(2);
if (!dir || (command !== "prepare" && command !== "verify")) {
  console.error("usage: k3b-b-driver.ts prepare|verify <dir>");
  process.exit(2);
}
if (command === "prepare") await prepare(dir);
else console.log(JSON.stringify(await verify(dir)));
