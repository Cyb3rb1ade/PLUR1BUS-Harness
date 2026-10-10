import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChannelHost } from "../../core/src/channels/types.ts";
import type { IdentityService } from "../../core/src/identity/service.ts";
import { parseMessage, UnsupportedError, type ApprovalDecision, type RichInbound } from "../src/index.ts";
import { ALLOWED, BOT, CAROL, IMAP_PW, SMTP_PW, STRANGER, fixtureMail, makeEmailFixture } from "./helpers/contract.ts";

interface HostRec {
  host: ChannelHost;
  received: { text: string; chatId: string }[];
  failures: unknown[];
}
function hostRec(): HostRec {
  const r: HostRec = {
    received: [],
    failures: [],
    host: {
      receive: async (m) => {
        r.received.push({ text: m.text, chatId: m.chatId });
      },
      fail: (e) => {
        r.failures.push(e);
      },
      log: { info() {}, warn() {}, error() {} },
    },
  };
  return r;
}

test("start rejects on a missing secret without leaking anything", async () => {
  const fx = await makeEmailFixture();
  try {
    const ch = fx.make(true);
    await assert.rejects(ch.start(hostRec().host), (e: Error) => !/invented|password-/.test(e.message) && e.message.length > 0);
    assert.equal((await ch.health()).ok, false);
  } finally {
    await fx.dispose();
  }
});

test("lifecycle: idempotent start, rich + framework inbound, idempotent stop, health", async () => {
  const fx = await makeEmailFixture();
  const h = hostRec();
  const rich: RichInbound[] = [];
  try {
    const ch = fx.channel;
    const p1 = ch.start(h.host);
    const p2 = ch.start(h.host);
    await Promise.all([p1, p2]);
    await ch.start(h.host);
    ch.onMessage((m) => {
      rich.push(m);
    });
    assert.equal((await ch.health()).ok, true);
    await fx.deliver(ALLOWED, "hallo bot");
    assert.equal(rich.length, 1);
    assert.equal(rich[0]!.text, "hallo bot");
    assert.equal(rich[0]!.senderId, ALLOWED);
    assert.equal(rich[0]!.auth.dmarc, "pass");
    assert.deepEqual(h.received.map((r) => r.text), ["hallo bot"]);
    await ch.stop();
    await ch.stop();
    assert.equal((await ch.health()).ok, false);
    await ch.start(h.host);
    assert.equal((await ch.health()).ok, true);
  } finally {
    await fx.dispose();
  }
});

test("stranger mail is dropped silently but still marked seen", async () => {
  const fx = await makeEmailFixture();
  const h = hostRec();
  try {
    await fx.channel.start(h.host);
    await fx.deliver(STRANGER, "let me in");
    assert.equal(h.received.length, 0);
    assert.ok(fx.logs.some((l) => (l as { event: string }).event === "channel.email.sender-not-allowed"));
  } finally {
    await fx.dispose();
  }
});

const LOOP_CASES: [string, string][] = [
  ["auto-submitted", "Auto-Submitted: auto-replied"],
  ["precedence bulk", "Precedence: bulk"],
  ["x-auto-response-suppress", "X-Auto-Response-Suppress: All"],
  ["list-id", "List-Id: <list.example.test>"],
  ["autoreply header", "X-Autoreply: yes"],
];
for (const [name, header] of LOOP_CASES) {
  test(`loop prevention: ${name} is never handled`, async () => {
    const fx = await makeEmailFixture();
    const h = hostRec();
    try {
      await fx.channel.start(h.host);
      await fx.deliverRaw(fixtureMail({ from: ALLOWED, body: "auto", messageId: `loop-${name}@x`, extraHeaders: [header] }));
      assert.equal(h.received.length, 0);
    } finally {
      await fx.dispose();
    }
  });
}

test("duplicate Message-ID is processed once", async () => {
  const fx = await makeEmailFixture();
  const h = hostRec();
  try {
    await fx.channel.start(h.host);
    await fx.deliverRaw(fixtureMail({ from: ALLOWED, body: "once", messageId: "same@x" }));
    await fx.deliverRaw(fixtureMail({ from: ALLOWED, body: "once", messageId: "same@x" }));
    assert.equal(h.received.length, 1);
  } finally {
    await fx.dispose();
  }
});

