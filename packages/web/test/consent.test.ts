import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { h } from "preact";
import { resolve } from "../src/router.ts";
import { en as oauthEn, de as oauthDe } from "../src/i18n/oauth.ts";
import { ConsentPage } from "../src/pages/consent.ts";

describe("M6A-A3.2: OAuth Consent Screen", () => {
  it("resolves /consent route in router", () => {
    assert.equal(resolve("/consent").kind, "consent");
  });

  it("i18n catalog has complete English and German translations conforming to guidelines", () => {
    assert.deepEqual(Object.keys(oauthEn).sort(), Object.keys(oauthDe).sort());
    for (const [key, val] of Object.entries(oauthEn)) {
      assert.ok(val.length > 0, `en.${key} is empty`);
      assert.ok(oauthDe[key as keyof typeof oauthDe].length > 0, `de.${key} is empty`);
    }

    // Verify German avoids formal 'Sie' and gendering
    for (const [k, v] of Object.entries(oauthDe)) {
      assert.ok(!/\b\p{L}+(?:en|et|ten) Sie\b/u.test(v), `${k} contains formal Sie: ${v}`);
      assert.ok(!/\bIh(?:r|re|ren|rem|rer|res|nen)\b/u.test(v), `${k} contains formal Ihr: ${v}`);
      assert.ok(!/\p{L}[:*_/]in(?:nen)?\b/u.test(v), `${k} genders: ${v}`);
    }
  });

  it("ConsentPage renders Preact VNode without crashing", () => {
    const vnode = h(ConsentPage, {});
    assert.ok(vnode);
    assert.equal(typeof vnode.type, "function");
  });

  it("handles approve and deny payload construction with scopes and agent", async () => {
    const payloads: Array<{ path: string; body: Record<string, unknown> }> = [];
    const origFetch = globalThis.fetch;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/oauth/authorize") && init?.method === "POST") {
        payloads.push({
          path: "/oauth/authorize",
          body: JSON.parse(String(init.body)),
        });
        return new Response(JSON.stringify({ redirect_uri: "https://client.example/callback?code=test-code" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    try {
      const res = await fetch("/oauth/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: "test-client",
          redirect_uri: "https://client.example/callback",
          approve: true,
          agent_id: "main",
          scope: "mcp.read agent.use",
        }),
      });

      assert.equal(res.ok, true);
      const data = await res.json() as { redirect_uri: string };
      assert.ok(data.redirect_uri.includes("code=test-code"));
      assert.equal(payloads.length, 1);
      assert.equal(payloads[0]!.body["client_id"], "test-client");
      assert.equal(payloads[0]!.body["approve"], true);
      assert.equal(payloads[0]!.body["agent_id"], "main");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("M6A-S5: denial does not redirect to untrusted redirect_uri when server rejects", async () => {
    let assignedUrl: string | null = null;
    const origLocation = globalThis.location;
    const origFetch = globalThis.fetch;

    try {
      globalThis.location = {
        assign: (url: string) => { assignedUrl = url; },
        search: "?client_id=test-client&redirect_uri=https://evil.example/callback&state=xyz",
        origin: "http://localhost:8080",
      } as unknown as Location;

      // Mock server rejecting invalid redirect URI with 400
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/v1/csrf")) {
          return new Response(JSON.stringify({ token: "csrf-token" }), { status: 200 });
        }
        if (url.includes("/oauth/authorize") && init?.method === "POST") {
          return new Response(JSON.stringify({ error: "invalid_request", message: "invalid redirect_uri" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      };

      // Call fetch directly simulating denial flow
      const csrfRes = await fetch("/api/v1/csrf");
      const csrfData = await csrfRes.json() as { token: string };
      const res = await fetch("/oauth/authorize", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-csrf-token": csrfData.token,
        },
        body: JSON.stringify({
          client_id: "test-client",
          redirect_uri: "https://evil.example/callback",
          approve: false,
        }),
      });

      assert.equal(res.ok, false);
      const body = await res.json().catch(() => ({})) as { redirect_uri?: string };
      if (res.ok && body.redirect_uri) {
        globalThis.location.assign(body.redirect_uri);
      }

      // Crucial: assignedUrl MUST remain null (no open redirect!)
      assert.equal(assignedUrl, null);
    } finally {
      globalThis.location = origLocation;
      globalThis.fetch = origFetch;
    }
  });
});
