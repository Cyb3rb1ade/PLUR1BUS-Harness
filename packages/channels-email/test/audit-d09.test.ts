import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ChannelHost } from "../../core/src/channels/types.ts";
import { FileThreadStore, FileUidStore, parseMessage, type SleepFn } from "../src/index.ts";
import { ImapConnection } from "../src/imap.ts";
import { htmlToText } from "../src/html-text.ts";
import { buildMessage } from "../src/mime-build.ts";
import { capReferences } from "../src/threading.ts";
import { defaultConnect } from "../src/wire.ts";
import { ALLOWED, BOT, CAROL, fixtureMail, makeEmailFixture } from "./helpers/contract.ts";

function timed(f: () => void): number {
  const t = process.hrtime.bigint();
  f();
  return Number(process.hrtime.bigint() - t) / 1e6;
}

// ---------- D1: pre-auth CPU exhaustion in the parsers (mail is parsed BEFORE the allowlist is consulted) ----------

test("htmlToText: unterminated '<' floods run in linear time", () => {
  const ms = timed(() => htmlToText("<".repeat(40_000)));
  assert.ok(ms < 2000, `took ${ms} ms`);
});

test("htmlToText: unclosed <a> floods run in linear time", () => {
  const ms = timed(() => htmlToText("<a>".repeat(20_000)));
  assert.ok(ms < 1500, `took ${ms} ms`);
  const ms2 = timed(() => htmlToText("</a>" + "<a href=x>".repeat(20_000)));
  assert.ok(ms2 < 1500, `took ${ms2} ms`);
});

test("htmlToText: behaviour on ordinary and edge input is unchanged", () => {
  assert.equal(htmlToText("a < b"), "a < b");
  assert.equal(htmlToText("<p>x</p><b"), "x\n<b");
  assert.equal(htmlToText('<a href="https://e.test/x">site</a> and <a>bare'), "site (https://e.test/x) and bare");
  assert.equal(htmlToText("keep<!-- gone"), "keep");
});

test("parseMessage: a flood of near-boundary lines is linear", () => {
  const raw = Buffer.from("Content-Type: multipart/mixed; boundary=b\r\n\r\n" + "--bx".repeat(250_000));
  const ms = timed(() => parseMessage(raw));
  assert.ok(ms < 2000, `took ${ms} ms`);
});

test("parseMessage: boundary handling still correct with trailing garbage lines", () => {
  const raw = Buffer.from(
    "Content-Type: multipart/mixed; boundary=b\r\n\r\npre\r\n--b\r\nContent-Type: text/plain\r\n\r\none --bx\r\n--b  \r\nContent-Type: text/plain\r\n\r\ntwo\r\n--b--\r\ntail",
  );
  assert.equal(parseMessage(raw).text, "one --bx\n\ntwo");
});

// ---------- D2: one hostile mail must not kill the channel or wedge the cursor (FileThreadStore validates strictly) ----------

const hostRec = () => {
  const failures: unknown[] = [];
  const received: string[] = [];
  const host: ChannelHost = {
    receive: async (m) => void received.push(m.text),
    fail: (e) => void failures.push(e),
    log: { info() {}, warn() {}, error() {} },
  };
  return { host, failures, received };
};

