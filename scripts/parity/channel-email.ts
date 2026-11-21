import { connect, type Socket } from "node:net";
import { openImap } from "../../packages/channels-email/src/imap.ts";
import { sendMail } from "../../packages/channels-email/src/smtp.ts";
import { EmailError } from "../../packages/channels-email/src/wire.ts";
import { buildMessage } from "../../packages/channels-email/src/mime-build.ts";
import { parseMessage } from "../../packages/channels-email/src/mime-parse.ts";
import { FakeImap } from "../../packages/channels-email/test/helpers/fake-imap.ts";
import { FakeSmtp } from "../../packages/channels-email/test/helpers/fake-smtp.ts";

const user = "fixture-sender@example.invalid";
const password = "synthetic-mail-marker";
const auth = Buffer.from(`\0${user}\0${password}`).toString("base64");
const base64 = (data: Buffer) => data.toString("base64");
const smtpData = Buffer.from("Subject: fixture\n\n.first\r\n..second\n");
const imapData = Buffer.from("From: Example <sender@example.invalid>\r\n\r\nGrüße 👋\r\n");

function recorder() {
  const steps: { send: Buffer[]; receive: Buffer[] }[] = [{ send: [], receive: [] }];
  const upgrades: number[] = [];
  const open = async (host: string, port: number) => new Promise<Socket>((resolve, reject) => {
    if (host !== "127.0.0.1") throw new Error("mail fixture must use loopback");
    const s = connect({ host, port });
    s.setTimeout(1500, () => s.destroy(new Error("fixture timed out")));
    s.on("error", reject);
    const write = s.write.bind(s);
    s.write = ((data: Buffer | string, ...args: unknown[]) => {
      steps.push({ send: [Buffer.from(data)], receive: [] });
      return Reflect.apply(write, s, [data, ...args]);
    }) as Socket["write"];
    s.on("data", (data: Buffer) => steps.at(-1)!.receive.push(Buffer.from(data)));
    s.once("connect", () => resolve(s));
  });
  const upgrade = async (s: Socket) => {
    upgrades.push(steps.length - 1);
    return s;
  };
  const script = () => steps.map(({ send, receive }) => ({
    sendBase64: send.map((chunk) => base64(Buffer.from(chunk.toString("utf8")
      .replaceAll(auth, "[FIXTURE:MAIL_PLAIN]").replaceAll(password, "[FIXTURE:MAIL_PASSWORD]")))),
    receiveChunksBase64: receive.length ? [base64(Buffer.concat(receive))] : [],
  }));
  return { open, upgrade, script, upgrades };
}

function failure(error: unknown) {
  if (!(error instanceof EmailError)) throw error;
  return { error: { kind: error.kind, message: error.message } };
}

export async function smtp(starttls: boolean, deferred = false) {
  const fake = new FakeSmtp({ user, password, starttls, requireTlsBeforeAuth: true });
  const r = recorder();
  await fake.listen();
  if (deferred) fake.failNext("RCPT", 450);
  const from = user;
  const to = "fixture-recipient@example.invalid";
  try {
    let expected;
    try {
      await sendMail({
        host: "127.0.0.1", port: fake.port, security: "starttls", user, password, from, to,
        ehloName: "example.invalid", data: smtpData, connect: r.open, upgradeTls: r.upgrade,
      });
      expected = { result: null };
    } catch (error) { expected = failure(error); }
    if ((starttls && fake.authenticated !== 1) || (!starttls && fake.authenticated !== 0) || fake.credentialsBeforeTls) {
      throw new Error("unexpected SMTP authentication sequence");
    }
    return { source: "packages/channels-email/src/smtp.ts", transport: "lines", exchanges: r.script(),
      input: { from, to, dataBase64: base64(smtpData) }, upgrades: r.upgrades, expected };
  } finally {
    await fake.close();
  }
}

