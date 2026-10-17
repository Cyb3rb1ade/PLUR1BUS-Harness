// The offline fixture server: serves the corpus manifest from loopback and nothing else. No fixture ever needs the
// network; the web.fetch under test reaches this server only because the test allowlists 127.0.0.0/8 for it.
import { readFileSync } from "node:fs";
import http from "node:http";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { startStub, type Stub } from "../helpers.ts";
import { GENERATED_BINARY, gzipBomb, longLine, manual500, plainBytes } from "./generators.ts";

export const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/web-fetch");
/** The clock every corpus run uses, so Retry-After dates and fetchedAt are exact. */
export const FIXED_NOW = Date.parse("2026-10-16T12:00:00Z");

export interface ResponseSpec {
  status?: number;
  type?: string;
  noContentType?: boolean;
  headers?: Record<string, string>;
  file?: string;
  encoding?: "gzip" | "br" | "deflate";
  kind?: "generated" | "redirect" | "loop" | "chain" | "stall" | "stall-body" | "reset" | "corrupt-gzip" | "tls" | "none";
  name?: string;
  bytes?: number;
  location?: string;
  hops?: number;
  robots?: string | number;
}

export interface CorpusCase {
  id: string;
  category: string;
  note: string;
  expect: "ok" | "fail" | "generated-ok";
  response: ResponseSpec & { robots?: string | number };
  chain?: Array<{ path: string; status: number; location: string }>;
  golden: string;
  request?: { path?: string; url?: string; args?: Record<string, unknown> };
  config?: Record<string, unknown>;
  strict?: boolean;
  special?: string;
  meta?: Record<string, string>;
  mustNotContain?: string[];
  rawText?: boolean;
  expectFinalPath?: string;
}

export const loadManifest = (): CorpusCase[] => (JSON.parse(readFileSync(join(FIXTURE_DIR, "corpus.json"), "utf8")) as { cases: CorpusCase[] }).cases;
export const readFixture = (rel: string): Buffer => readFileSync(join(FIXTURE_DIR, rel));

const cache = new Map<string, Buffer>();
function generated(name: string, spec: ResponseSpec): { body: Buffer; encoding?: string } {
  const key = `${name}:${spec.bytes ?? ""}`;
  const hit = cache.get(key);
  const done = (b: Buffer, encoding?: string) => {
    cache.set(key, b);
    return { body: b, ...(encoding ? { encoding } : {}) };
  };
  if (name === "manual-500") return hit ? { body: hit } : done(Buffer.from(manual500().html));
  if (name === "long-line") return hit ? { body: hit } : done(Buffer.from(longLine().html));
  if (name === "bytes") return hit ? { body: hit } : done(plainBytes(spec.bytes!));
  if (name === "gzip-bomb") return hit ? { body: hit, encoding: "gzip" } : done(gzipBomb(spec.bytes!), "gzip");
  const gen = GENERATED_BINARY[name];
  if (!gen) throw new Error(`unknown generator ${name}`);
  return { body: hit ?? done(gen()).body };
}

function compress(body: Buffer, enc: string | undefined): Buffer {
  if (enc === "gzip") return gzipSync(body);
  if (enc === "br") return brotliCompressSync(body);
  if (enc === "deflate") return deflateSync(body);
  return body;
}

export interface CorpusServer {
  base: string;
  stub: Stub;
  close(): Promise<void>;
}

/** `robots`: what /robots.txt answers (text, or a status number). Default 404 (no rules). */
export async function startCorpusServer(cases: CorpusCase[], opts: { robots?: string | number } = {}): Promise<CorpusServer> {
  const routes = new Map<string, (req: http.IncomingMessage, res: http.ServerResponse) => void>();
  const send = (res: http.ServerResponse, spec: ResponseSpec): void => {
    const headers: Record<string, string> = { ...(spec.headers ?? {}) };
    for (const [k, v] of Object.entries(headers)) {
      const m = /^@\+(\d+)s$/.exec(v);
      if (m) headers[k] = new Date(FIXED_NOW + Number(m[1]) * 1000).toUTCString();
    }
    let body: Buffer;
    let encoding = spec.encoding as string | undefined;
    if (spec.kind === "generated") {
      const g = generated(spec.name!, spec);
      body = g.body;
      encoding = g.encoding ?? encoding;
      if (g.encoding) headers["content-encoding"] = g.encoding;
      else if (encoding) {
        body = compress(body, encoding);
        headers["content-encoding"] = encoding;
      }
    } else {
      body = spec.file ? readFixture(spec.file) : Buffer.alloc(0);
      if (encoding) {
        body = compress(body, encoding);
        headers["content-encoding"] = encoding;
      }
    }
    if (!spec.noContentType && spec.type) headers["content-type"] = spec.type;
    res.writeHead(spec.status ?? 200, headers);
    res.end(body);
  };

  for (const c of cases) {
    const r = c.response;
    const route = `/p/${c.id}`;
    switch (r.kind) {
      case "stall":
        routes.set(route, () => {});
        break;
      case "stall-body":
        routes.set(route, (_q, res) => {
          res.writeHead(200, { "content-type": "text/plain", "content-length": "100000" });
          res.write("partial body ");
        });
        break;
      case "reset":
        routes.set(route, (req) => req.socket.destroy());
        break;
      case "corrupt-gzip":
        routes.set(route, (_q, res) => {
          res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
          res.end(Buffer.concat([Buffer.from([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 3]), Buffer.from("this is not a deflate stream at all")]));
        });
        break;
      case "redirect":
        routes.set(route, (_q, res) => res.writeHead(r.status ?? 302, { location: r.location! }).end());
        break;
      case "loop":
        routes.set(route, (_q, res) => res.writeHead(302, { location: `${route}/b` }).end());
        routes.set(`${route}/b`, (_q, res) => res.writeHead(302, { location: route }).end());
        break;
      case "chain": {
        const n = r.hops!;
        routes.set(route, (_q, res) => res.writeHead(302, { location: `${route}/1` }).end());
        for (let k = 1; k < n; k++) routes.set(`${route}/${k}`, (_q, res) => res.writeHead(302, { location: `${route}/${k + 1}` }).end());
        routes.set(`${route}/${n}`, (_q, res) => res.writeHead(200, { "content-type": "text/plain" }).end("the end of the chain"));
        break;
      }
      case "tls":
      case "none":
        break;
      default:
        routes.set(route, (_q, res) => send(res, r));
    }
    for (const hop of c.chain ?? []) routes.set(hop.path, (_q, res) => res.writeHead(hop.status, { location: hop.location.replaceAll("{{BASE}}", baseRef.value) }).end());
  }

  const baseRef = { value: "" };
  const stub = await startStub((req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    if (path === "/robots.txt") {
      const rb = opts.robots;
      if (typeof rb === "number") return void res.writeHead(rb, { "content-type": "text/plain" }).end("unavailable");
      if (typeof rb === "string") return void res.writeHead(200, { "content-type": "text/plain" }).end(rb);
      return void res.writeHead(404).end();
    }
    const h = routes.get(path);
    if (!h) return void res.writeHead(404, { "content-type": "text/plain" }).end("no such fixture route");
    h(req, res);
  });
  baseRef.value = `http://127.0.0.1:${stub.port}`;
  return { base: baseRef.value, stub, close: () => stub.close() };
}
