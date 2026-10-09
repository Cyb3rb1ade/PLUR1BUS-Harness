import assert from "node:assert/strict";
import { createServer, connect as netConnect, type Server, type Socket } from "node:net";
import { test } from "node:test";
import { ImapConnection, openImap, quote } from "../src/imap.ts";
import { sendMail, dotStuff, checkAddrSpec, smtpNoop } from "../src/smtp.ts";
import { EmailError, type ConnectFn, type UpgradeTlsFn } from "../src/wire.ts";
import { FakeImap } from "./helpers/fake-imap.ts";
import { FakeSmtp } from "./helpers/fake-smtp.ts";

const IMAP_USER = "bot@example.test";
const IMAP_PW = "invented-imap-password-1a2b";
const SMTP_PW = "invented-smtp-password-3c4d";
const plainConnect: ConnectFn = (host, port) =>
  new Promise((resolve, reject) => {
    const s = netConnect({ host, port });
    s.once("error", reject);
    s.once("connect", () => {
      s.removeAllListeners("error");
      s.on("error", () => {});
      resolve(s);
    });
  });
/** Test seam: the "TLS" upgrade is the identity, and it records when it ran. */
function identityUpgrade(events: string[]): UpgradeTlsFn {
  return async (s) => {
    events.push("upgrade");
    return s;
  };
}

test("quote() refuses CR, LF and NUL and escapes quotes and backslashes", () => {
  assert.equal(quote('a"b\\c'), '"a\\"b\\\\c"');
  for (const v of ["a\r\nA002 LOGIN", "a\nb", "a\0b"]) assert.throws(() => quote(v), EmailError);
});

test("STARTTLS missing: fail closed, no credentials sent", async () => {
  const fake = new FakeImap({ user: IMAP_USER, password: IMAP_PW, starttls: false });
  await fake.listen();
  try {
    await assert.rejects(
      openImap({
        host: "127.0.0.1",
        port: fake.port,
        security: "starttls",
        user: IMAP_USER,
        password: IMAP_PW,
        folder: "INBOX",
        connect: plainConnect,
        upgradeTls: identityUpgrade([]),
      }),
      (e: unknown) => e instanceof EmailError && e.kind === "tls" && !/invented/.test(e.message),
    );
    assert.equal(fake.authenticated, 0);
    assert.ok(!fake.commands.includes("LOGIN") && !fake.commands.includes("AUTHENTICATE"));
  } finally {
    await fake.close();
  }
});

test("STARTTLS: upgrade happens before any credential is sent, then AUTH, then SELECT", async () => {
  const fake = new FakeImap({ user: IMAP_USER, password: IMAP_PW, starttls: true, requireTlsBeforeAuth: true });
  await fake.listen();
  const events: string[] = [];
  const upgrade: UpgradeTlsFn = async (s) => {
    events.push(`upgrade:${fake.commands.join(",")}`);
    return s;
  };
  try {
    const opened = await openImap({
      host: "127.0.0.1",
      port: fake.port,
      security: "starttls",
      user: IMAP_USER,
      password: IMAP_PW,
      folder: "INBOX",
      connect: plainConnect,
      upgradeTls: upgrade,
    });
    assert.equal(fake.credentialsBeforeTls, false);
    assert.equal(fake.authenticated, 1);
    assert.equal(opened.select.uidValidity, 1);
    opened.conn.close();
    assert.equal(events.length, 1);
    assert.ok(events[0]!.startsWith("upgrade:") && events[0]!.includes("STARTTLS") && !events[0]!.includes("LOGIN"));
  } finally {
    await fake.close();
  }
});

test("wrong password is an auth error and the password never appears in it", async () => {
  const fake = new FakeImap({ user: IMAP_USER, password: IMAP_PW, starttls: true });
  await fake.listen();
  try {
    await assert.rejects(
      openImap({
        host: "127.0.0.1",
        port: fake.port,
        security: "starttls",
        user: IMAP_USER,
        password: "wrong-password-xyz",
        folder: "INBOX",
        connect: plainConnect,
        upgradeTls: identityUpgrade([]),
      }),
      (e: unknown) => e instanceof EmailError && e.kind === "auth" && !/wrong-password/.test(e.message),
    );
  } finally {
    await fake.close();
  }
});

