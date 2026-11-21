// Parity vectors (mode V) for the egress package (P4-K K2, plan P4-21): the compiled policy and `hostAllowed`, the per-hop
// gate (`beforeResolve`, `afterResolve`) over URLs as `new URL` reads them, the dry run of the service (`decide`) over a
// scripted resolver with the names it looked up and the counters of `status`, and the model-download exception
// (`isModelArtifactRequest` over real `Request` objects, `modelDownloadPolicy`), and what `new URL` reads from a hostile URL
// corpus (`urls`: named classes and a generated set with a fixed seed). `crates/plur1bus-core/src/egress/vectors.rs` replays
// every case. Recorded, never edited by hand.
//
// The address classification itself (`tools/web/ip.ts`) is pinned by the shared vector file
// `packages/core/test/fixtures/net/ip-classification-vectors.json`, which the Rust replay reads as well.
//
// What the vectors cannot hold: `request` (the guarded HTTP client belongs to the web tools of P4-30), and configuration
// values JSON cannot carry (`NaN`, `Infinity`, a non-JSON object): the live configuration is JSON.
//
//   node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning scripts/parity/export-egress.ts [--check]
import { domainToASCII, domainToUnicode, fileURLToPath } from "node:url";
import { compileEgressPolicy, hostAllowed, type EgressConfig } from "../../packages/core/src/egress/policy.ts";
import { bareHost, createGate, EgressDenial, effectivePort, isLoopbackHost, type Decision } from "../../packages/core/src/egress/gate.ts";
import { createEgress } from "../../packages/core/src/egress/service.ts";
import { isModelArtifactRequest, modelDownloadPolicy, MODEL_DOWNLOAD_HOSTS } from "../../packages/core/src/egress/model-downloads.ts";
import type { ResolvedAddress } from "../../packages/core/src/tools/web/guard.ts";
import { exporterMain } from "./lib.mjs";

/** Non-ASCII hosts and `xn--` labels need IDNA (UTS 46) on the Rust side; such cases carry this note. */
const IDNA_NOTE = "needs IDNA (domainToASCII / the URL host parser)";
const nonAscii = (s: string): boolean => /[^\x00-\x7f]/u.test(s) || /xn--/iu.test(s);
/** K2-D4: Node's `domainToASCII` (and `new URL`) accepts an `xn--` label that is not valid IDNA (`xn--zz` decodes to nothing UTS 46
 *  allows). The Rust host parser refuses it, so such an entry is a configuration error there (deny-all). Cases that hold one carry
 *  `divergence`; the replay then checks the fail-closed answer. */
const LENIENT_PUNYCODE = ["xn--zz.example", "xn--a.example"];
const divergence = (json: string) => (LENIENT_PUNYCODE.some((e) => json.includes(e)) ? { divergence: "K2-D4" } : {});

const compiled = (cfg: unknown) => {
  const p = compileEgressPolicy(cfg as EgressConfig);
  return { hostRules: p.hostRules, allowPorts: p.allowPorts, allowLoopback: p.allowLoopback, errors: p.errors, allowHosts: p.allowHosts };
};

// --- the compiled policy and hostAllowed --------------------------------------------------------------------------------------
const POLICY_CONFIGS: unknown[] = [
  { allowHosts: [], allowPorts: [443], allowLoopback: false },
  { allowHosts: ["Example.COM", "*.api.test", "8.8.8.8", "[2001:4860:4860::8888]"], allowPorts: [443], allowLoopback: false },
  { allowHosts: ["Example.COM", "*.api.test", "8.8.8.8", "[2001:4860:4860::8888]", "bücher.example."], allowPorts: [443], allowLoopback: false },
  { allowHosts: ["*"], allowPorts: [443, 80], allowLoopback: true },
  { allowHosts: ["*", "localhost", "127.0.0.1", "[::1]"], allowPorts: [80, 443, 3000], allowLoopback: true },
  { allowHosts: ["  spaced.example  ", "trailing.example.", "UPPER.Example", "*.Deep.Suffix.Test", "a-b.c-d.example"], allowPorts: [443, 8443, 65535, 1], allowLoopback: "yes" },
  { allowHosts: ["10.0.0.1", "[::ffff:10.0.0.2]", "[fd7a:115c:a1e0::9]", "100.64.0.9"], allowPorts: [443], allowLoopback: false },
  { allowHosts: ["*.example"], allowPorts: [443], allowLoopback: false },
  { allowHosts: ["node.example"], allowPorts: [443], allowLoopback: false },
  { allowHosts: ["x".repeat(63) + ".example", "a".repeat(64) + ".example"], allowPorts: [443], allowLoopback: false },
  { allowHosts: ["1example.com", "example.123", "example.1a", "-bad.example", "bad-.example", "_srv.example"], allowPorts: [443], allowLoopback: false },
  { allowHosts: ["xn--bcher-kva.example"], allowPorts: [443], allowLoopback: false },
  { allowHosts: ["xn--zz.example"], allowPorts: [443], allowLoopback: false },
  { allowHosts: ["例子.测试"], allowPorts: [443], allowLoopback: false },
];
for (const bad of ["", "ex ample.com", "http://example.com", "example.com/path", "a*.example.com", "*.", "**", "*.*.example.com", "user@example.com", "example.com:443",
  "0x7f.1", "2130706433", "x".repeat(300), "127.1", "::1", "[127.0.0.1]", "2001:db8::1", "[2001:db8::1", "exa%41mple.com", "a\\b.example", "tab\texample.com", "a..b.example", ".lead.example",
  // `domainToASCII` is the host parser: a name that ends in a number is read as IPv4 (or refused), UTS 46 maps and validates.
  "0x7f.0x1", "foo.0x", "a.0x10", "0x7f000001", "1.0x", "example.0X1F", "0x.example", "\uff25\uff38\uff21\uff2d\uff30\uff2c\uff25.com", "fa\u00df.example", "xn--a.example",
  "a\u00adb.example", "a\u200db.example", "\u0661.example", "\uff11\uff12\uff17.\uff10.\uff10.\uff11", "xn--fa-hia.example", "XN--BCHER-KVA.example", "a.xn--", "xn--.example"]) {
  POLICY_CONFIGS.push({ allowHosts: ["good.example", bad], allowPorts: [443], allowLoopback: false });
}
// An address entry in JavaScript white space or behind a byte order mark: `parseAddress` trims as `String.prototype.trim` does
// (review A of K2, RA-2 at the root), and the host parser refuses the same text as a name.
for (const spaced of [" 8.8.8.8 ", "8.8.8.8\u00a0", "\u00a08.8.8.8", "8.8.8.8\ufeff", "\u3000[::1]", "127.0.0.1\u2028", "[::1]\u00a0", "8.8.8.8\u200b", "8.8.8.8\u0085"]) {
  POLICY_CONFIGS.push({ allowHosts: ["good.example", spaced], allowPorts: [443], allowLoopback: false });
}
for (const ports of [[0], [65536], [-1], [1.5], ["443"], [null], [443, 443], []]) POLICY_CONFIGS.push({ allowHosts: ["a.example"], allowPorts: ports, allowLoopback: true });
for (const bad of [{ allowHosts: null }, {}, { allowHosts: "example.com" }, { allowPorts: undefined }, { allowPorts: 443 }, { allowPorts: null }, { allowHosts: [7, "a.example"] }, { allowHosts: [null] }]) {
  const base: Record<string, unknown> = { allowHosts: ["a.example"], allowPorts: [443], allowLoopback: true };
  const cfg = { ...base, ...bad };
  if ("allowPorts" in bad && bad.allowPorts === undefined) delete cfg.allowPorts;
  if (Object.keys(bad).length === 0) delete cfg.allowHosts;
  POLICY_CONFIGS.push(cfg);
}

