// Parity vectors (mode V) for the model-only failure boundary (`packages/core/src/toolcall/model-tool-error.ts`, N1,
// P4-K K9b). Each case is a failed tool envelope, a secret source, the home directory and platform the call states, and
// the envelope TypeScript gives the model (or the error it throws on an envelope without the dispatcher's shape). The Rust
// replay is `crates/plur1bus-core/src/toolcall/model_error_vectors.rs`.
//
// The process's own home directory is never used: every case names its home, so the file is the same on every machine.
// A case that carries secret-shaped material stores its envelope and its secrets in pieces (`{ parts: [...] }`).
//
//   node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning scripts/parity/export-model-tool-error.ts [--check]
import { fileURLToPath } from "node:url";
import { exporterMain } from "./lib.mjs";
import { hash16, rawOf, str, thrown } from "./toolcall-support.ts";
import { modelToolError } from "../../packages/core/src/toolcall/model-tool-error.ts";
import { SecretFormsCache } from "../../packages/core/src/logs/secret-forms.ts";

const text = (v: unknown) => JSON.stringify(v);
const ch = (code: number) => String.fromCharCode(code);
/** A text cut into pieces of at most six code units, so no secret-shaped run is stored whole. */
const pieces = (t: string) => ({ parts: t.match(/[\s\S]{1,6}/g) ?? [""] });

const envelope = (over: Record<string, unknown> = {}, error: Record<string, unknown> = {}) => ({
  callId: "call-1", tool: "file.read", isError: true, error: { code: "tool-failed", message: "boom", ...error },
  provenance: { origin: { system: "tool:file.read", agent: "main", principal: "owner", trust: "first-party" }, hops: 1, transformedBy: [] },
  meta: { decision: "allow", durationMs: 0, bytes: 0 }, ...over,
});

type Secrets = { raw: unknown[] } | { forms: unknown[] } | { matcher: unknown[] };
interface Case { name: string; failure: unknown; secrets?: Secrets; home: string; realHome?: string; platform: string; secret?: boolean }

const SECRET = ["sec", "ret-", "1234", "5"].join("");
const NUMERIC = ["9081", "7263", "54"].join("");
const GH = ["gh", "p_", "Ab3dE", "f6hIj", "Kl9nOp", "Qr2tUv", "Wx5zAb", "Cd8fGh", "Ij"].join("");

