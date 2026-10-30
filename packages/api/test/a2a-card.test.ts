import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { AgentCard } from "@a2a-js/sdk";
import { raw, start } from "./helpers.ts";
import { verifyAgentCard } from "../src/a2a/card.ts";

test("M6A-A4.2: serves default agent card at /.well-known/agent-card.json and /.well-known/agent.json", async () => {
  const h = await start({
    a2aConfig: {
      a2aServer: {
        enabled: true,
        defaultAgentId: "main",
      },
      agents: {
        main: {
          a2aServer: {
            exposed: true,
            name: "Main Assistant",
            description: "Default primary assistant",
          },
        },
      },
    },
  });
  const originalImpl = h.core.impl;
  h.core.impl = async (method, params: any) => {
    if (method === "secret.get" && params?.name === "agent-card-signing-key" && params?.reveal === true) {
      return { secret: { name: "agent-card-signing-key" }, value: privateKeyPem };
    }
    return originalImpl(method, params);
  };
  try {
    for (const p of ["/.well-known/agent-card.json", "/.well-known/agent.json"]) {
      const res = await raw(h, { method: "GET", path: p });
      assert.equal(res.status, 200, `${p} should return 200`);
      assert.equal(res.json.name, "Main Assistant");
      assert.equal(res.json.description, "Default primary assistant");
      assert.ok(Array.isArray(res.json.supportedInterfaces));
      assert.equal(res.json.supportedInterfaces.length, 1);
      assert.equal(res.json.supportedInterfaces[0].protocolBinding, "JSONRPC");
      assert.equal(res.json.supportedInterfaces[0].protocolVersion, "1.0");
      assert.match(res.json.supportedInterfaces[0].url, /\/a2a\/main$/);
    }
  } finally {
    await h.close();
  }
});

test("M6A-A4.2: serves per-agent card at /a2a/{agentId}/.well-known/agent-card.json and agent.json", async () => {
  const h = await start({
    a2aConfig: {
      a2aServer: {
        enabled: true,
      },
      agents: {
        agent1: {
          a2aServer: {
            exposed: true,
            name: "Agent One",
            description: "First exposed agent",
          },
        },
        agent2: {
          a2aServer: {
            exposed: true,
            name: "Agent Two",
            description: "Second exposed agent",
          },
        },
      },
    },
  });
  try {
    const res1 = await raw(h, { method: "GET", path: "/a2a/agent1/.well-known/agent-card.json" });
    assert.equal(res1.status, 200);
    assert.equal(res1.json.name, "Agent One");
    assert.match(res1.json.supportedInterfaces[0].url, /\/a2a\/agent1$/);

    const alias2 = await raw(h, { method: "GET", path: "/a2a/agent2/.well-known/agent.json" });
    assert.equal(alias2.status, 200);
    assert.equal(alias2.json.name, "Agent Two");
    assert.match(alias2.json.supportedInterfaces[0].url, /\/a2a\/agent2$/);
  } finally {
    await h.close();
  }
});

test("M6A-A4.2: unexposed or unknown agent returns 404", async () => {
  const h = await start({
    a2aConfig: {
      a2aServer: {
        enabled: true,
      },
      agents: {
        privateAgent: {
          a2aServer: {
            exposed: false,
            name: "Private Agent",
          },
        },
      },
    },
  });
  try {
    const unexposed = await raw(h, { method: "GET", path: "/a2a/privateAgent/.well-known/agent-card.json" });
    assert.equal(unexposed.status, 404);

    const unknown = await raw(h, { method: "GET", path: "/a2a/nonExistent/.well-known/agent-card.json" });
    assert.equal(unknown.status, 404);

    const rootUnexposed = await raw(h, { method: "GET", path: "/.well-known/agent-card.json" });
    assert.equal(rootUnexposed.status, 404);
  } finally {
    await h.close();
  }
});

test("M6A-A4.2: signs agent card with Ed25519 when signingKey is configured and verifies with public key", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const h = await start({
    a2aConfig: {
      a2aServer: {
        enabled: true,
        defaultAgentId: "signedAgent",
        signingKey: {
          privateKeySecret: "agent-card-signing-key",
          kid: "test-ed25519-key",
        },
      },
      agents: {
        signedAgent: {
          a2aServer: {
            exposed: true,
            name: "Signed Agent",
            description: "Cryptographically signed card",
          },
        },
      },
    },
  });
  try {
    const res = await raw(h, { method: "GET", path: "/.well-known/agent-card.json" });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json.signatures));
    assert.equal(res.json.signatures.length, 1);
    assert.ok(res.json.signatures[0].signature);
    assert.ok(res.json.signatures[0].protected);

    // Verify signature using verifyAgentCard
    const parsedCard = AgentCard.fromJSON(res.json);
    let resolvedKid: string | undefined;
    await verifyAgentCard(parsedCard, async (kid) => {
      resolvedKid = kid;
      return publicKey;
    });
    assert.equal(resolvedKid, "test-ed25519-key");

    // Tampering with the card causes verification to reject
    const tamperedCard = AgentCard.fromJSON({ ...res.json, name: "Tampered Name" });
    await assert.rejects(
      async () => {
        await verifyAgentCard(tamperedCard, async () => publicKey);
      },
      /no valid signatures/i,
    );
  } finally {
    await h.close();
  }
});

test("M6A-A4.2: includes legacy 0.3 interface when legacy03 is enabled", async () => {
  const h = await start({
    a2aConfig: {
      a2aServer: {
        enabled: true,
        legacy03: true,
        defaultAgentId: "main",
      },
      agents: {
        main: {
          a2aServer: {
            exposed: true,
            name: "Compat Agent",
          },
        },
      },
    },
  });
  try {
    const res = await raw(h, { method: "GET", path: "/.well-known/agent-card.json" });
    assert.equal(res.status, 200);
    const ifaces = res.json.supportedInterfaces as Array<{ protocolVersion: string }>;
    assert.ok(ifaces.some((i) => i.protocolVersion === "1.0"));
    assert.ok(ifaces.some((i) => i.protocolVersion === "0.3"));
  } finally {
    await h.close();
  }
});

test("M6A-S8: loads agent card signing key from SecretStore via privateKeySecret", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const h = await start({
    a2aConfig: {
      a2aServer: {
        enabled: true,
        defaultAgentId: "secretAgent",
        signingKey: {
          privateKeySecret: "agent-card-signing-key",
          kid: "secret-store-key-1",
        },
      },
      agents: {
        secretAgent: {
          a2aServer: {
            exposed: true,
            name: "Secret Signed Agent",
          },
        },
      },
    },
  });

  // Mock core.impl for secret.get
  const originalImpl = h.core.impl;
  h.core.impl = async (method, params: any) => {
    if (method === "secret.get" && params?.name === "agent-card-signing-key" && params?.reveal === true) {
      return { secret: { name: "agent-card-signing-key" }, value: privateKeyPem };
    }
    return originalImpl(method, params);
  };

  try {
    const res = await raw(h, { method: "GET", path: "/.well-known/agent-card.json" });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json.signatures));
    assert.equal(res.json.signatures.length, 1);
    assert.ok(res.json.signatures[0].signature);

    const parsedCard = AgentCard.fromJSON(res.json);
    let resolvedKid: string | undefined;
    await verifyAgentCard(parsedCard, async (kid) => {
      resolvedKid = kid;
      return publicKey;
    });
    assert.equal(resolvedKid, "secret-store-key-1");
  } finally {
    await h.close();
  }
});