const HOSTS = [
  "example.com", "EXAMPLE.com.", "www.example.com", "example.com.evil.test", "a.api.test", "a.b.api.test", "api.test", "evilapi.test", "api.test.evil.test",
  "xn--bcher-kva.example", "8.8.8.8", "8.8.4.4", "[2001:4860:4860::8888]", "[2001:4860:4860:0:0:0:0:8888]", "2001:4860:4860::8888", "anything.example", "[::1]",
  "127.0.0.1", "localhost", "foo.localhost", "10.0.0.1", "10.0.0.2", "[::ffff:10.0.0.2]", "[::ffff:a00:2]", "100.64.0.9", "[fd7a:115c:a1e0::9]", "node.example",
  "spaced.example", "trailing.example", "upper.example", "x.deep.suffix.test", "deep.suffix.test", "a-b.c-d.example", "good.example", "a.example", "", ".", "0x8.8.8.8",
  "134744072", "8.8.8.8.", "[2001:4860:4860::8888].",
  " 8.8.8.8", "8.8.8.8\u00a0", "\ufeff8.8.8.8", "[::1] ", "127.0.0.1\u3000", "8.8.8.8\u200b",
  "0x7f.0x1", "foo.0x", "fa\u00df.example", "FASS.example", "xn--fa-hia.example", "\uff25\uff38\uff21\uff2d\uff30\uff2c\uff25.com", "b\u00fccher.example", "B\u00dcCHER.example",
];

function policyCases() {
  return POLICY_CONFIGS.map((config, i) => {
    const p = compileEgressPolicy(config as EgressConfig);
    const allowed = HOSTS.map((h) => [hostAllowed(p, h), hostAllowed(p, h, { explicitOnly: true }), hostAllowed(p, h, { exactOnly: true })]);
    const json = JSON.stringify(config);
    return { name: `config-${i}`, config, policy: compiled(config), hosts: HOSTS, allowed, ...(nonAscii(json) ? { note: IDNA_NOTE } : {}), ...divergence(json) };
  });
}

// --- the gate -------------------------------------------------------------------------------------------------------------------
const GATE_CONFIGS: unknown[] = [
  { allowHosts: ["example.com", "*.cdn.test", "localhost", "127.0.0.1", "[::1]"], allowPorts: [443, 8443], allowLoopback: false },
  { allowHosts: ["localhost", "127.0.0.1", "[::1]"], allowPorts: [3000], allowLoopback: true },
  { allowHosts: ["127.0.0.1"], allowPorts: [80], allowLoopback: true },
  { allowHosts: ["10.0.0.1"], allowPorts: [80], allowLoopback: true },
  { allowHosts: ["example.com"], allowPorts: [8443], allowLoopback: false },
  { allowHosts: ["*"], allowPorts: [80, 443], allowLoopback: true },
  { allowHosts: ["*", "localhost"], allowPorts: [80, 443], allowLoopback: true },
  { allowHosts: ["localhost", "dev.example", "*"], allowPorts: [443, 3000], allowLoopback: true },
  { allowHosts: ["localhost"], allowPorts: [443], allowLoopback: false },
  { allowHosts: ["8.8.8.8", "[2001:db8::1]"], allowPorts: [443, 8443], allowLoopback: false },
  { allowHosts: [""], allowPorts: [443], allowLoopback: true },
];
const URLS = [
  "https://example.com/x", "https://a.cdn.test:8443/x", "https://evil.test/", "https://example.com:444/", "https://example.com:22/", "https://example.com/",
  "http://example.com/", "ftp://example.com/", "file:///etc/passwd", "gopher://example.com/", "ws://example.com/", "wss://example.com/", "data:text/plain,hi",
  "http://localhost:443/", "http://localhost:3000/", "http://127.0.0.1:3000/", "http://[::1]:3000/", "http://127.0.0.2:3000/", "http://localhost:3001/", "http://example.com:3000/",
  "http://0x7f.1/", "http://2130706433/", "http://017700000001/", "http://127.1/", "http://0x7f.0.0.2/", "http://[::ffff:127.0.0.1]/", "http://[0:0:0:0:0:0:0:1]:3000/",
  "https://user:pw@example.com/", "https://@example.com/", "https://user@example.com/", "https://:pw@example.com/", "https://example.com./", "https://example.com../",
  "http://localhost/", "http://foo.localhost/", "https://localhost/", "http://LOCALHOST:3000/", "http://localhost.:3000/", "https://EXAMPLE.com/", "HTTPS://example.com/",
  "https:example.com", "https:\\\\example.com\\x", "https://ex%41mple.com/", "https://example.com:0443/", "https://example.com:443/", "https://example.com:/",
  "  https://example.com/  ", "https://exam\tple.com/", "https://example.com#frag", "https://example.com?x=1", "https://8.8.8.8/", "https://8.8.8.8./", "https://[2001:db8::1]:8443/",
  "https://[2001:0db8:0:0:0:0:0:1]/", "https://xn--bcher-kva.example/", "https://bücher.example/", "https://ｅxample.com/", "https://1.2.3.4.5/", "https://example.com:65536/",
  "https://exa mple.com/", "not a url", "https://", "https://a..b/", "https://.a/", "https://4294967295/", "https://0/", "https://dev.example/", "http://[::1]/", "https://[::1]/",
];
const PINS: ResolvedAddress[] = [
  { address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }, { address: "127.0.0.9", family: 4 }, { address: "::1", family: 6 },
  { address: "::ffff:127.0.0.1", family: 6 }, { address: "10.0.0.1", family: 4 }, { address: "2001:db8::1", family: 6 }, { address: "nope", family: 4 },
];

