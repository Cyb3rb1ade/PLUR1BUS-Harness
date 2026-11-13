// Parity vectors (mode V) for the D111 redactor the Rust port shares between the CLI and the core (P4-11 task 1):
// `createRedactor` (rules 1 to 6, `secretsOnly`, `secretForms`, `textWindow`), `isSecretKey`, `maskSecretsInJson`,
// the exact-value `SecretMatcher` (spans, windows, bytes, `scanJson`), `secretFormsOf`/`secretFormsIn`, and the helpers
// `wellFormedPrefix`, `jsonEscapeView`, `jsonSecretViews`. `crates/plur1bus-log-schema/tests/redact_vectors.rs` replays
// every case. Recorded, never edited by hand.
//
// Task 2 (the log write path) adds `levels`, `trace`, `output` (`sanitise`, `signalLevel`, `cap`), `files` (listing and
// collation), `lines` (the streaming reader over generated files) and `records` (op sequences against a writer with a fixed
// clock and trace; the TypeScript lines are recorded together with `canonical`, the same line with attribute keys sorted,
// which is what the Rust writer produces; a case with a `note` differs from the TypeScript bytes in that order only).
// `crates/plur1bus-core/src/logs/vectors.rs` replays them.
//
// Task 3 (the log query) adds `query` (`runQuery` over generated files: records, `scanned.bytes`, cursor and truncation per
// order; `fingerprint`, `mintCursor`, `decodeCursor`) and `methods` (`logs.query`/`logs.tail`/`logs.levels`: bounds verdicts,
// tail scenarios with a fake clock and sleep, level changes with their audit events). Every date is UTC, so the files do not
// depend on `TZ`; a case with a `note` differs from the TypeScript output (key order, legacy date forms) on purpose.
// `crates/plur1bus-core/src/logs/query_vectors.rs` replays them.
//
// Strings: a JavaScript string can hold a lone surrogate, a JSON file read by Rust cannot, so a string is stored as
//   "plain text"                              when it is well-formed and holds no credential-shaped value,
//   { "units": [UTF-16 code units] }          when it is not well-formed,
//   { "parts": [string | { units }, ...] }    when it holds a credential-shaped canary: the canary is stored in the
//                                             fragments the TypeScript tests assemble it from (`S(...)`), never in one
//                                             piece, and the reader concatenates the parts.
// No credential is invented: every canary below is one the TypeScript tests (`packages/core/test/logs/`) already use, and
// the exporter refuses to write a fixture that holds an assembled canary.
//
//   node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning scripts/parity/export-logs.ts [--check]
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { jsonEscapeView, jsonSecretViews } from "../../packages/core/src/logs/json-escapes.ts";
import { createRedactor, isSecretKey, maskSecretsInJson, type RedactOptions } from "../../packages/core/src/logs/redact.ts";
import { secretFormsIn, secretFormsOf } from "../../packages/core/src/logs/secret-forms.ts";
import { createSecretMatcher, type SecretMatcher } from "../../packages/core/src/logs/secret-matcher.ts";
import { wellFormedPrefix } from "../../packages/core/src/logs/utf16.ts";
import { listLogFiles } from "../../packages/core/src/logs/files.ts";
import { LevelPolicy } from "../../packages/core/src/logs/levels.ts";
import { alignForward, backwardLines, forwardLines, lastLineBoundary, seekByTs } from "../../packages/core/src/logs/lines.ts";
import { sanitise, signalLevel } from "../../packages/core/src/logs/output.ts";
import { fromRpcMeta, parseTraceparent, withTrace } from "../../packages/core/src/logs/trace.ts";
import { cap, createWriter } from "../../packages/core/src/logs/writer.ts";
import { createLogsMethods } from "../../packages/core/src/logs/methods.ts";
import { CursorError, decodeCursor, fingerprint, mintCursor, runQuery, type LogFilter, type Order } from "../../packages/core/src/logs/query.ts";
import { memoryAuditSink } from "../../packages/core/src/rbac/audit.ts";
import { RpcError } from "../../packages/core/src/rpc/errors.ts";
import { exporterMain } from "./lib.mjs";

const MARK = "[REDACTED:secret]";
const BS = String.fromCharCode(92);
const HIGH = String.fromCharCode(0xd83d); // a lone high surrogate when nothing follows
const LOW = String.fromCharCode(0xde00);
const PAIR = HIGH + LOW; // U+1F600
const FFFD = String.fromCharCode(0xfffd);

type Piece = string | { units: number[] };
export type Enc = string | { units: number[] } | { parts: Piece[] };

/** Credential-shaped canaries, assembled from fragments (the way the TypeScript tests do), registered for `enc`. */
const shapes: string[][] = [];
const S = (...parts: string[]): string => { if (!shapes.some((p) => p.join("|") === parts.join("|"))) shapes.push(parts); return parts.join(""); };

const units = (s: string): number[] => Array.from({ length: s.length }, (_, at) => s.charCodeAt(at));
const piece = (s: string): Piece => (s.isWellFormed() ? s : { units: units(s) });

/** A string as the fixture stores it (see the header). */
export function enc(s: string): Enc {
  const parts: Piece[] = []; let plain = ""; let used = false;
  for (let at = 0; at < s.length;) {
    const hit = shapes.filter((p) => s.startsWith(p.join(""), at)).sort((a, b) => b.join("").length - a.join("").length)[0];
    if (!hit) { plain += s[at]!; at++; continue; }
    if (plain) { parts.push(piece(plain)); plain = ""; }
    parts.push(...hit); at += hit.join("").length; used = true;
  }
  if (!used) return s.isWellFormed() ? s : { units: units(s) };
  if (plain) parts.push(piece(plain));
  return { parts };
}
const encAll = (list: readonly string[]): Enc[] => list.map(enc);

/** `fakeSecret` of `redact-secrets-only.test.ts`: a value derived from a label, with no key-like shape. */
const fake = (label: string): string => `fixture-${label}-${createHash("sha256").update(label).digest("hex").slice(0, 16)}`;
/** What `randomUUID()` is in the TypeScript tests, made deterministic. */
const uuid = (label: string): string => { const h = createHash("sha256").update(`uuid:${label}`).digest("hex"); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`; };
const hex4 = (code: number): string => code.toString(16).padStart(4, "0");
/** Every UTF-16 unit as a `\uXXXX` escape. */
const escapeAll = (s: string): string => Array.from({ length: s.length }, (_, at) => `${BS}u${hex4(s.charCodeAt(at))}`).join("");

interface Options { pii?: boolean; secrets?: string[]; secretsOnly?: boolean; secretForms?: string[] }
const encOptions = (o: Options) => ({
  ...(o.pii ? { pii: true } : {}), ...(o.secretsOnly ? { secretsOnly: true } : {}),
  ...(o.secrets ? { secrets: encAll(o.secrets) } : {}), ...(o.secretForms ? { secretForms: encAll(o.secretForms) } : {}),
});
const redactorOf = (o: Options) => createRedactor(o as RedactOptions);

// ---- redact.json: text, value, window, key names, maskJson ----

interface TextCase { name: string; options: ReturnType<typeof encOptions>; input: Enc; output: Enc; note?: string }
const textCases: TextCase[] = [];
function text(name: string, input: string, options: Options = {}, note?: string): void {
  textCases.push({ name, options: encOptions(options), input: enc(input), output: enc(redactorOf(options).text(input)), ...(note ? { note } : {}) });
}

const SK = S("sk-", "A1b2C3d4E5f6G7h8I9j0K1l2");
const GHP = S("ghp_", "a".repeat(36));
const JWT = S("eyJhbGciOiJIUzI1NiJ9.", "eyJzdWIiOiIxMjM0In0.", "c2lnbmF0dXJlX3ZhbHVl");
const AKIA = S("AKIA", "ABCDEFGHIJKLMNOP");
const XOXB = S("xoxb-", "1234567890-abcdef");
const EK = S("ek_", "q".repeat(20));
const BEARER = S("Bearer ", "abc.def-ghi_jkl");
function buildTextCases(): void {
  // redact.test.ts: "replaces credential shapes in free text and says which rule did it"
  [SK, GHP, JWT, AKIA, XOXB, EK, BEARER].forEach((secret, i) => text(`credential-shape-${i + 1}`, `call failed with ${secret} in the header`));
  text("basic-is-an-ordinary-word", "Basic info about this");
  // "redacts key=value and JSON-ish pairs inside a message"
  text("key-value-pair", "retry token=abc123 attempt=2");
  text("json-pair", '{"client_secret":"s3cr3t","ok":1}');
  text("counter-name-stays", "max_tokens=100");
  // "redacts PLUR1BUS_* env values and long base64url runs, but keeps hex digests readable"
  text("plur1bus-env", "PLUR1BUS_HOME=/srv/x");
  text("base64url-run", `blob ${S("A".repeat(20), "-", "b".repeat(30))}`);
  text("hex-digest-stays", `sha256 ${"a".repeat(64)}`);
  // "urls lose userinfo, query values and fragment; parameter names stay"
  text("url", "GET https://user:pw@example.test/cb?code=abc&state=xyz#frag now");
  // "replaces deny-listed paths by class and a short hash"
  for (const [name, p] of [["ssh", "/home/u/.ssh/id_ed25519"], ["cloud-cli-windows", "C:\\Users\\u\\.aws\\credentials"], ["dotenv", "/srv/app/.env"], ["gnupg", "/home/u/.gnupg/pubring.kbx"]] as const) text(`deny-path-${name}`, `opened ${p} failed`);
  text("ordinary-path-stays", "opened /home/u/project/readme.md");
  // "PII only when asked"
  const pii = { pii: true };
  text("pii-off-email", "mail a.b@example.test");
  text("pii-off-iban", "pay to DE89370400440532013000 now");
  text("pii-off-card", "card 4111-2222-3333-4444 exp");
  text("pii-on-email", "mail a.b@example.test", pii);
  text("pii-on-iban", "pay to DE89370400440532013000 now", pii);
  text("pii-on-iban-spaced", "pay to DE89 3704 0044 0532 0130 00 now", pii);
  text("pii-on-card-dashed", "card 4111-2222-3333-4444 exp", pii);
  text("pii-on-card-plain", "card 4111222233334444 exp", pii);
  text("pii-on-amex", "amex 3782-822463-10005", pii);
  text("pii-on-phone-e164", "call +4930123456789 now", pii);
  text("pii-on-phone-nanp", "call (555) 123-4567 now", pii);
  text("pii-on-phone-national", "call 030 12345678 now", pii);
  // "secret registry values (and their encodings) when given"
  const hunter = "hunter2hunter2";
  text("registry-value-and-base64", `a ${hunter} b ${Buffer.from(hunter).toString("base64")} c short`, { secrets: [hunter, "short"] });
  // "hex (lower and upper case) and base64url with padding are masked like base64 and percent forms"
  const awkward = "ab?>?>?>cd/+=value-1234";
  const buf = Buffer.from(awkward);
  const std = buf.toString("base64"); const url = buf.toString("base64url");
  const forms = [awkward, std, std.replace(/=+$/, ""), url, url + "=".repeat((4 - (url.length % 4)) % 4), buf.toString("hex"), buf.toString("hex").toUpperCase(), encodeURIComponent(awkward)];
  [...new Set(forms)].forEach((form, i) => text(`registry-form-${i + 1}`, `line ${form} end`, { secrets: [awkward] }));
  text("registry-padded-base64url", `x ${Buffer.from("secret-with-pad!").toString("base64url")}== y`, { secrets: ["secret-with-pad!"] });
  // "the same minimum length applies before the forms are derived, and foreign hex or base64url stays"
  const reg = { secrets: ["abc123", hunter] };
  text("registry-short-value-and-its-forms-stay", "abc123 616263313233 YWJjMTIz", reg);
  const foreignHex = Buffer.from("another-value-xx").toString("hex");
  const digest = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
  const foreignB64 = Buffer.from("another-value-xx").toString("base64url") + "==";
  text("registry-foreign-forms-stay", `h=${foreignHex} d=${digest.toUpperCase()} u=${foreignB64}`, reg);
  const own = Buffer.from(hunter).toString("hex");
  text("registry-own-hex-both-cases", `a ${own} b ${own.toUpperCase()} c`, reg);
  // redact-secrets-only.test.ts
  const only = fake("only");
  const mixed = `k=${only} password=hunter2 Bearer abc.def https://example.test/a?x=1 ${"A".repeat(60)}`;
  text("secrets-only-masks-the-value-and-nothing-else", mixed, { secrets: [only], secretsOnly: true });
  text("full-redactor-applies-every-rule", mixed, { secrets: [only] });
  const short = "s".repeat(7);
  text("secrets-only-below-minimum", `a ${short}`, { secrets: [short], secretsOnly: true });
  text("secrets-only-at-minimum", "a eeeeeeee", { secrets: ["e".repeat(8)], secretsOnly: true });
  const given = [fake("given-a"), fake("given-b")];
  text("secret-forms-option", `${given[0]} ${given[1]}`, { secretForms: [given[0]!], secretsOnly: true });
  text("secret-forms-and-secrets", `${given[0]} ${given[1]}`, { secrets: [given[1]!], secretForms: [given[0]!], secretsOnly: true });
  // redaction-gaps.test.ts
  const pw = ["hunter", "two", "pass"].join("");
  [`Error: token=${pw} x`, `TypeError: password=${pw}`, `cause: password=${pw}, retrying`, `Name: key=1 api_key=${pw}`, `{"msg":"connect failed password=${pw}"}`, `a: b: c: secret=${pw}`]
    .forEach((t, i) => text(`secret-pair-behind-a-prefix-${i + 1}`, t));
  text("pair-behind-error-prefix", "Error: token=abc while connecting");
  text("header-style-after-text", "sent x-api-key: abc123 now");
  text("header-style-line", "x-api-key: abc123");
  text("header-equals-style", "sent x-api-key=abc123");
  text("plain-pair-after-colon", "retry: attempt=2 ok");
  const tail = "Q1w2E3r4T5y6U7i8O9p0A1s2D3f4G5h6J7k8";
  for (const prefix of ["gho", "ghs", "ghu", "ghr", "ghp"]) { const token = S(`${prefix}_`, tail); text(`github-${prefix}`, `gh said ${token} twice: ${token}`); }
  for (const fine of [S("ghost_", tail), "gho_short", S("highgho_", tail.slice(0, 30)), S("ghx_", tail)]) text(`github-lookalike-${fine.slice(0, 6)}`, fine);
  const tg = S("AAHd", "qTcvCH1vGWJxfSeofSAs0K5PALDsaw");
  text("telegram-bot-url", `HTTP 401 for https://api.telegram.org/bot123456789:${tg}/getMe (retrying)`);
  text("telegram-bot-file-url", `HTTP 401 for https://api.telegram.org/file/bot123456789:${tg}/photos/file_1.jpg (retrying)`);
  const slack = [S("T0123ABCD"), S("B0456EFGH"), S("xYz1AbC2dEf3GhI4jKl5MnOp")];
  const discordToken = S("d1sc0rdT0ken_", "Abc-123".repeat(2));
  const guid = (n: string) => `0a1b2c3d-${n}-4e5f-8a9b-0c1d2e3f4a5b`;
  text("slack-webhook", `post to https://hooks.slack.com/services/${slack.join("/")} failed`);
  text("discord-webhook", `post to https://discord.com/api/webhooks/123456789012345678/${discordToken} failed`);
  text("teams-webhook", `post to https://example.webhook.office.com/webhookb2/${guid("aaaa")}@${guid("bbbb")}/IncomingWebhook/0123456789abcdef0123456789abcdef/${guid("cccc")} failed`);
  for (const same of ["https://example.test/docs/robots/index.html", "https://api.telegram.org/bot/getMe", "https://example.test/bot123456789/status", "https://hooks.slack.com/services/", "https://example.test/api/webhooks/list", "see /bot123456789:short/x outside a URL"]) text(`ordinary-url-${same.length}`, same);
  text("url-query-and-fragment-still-run", "https://example.test/a/b?sig=abc123#frag");
  // engine-fold-redaction.test.ts (RE-08)
  for (const quote of ['"', "'"]) text(`quoted-bearer-${quote === '"' ? "double" : "single"}`, `failed Bearer ${quote}FAKE first second${quote} retry`);
  text("authorization-single-line", "Authorization: FAKE first");
  for (const [label, newline] of [["lf", "\n"], ["crlf", "\r\n"]] as const) {
    const input = `Authorization: FAKE first${newline} FAKE second${newline}\tFAKE third${newline}X-Request: public`;
    text(`folded-authorization-${label}`, input);
    text(`folded-authorization-${label}-twice`, redactorOf({}).text(input));
  }
  for (const name of ["access_key", "access-key-id", "accessKeyId"]) text(`access-key-${name}`, `retry ${name}="FAKE value spaces" attempt=2`);
  for (const name of ["credential", "client_credential"]) {
    text(`credential-${name}`, `${name}=FAKE-value`);
    text(`credential-${name}-quoted`, `retry ${name}="FAKE first second" attempt=2`);
    const json = JSON.stringify({ [name]: 'FAKE first " quoted second' });
    text(`credential-${name}-json`, json);
    text(`credential-${name}-json-twice`, redactorOf({}).text(json));
  }
  const botToken = "123456789:" + S("FAKE_bot_value-0123456789/+=.");
  text("bare-telegram-token", `failed ${botToken} retry`);
  text("telegram-lookalike-short", "123456789:short");
  text("telegram-lookalike-slash", "123456789/status");
  for (const t of ["sk-FAKE0123", S("gho_", "F".repeat(30))]) text(`vendor-minimum-${t.slice(0, 4)}`, t);
  text("vendor-minimum-sk-20", S("sk-", "F".repeat(20)));
  text("vendor-minimum-gho-36", S("gho_", "F".repeat(36)));
  // JavaScript/Rust differences the port keeps on purpose or cannot remove (see the README, "Known divergences")
  const KELVIN = String.fromCharCode(0x212a), LONG_S = String.fromCharCode(0x17f), BOM = String.fromCharCode(0xfeff), NEL = String.fromCharCode(0x85);
  text("unicode-fold-kelvin-sign-in-a-header-name", `Coo${KELVIN}ie: abc`, {},
    "a JavaScript /i regexp without the u flag folds case by toUpperCase and never maps a non-ASCII letter to ASCII, so the Kelvin sign is no k; Rust's (?i) uses Unicode simple case folding and redacts (fail closed)");
  text("unicode-fold-long-s-in-a-key-prefix", `${LONG_S}k-${"A1b2C3d4E5f6G7h8I9j0K1l2"}`, {},
    "the credential-shape patterns are case-sensitive: nothing folds U+017F on either side");
  text("js-whitespace-bom-ends-a-bare-value", `password=abc${BOM}def tail`, {},
    "JavaScript's \\s includes U+FEFF and excludes U+0085; Rust's char::is_whitespace is the other way round, so the Rust port tests its own is_js_space");
  text("js-whitespace-nel-does-not-end-a-bare-value", `password=abc${NEL}def tail`, {}, "see the BOM case");
  text("js-whitespace-bom-in-a-path", `read /srv/${BOM}x/.ssh/id_rsa now`, {}, "see the BOM case: the path token ends at a JavaScript space");
  text("js-whitespace-nel-in-a-path", `read /srv/${NEL}x/.ssh/id_rsa now`, {}, "see the BOM case");
  text("js-whitespace-bom-after-bearer", `sent Bearer${BOM}abcdefghijklmnop done`, {},
    "the patterns of redaction.json are compiled with the regex crate, whose \\s is White_Space (U+0085 in, U+FEFF out): they still differ from JavaScript's \\s here");
  text("js-whitespace-nel-after-bearer", `sent Bearer${NEL}abcdefghijklmnop done`, {}, "see the Bearer BOM case");
  text("lone-surrogates-in-the-input-become-replacement-characters", `a${HIGH}b password=x ${LOW}`, {}, "a Rust str cannot hold them: the replay passes the UTF-16 code units");
}

