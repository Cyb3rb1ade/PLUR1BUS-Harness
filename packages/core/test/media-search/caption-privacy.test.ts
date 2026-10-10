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
      checkBeforeCall: () => (refuse ? { kind: "refuse", code: "budget_exceeded" } : (log.push("reserve"), { kind: "allow", reservationId: "r1", estimatedCostMicros: 0 })),
      settle: () => { log.push("settle"); }, releaseUnused: () => { log.push("release"); },
    } as any };
  };
  const mk = (o: { refuse?: boolean; deny?: boolean }) => {
    const b = budgetFake(!!o.refuse);
    const sent: any[] = [];
    const provider = createCloudCaptionProvider({
      id: "openai", model: "vision-model", budget: b.budget, principal: "u", agent: "a", maxChars: () => 100,
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