const denial = (e: unknown) => {
  if (!(e instanceof EgressDenial)) throw e;
  return { reason: e.reason, message: e.message, host: e.host, code: e.code };
};

function gateCases() {
  const out: unknown[] = [];
  for (const [ci, config] of GATE_CONFIGS.entries()) {
    const policy = compileEgressPolicy(config as EgressConfig);
    for (const raw of URLS) {
      let url: URL;
      try { url = new URL(raw); } catch { out.push({ config: ci, url: raw, urlError: true }); continue; }
      const seen: Decision[] = [];
      const gate = createGate(policy, { onDecision: (d) => seen.push(d) });
      let before: unknown = null;
      try { gate.beforeResolve(url); } catch (e) { before = denial(e); }
      const after = PINS.map((pin) => {
        const s: Decision[] = [];
        const g = createGate(policy, { onDecision: (d) => s.push(d) });
        try { g.afterResolve(url, pin); return { ok: true, decisions: s }; } catch (e) { return { ...denial(e), decisions: s }; }
      });
      out.push({
        config: ci, url: raw, hostname: url.hostname, protocol: url.protocol, port: url.port, bareHost: bareHost(url), effectivePort: effectivePort(url),
        loopbackHost: isLoopbackHost(bareHost(url)), before, beforeDecisions: seen, after, ...(nonAscii(raw) ? { note: IDNA_NOTE } : {}),
      });
    }
  }
  return { configs: GATE_CONFIGS, pins: PINS, cases: out };
}

// --- the service: decide and status -------------------------------------------------------------------------------------------
type Answer = { addresses: ResolvedAddress[] } | { error: string };
type Step = { url: string; purpose?: "a2a"; config?: number; answers?: Record<string, Answer> };
const DECIDE_SCENARIOS: { name: string; configs: unknown[]; answers: Record<string, Answer>; steps: Step[] }[] = [
  {
    name: "a2a-tailnet-pins", configs: [{ allowHosts: ["node.example"], allowPorts: [443], allowLoopback: false }, { allowHosts: ["*"], allowPorts: [443], allowLoopback: false }],
    answers: { "node.example": { addresses: [{ address: "100.64.0.9", family: 4 }] } },
    steps: [
      { url: "https://node.example/a2a" }, { url: "https://node.example/a2a", purpose: "a2a" },
      { url: "https://node.example/a2a", purpose: "a2a", answers: { "node.example": { addresses: [{ address: "fd7a:115c:a1e0::9", family: 6 }] } } },
      ...["10.0.0.1", "169.254.169.254", "100.100.100.200", "127.0.0.1"].map((a) => ({ url: "https://node.example/a2a", purpose: "a2a" as const, answers: { "node.example": { addresses: [{ address: "100.64.0.9", family: 4 as const }, { address: a, family: 4 as const }] } } })),
      { url: "https://node.example/a2a", purpose: "a2a", config: 1 },
    ],
  },
  {
    name: "a2a-exact-before-dns", configs: [{ allowHosts: ["*.example"], allowPorts: [443], allowLoopback: false }, { allowHosts: ["node.example"], allowPorts: [443], allowLoopback: false }, { allowHosts: ["100.64.0.9"], allowPorts: [443], allowLoopback: false }],
    answers: { "node.example": { addresses: [{ address: "100.64.0.9", family: 4 }] } },
    steps: [
      { url: "https://node.example/a2a", purpose: "a2a" },
      { url: "https://node.example/a2a", purpose: "a2a", answers: { "node.example": { addresses: [{ address: "93.184.216.34", family: 4 }] } } },
      { url: "https://node.example/a2a", answers: { "node.example": { addresses: [{ address: "93.184.216.34", family: 4 }] } } },
      { url: "https://node.example/a2a", purpose: "a2a", config: 1 },
      { url: "https://100.64.0.9/a2a", purpose: "a2a", config: 2 }, { url: "https://100.64.0.9/a2a", config: 2 },
    ],
  },
  {
    name: "ordinary-decisions", configs: [{ allowHosts: ["example.com", "*.cdn.test", "localhost", "127.0.0.1", "8.8.8.8"], allowPorts: [443, 3000], allowLoopback: true }, { allowHosts: [], allowPorts: [443], allowLoopback: false }, { allowHosts: ["ok.example", "bad entry"], allowPorts: [443], allowLoopback: true }],
    answers: {
      "example.com": { addresses: [{ address: "93.184.216.34", family: 4 }, { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 }] },
      "a.cdn.test": { addresses: [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }] },
      "b.cdn.test": { addresses: [] }, "c.cdn.test": { error: "ENOTFOUND" }, "d.cdn.test": { error: "" }, "e.cdn.test": { addresses: [{ address: "garbage", family: 4 }] },
      "f.cdn.test": { addresses: [{ address: "127.0.0.1", family: 4 }] }, "g.cdn.test": { addresses: [{ address: "::ffff:93.184.216.34", family: 6 }] },
      "h.cdn.test": { addresses: [{ address: "168.63.129.16", family: 4 }] }, "i.cdn.test": { addresses: [{ address: "100.100.100.200", family: 4 }] },
    },
    steps: [
      { url: "https://example.com/" }, { url: "https://a.cdn.test/" }, { url: "https://b.cdn.test/" }, { url: "https://c.cdn.test/" }, { url: "https://d.cdn.test/" },
      { url: "https://e.cdn.test/" }, { url: "https://f.cdn.test/" }, { url: "https://g.cdn.test/" }, { url: "https://h.cdn.test/" }, { url: "https://i.cdn.test/" },
      { url: "http://localhost:3000/" }, { url: "https://localhost:3000/" }, { url: "https://127.0.0.1:3000/" }, { url: "https://8.8.8.8/" }, { url: "https://[::ffff:8.8.8.8]/" },
      { url: "not a url" }, { url: "https://evil.test/" }, { url: "http://example.com/" }, { url: "https://example.com:8080/" }, { url: "https://u:p@example.com/" },
      { url: "https://example.com/", config: 1 }, { url: "https://ok.example/", config: 2 }, { url: "http://localhost:3000/", purpose: "a2a" }, { url: "https://bücher.example/" },
    ],
  },
];

