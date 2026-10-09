import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseAuthResults,
  authPasses,
  stripCfws,
  loopReason,
  senderMatches,
  parseApprovalReply,
  parseLinkCommand,
  stripQuotedText,
  SlidingWindow,
  newApprovalCode,
} from "../src/policy.ts";
import { parseMessage } from "../src/mime-parse.ts";

const AR = {
  spf: "pass" as const,
  dkim: "pass" as const,
  dmarc: "pass" as const,
};
const NONE = { spf: "none", dkim: "none", dmarc: "none" };

interface AuthCase {
  name: string;
  headers: string[];
  servId?: string | undefined;
  want: typeof NONE;
}
const AUTH_CASES: AuthCase[] = [
  { name: "trusted header", headers: ["mx.test; spf=pass smtp.mailfrom=a; dkim=pass; dmarc=pass"], servId: "mx.test", want: AR },
  { name: "authserv-id is case-insensitive", headers: ["MX.Test; dmarc=pass"], servId: "mx.test", want: { ...NONE, dmarc: "pass" } },
  { name: "version token after authserv-id", headers: ["mx.test 1; dmarc=fail"], servId: "mx.test", want: { ...NONE, dmarc: "fail" } },
  {
    name: "comment injection inside a foreign header is ignored",
    headers: ["evil.example (mx.test; spf=pass dkim=pass dmarc=pass); spf=fail"],
    servId: "mx.test",
    want: NONE,
  },
  {
    name: "pass hidden in a comment of the trusted header does not count",
    headers: ["mx.test (spf=pass dkim=pass dmarc=pass); spf=fail"],
    servId: "mx.test",
    want: { ...NONE, spf: "fail" },
  },
  {
    name: "foreign authserv-id ignored",
    headers: ["attacker.example; spf=pass dkim=pass dmarc=pass"],
    servId: "mx.test",
    want: NONE,
  },
  {
    name: "duplicate headers: topmost matching one wins",
    headers: ["mx.test; dmarc=fail", "mx.test; dmarc=pass"],
    servId: "mx.test",
    want: { ...NONE, dmarc: "fail" },
  },
  {
    name: "foreign header above a trusted one does not shadow it",
    headers: ["attacker.example; dmarc=pass", "mx.test; dmarc=fail"],
    servId: "mx.test",
    want: { ...NONE, dmarc: "fail" },
  },
  {
    name: "missing authServId fails closed",
    headers: ["mx.test; spf=pass dkim=pass dmarc=pass"],
    servId: undefined,
    want: NONE,
  },
  { name: "no matching header fails closed", headers: [], servId: "mx.test", want: NONE },
  {
    name: "quoted-string injection: ; and = inside quotes do not split",
    headers: ['mx.test; dkim=fail reason="x; dmarc=pass; spf=pass"; dmarc=fail'],
    servId: "mx.test",
    want: { ...NONE, dkim: "fail", dmarc: "fail" },
  },
  {
    name: "resinfo tail is never scanned (only leading method=result)",
    headers: ["mx.test; dkim=none header.b=abc dmarc=pass"],
    servId: "mx.test",
    want: { ...NONE, dkim: "none" },
  },
  {
    name: "multi-resinfo: each method read once, first wins",
    headers: ["mx.test; spf=softfail smtp.mailfrom=x; dkim=pass header.d=y; spf=pass; dmarc=none"],
    servId: "mx.test",
    want: { spf: "softfail", dkim: "pass", dmarc: "none" },
  },
];
for (const c of AUTH_CASES) {
  test(`auth-results: ${c.name}`, () => {
    assert.deepEqual(parseAuthResults(c.headers, c.servId), c.want);
  });
}

test("authPasses: DMARC pass only; SPF+DKIM without alignment never passes", () => {
  const rows: [string, boolean][] = [
    ["mx.test; dmarc=pass", true],
    ["mx.test; spf=pass smtp.mailfrom=a.example; dkim=pass header.d=a.example; dmarc=pass", true],
    ["mx.test; spf=pass smtp.mailfrom=attacker.example; dkim=pass header.d=attacker.example", false],
    ["mx.test; dkim=pass header.d=other.example; spf=pass smtp.mailfrom=x.example; dmarc=none", false],
    ["mx.test; spf=pass; dkim=pass; dmarc=fail", false],
    ["mx.test; spf=pass; dkim=pass", false],
    ["mx.test; dmarc=none", false],
  ];
  for (const [value, want] of rows) assert.equal(authPasses(parseAuthResults([value], "mx.test")), want, value);
});

test("stripCfws removes nested comments and blanks quoted strings", () => {
  assert.equal(stripCfws("a (x (y) z) b"), "a  b");
  assert.equal(stripCfws('a "b;c" d'), 'a "" d');
  assert.equal(stripCfws("a \\(b c"), "a \\(b c", "an escaped paren outside a comment is kept verbatim");
  assert.equal(stripCfws('a "x\\"; y" b'), 'a "" b', "an escaped quote does not end the quoted string");
});