test("requireAuthPass: dmarc=fail is dropped, dmarc=pass passes", async () => {
  const fx = await makeEmailFixture();
  const h = hostRec();
  const ch = fx.make(false, { requireAuthPass: true });
  try {
    await ch.start(h.host);
    await fx.deliverRaw(fixtureMail({ from: ALLOWED, body: "forged", messageId: "f1@x", auth: "mx.test; dmarc=fail" }));
    assert.equal(h.received.length, 0);
    await fx.deliverRaw(fixtureMail({ from: ALLOWED, body: "genuine", messageId: "g1@x", auth: "mx.test; dmarc=pass" }));
    assert.deepEqual(h.received.map((r) => r.text), ["genuine"]);
  } finally {
    await ch.stop();
    await fx.dispose();
  }
});

test("requireAuthPass without authServId drops everything; forged trusted-looking header is ignored", async () => {
  const fx = await makeEmailFixture();
  const h = hostRec();
  const ch = fx.make(false, { requireAuthPass: true, noAuthServId: true });
  try {
    await ch.start(h.host);
    await fx.deliverRaw(fixtureMail({ from: ALLOWED, body: "x", messageId: "u1@x", auth: "mx.test; dmarc=pass" }));
    assert.equal(h.received.length, 0);
  } finally {
    await ch.stop();
    await fx.dispose();
  }
});

test("a foreign authserv-id claiming dmarc=pass does not pass requireAuthPass", async () => {
  const fx = await makeEmailFixture();
  const h = hostRec();
  const ch = fx.make(false, { requireAuthPass: true });
  try {
    await ch.start(h.host);
    await fx.deliverRaw(fixtureMail({ from: ALLOWED, body: "x", messageId: "fa1@x", auth: "attacker.example; dmarc=pass" }));
    assert.equal(h.received.length, 0);
  } finally {
    await ch.stop();
    await fx.dispose();
  }
});

test("inbound quoted history and signature are stripped; attachments go to rich onMessage only", async () => {
  const fx = await makeEmailFixture();
  const h = hostRec();
  const rich: RichInbound[] = [];
  try {
    await fx.channel.start(h.host);
    fx.channel.onMessage((m) => void rich.push(m));
    const raw = Buffer.from(
      [
        "Authentication-Results: mx.test; dmarc=pass",
        `From: ${ALLOWED}`,
        "Subject: with file",
        "Message-ID: <att1@x>",
        'Content-Type: multipart/mixed; boundary="M"',
        "",
        "--M",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "please check",
        "> quoted",
        "-- ",
        "sig",
        "--M",
        'Content-Type: image/png; name="a.png"',
        'Content-Disposition: attachment; filename="a.png"',
        "Content-Transfer-Encoding: base64",
        "",
        Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"),
        "--M--",
        "",
      ].join("\r\n"),
      "utf8",
    );
    await fx.deliverRaw(raw);
    assert.equal(rich.length, 1);
    assert.equal(rich[0]!.text, "please check");
    assert.equal(rich[0]!.attachments?.[0]?.kind, "image");
    assert.deepEqual([...rich[0]!.attachments![0]!.data], [0x89, 0x50, 0x4e, 0x47]);
    assert.equal(h.received.length, 0, "rich-only turns are not forwarded as text");
    assert.ok(fx.logs.some((l) => (l as { event: string }).event === "channel.email.framework-rich-turn-gap"));
  } finally {
    await fx.dispose();
  }
});

test("oversized message is skipped before any body is handled", async () => {
  const fx = await makeEmailFixture();
  const h = hostRec();
  const ch = fx.make(false, { maxMessageBytes: 200 });
  try {
    await ch.start(h.host);
    await fx.deliverRaw(fixtureMail({ from: ALLOWED, body: "x".repeat(500), messageId: "big@x" }));
    assert.equal(h.received.length, 0);
    assert.ok(fx.logs.some((l) => (l as { event: string }).event === "channel.email.oversized-skipped"));
  } finally {
    await ch.stop();
    await fx.dispose();
  }
});