// Spellings that a URL reader must not take for an address or a name it is not (review A of K2): a sign in an IPv4 part,
// white space and a byte order mark around an address, a capital sigma at the end of a label, digits and dots that UTS 46
// maps. The policy lists the address and the names; the resolver answers the two sigma spellings with different addresses,
// so the name that was looked up shows in the pin.
const SPELLING_URLS = [
  "https://1.2.3.4/", "https://+1.2.3.4/", "https://1.+2.3.4/", "https://%2b1.2.3.4/", "https://0x+1020304/", "https://+16909060/", "https://1.2.3.+4/", "https://-1.2.3.4/",
  "http://+127.0.0.1/", "http://+127.1/", "http://0x+7f.1/", "http://+2130706433/", "http://127.0.0.1/",
  "https://1.2.3.4\u00a0/", "https://1.2.3.4\u3000/", "https://1.2.3.4\u2028/", "https://1.2.3.4\u2029/", "https://1.2.3.4\u1680/", "https://1.2.3.4\u2003/", "https://1.2.3.4\u202f/", "https://1.2.3.4\u205f/",
  "https://1.2.3.4\ufeff/", "https://1.2.3.4%C2%A0/", "https://1.2.3.4%E3%80%80/", "https://\u00a01.2.3.4/", "http://127.0.0.1\u00a0/", "http://127.0.0.1\ufeff/",
  "https://\u039f\u03a3-shop.example/", "https://\u03bf\u03c3-shop.example/", "https://\u03bf\u03c2-shop.example/", "https://example.\u039f\u03a3/", "https://example.\u03bf\u03c3/", "https://example.\u03bf\u03c2/", "https://\u039f\u03a3/",
  "https://\uff11.2.3.4/", "https://1\u200b.2.3.4/", "https://\u00ad1.2.3.4/", "https://1\u30022\u30023\u30024/",
];
const publicPin = (address: string): Answer => ({ addresses: [{ address, family: 4 }] });
DECIDE_SCENARIOS.push({
  name: "address-and-name-spellings",
  configs: [
    { allowHosts: ["1.2.3.4", "127.0.0.1", "\u039f\u03a3-shop.example", "example.\u039f\u03a3"], allowPorts: [443, 80], allowLoopback: true },
    { allowHosts: ["*"], allowPorts: [443, 80], allowLoopback: false },
  ],
  answers: {
    [domainToASCII("\u03bf\u03c3-shop.example")]: publicPin("93.184.216.34"), [domainToASCII("\u03bf\u03c2-shop.example")]: publicPin("93.184.216.35"),
    [domainToASCII("example.\u03bf\u03c3")]: publicPin("93.184.216.36"), [domainToASCII("example.\u03bf\u03c2")]: publicPin("93.184.216.37"),
    [domainToASCII("\u03bf\u03c3")]: publicPin("93.184.216.38"), [domainToASCII("\u03bf\u03c2")]: publicPin("93.184.216.39"),
  },
  steps: SPELLING_URLS.flatMap((url): Step[] => [{ url }, { url, purpose: "a2a" }, { url, config: 1 }]),
});

async function decideCases() {
  const out: unknown[] = [];
  for (const sc of DECIDE_SCENARIOS) {
    let config = 0;
    let answers = sc.answers;
    const lookups: string[] = [];
    const resolver = async (host: string): Promise<ResolvedAddress[]> => {
      lookups.push(host);
      const a = answers[host];
      if (a === undefined) throw Object.assign(new Error("no such host"), { code: "ENOTFOUND" });
      if ("error" in a) throw a.error === "" ? new Error("lookup failed without a code") : Object.assign(new Error("lookup failed"), { code: a.error });
      return a.addresses;
    };
    const egress = createEgress({ config: () => sc.configs[config] as EgressConfig, resolver, now: () => Date.UTC(2026, 10, 18, 5) });
    const steps: unknown[] = [];
    for (const step of sc.steps) {
      config = step.config ?? 0;
      answers = step.answers ? { ...sc.answers, ...step.answers } : sc.answers;
      lookups.length = 0;
      const result = await egress.decide(step.url, step.purpose ? { purpose: step.purpose } : undefined);
      steps.push({ ...step, result, lookups: [...lookups], status: egress.status(), ...(nonAscii(step.url) ? { note: IDNA_NOTE } : {}) });
    }
    out.push({ name: sc.name, configs: sc.configs, answers: sc.answers, steps });
  }
  return out;
}

