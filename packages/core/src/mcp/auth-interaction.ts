/** M-A8: reuse the login ladder for MCP UI interaction, leaving state, PKCE and token exchange with the provider. */
import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import type { AuthorizationServerMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import { AuthorizationPrompt, type DevicePrompt } from "../auth/login.ts";
import type { EnvSnapshot } from "../auth/env.ts";
import { planLogin, type LoginMethod, type LoginPlan } from "../auth/ladder.ts";
import type { AuthProfile } from "../auth/profile.ts";
import { MCP_AUTH_TIMEOUT_MS, McpAuthRequiredError } from "./auth.ts";

const MAX_CALLBACK_BYTES = 8192;
const CALLBACK_FAILURE_LIMIT = 32;

type CodeResponse = { code: string; state: string; issuer?: string };
type InteractionResponse = CodeResponse | { kind: "device_code" };

/** Host-owned presentation ports. Authorization URLs and user codes travel only through these explicit callbacks. */
export interface McpAuthInteractionOptions {
  env: EnvSnapshot;
  method?: LoginMethod;
  pasteCallback?: boolean;
  openBrowser?(url: string): Promise<void>;
  onAuthorization?(prompt: AuthorizationPrompt): Promise<void>;
  readCallback?(prompt: AuthorizationPrompt, signal: AbortSignal): Promise<string>;
  onDevice?(prompt: DevicePrompt): Promise<void>;
  now?: () => number;
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
}

/** The authorization step returns a callback or chooses device grant; it never fabricates a code for a device token. */
export interface McpAuthInteraction {
  plan(metadata: AuthorizationServerMetadata): LoginPlan;
  authorize(url: URL, metadata: AuthorizationServerMetadata, signal?: AbortSignal): Promise<InteractionResponse>;
  onDevice(prompt: DevicePrompt, signal: AbortSignal): Promise<void>;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  now?: () => number;
}

function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new McpAuthRequiredError());
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new McpAuthRequiredError()); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

function profile(metadata: AuthorizationServerMetadata): AuthProfile {
  const device = "device_authorization_endpoint" in metadata
    && typeof metadata.device_authorization_endpoint === "string"
    ? metadata.device_authorization_endpoint : undefined;
  return {
    id: "mcp", display_name: "MCP",
    kind: metadata.code_challenge_methods_supported?.includes("S256") ? "oauth_pkce" : "device_code",
    capabilities: ["chat"], auth_header_scheme: "Authorization: Bearer {token}",
    authorizeUrl: metadata.authorization_endpoint!, tokenUrl: metadata.token_endpoint!,
    ...(device ? { deviceUrl: device } : {}),
    policy_status: "allowed", policy_source: "M-A8", policy_checked: "2026-10-28",
  };
}

function readCode(raw: string, authorize: URL): CodeResponse {
  if (Buffer.byteLength(raw, "utf8") > MAX_CALLBACK_BYTES) throw new McpAuthRequiredError();
  const callback = new URL(raw);
  const redirect = new URL(authorize.searchParams.get("redirect_uri")!);
  if (callback.username || callback.password || callback.hash || callback.origin !== redirect.origin
    || callback.pathname !== redirect.pathname || callback.searchParams.has("error")) throw new McpAuthRequiredError();
  const states = callback.searchParams.getAll("state"), codes = callback.searchParams.getAll("code");
  const issuers = callback.searchParams.getAll("iss");
  const digest = (value: string) => createHash("sha256").update(value).digest();
  if (states.length !== 1 || !timingSafeEqual(digest(states[0]!), digest(authorize.searchParams.get("state")!))
    || codes.length !== 1 || !codes[0] || issuers.length > 1 || issuers.length === 1 && !issuers[0]) {
    throw new McpAuthRequiredError();
  }
  return { code: codes[0], state: states[0]!, ...(issuers.length ? { issuer: issuers[0]! } : {}) };
}