test("threading: reply carries In-Reply-To and References, Re: subject, markdown converted", async () => {
  const fx = await makeEmailFixture();
  const h = hostRec();
  try {
    await fx.channel.start(h.host);
    const chatIds: string[] = [];
    fx.channel.onMessage((m) => void chatIds.push(m.chatId));
    await fx.deliverRaw(fixtureMail({ from: ALLOWED, subject: "Plan", body: "start", messageId: "root@x" }));
    await fx.deliverRaw(fixtureMail({ from: ALLOWED, subject: "Re: Plan", body: "more", messageId: "second@x", extraHeaders: ["References: <root@x>"] }));
    assert.equal(chatIds[0], chatIds[1], "one thread, one chat");
    const refs = await fx.channel.sendTurn({ chatId: chatIds[0]!, text: "**done**" });
    assert.equal(refs.length, 1);
    const sent = parseMessage(fx.smtp.received.at(-1)!.data);
    assert.equal(sent.subject, "Re: Plan");
    assert.equal(sent.inReplyTo, "second@x");
    assert.deepEqual(sent.references, ["root@x", "second@x"]);
    assert.equal(sent.text, "**done**");
    assert.equal(sent.headers.get("auto-submitted"), "auto-replied");
    assert.equal(sent.headers.get("precedence"), undefined);
    assert.equal(sent.to[0]?.address, ALLOWED);
    assert.equal(sent.from?.address, BOT);
    assert.equal(sent.contentType, "multipart/alternative", "text and HTML parts");
  } finally {
    await fx.dispose();
  }
});

test("sendTurn: unknown thread, disallowed peer and unsupported MIME are refused", async () => {
  const fx = await makeEmailFixture();
  const h = hostRec();
  try {
    await fx.channel.start(h.host);
    await assert.rejects(fx.channel.sendTurn({ chatId: "t-00000000000000000000000000000000", text: "x" }), /unknown email thread/);
    fx.channel.onMessage(() => {});
    const got: string[] = [];
    fx.channel.onMessage((m) => void got.push(m.chatId));
    await fx.deliverRaw(fixtureMail({ from: ALLOWED, body: "hi", messageId: "peer@x" }));
    const chatId = got[0]!;
    await assert.rejects(
      fx.channel.sendTurn({
        chatId,
        text: "x",
        attachments: [{ kind: "file", data: Buffer.from("MZ"), mimeType: "application/x-msdownload", filename: "x.exe" }],
      }),
      /unsupported media/,
    );
    await assert.rejects(fx.channel.edit({ chatId, id: "x" }, "y"), (e: unknown) => e instanceof UnsupportedError);
  } finally {
    await fx.dispose();
  }
});

test("approval by email: prompt, valid code accepted once, replay and wrong-thread refused", async () => {
  const fx = await makeEmailFixture();
  const h = hostRec();
  const ch = fx.make(false, { dmAllowlist: [ALLOWED, CAROL] });
  const decisions: ApprovalDecision[] = [];
  try {
    await ch.start(h.host);
    ch.onDecision((d) => void decisions.push(d));
    let chatId = "";
    let rootId = "";
    ch.onMessage((m) => {
      chatId = m.chatId;
      rootId = m.rootMessageId;
    });
    await fx.deliverRaw(fixtureMail({ from: ALLOWED, body: "run the tool", messageId: "req@x" }));
    const { promptId } = await ch.prompt({
      chatId,
      text: "Allow the tool to run?",
      choices: [
        { id: "once", label: "once" },
        { id: "deny", label: "deny" },
      ],
      approverIds: [ALLOWED],
    });
    const mail = parseMessage(fx.smtp.received.at(-1)!.data);
    const code = /\[approval ([0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4})\]/.exec(mail.subject)?.[1];
    assert.ok(code, mail.subject);
    assert.ok(mail.text.includes(`${code} 1`) && mail.text.includes(`${code} 2`));
    const promptMsg = mail.messageId!;
    const reply = (id: string, from: string, line: string, root = rootId) =>
      fixtureMail({ from, body: line, messageId: id, extraHeaders: [`References: <${root}> <${promptMsg}>`, `In-Reply-To: <${promptMsg}>`] });
    await fx.deliverRaw(reply("ok1@x", ALLOWED, `${code} 1`));
    assert.equal(decisions.length, 1);
    assert.deepEqual({ ...decisions[0], at: 0 }, { promptId, chatId, senderId: ALLOWED, choiceId: "once", at: 0 });
    await fx.deliverRaw(reply("replay@x", ALLOWED, `${code} 1`));
    assert.equal(decisions.length, 1, "replay is never a decision");
    await fx.deliverRaw(reply("wrong@x", CAROL, `${code} 2`));
    assert.equal(decisions.length, 1, "non-approver is never a decision");
    await fx.deliverRaw(reply("thread@x", ALLOWED, `${code} 2`, "some-other-root@x"));
    assert.equal(decisions.length, 1, "wrong thread is never a decision");
  } finally {
    await ch.stop();
    await fx.dispose();
  }
});