// --- model downloads ------------------------------------------------------------------------------------------------------------
const ARTIFACT = "https://huggingface.co/intfloat/multilingual-e5-small/resolve/614241f622f53c4eeff9890bdc4f31cfecc418b3/config.json";
type Req = { url: string; method?: string; headers?: [string, string][]; body?: string };
const REQUESTS: Req[] = [
  { url: ARTIFACT }, { url: ARTIFACT, method: "HEAD", headers: [["range", "bytes=0-5"]] }, { url: ARTIFACT + "?text=private" }, { url: ARTIFACT + "?" }, { url: ARTIFACT + "#frag" },
  { url: ARTIFACT, headers: [["authorization", "Bearer x"]] }, { url: ARTIFACT, headers: [["x-api-key", "k"]] }, { url: ARTIFACT, headers: [["Accept", "*/*"], ["User-Agent", "t"]] },
  { url: ARTIFACT, method: "POST", body: "private" }, { url: ARTIFACT, method: "get" }, { url: ARTIFACT, method: "PUT" }, { url: "https://huggingface.co/api/inference" },
  { url: "https://attacker.example/model.onnx" }, { url: "https://HuggingFace.co/a/b/resolve/main/model.onnx" }, { url: "https://huggingface.co./a/b/resolve/main/model.onnx" },
  { url: "https://huggingface.co:443/a/b/resolve/main/model.onnx" }, { url: "https://huggingface.co:8443/a/b/resolve/main/model.onnx" }, { url: "http://huggingface.co/a/b/resolve/main/model.onnx" },
  { url: "https://u:p@huggingface.co/a/b/resolve/main/model.onnx" }, { url: "https://huggingface.co/a/b/resolve/main/onnx/model.onnx_data" }, { url: "https://huggingface.co/a/b/resolve/main/sub/dir/tokenizer.model" },
  { url: "https://huggingface.co/a/b/resolve/main/model.bin" }, { url: "https://huggingface.co/a/b/resolve/main/../model.onnx" }, { url: "https://huggingface.co/a/b/resolve/main/./model.onnx" },
  { url: "https://huggingface.co/a/b/resolve/main/%2e%2e/model.onnx" }, { url: "https://huggingface.co/a/b/resolve/main/x%2Fy.json" }, { url: "https://huggingface.co/a/b/resolve/main/.json" },
  { url: "https://huggingface.co/a/b/resolve/main/a..b.json" }, { url: "https://huggingface.co/a/b/resolve/main//x.json" }, { url: "https://huggingface.co/a/b/blob/main/x.json" },
  { url: "https://huggingface.co/a/b/resolve/main/x.json/" }, { url: "https://us.aws.cdn.hf.co/a/b/resolve/main/x.json" }, { url: "https://huggingface.co/a/b/resolve/main/x.JSON" },
  { url: "https://huggingface.co\\a\\b\\resolve\\main\\x.json" }, { url: "https://huggingface.co/a b/c/resolve/main/x.json" }, { url: "https://huggingface.co/ä/b/resolve/main/x.json" },
  // The catalogue host in spellings the URL host parser maps onto it (review A of K2), and paths the URL parser rewrites.
  { url: "https://\uff48uggingface.co/a/b/resolve/main/x.json" }, { url: "https://huggingface\u3002co/a/b/resolve/main/x.json" }, { url: "https://huggingface.co\u00ad/a/b/resolve/main/x.json" },
  { url: "https://HUGGINGFACE.CO/a/b/resolve/main/x.json" }, { url: "https://hugging%66ace.co/a/b/resolve/main/x.json" }, { url: "https://huggingface.co\u3002/a/b/resolve/main/x.json" },
  { url: "https://huggingface.c\u03bf/a/b/resolve/main/x.json" }, { url: "https://xn--huggingface-.co/a/b/resolve/main/x.json" },
  { url: "https:huggingface.co/a/b/resolve/main/x.json" }, { url: "https:/huggingface.co/a/b/resolve/main/x.json" }, { url: " https://huggingface.co/a/b/resolve/main/x.json\n" },
  { url: "https://huggingface.co/a/b/re\tsolve/main/x.json" }, { url: "https://huggingface.co/a/b/resolve/main/x.json#" }, { url: "https://huggingface.co/a/b/resolve/main/x.json?#" },
  { url: "https://huggingface.co//a/b/resolve/main/x.json" }, { url: "https://huggingface.co/a/b/resolve/main/%2E/x.json" }, { url: "https://huggingface.co/a/b/resolve/main/x/%2e%2E/y.json" },
  { url: "https://huggingface.co/a/b/resolve/main/x.json\\" }, { url: "https://huggingface.co/a/b/resolve/main/x%2ejson" }, { url: "https://huggingface.co/a/b/resolve/main/x\u00e9.json" },
  { url: "https://huggingface.co\\@evil.example/a/b/resolve/main/x.json" }, { url: "https://evil.example\\@huggingface.co/a/b/resolve/main/x.json" }, { url: "https://huggingface.co:/a/b/resolve/main/x.json" },
];
const MODEL_CONFIGS: unknown[] = [
  { allowHosts: ["*"], allowPorts: [443], allowLoopback: false },
  { allowHosts: [], allowPorts: [443], allowLoopback: false, modelDownloads: { enabled: true, allowHosts: ["huggingface.co"] } },
  { allowHosts: [], allowPorts: [443], allowLoopback: false, modelDownloads: { enabled: true, allowHosts: [] } },
  { allowHosts: [], allowPorts: [443], allowLoopback: false, modelDownloads: { enabled: false, allowHosts: ["huggingface.co"] } },
  { allowHosts: [], allowPorts: [443], allowLoopback: false, modelDownloads: { enabled: true, allowHosts: ["*"] } },
  { allowHosts: [], allowPorts: [443], allowLoopback: false, modelDownloads: { enabled: "true", allowHosts: ["huggingface.co"] } },
  { allowHosts: [], allowPorts: [443], allowLoopback: false, modelDownloads: { enabled: true } },
  { allowHosts: [], allowPorts: [443], allowLoopback: false, modelDownloads: { enabled: true, allowHosts: "huggingface.co" } },
  { allowHosts: [], allowPorts: [443], allowLoopback: false, modelDownloads: { enabled: true, allowHosts: ["HuggingFace.co"] } },
  { allowHosts: [], allowPorts: [443], allowLoopback: false, modelDownloads: { enabled: true, allowHosts: ["us.aws.cdn.hf.co", "huggingface.co"] } },
  { allowHosts: [], allowPorts: [443], allowLoopback: false, modelDownloads: null },
];