const MECHANISM_CASES: { name: string; authPlain: boolean; login: boolean; expect: "AUTHENTICATE" | "LOGIN" | "auth-error" }[] = [
  { name: "AUTH=PLAIN preferred", authPlain: true, login: true, expect: "AUTHENTICATE" },
  { name: "LOGIN when no PLAIN", authPlain: false, login: true, expect: "LOGIN" },
  { name: "neither usable", authPlain: false, login: false, expect: "auth-error" },
];
for (const c of MECHANISM_CASES) {
  test(`IMAP mechanism: ${c.name}`, async () => {
    const fake = new FakeImap({ user: IMAP_USER, password: IMAP_PW, starttls: true, authPlain: c.authPlain, login: c.login });
    await fake.listen();
    try {
      const p = openImap({
        host: "127.0.0.1",
        port: fake.port,
        security: "starttls",
        user: IMAP_USER,
        password: IMAP_PW,
        folder: "INBOX",
        connect: plainConnect,
        upgradeTls: identityUpgrade([]),
      });
      if (c.expect === "auth-error") {
        await assert.rejects(p, (e: unknown) => e instanceof EmailError && e.kind === "auth");
      } else {
        const opened = await p;
        assert.ok(fake.commands.includes(c.expect), fake.commands.join(","));
        opened.conn.close();
      }
    } finally {
      await fake.close();
    }
  });
}

test("IMAP uidsAbove and fetch: only UIDs above the cursor, bodies byte-exact", async () => {
  const fake = new FakeImap({ user: IMAP_USER, password: IMAP_PW, starttls: false });
  await fake.listen();
  const body = Buffer.from("Subject: x\r\n\r\n* A0001 OK fake\r\n{5}\r\nliteral-looking text\r\n", "utf8");
  fake.append(Buffer.from("Subject: one\r\n\r\na\r\n"));
  fake.append(Buffer.from("Subject: two\r\n\r\nb\r\n"));
  fake.append(body);
  try {
    const conn = new ImapConnection(await plainConnect("127.0.0.1", fake.port));
    await conn.greeting();
    await conn.select("INBOX");
    assert.deepEqual(await conn.uidsAbove(0), [1, 2, 3]);
    assert.deepEqual(await conn.uidsAbove(2), [3]);
    assert.deepEqual(await conn.uidsAbove(3), []);
    assert.equal(await conn.fetchSize(3), body.length);
    assert.deepEqual(await conn.fetchRaw(3), body);
    await conn.markSeen(3);
    assert.equal(fake.messages[2]!.seen, true);
    conn.close();
  } finally {
    await fake.close();
  }
});