test("approval codes expire", async () => {
  const fx = await makeEmailFixture();
  const h = hostRec();
  try {
    await fx.channel.start(h.host);
    const decisions: ApprovalDecision[] = [];
    fx.channel.onDecision((d) => void decisions.push(d));
    let chatId = "";
    let rootId = "";
    fx.channel.onMessage((m) => {
      chatId = m.chatId;
      rootId = m.rootMessageId;
    });
    await fx.deliverRaw(fixtureMail({ from: ALLOWED, body: "go", messageId: "req2@x" }));
    await fx.channel.prompt({ chatId, text: "ok?", choices: [{ id: "once", label: "once" }], approverIds: [ALLOWED], ttlMs: 60_000 });
    const code = /\[approval ([0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4})\]/.exec(parseMessage(fx.smtp.received.at(-1)!.data).subject)![1]!;
    fx.setClock(fx.now() + 61_000);
    await fx.deliverRaw(fixtureMail({ from: ALLOWED, body: `${code} 1`, messageId: "late@x", extraHeaders: [`References: <${rootId}>`] }));
    assert.equal(decisions.length, 0);
  } finally {
    await fx.dispose();
  }
});

test("prompt validates TTL, choices and approvers", async () => {
  const fx = await makeEmailFixture();
  const h = hostRec();
  try {
    await fx.channel.start(h.host);
    let chatId = "";
    fx.channel.onMessage((m) => void (chatId = m.chatId));
    await fx.deliverRaw(fixtureMail({ from: ALLOWED, body: "x", messageId: "p-req@x" }));
    const base = { chatId, text: "?", choices: [{ id: "a", label: "a" }], approverIds: [ALLOWED] };
    await assert.rejects(fx.channel.prompt({ ...base, ttlMs: 25 * 3600_000 }), RangeError);
    await assert.rejects(fx.channel.prompt({ ...base, ttlMs: 500 }), RangeError);
    await assert.rejects(fx.channel.prompt({ ...base, choices: [] }), RangeError);
    await assert.rejects(fx.channel.prompt({ ...base, approverIds: [STRANGER] }), /allowlist/);
  } finally {
    await fx.dispose();
  }
});

test("/link: claimed for the sender address, uniform reply, the code is never logged", async () => {
  const claims: unknown[] = [];
  let fail = false;
  const pairing = {
    claim: (p: unknown) => {
      claims.push(p);
      if (fail) throw new Error("no");
      return { pairingId: "p", state: "awaiting-confirmation", confirmBy: 0 };
    },
  } as unknown as Pick<IdentityService, "claim">;
  const fx = await makeEmailFixture();
  const ch = fx.make(false, { pairing });
  const h = hostRec();
  try {
    await ch.start(h.host);
    fx.channel.onMessage(() => {});
    await fx.deliverRaw(fixtureMail({ from: ALLOWED, subject: "link LINKCODE9", body: "hi", messageId: "l1@x" }));
    await fx.deliverRaw(fixtureMail({ from: ALLOWED, body: "/link LINKCODE9", messageId: "l2@x" }));
    assert.equal(claims.length, 2);
    assert.deepEqual(claims[0], { code: "LINKCODE9", identity: { channel: "email", accountId: BOT, userId: ALLOWED } });
    fail = true;
    await fx.deliverRaw(fixtureMail({ from: ALLOWED, body: "link ANOTHERCODE", messageId: "l3@x" }));
    const replies = fx.smtp.received.map((r) => parseMessage(r.data).text.trim());
    assert.ok(replies.some((t) => t.includes("Pairing ID: p") && t.includes("plur1bus identity approve p")));
    assert.ok(replies.every((t) => !t.includes("LINKCODE9") && !t.includes("ANOTHERCODE")));
    assert.ok(replies.some((t) => t.startsWith("Pairing failed")));
    assert.ok(!JSON.stringify(fx.logs).includes("LINKCODE9") && !JSON.stringify(fx.logs).includes("ANOTHERCODE"));
    assert.equal(h.received.length, 0, "link commands are not forwarded as text");
  } finally {
    await ch.stop();
    await fx.dispose();
  }
});