function cases(): Case[] {
  const out: Case[] = [];
  const HOMES: [string, string, string?][] = [["/srv/operator", "linux"], ["/srv/operator", "darwin"], ["/srv/operator/", "linux"], ["/srv/operator", "linux", "/private/srv/operator"],
    ["C:\\Users\\Op", "win32"], ["\\\\?\\C:\\Users\\Op", "win32"], ["/home/jürgen", "darwin"], ["/Users/sam", "darwin"], ["/Users/kim", "darwin"], ["/home/😀x", "linux"], ["/", "linux"], ["//", "linux"], ["/a.b+c(d)", "linux"], ["C:", "win32"]];
  const MESSAGES = [
    "cannot read /srv/operator/x.txt", "cannot read /SRV/Operator/x.txt", "see /srv/operator2/x", "see file:///srv/operator/x", "see a/srv/operator/x", "see /srv/operator", "/srv/operator:1", "(/srv/operator)", "/srv//operator/x", "/srv/operator\\x",
    "\\\\?\\C:\\Users\\Op\\x", "C:/Users/Op/x", "c:\\users\\op\\x", "C:\\Users\\Opal\\x", "/private/srv/operator/x",
    "/home/alice/project/report.txt", "/Users/Bob/x", "C:\\Users\\carol\\x", "\\\\?\\C:\\Users\\dave\\y", "/mnt/c/Users/eve/z", "/Volumes/Disk/Users/frank/a", "\\\\wsl$\\Ubuntu\\home\\gina\\b", "\\\\wsl.localhost\\Debian\\var\\home\\hal\\c",
    "file:///Users/ivan/x", "x/home/alice", "~/home/al", "/HOME/alice", "/home//alice/x", "/home/", "/home/alice:1", "/var/home/x/y", "/home/jürgen/a", "/HOME/JÜRGEN/a", "/Users/ſam/x", "/USERS/SAM/x", "/Users/" + ch(0x212a) + "im/x", "/Users/KIM/x", "/home/😀x/y",
    "line one\nline two", "first\r\nsecond", "a" + ch(0x2028) + "b", "c" + ch(0x2029) + "d", "x" + ch(0x85) + "y", "", "lone " + ch(0xd800) + " surrogate",
    "y".repeat(299) + "😀" + "z", "y".repeat(301), "y".repeat(300), "y".repeat(298) + "😀", "/a.b+c(d)/e",
    // Without `u`, `i` does not fold ſ (U+017F) into s: these are no home folders to JavaScript.
    "/U" + ch(0x17f) + "ers/bob/x", "/Volume" + ch(0x17f) + "/Disk/Users/bob", "C:\\U" + ch(0x17f) + "ers\\bob", "/home" + ch(0x17f) + "/x",
  ];
  for (const [home, platform, realHome] of HOMES) for (const message of MESSAGES) out.push({ name: `home ${home} ${platform}`, failure: envelope({}, { message }), home, platform, ...(realHome ? { realHome } : {}) });
  const L = "/srv/operator";
  const one = (name: string, failure: unknown, extra: Partial<Case> = {}) => out.push({ name, failure, home: L, platform: "linux", ...extra });
  for (const code of ["tool-failed", "tool-denied", "invalid-arguments", "tool-timeout"]) {
    one(`long message under ${code}`, envelope({}, { code, message: "m".repeat(600) }));
    one(`typed failure under ${code}`, envelope({}, { code, message: "x failed: not-found", typedFailure: { code: "not-found", message: "no such file " + "q".repeat(400), hint: "check the path" } }));
  }
  // Clip bounds with text the pattern rules leave alone (a long run of one letter is token-shaped and redacted first).
  const words = (n: number) => "ab cd ".repeat(200).slice(0, n);
  for (const code of ["tool-failed", "tool-denied"]) for (const n of [299, 300, 301, 499, 500, 501, 600]) {
    one(`${n} characters under ${code}`, envelope({}, { code, message: words(n) }));
    one(`${n} characters and an emoji under ${code}`, envelope({}, { code, message: words(n - 2) + "😀" }));
    one(`a ${n}-character hint under ${code}`, envelope({}, { code, hint: words(n) }));
  }
  // The 4096 bound exactly: the longest envelope that is kept whole, and one character more.
  // Identities clipped to 128 in the shortened envelope (word text, so no pattern rule shortens them first).
  for (const n of [127, 128, 129, 300]) one(`${n}-character identities, shortened`, envelope({ callId: words(n), tool: words(n), provenance: { origin: { system: words(n), agent: words(n), principal: words(n - 1) + "😀", trust: "first-party" }, hops: 1, transformedBy: [] } }, { hint: "h".repeat(10), ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, words(400)])) }));
  // The bulk sits in error details, which the shortened envelope drops (`meta` it keeps).
  const filled = (last: number) => envelope({}, { ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, words(400)])), last: words(last) });
  for (let last = 0; last < 500; last++) {
    const out = modelToolError(JSON.parse(text(filled(last))), [], { home: L, platform: "linux" }) as any;
    if (text(out).length === 4096 && out.error?.last !== undefined) { one("exactly 4096 characters", filled(last)); one("4097 characters", filled(last + 1)); break; }
  }
  for (const internalFailure of ["internal-error", "classification-failure", "approval-port-failure", "audit-unavailable", "nope", "__proto__", "toString", "constructor", null, 1, ""])
    one(`internal ${String(internalFailure)}`, envelope({}, { internalFailure, message: "raw diagnostics /home/alice", sourceCode: "x", typedFailure: { code: "t" } }));
  one("internal without a code", { ...envelope(), error: { message: "m", internalFailure: "internal-error" } });
  for (const code of ["not-found", "Bad Code!", "", "a".repeat(64), "a".repeat(65), "a_b.c-d", null, 5, true, ["ab"], ["a", "b"], { x: 1 }, "ü"])
    one(`typed code ${text(code)}`, envelope({}, { typedFailure: { code, message: "typed" } }));
  one("typed without a code", envelope({}, { typedFailure: { message: "typed", hint: "h" } }));
  one("typed with its own sourceCode", envelope({}, { typedFailure: { sourceCode: "zz", message: "typed", code: "c" } }));
  one("typed with its own code first", envelope({}, { typedFailure: { code: "c", extra: 1, message: "typed" } }));
  one("typed as a string", envelope({}, { typedFailure: "ab" }));
  one("typed as an array", envelope({}, { typedFailure: ["x"] }));
  one("typed as a number", envelope({}, { typedFailure: 5 }));
  one("typed empty string", envelope({}, { typedFailure: "", message: "kept" }));
  one("typed null", envelope({}, { typedFailure: null, message: "kept" }));
  one("typed without a message", envelope({}, { typedFailure: { code: "c" } }));
  one("typed with a number message", envelope({}, { typedFailure: { code: "c", message: 5 } }));
  one("a number message", envelope({}, { message: 5 }));
  one("no message", { ...envelope(), error: { code: "tool-failed" } });
  one("a sourceCode kept", envelope({}, { sourceCode: "tool-failed" }));
  one("a sourceCode removed", envelope({}, { sourceCode: "Not OK" }));
  one("a null sourceCode", envelope({}, { sourceCode: null }));
  one("no error", { ...envelope(), error: undefined });
  one("key-named members", envelope({ meta: { decision: "allow", token: "abc", password: null, apiKey: 5, nested: { secret: { a: 1 } }, Authorization: "Bearer x" } }, { hint: "h", authToken: "zz" }));
  one("deep nesting", envelope({ meta: (() => { let v: unknown = "deep /home/alice"; for (let i = 0; i < 70; i++) v = i % 2 ? [v] : { a: v }; return v; })() }));
  one("big hint", envelope({}, { hint: "h".repeat(5000) }));
  one("big hint, long ids", envelope({ callId: "c".repeat(300), tool: "t".repeat(200) }, { hint: "h".repeat(5000), sourceCode: "ok" }));
  one("big hint, agent null", envelope({ provenance: { origin: { system: "s", agent: null, principal: "p", trust: "first-party" }, hops: 2, transformedBy: ["x"] } }, { hint: "h".repeat(5000) }));
  one("big hint, no provenance", { ...envelope({}, { hint: "h".repeat(5000) }), provenance: undefined });
  one("big hint, number callId", envelope({ callId: 7 }, { hint: "h".repeat(5000) }));
  one("big hint, no meta", { ...envelope({}, { hint: "h".repeat(5000) }), meta: undefined });
  one("big hint, emoji ids", envelope({ callId: "😀".repeat(100) }, { hint: "h".repeat(5000) }));
  one("big typed message", envelope({}, { code: "invalid-arguments", typedFailure: { code: "x", message: "m".repeat(4000) } }));
  // Secrets: raw values (their encodings are derived), forms (masked as they are), a compiled matcher.
  const s = (name: string, failure: unknown, secrets: Secrets) => out.push({ name, failure, secrets, home: L, platform: "linux", secret: true });
  const raw = { raw: [pieces(SECRET)] };
  s("raw secret in the message", envelope({}, { message: `cannot read /home/alice/r.txt ${SECRET}\n    at privateStack`, hint: `try /Users/alice/r.txt ${SECRET}` }), raw);
  s("raw secret everywhere", envelope({ callId: `id ${SECRET}`, tool: SECRET, meta: { note: encodeURIComponent(`a/${SECRET}`), b64: Buffer.from(SECRET).toString("base64"), hex: Buffer.from(SECRET).toString("hex") } }, { message: SECRET, typedFailure: { code: SECRET, message: `t ${SECRET}` } }), raw);
  s("a number that is a secret", envelope({ meta: { bytes: Number(NUMERIC), other: 5 } }), { raw: [pieces(NUMERIC)] });
  s("forms as given", envelope({}, { message: `${SECRET} ${Buffer.from(SECRET).toString("hex")}` }), { forms: [pieces(SECRET), pieces(SECRET)] });
  s("a matcher", envelope({}, { message: `private ${SECRET}` }), { matcher: [pieces(SECRET)] });
  s("a token-shaped string without a registered secret", envelope({}, { message: `auth failed ${GH} at /home/alice`, hint: `password=${SECRET}` }), { raw: [] });
  s("a short secret is not one", envelope({}, { message: "pw abc" }), { raw: [pieces("abc")] });
  return out;
}

