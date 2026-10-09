import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMessage, decodeEncodedWords, decodeQuotedPrintable, parseAddressList, parseMessageIds } from "../src/mime-parse.ts";

const crlf = (s: string) => Buffer.from(s.replace(/\r?\n/g, "\r\n"), "latin1");
const u8 = (s: string) => Buffer.from(s.replace(/\r?\n/g, "\r\n"), "utf8");
const png = Buffer.from("89504e470d0a1a0a0000", "hex");
const b64 = (b: Buffer) => b.toString("base64").replace(/(.{76})/g, "$1\r\n");

interface Case {
  name: string;
  raw: Buffer;
  text: string;
  fromHtml?: boolean;
  attachments?: number;
  report?: boolean;
  subject?: string;
}
const CASES: Case[] = [
  { name: "plain 7bit", raw: crlf("From: a@b.c\nSubject: Hi\n\nhello\nworld\n"), text: "hello\nworld\n", subject: "Hi" },
  {
    name: "quoted-printable utf-8",
    raw: crlf("Content-Type: text/plain; charset=utf-8\nContent-Transfer-Encoding: quoted-printable\n\nStra=C3=9Fe =\nlang=3D1\n"),
    text: "Straße lang=1\n",
  },
  {
    name: "quoted-printable iso-8859-1",
    raw: crlf("Content-Type: text/plain; charset=iso-8859-1\nContent-Transfer-Encoding: quoted-printable\n\nGr=FC=DFe\n"),
    text: "Grüße\n",
  },
  {
    name: "base64 windows-1252",
    raw: crlf(`Content-Type: text/plain; charset=windows-1252\nContent-Transfer-Encoding: base64\n\n${Buffer.from([0x80, 0x20, 0x94, 0x68, 0x69, 0x93]).toString("base64")}\n`),
    text: "€ ”hi“",
  },
  {
    name: "unknown charset falls back",
    raw: crlf("Content-Type: text/plain; charset=x-bogus\nContent-Transfer-Encoding: 8bit\n\nplain\n"),
    text: "plain\n",
  },
  {
    name: "multipart/alternative prefers text/plain",
    raw: crlf('Content-Type: multipart/alternative; boundary="BB"\n\n--BB\nContent-Type: text/plain\n\nplain version\n--BB\nContent-Type: text/html\n\n<p>html version</p>\n--BB--\n'),
    text: "plain version",
  },
  {
    name: "multipart/alternative html only",
    raw: crlf("Content-Type: multipart/alternative; boundary=BB\n\n--BB\nContent-Type: text/html\n\n<p>Hello <b>you</b></p><p>second</p>\n--BB--\n"),
    text: "Hello you\n\nsecond",
    fromHtml: true,
  },
  {
    name: "html-only message",
    raw: crlf("Content-Type: text/html; charset=utf-8\n\n<style>p{}</style><div>Hi<br>there</div>"),
    text: "Hi\nthere",
    fromHtml: true,
  },
  {
    name: "multipart/mixed with attachment",
    raw: crlf(`Content-Type: multipart/mixed; boundary="X"\n\n--X\nContent-Type: text/plain\n\nsee attached\n--X\nContent-Type: image/png; name="pic.png"\nContent-Disposition: attachment; filename="pic.png"\nContent-Transfer-Encoding: base64\n\n${b64(png)}\n--X--\n`),
    text: "see attached",
    attachments: 1,
  },
  {
    name: "multipart/related nested in alternative",
    raw: crlf(`Content-Type: multipart/alternative; boundary="A"\n\n--A\nContent-Type: text/plain\n\nplain wins\n--A\nContent-Type: multipart/related; boundary="R"\n\n--R\nContent-Type: text/html\n\n<img src=cid:1>\n--R\nContent-Type: image/png\nContent-ID: <1>\nContent-Transfer-Encoding: base64\n\n${b64(png)}\n--R--\n--A--\n`),
    text: "plain wins",
    attachments: 1,
  },
  {
    name: "bounce multipart/report",
    raw: crlf('Content-Type: multipart/report; report-type=delivery-status; boundary="D"\n\n--D\nContent-Type: text/plain\n\nDelivery failed\n--D\nContent-Type: message/delivery-status\n\nReporting-MTA: dns; x\n--D--\n'),
    text: "Delivery failed",
    report: true,
  },
  {
    name: "auto-reply",
    raw: crlf("Auto-Submitted: auto-replied\nSubject: Out of office\n\nI am away\n"),
    text: "I am away\n",
    subject: "Out of office",
  },
  {
    name: "encoded-word subject (B)",
    raw: crlf("Subject: =?UTF-8?B?w5xiZXIgZGllIEJyw7xja2U=?=\n\nx\n"),
    text: "x\n",
    subject: "Über die Brücke",
  },
  {
    name: "q-encoded latin1 with underscore",
    raw: crlf("Subject: =?ISO-8859-1?Q?Gr=FC=DF_Gott?= and more\n\nx\n"),
    text: "x\n",
    subject: "Grüß Gott and more",
  },
  {
    name: "8-bit utf-8 headers and body",
    raw: u8("Subject: Grüße\nContent-Type: text/plain; charset=utf-8\nContent-Transfer-Encoding: 8bit\n\nÄpfel\n"),
    text: "Äpfel\n",
    subject: "Grüße",
  },
  { name: "folded header", raw: crlf("Subject: one\n two\n\tthree\n\nbody"), text: "body", subject: "one two three" },
  { name: "bare LF line endings", raw: Buffer.from("Subject: lf\n\nbody\nmore\n"), text: "body\nmore\n", subject: "lf" },
  {
    name: "missing closing boundary",
    raw: crlf('Content-Type: multipart/mixed; boundary="Z"\n\n--Z\nContent-Type: text/plain\n\nunterminated\n'),
    text: "unterminated\n",
  },
  {
    name: "boundary-like text inside body is not a boundary",
    raw: crlf('Content-Type: multipart/mixed; boundary="Q"\n\n--Q\nContent-Type: text/plain\n\nline --Q inside\n--QQ not a delimiter\n--Q--\n'),
    text: "line --Q inside\n--QQ not a delimiter",
  },
  {
    name: "text/plain with filename is an attachment",
    raw: crlf('Content-Type: multipart/mixed; boundary="M"\n\n--M\nContent-Type: text/plain\n\nbody\n--M\nContent-Type: text/plain; name="notes.txt"\nContent-Disposition: attachment; filename="notes.txt"\n\nnotes\n--M--\n'),
    text: "body",
    attachments: 1,
  },
];

