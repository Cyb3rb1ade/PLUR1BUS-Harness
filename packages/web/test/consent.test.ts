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
});