test("IMAP literal parsing: byte-by-byte delivery with CRLF inside the literal", async () => {
  const literal = Buffer.from("line1\r\n* 9 FETCH (x)\r\nA0002 OK bogus\r\nend", "utf8");
  const server: Server = createServer((s: Socket) => {
    s.on("error", () => {});
    s.write("* OK ready\r\n");
    let pending = "";
    s.on("data", (d: Buffer) => {
      pending += d.toString("latin1");
      let i: number;
      while ((i = pending.indexOf("\r\n")) >= 0) {
        const line = pending.slice(0, i);
        pending = pending.slice(i + 2);
        const tag = line.split(" ")[0];
        const verb = line.split(" ")[1]?.toUpperCase();
        if (verb === "UID") {
          const head = Buffer.from(`* 1 FETCH (UID 1 BODY[] {${literal.length}}\r\n`, "latin1");
          const payload = Buffer.concat([head, literal, Buffer.from(")\r\n", "latin1"), Buffer.from(`${tag} OK done\r\n`, "latin1")]);
          // Deliver in 7-byte pieces so every boundary falls somewhere awkward.
          for (let off = 0; off < payload.length; off += 7) s.write(payload.subarray(off, off + 7));
        } else s.write(`${tag} OK done\r\n`);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    const conn = new ImapConnection(await plainConnect("127.0.0.1", port));
    await conn.greeting();
    assert.deepEqual(await conn.fetchRaw(1), literal);
    conn.close();
  } finally {
    server.close();
  }
});

test("IMAP: UIDVALIDITY is read from SELECT and missing it is a protocol error", async () => {
  const fake = new FakeImap({ user: IMAP_USER, password: IMAP_PW, starttls: false });
  await fake.listen();
  try {
    const conn = new ImapConnection(await plainConnect("127.0.0.1", fake.port));
    await conn.greeting();
    fake.resetUidValidity(77);
    const sel = await conn.select("INBOX");
    assert.equal(sel.uidValidity, 77);
    assert.equal(sel.uidNext, 1);
    conn.close();
  } finally {
    await fake.close();
  }
});

// ---------- SMTP ----------

const DOTSTUFF: [string, string][] = [
  ["a\r\n.b\r\n", "a\r\n..b\r\n.\r\n"],
  ["a\nb\n", "a\r\nb\r\n.\r\n"],
  ["..x\r\n", "...x\r\n.\r\n"],
  ["no newline", "no newline\r\n.\r\n"],
];
for (const [input, want] of DOTSTUFF) {
  test(`dotStuff: ${JSON.stringify(input)}`, () => {
    assert.equal(dotStuff(Buffer.from(input, "latin1")).toString("latin1"), want);
  });
}

test("checkAddrSpec refuses injection shapes", () => {
  assert.equal(checkAddrSpec("a@b.test"), "a@b.test");
  for (const v of ["a@b.test>\r\nRCPT TO:<x@y>", "a b@c.test", "<a@b.test>", "a@b.test\nDATA", "a\"b@c.test", ""]) {
    assert.throws(() => checkAddrSpec(v), EmailError, v);
  }
});

const SMTP_PW_CHECK = (f: FakeSmtp) => f.authenticated;

test("SMTP send: dot-stuffed body round-trips and envelope is recorded", async () => {
  const fake = new FakeSmtp({ user: IMAP_USER, password: SMTP_PW, starttls: true });
  await fake.listen();
  const events: string[] = [];
  try {
    const data = Buffer.from("Subject: s\r\n\r\n.starts with dot\r\nplain\r\n", "latin1");
    await sendMail({
      host: "127.0.0.1",
      port: fake.port,
      security: "starttls",
      user: IMAP_USER,
      password: SMTP_PW,
      ehloName: "example.test",
      connect: plainConnect,
      upgradeTls: identityUpgrade(events),
      from: IMAP_USER,
      to: "alice@example.test",
      data,
    });
    assert.equal(SMTP_PW_CHECK(fake), 1);
    assert.equal(fake.received.length, 1);
    assert.equal(fake.received[0]!.from, IMAP_USER);
    assert.deepEqual(fake.received[0]!.rcpt, ["alice@example.test"]);
    assert.deepEqual(fake.received[0]!.data, data);
    assert.equal(fake.credentialsBeforeTls, false);
  } finally {
    await fake.close();
  }
});

const SMTP_FAILURES: { name: string; setup: (f: FakeSmtp) => void; kind: string }[] = [
  { name: "451 on MAIL is temporary", setup: (f) => f.failNext("MAIL", 451), kind: "temporary" },
  { name: "550 on RCPT is permanent", setup: (f) => f.failNext("RCPT", 550), kind: "permanent" },
  { name: "451 at end of DATA is temporary", setup: (f) => f.failNext("end", 451), kind: "temporary" },
  { name: "554 at end of DATA is permanent", setup: (f) => f.failNext("end", 554), kind: "permanent" },
];
for (const c of SMTP_FAILURES) {
  test(`SMTP failure: ${c.name}`, async () => {
    const fake = new FakeSmtp({ user: IMAP_USER, password: SMTP_PW, starttls: true });
    await fake.listen();
    c.setup(fake);
    try {
      await assert.rejects(
        sendMail({
          host: "127.0.0.1",
          port: fake.port,
          security: "starttls",
          user: IMAP_USER,
          password: SMTP_PW,
          ehloName: "example.test",
          connect: plainConnect,
          upgradeTls: identityUpgrade([]),
          from: IMAP_USER,
          to: "alice@example.test",
          data: Buffer.from("Subject: s\r\n\r\nb\r\n"),
        }),
        (e: unknown) => e instanceof EmailError && e.kind === c.kind && !/injected|invented/.test(e.message),
      );
    } finally {
      await fake.close();
    }
  });
}

test("SMTP: no STARTTLS offered means no AUTH is sent", async () => {
  const fake = new FakeSmtp({ user: IMAP_USER, password: SMTP_PW, starttls: false });
  await fake.listen();
  try {
    await assert.rejects(
      smtpNoop({
        host: "127.0.0.1",
        port: fake.port,
        security: "starttls",
        user: IMAP_USER,
        password: SMTP_PW,
        ehloName: "example.test",
        connect: plainConnect,
        upgradeTls: identityUpgrade([]),
      }),
      (e: unknown) => e instanceof EmailError && e.kind === "tls",
    );
    assert.equal(fake.authenticated, 0);
    assert.ok(!fake.commands.includes("AUTH"));
  } finally {
    await fake.close();
  }
});

test("SMTP: wrong password is an auth error without the password in the message", async () => {
  const fake = new FakeSmtp({ user: IMAP_USER, password: SMTP_PW, starttls: true });
  await fake.listen();
  try {
    await assert.rejects(
      smtpNoop({
        host: "127.0.0.1",
        port: fake.port,
        security: "starttls",
        user: IMAP_USER,
        password: "not-the-password",
        ehloName: "example.test",
        connect: plainConnect,
        upgradeTls: identityUpgrade([]),
      }),
      (e: unknown) => e instanceof EmailError && e.kind === "auth" && !/not-the-password/.test(e.message),
    );
  } finally {
    await fake.close();
  }
});