interface ValueCase { name: string; options: ReturnType<typeof encOptions>; inputJson: Enc; outputJson: Enc; note?: string }
const valueCases: ValueCase[] = [];
function value(name: string, inputJson: string, options: Options = {}, note?: string): void {
  const out = redactorOf(options).value(JSON.parse(inputJson));
  valueCases.push({ name, options: encOptions(options), inputJson: enc(inputJson), outputJson: enc(JSON.stringify(out)), ...(note ? { note } : {}) });
}
function buildValueCases(): void {
  // redact.test.ts: "replaces values under secret-looking keys and keeps counts and ids"
  value("secret-looking-keys", JSON.stringify({ authorization: "Bearer abcdefghijkl", accessToken: "t", max_tokens: 10, input_tokens: 3, agent: "bernd", attrs: { password: "x", model: "m", nested: { api_key: "k" } } }));
  value("non-strings-stay", JSON.stringify({ n: 1, z: null, b: true }));
  value("nulls-under-secret-keys-stay", JSON.stringify({ password: null, token: [null], a: { secret: { k: 1 } } }));
  value("arrays-and-credential-shapes", JSON.stringify({ l: [`Bearer ${"abcdefghij"}`, "ok", { token: "t" }] }));
  value("proto-key-is-kept", '{"__proto__":"plain","password":"p","n":{"__proto__":{"token":"t"}}}');
  value("number-keys-order", '{"b":1,"2":2,"a":3,"1":4}');
  // redact-secrets-only.test.ts: "keeps values under secret-looking keys and masks registered values in strings and keys"
  const walk = fake("walk");
  value("secrets-only-keys-and-values", JSON.stringify({ password: "hunter2", note: `x ${walk}`, [walk]: [1, walk, { token: "t" }] }), { secrets: [walk], secretsOnly: true });
  value("default-redactor-keeps-counts", JSON.stringify({ password: "x", n: 1 }));
  // "numbers keys that mask to the same text, in order, so none is lost"
  const [a, b] = [fake("nk-a"), fake("nk-b")];
  value("secrets-only-repeated-key-numbering", JSON.stringify({ [a]: 1, [b]: 2, other: 3, [Buffer.from(a).toString("hex")]: 4 }), { secrets: [a, b], secretsOnly: true },
    "JavaScript numbers the repeats in insertion order; a serde_json::Map iterates in key order, so the Rust port numbers them in that order");
  // numbers that hold a registered value are replaced (a numeric credential in a diagnostic attr)
  value("registered-number", '{"id":4815162342,"text":"pin 4815162342","f":1.5}', { secrets: ["4815162342"] });
  value("registered-number-secrets-only", '{"id":4815162342}', { secrets: ["4815162342"], secretsOnly: true });
  value("registered-number-exponent", '{"n":1.2345678e25,"m":1.2345678e-9,"k":100000000000000000000,"j":0.000001234567,"i":-1234567890123}', { secrets: ["1.2345678e+25", "1.2345678e-9", "100000000000000000000", "0.000001234567", "-1234567890123"] });
  // redaction-gaps.test.ts: "redacts values nested in objects too"
  value("nested-telegram-url", JSON.stringify({ attrs: { foreign_message: `GET https://api.telegram.org/bot123456789:${S("AAHd", "qTcvCH1vGWJxfSeofSAs0K5PALDsaw")}/getMe` } }));
  // engine-fold-redaction.test.ts
  value("access-key-values", JSON.stringify({ access_key: "FAKE first", "access-key-id": "FAKE second", credentials_count: 2 }));
  value("registered-structured-credential", JSON.stringify({ credential: "FAKE-registered-value" }), { secrets: ["FAKE-registered-value"] });
}

/** Window queries of `textWindow` (the writer's source-window policy). */
interface WindowCase { name: string; options: ReturnType<typeof encOptions>; input: Enc; begin: number; end: number; output: Enc }
const windowCases: WindowCase[] = [];
function window(name: string, input: string, begin: number, end: number, options: Options = {}): void {
  windowCases.push({ name, options: encOptions(options), input: enc(input), begin, end, output: enc(redactorOf(options).textWindow!(input, begin, end)) });
}
function buildWindowCases(): void {
  const secret = fake("window");
  const line = `before ${secret} after password=hunter2 tail`;
  window("secret-inside-the-window", line, 0, line.length, { secrets: [secret] });
  window("secret-cut-by-the-window-start", line, 10, line.length, { secrets: [secret] });
  window("secret-cut-by-the-window-end", line, 0, 20, { secrets: [secret] });
  window("window-between-secrets", `${secret} public ${secret} tail`, secret.length + 1, secret.length + 7, { secrets: [secret] });
  window("other-rules-apply-in-the-window", line, 7 + secret.length + 7, line.length, { secrets: [secret] });
  window("empty-window", line, 9, 9, { secrets: [secret] });
}

/** `isSecretKey` over the names of the TypeScript tests and the shared key list. */
function buildKeyNames(): Array<{ name: Enc; secret: boolean }> {
  const names = ["id_token_hint", "Set-Cookie", "tokens", "outputTokens", "password", "accessToken", "max_tokens", "input_tokens", "agent", "model", "api_key", "client_secret",
    "authorization", "x-api-key", "access_key", "access-key-id", "accessKeyId", "credential", "client_credential", "credentials_count", "apiKey", "refresh_token", "secret", "passwd", "private_key", ""];
  return names.map((name) => ({ name: enc(name), secret: isSecretKey(name) }));
}

/** `maskSecretsInJson`: a matcher over given forms, or over the forms of registered values. */
interface MaskJsonCase { name: string; secrets?: Enc[]; forms?: Enc[]; json: Enc; found: boolean; result: "none" | "masked" | "error"; valueJson?: Enc; maskedJson?: Enc; message?: string; note?: string; loneSurrogate?: boolean }
const maskJsonCases: MaskJsonCase[] = [];
function maskJson(name: string, input: { secrets?: string[]; forms?: string[] }, json: string): void {
  const matcher = createSecretMatcher(input.forms ?? secretFormsIn(input.secrets!));
  // JSON.parse keeps a lone surrogate escape; serde_json refuses the text, so the Rust replay checks only the scan of it.
  const lone = new RegExp(BS + BS + "ud[89a-f][0-9a-f]{2}").test(JSON.stringify(JSON.parse(json)).replaceAll(BS + BS, ""));
  const base = { name, ...(input.secrets ? { secrets: encAll(input.secrets) } : {}), ...(input.forms ? { forms: encAll(input.forms) } : {}), json: enc(json), found: matcher.scanJson(json).found, ...(lone ? { loneSurrogate: true, note: "the text holds a lone surrogate escape, which a Rust String cannot hold: serde_json refuses it, the replay checks the scan only" } : {}) };
  try {
    const got = input.forms
      ? maskSecretsInJson(json, JSON.parse(json), [], { forms: input.forms, matcher: createSecretMatcher(input.forms) })
      : maskSecretsInJson(json, JSON.parse(json), input.secrets!);
    maskJsonCases.push(got ? { ...base, result: "masked", valueJson: enc(JSON.stringify(got.value)), maskedJson: enc(got.json) } : { ...base, result: "none" });
  } catch (e) { maskJsonCases.push({ ...base, result: "error", message: (e as Error).message }); }
}
function buildMaskJson(): void {
  const awkward = `${fake("awk")}"${BS}\n\t é 😀`; // quote, backslash, control characters, non-ASCII, a surrogate pair
  const plain = fake("plain");
  let deep: unknown = { leaf: "plain" };
  for (let i = 0; i < 100; i++) deep = { next: deep };
  const deepJson = JSON.stringify(deep);
  maskJson("absent-forms-are-not-walked", { secrets: [fake("absent"), awkward] }, deepJson);
  maskJson("no-secrets", { secrets: [] }, deepJson);
  const values: unknown[] = [
    { a: `x ${plain} y`, [plain]: 1 },
    { a: `before ${awkward} after`, b: [awkward, { [awkward]: awkward }] },
    [`${Buffer.from(plain).toString("base64")}`, Buffer.from(awkward).toString("hex"), encodeURIComponent(awkward)],
    { nested: { deeper: { deepest: [`${plain}${plain}`, `${awkward}${plain}`] } }, n: 7, t: true, z: null },
    { text: `😀${plain}😀`, lone: `${plain}${HIGH}` },
  ];
  values.forEach((v, i) => maskJson(`sound-scan-${i + 1}`, { secrets: [plain, awkward] }, JSON.stringify(v)));
  const pin = "4815162342";
  maskJson("number-holds-the-secret", { secrets: [pin] }, JSON.stringify({ id: Number(pin), text: `pin ${pin}` }));
  maskJson("string-holds-the-secret", { secrets: [pin] }, JSON.stringify({ id: pin }));
  const [a, b] = [fake("nk-a"), fake("nk-b")];
  maskJson("repeated-keys", { secrets: [a, b] }, JSON.stringify({ [a]: 1, [b]: 2, other: 3, [Buffer.from(a).toString("hex")]: 4 }));
  // secret-matcher.test.ts: "compiled JSON scanning resets between tokens and retains original-hit residual semantics"
  const secret = uuid("scan");
  const split = [secret.slice(0, 20), secret.slice(20)];
  maskJson("split-across-tokens", { forms: [secret, "REDACTED"] }, JSON.stringify(split));
  maskJson("matcher-given-forms-mask", { forms: [secret, "REDACTED"] }, JSON.stringify({ ordinary: secret }));
  maskJson("matcher-given-forms-residual", { forms: [secret, "REDACTED"] }, JSON.stringify({ ordinary: secret, other: "REDACTED" }));
}

// ---- secret-matcher.json ----

interface MatcherText { name: string; forms: Enc[]; input: Enc; spans: Array<[number, number]>; masked: Enc; projected: Enc; windows: Array<{ begin: number; end: number; output: Enc }>; bytes?: { input: number[]; spans: Array<[number, number]>; masked: number[] }; note?: string }
const matcherTexts: MatcherText[] = [];
interface MatcherBytes { name: string; forms: Enc[]; input: number[]; spans: Array<[number, number]>; masked: number[]; windows: Array<{ begin: number; end: number; output: number[] }>; maxSourceBytes: number }
const matcherBytes: MatcherBytes[] = [];

function textCase(name: string, forms: string[], input: string, windows: Array<[number, number]> = [], opts: { bytes?: boolean; note?: string } = {}): SecretMatcher {
  const m = createSecretMatcher(forms);
  const projection = m.projectText(input);
  const spans = m.findTextSpans(input).map((s) => [s.start, s.end] as [number, number]);
  if (JSON.stringify(spans) !== JSON.stringify(projection.spans.map((s) => [s.start, s.end]))) throw new Error(`${name}: projectText and findTextSpans disagree`);
  const bytes = opts.bytes ? Buffer.from(input) : undefined;
  matcherTexts.push({
    name, forms: encAll(forms), input: enc(input), spans, masked: enc(m.maskText(input)), projected: enc(projection.text),
    windows: windows.map(([begin, end]) => ({ begin, end, output: enc(m.maskTextWindow(input, begin, end)) })),
    ...(bytes ? { bytes: { input: Array.from(bytes), spans: m.findByteSpans(bytes).map((s) => [s.start, s.end] as [number, number]), masked: Array.from(m.maskBytes(bytes)) } } : {}),
    ...(opts.note ? { note: opts.note } : {}),
  });
  return m;
}
function bytesCase(name: string, forms: string[], input: Buffer, windows: Array<[number, number]> = []): void {
  const m = createSecretMatcher(forms);
  matcherBytes.push({
    name, forms: encAll(forms), input: Array.from(input), spans: m.findByteSpans(input).map((s) => [s.start, s.end] as [number, number]),
    masked: Array.from(m.maskBytes(input)), windows: windows.map(([begin, end]) => ({ begin, end, output: Array.from(m.maskBytesWindow(input, begin, end)) })), maxSourceBytes: m.maxSourceBytes,
  });
}

interface Limits { name: string; forms: Enc[]; maxFormUnits: number; maxSourceBytes: number; distinctForms: number }
const limits: Limits[] = [];
function limit(name: string, forms: string[]): void {
  const m = createSecretMatcher(forms);
  limits.push({ name, forms: encAll(forms), maxFormUnits: m.maxFormUnits, maxSourceBytes: m.maxSourceBytes, distinctForms: m.forms.length });
}