/** Time-based (not iteration-based) wait, so a heavily loaded CI host cannot turn slowness into a false failure. */
async function seen(fx: Awaited<ReturnType<typeof makeEmailFixture>>, raw: Buffer): Promise<void> {
  const uid = fx.imap.append(raw);
  for (let i = 0; i < 2000; i++) {
    if (fx.imap.messages.find((m) => m.uid === uid)?.seen) return;
    fx.release();
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("mail was not processed");
}

const POISON: [string, (n: number) => Buffer][] = [
  ["very long subject", (n) => fixtureMail({ from: ALLOWED, subject: "s".repeat(1500), body: "x", messageId: `p${n}@x` })],
  [
    "many short References",
    (n) =>
      fixtureMail({
        from: ALLOWED,
        body: "x",
        messageId: `p${n}@x`,
        extraHeaders: [`References: ${Array.from({ length: 200 }, (_, i) => `<r${i}>`).join(" ")}`],
      }),
  ],
  ["over-long sender address", (n) => fixtureMail({ from: `${"a".repeat(400)}@example.test`, body: "x", messageId: `p${n}@x` })],
];
for (const [name, mk] of POISON) {
  test(`poison mail (${name}) cannot make the channel fail or block later mail`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "d09-"));
    const fx = await makeEmailFixture();
    const h = hostRec();
    try {
      const ch = fx.make(false, { dmAllowlist: ["*@example.test"], threadStore: new FileThreadStore(dir) }, new FileUidStore(dir));
      await ch.start(h.host);
      await seen(fx, mk(1));
      await seen(fx, fixtureMail({ from: ALLOWED, body: "still alive", messageId: "ok@x" }));
      assert.deepEqual(h.failures, []);
      assert.ok(h.received.includes("still alive"));
      await ch.stop();
    } finally {
      await fx.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("capReferences also bounds the entry count (root kept)", () => {
  const out = capReferences(Array.from({ length: 300 }, (_, i) => `r${i}`));
  assert.ok(out.length <= 64);
  assert.equal(out[0], "r0");
  assert.equal(out.at(-1), "r299");
});

// ---------- D3: an inbound mail must not pre-empt a person's owner thread ----------

test("resolveOwnerTarget: a thread planted via References never redirects owner messages to another person", async () => {
  const fx = await makeEmailFixture();
  const h = hostRec();
  try {
    const ch = fx.make(false, { dmAllowlist: [ALLOWED, CAROL] });
    await ch.start(h.host);
    await fx.deliverRaw(
      fixtureMail({ from: CAROL, body: "plant", messageId: "plant@x", extraHeaders: [`References: <owner-target:${ALLOWED}>`] }),
    );
    const chatId = await ch.resolveOwnerTarget({ userId: ALLOWED });
    await ch.send({ chatId, text: "private note for alice" });
    assert.deepEqual(fx.smtp.received.map((r) => r.rcpt), [[ALLOWED]]);
    await ch.stop();
  } finally {
    await fx.dispose();
  }
});

// ---------- D4: reconnect backoff must grow while the session keeps failing after login ----------

test("reconnect backoff keeps growing when sessions connect but fail during sync", async () => {
  const fx = await makeEmailFixture();
  const h = hostRec();
  const waits: number[] = [];
  const sleep: SleepFn = (ms, signal) =>
    new Promise<void>((resolve) => {
      if (ms === 25 * 60 * 1000 || ms === 60_000) {
        signal.addEventListener("abort", () => resolve(), { once: true }); // IDLE timer / poll: parked
        return;
      }
      waits.push(ms);
      if (waits.length >= 5 || signal.aborted) return signal.addEventListener("abort", () => resolve(), { once: true });
      setImmediate(resolve);
    });
  try {
    const ch = fx.make(false, { sleep });
    await ch.start(h.host);
    fx.imap.failFetch = true;
    fx.imap.append(fixtureMail({ from: ALLOWED, body: "poison", messageId: "fetchfail@x" }));
    for (let i = 0; i < 400 && waits.length < 5; i++) await new Promise((r) => setTimeout(r, 5));
    await ch.stop();
    assert.ok(waits.length >= 5, `waits: ${waits}`);
    assert.deepEqual(waits.slice(0, 5), [1000, 2000, 4000, 8000, 16000]);
  } finally {
    await fx.dispose();
  }
});

// ---------- D5: the socket inactivity timeout must not kill a quiet IDLE ----------

test("IDLE disables the socket inactivity timeout and restores it afterwards", async () => {
  const sockets: Socket[] = [];
  const srv: Server = createServer((s) => {
    sockets.push(s);
    s.on("error", () => {});
    s.write("* OK ready\r\n");
    s.on("data", (d) => {
      const t = d.toString().split(" ")[0]!;
      if (/IDLE/.test(d.toString())) s.write("+ idling\r\n");
      else if (/DONE/.test(d.toString())) s.write(`${lastTag} OK done\r\n`);
      else lastTag = t;
      if (/IDLE/.test(d.toString())) lastTag = t;
    });
  });
  let lastTag = "";
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as { port: number }).port;
  const sock = await defaultConnect("127.0.0.1", port);
  try {
    const conn = new ImapConnection(sock);
    await conn.greeting();
    assert.ok(sock.timeout, "precondition: an inactivity timeout is armed");
    let during: number | undefined = -1;
    const p = conn.idle(100_000, (_ms, signal) =>
      new Promise<void>((resolve) => {
        during = sock.timeout;
        setTimeout(resolve, 20);
        signal.addEventListener("abort", () => resolve(), { once: true });
      }),
    );
    await p;
    assert.ok(!during, `socket timeout during IDLE was ${during}`);
    assert.ok(sock.timeout, "timeout restored after IDLE");
  } finally {
    sock.destroy();
    await new Promise<void>((r) => srv.close(() => r()));
  }
});

// ---------- D6: Subject folding and reply-id hygiene ----------

test("buildMessage folds long encoded Subjects so no line exceeds 998 octets and the text round-trips", () => {
  const subject = "Grüße ".repeat(120);
  const raw = buildMessage({ from: { address: BOT }, to: ALLOWED, subject, text: "x", messageId: "m@x", date: 0 });
  const head = raw.toString("utf8").split("\r\n\r\n")[0]!;
  for (const l of head.split("\r\n")) assert.ok(l.length <= 998, `header line of ${l.length}`);
  assert.equal(parseMessage(raw).subject, subject.trim());
});

test("buildMessage folds a very long ASCII Subject too", () => {
  const subject = "word ".repeat(400).trim();
  const raw = buildMessage({ from: { address: BOT }, to: ALLOWED, subject, text: "x", messageId: "m@x", date: 0 });
  for (const l of raw.toString("utf8").split("\r\n\r\n")[0]!.split("\r\n")) assert.ok(l.length <= 998);
  assert.equal(parseMessage(raw).subject, subject);
});

test("sendTurn: a malformed replyTo never yields a malformed In-Reply-To", async () => {
  const fx = await makeEmailFixture();
  const h = hostRec();
  try {
    await fx.channel.start(h.host);
    await fx.deliverRaw(fixtureMail({ from: ALLOWED, body: "hi", messageId: "root@x" }));
    const chatId = (await fx.channel.resolveOwnerTarget({ userId: ALLOWED }));
    for (const bad of ["a> <b@x", "a b", "<<x>>", "x".repeat(2000)]) await fx.channel.sendTurn({ chatId, text: "r", replyTo: bad });
    for (const r of fx.smtp.received) {
      const irt = parseMessage(r.data).headers.getAll("in-reply-to");
      for (const v of irt) assert.match(v, /^<[^<>\s]{1,998}>$/);
    }
  } finally {
    await fx.dispose();
  }
});