function modelCases() {
  const requests = REQUESTS.map((r) => {
    let request: Request;
    try { request = new Request(r.url, { method: r.method ?? "GET", headers: r.headers ?? [], ...(r.body !== undefined ? { body: r.body } : {}) }); }
    catch (e) { return { ...r, requestError: (e as Error).name }; }
    return { ...r, method: request.method, pathname: new URL(request.url).pathname, artifact: isModelArtifactRequest(request), ...(nonAscii(r.url) ? { note: "the WHATWG path serialiser percent-encodes non-ASCII" } : {}) };
  });
  const policies = MODEL_CONFIGS.map((config) => {
    try {
      const derived = modelDownloadPolicy(config as EgressConfig);
      return { config, derived, policy: compiled(derived) };
    } catch (e) { return { config, error: (e as Error).name }; }
  });
  return { hosts: MODEL_DOWNLOAD_HOSTS, requests, policies };
}

// --- what `new URL` reads from hostile URLs ---------------------------------------------------------------------------------------
// The gate judges what its URL reader hands it, so the reader has to read as `new URL` does. `urls` records Node's reading of
// URLs built to be misread: `classes` names what review A of K2 found and what the mapping onto the gate's fields can get
// wrong, `corpus` is a generated set (mulberry32, fixed seed) over hostile schemes, separators, userinfo, hosts, ports and
// tails. A row is the JSON text of `[url]` where `new URL` throws and of `[url, protocol, username, password, hostname, port]`
// where it reads; kept as text so that a row is one line of the file.
//
// K2-D4 in this set: Node keeps an `xn--` label it cannot decode (`domainToUnicode` hands it back unchanged) and the Rust host
// parser refuses it. Such a row ends with the marker, and the replay then requires the refusal.
const URL_CLASSES: Record<string, string[]> = {
  "a sign in an IPv4 part": ["https://+1.2.3.4/", "https://1.+2.3.4/", "https://%2b1.2.3.4/", "http://+127.0.0.1/", "http://+127.1/", "http://0x+7f.1/", "https://0x+1020304/", "https://+16909060/", "https://1.2.3.+4/", "https://-1.2.3.4/", "https://1.2.3.-4/"],
  "white space after an address": ["https://1.2.3.4\u00a0/", "https://1.2.3.4\u3000/", "https://1.2.3.4\u2028/", "https://1.2.3.4\u2029/", "https://1.2.3.4\u1680/", "https://1.2.3.4\u2003/", "https://1.2.3.4\u202f/", "https://1.2.3.4\u205f/", "http://127.0.0.1\u00a0/", "https://1.2.3.4 /"],
  "percent-encoded white space after an address": ["https://1.2.3.4%C2%A0/", "https://1.2.3.4%E3%80%80/", "http://127.0.0.1%C2%A0/", "https://1.2.3.4%20/", "https://1.2.3.4%E2%80%A8/", "https://1.2.3.4%09/"],
  "white space before or inside a host": ["https://\u00a01.2.3.4/", "https://%C2%A01.2.3.4/", "https://1.2.\u30003.4/", "https://example.com\u00a0/", "https://exam\u3000ple.com/", "https://\u2003example.com/", "https://example%E3%80%80.com/"],
  "a byte order mark in a host": ["https://1.2.3.4\ufeff/", "http://127.0.0.1\ufeff/", "https://\ufeff1.2.3.4/", "https://example\ufeff.com/", "https://1.2.3.4%EF%BB%BF/", "https://\ufeff/"],
  "a capital sigma at the end of a label": ["https://\u039f\u03a3-shop.example/", "https://\u03bf\u03c3-shop.example/", "https://\u03bf\u03c2-shop.example/", "https://example.\u039f\u03a3/", "https://example.\u03bf\u03c3/", "https://example.\u03bf\u03c2/", "https://\u039f\u03a3/", "https://\u03a3/", "https://\u039f\u03a3.\u039f\u03a3/"],
  "mapped digits and ignored characters in an address": ["https://\uff11.2.3.4/", "https://1.2.3.\uff14/", "https://\uff11\uff12\uff17\u3002\uff10\u3002\uff10\u3002\uff11/", "https://1\u200b.2.3.4/", "https://\u00ad1.2.3.4/", "https://\u00ad0X7f.1/", "https://\u2460.example/", "https://\u0661.2.3.4/", "https://\uff10x7f.1/"],
  "dots that are not U+002E": ["https://ex\u3002ample\uff0ecom\uff61/", "https://1\u30022\u30023\u30024/", "https://a\u3002\u3002b/", "https://1\u20242\u20243\u20244/", "https://example\uff0ecom/", "https://127\uff610\uff610\uff611/"],
  "an xn-- label": ["https://xn--zz.example/", "https://xn--a.example/", "https://xn--/", "https://xn--.example/", "https://xn--bcher-kva.example/", "https://XN--BCHER-KVA.example/", "https://xn--fa-hia.example/", "ftp://xn--zz.example/", "custom://xn--zz.example/"],
  "schemes that are not special": ["custom://host:443\\x", "data://a\"b:443\\x", "blob://example.com:65535\\x", "about://127.1:8080\\x", "javascript://localhost.example.com:\\x", "custom://Host:5/x", "custom://host:443/\\x", "custom://ho\\st/", "mailto:a@b", "data:text/plain,hi", "custom:", "custom:/x", "custom://", "gopher://example.com:70/", "ht+tp://a.example:443?q", "custom://[::1]:9#f", "custom://%41.example/"],
  "the file scheme": ["file:///etc/passwd", "file://localhost/x", "file://host.example/x", "file:x", "file://+1.2.3.4/x", "file://1.2.3.4\u00a0/x", "file:///", "file://"],
  "userinfo": ["https://user:pw@example.com/", "https://a%40b:c%3Ad@example.com/", "https://\u00fc@example.com/", "https://a b@example.com/", "https://:@example.com/", "https://@example.com/", "https://a:b:c@example.com/", "https://u\\@example.com/", "https://a@b@example.com/", "https://user:@example.com/", "https://:pw@example.com/", "https://us'er:p\"w@example.com/", "https://%00@example.com/"],
  "ports": ["https://example.com:443/", "http://example.com:80/", "https://example.com:80/", "http://example.com:443/", "ws://example.com:80/", "wss://example.com:443/", "ftp://example.com:21/", "https://example.com:0443/", "https://example.com:65535/", "https://example.com:65536/", "https://example.com:/", "https://example.com:+443/", "https://example.com:0/", "https://example.com:\uff14\uff14\uff13/", "https://example.com:44 3/"],
  "IPv6 literals": ["https://[::1]/", "https://[0:0:0:0:0:0:0:1]:8443/", "https://[::ffff:127.0.0.1]/", "https://[2001:db8:0:0:1:0:0:1]/", "https://[::1", "https://[fe80::1%25eth0]/", "https://[::FFFF:1.2.3.4]/", "https://[::1]x/", "https://[1.2.3.4]/", "https://[\u00e9]/"],
  "empty and dotted hosts": ["https://", "https:///x", "https://./", "https://../", "https://a..b/", "https://.a/", "https://a./", "https://a../", "https://%2e/", "https://\u3002/"],
};

