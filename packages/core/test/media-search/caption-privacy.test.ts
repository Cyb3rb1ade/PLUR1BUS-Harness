import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveCaptionProvider } from "../../src/media-search/caption/service.ts";
import { createCloudCaptionProvider } from "../../src/media-search/caption/cloud.ts";
import { FakeCaptionProvider } from "./fakes.ts";

describe("privacy pin", () => {
  it("pinned + cloud configured refuses before any request", () => {
    let lookups = 0;
    const cloud = new FakeCaptionProvider("openai", false);
    assert.throws(
      () => resolveCaptionProvider({ config: { provider: "openai" }, pinned: true, providers: { local: new FakeCaptionProvider(), cloud: () => { lookups++; return cloud; } } }),
      (e: any) => e.error === "E_MEDIA_PRIVACY" || e.code === "E_MEDIA_PRIVACY",
    );
    assert.equal(lookups, 0);
    assert.equal(cloud.calls.length, 0);
  });
  it("pinned + unset falls back to local", () => {
    const local = new FakeCaptionProvider("local", true);
    assert.equal(resolveCaptionProvider({ config: {}, pinned: true, providers: { local } }), local);
  });
  it("pinned + off stays off", () => {
    assert.equal(resolveCaptionProvider({ config: { provider: "off" }, pinned: true, providers: { local: new FakeCaptionProvider() } }), undefined);
  });
});

describe("cloud provider", () => {
  const png = new Uint8Array([1, 2, 3]);
  const budgetFake = (refuse: boolean) => {
    const log: string[] = [];
    return { log, budget: {
      checkBeforeCall: () => (refuse ? { kind: "refuse", code: "budget_exceeded" } : (log.push("reserve"), { kind: "allow", reservationId: "r1", estimatedTokens: 0 })),
      settle: () => { log.push("settle"); }, releaseUnused: () => { log.push("release"); },
    } as any };
  };
  const mk = (o: { refuse?: boolean; deny?: boolean }) => {
    const b = budgetFake(!!o.refuse);
    const sent: any[] = [];
    const provider = createCloudCaptionProvider({
      id: "openai", model: "vision-model", privacy: () => ({ ack: { provider: "openai", acknowledgedAt: "2026-10-14T10:00:00Z", by: "u" } }), budget: b.budget, principal: "u", agent: "a", maxChars: () => 100,
      decide: async () => { if (o.deny) throw new Error("denied"); },
      chat: { async complete(req) { sent.push(req); return { text: "a cat on a sofa", usage: { inputTokens: 10, outputTokens: 5 }, provider: "openai", model: "vision-model" }; } },
    });
    return { provider, sent, log: b.log };
  };
  it("sends an image part and settles the budget", async () => {
    const { provider, sent, log } = mk({});
    assert.equal(await provider.caption({ kind: "image", mime: "image/png", source: { bytes: png } }), "a cat on a sofa");
    const parts = (sent[0].messages[0].content as any[]);
    assert.ok(parts.some(p => p.type === "image_url" && p.url.startsWith("data:image/png;base64,")));
    assert.deepEqual(log, ["reserve", "settle"]);
  });
  it("policy denial sends nothing", async () => {
    const { provider, sent } = mk({ deny: true });
    await assert.rejects(provider.caption({ kind: "image", mime: "image/png", source: { bytes: png } }));
    assert.equal(sent.length, 0);
  });
  it("budget refusal sends nothing", async () => {
    const { provider, sent } = mk({ refuse: true });
    await assert.rejects(provider.caption({ kind: "image", mime: "image/png", source: { bytes: png } }));
    assert.equal(sent.length, 0);
  });
});

it("direct cloud adapter without acknowledgment never reaches policy or network", async () => {
 let requests=0;
 const provider=createCloudCaptionProvider({id:"openai",model:"vision",budget:null,principal:"alice",agent:"main",maxChars:()=>100,decide:async()=>{requests++;},chat:{complete:async()=>{requests++;throw new Error("unexpected network");}}});
 await assert.rejects(provider.caption({kind:"image",mime:"image/png",source:{bytes:new Uint8Array([1])}}),(e:any)=>e.error==="E_MEDIA_PRIVACY");
 assert.equal(requests,0);
});


it("direct OpenAI factory uses only caption consent with local media; runtime pin prevents background calls", async () => {
  const { defaults } = await import("@plur1bus/config-schema");
  const cfg = defaults();
  cfg.memory.mediaEmbedding.caption.provider = "openai";
  cfg.memory.mediaEmbedding.caption.privacyAck = { provider: "openai", acknowledgedAt: "2026-10-14T10:00:00Z", by: "alice" };
  let pinned = false; let policyCalls = 0; let networkCalls = 0; let budgetCalls = 0;
  const provider = createCloudCaptionProvider({
    id: "openai", model: "vision-fixture", principal: "system:media-index-fixture", agent: "fixture-agent", maxChars: () => 100,
    privacy: () => ({ ack: cfg.memory.mediaEmbedding.caption.privacyAck!, pinned }),
    decide: async () => { policyCalls++; },
    budget: { checkBeforeCall: () => { budgetCalls++; return { kind: "allow", reservationId: "fixture", estimatedTokens: 0 }; }, settle() {}, releaseUnused() {} } as any,
    chat: { async complete() { networkCalls++; return { text: "auto caption", usage: { inputTokens: 1, outputTokens: 1 }, provider: "openai", model: "vision-fixture" }; } },
  });
  const input = { kind: "image" as const, mime: "image/png", source: { bytes: new Uint8Array([1]) } };
  assert.equal(cfg.memory.mediaEmbedding.provider, "local-transformers");
  assert.equal(cfg.memory.mediaEmbedding.privacyAck, undefined);
  assert.equal(await provider.caption(input), "auto caption");
  assert.equal(networkCalls, 1); assert.equal(policyCalls, 1); assert.equal(budgetCalls, 1);
  pinned = true;
  await assert.rejects(provider.caption(input), (e: any) => e.error === "E_MEDIA_PRIVACY");
  assert.equal(networkCalls, 1); assert.equal(policyCalls, 1); assert.equal(budgetCalls, 1);
});
