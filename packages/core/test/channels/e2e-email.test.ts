// The email adapter behind the switchboard host, against the channel's own in-process fake IMAP + SMTP servers (loopback only).
import { test } from "node:test";
import { assert } from "./e2e-assert.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { deriveUserPrincipal } from "../../src/identity/principals.ts";
import { TEST_MESSAGE } from "../../src/rpc/channel-surface.ts";
import { FakeImap } from "../../../channels-email/test/helpers/fake-imap.ts";
import { FakeSmtp } from "../../../channels-email/test/helpers/fake-smtp.ts";
import { fixtureMail } from "../../../channels-email/test/helpers/contract.ts";
import { parseMessage } from "../../../channels-email/src/index.ts";
import { OWNER, flush, type Rig } from "./switchboard-rig.ts";
import { startE2e, type E2e } from "./e2e-rig.ts";
import type { ApprovalView } from "../../src/approvals/service.ts";
import { tempDir } from "../helpers/temp-dir.ts";

const BOT = "bot@example.test";
const PAT = "pat@example.test";
const EVE = "eve@example.test";
const IMAP_PW = "invented-imap-password-9f2c", SMTP_PW = "invented-smtp-password-4b7d";

async function setup(o: { outputs?: unknown; allow?: string[]; requireAuthPass?: boolean } = {}) {
  const imap = new FakeImap({ user: BOT, password: IMAP_PW, starttls: true, requireTlsBeforeAuth: true });
  const smtp = new FakeSmtp({ user: BOT, password: SMTP_PW, starttls: true, requireTlsBeforeAuth: true });
  await imap.listen();
  await smtp.listen();
  // Fake sleep: IDLE timeouts, poll intervals and retries only continue when the test releases them.
  const timers = new Set<() => void>();
  const sleep = (_ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
    const done = () => { timers.delete(done); signal.removeEventListener("abort", done); resolve(); };
    timers.add(done);
    signal.addEventListener("abort", done, { once: true });
  });
  const release = () => { for (const t of [...timers]) t(); };
  const server = (port: number) => ({ host: "127.0.0.1", port, security: "starttls", user: BOT });
  const e2e = await startE2e({
    id: "email",
    adapterDeps: { upgradeTls: async (s: unknown) => s, sleep, random: () => 0.5, ...(o.outputs ? { outputs: o.outputs } : {}) },
    secrets: { "channels.email.imap": IMAP_PW, "channels.email.smtp": SMTP_PW },
    config: {
      address: BOT,
      imap: { ...server(imap.port), passwordSecret: "channels.email.imap", idle: true },
      smtp: { ...server(smtp.port), passwordSecret: "channels.email.smtp" },
      dmAllowlist: o.allow ?? [PAT],
      authServId: "mx.test",
      requireAuthPass: o.requireAuthPass ?? false,
    },
  });
  try { await e2e.until(() => e2e.switchboard.view.status("email")?.state === "running", "email channel running"); } catch (e) { e2e.close(); release(); await imap.close(); await smtp.close(); throw e; }
  await e2e.until(() => imap.commands.length > 0 && imap.authenticated > 0, "imap logged in");
  await flush(20); // the baseline sync (first start never processes history) finishes before any mail is appended
  let n = 0;
  /** Appends a mail and resolves once the adapter has processed (marked seen) it. */
  const deliver = async (from: string, body: string, o2: { subject?: string; auth?: string | null; root?: string } = {}): Promise<string> => {
    const id = `in-${++n}@example.test`;
    const uid = imap.append(fixtureMail({
      from, body, messageId: id, ...(o2.subject !== undefined ? { subject: o2.subject } : {}), ...(o2.auth !== undefined ? { auth: o2.auth } : {}),
      ...(o2.root ? { extraHeaders: [`References: <${o2.root}>`, `In-Reply-To: <${o2.root}>`] } : {}),
    }));
    await e2e.until(() => { release(); return imap.messages.find((m) => m.uid === uid)?.seen === true; }, `mail ${id} processed`);
    return id;
  };
  const mails = () => smtp.received.map((r) => ({ to: r.rcpt, msg: parseMessage(r.data) }));
  const close = async () => { e2e.close(); release(); await imap.close(); await smtp.close(); };
  return { e2e, imap, smtp, deliver, mails, release, close };
}