for (const c of CASES) {
  test(`mime fixture: ${c.name}`, () => {
    const m = parseMessage(c.raw);
    assert.equal(m.text.replace(/\r\n/g, "\n"), c.text);
    if (c.fromHtml !== undefined) assert.equal(m.fromHtml, c.fromHtml);
    assert.equal(m.attachments.length, c.attachments ?? 0);
    assert.equal(m.isReport, c.report ?? false);
    if (c.subject !== undefined) assert.equal(m.subject, c.subject);
  });
}

test("attachment filenames (RFC 2231, encoded-word) and bytes decode", () => {
  const raw = crlf(
    `Content-Type: multipart/mixed; boundary="X"\n\n--X\nContent-Type: text/plain\n\nhi\n--X\nContent-Type: application/pdf\nContent-Disposition: attachment; filename*=utf-8''r%C3%A9sum%C3%A9.pdf\nContent-Transfer-Encoding: base64\n\n${b64(png)}\n--X\nContent-Type: application/pdf; name="=?UTF-8?Q?=C3=BC.pdf?="\nContent-Disposition: attachment\nContent-Transfer-Encoding: base64\n\n${b64(png)}\n--X--\n`,
  );
  const m = parseMessage(raw);
  assert.equal(m.attachments[0]?.filename, "résumé.pdf");
  assert.equal(m.attachments[1]?.filename, "ü.pdf");
  assert.deepEqual([...m.attachments[0]!.data], [...png]);
});

test("oversized attachments are skipped before decoding and counted", () => {
  const big = Buffer.alloc(5000, 1);
  const raw = crlf(`Content-Type: multipart/mixed; boundary="X"\n\n--X\nContent-Type: text/plain\n\nhi\n--X\nContent-Type: application/zip\nContent-Disposition: attachment; filename=a.zip\nContent-Transfer-Encoding: base64\n\n${b64(big)}\n--X--\n`);
  const m = parseMessage(raw, { maxAttachmentBytes: 1000 });
  assert.equal(m.attachments.length, 0);
  assert.equal(m.skippedAttachments, 1);
  assert.equal(m.text, "hi");
});

test("depth limit bounds hostile nesting", () => {
  let inner = "Content-Type: text/plain\n\ndeep";
  for (let i = 0; i < 30; i++) inner = `Content-Type: multipart/mixed; boundary="b${i}"\n\n--b${i}\n${inner}\n--b${i}--\n`;
  assert.equal(parseMessage(crlf(inner)).text, "");
});

test("encoded words: adjacent words join, invalid stays literal", () => {
  assert.equal(decodeEncodedWords("=?utf-8?q?a?= =?utf-8?q?b?="), "ab");
  assert.equal(decodeEncodedWords("plain =?bad"), "plain =?bad");
  assert.equal(decodeEncodedWords("=?unknown-cs?q?caf=E9?="), "café");
});

test("quoted-printable: soft breaks, trailing whitespace, invalid escapes", () => {
  assert.equal(decodeQuotedPrintable("a=\r\nb  \r\nc=ZZ").toString(), "ab\r\nc=ZZ");
});