function corpusUrls(count: number): string[] {
  let seed = 20261118 >>> 0;
  const rnd = (): number => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = <T,>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]!;
  const chance = (p: number): boolean => rnd() < p;
  const SCHEMES = ["https", "https", "https", "https", "https", "https", "http", "http", "http", "HTTPS", "hTtP", "ws", "wss", "ftp", "file", "custom", "javascript", "data", "h\tttps", "https\n", "", "1http", "ht+tp", "blob", "about", "http s", "https\u00a0"];
  const SEPS = ["://", "://", "://", "://", "://", "://", "://", ":/", ":", ":\\\\", ":/\\", ":///", "://///", ":\\/", "::", ":/\t/", ":\n//"];
  const USER = ["", "", "", "", "", "", "", "", "user@", "user:pw@", ":@", "@", "a@b@", "a:b:c@", "%40@", "u\\@", "user:@", ":pw@", "@@", "a b@", "\u00fc@", "\t@", "%00@", ":%20@", "a/b@", "a?b@", "a#b@"];
  const NAMES = [
    "example.com", "EXAMPLE.com", "example.com.", "example.com..", ".example.com", "a..b", "localhost", "LOCALHOST", "localhost.", "foo.localhost", "foo.localhost.", "localhost.example.com",
    "sub.example.org", "example.org", "deep.sub.example.org", "xexample.org", "example.orgx", "priv.example.org", "loop.example.org", "mixed.example.org", "nx.example.org", "empty.example.org", "tail.example.org", "meta.example.org",
    "xn--bcher-kva.example", "b\u00fccher.example", "B\u00dcCHER.example", "\u039f\u03a3.example", "\u03bf\u03c3.example", "\u03bf\u03c2.example", "stra\u00dfe.de", "STRASSE.de", "\u1e9e.de", "fa\u00df.de", "\u0130stanbul.tr", "\u0131.tr", "\ufb01.example", "\u3392.example",
    "a\u200db.example", "a\u200cb.example", "a\u00adb.example", "ex\u3002ample\uff0ecom\uff61", "\uff11\uff12\uff17\u3002\uff10\u3002\uff10\u3002\uff11", "\u2460.example", "xn--zz.example", "xn--a.example", "xn--", "xn--.example", "XN--BCHER-KVA.example",
    "a_b.example", "-a.example", "a-.example", "a--b.example", "ab--c.example", "a".repeat(63) + ".example", "a".repeat(64) + ".example", ("a".repeat(60) + ".").repeat(4) + "com", ("a".repeat(62) + ".").repeat(4) + "com", "a.".repeat(130) + "b", "x".repeat(300),
    "%65xample.com", "%2565xample.com", "ex%61mple.com", "%E4%BD%A0.example", "%ff.example", "%00.example", "ex%2Fample", "a%40b", "a%3Ab", "a%23b", "a%3fb", "a%5Cb", "a%20b", "a%09b", "%31%32%37.0.0.1", "%6c%6f%63%61%6c%68%6f%73%74", "a%", "a%4", "%",
    "0x7f.1", "0x7F.0.0.1", "0177.0.0.1", "017700000001", "2130706433", "127.1", "127.0.1", "127.0.0.1", "1.2.3.4", "01.02.03.04", "1.2.3.4.", "1.2.3.4..", "1.2.3.4.5", "256.1.1.1", "1.2.3.256", "0x.0x.0x.0x", "0x", "0xg", "1.2.3.0x", "1.0x", "foo.0x", "a.0x10",
    "example.0X1F", "4294967295", "4294967296", "0xffffffff", "0x100000000", "1.16777215", "1.16777216", "00000000000000000001.2.3.4", "+1.2.3.4", "1.+2.3.4", "-1.2.3.4", "1.2.3.-4", "0x+1.2", "0+7.1", "+127.0.0.1", "127.+0.0.1", "0x+7f.0.0.1", "1e3", "1.2.3.4e0",
    "\uff11.2.3.4", "1.2.3.\uff14", "1.2.3.4\u3000", "1.2.3.4\u00a0", "\u00a01.2.3.4", "1.2.3.4\ufeff", "127.0.0.1\u2028", "127.0.0.1\u00a0", "1.2.3", "1..2", "..", ".", "...", "1.", ".1", "09.1.1.1", "08", "0008", "1.2.3.08", "10.0.0.1", "100.64.0.1", "100.100.100.200", "169.254.169.254", "0", "0.0.0.0", "255.255.255.255",
    "[::1]", "[::]", "[0:0:0:0:0:0:0:1]", "[::ffff:127.0.0.1]", "[::ffff:7f00:1]", "[::127.0.0.1]", "[64:ff9b::7f00:1]", "[2002:7f00:1::]", "[fe80::1%25eth0]", "[fe80::1%eth0]", "[::1", "::1]", "[::1]x", "[[::1]]", "[::1]]", "[]", "[", "]", "[:]", "[:::]",
    "[1:2:3:4:5:6:7:8]", "[1:2:3:4:5:6:7:8:9]", "[1:2:3:4:5:6:7::]", "[::2:3:4:5:6:7:8]", "[1::8]", "[1:2:3:4:5:6:1.2.3.4]", "[::1.2.3.4]", "[::01.2.3.4]", "[::1.2.3]", "[::1.2.3.4.5]", "[::1.2.3.256]", "[1.2.3.4]", "[::FFFF:1.2.3.4]", "[2001:DB8::1]", "[2001:db8::1]",
    "[2001:db8:0:0:1:0:0:1]", "[0:0:0:0:0:0:0:0]", "[::0]", "[0::0]", "[00000::1]", "[::12345]", "[g::1]", "[::1 ]", "[ ::1]", "[::1%]", "[v1.x]", "[::ffff:0x7f.0.0.1]", "[::ffff:127.1]", "[::%31]", "[%3A%3A1]", "[::\uff11]", "[::1]\u00e9", "[\u00e9", "[\u00e9]", "[::1\u00e9]", "[fd7a:115c:a1e0::9]",
    "exa\x00mple.com", "exa\x01mple", "exa\x7fmple", "exa mple.com", "exa\tmple.com", "exa\nmple.com", "exa\rmple", "exa\x0bmple", "exa\x0cmple", "a<b", "a>b", "a^b", "a|b", "a`b", "a{b", "a}b", "a\"b", "a'b", "a!b", "a$b", "a&b", "a(b", "a)b", "a*b", "a+b", "a,b", "a;b", "a=b", "a~b", "a[b", "a]b", "",
    " ", "\u00a0", "\ufeff", "\u200b", "\ufffd.example", "\ud83d\ude00.example", "e\u0301.example", "\u00e9.example", "a.\u0308b.example", "\u0661.example", "\u06f1.2.3.4", "a\uff0fb", "a\uff20b", "a\uff1ab", "a\uff05b", "a\uff03b", "a\uff1fb", "a\uff3cb", "\u2100.example", "\u2488.example", "a\u2024b", "1\u20242\u20243\u20244", "a\u3002\u3002b",
  ];
  const PORTS = ["", "", "", "", "", "", "", "", ":", ":443", ":443", ":80", ":8080", ":0", ":00443", ":65535", ":65536", ":99999999999999999999", ":-1", ":+443", ":4 43", ":443x", ":x", "::443", ":443:80", ":\t443", ":\uff14\uff14\uff13", ":0x1bb", ":1e2", ": 443", ":" + "0".repeat(30) + "443", ":4\n43", ":8443", ":21"];
  const PATHS = ["", "", "/", "/", "/a?b#c", "?q", "#f", "\\x", "/@evil.com", "/:80", "?@x", "#@x", "\\@x.com", "/..", "/%2e%2e"];
  const EVIL = ["\t", "\n", "\r", " ", "\x00", "\x0b", "\x0c", "\x1f", "\x7f", "\u00a0", "\u3000", "\ufeff", "\u2028", "\u200b", "\u00ad", "%", "%2", "%25", "%2e", "%00", "@", ":", "/", "\\", "?", "#", "[", "]", ".", "..", "\u3002", "\uff0e", "\uff61", "+", "-", "_", "*", "0x", "0", "8", "\u0130", "\u03a3", "\u00df", "\u1e9e", "\ufffd", "\ud83d\ude00", "A", "Z", "x", "e"];
  const flipCase = (s: string): string => Array.from(s).map((c) => (chance(0.5) ? c.toUpperCase() : c.toLowerCase())).join("");
  const pct = (s: string): string => { const cs = Array.from(s); if (cs.length === 0) return s; const i = Math.floor(rnd() * cs.length); const c = cs[i]!; if (c.charCodeAt(0) > 0x7f || c.length > 1) return s; cs[i] = "%" + c.charCodeAt(0).toString(16).padStart(2, "0"); return cs.join(""); };
  const mutate = (s: string): string => { const cs = Array.from(s); const i = Math.floor(rnd() * (cs.length + 1)); const k = rnd(); if (k < 0.5) cs.splice(i, 0, pick(EVIL)); else if (k < 0.8 && cs.length > 0) cs.splice(Math.min(i, cs.length - 1), 1, pick(EVIL)); else if (cs.length > 0) cs.splice(Math.min(i, cs.length - 1), 1); return cs.join(""); };
  function host(): string {
    let h = pick(NAMES);
    if (chance(0.15)) h = flipCase(h);
    if (chance(0.15)) h = pct(h);
    if (chance(0.25)) h = mutate(h);
    if (chance(0.05)) h = mutate(h);
    return h;
  }
  function url(): string {
    let u = pick(SCHEMES) + pick(SEPS) + pick(USER) + host() + pick(PORTS) + pick(PATHS);
    if (chance(0.05)) u = pick([" ", "\t", "\n", "\x00", "\x1f", "\u00a0", "\ufeff"]) + u;
    if (chance(0.05)) u = u + pick([" ", "\t", "\n", "\x00", "\x1f", "\u00a0", "\ufeff"]);
    if (chance(0.05)) u = mutate(u);
    return u;
  }
  const out = NAMES.flatMap((n) => ["https://" + n + "/", "http://" + n + ":8080/x", "https://u@" + n + "/"]);
  while (out.length < count) out.push(url());
  return out;
}