const approvalFor = (humanId: string, sessionId: string): ApprovalView => ({
  id: "req-1", status: "pending", capability: "net.submit", tool: "demo.net", risk: "medium", principal: humanId,
  subject: { kind: "agent", id: "main" }, actionHash: "h", turnId: "t", taskId: "task", sessionId, createdAt: 0, expiresAt: 600_000, delegable: false,
  summary: "send a mail to a@example.org",
} as ApprovalView);

const sessionOf = (e: Rig, humanId: string) => e.store.listSessions({ owner: deriveUserPrincipal(humanId), kind: "channel" }).sessions[0]!;

test("a linked person's mail runs a turn and the reply is threaded back to the sender; an unlinked sender only gets the pairing notice", async () => {
  const t = await setup({ requireAuthPass: true, allow: [PAT, EVE] });
  try {
    const { humanId } = t.e2e.link("email", BOT, PAT);
    const root = await t.deliver(PAT, "hello bot", { subject: "Question" });
    await t.e2e.until(() => t.mails().length === 1, "reply mail");
    const [reply] = t.mails();
    assert.deepEqual(reply!.to, [PAT]);
    assert.match(reply!.msg.text, /echo:hello bot/);
    assert.equal(reply!.msg.subject, "Re: Question");
    assert.deepEqual(reply!.msg.references, [root]);
    assert.equal(sessionOf(t.e2e, humanId).kind, "channel");
    assert.equal(t.e2e.provider.requests.length, 1);

    // a mail from an allowed but unlinked sender starts no turn
    await t.deliver(EVE, "let me in");
    await t.e2e.until(() => t.mails().length === 2, "pairing notice");
    assert.deepEqual(t.mails()[1]!.to, [EVE]);
    assert.equal(t.e2e.provider.requests.length, 1, "no turn for an unlinked sender");
    assert.doesNotMatch(t.mails()[1]!.msg.text, /echo:/);

    // requireAuthPass: without DMARC pass nothing happens at all
    await t.deliver(PAT, "spoofed", { auth: "mx.test; dmarc=fail" });
    await flush(30);
    assert.equal(t.e2e.provider.requests.length, 1);
    assert.equal(t.mails().length, 2);
  } finally { await t.close(); }
});

test("approval: the prompt mail carries a code; only the approver's DMARC-passing reply with the right code decides", async () => {
  const t = await setup({ allow: [PAT, EVE] });
  try {
    const { humanId } = t.e2e.link("email", BOT, PAT);
    const root = await t.deliver(PAT, "do it");
    await t.e2e.until(() => t.mails().length === 1, "reply mail");
    t.e2e.switchboard.approvalEvents.emit("approval.requested", { approval: approvalFor(humanId, sessionOf(t.e2e, humanId).id), nonce: "nonce-1", foregroundUntil: 1 });
    await t.e2e.until(() => t.mails().length === 2, "prompt mail");
    const prompt = t.mails()[1]!;
    assert.deepEqual(prompt.to, [PAT]);
    assert.match(prompt.msg.text, /demo\.net/);
    assert.doesNotMatch(prompt.msg.text, /nonce-1/);
    const code = /([0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}) 1/.exec(prompt.msg.text)?.[1];
    assert.ok(code, "a code in the prompt");
    assert.match(prompt.msg.subject, new RegExp(code!));

    await t.deliver(EVE, `${code} 1`, { root });                                    // another address
    await t.deliver(PAT, `${code} 1`, { root, auth: "mx.test; dmarc=fail" });         // no DMARC pass
    await t.deliver(PAT, "ZZZZ-ZZZZ 1", { root });                                    // wrong code
    await flush(30);
    assert.deepEqual(t.e2e.approvals.decisions, []);

    await t.deliver(PAT, `${code} 1`, { root });
    await t.e2e.until(() => t.e2e.approvals.decisions.length === 1, "decision");
    assert.deepEqual(t.e2e.approvals.decisions, [{ requestId: "req-1", nonce: "nonce-1", decision: "approve", person: humanId, surface: 2 }]);
    await t.deliver(PAT, `${code} 2`, { root });                                      // a code works once
    await flush(30);
    assert.equal(t.e2e.approvals.decisions.length, 1);
  } finally { await t.close(); }
});