test("without pairing the /link text is ordinary text", async () => {
  const fx = await makeEmailFixture();
  const h = hostRec();
  try {
    await fx.channel.start(h.host);
    await fx.deliverRaw(fixtureMail({ from: ALLOWED, body: "link ABCD1234", messageId: "nol@x" }));
    assert.deepEqual(h.received.map((r) => r.text), ["link ABCD1234"]);
  } finally {
    await fx.dispose();
  }
});

test("thread peer mismatch: another sender cannot inject into an existing thread", async () => {
  const fx = await makeEmailFixture();
  const h = hostRec();
  const ch = fx.make(false, { dmAllowlist: [ALLOWED, CAROL] });
  try {
    await ch.start(h.host);
    const ids: string[] = [];
    ch.onMessage((m) => void ids.push(m.chatId));
    await fx.deliverRaw(fixtureMail({ from: ALLOWED, body: "mine", messageId: "tm-root@x" }));
    await fx.deliverRaw(fixtureMail({ from: CAROL, body: "injected", messageId: "tm-2@x", extraHeaders: ["References: <tm-root@x>"] }));
    assert.equal(ids.length, 1);
    assert.ok(fx.logs.some((l) => (l as { event: string }).event === "channel.email.thread-peer-mismatch"));
  } finally {
    await ch.stop();
    await fx.dispose();
  }
});

test("reconnects after a dropped connection and keeps delivering", async () => {
  const fx = await makeEmailFixture();
  const h = hostRec();
  try {
    await fx.channel.start(h.host);
    fx.imap.dropOnSelect = 1;
    await fx.deliverRaw(fixtureMail({ from: ALLOWED, body: "after drop", messageId: "rc@x" }));
    assert.deepEqual(h.received.map((r) => r.text), ["after drop"]);
    assert.ok(fx.logs.some((l) => (l as { event: string }).event === "channel.email.reconnect"));
  } finally {
    await fx.dispose();
  }
});

test("runtime auth failure after reconnect is fatal: host.fail, no retry storm", async () => {
  const fx = await makeEmailFixture();
  const h = hostRec();
  try {
    await fx.channel.start(h.host);
    fx.imap.opts.password = "rotated-elsewhere";
    fx.imap.dropOnSelect = 1;
    fx.release();
    await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < 200 && h.failures.length === 0; i++) {
      fx.release();
      await new Promise((r) => setImmediate(r));
    }
    assert.equal(h.failures.length, 1);
    assert.equal((h.failures[0] as Error).message, "email authentication failed");
    assert.equal((await fx.channel.health()).ok, false);
  } finally {
    await fx.dispose();
  }
});

test("health: SMTP is checked lazily (one NOOP per window), detail is content-free", async () => {
  const fx = await makeEmailFixture();
  const h = hostRec();
  try {
    await fx.channel.start(h.host);
    const first = await fx.channel.health();
    assert.equal(first.ok, true);
    assert.match(first.detail ?? "", /imap:up smtp:ok/);
    await fx.channel.health();
    assert.equal(fx.smtp.commands.filter((c) => c === "NOOP").length, 1);
  } finally {
    await fx.dispose();
  }
});

test("logs never contain passwords or message content", async () => {
  const fx = await makeEmailFixture();
  const h = hostRec();
  try {
    await fx.channel.start(h.host);
    await fx.deliverRaw(fixtureMail({ from: ALLOWED, subject: "SECRETSUBJECT", body: "SECRETBODY", messageId: "log@x" }));
    const text = JSON.stringify(fx.logs);
    assert.ok(!text.includes(IMAP_PW) && !text.includes(SMTP_PW));
    assert.ok(!text.includes("SECRETBODY") && !text.includes("SECRETSUBJECT"));
    assert.ok(!text.includes(ALLOWED) && !text.includes("alice@"));
  } finally {
    await fx.dispose();
  }
});

test("outbound rate limit per peer is enforced", async () => {
  const fx = await makeEmailFixture();
  const h = hostRec();
  try {
    await fx.channel.start(h.host);
    let chatId = "";
    fx.channel.onMessage((m) => void (chatId = m.chatId));
    await fx.deliverRaw(fixtureMail({ from: ALLOWED, body: "x", messageId: "rl@x" }));
    let sent = 0;
    let limited = false;
    for (let i = 0; i < 40 && !limited; i++) {
      try {
        await fx.channel.sendTurn({ chatId, text: `m${i}` });
        sent++;
      } catch (e) {
        limited = /rate limit/.test((e as Error).message);
      }
    }
    assert.equal(sent, 30);
    assert.ok(limited);
  } finally {
    await fx.dispose();
  }
});