function matcherOf(secrets: Secrets | undefined): [unknown[], Record<string, unknown>] {
  if (!secrets) return [[], {}];
  if ("raw" in secrets) return [secrets.raw.map(v => rawOf(v)), {}];
  if ("forms" in secrets) return [[], { secretForms: secrets.forms.map(v => rawOf(v)) }];
  return [[], { secretMatcher: new SecretFormsCache().snapshot(secrets.matcher.map(v => String(rawOf(v)))).matcher }];
}

export function buildModelToolError() {
  return {
    cases: cases().map(c => {
      const [secrets, extra] = matcherOf(c.secrets);
      const failure = JSON.parse(text(c.failure));
      let answer: unknown;
      try {
        const safe = modelToolError(failure, secrets as string[], { ...extra, home: c.home, ...(c.realHome ? { realHome: c.realHome } : {}), platform: c.platform as NodeJS.Platform });
        const full = text(safe);
        // The home grid differs only in the message: that in full, the envelope as its hash.
        answer = c.name.startsWith("home ") ? { message: str(safe.error.message), h: hash16(full), n: full.length } : str(full);
      } catch (e) { answer = { throws: { name: (thrown(e) as any).throws.name } }; }
      return { name: c.name, failure: c.secret ? pieces(text(c.failure)) : str(text(c.failure)), ...(c.secrets ? { secrets: c.secrets } : {}), home: c.home, ...(c.realHome ? { realHome: c.realHome } : {}), platform: c.platform, answer };
    }),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(await exporterMain({ area: "toolcall", build: async () => ({ "model-tool-error": buildModelToolError() }) }));