test("loopReason table", () => {
  const base = "From: a@example.test\r\nSubject: s\r\n\r\nb";
  const own = "bot@example.test";
  const rows: [string, string | undefined][] = [
    [base, undefined],
    [base.replace("Subject", "Auto-Submitted: auto-generated\r\nSubject"), "auto-submitted"],
    [base.replace("Subject", "Auto-Submitted: no\r\nSubject"), undefined],
    [base.replace("Subject", "Precedence: bulk\r\nSubject"), "precedence"],
    [base.replace("Subject", "Precedence: list\r\nSubject"), "precedence"],
    [base.replace("Subject", "X-Auto-Response-Suppress: All\r\nSubject"), "auto-response-suppress"],
    [base.replace("Subject", "List-Id: <x.example>\r\nSubject"), "list"],
    [base.replace("Subject", "Return-Path: <>\r\nSubject"), "null-sender"],
    [base.replace("From: a@example.test", "From: bot@example.test"), "self"],
    [base.replace("From: a@example.test", "From: MAILER-DAEMON@example.test"), "system-sender"],
    [base.replace("From: a@example.test", "From: no-reply@example.test"), "system-sender"],
    [base.replace("From: a@example.test", "From: postmaster@example.test"), "system-sender"],
  ];
  for (const [raw, want] of rows) {
    const m = parseMessage(Buffer.from(raw.replace(/\r?\n/g, "\r\n"), "utf8"));
    assert.equal(loopReason(m, own), want, raw.slice(0, 60));
  }
});

test("loopReason: multipart/report bounces are reports", () => {
  const raw = Buffer.from(
    'From: a@example.test\r\nContent-Type: multipart/report; report-type=delivery-status; boundary="D"\r\n\r\n--D\r\nContent-Type: text/plain\r\n\r\nfail\r\n--D--\r\n',
  );
  assert.equal(loopReason(parseMessage(raw), "bot@example.test"), "report");
});

test("sender allowlist: exact address and *@domain, case-insensitive, no subdomain", () => {
  const rows: [string[], string, boolean][] = [
    [["alice@example.test"], "Alice@Example.test", true],
    [["alice@example.test"], "bob@example.test", false],
    [["*@partner.example"], "anyone@partner.example", true],
    [["*@partner.example"], "anyone@sub.partner.example", false],
    [["*@partner.example"], "anyone@partner.example.evil", false],
    [[], "anyone@example.test", false],
  ];
  for (const [list, addr, want] of rows) assert.equal(senderMatches(list, addr), want, `${list} ${addr}`);
});

test("approval reply lines", () => {
  assert.deepEqual(parseApprovalReply("7K2Q-9M4X 1"), { code: "7K2Q-9M4X", choice: 1 });
  assert.deepEqual(parseApprovalReply("7k2q9m4x 2"), { code: "7K2Q-9M4X", choice: 2 });
  assert.equal(parseApprovalReply("7K2Q-9M4X 0"), undefined);
  assert.equal(parseApprovalReply("7K2Q-9M4X 1 please"), undefined);
  assert.equal(parseApprovalReply("2024 3"), undefined);
  assert.match(newApprovalCode(), /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
});

test("link command table", () => {
  const rows: [string, string | undefined][] = [
    ["link ABCD1234", "ABCD1234"],
    ["/link abc_-DEF", "abc_-DEF"],
    ["LINK abcd", "abcd"],
    ["please link abcd", undefined],
    ["link ab", undefined],
    ["link abcd extra", undefined],
  ];
  for (const [line, want] of rows) assert.equal(parseLinkCommand(line), want, line);
});

test("stripQuotedText: quotes, attribution blocks and signatures", () => {
  const rows: [string, string][] = [
    ["new text\n> old\n> older", "new text"],
    ["hi\n\nOn Mon, 6 Oct 2026, Alice <a@x> wrote:\n> hello", "hi"],
    ["hallo\n\nAm 6.10.2026 schrieb Alice:\n> hallo", "hallo"],
    ["body\n-- \nSig line", "body"],
    ["body\n-----Original Message-----\nfrom me", "body"],
  ];
  for (const [input, want] of rows) assert.equal(stripQuotedText(input), want, input);
});

test("SlidingWindow: bounded per key with injected clock", () => {
  let t = 0;
  const w = new SlidingWindow(2, 1000, () => t);
  assert.equal(w.take("a"), true);
  assert.equal(w.take("a"), true);
  assert.equal(w.take("a"), false);
  assert.equal(w.take("b"), true);
  t = 1000;
  assert.equal(w.take("a"), true);
});