function buildMatcherCases(): void {
  // "mixed raw and escaped overlaps use their complete original source union"
  const value = uuid("mixed").replaceAll("-", "");
  const escaped = value.slice(0, 5) + BS + "u" + hex4(value.charCodeAt(5)) + value.slice(6, 13);
  textCase("mixed-raw-and-escaped-overlap", [value.slice(0, 8), value.slice(5, 13)], `before ${escaped} after`, [[9, 23]]);
  // "source windows retain their original position after earlier matches shrink"
  const secret = uuid("shrink");
  const shrink = `${secret} public ${secret} tail`;
  const begin = secret.length + 1;
  textCase("window-after-earlier-matches-shrink", [secret], shrink, [[begin, begin + 6], [begin, shrink.length - 6]]);
  textCase("adjacent-matches-keep-separate-markers", [secret], secret + secret);
  // "an empty source window emits no marker even inside a registered value"
  const empty = uuid("empty");
  textCase("empty-window-inside-a-value", [empty], empty, [[8, 8], [0, 0], [empty.length, empty.length]]);
  // "masking a surrogate half conceals its whole code point without creating another registered spelling"
  const halfPrefix = uuid("half-prefix"), halfSecret = uuid("half-secret") + HIGH;
  textCase("surrogate-half-conceals-the-code-point", [halfSecret, halfPrefix + MARK + FFFD], halfPrefix + halfSecret + LOW);
  // "source spans include complete surrogate pairs and prevent a three-stage replacement cascade"
  const [first, middle, last] = [uuid("cascade-1"), uuid("cascade-2"), uuid("cascade-3")];
  const tailText = ` public ${uuid("cascade-tail")}`;
  const cascade = first + PAIR + middle + PAIR + last + tailText;
  textCase("pair-complete-spans-no-cascade", [first + HIGH, FFFD + middle + HIGH, FFFD + last], cascade, [[first.length + 2, cascade.length]]);
  // "matching a surrogate half covers its entire <spelling> source spelling"
  const [prefix, suffix] = [uuid("spelling-prefix"), uuid("spelling-suffix")];
  for (const [label, pair] of [["raw", PAIR], ["escaped", `${BS}ud83d${BS}ude00`], ["raw-high", HIGH + BS + "ude00"], ["raw-low", BS + "ud83d" + LOW]] as const)
    textCase(`surrogate-half-spelling-${label}`, [prefix + HIGH], prefix + pair + suffix, [[prefix.length, prefix.length + 1]]);
  // "pair expansion at both edges remains inside the declared escaped-source padding"
  const edge = uuid("edge");
  const edgeEscaped = `${BS}ud83d${BS}ude00` + escapeAll(edge) + `${BS}ud83d${BS}ude00`;
  const edgeMatcher = textCase("pair-expansion-at-both-edges", [LOW + edge + HIGH], edgeEscaped, [], { bytes: true });
  if (edgeMatcher.maxSourceBytes < Buffer.byteLength(edgeEscaped)) throw new Error("padding too small");
  limit("edge-padding", [LOW + edge + HIGH]);
  // "public source-window edges omit incomplete code points instead of inventing a registered replacement spelling"
  const publicText = uuid("public");
  textCase("window-edges-omit-incomplete-code-points", [FFFD + publicText, publicText + FFFD], PAIR + publicText, [[1, publicText.length + 2]]);
  textCase("window-edges-omit-incomplete-code-points-trailing", [FFFD + publicText, publicText + FFFD], publicText + PAIR, [[0, publicText.length + 1]]);
  // "byte padding covers fully escaped UTF-16 source spellings at either window edge"
  const padded = `${uuid("padded")}é😀`;
  const paddedEscaped = escapeAll(padded);
  const paddedMatcher = textCase("fully-escaped-source", [padded], paddedEscaped, [[3, paddedEscaped.length - 2]], { bytes: true });
  if (paddedMatcher.maxSourceBytes < Buffer.byteLength(paddedEscaped)) throw new Error("padding too small");
  limit("fully-escaped-source", [padded]);
  bytesCase("fully-escaped-source-bytes", [padded], Buffer.from(paddedEscaped), [[3, Buffer.byteLength(paddedEscaped) - 2]]);
  // plain matches, no match, a form that is only part of a longer word
  textCase("plain-and-absent", [uuid("plain"), "short-form"], `x ${uuid("plain")} y short-form z ${uuid("plain").slice(0, 20)}`);
  textCase("json-escaped-form-in-wire-text", ["line1\nline2-0123"], `{"k":"line1${BS}nline2-0123"}`);
  textCase("lone-surrogate-text-is-well-formed-in-the-output", [uuid("lone")], `a${HIGH}${uuid("lone")}${LOW}b`);

  // "byte windows mask before base64 while preserving arbitrary bytes outside matches"
  const secretBytes = `${uuid("bytes")}é😀`;
  const before = Buffer.from([0xff, 0, 0xfe]), after = Buffer.from([0xf5, 0x80, 0]);
  const input = Buffer.concat([before, Buffer.from(secretBytes), after]);
  bytesCase("bytes-around-a-secret", [secretBytes], input, [[7, input.length - 1], [0, input.length], [3, 3]]);
  // "invalid UTF-8 does not invent a matching replacement character or change unrelated bytes"
  const [p, s] = [uuid("invalid-prefix"), uuid("invalid-suffix")];
  bytesCase("invalid-utf8-matches-nothing", [p + FFFD + s], Buffer.concat([Buffer.from(p), Buffer.from([0xff]), Buffer.from(s)]));
  bytesCase("overlong-and-truncated-sequences", [uuid("overlong")], Buffer.concat([Buffer.from([0xc0, 0x80, 0xe0, 0x80, 0x80, 0xed, 0xa0, 0x80, 0xf4, 0x90, 0x80, 0x80, 0xe2, 0x82]), Buffer.from(uuid("overlong")), Buffer.from([0xf0, 0x9f])]));
  bytesCase("astral-form-in-bytes", [PAIR + uuid("astral")], Buffer.from(`k=${PAIR}${uuid("astral")};`));

  // construction: duplicates, empty forms and the limits
  limit("duplicates-and-empty-forms", [uuid("dup"), uuid("dup"), "", uuid("other")]);
  limit("no-forms", []);
  limit("lone-surrogate-form", [uuid("lone-form") + HIGH]);
  limit("single-form", ["abcdefgh"]);
}

/** `secretFormsOf` / `secretFormsIn` and the helpers of utf16.ts and json-escapes.ts. */
function buildFormsAndHelpers() {
  const values = [uuid("form-a"), "ab?>?>?>cd/+=value-1234", `${fake("awk")}"${BS}\n\t é 😀`, "a/b+c=d é", "line1\nline2"];
  const formsOf = values.map((v) => ({ value: enc(v), forms: encAll(secretFormsOf(v)) }));
  const [a, b] = [fake("form-a"), fake("form-b")];
  const formsIn = [
    { name: "two-values", values: encAll([a, b]) }, { name: "repeated-and-short", values: encAll([a, b, a, a, "short", b]) },
    { name: "only-short", values: encAll(["short"]) }, { name: "none", values: [] },
    { name: "minimum-is-in-units", values: encAll(["é".repeat(8), "é".repeat(7), "😀".repeat(4), "😀".repeat(3)]) },
    { name: "tie-order", values: encAll(["aaaaaaaa", "bbbbbbbb", "cccccccc"]) },
  ].map((c) => ({ ...c, forms: encAll(secretFormsIn(c.values.map((v) => decode(v)))) }));
  const prefixes = [["abc", 2], ["abc", 3], ["abc", 10], ["abc", 0], ["ab" + PAIR + "c", 3], ["ab" + PAIR + "c", 4], [PAIR, 1], [HIGH, 5], ["a" + HIGH + "b", 2], ["a" + HIGH, 2], [LOW + "x", 1]] as const;
  const wellFormed = prefixes.map(([t, n]) => ({ text: enc(t), limit: n, output: enc(wellFormedPrefix(t, n)) }));
  const escapes = ["plain", `a${BS}nb${BS}u0041c`, `${BS}q`, `a${BS}nb${BS}u0041${BS}q${BS}u00zz`, `${BS}${BS}n`, `${BS}ud83d`, `x${BS}"y${BS}/z${BS}t`, `${BS}u004`, `${BS}`, "é" + BS + "n" + "😀" + BS + "u0041"]
    .map((input) => { const v = jsonEscapeView(input); return { input: enc(input), view: v ? { text: enc(v.text), offsets: Array.from({ length: v.text.length + 1 }, (_, at) => v.sourceOffset(at)) } : null }; });
  const secretViews = [
    `{"k":"a${BS}${BS}u0041 ${BS}ud83d"}`, `{"k":"plain"}`, `["${BS}u0061${BS}u0062","${BS}${BS}u0061"]`, `"unterminated ${BS}n`, `"a" "b${BS}n" ${BS}n "c${BS}u0041"`, `"bad${BS}q" "ok${BS}n"`, `"ctl\u0001${BS}n" "x${BS}n"`,
  ].map((json) => ({ json: enc(json), views: jsonSecretViews(json).map(enc) }));
  return { formsOf, formsIn, wellFormed, escapes, secretViews };
}
const decode = (e: Enc): string => typeof e === "string" ? e : "units" in e ? String.fromCharCode(...e.units) : e.parts.map((p) => typeof p === "string" ? p : String.fromCharCode(...p.units)).join("");

// ---- levels, trace, output, files, lines, records: the write path of P4-11 task 2 ----

const T0 = 1791374400000; // 2026-10-07T12:00:00Z
const HOUR = 3600000;

/** `levels.json`: the live level policy (`levels.ts`). A step is `update`, `clock` (ms after T0) or `resolve`. */
function buildLevels() {
  type Step = { op: "update"; settings: { defaultLevel?: string; levels?: Record<string, string>; traceUntilIn?: number } } | { op: "clock"; at: number } | { op: "resolve"; kind: string; id: string };
  const cases: { name: string; steps: Step[]; results?: unknown[] }[] = [];
  const add = (name: string, steps: Step[]): void => { cases.push({ name, steps }); };
  const at = (kind: string, id: string): Step => ({ op: "resolve", kind, id });
  add("default-is-info", [at("harness", "core"), at("extension", "x")]);
  add("default-and-kind-and-source-overrides", [
    { op: "update", settings: { defaultLevel: "debug", levels: { harness: "warn", "harness:core": "error" } } },
    at("harness", "core"), at("harness", "other"), at("extension", "x"),
  ]);
  add("a-key-covers-its-slash-children", [
    { op: "update", settings: { levels: { "extension:foo": "warn" } } },
    at("extension", "foo"), at("extension", "foo/bar"), at("extension", "foobar"), at("extension", "foo/bar/baz"),
  ]);
  add("the-longest-key-wins", [
    { op: "update", settings: { defaultLevel: "info", levels: { extension: "warn", "extension:foo": "error", "extension:foo/bar": "debug" } } },
    at("extension", "foo"), at("extension", "foo/bar"), at("extension", "foo/baz"), at("extension", "zed"),
  ]);
  add("removing-an-override-restores-the-default", [
    { op: "update", settings: { levels: { harness: "error" } } }, at("harness", "core"),
    { op: "update", settings: {} }, at("harness", "core"),
  ]);
  add("invalid-source-key", [
    { op: "update", settings: { levels: { "Bad Key": "warn" } } }, at("harness", "core"),
    { op: "update", settings: { levels: { harness: "warn" } } },
    { op: "update", settings: { levels: { "harness:": "warn" } } }, at("harness", "core"),
  ]);
  add("trace-needs-a-future-expiry-within-a-day", [
    { op: "update", settings: { defaultLevel: "trace" } },
    { op: "update", settings: { defaultLevel: "trace", traceUntilIn: 0 } },
    { op: "update", settings: { defaultLevel: "trace", traceUntilIn: -HOUR } },
    { op: "update", settings: { defaultLevel: "trace", traceUntilIn: 24 * HOUR + 1 } },
    { op: "update", settings: { defaultLevel: "trace", traceUntilIn: 24 * HOUR } },
    at("harness", "core"),
    { op: "update", settings: { levels: { harness: "trace" } } },
    { op: "update", settings: { levels: { harness: "trace" }, traceUntilIn: HOUR } },
    at("harness", "core"), at("extension", "x"),
  ]);
  add("trace-lapses-once-per-source-key", [
    { op: "update", settings: { defaultLevel: "trace", traceUntilIn: HOUR } },
    at("harness", "core"), { op: "clock", at: HOUR - 1 }, at("harness", "core"),
    { op: "clock", at: HOUR }, at("harness", "core"), at("harness", "core"), at("extension", "x"), at("extension", "x"),
    { op: "update", settings: { defaultLevel: "trace", traceUntilIn: 2 * HOUR } }, { op: "clock", at: 3 * HOUR }, at("harness", "core"), at("harness", "core"),
  ]);
  for (const c of cases) {
    let now = T0; const expired: string[] = [];
    const policy = new LevelPolicy({ now: () => now, expired: (key: string) => expired.push(key) });
    c.results = c.steps.map((step) => {
      if (step.op === "clock") { now = T0 + step.at; return {}; }
      if (step.op === "update") {
        const { traceUntilIn, ...rest } = step.settings;
        try { policy.update({ ...rest, ...(traceUntilIn !== undefined ? { traceUntil: T0 + traceUntilIn } : {}) } as any); return { ok: true }; }
        catch (e) { return { error: (e as Error).message }; }
      }
      const before = expired.length;
      const level = policy.resolve({ kind: step.kind as any, id: step.id, version: null });
      return { level, expired: expired.slice(before) };
    });
  }
  return { cases };
}

/** `trace.json`: `parseTraceparent` and the adoption rule of `fromRpcMeta` (fresh ids are random, so only the rule is recorded). */
function buildTrace() {
  const T = "0123456789abcdef0123456789abcdef", Sp = "0123456789abcdef";
  const inputs: [string, unknown][] = [
    ["valid", `00-${T}-${Sp}-01`], ["flags-00", `00-${T}-${Sp}-00`], ["upper-case-hex", `00-${T.toUpperCase()}-${Sp}-01`], ["zero-trace", `00-${"0".repeat(32)}-${Sp}-01`],
    ["zero-span", `00-${T}-${"0".repeat(16)}-01`], ["other-version", `01-${T}-${Sp}-01`], ["short-trace", `00-${T.slice(1)}-${Sp}-01`], ["long-span", `00-${T}-${Sp}0-01`],
    ["flags-not-hex", `00-${T}-${Sp}-zz`], ["trailing-newline", `00-${T}-${Sp}-01\n`], ["leading-space", ` 00-${T}-${Sp}-01`], ["tracestate-suffix", `00-${T}-${Sp}-01-extra`],
    ["empty", ""], ["number", 7], ["null", null], ["object", { traceparent: "x" }],
  ];
  const parse = inputs.map(([name, input]) => ({ name, input, output: parseTraceparent(input) }));
  const metas: [string, unknown, boolean][] = [
    ["trusted-valid", { traceparent: `00-${T}-${Sp}-01` }, true], ["untrusted-valid", { traceparent: `00-${T}-${Sp}-01` }, false],
    ["trusted-invalid", { traceparent: "nope" }, true], ["untrusted-invalid", { traceparent: "nope" }, false],
    ["trusted-no-carrier", {}, true], ["null-meta", null, true], ["trusted-zero-trace", { traceparent: `00-${"0".repeat(32)}-${Sp}-01` }, true],
  ];
  const fromMeta = metas.map(([name, meta, trusted]) => {
    const ctx = fromRpcMeta(meta, trusted);
    const adopted = ctx.link_trace_id === undefined && meta !== null && typeof meta === "object" && trusted && parseTraceparent((meta as any).traceparent) !== null;
    return { name, meta, trusted, adopted, traceparent: adopted ? ctx.traceparent : null, link: ctx.link_trace_id ?? null };
  });
  return { parse, fromMeta };
}

/** `output.json`: `sanitise`, `signalLevel`, `cap`. */
function buildOutput() {
  const ESC = String.fromCharCode(27), BEL = String.fromCharCode(7), ch = (n: number): string => String.fromCharCode(n);
  const sanitiseInputs: [string, string][] = [
    ["plain", "hello world"], ["sgr", `a${ESC}[31mred${ESC}[0m b`], ["cursor", `${ESC}[?25h${ESC}[1;2H!`], ["osc-bel", `x${ESC}]0;title${BEL}y`], ["osc-st", `x${ESC}]0;title${ESC}${BS}y`],
    ["osc-unterminated", `x${ESC}]0;never ends`], ["csi-unterminated", `x${ESC}[31`], ["csi-with-intermediates", `x${ESC}[1 qy`], ["lone-esc", `a${ESC}b`],
    ["controls", `t${ch(9)}ab${ch(0)}${BEL}${ch(127)}${ch(0x85)}${ch(13)}`],
    ["c1-range", `a${ch(0x80)}b${ch(0x9f)}c${ch(0xa0)}d`], ["unicode", "ünïcödé 😀 日本"], ["osc-then-csi", `${ESC}]x${BEL}${ESC}[0m`], ["two-osc", `${ESC}]a${BEL}k${ESC}]b${BEL}`],
    ["newline-removed", "a\nb"], ["esc-then-osc", `${ESC}${ESC}]t${BEL}z`],
  ];
  const sanitiseCases = sanitiseInputs.map(([name, input]) => ({ name, input, output: sanitise(input) }));
  const signals: [string, any][] = [
    ["none", {}], ["exit-0", { exitCode: 0 }], ["exit-1", { exitCode: 1 }], ["signal", { signal: "SIGKILL" }], ["empty-signal", { signal: "" }], ["protocol", { protocolError: true }],
    ["503-retrying", { httpStatus: 503, retrying: true }], ["503", { httpStatus: 503 }], ["429-retrying", { httpStatus: 429, retrying: true }], ["404-retrying", { httpStatus: 404, retrying: true }],
    ["399", { httpStatus: 399 }], ["200", { httpStatus: 200 }], ["exit-and-503-retrying", { exitCode: 2, httpStatus: 503, retrying: true }],
  ];
  const signalCases = signals.map(([name, input]) => ({ name, input, output: signalLevel(input) }));
  const caps: [string, number][] = [["abc", 3], ["abcdef", 6], ["abcdefg", 6], ["a😀😀b", 6], ["é", 1], ["é", 2], ["éé", 4], ["日本語", 9], ["日本語", 8], ["abc", 0], ["abcd", 3], ["😀", 3], ["😀", 4]];
  const capCases = caps.map(([text, bytes]) => ({ text, bytes, output: cap(text, bytes) }));
  return { sanitise: sanitiseCases, signal: signalCases, cap: capCases };
}