test("harness: the shared contract helper wires a working channel", async () => {
  const { makeContractHarness } = await import("./helpers/contract.ts");
  const hx = await makeContractHarness();
  try {
    assert.equal(hx.name, "email");
    assert.equal(hx.channel.name, "email");
    await hx.withMissingSecret().then((c) => assert.rejects(c.start()));
    await hx.channel.start(hostRec().host);
    await hx.deliverDirect("from the contract");
    await hx.deliverGroupUnmentioned("stranger");
    assert.ok(hx.logs.length > 0);
  } finally {
    await hx.dispose();
  }
});

// ---- Identity-bearing actions (/link, approvals) need a trusted DMARC pass, whatever requireAuthPass says ----
const IDENTITY_CASES: { name: string; auth: string | null; noAuthServId?: boolean; allowed: boolean }[] = [
  { name: "forged From, no Authentication-Results", auth: null, allowed: false },
  { name: "dmarc=pass from the trusted authserv-id", auth: "mx.test; dmarc=pass", allowed: true },
  {
    name: "spf and dkim pass without dmarc",
    auth: "mx.test; spf=pass smtp.mailfrom=x.example; dkim=pass header.d=x.example",
    allowed: false,
  },
  { name: "dmarc=fail", auth: "mx.test; dmarc=fail", allowed: false },
  { name: "dmarc=pass from a foreign authserv-id", auth: "attacker.example; dmarc=pass", allowed: false },
  { name: "dmarc=pass but no authServId configured", auth: "mx.test; dmarc=pass", noAuthServId: true, allowed: false },
];
for (const c of IDENTITY_CASES) {
  test(`identity actions: ${c.name}`, async () => {
    const claims: unknown[] = [];
    const pairing = {
      claim: (p: unknown) => {
        claims.push(p);
        return { pairingId: "p", state: "awaiting-confirmation", confirmBy: 0 };
      },
    } as unknown as Pick<IdentityService, "claim">;
    const fx = await makeEmailFixture();
    const ch = fx.make(false, { pairing, noAuthServId: c.noAuthServId ?? false });
    const h = hostRec();
    const decisions: ApprovalDecision[] = [];
    let chatId = "";
    let root = "";
    ch.onMessage((m) => {
      chatId = m.chatId;
      root = m.rootMessageId;
    });
    ch.onDecision((d) => void decisions.push(d));
    try {
      await ch.start(h.host);
      await fx.deliverRaw(fixtureMail({ from: ALLOWED, body: "start", messageId: "idc-root@x" }));
      const { promptId } = await ch.prompt({
        chatId,
        text: "ok?",
        choices: [{ id: "once", label: "once" }],
        approverIds: [ALLOWED],
      });
      const promptMail = parseMessage(fx.smtp.received.at(-1)!.data);
      const code = /\[approval ([0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4})\]/.exec(promptMail.subject)![1]!;
      await fx.deliverRaw(
        fixtureMail({
          from: ALLOWED,
          body: `${code} 1`,
          messageId: "idc-approve@x",
          auth: c.auth,
          extraHeaders: [`References: <${root}> <${promptMail.messageId}>`],
        }),
      );
      await fx.deliverRaw(fixtureMail({ from: ALLOWED, body: "link LINKCODE1", messageId: "idc-link@x", auth: c.auth }));
      if (c.allowed) {
        assert.equal(claims.length, 1);
        assert.equal(decisions.length, 1);
        assert.equal(decisions[0]!.promptId, promptId);
        assert.equal(decisions[0]!.choiceId, "once");
      } else {
        assert.equal(claims.length, 0, "forged or unaligned mail must not bind an identity");
        assert.equal(decisions.length, 0, "forged or unaligned mail must not approve");
        assert.ok(!JSON.stringify(fx.logs).includes("LINKCODE1"), "code never logged");
        assert.ok(!JSON.stringify(fx.logs).includes(code), "approval code never logged");
      }
    } finally {
      await ch.stop();
      await fx.dispose();
    }
  });
}
