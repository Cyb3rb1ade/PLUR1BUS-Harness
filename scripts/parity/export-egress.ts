// Parity vectors (mode V) for the egress package (P4-K K2, plan P4-21): the compiled policy and `hostAllowed`, the per-hop
// gate (`beforeResolve`, `afterResolve`) over URLs as `new URL` reads them, the dry run of the service (`decide`) over a
// scripted resolver with the names it looked up and the counters of `status`, and the model-download exception
// (`isModelArtifactRequest` over real `Request` objects, `modelDownloadPolicy`). `crates/plur1bus-core/src/egress/vectors.rs`
// replays every case. Recorded, never edited by hand.
//
// The address classification itself (`tools/web/ip.ts`) is pinned by the shared vector file
// `packages/core/test/fixtures/net/ip-classification-vectors.json`, which the Rust replay reads as well.
//
// What the vectors cannot hold: `request` (the guarded HTTP client belongs to the web tools of P4-30), and configuration
// values JSON cannot carry (`NaN`, `Infinity`, a non-JSON object): the live configuration is JSON.
//
//   node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning scripts/parity/export-egress.ts [--check]
import { fileURLToPath } from "node:url";
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

export async function buildEgressVectors() {
  return { policy: policyCases(), gate: gateCases(), decide: await decideCases(), model: modelCases() };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await exporterMain({ area: "egress", build: buildEgressVectors });
}