test("channel.test --send-owner mails the fixed test text to the person's address", async () => {
  const t = await setup();
  try {
    const { humanId } = t.e2e.link("email", BOT, PAT);
    const res = await t.e2e.call("channel.test", { id: "email", sendOwner: true }, humanId);
    assert.equal(res.sent, true);
    const [m] = t.mails();
    assert.deepEqual(m!.to, [PAT]);
    assert.equal(m!.msg.text.trim(), TEST_MESSAGE);
  } finally { await t.close(); }
});

test("a person not on the allowlist cannot be sent an owner test mail", async () => {
  const t = await setup({ allow: [EVE] });
  try {
    const { humanId } = t.e2e.link("email", BOT, PAT);
    await assert.rejects(t.e2e.call("channel.test", { id: "email", sendOwner: true }, humanId), /could not be sent/);
    assert.equal(t.mails().length, 0);
  } finally { await t.close(); }
});

test("/link <code> in the subject or the body creates a pending claim, only with a DMARC pass", async () => {
  const t = await setup();
  try {
    const human = t.e2e.identity.createHuman({ displayName: "Pat" }, OWNER);
    const self = { user: human.id, host: "test", kind: "person" as const, role: "member" as const };
    const code1 = t.e2e.identity.startPairing({ humanId: human.id, channel: "email" }, self).code;
    const claimed = () => t.e2e.identity.list({}).pairings.filter((x: { state: string }) => x.state === "claimed");
    await t.deliver(PAT, `/link ${code1}`, { auth: "mx.test; dmarc=fail" });
    await flush(30);
    assert.equal(claimed().length, 0, "no claim without a DMARC pass");

    await t.deliver(PAT, `/link ${code1}`);
    await t.e2e.until(() => claimed().length === 1, "claim recorded");
    assert.deepEqual(claimed()[0]!.claimedBy, { channel: "email", accountId: BOT, userId: PAT });
    assert.equal(t.e2e.provider.requests.length, 0, "a link mail is not a turn");

    const code2 = t.e2e.identity.startPairing({ humanId: human.id, channel: "email" }, self).code;
    await t.deliver(PAT, "", { subject: `link ${code2}` });
    await t.e2e.until(() => claimed().length === 2, "subject claim");
  } finally { await t.close(); }
});

test("media: an image from a turn's tool result follows the text reply as an attachment mail", async () => {
  const root = tempDir("e2e-email-media-");
  const id = "0a1b2c3d-0000-4000-8000-000000000001";
  const bytes = Buffer.from("89504e470d0a1a0a", "hex");
  mkdirSync(join(root, id));
  writeFileSync(join(root, id, "0.png"), bytes);
  const file = { path: "0.png", sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, format: "png" };
  writeFileSync(join(root, id, "manifest.json"), JSON.stringify({ schema: "media.output/1", id, files: [file] }));
  // The host's own `outputs` port is not in the rig (no output store), so this seam stands in for it and authorizes the one id.
  const outputs = {
    store: { root, get: async (x: string) => (x === id ? { id, files: [file] } : null) },
    authorize: async (x: string) => x === id,
  };
  const t = await setup({ outputs });
  try {
    t.e2e.link("email", BOT, PAT);
    t.e2e.provider.script = () => [
      { type: "tool.result", id: "tc-1", output: JSON.stringify({ id, files: [{ path: "0.png", format: "png" }] }) },
      { type: "delta", text: "here is your picture" },
    ];
    await t.deliver(PAT, "draw");
    await t.e2e.until(() => t.mails().length === 2, "text reply and attachment mail");
    assert.match(t.mails()[0]!.msg.text, /here is your picture/);
    const att = t.mails()[1]!.msg;
    assert.deepEqual(t.mails()[1]!.to, [PAT]);
    assert.equal(att.attachments.length, 1);
    assert.equal(att.attachments[0]!.mimeType, "image/png");
    assert.deepEqual(Buffer.from(att.attachments[0]!.data), bytes);
  } finally { await t.close(); }
});
