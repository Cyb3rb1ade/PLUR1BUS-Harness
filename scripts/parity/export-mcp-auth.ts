import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { discoverMcpAuthChallenge, PkceAuthProvider } from "../../packages/core/src/mcp/auth.ts";
import type { McpAuthInteraction } from "../../packages/core/src/mcp/auth-interaction.ts";
import { createMcpFetch } from "../../packages/core/src/mcp/http.ts";
import { exporterMain } from "./lib.mjs";

const resourcePath = "/mcp";
const clientId = "fixture-public-client";
const redirectUri = "http://127.0.0.1:7081/callback";

async function record(mode: "pkce" | "device") {
  let origin = "";
  let now = 1_000;
  let authorized: URL | undefined;
  let polls = 0;
  const waits: number[] = [];
  const exchanges: Array<Record<string, unknown>> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const params = new URLSearchParams(Buffer.concat(chunks).toString());
    const path = request.url!;
    const grant = params.get("grant_type");
    let status = 200;
    let reply: Record<string, unknown>;
    if (path === "/.well-known/oauth-protected-resource/mcp") {
      reply = { resource: origin + resourcePath, authorization_servers: [origin + "/issuer"] };
    } else if (path === "/.well-known/oauth-authorization-server/issuer") {
      reply = {
        issuer: origin + "/issuer", authorization_endpoint: origin + "/authorize",
        token_endpoint: origin + "/token", device_authorization_endpoint: origin + "/device",
        response_types_supported: ["code"], code_challenge_methods_supported: ["S256"],
        authorization_response_iss_parameter_supported: true,
      };
    } else if (path === "/device") {
      reply = { device_code: "<fixture-device>", user_code: "<fixture-user-code>", verification_uri: origin + "/verify", expires_in: 60, interval: 2 };
    } else if (grant === "urn:ietf:params:oauth:grant-type:device_code" && polls++ < 2) {
      status = 400; reply = { error: polls === 1 ? "authorization_pending" : "slow_down" };
    } else if (grant === "refresh_token") {
      reply = { token_type: "Bearer", access_token: "<fixture-renewed-access>", expires_in: 60 };
    } else {
      reply = { token_type: "Bearer", access_token: "<fixture-access>", refresh_token: "<fixture-refresh>", expires_in: mode === "pkce" ? 1 : 60 };
    }
    const verifier = params.get("code_verifier");
    if (verifier !== null) {
      if (createHash("sha256").update(verifier).digest("base64url") !== authorized?.searchParams.get("code_challenge")) {
        throw new Error("fixture verifier does not match its challenge");
      }
      params.set("code_verifier", "<verifier>");
    }
    if (params.has("resource")) params.set("resource", params.get("resource")!.replace(origin, "{origin}"));
    exchanges.push({
      request: { method: request.method, path, form: params.toString(),
        credentialHeaders: ["authorization", "proxy-authorization", "cookie"].filter(key => request.headers[key] !== undefined) },
      response: { status, body: JSON.parse(JSON.stringify(reply).replaceAll(origin, "{origin}")) },
    });
    response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(reply));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const resource = origin + resourcePath;
    let presented: { verification: string; userCode: string } | undefined;
    const interaction: McpAuthInteraction = {
      plan: () => { throw new Error("fixture interaction is already selected"); },
      authorize: async url => {
        authorized = url;
        return mode === "device" ? { kind: "device_code" } : {
          code: "<fixture-code>", state: url.searchParams.get("state")!, issuer: origin + "/issuer",
        };
      },
      onDevice: async prompt => { presented = { verification: prompt.verificationUri.replace(origin, "{origin}"), userCode: prompt.userCode }; },
      sleep: async ms => { waits.push(ms); now += ms; },
      now: () => now,
    };
    const protect: string[] = [];
    const provider = new PkceAuthProvider({ clientId, redirectUri, interaction });
    const challenge = await discoverMcpAuthChallenge(resource, createMcpFetch(), provider, value => protect.push(value), undefined,
      { scope: "read profile" });
    const access = await provider.authorize(challenge);
    if (!authorized || access !== "<fixture-access>" || !protect.includes(access)) throw new Error("incomplete fixture authorization");
    const refreshed = mode === "pkce" ? await provider.accessToken(resource) : undefined;
    if (mode === "pkce" && (refreshed !== "<fixture-renewed-access>" || !protect.includes(refreshed))) throw new Error("incomplete fixture refresh");
    const params = new URLSearchParams(authorized.searchParams);
    params.set("state", "<state>");
    params.set("code_challenge", "<challenge>");
    params.set("resource", params.get("resource")!.replace(origin, "{origin}"));
    return {
      mode, transport: "http", exchanges, observed: { prompt: params.toString(), waits, presented, tokenProtected: protect.includes(access), refreshProtected: refreshed === undefined ? undefined : protect.includes(refreshed) },
    };
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

export async function recordMcpAuth() {
  return { auth: { source: "packages/core/src/mcp/auth.ts", cases: [await record("pkce"), await record("device")] } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await exporterMain({ area: "mcp", build: recordMcpAuth });
}