/** `files.json`: the listing of `listLogFiles` over a directory holding `names`, and the collation of components. */
function buildFiles() {
  const listings: [string, string[]][] = [
    ["rotation-order", ["core.log", "core.log.1", "core.log.2", "core.log.10", "audit.log", "audit.log.1", "payload.log", "payload.log.1", "agent.log", "notes.txt", "core.log.x"]],
    ["components-with-punctuation", ["mcp-b.log", "mcp_a.log", "mcp.a.log", "mcp1.log", "mcp10.log", "mcp2.log", "mcpa.log", "mcpb.log"]],
    ["case", ["Zed.log", "alpha.log", "Beta.log", "gamma.log", "Delta.log.2", "Delta.log.1"]],
    ["leading-digits-and-dots", ["1core.log", "core.v2.log", "core.log", "core-v2.log", "core_v2.log", "0.log", "a.b.log.3"]],
    ["names-the-pattern-refuses", [".log", "-x.log", "x.log.", "x.log.1a", "x.log.1.2", "x..log", "x.LOG", "log", "x.log.-1", "x.log.01", ".hidden.log"]],
    ["only-audit", ["audit.log", "audit.log.3", "audit.log.12", "audit.log.2", "core.log"]],
    ["empty", []],
  ];
  const cases = listings.flatMap(([name, names]) => (["diagnostic", "audit"] as const).map((stream) => {
    const dir = mkdtempSync(join(tmpdir(), "p4-11-files-"));
    try {
      for (const n of names) writeFileSync(join(dir, n), "");
      return { name: `${name}-${stream}`, names, stream, listed: listLogFiles(dir, stream).map((f) => ({ name: basename(f.path), component: f.component, generation: f.generation })) };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }));
  const components = ["a", "A", "b", "B", "_x", "-x", ".x", "x1", "x10", "x2", "x-1", "x_1", "x.1", "x1a", "xa", "mcp_a", "mcp-b", "mcp.a", "Z9", "z9", "core", "Core", "core2", "core-1", "core.1", "core_1", "0", "00", "1a", "a1", "ab", "aB", "Ab", "AB"];
  const collation = [...components].sort((a, b) => a.localeCompare(b));
  return { cases, collation: { input: components, sorted: collation } };
}

/** `lines.json`: the streaming reader (`lines.ts`) over generated files. A file is a list of segments. */
type Segment = string | { fill: string; bytes: number } | { tsLines: { count: number; pad: number; stepMs: number } };
function segmentsBytes(segments: Segment[]): Buffer {
  const parts: Buffer[] = [];
  for (const s of segments) {
    if (typeof s === "string") parts.push(Buffer.from(s));
    else if ("fill" in s) parts.push(Buffer.alloc(s.bytes, s.fill));
    else for (let i = 0; i < s.tsLines.count; i++) parts.push(Buffer.from(`{"ts":"${new Date(T0 + i * s.tsLines.stepMs).toISOString()}","n":${i},"pad":"${"x".repeat(s.tsLines.pad)}"}\n`));
  }
  return Buffer.concat(parts);
}
/** A line as the fixture stores it: short text as it is, long text as its byte length, head and SHA-256. */
const shapeLine = (l: { text: string; tooLong: boolean }) => Buffer.byteLength(l.text) <= 64 ? l : { tooLong: l.tooLong, len: Buffer.byteLength(l.text), head: l.text.slice(0, 16), sha256: createHash("sha256").update(l.text).digest("hex") };
const tsOfLine = (line: string): string | null => /"ts":"([^"]*)"/.exec(line)?.[1] ?? null;
async function buildLines() {
  const files: { name: string; segments: Segment[] }[] = [
    { name: "plain", segments: ["one\ntwo\nthree\n"] },
    { name: "unterminated-last-line", segments: ["one\ntwo\nthr"] },
    { name: "crlf-and-blank-lines", segments: ["one\r\n\r\n\ntwo\r\n\r\nthree\n"] },
    { name: "multibyte", segments: ["é\n😀日本\nx\n"] },
    { name: "one-newline", segments: ["\n"] },
    { name: "no-newline", segments: ["abc"] },
    { name: "long-lines", segments: ["short\n", { fill: "y", bytes: 40 }, "\nmid\n", { fill: "z", bytes: 41 }, "\nend\n"] },
    { name: "spans-chunks", segments: ["head\n", { fill: "a", bytes: 70000 }, "\n", { fill: "b", bytes: 65535 }, "\n", { fill: "c", bytes: 65536 }, "\ntail\n"] },
    { name: "stamped-lines", segments: [{ tsLines: { count: 1500, pad: 60, stepMs: 1000 } }] },
  ];
  const cases: any[] = [];
  for (const f of files) {
    const buf = segmentsBytes(f.segments); const dir = mkdtempSync(join(tmpdir(), "p4-11-lines-"));
    try {
      const path = join(dir, "a.log"); writeFileSync(path, buf);
      const fh = await open(path, "r");
      try {
        const size = buf.length;
        const big = f.name === "stamped-lines";
        // The long stamped file keeps the count and the first three lines only (the whole list would be 100 KB of lines).
        const collect = async (gen: AsyncGenerator<{ text: string; tooLong: boolean }>) => { const out = []; for await (const l of gen) out.push(shapeLine(l)); return big ? { count: out.length, lines: out.slice(0, 3) } : { count: out.length, lines: out }; };
        const ends = [0, 1, 2, 3, 5, 10, 14, size - 1, size, 65536, 65537, 70005, 131078].filter((n) => n >= 0 && n <= size);
        const uniq = [...new Set(ends)].sort((a, b) => a - b);
        const maxLines = f.name === "long-lines" ? [undefined, 40, 10] : [undefined];
        const forward: any[] = [], backward: any[] = [], boundary: any[] = [], align: any[] = [], seek: any[] = [];
        for (const maxLine of maxLines) {
          const mo = maxLine === undefined ? {} : { maxLine };
          forward.push({ start: 0, end: size, ...mo, ...(await collect(forwardLines(fh, { start: 0, end: size, ...mo }))) });
          backward.push({ end: size, ...mo, ...(await collect(backwardLines(fh, { end: size, ...mo }))) });
        }
        for (const end of uniq) {
          if (!big) backward.push({ end, ...(await collect(backwardLines(fh, { end }))) });
          boundary.push({ end, output: await lastLineBoundary(fh, end) });
          align.push({ off: end, output: await alignForward(fh, end, size) });
          if (!big && end > 0 && end < size) { const start = await alignForward(fh, end, size); forward.push({ start, end: size, ...(await collect(forwardLines(fh, { start, end: size }))) }); }
        }
        if (big) {
          for (const [offset, strict] of [[-5, false], [0, false], [0, true], [1, false], [749, false], [749, true], [750, false], [1499, true], [1499, false], [1500, false], [5000, false]] as const) {
            const ts = new Date(T0 + offset * 1000).toISOString();
            seek.push({ ts, strict, output: await seekByTs(fh, size, ts, tsOfLine, strict) });
          }
          seek.push({ ts: "2026-10-07T12:00:00.500Z", strict: false, output: await seekByTs(fh, size, "2026-10-07T12:00:00.500Z", tsOfLine, false) });
          seek.push({ ts: "2026-10-07T12:12:30.000Z", strict: false, unreadable: true, output: await seekByTs(fh, size, "2026-10-07T12:12:30.000Z", () => null, false) });
        }
        cases.push({ name: f.name, segments: f.segments, size, forward, backward, boundary, align, seek });
      } finally { await fh.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  return { cases };
}

/** `records.json`: op sequences against a writer with a fixed clock and trace; the TypeScript lines are recorded. */
const TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
type Op = any;
const REPEAT = (text: string, times: number) => ({ $repeat: [text, times] });
const expandRepeats = (v: any): any => Array.isArray(v) ? v.map(expandRepeats) : v && typeof v === "object" ? ("$repeat" in v ? v.$repeat[0].repeat(v.$repeat[1]) : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expandRepeats(x)]))) : v;
const sortedDeep = (v: any): any => Array.isArray(v) ? v.map(sortedDeep) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortedDeep(v[k])])) : v;
/** The line the Rust writer produces for a TypeScript line: attribute keys (and legacy fields) sorted, everything else as written. */
function canonicalLine(line: string): string {
  const v = JSON.parse(line);
  if ("attrs" in v) return JSON.stringify({ ...v, attrs: sortedDeep(v.attrs) });
  if (Object.keys(v)[3] === "msg") return line; // the over-long legacy line: {at, level, role, msg, truncated, bytes}, a fixed order
  const { at, level, role, msg, ...extra } = v;
  return JSON.stringify({ at, level, role, ...sortedDeep(extra), msg });
}
async function buildRecords() {
  const secret = fake("records-secret"), pinned = fake("records-pinned");
  const cases: { name: string; options?: any; ops: Op[] }[] = [];
  const add = (name: string, ops: Op[], options?: any): void => { cases.push({ name, ops, ...(options ? { options } : {}) }); };
  const started = (pid: number): Op => ({ op: "write", event: "core.process.started", attrs: { pid } });
  add("started-record", [started(4242), { op: "flush" }]);
  add("attributes-in-caller-order", [{ op: "write", event: "process.output.line", attrs: { untrusted: true, text: "hello" }, fields: { stream: "stdout" } }, { op: "flush" }]);
  add("dedup-then-summary", [started(1), started(1), started(1), { op: "advance", ms: 61000 }, { op: "tick" }, started(2), { op: "flush" }]);
  add("dedup-summary-at-close", [started(7), started(7), { op: "close" }]);
  add("level-filter-hides-debug", [{ op: "write", event: "scheduler.run.started", attrs: { job: "j" } }, { op: "flush" }]);
  add("level-change-records", [
    { op: "levels", settings: { defaultLevel: "debug", levels: { extension: "warn" } } },
    { op: "write", event: "scheduler.run.started", attrs: { job: "j" } },
    { op: "levels", settings: { defaultLevel: "info", levels: { extension: "warn", "harness:core": "error" } } },
    { op: "flush" },
  ]);
  add("trace-level-expires", [
    { op: "levels", settings: { defaultLevel: "trace", traceUntilIn: HOUR } }, { op: "advance", ms: HOUR + 1 }, { op: "tick" }, { op: "flush" },
  ]);
  add("unregistered-event", [{ op: "write", event: "nope.not.there", attrs: {} }, { op: "flush" }]);
  add("invalid-attributes-throw", [{ op: "write", event: "core.process.started", attrs: {} }, { op: "write", event: "core.process.started", attrs: { pid: "x" } }, { op: "flush" }]);
  add("audit-event-refused", [{ op: "write", event: "agent.create", attrs: {} }, { op: "flush" }]);
  add("source-override", [{ op: "write", event: "scheduler.run.started", attrs: { job: "j" }, fields: { source: { kind: "harness", id: "scheduler", version: "0.1.0" }, level: "debug" } }, { op: "levels", settings: { defaultLevel: "debug" } }, { op: "write", event: "scheduler.run.started", attrs: { job: "k" }, fields: { source: { kind: "harness", id: "scheduler", version: "0.1.0" } } }, { op: "flush" }]);
  add("registered-secret-in-output-text", [{ op: "secret", value: secret }, { op: "secret", value: pinned, pinned: true },
    { op: "write", event: "process.output.line", attrs: { text: `a ${secret} b ${pinned} c`, untrusted: true }, fields: { stream: "stderr" } }, { op: "flush" }]);
  add("pii-only-when-asked", [{ op: "write", event: "process.output.line", attrs: { text: "mail a.b@example.test now", untrusted: true }, fields: { stream: "stdout" } }, { op: "flush" }]);
  add("pii-on", [{ op: "write", event: "process.output.line", attrs: { text: "mail a.b@example.test now", untrusted: true }, fields: { stream: "stdout" } }, { op: "flush" }], { redactPii: true });
  add("oversized-text-is-cut", [{ op: "write", event: "process.output.line", attrs: { untrusted: true, text: REPEAT("é", 5000) }, fields: { stream: "stderr", bypassRate: true } }, { op: "flush" }]);
  add("legacy-line-field-order", [{ op: "legacy", level: "warn", msg: "hello", fields: { zeta: 1, alpha: { b: 2, a: 1 }, level: "forged", at: "forged", role: "forged", msg: "forged" } }]);
  add("legacy-redacts-message-and-fields", [{ op: "secret", value: secret }, { op: "legacy", level: "error", msg: `leak ${secret}`, fields: { note: secret, nested: { list: [secret, "ok"] } } }]);
  add("legacy-too-long-is-summarised", [{ op: "legacy", level: "warn", msg: "big", fields: { blob: REPEAT("lorem ipsum dolor ", 350) } }]);
  add("legacy-below-level-is-dropped", [{ op: "legacy", level: "debug", msg: "hidden", fields: {} }, { op: "legacy", level: "info", msg: "shown", fields: {} }]);
  add("legacy-message-cut", [{ op: "legacy", level: "warn", msg: REPEAT("m", 3000), fields: {} }]);
  add("rate-limit-reports-drops", [{ op: "many", event: "core.process.started", key: "pid", count: 503 }, { op: "advance", ms: 1000 }, { op: "tick" }, { op: "flush" }], { summaryOnly: 3 });
  const results: any[] = [];
  for (const c of cases) {
    const root = mkdtempSync(join(tmpdir(), "p4-11-records-")); let now = T0;
    const w = createWriter({ dir: join(root, "logs"), role: "core", source: { kind: "harness", id: "core", version: "0.1.0" }, now: () => now, timers: false, ...(c.options?.redactPii ? { redactPii: true } : {}) } as any);
    const errors: (string | null)[] = [];
    try {
      withTrace(parseTraceparent(TRACEPARENT)!, () => {
        for (const op of c.ops) {
          let error: string | null = null;
          try {
            if (op.op === "write") w.write(op.event, expandRepeats(op.attrs), op.fields ?? {});
            else if (op.op === "many") for (let i = 0; i < op.count; i++) w.write(op.event, { [op.key]: i });
            else if (op.op === "legacy") w.writeLegacy(op.level, expandRepeats(op.msg), expandRepeats(op.fields));
            else if (op.op === "advance") now += op.ms;
            else if (op.op === "tick") w.tick();
            else if (op.op === "flush") w.flush();
            else if (op.op === "close") w.close();
            else if (op.op === "secret") w.registerSecret(op.value, op.pinned ? { pinned: true } : undefined);
            else if (op.op === "levels") { const { traceUntilIn, ...rest } = op.settings; w.updateLevels({ ...rest, ...(traceUntilIn !== undefined ? { traceUntil: now + traceUntilIn } : {}) }); }
          } catch (e) { error = (e as Error).message.replace(/^(invalid log record: \S+) .*$/s, "$1"); }
          errors.push(error);
        }
      });
      w.flush();
      const file = join(root, "logs", "core.log");
      const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
      const from = c.options?.summaryOnly ? lines.length - c.options.summaryOnly : 0;
      const kept = lines.slice(from);
      const canonical = kept.map(canonicalLine);
      const differs = kept.some((l, i) => l !== canonical[i]);
      results.push({ name: c.name, ...(c.options ? { options: c.options } : {}), ops: c.ops, errors, count: lines.length, lines: kept, canonical,
        ...(differs ? { note: "the TypeScript line orders attribute keys as the caller gave them; a serde_json::Map is sorted, so the Rust line has them sorted (`canonical`); both parse to the same value" } : {}) });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  const mustDiffer = ["attributes-in-caller-order", "legacy-line-field-order", "oversized-text-is-cut", "level-change-records", "rate-limit-reports-drops"];
  for (const n of mustDiffer) if (!results.find((r) => r.name === n)?.note) throw new Error(`records case ${n} should record an attribute-order difference`);
  return { cases: results, trace: TRACEPARENT };
}

// ---- query.json and methods.json: the log query (`query.ts`) and the `logs.*` handlers (`methods.ts`) (P4-11 task 3) ----
//
// `query.json`:
//   fingerprint   `fingerprint(filter, order)`
//   cursor        `mintCursor` and `decodeCursor` (the base64url reader is Node's lenient one)
//   scans         `runQuery` over generated files: a case is files (lists of segments), steps (query, append, rotate) and the
//                 recorded output of every step. `normalTs`, `quickTs`, the filters, the merge, the page boundary rules and
//                 the scan budget are private to `query.ts`; they are pinned through what `runQuery` returns.
// `methods.json`:
//   query         `logs.query` and `logs.tail` through `createLogsMethods` (the parameter checks `bound` and `filterOf` are
//                 private; their verdicts are the errors the handlers raise), with a fake clock and sleep
//   levels        `logs.levels` against a real writer with a fixed clock, and the audit events it appends
// File segments: a string (an `Enc`), `{ fill, bytes }`, or `{ gen }` (a stamped line generator, see `genLine`).
const QBASE = Date.UTC(2026, 9, 7, 9, 0, 0);
const qiso = (ms: number): string => new Date(QBASE + ms).toISOString();
const qrec = (ms: number, level: string, msg: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ ts: qiso(ms), level, source: { kind: "harness", id: "core", version: null }, event: "core.test", msg, ...extra }) + "\n";
const qlegacy = (ms: number, level: string, msg: string, role = "core"): string => JSON.stringify({ at: qiso(ms), level, role, msg }) + "\n";
const qmany = (n: number): string => Array.from({ length: n }, (_, i) => qrec(i * 10, i % 7 === 0 ? "error" : "info", `m${i}`)).join("");
const QPAD = "p".repeat(80);

type Gen = { count: number; stepMs: number; style: "prefix" | "late" | "legacy-num" | "legacy-str" | "rec" | "filler"; mix?: "garbage" | "array" | "nullepoch"; swap?: [number, number] };
type Seg = Enc | { fill: string; bytes: number } | { gen: Gen };
function genLine(i: number, g: Gen): string {
  const t = QBASE + i * g.stepMs;
  if (g.mix === "garbage" && i % 2) return `garbage line without json ${QPAD}\n`;
  if (g.mix === "array" && i % 2) return "[1,2,3] \n";
  if (g.mix === "nullepoch" && i % 3 === 1) return "null\n";
  if (g.mix === "nullepoch" && i % 3 === 2) return `{"at":99999999999999999,"level":"info","pad":"${QPAD}"}\n`;
  switch (g.style) {
    case "prefix": return `{"ts":"${new Date(t).toISOString()}","level":"info","msg":"n${i}","pad":"${QPAD}"}\n`;
    case "late": return `{"level":"info","msg":"n${i}","pad":"${QPAD}","ts":"${new Date(t).toISOString()}"}\n`;
    case "legacy-num": return `{"at":${t},"level":"info","msg":"n${i}","pad":"${QPAD}"}\n`;
    case "legacy-str": return `{ "at" : "${new Date(t).toISOString()}" , "level":"info","msg":"n${i}","pad":"${QPAD}"}\n`;
    case "rec": return qrec(i * g.stepMs, "info", `m${i}`);
    case "filler": return qrec(i * g.stepMs, "info", `filler ${i}`);
  }
}
function genText(g: Gen): string {
  const lines = Array.from({ length: g.count }, (_, i) => genLine(i, g));
  if (g.swap) { const [a, b] = g.swap; [lines[a], lines[b]] = [lines[b]!, lines[a]!]; }
  return lines.join("");
}
function segText(seg: Seg): string {
  if (typeof seg === "string" || "units" in seg || "parts" in seg) {
    if (typeof seg === "string") return seg;
    if ("units" in seg) return String.fromCharCode(...seg.units);
    return seg.parts.map((p) => (typeof p === "string" ? p : String.fromCharCode(...p.units))).join("");
  }
  if ("fill" in seg) return seg.fill.repeat(seg.bytes);
  return genText(seg.gen);
}
/** A file's content from plain text pieces: every piece through `enc`. */
const T = (...texts: string[]): Seg[] => texts.map((t) => enc(t));

type QStep =
  | { op: "query"; filter: any; order: Order; limit: number; cursor?: string; maxScanBytes?: number; maxLine?: number; project?: "msg" | "span"; repeat?: "until-done" }
  | { op: "append"; file: string; segs: Seg[] }
  | { op: "rotate"; file: string };
interface ScanCase { name: string; files: Record<string, Seg[]>; steps: QStep[]; missingDir?: boolean }

const DIAG = { stream: "diagnostic" };
const AUD = { stream: "audit" };
const qrotate = (dir: string, name: string, keep = 5): void => {
  for (let i = keep - 1; i >= 1; i--) { try { renameSync(join(dir, `${name}.${i}`), join(dir, `${name}.${i + 1}`)); } catch { /* none */ } }
  renameSync(join(dir, name), join(dir, `${name}.1`));
  writeFileSync(join(dir, name), "");
};
function projectOf(r: any, how: "msg" | "span" | undefined): any[] | object {
  if (how === "msg") return r.records.map((x: any) => String(x.record.msg));
  if (how === "span") return { count: r.records.length, first: r.records[0] ? String(r.records[0].record.msg) : null, last: r.records.length ? String(r.records[r.records.length - 1].record.msg) : null };
  return r.records;
}
/** A step as the fixture stores it: a search text that holds a canary is stored in fragments. */
const encStep = (s: QStep): QStep => (s.op === "query" && typeof s.filter?.text === "string" ? { ...s, filter: { ...s.filter, text: enc(s.filter.text) } } : s);
async function runScan(c: ScanCase): Promise<{ name: string; files: Record<string, Seg[]>; missingDir?: boolean; steps: QStep[]; outputs: any[] }> {
  const root = mkdtempSync(join(tmpdir(), "p4-11-query-"));
  try {
    const dir = join(root, "logs");
    mkdirSync(dir);
    for (const [name, segs] of Object.entries(c.files)) writeFileSync(join(dir, name), segs.map(segText).join(""));
    const target = c.missingDir ? join(dir, "nope") : dir;
    let prev: string | null = null;
    const steps: QStep[] = []; const outputs: any[] = [];
    const queryOnce = async (s: Extract<QStep, { op: "query" }>): Promise<any> => {
      const cursor = s.cursor === "prev" ? prev : s.cursor;
      try {
        const r = await runQuery({ dir: target, filter: s.filter, order: s.order, limit: s.limit, ...(cursor ? { cursor } : {}), ...(s.maxScanBytes !== undefined ? { maxScanBytes: s.maxScanBytes } : {}), ...(s.maxLine !== undefined ? { maxLine: s.maxLine } : {}) });
        prev = r.nextCursor;
        return { records: projectOf(r, s.project), nextCursor: r.nextCursor, corrupt: r.corrupt, scanned: r.scanned, truncated: r.truncated };
      } catch (e) {
        if (e instanceof CursorError) return { error: e.reason };
        throw e;
      }
    };
    for (const s of c.steps) {
      if (s.op === "query" && s.repeat === "until-done") {
        const { repeat, ...once } = s;
        for (let round = 0; round < 60; round++) {
          const out = await queryOnce({ ...once, ...(round > 0 ? { cursor: "prev" } : {}) });
          steps.push(encStep({ ...once, ...(round > 0 ? { cursor: "prev" } : {}) })); outputs.push(out);
          if (!out.nextCursor) break;
        }
        continue;
      }
      steps.push(encStep(s));
      if (s.op === "query") outputs.push(await queryOnce(s));
      else {
        if (s.op === "append") appendFileSync(join(dir, s.file), s.segs.map(segText).join(""));
        else qrotate(dir, s.file);
        outputs.push(null);
      }
    }
    return { name: c.name, files: c.files, ...(c.missingDir ? { missingDir: true } : {}), steps, outputs };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

const Q = (filter: any, order: Order = "asc", limit = 1000, more: Partial<Extract<QStep, { op: "query" }>> = {}): QStep => ({ op: "query", filter, order, limit, ...more });
/** Pages through a file: `n` queries, each with the cursor of the one before. */
const pages = (n: number, filter: any, order: Order, limit: number, project: "msg" | "span" = "msg"): QStep[] =>
  Array.from({ length: n }, (_, i) => Q(filter, order, limit, { project, ...(i > 0 ? { cursor: "prev" } : {}) }));

function scanCases(): ScanCase[] {
  const cases: ScanCase[] = [];
  const add = (name: string, files: Record<string, Seg[]>, steps: QStep[], more: Partial<ScanCase> = {}): void => { cases.push({ name, files, steps, ...more }); };
  const CANARY_Q = S("sk-", "Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2");
  const CANARY_RPC = S("sk-", "Q1w2E3r4T5y6U7i8O9p0A1s2");

  // ---- query.test.ts: reading ----
  add("merges-the-live-file-and-its-rotated-copies", {
    "core.log.2": T(qrec(0, "info", "a") + qrec(1000, "info", "b")), "core.log.1": T(qrec(2000, "info", "c") + qrec(3000, "info", "d")), "core.log": T(qrec(4000, "info", "e")),
  }, [Q(DIAG, "asc"), Q(DIAG, "desc")]);
  add("merges-components-by-time-and-reports-the-role", {
    "core.log": T(qrec(0, "info", "c0") + qrec(2000, "info", "c2")), "supervisor.log": T(qlegacy(1000, "warn", "s1", "supervisor") + qlegacy(3000, "info", "s3", "supervisor")),
  }, [Q(DIAG, "asc")]);
  add("unterminated-last-line-and-corrupt-lines", {
    "core.log": T(qrec(0, "info", "ok1") + "not json at all\n" + '{"ts":"2026-10-07T09:00:01.000Z","level":"loud","msg":"bad level"}\n' + '{"level":"info","msg":"no ts"}\n' + "[1,2]\n" + qrec(5000, "info", "ok2") + '{"ts":"2026-10-07T09:00:09.000Z","level":"info","msg":"half'),
  }, [Q(DIAG, "asc")]);
  add("a-line-over-the-cap-is-counted-once", {
    "core.log": [...T(qrec(0, "info", "a")), ...T(`{"ts":"${qiso(1000)}","level":"info","msg":"`), { fill: "x", bytes: 300_000 }, ...T('"}\n'), ...T(qrec(2000, "info", "b"))],
  }, [Q(DIAG, "asc", 1000, { project: "msg" }), Q(DIAG, "desc", 1000, { project: "msg" })]);
  add("payload-is-not-read-and-out-log-is-its-own-component", {
    "payload.log": T(qrec(0, "info", "payload")), "hermes.out.log": T(qrec(1000, "info", "child output")),
  }, [Q(DIAG, "asc")]);
  add("a-missing-directory-is-empty", {}, [Q(DIAG, "asc"), Q(DIAG, "desc"), Q(AUD, "asc")], { missingDir: true });
  add("the-audit-stream-is-served-from-audit-log-with-a-null-level", {
    "core.log": T(qrec(0, "info", "diag")),
    "audit.log": T(JSON.stringify({ at: qiso(1000), actor: { user: "u", host: "h" }, action: "rbac.denied", target: "jobs.run", detail: { reason: "role-denied" } }) + "\n"
      + JSON.stringify({ ts: qiso(2000), actor: { user: "u", host: "h" }, action: "config.set", target: "core.logLevel", detail: {} }) + "\n"),
  }, [Q(AUD, "asc"), Q({ ...AUD, component: "rbac" }, "asc"), Q(DIAG, "asc")]);

  // ---- query.test.ts: filters ----
  const filterFiles = (): Record<string, Seg[]> => ({
    "core.log": T(qrec(0, "debug", "boot", { source: { kind: "harness", id: "core", version: null } }) + qrec(1000, "info", "listening on socket")
      + qrec(2000, "warn", "slow recall", { source: { kind: "provider", id: "openai", version: "p@3" } }) + qrec(3000, "error", "provider failed: Timeout") + qrec(4000, "info", "done")),
    "supervisor.log": T(qlegacy(2500, "error", "child exited", "supervisor")),
  });
  add("filter-time-range-is-inclusive", filterFiles(), [Q({ ...DIAG, from: qiso(1000), to: qiso(3000) }), Q({ ...DIAG, from: qiso(4000) }), Q({ ...DIAG, to: qiso(0) })].map((s) => ({ ...s, project: "msg" }) as QStep));
  add("filter-min-level", filterFiles(), [Q({ ...DIAG, minLevel: "warn" }, "asc", 1000, { project: "msg" }), Q({ ...DIAG, minLevel: "error" }, "asc", 1000, { project: "msg" })]);
  add("filter-component", filterFiles(), ["supervisor", "openai", "provider", "core", "nobody"].map((component) => Q({ ...DIAG, component }, "asc", 1000, { project: "msg" })));
  add("filter-text-is-a-case-insensitive-substring", filterFiles(), [Q({ ...DIAG, text: "TIMEOUT" }, "asc", 1000, { project: "msg" }), Q({ ...DIAG, text: "openai" }, "asc", 1000, { project: "msg" })]);
  const TID = "4bf92f3577b34da6a3ce929d0e0e4736";
  add("filter-trace-id-is-an-exact-match", {
    "core.log": T(qrec(0, "info", "hit", { trace_id: TID }) + qrec(10, "info", "miss", { trace_id: "00f067aa0ba902b74bf92f3577b34da6" }) + qrec(20, "info", `mentions ${TID}`)),
  }, [Q({ ...DIAG, traceId: TID }, "asc", 1000, { project: "msg" })]);
  add("filters-combine", filterFiles(), [Q({ ...DIAG, from: qiso(1000), to: qiso(3500), minLevel: "warn", component: "core", text: "provider" }, "asc", 1000, { project: "msg" }),
    Q({ ...DIAG, from: qiso(1000), to: qiso(3500), minLevel: "warn", component: "supervisor", text: "provider" }, "asc", 1000, { project: "msg" })]);
  add("the-text-search-runs-on-the-redacted-record", {
    "core.log": T(qrec(0, "error", `provider said no to ${CANARY_Q}`, { attrs: { api_key: "plain-key-value-123", note: "n" } })),
  }, [Q({ ...DIAG, text: CANARY_Q }), Q({ ...DIAG, text: "plain-key-value-123" }), Q({ ...DIAG, text: "Zz9Yy8Xx7" }), Q(DIAG), Q({ ...DIAG, text: "REDACTED:key" })]);
  add("a-planted-secret-never-leaves", {
    "planted.log": T(qrec(0, "error", `failed with ${CANARY_RPC}`, { source: { kind: "harness", id: "planted", version: null }, attrs: { password: "hunter2" } })),
  }, [Q({ ...DIAG, component: "planted" }), Q({ ...DIAG, text: CANARY_RPC })]);

  // ---- query.test.ts: cursor and paging ----
  add("pages-in-both-directions-cover-every-record-once", { "core.log": T(qmany(57)) }, [...pages(6, DIAG, "asc", 10), ...pages(6, DIAG, "desc", 10)]);
  add("a-cursor-stays-valid-when-lines-are-appended", { "core.log": T(qmany(5)) }, [
    Q(DIAG, "asc", 3), { op: "append", file: "core.log", segs: T(qrec(1000, "info", "late1") + qrec(1010, "info", "late2")) }, Q(DIAG, "asc", 100, { cursor: "prev" }),
  ]);
  add("a-cursor-stays-valid-across-a-rotation", { "core.log": T(qmany(6)) }, [
    Q(DIAG, "asc", 4), { op: "rotate", file: "core.log" }, { op: "append", file: "core.log", segs: T(qrec(500, "info", "after-rotation-1") + qrec(510, "info", "after-rotation-2")) },
    { op: "rotate", file: "core.log" }, { op: "append", file: "core.log", segs: T(qrec(600, "info", "after-rotation-3")) }, Q(DIAG, "asc", 100, { cursor: "prev" }),
  ]);
  add("lines-with-one-timestamp-keep-a-total-order", { "core.log": T(Array.from({ length: 9 }, (_, i) => qrec(0, "info", `same-${i}`)).join("")) }, pages(5, DIAG, "asc", 2));
  const forged = (o: unknown): string => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
  add("a-cursor-with-other-filters-or-a-forged-cursor-is-refused", { "core.log": T(qmany(20)) }, [
    Q(DIAG, "asc", 5), Q({ ...DIAG, minLevel: "error" }, "asc", 1000, { cursor: "prev" }), Q(DIAG, "desc", 1000, { cursor: "prev" }),
    ...["x", "%%%", forged("{}"), forged({ v: 1, ts: "no", h: "h", fp: "f" })].map((cursor) => Q(DIAG, "asc", 1000, { cursor })),
  ]);

  // ---- logs-query.coverage.test.ts: timestamps ----
  const stamp = (name: string, value: unknown, key: "ts" | "at" = "ts"): string => JSON.stringify({ [key]: value, level: "info", msg: name }) + "\n";
  const tsValues: Array<[string, unknown]> = [
    ["iso-ms", "2026-10-07T09:00:00.123Z"], ["iso-seconds", "2026-10-07T09:00:00Z"], ["iso-minutes", "2026-10-07T09:00Z"], ["zoneless-minutes", "2026-10-07T09:00"], ["zoneless-space-minutes", "2026-10-07 09:00"],
    ["zoneless-space-seconds", "2026-10-07 09:00:01"], ["zoneless-space-fraction", "2026-10-07 09:00:01.5"], ["zoneless-seconds", "2026-10-07T09:00:01"], ["zoneless-fraction", "2026-10-07T09:00:01.25"],
    ["date-only", "2026-10-07"], ["year-month", "2026-10"], ["year", "2026"], ["four-fraction-digits", "2026-10-07T09:00:00.1234Z"], ["one-fraction-digit", "2026-10-07T09:00:00.1Z"],
    ["many-fraction-digits", "2026-10-07T09:00:00.12345678901234567890Z"], ["sub-millisecond", "2026-10-07T09:00:00.0005Z"], ["offset-plus", "2026-10-07T09:00:00+02:00"], ["offset-plus-compact", "2026-10-07T09:00:00+0200"],
    ["offset-half-hour", "2026-10-07T09:00:00+02:30"], ["offset-minus-zero", "2026-10-07T09:00:00-00:00"], ["offset-minus-compact-zero", "2026-10-07T09:00:00-0000"], ["offset-widest", "2026-10-07T09:00:00.000-23:59"],
    ["offset-over-a-day", "2026-10-07T09:00:00.000+24:00"], ["offset-bad-minutes", "2026-10-07T09:00:00.000+23:60"], ["offset-one-digit-hour", "2026-10-07T09:00:00+2:00"], ["offset-hours-only", "2026-10-07T09:00:00+02"],
    ["hour-24", "2026-10-07T24:00:00Z"], ["hour-24-minutes", "2026-10-07T24:00Z"], ["hour-24-ms-zero", "2026-10-07T24:00:00.000Z"], ["hour-24-ms", "2026-10-07T24:00:00.001Z"], ["hour-24-second", "2026-10-07T24:00:01Z"],
    ["hour-24-zoneless", "2026-10-07 24:00"], ["hour-25", "2026-10-07T25:00:00Z"], ["minute-60", "2026-10-07T09:60:00Z"], ["second-60", "2026-10-07T09:00:60Z"],
    ["feb-30-rolls-over", "2026-02-30T00:00:00Z"], ["feb-29-in-a-common-year", "2026-02-29"], ["feb-29-in-a-leap-year", "2024-02-29"], ["apr-31-rolls-over", "2026-04-31"], ["feb-31-rolls-over", "2026-02-31T00:00:00Z"],
    ["month-13", "2026-13-01T00:00:00Z"], ["month-0", "2026-00-10"], ["day-0", "2026-10-00"], ["day-32", "2026-10-32"], ["day-32-february", "2026-02-32"],
    ["expanded-year-plus", "+002026-10-07T09:00:00Z"], ["expanded-year-minus", "-000001-01-01T00:00:00Z"], ["expanded-year-minus-zero", "-000000-01-01T00:00:00Z"], ["expanded-year-month", "+002026-10"], ["expanded-year-only", "+002026"],
    ["expanded-year-negative-date", "-002026-10-07"], ["max-date", "+275760-09-13T00:00:00.000Z"], ["past-max-date", "+275760-09-13T00:00:00.001Z"], ["past-max-day", "+275760-09-14"], ["min-date", "-271821-04-20T00:00:00Z"],
    ["year-0", "0000-01-01T00:00:00Z"], ["year-1", "0001-01-01"], ["year-9999", "9999-12-31T23:59:59.999Z"], ["year-10000", "+010000-01-01T00:00:00Z"], ["year-10000-short", "+10000-01-01T00:00:00Z"],
    ["lower-case-t-and-z", "2026-10-07t09:00:00z"], ["lower-case-z", "2026-10-07T09:00:00z"], ["space-then-z", "2026-10-07 09:00:00Z"], ["space-with-offset", "2026-10-07 09:00:00+02:00"],
    ["one-digit-hour", "2026-10-07T9:00:00Z"], ["comma-fraction", "2026-10-07T09:00:00,5Z"], ["dot-without-digits", "2026-10-07T09:00:00.Z"], ["trailing-dot", "2026-10-07T09:00:00."], ["hour-only", "2026-10-07T09"], ["t-only", "2026-10-07T"],
    ["space-before-z", "2026-10-07T09:00:00 Z"], ["trailing-space", "2026-10-07T09:00:00Z "], ["trailing-newline", "2026-10-07T09:00:00Z\n"], ["double-z", "2026-10-07T09:00:00ZZ"], ["z-then-offset", "2026-10-07T09:00:00Z+01:00"],
    ["offset-then-z", "2026-10-07T09:00:00+02:00Z"], ["week-date", "2026-W41"], ["compact-date", "20261007T090000Z"], ["no-dash-day", "2026-1007"], ["time-only", "T09:00"], ["exponent-text", "1e3"], ["nan-text", "NaN"], ["empty-text", ""], ["words", "not a date"],
    ["epoch-zero-number", 0], ["number-with-fraction", 1.9], ["negative-number-with-fraction", -1.9], ["half", 0.5], ["negative-half", -0.5], ["epoch-ms-with-decimals", 1791374400000.7], ["max-number", 8.64e15], ["past-max-number", 8.64e15 + 1], ["min-number", -8.64e15],
    ["year-33658-number", 1e15], ["year-minus-29719-number", -1e15], ["year-10000-number", 253402300800000], ["last-ms-of-9999", 253402300799999], ["huge-number", 1e17], ["huge-negative-number", -1e17],
    ["boolean-true", true], ["object", {}], ["array", [1]], ["null-without-at", null],
  ];
  add("timestamps-ts-field", { "core.log": tsValues.map(([name, v]) => enc(stamp(name, v))) }, [Q(DIAG, "asc", 1000, { project: "msg" }), Q(DIAG, "asc", 1000)]);
  add("timestamps-at-field", { "core.log": tsValues.map(([name, v]) => enc(stamp(name, v, "at"))) }, [Q(DIAG, "asc", 1000)]);
  add("ts-wins-over-at-and-null-ts-falls-back", {
    "core.log": T(JSON.stringify({ ts: qiso(1), at: qiso(99), level: "info", msg: "both" }) + "\n" + JSON.stringify({ ts: null, at: qiso(2), level: "info", msg: "null-ts" }) + "\n" + JSON.stringify({ ts: "garbage", at: qiso(3), level: "info", msg: "bad-ts" }) + "\n"),
  }, [Q(DIAG, "asc")]);
  add("legacy-at-as-epoch-milliseconds-and-text", { "core.log": T(JSON.stringify({ at: QBASE + 5, level: "info", msg: "num" }) + "\n" + JSON.stringify({ at: qiso(10), level: "info", msg: "str" }) + "\n") }, [Q(DIAG, "asc")]);
  add("json-arrays-and-primitives-are-corrupt", { "core.log": T('[1,2]\n42\n"str"\nnull\ntrue\n' + qrec(0, "info", "ok")) }, [Q(DIAG, "asc")]);
  add("blank-cr-and-crlf-lines-are-skipped", { "core.log": T("\n\r\n" + qrec(0, "info", "ok").replace("\n", "\r\n")) }, [Q(DIAG, "asc")]);
  add("a-level-of-the-wrong-type", {
    "core.log": T(JSON.stringify({ ts: qiso(0), level: 5, msg: "x" }) + "\n" + JSON.stringify({ ts: qiso(1), msg: "nolevel" }) + "\n"),
    "audit.log": T(JSON.stringify({ ts: qiso(0), level: 5, action: "a.b" }) + "\n" + JSON.stringify({ ts: qiso(1), action: "a.c" }) + "\n"),
  }, [Q(DIAG, "asc"), Q(AUD, "asc")]);

  // ---- logs-query.coverage.test.ts: filters ----
  const levelFile = { "core.log": T(qrec(0, "trace", "t") + qrec(1, "debug", "d") + qrec(2, "info", "i") + qrec(3, "warn", "w") + qrec(4, "error", "e") + qrec(5, "fatal", "f")) };
  add("min-level-at-every-level", levelFile, ["trace", "debug", "info", "warn", "error", "fatal"].map((minLevel) => Q({ ...DIAG, minLevel }, "asc", 1000, { project: "msg" })));
  add("from-and-to-exclude-outside-and-include-the-bound", levelFile, (["asc", "desc"] as const).map((order) => Q({ ...DIAG, from: qiso(2), to: qiso(4) }, order, 1000, { project: "msg" })));
  add("from-after-the-last-line-and-to-before-the-first", levelFile, [
    Q({ ...DIAG, from: qiso(1000) }), Q({ ...DIAG, to: qiso(-1000) }), Q({ ...DIAG, to: qiso(-1000) }, "desc"), Q({ ...DIAG, from: qiso(1000) }, "desc"),
  ]);
  add("component-by-action-segment-role-and-source", {
    "audit.log": T(JSON.stringify({ ts: qiso(0), action: "rbac.denied", msg: "a" }) + "\n" + JSON.stringify({ ts: qiso(1), action: 7, msg: "b" }) + "\n" + JSON.stringify({ ts: qiso(2), msg: "c" }) + "\n"),
    "legacy.log": T(JSON.stringify({ at: qiso(0), level: "info", role: "worker", msg: "r" }) + "\n" + JSON.stringify({ at: qiso(1), level: "info", source: null, msg: "nosrc" }) + "\n"),
  }, [Q({ ...AUD, component: "rbac" }, "asc", 1000, { project: "msg" }), Q({ ...AUD, component: "audit" }, "asc", 1000, { project: "msg" }), Q({ ...AUD, component: "denied" }, "asc", 1000, { project: "msg" }),
    Q({ ...DIAG, component: "worker" }, "asc", 1000, { project: "msg" }), Q({ ...DIAG, component: "legacy" }, "asc", 1000, { project: "msg" })]);
  add("component-with-a-source-that-is-not-an-object", {
    "core.log": T(JSON.stringify({ ts: qiso(0), level: "info", source: "plain", msg: "s" }) + "\n" + JSON.stringify({ ts: qiso(1), level: "info", source: {}, msg: "o" }) + "\n"),
  }, [Q({ ...DIAG, component: "nothing" }, "asc", 1000, { project: "msg" }), Q({ ...DIAG, component: "core" }, "asc", 1000, { project: "msg" })]);
  add("component-is-exact-and-case-sensitive", levelFile, [Q({ ...DIAG, component: "cor" }), Q({ ...DIAG, component: "Core" })]);
  add("an-empty-needle-matches-all-and-a-key-name-matches", levelFile, [Q({ ...DIAG, text: "" }, "asc", 1000, { project: "msg" }), Q({ ...DIAG, text: "source" }, "asc", 1000, { project: "msg" }), Q({ ...DIAG, text: "does-not-occur" }, "asc", 1000, { project: "msg" })]);
  add("limit-zero-and-limit-above-the-data", levelFile, [Q(DIAG, "asc", 0), Q(DIAG, "asc", 1_000_000, { project: "msg" })]);
  add("scanned-counts-files-and-bytes", { ...levelFile, "other.log": T(qrec(0, "info", "o")) }, [Q(DIAG, "asc")]);
  add("an-empty-directory-and-an-empty-file", { "core.log": [] }, [Q(DIAG, "asc"), Q(DIAG, "desc")]);
  add("max-line-marks-longer-lines-corrupt", { "core.log": T(qrec(0, "info", "a") + qrec(1, "info", "x".repeat(500)) + qrec(2, "info", "b")) }, (["asc", "desc"] as const).map((order) => Q(DIAG, order, 1000, { maxLine: 300, project: "msg" })));
  add("lines-with-one-timestamp-come-out-in-hash-order", { "core.log": T(Array.from({ length: 12 }, (_, i) => qrec(0, "info", `same-${i}`)).join("")) }, [Q(DIAG, "asc", 1000, { project: "msg" }), Q(DIAG, "desc", 1000, { project: "msg" })]);
  add("groups-of-equal-timestamps-between-other-times", { "core.log": T(qrec(0, "info", "a1") + qrec(0, "info", "a2") + qrec(5, "info", "b") + qrec(10, "info", "c1") + qrec(10, "info", "c2")) }, [Q(DIAG, "asc", 1000, { project: "msg" })]);
  add("identical-lines-at-a-page-boundary-stay-together", { "core.log": T(qrec(0, "info", "first") + qrec(10, "info", "dup").repeat(5) + qrec(20, "info", "last")) }, [Q(DIAG, "asc", 3, { project: "msg" }), Q(DIAG, "asc", 3, { cursor: "prev", project: "msg" })]);
  add("at-most-100-extra-identical-lines-are-held-back", { "core.log": T(qrec(10, "info", "dup").repeat(150)) }, [Q(DIAG, "asc", 2, { project: "msg" })]);
  add("a-non-identical-line-at-the-boundary-is-not-pulled-in", { "core.log": T(qrec(10, "info", "a") + qrec(10, "info", "b") + qrec(10, "info", "c")) }, [Q(DIAG, "asc", 1, { project: "msg" })]);
  const tenTimes = { "core.log": T(Array.from({ length: 20 }, (_, i) => qrec(i * 10, "info", `m${i}`)).join("")) };
  add("asc-cursor-with-from-continues-after-the-later-of-the-two", tenTimes, [Q({ ...DIAG, from: qiso(30) }, "asc", 3, { project: "msg" }), Q({ ...DIAG, from: qiso(30) }, "asc", 3, { cursor: "prev", project: "msg" })]);
  add("desc-cursor-with-to-continues-before-the-earlier-of-the-two", tenTimes, [Q({ ...DIAG, to: qiso(150) }, "desc", 3, { project: "msg" }), Q({ ...DIAG, to: qiso(150) }, "desc", 3, { cursor: "prev", project: "msg" })]);
  add("a-cursor-is-refused-for-each-other-filter-field", { "core.log": T(qmany(10)) }, [
    Q(DIAG, "asc", 2), ...[{ ...DIAG, from: qiso(0) }, { ...DIAG, to: qiso(1000) }, { ...DIAG, minLevel: "info" }, { ...DIAG, component: "core" }, { ...DIAG, text: "m" }, { ...DIAG, traceId: TID }, AUD].map((f) => Q(f, "asc", 1000, { cursor: "prev" })),
  ]);
  add("a-cursor-at-the-very-end", { "core.log": T(qmany(3)) }, [Q(DIAG, "asc", 2, { project: "msg" }), Q(DIAG, "asc", 2, { cursor: "prev", project: "msg" })]);

  // ---- the scan budget ----
  add("the-budget-stops-a-scan-and-the-cursor-continues", { "core.log": [{ gen: { count: 6000, stepMs: 1, style: "rec" } }] }, [
    Q(DIAG, "asc", 1000, { maxScanBytes: 130_000, project: "span" }), Q(DIAG, "asc", 1000, { maxScanBytes: 1_000_000, cursor: "prev", project: "span" }),
  ]);
  add("a-budget-smaller-than-the-first-read", { "core.log": T(qrec(0, "info", "a") + qrec(1, "info", "b")) }, [Q(DIAG, "asc", 1000, { maxScanBytes: 1 }), Q(DIAG, "desc", 1000, { maxScanBytes: 1 })]);
  add("a-budget-of-zero-is-a-real-budget", { "core.log": T(qrec(0, "info", "a")) }, [Q(DIAG, "asc", 10, { maxScanBytes: 0 })]);
  add("a-full-scan-that-finds-nothing-hands-back-a-cursor", { "core.log": [{ gen: { count: 3000, stepMs: 1, style: "filler" } }, ...T(qrec(9999, "info", "needle"))] }, [
    Q({ ...DIAG, text: "needle" }, "asc", 100, { maxScanBytes: 100_000, project: "msg", repeat: "until-done" }),
  ]);
  add("budget-spent-on-corrupt-lines-ends-the-call", { "core.log": [...T("garbage\n".repeat(30)), ...T(qrec(0, "info", "after"))] }, [
    Q(DIAG, "asc", 10, { maxScanBytes: 100, project: "msg" }), Q(DIAG, "desc", 10, { maxScanBytes: 100, project: "msg" }),
  ]);

  // ---- large files: the seek paths ----
  const N = 4000;
  const at = (i: number): string => qiso(i * 10);
  for (const style of ["prefix", "late", "legacy-num", "legacy-str"] as const) {
    add(`seeks-by-timestamp-written-as-${style}`, { "core.log": [{ gen: { count: N, stepMs: 10, style } }] }, [
      Q(DIAG, "asc", 100_000, { project: "span" }), Q({ ...DIAG, from: at(3000) }, "asc", 5, { project: "msg" }), Q({ ...DIAG, to: at(1000) }, "desc", 3, { project: "msg" }),
    ]);
  }
  add("a-corrupt-probe-line-falls-back-to-a-full-scan", { "core.log": [{ gen: { count: N, stepMs: 10, style: "prefix", mix: "garbage" } }] }, [Q({ ...DIAG, from: at(3000) }, "asc", 3, { project: "msg" })]);
  add("probe-lines-that-are-json-but-not-objects", { "core.log": [{ gen: { count: N, stepMs: 10, style: "prefix", mix: "array" } }] }, [Q({ ...DIAG, from: at(3500) }, "asc", 2, { project: "msg" })]);
  add("probe-lines-that-are-null-or-an-invalid-epoch", { "core.log": [{ gen: { count: N, stepMs: 10, style: "prefix", mix: "nullepoch" } }] }, [Q({ ...DIAG, from: at(3000) }, "asc", 2, { project: "msg" })]);
  const big = { "core.log": [{ gen: { count: N, stepMs: 10, style: "prefix" } } as Seg] };
  add("from-and-to-together-on-a-large-file", big, [Q({ ...DIAG, from: at(2000), to: at(2002) }, "asc", 1000, { project: "msg" }), Q({ ...DIAG, from: at(2000), to: at(2002) }, "desc", 1000, { project: "msg" })]);
  add("a-cursor-on-a-large-file-continues-after-it", big, [
    Q(DIAG, "asc", 3, { project: "msg" }), Q(DIAG, "asc", 3, { cursor: "prev", project: "msg" }), Q(DIAG, "desc", 3, { project: "msg" }), Q(DIAG, "desc", 3, { cursor: "prev", project: "msg" }),
  ]);
  add("a-stale-cursor-from-the-far-past", big, [Q(DIAG, "asc", 100, { cursor: mintCursor(DIAG as LogFilter, "asc", { ts: new Date(QBASE + 3990 * 10 + 5).toISOString(), h: "0000000000000000" }), project: "msg" })]);
  add("a-line-out-of-order-inside-the-seek-window", { "core.log": [{ gen: { count: N, stepMs: 10, style: "prefix", swap: [2000, 2001] } }] }, [Q({ ...DIAG, from: at(2000) }, "asc", 2, { project: "msg" })]);

  // ---- multiple files and streams ----
  add("rotated-generations-of-several-components", {
    "core.log.2": T(qrec(0, "info", "c0") + qrec(30, "info", "c3")), "core.log.1": T(qrec(40, "info", "c4")), "core.log": T(qrec(60, "info", "c6")), "web.log": T(qrec(10, "info", "w1") + qrec(50, "info", "w5")),
  }, [Q(DIAG, "asc", 1000, { project: "msg" }), Q(DIAG, "desc", 1000, { project: "msg" })]);
  add("the-audit-stream-reads-only-audit-files-including-rotated-ones", {
    "audit.log.1": T(JSON.stringify({ ts: qiso(0), action: "a.b" }) + "\n"), "audit.log": T(JSON.stringify({ ts: qiso(5), action: "a.c" }) + "\n"), "core.log": T(qrec(1, "info", "d")),
  }, [Q(AUD, "asc")]);
  add("payload-log-is-never-read", { "payload.log": T(qrec(0, "info", "secret payload")), "core.log": T(qrec(1, "info", "ok")) }, [Q(DIAG, "asc", 1000, { project: "msg" }), Q(AUD, "asc")]);
  return cases;
}

function cursorVectors() {
  const fl = (o: any): any => ({ stream: "diagnostic", ...o });
  const filters: Array<[string, any, Order]> = [
    ["diagnostic-asc", fl({}), "asc"], ["diagnostic-desc", fl({}), "desc"], ["audit-asc", { stream: "audit" }, "asc"], ["from", fl({ from: qiso(0) }), "asc"], ["to", fl({ to: qiso(0) }), "asc"],
    ["min-level", fl({ minLevel: "warn" }), "asc"], ["component", fl({ component: "core" }), "asc"], ["text", fl({ text: "x" }), "asc"], ["trace-id", fl({ traceId: "4bf92f3577b34da6a3ce929d0e0e4736" }), "asc"],
    ["everything", fl({ from: qiso(0), to: qiso(1000), minLevel: "error", component: "core", text: "needle", traceId: "4bf92f3577b34da6a3ce929d0e0e4736" }), "desc"],
    ["text-with-quotes-and-controls", fl({ text: 'a"b\\c\nd\te\u0001f\u007f' }), "asc"], ["text-with-unicode", fl({ text: "é日本😀 " }), "asc"], ["empty-text", fl({ text: "" }), "asc"], ["empty-component", fl({ component: "" }), "asc"],
  ];
  const fingerprints = filters.map(([name, filter, order]) => ({ name, filter, order, output: fingerprint(filter, order) }));
  const keys: Array<[string, { ts: string; h: string }]> = [
    ["plain", { ts: "2026-10-07T09:00:00.000Z", h: "abcdef0123456789" }], ["empty-hash", { ts: "2026-10-07T09:00:00.000Z", h: "" }], ["unicode-hash", { ts: "2026-10-07T09:00:00.000Z", h: "é😀\"\\" }],
    ["extended-year", { ts: "+033658-09-27T01:46:40.000Z", h: "0123456789abcdef" }], ["short-year", { ts: "0001-01-01T00:00:00.000Z", h: "0123456789abcdef" }],
  ];
  const mint = keys.map(([name, key]) => ({ name, filter: fl({}), order: "asc" as Order, key, output: mintCursor(fl({}), "asc", key) }));
  const fp = fl({}); const key = { ts: "2026-10-07T09:00:00.000Z", h: "abcdef0123456789" };
  const fpText = fingerprint(fp, "asc");
  const enc64 = (o: unknown): string => Buffer.from(typeof o === "string" ? o : JSON.stringify(o), "utf8").toString("base64url");
  const doc = (extra: object = {}): any => ({ v: 1, ts: key.ts, h: key.h, fp: fpText, ...extra });
  const raw = (text: string): string => Buffer.from(text, "utf8").toString("base64url");
  const std = Buffer.from(JSON.stringify(doc()), "utf8").toString("base64");
  const decodeInputs: Array<[string, string, string?]> = [
    ["round-trip", mintCursor(fp, "asc", key)],
    ["empty", ""], ["not-base64-or-json", "!!!"], ["json-null", enc64("null")], ["json-number", enc64("5")], ["json-string", enc64('"x"')], ["json-array", enc64("[]")], ["json-garbage", enc64("{not json")], ["empty-object", enc64({})],
    ["wrong-version", enc64({ ...doc(), v: 2 })], ["version-as-string", enc64({ ...doc(), v: "1" })], ["version-as-float-one", raw(`{"v":1.0,"ts":"${key.ts}","h":"${key.h}","fp":"${fpText}"}`)], ["version-as-exponent-one", raw(`{"v":1e0,"ts":"${key.ts}","h":"${key.h}","fp":"${fpText}"}`)],
    ["version-true", enc64({ ...doc(), v: true })], ["ts-missing", enc64({ v: 1, h: "h", fp: fpText })], ["ts-not-a-string", enc64({ ...doc(), ts: 5 })], ["ts-without-millis", enc64({ ...doc(), ts: "2026-10-07T09:00:00Z" })],
    ["ts-with-offset", enc64({ ...doc(), ts: "2026-10-07T09:00:00.000+00:00" })], ["ts-with-trailing-newline", enc64({ ...doc(), ts: "2026-10-07T09:00:00.000Z\n" })], ["ts-extended-year", enc64({ ...doc(), ts: "+033658-09-27T01:46:40.000Z" })],
    ["ts-with-a-letter-for-a-digit", enc64({ ...doc(), ts: "2026-1a-07T09:00:00.000Z" })], ["ts-lower-case-z", enc64({ ...doc(), ts: "2026-10-07T09:00:00.000z" })], ["ts-arabic-indic-digits", enc64({ ...doc(), ts: "٢٠٢٦-10-07T09:00:00.000Z" })],
    ["h-not-a-string", enc64({ ...doc(), h: 7 })], ["h-missing", enc64({ v: 1, ts: key.ts, fp: fpText })], ["fp-not-a-string", enc64({ ...doc(), fp: 1 })], ["fp-missing", enc64({ v: 1, ts: key.ts, h: "h" })],
    ["foreign-fingerprint", mintCursor(fl({}), "desc", key)], ["an-empty-hash-and-extra-fields", enc64({ ...doc({ extra: true }), h: "" })], ["a-hash-with-unicode", enc64({ ...doc(), h: "é😀" })],
    ["key-order-does-not-matter", raw(`{"fp":"${fpText}","h":"${key.h}","ts":"${key.ts}","v":1}`)], ["duplicate-members-last-wins", raw(`{"v":2,"v":1,"ts":"${key.ts}","h":"${key.h}","fp":"${fpText}"}`)],
    ["standard-alphabet-with-padding", std], ["padding-stripped", std.replace(/=+$/, "")], ["whitespace-inside", mintCursor(fp, "asc", key).replace(/^(.{8})/, "$1 \n\t")], ["junk-characters-inside", mintCursor(fp, "asc", key).replace(/^(.{8})/, "$1%!*")],
    ["equals-ends-the-input", mintCursor(fp, "asc", key) + "=garbage"], ["equals-in-the-middle", mintCursor(fp, "asc", key).replace(/^(.{8})/, "$1=")], ["trailing-junk-after-valid-json", raw(JSON.stringify(doc()) + "x")], ["trailing-whitespace-json", raw(JSON.stringify(doc()) + " \n")],
    ["leading-whitespace-json", raw(" \n" + JSON.stringify(doc()))], ["byte-order-mark-json", raw("﻿" + JSON.stringify(doc()))], ["non-ascii-characters-are-skipped", mintCursor(fp, "asc", key).replace(/^(.{8})/, "$1é日")],
    ["url-alphabet-characters-from-the-standard-set", Buffer.from(JSON.stringify(doc({ pad: "???>>>" })), "utf8").toString("base64")],
    ["single-character", "x"], ["one-valid-group", "e30"], ["percent-signs", "%%%"],
  ];
  const decode = decodeInputs.map(([name, cursor]) => {
    let output: any;
    try { output = { key: decodeCursor(cursor, fpText) }; } catch (e) { if (e instanceof CursorError) output = { error: e.reason }; else throw e; }
    return { name, cursor, filter: fp, order: "asc" as Order, output };
  });
  return { fingerprint: fingerprints, mint, decode };
}

async function buildQuery() {
  const scans = [];
  for (const c of scanCases()) scans.push(await runScan(c));
  const names = new Set<string>();
  for (const s of scans) { if (names.has(s.name)) throw new Error(`duplicate scan case ${s.name}`); names.add(s.name); }
  return { ...cursorVectors(), scans };
}

// ---- methods.json ----
interface MCall { method: string; params: any; cursorFromCall?: number; appendBefore?: { file: string; segs: Seg[] }; rotateBefore?: string; abortConnectionOnSleep?: number; abortCoreOnSleep?: number; appendOnSleep?: { n: number; file: string; segs: Seg[] }; connectionAborted?: boolean }
interface MCase { name: string; files: Record<string, Seg[]>; pollMs?: number; maxScanBytes?: number; start?: number; missingDir?: boolean; calls: MCall[] }
const errOf = (e: any): any => (e instanceof RpcError ? { error: e.error, ...(e.reason ? { reason: e.reason } : {}), message: e.message } : { internal: String(e) });

async function runMethodCase(c: MCase) {
  const root = mkdtempSync(join(tmpdir(), "p4-11-methods-"));
  try {
    const dir = join(root, "logs"); mkdirSync(dir);
    for (const [name, segs] of Object.entries(c.files)) writeFileSync(join(dir, name), segs.map(segText).join(""));
    let t = c.start ?? 1_000_000; let sleeps: number[] = []; let current: MCall | null = null;
    const conn = { ctl: new AbortController() }; const core = new AbortController();
    const h = createLogsMethods({
      dir: c.missingDir ? join(dir, "nope") : dir, signal: core.signal, now: () => t, ...(c.pollMs !== undefined ? { pollMs: c.pollMs } : {}), ...(c.maxScanBytes !== undefined ? { maxScanBytes: c.maxScanBytes } : {}),
      sleep: async (ms: number) => {
        t += ms; sleeps.push(ms);
        if (current?.appendOnSleep?.n === sleeps.length) appendFileSync(join(dir, current.appendOnSleep.file), current.appendOnSleep.segs.map(segText).join(""));
        if (current?.abortConnectionOnSleep === sleeps.length) conn.ctl.abort();
        if (current?.abortCoreOnSleep === sleeps.length) core.abort();
      },
    });
    const outputs: any[] = [];
    for (const call of c.calls) {
      current = call; sleeps = [];
      if (call.appendBefore && call.rotateBefore) throw new Error("one setup step per call");
      if (call.rotateBefore) qrotate(dir, call.rotateBefore);
      if (call.appendBefore) appendFileSync(join(dir, call.appendBefore.file), call.appendBefore.segs.map(segText).join(""));
      const params = { ...call.params };
      if (call.cursorFromCall !== undefined) params.cursor = outputs[call.cursorFromCall].ok.nextCursor;
      conn.ctl = new AbortController();
      const signal = call.connectionAborted ? (() => { const a = new AbortController(); a.abort(); return a.signal; })() : conn.ctl.signal;
      try { outputs.push({ ok: await h[call.method]!(params, { requestId: "r", connectionId: "c", signal }), sleeps: [...sleeps] }); }
      catch (e) { outputs.push({ ...errOf(e), sleeps: [...sleeps] }); }
    }
    return { ...c, outputs };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function methodCases(): MCase[] {
  const cases: MCase[] = [];
  const add = (c: MCase): void => { cases.push(c); };
  const ab = { "core.log": T(qrec(0, "info", "a") + qrec(1, "info", "b")) };
  const Qm = (params: any, more: Partial<MCall> = {}): MCall => ({ method: "logs.query", params, ...more });
  const Tm = (params: any, more: Partial<MCall> = {}): MCall => ({ method: "logs.tail", params, ...more });

  // logs.query: defaults and the documented shape
  add({ name: "query-defaults-newest-100-first", files: { "core.log": [{ gen: { count: 150, stepMs: 1, style: "rec" } }] }, calls: [Qm({})] });
  // logs.query / logs.tail: bounds
  const bad: Array<[string, unknown]> = [
    ["plain-word", "yesterday"], ["date-only", "2026-10-07"], ["without-z", "2026-10-07T09:00:00"], ["with-offset", "2026-10-07T09:00:00+02:00"], ["four-fraction-digits", "2026-10-07T09:00:00.1234Z"],
    ["lower-case-z", "2026-10-07T09:00:00z"], ["lower-case-t", "2026-10-07t09:00:00Z"], ["month-13", "2026-13-01T00:00:00Z"], ["month-13-day-45", "2026-13-45T00:00:00Z"], ["empty-string", ""], ["number", 1_700_000_000_000], ["null", null], ["object", {}],
    ["boolean", true], ["array", ["2026-10-07T09:00:00Z"]], ["leading-space", " 2026-10-07T09:00:00Z"], ["trailing-newline", "2026-10-07T09:00:00Z\n"], ["space-instead-of-t", "2026-10-07 09:00:00Z"], ["fraction-without-digits", "2026-10-07T09:00:00.Z"],
    ["feb-30-rolls-over", "2026-02-30T00:00:00Z"], ["apr-31-rolls-over", "2026-04-31T00:00:00Z"], ["hour-24-rolls-over", "2026-10-07T24:00:00Z"], ["hour-25", "2026-10-07T25:00:00Z"], ["minute-60", "2026-10-07T09:60:00Z"], ["second-60", "2026-10-07T09:00:60Z"],
    ["day-32", "2026-10-32T00:00:00Z"], ["month-0", "2026-00-10T00:00:00Z"], ["day-0", "2026-10-00T00:00:00Z"], ["arabic-indic-digits", "٢٠٢٦-10-07T09:00:00Z"], ["feb-29-common-year", "2026-02-29T00:00:00Z"], ["year-9999-hour-24", "9999-12-31T24:00:00Z"],
  ];
  for (const [label, v] of bad) add({ name: `bound-${label}`, files: ab, calls: [Qm({ from: v }), Qm({ to: v }), Tm({ from: v })] });
  const good: Array<[string, string]> = [["milliseconds", "2026-10-07T09:00:00.123Z"], ["seconds", "2026-10-07T09:00:00Z"], ["one-fraction-digit", "2026-10-07T09:00:00.1Z"], ["two-fraction-digits", "2026-10-07T09:00:00.10Z"], ["leap-day", "2024-02-29T12:00:00Z"], ["year-0", "0000-01-01T00:00:00Z"], ["year-9999", "9999-12-31T23:59:59.999Z"], ["epoch", "1970-01-01T00:00:00Z"]];
  for (const [label, v] of good) add({ name: `bound-accepts-${label}`, files: ab, calls: [Qm({ from: v }), Qm({ to: v, order: "asc" })] });
  add({ name: "from-only-and-to-only", files: { "core.log": T(qrec(0, "info", "a") + qrec(1000, "info", "b") + qrec(2000, "info", "c")) }, calls: [Qm({ order: "asc", from: qiso(1000) }), Qm({ order: "asc", to: qiso(1000) }), Qm({ from: qiso(1000), to: qiso(1000) })] });
  add({ name: "second-precision-bounds-and-ms-normalising", files: { "core.log": T(qrec(500, "info", "in") + qrec(2500, "info", "out")) }, calls: [Qm({ from: "2026-10-07T09:00:00Z", to: "2026-10-07T09:00:01Z" }), Qm({ order: "asc", from: "2026-10-07T09:00:00.5Z", to: "2026-10-07T09:00:00.500Z" })] });
  add({ name: "empty-range-and-level-not-applicable", files: ab, calls: [
    Qm({ from: qiso(10), to: qiso(0) }), Tm({ from: qiso(5), to: qiso(0) }), Qm({ stream: "audit", minLevel: "warn" }), Qm({ stream: "audit", minLevel: "error" }), Tm({ stream: "audit", minLevel: "info" }), Qm({ stream: "audit" }),
    Qm({ from: "yesterday", to: qiso(0) }), Qm({ from: qiso(10), to: "yesterday" }), Qm({ stream: "audit", minLevel: "warn", from: "yesterday" }),
  ] });
  add({ name: "cursors-bad-and-foreign", files: ab, calls: [
    Qm({ cursor: "garbage" }), Qm({ cursor: "###" }), Qm({ limit: 1, order: "asc" }), Qm({ cursor: "x", order: "asc", minLevel: "error" }, { cursorFromCall: 2 }), Qm({ order: "asc", limit: 1 }, { cursorFromCall: 2 }),
    Tm({ cursor: "garbage" }), Tm({}), Tm({ minLevel: "fatal" }, { cursorFromCall: 6 }),
  ] });
  add({ name: "filters-through-the-handler", files: {
    "core.log": T(qrec(0, "debug", "Alpha") + qrec(1, "warn", "Beta") + qrec(2, "error", "gamma")), "sup.log": T(qrec(3, "error", "Delta", { source: { kind: "harness", id: "sup", version: null } })),
    "audit.log": T(JSON.stringify({ ts: qiso(0), action: "auth.login", msg: "a" }) + "\n"),
  }, calls: [Qm({ order: "asc", minLevel: "warn" }), Qm({ order: "asc", component: "sup" }), Qm({ order: "asc", text: "ALPHA" }), Qm({ order: "asc", component: "", text: "" }), Qm({ stream: "audit" }), Qm({ order: "asc", limit: 1 })] });
  add({ name: "a-unicode-text-filter", files: { "core.log": T(qrec(0, "info", "Grüße 日本語 😀") + qrec(1, "info", "plain")) }, calls: [Qm({ text: "日本" })] });
  add({ name: "trace-id-matches-only-that-trace", files: { "core.log": T(qrec(0, "info", "hit", { trace_id: "4bf92f3577b34da6a3ce929d0e0e4736" }) + qrec(10, "info", "mentions 4bf92f3577b34da6a3ce929d0e0e4736")) }, calls: [Qm({ traceId: "4bf92f3577b34da6a3ce929d0e0e4736" }), Tm({ traceId: "4bf92f3577b34da6a3ce929d0e0e4736" })] });
  add({ name: "paging-through-the-handler-both-orders", files: { "core.log": T(Array.from({ length: 7 }, (_, i) => qrec(i * 10, "info", `m${i}`)).join("")) }, calls: [
    Qm({ order: "asc", limit: 3 }), Qm({ order: "asc", limit: 3 }, { cursorFromCall: 0 }), Qm({ order: "asc", limit: 3 }, { cursorFromCall: 1 }),
    Qm({ order: "desc", limit: 3 }), Qm({ order: "desc", limit: 3 }, { cursorFromCall: 3 }), Qm({ order: "desc", limit: 3 }, { cursorFromCall: 4 }),
  ] });
  add({ name: "a-missing-log-directory-is-empty", files: {}, missingDir: true, calls: [Qm({}), Tm({})] });
  add({ name: "the-scan-budget-reaches-the-handler", files: { "core.log": [{ gen: { count: 400, stepMs: 1, style: "rec" } }] }, maxScanBytes: 12_000, calls: [Qm({ order: "asc", limit: 5000 })] });
  add({ name: "a-redacted-record", files: { "core.log": T(qrec(0, "error", "x", { attrs: { token: "abc", h: S("Bearer ", "abcdefghijklmnop") } })) }, calls: [Qm({}), Tm({})] });

  // logs.tail
  add({ name: "tail-first-call-then-only-what-came-after", files: { "core.log": T(Array.from({ length: 10 }, (_, i) => qrec(i * 10, "info", `m${i}`)).join("")) }, calls: [
    Tm({ limit: 3 }), Tm({}, { cursorFromCall: 0 }), Tm({}, { cursorFromCall: 0, appendBefore: { file: "core.log", segs: T(qrec(1000, "info", "n1") + qrec(1010, "info", "n2")) } }), Tm({}, { cursorFromCall: 2 }),
  ] });
  add({ name: "a-rotation-in-the-middle-of-the-tail", files: { "core.log": T(qrec(0, "info", "m0") + qrec(10, "info", "m1")) }, calls: [
    Tm({}),
    Tm({}, { cursorFromCall: 0, appendBefore: { file: "core.log", segs: T(qrec(20, "info", "a")) } }),
    Tm({}, { cursorFromCall: 1, rotateBefore: "core.log" }),
    Tm({}, { cursorFromCall: 2, appendBefore: { file: "core.log", segs: T(qrec(30, "info", "b") + qrec(40, "info", "c")) } }),
    Tm({}, { cursorFromCall: 3, rotateBefore: "core.log" }),
    Tm({}, { cursorFromCall: 4, rotateBefore: "core.log" }),
    Tm({}, { cursorFromCall: 5, appendBefore: { file: "core.log", segs: T(qrec(50, "info", "d")) } }),
    Tm({}, { cursorFromCall: 6 }),
  ] });
  add({ name: "tail-after-an-append", files: { "core.log": T(Array.from({ length: 10 }, (_, i) => qrec(i * 10, "info", `m${i}`)).join("")) }, calls: [
    Tm({ limit: 3 }), Tm({ waitMs: 1000, limit: 3 }, { cursorFromCall: 0, appendOnSleep: { n: 1, file: "core.log", segs: T(qrec(1000, "info", "n1") + qrec(1010, "info", "n2")) } }), Tm({}, { cursorFromCall: 1 }),
  ] });
  add({ name: "tail-with-nothing-matching-still-anchors", files: { "core.log": T(qrec(0, "info", "quiet")) }, calls: [
    Tm({ minLevel: "error" }), Tm({ minLevel: "error", waitMs: 100 }, { cursorFromCall: 0, appendOnSleep: { n: 1, file: "core.log", segs: T(qrec(10, "info", "still quiet") + qrec(20, "error", "boom")) } }),
  ] });
  add({ name: "tail-long-poll-answers-at-once-when-a-line-arrives", pollMs: 250, files: { "core.log": T(qrec(0, "info", "m0")) }, calls: [
    Tm({}), Tm({ waitMs: 10_000 }, { cursorFromCall: 0, appendOnSleep: { n: 3, file: "core.log", segs: T(qrec(100, "info", "arrived")) } }),
  ] });
  add({ name: "tail-waits-until-the-deadline-then-answers-empty", pollMs: 250, files: { "core.log": T(qrec(0, "info", "m0")) }, calls: [
    Tm({}), Tm({ waitMs: 1000 }, { cursorFromCall: 0 }), Tm({ waitMs: 30_000 }, { cursorFromCall: 0, abortConnectionOnSleep: 2 }),
    Tm({ waitMs: 10_000 }, { cursorFromCall: 0, connectionAborted: true }), Tm({ waitMs: 30_000 }, { cursorFromCall: 0, abortCoreOnSleep: 1 }),
  ] });
  add({ name: "tail-on-an-empty-directory", pollMs: 100, files: {}, calls: [Tm({}), Tm({ waitMs: 250 }), Tm({ waitMs: 1 }), Tm({ waitMs: 0 }), Tm({ waitMs: -50 })] });
  add({ name: "tail-continues-with-a-cursor-cut-by-the-limit", files: { "core.log": T(Array.from({ length: 6 }, (_, i) => qrec(i * 10, "info", `m${i}`)).join("")) }, calls: [
    Tm({ limit: 2 }),
    Tm({ limit: 2 }, { cursorFromCall: 0, appendBefore: { file: "core.log", segs: T(Array.from({ length: 5 }, (_, i) => qrec(1000 + i, "info", `n${i}`)).join("")) } }),
    Tm({ limit: 2 }, { cursorFromCall: 1 }), Tm({ limit: 2 }, { cursorFromCall: 2 }), Tm({ limit: 2 }, { cursorFromCall: 3 }),
  ] });
  add({ name: "tail-on-the-audit-stream-and-with-filters", files: {
    "audit.log": T(JSON.stringify({ ts: qiso(0), action: "a.b", msg: "x" }) + "\n" + JSON.stringify({ ts: qiso(1), action: "a.c", msg: "y" }) + "\n"),
    "core.log": T(qrec(0, "info", "a") + qrec(1, "error", "Needle one") + qrec(2, "error", "other")),
  }, calls: [Tm({ stream: "audit" }), Tm({ minLevel: "error", component: "core", text: "needle" })] });
  add({ name: "tail-forwards-the-scan-budget", maxScanBytes: 100, files: { "core.log": [{ gen: { count: 50, stepMs: 1, style: "rec" } }] }, calls: [Tm({ limit: 100 })] });
  return cases;
}

async function buildLevelCases() {
  const T0L = T0;
  const source = { kind: "harness", id: "core", version: null };
  interface LCase { name: string; writer: false | { levels?: { defaultLevel?: string; levels?: Record<string, string>; traceUntilIn?: number } }; actor?: boolean; calls: any[] }
  const cases: LCase[] = [];
  const add = (c: LCase): void => { cases.push(c); };
  const isoAt = (d: number): string => new Date(T0L + d).toISOString();
  add({ name: "a-change-for-one-component-is-audited", writer: { levels: { defaultLevel: "info" } }, actor: true, calls: [{ levels: { "provider:fake": "debug" } }, {}] });
  add({ name: "empty-params-read-the-snapshot", writer: { levels: { defaultLevel: "warn", levels: { "provider:fake": "debug" } } }, actor: true, calls: [{}] });
  add({ name: "unset-restores-inheritance", writer: { levels: { defaultLevel: "info", levels: { "provider:fake": "debug", "provider:other": "debug" } } }, actor: true, calls: [{ unset: ["provider:fake"] }, {}] });
  add({ name: "without-a-writer-it-fails-closed", writer: false, calls: [{ defaultLevel: "debug" }, {}] });
  add({ name: "refusals", writer: { levels: { defaultLevel: "info" } }, actor: true, calls: [
    { levels: { "not a key": "debug" } }, { defaultLevel: "trace" }, { traceUntil: "yesterday" }, { levels: { "provider:fake": "loud" } }, { levels: { "provider:fake": 5 } }, { levels: { "provider:fake": null } }, { unset: ["not a key"] },
    { defaultLevel: "loud" }, { traceUntil: 5 }, { traceUntil: "2026-10-07T24:00:00Z" }, { traceUntil: "2026-02-30T00:00:00Z" }, { levels: { "provider:fake": "trace" } }, { levels: { harness: "debug" }, traceUntil: "yesterday" }, {},
  ] });
  add({ name: "a-trace-level-with-an-expiry", writer: { levels: { defaultLevel: "info" } }, actor: true, calls: [
    { defaultLevel: "trace", traceUntil: isoAt(HOUR) }, {}, { traceUntil: null }, {}, { defaultLevel: "info", traceUntil: null }, {},
  ] });
  add({ name: "an-expiry-in-the-past-or-too-far-ahead", writer: { levels: { defaultLevel: "info" } }, actor: true, calls: [
    { defaultLevel: "trace", traceUntil: isoAt(-1000) }, { defaultLevel: "trace", traceUntil: isoAt(25 * HOUR) }, { defaultLevel: "trace", traceUntil: isoAt(24 * HOUR) }, {},
  ] });
  add({ name: "several-changes-are-audited-per-key", writer: { levels: { defaultLevel: "info", levels: { "extension:a": "warn" } } }, actor: true, calls: [
    { defaultLevel: "error", levels: { "extension:a": "debug", "provider:b": "warn" }, unset: [] }, { unset: ["extension:a", "provider:b"] }, { levels: { "provider:b": "info" } }, { levels: { "provider:b": "info" } },
  ] });
  add({ name: "no-actor-is-unknown-on-rpc", writer: { levels: { defaultLevel: "info" } }, calls: [{ defaultLevel: "debug" }] });
  add({ name: "empty-collections-count-as-a-change-request", writer: { levels: { defaultLevel: "warn" } }, actor: true, calls: [{ levels: {} }, { unset: [] }, {}] });
  const out = [];
  for (const c of cases) {
    const root = mkdtempSync(join(tmpdir(), "p4-11-levels-"));
    try {
      const dir = join(root, "logs");
      let w: any = null;
      if (c.writer) {
        const { traceUntilIn, ...rest } = c.writer.levels ?? {};
        w = createWriter({ dir, role: "core", source, timers: false, now: () => T0L, levels: { ...rest, ...(traceUntilIn !== undefined ? { traceUntil: T0L + traceUntilIn } : {}) } } as any);
      }
      const audit = memoryAuditSink();
      const h = createLogsMethods({ dir, ...(w ? { writer: w } : {}), audit, now: () => T0L, ...(c.actor ? { actor: () => ({ user: "owner", host: "rpc" }) } : {}) });
      const outputs: any[] = [];
      for (const params of c.calls) {
        try { outputs.push({ ok: await h["logs.levels"]!(params, { requestId: "r", connectionId: "c", signal: new AbortController().signal }) }); }
        catch (e) { outputs.push(errOf(e)); }
      }
      out.push({ ...c, outputs, audit: audit.events });
      w?.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  return out;
}

async function buildMethods() {
  const query = [];
  for (const c of methodCases()) query.push(await runMethodCase(c));
  const names = new Set<string>();
  for (const q of query) { if (names.has(q.name)) throw new Error(`duplicate methods case ${q.name}`); names.add(q.name); }
  return { query, levels: await buildLevelCases(), time: { start: 1_000_000, t0: T0 } };
}

export async function buildLogsVectors(): Promise<Record<string, unknown>> {
  textCases.length = 0; valueCases.length = 0; windowCases.length = 0; maskJsonCases.length = 0; matcherTexts.length = 0; matcherBytes.length = 0; limits.length = 0;
  buildTextCases(); buildValueCases(); buildWindowCases(); buildMaskJson(); buildMatcherCases();
  const helpers = buildFormsAndHelpers();
  for (const list of [textCases, valueCases, windowCases, maskJsonCases, matcherTexts, matcherBytes, limits]) {
    const seen = new Set<string>();
    for (const { name } of list) { if (seen.has(name)) throw new Error(`duplicate case name ${name}`); seen.add(name); }
  }
  const out = {
    redact: { text: textCases, value: valueCases, window: windowCases, secretKey: buildKeyNames(), maskJson: maskJsonCases },
    "secret-matcher": { text: matcherTexts, bytes: matcherBytes, limits, ...helpers },
    levels: buildLevels(), trace: buildTrace(), output: buildOutput(), files: buildFiles(), lines: await buildLines(), records: await buildRecords(),
    query: await buildQuery(), methods: await buildMethods(),
  };
  // No assembled canary may reach a fixture: a hit means a case was written around `enc`.
  const text = JSON.stringify(out);
  for (const parts of shapes) if (parts.length > 1 && text.includes(parts.join(""))) throw new Error(`an assembled canary reached a fixture: ${parts[0]}...`);
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(await exporterMain({ area: "logs", build: buildLogsVectors }));
}