test("lenient address list: names, quotes, lists", () => {
  assert.deepEqual(parseAddressList('"Doe, John" <John@Example.com>, bob@x.y (Bob)'), [
    { name: "Doe, John", address: "john@example.com" },
    { address: "bob@x.y" },
  ]);
  assert.deepEqual(parseAddressList("=?UTF-8?Q?J=C3=BCrgen?= <j@x.de>"), [{ name: "Jürgen", address: "j@x.de" }]);
  assert.deepEqual(parseAddressList("not an address"), []);
  assert.deepEqual(parseAddressList(undefined), []);
});

test("message ids and references", () => {
  assert.deepEqual(parseMessageIds("<a@b> <c@d>\r\n <e@f>"), ["a@b", "c@d", "e@f"]);
  const m = parseMessage(crlf("Message-ID: <m1@x>\nIn-Reply-To: <p@x>\nReferences: <r@x>\n <p@x>\nReturn-Path: <>\n\nx"));
  assert.equal(m.messageId, "m1@x");
  assert.equal(m.inReplyTo, "p@x");
  assert.deepEqual(m.references, ["r@x", "p@x"]);
  assert.equal(m.returnPath, "<>");
});

test("garbage input never throws", () => {
  for (const g of [Buffer.alloc(0), Buffer.from("\0\0\0"), Buffer.from("::::\n\n\n"), Buffer.from("Content-Type: multipart/mixed\n\n--x")]) {
    assert.doesNotThrow(() => parseMessage(g));
  }
});

// ---- From-header hardening: the allowlist compares only the final, unambiguous addr-spec ----
const fromOf = (hdr: string) => parseMessage(crlf(`${hdr}\nSubject: s\n\nbody`));
const FROM_CASES: { name: string; header: string; address?: string; problem?: string }[] = [
  { name: "plain", header: "From: Alice <Alice@Trusted.COM>", address: "alice@trusted.com" },
  { name: "bare addr", header: "From: bob@x.y", address: "bob@x.y" },
  { name: "quoted display name containing an address", header: 'From: "a@trusted.com" <evil@x.com>', address: "evil@x.com" },
  { name: "quoted display name containing angle-addr", header: 'From: "x <a@trusted.com>" <evil@x.com>', address: "evil@x.com" },
  { name: "comment containing angle-addr", header: "From: (x <a@trusted.com>) <evil@x.com>", address: "evil@x.com" },
  { name: "nested comment", header: "From: (a (b <t@trusted.com>) c) evil@x.com", address: "evil@x.com" },
  { name: "escaped quote in display name", header: 'From: "a\\" <t@trusted.com>" <evil@x.com>', address: "evil@x.com" },
  { name: "comment before bare address", header: "From: (<t@trusted.com>) evil@x.com", address: "evil@x.com" },
  { name: "encoded-word display name containing an address", header: "From: =?utf-8?q?a=40trusted.com?= <evil@x.com>", address: "evil@x.com" },
  { name: "multiple mailboxes", header: "From: a@trusted.com, evil@x.com", problem: "multiple" },
  { name: "multiple angle-addrs", header: "From: <a@trusted.com> <evil@x.com>", problem: "multiple" },
  { name: "semicolon separated", header: "From: a@trusted.com; evil@x.com", problem: "multiple" },
  { name: "group syntax", header: "From: Team: a@trusted.com, evil@x.com;", problem: "group" },
  { name: "empty group", header: "From: undisclosed-recipients:;", problem: "group" },
  { name: "missing angle close", header: "From: Eve <evil@x.com", problem: "malformed" },
  { name: "stray angle close", header: "From: evil@x.com>", problem: "malformed" },
  { name: "unterminated quote", header: 'From: "a@trusted.com <evil@x.com>', problem: "malformed" },
  { name: "unterminated comment", header: "From: (a <t@trusted.com> evil@x.com", problem: "malformed" },
  { name: "garbage", header: "From: not an address", problem: "malformed" },
  { name: "duplicate From", header: "From: a@trusted.com\nFrom: evil@x.com", problem: "duplicate" },
  { name: "Sender disagrees", header: "From: a@trusted.com\nSender: evil@x.com", problem: "sender-mismatch" },
  { name: "Sender agrees", header: "From: a@trusted.com\nSender: A@Trusted.com", address: "a@trusted.com" },
  { name: "duplicate Return-Path", header: "From: a@trusted.com\nReturn-Path: <a@trusted.com>\nReturn-Path: <evil@x.com>", problem: "duplicate-return-path" },
];
for (const c of FROM_CASES) {
  test(`strict From: ${c.name}`, () => {
    const m = fromOf(c.header);
    if (c.problem) {
      assert.equal(m.fromProblem, c.problem);
      assert.equal(m.from, undefined);
    } else {
      assert.equal(m.fromProblem, undefined);
      assert.equal(m.from?.address, c.address);
    }
  });
}
test("missing From is a problem", () => {
  assert.equal(parseMessage(crlf("Subject: x\n\nb")).fromProblem, "missing");
});