async function loopback(authorize: URL, method: LoginMethod, plan: LoginPlan,
  o: McpAuthInteractionOptions, signal: AbortSignal): Promise<CodeResponse> {
  const redirect = new URL(authorize.searchParams.get("redirect_uri")!);
  if (redirect.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(redirect.hostname)
    || !redirect.port || redirect.search || redirect.hash || redirect.username || redirect.password) {
    throw new McpAuthRequiredError();
  }
  let accept!: (response: CodeResponse) => void;
  const callback = new Promise<CodeResponse>(resolve => { accept = resolve; });
  let consumed = false, failures = 0;
  const server = createServer((request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-security-policy", "default-src 'none'");
    response.setHeader("referrer-policy", "no-referrer");
    if (consumed) { response.writeHead(410).end(); return; }
    try {
      if (request.method !== "GET" || request.headers.host !== redirect.host) throw new McpAuthRequiredError();
      const code = readCode(new URL(request.url ?? "/", redirect).href, authorize);
      consumed = true;
      response.writeHead(200).end("Sign-in complete. You may close this window.", () => accept(code));
    } catch {
      response.writeHead(++failures > CALLBACK_FAILURE_LIMIT ? 429 : 400).end("Sign-in callback refused.");
    }
  });
  try {
    await bounded(new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(Number(redirect.port), redirect.hostname.replace(/^\[|\]$/g, ""), resolve);
    }), signal);
    const prompt = new AuthorizationPrompt(authorize.href, redirect.href,
      method === "loopback_ssh" ? plan.sshHint?.(Number(redirect.port)) : undefined);
    const ui = Promise.resolve().then(async () => {
      if (method === "loopback_pkce") {
        if (!o.openBrowser) throw new McpAuthRequiredError();
        await o.openBrowser(prompt.authorizationUrl);
      } else {
        if (!o.onAuthorization) throw new McpAuthRequiredError();
        await o.onAuthorization(prompt);
      }
      return callback;
    });
    return await bounded(Promise.race([callback, ui]), signal);
  } finally {
    consumed = true;
    server.closeAllConnections();
    server.close();
  }
}

/** Select an explicit ladder step. A declined, cancelled or invalid callback never silently starts another login. */
export function createMcpAuthInteraction(o: McpAuthInteractionOptions): McpAuthInteraction {
  const plan = (metadata: AuthorizationServerMetadata) => planLogin(profile(metadata), o.env,
    o.pasteCallback === undefined ? {} : { pasteCallback: o.pasteCallback });
  return {
    plan,
    ...(o.now ? { now: o.now } : {}),
    sleep: (ms, signal) => bounded((o.sleep ?? sleep)(ms, signal), signal),
    onDevice: async (prompt, signal) => {
      if (!o.onDevice) throw new McpAuthRequiredError();
      try { await bounded(o.onDevice(prompt), signal); } catch { throw new McpAuthRequiredError(); }
    },
    async authorize(url, metadata, signal) {
      const deadline = AbortSignal.any([AbortSignal.timeout(MCP_AUTH_TIMEOUT_MS), ...(signal ? [signal] : [])]);
      try {
        if (deadline.aborted) throw new McpAuthRequiredError();
        const current = plan(metadata), method = o.method ?? current.method;
        if (![current.method, ...current.fallbacks].includes(method)) throw new McpAuthRequiredError();
        if (method === "device_code") {
          if (!o.onDevice || !("device_authorization_endpoint" in metadata)
            || typeof metadata.device_authorization_endpoint !== "string") throw new McpAuthRequiredError();
          return { kind: "device_code" };
        }
        if (method === "paste_callback") {
          if (!o.readCallback) throw new McpAuthRequiredError();
          const prompt = new AuthorizationPrompt(url.href, url.searchParams.get("redirect_uri")!);
          await bounded(o.onAuthorization?.(prompt) ?? Promise.resolve(), deadline);
          return readCode(await bounded(o.readCallback(prompt, deadline), deadline), url);
        }
        return await loopback(url, method, current, o, deadline);
      } catch { throw new McpAuthRequiredError(); }
    },
  };
}
