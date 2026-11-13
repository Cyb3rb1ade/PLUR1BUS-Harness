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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  };
  // No assembled canary may reach a fixture: a hit means a case was written around `enc`.
  const text = JSON.stringify(out);
  for (const parts of shapes) if (parts.length > 1 && text.includes(parts.join(""))) throw new Error(`an assembled canary reached a fixture: ${parts[0]}...`);
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(await exporterMain({ area: "logs", build: buildLogsVectors }));
}