export async function imap(starttls: boolean) {
  const fake = new FakeImap({ user, password, starttls, authPlain: true, requireTlsBeforeAuth: true });
  fake.append(imapData);
  const r = recorder();
  await fake.listen();
  try {
    let expected;
    try {
      const { conn, caps, select } = await openImap({
        host: "127.0.0.1", port: fake.port, security: "starttls", user, password, folder: "INBOX",
        connect: r.open, upgradeTls: r.upgrade,
      });
      try {
        const uids = await conn.uidsAbove(0);
        const size = await conn.fetchSize(1);
        const data = await conn.fetchRaw(1);
        await conn.markSeen(1);
        expected = { result: { caps: [...caps].sort(), select, uids, size, dataBase64: base64(data) } };
      } finally { conn.close(); }
    } catch (error) { expected = failure(error); }
    if ((starttls && fake.authenticated !== 1) || (!starttls && fake.authenticated !== 0) || fake.credentialsBeforeTls) {
      throw new Error("unexpected IMAP authentication sequence");
    }
    return { source: "packages/channels-email/src/imap.ts", transport: "lines", exchanges: r.script(), upgrades: r.upgrades, expected };
  } finally {
    await fake.close();
  }
}

function snapshot(bytes: Buffer, options = {}) {
  const { attachments, headers, ...parsed } = parseMessage(bytes, options);
  return { ...parsed, attachments: attachments.map(({ data, ...metadata }) => ({ ...metadata, bytes: Array.from(data) })),
    headers: Object.fromEntries(["from", "to", "date", "content-type", "return-path"].map((key) => [key, headers.getAll(key)])),
  };
}

export function mime() {
  const input = {
    from: { name: "Müller 👋", address: user },
    to: "recipient@example.invalid", subject: "Grüße aus dem Test",
    text: "Erste Zeile.\n.Zweite Zeile.", html: "<p>Alternative</p>",
    messageId: "local-0001@example.invalid", date: 1_700_000_000_000,
    inReplyTo: "local-0000@example.invalid", references: ["local-0000@example.invalid"],
    attachments: [{ filename: "../Bericht ü.txt", mimeType: "text/plain", bytes: [0, 1, 2, 255] }],
    boundaries: ["fixture-alt-marker", "fixture-mixed-marker"],
  };
  let cursor = 0;
  const built = buildMessage({ ...input,
    attachments: input.attachments.map((a) => ({ ...a, data: Uint8Array.from(a.bytes) })),
    boundary: () => input.boundaries[cursor++]!,
  });
  const validFrom = `From: Example <${user}>\r\n`;
  const variants = [
    { name: "roundtrip", bytes: built },
    { name: "duplicate-from", bytes: Buffer.from(validFrom + validFrom + "\r\nbody") },
    { name: "multiple-mailboxes", bytes: Buffer.from("From: one@example.invalid, two@example.invalid\r\n\r\nbody") },
    { name: "group", bytes: Buffer.from("From: Group: one@example.invalid;\r\n\r\nbody") },
    { name: "duplicate-path", bytes: Buffer.from(validFrom + "Return-Path: <>\r\nReturn-Path: <>\r\n\r\n") },
    { name: "sender-mismatch", bytes: Buffer.from(validFrom + "Sender: other@example.invalid\r\n\r\nbody") },
    { name: "comments-and-quotes", bytes: Buffer.from('From: "Example, Ali" (opaque) <SENDER@example.invalid>\r\n\r\nbody') },
    { name: "quoted-printable", bytes: Buffer.from(validFrom + "Subject: =?windows-1252?Q?Gr=FC=DFe?=\r\nContent-Type: text/plain; charset=windows-1252\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nGr=FC=DFe  \r\nA=\r\nB") },
    { name: "attachments-capped", bytes: built, options: { maxAttachmentBytes: 2 } },
    { name: "depth-capped", bytes: built, options: { maxDepth: 1 } },
    { name: "html", bytes: Buffer.from(validFrom + "Content-Type: text/html\r\n\r\n<p>Gr&uuml;&szlig;e <a href='https://fixture.invalid/'>link</a></p><script>ignored</script>") },
    { name: "machine-report", bytes: Buffer.from(validFrom + "Content-Type: message/delivery-status\r\n\r\nstatus") },
    { name: "filename-parameters", bytes: Buffer.from(validFrom + "Content-Type: image/png\r\nContent-Disposition: inline; filename*0*=utf-8''gr%C3%BC; filename*1*=sse.png\r\nContent-Transfer-Encoding: base64\r\n\r\nAAEC") },
  ].map(({ name, bytes, options }) => ({ name, bytesBase64: base64(bytes), options, expected: snapshot(bytes, options) }));
  return { schema: "plur1bus.parity-email/1", source: "packages/channels-email/src/mime-build.ts and mime-parse.ts",
    build: { input, bytesBase64: base64(built) }, variants,
  };
}