const SPECIAL = ["http:", "https:", "ws:", "wss:", "ftp:"];
/** One row: the URL alone where `new URL` throws, else the five members the gate reads, and the K2-D4 marker. */
function urlRow(raw: string): string {
  let u: URL;
  try { u = new URL(raw); } catch { return JSON.stringify([raw]); }
  const undecoded = SPECIAL.includes(u.protocol) && u.hostname.split(".").some((label) => label.startsWith("xn--") && domainToUnicode(label) === label);
  return JSON.stringify([raw, u.protocol, u.username, u.password, u.hostname, u.port, ...(undecoded ? ["K2-D4"] : [])]);
}

function urlCases() {
  const seen = new Set<string>(Object.values(URL_CLASSES).flat());
  if (seen.size !== Object.values(URL_CLASSES).flat().length) throw new Error("a URL is in two classes");
  const corpus: string[] = [];
  // A lone surrogate cannot be written to the fixture as text a Rust string holds.
  for (const raw of corpusUrls(3600)) if (raw.isWellFormed() && !seen.has(raw)) { seen.add(raw); corpus.push(urlRow(raw)); }
  return {
    columns: ["url", "protocol", "username", "password", "hostname", "port", "divergence"],
    classes: Object.fromEntries(Object.entries(URL_CLASSES).map(([name, urls]) => [name, urls.map(urlRow)])),
    corpus,
  };
}

export async function buildEgressVectors() {
  return { policy: policyCases(), gate: gateCases(), decide: await decideCases(), model: modelCases(), urls: urlCases() };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await exporterMain({ area: "egress", build: buildEgressVectors });
}
