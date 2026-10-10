import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { defaults } from "@plur1bus/config-schema";
import { createMediaOwnerAcl, createMediaSearchSurface, MEDIA_SEARCH_METHODS, type MediaSearchSurfaceDeps } from "../../src/rpc/media-search-surface.ts";
import { guardMethods, RPC_RULES, type PrincipalResolver } from "../../src/rbac/guard.ts";
import { memoryAuditSink } from "../../src/rbac/audit.ts";
import { RpcError } from "../../src/rpc/errors.ts";
import type { Principal } from "../../src/rbac/types.ts";
import type { CallContext } from "../../src/rpc/server.ts";
import type { MediaHit, MediaIndexPort, MediaIndexStatus, MediaSearchRequest } from "../../src/media-search/types.ts";

const schema = JSON.parse(readFileSync(new URL("../../../rpc-schema/schema/rpc.schema.json", import.meta.url), "utf8"));
const OWNER: Principal = { userId: "local-owner", role: "owner", kind: "person" };
const MEMBER: Principal = { userId: "mia", role: "member", kind: "person" };
const VIEWER: Principal = { userId: "vi", role: "viewer", kind: "person" };
const AGENT: Principal = { userId: "bernd", role: "member", kind: "agent" };
const STATUS: MediaIndexStatus = {
  enabled: true, provider: "local-transformers", model: "google/embeddinggemma-2", dim: 768, fingerprint: "fp-1",
  counts: { indexed: 2, pending: 1, failed: 0, unsupported: 0 }, backfill: { state: "running", done: 2, total: 3 },
};

function setup(o: { hits?: MediaHit[]; readable?: (p: Principal, id: string) => boolean; editable?: (p: Principal, id: string) => boolean; index?: boolean; mediaCfg?: Record<string, unknown>; searchError?: unknown } = {}) {
  const calls: string[] = [];
  const searches: MediaSearchRequest[] = [];
  const captions: { id: string; text: string; source: string }[] = [];
  const index = {
    async search(req: MediaSearchRequest) { searches.push(req); if (o.searchError) throw o.searchError; return o.hits ?? []; },
    async status() { return structuredClone(STATUS); },
    async setCaption(id: string, text: string, source: string) { captions.push({ id, text, source }); },
  } as unknown as MediaIndexPort;
  const cfg = defaults() as any;
  if (o.mediaCfg) cfg.memory.mediaEmbedding = { ...(cfg.memory.mediaEmbedding ?? {}), ...o.mediaCfg };
  const audit = memoryAuditSink();
  const deps: MediaSearchSurfaceDeps = {
    index: () => (o.index === false ? null : index), config: () => cfg,
    backfill: { pause: async () => { calls.push("pause"); }, resume: async () => { calls.push("resume"); }, reindex: async () => { calls.push("reindex"); } },
    scopeOf: (p) => ({ agent: p.kind === "agent" ? p.userId : "main", workspace: "w" }) as never,
    readable: async (p, id) => (o.readable ? o.readable(p, id) : true),
    editable: async (p, id) => (o.editable ? o.editable(p, id) : true),
    captionOf: async (id) => (id ? `caption of ${id}` : undefined),
    thumbnailUrl: (id) => `/thumb/${id}`,
    audit, clock: () => 7,
  };
  const raw = createMediaSearchSurface(deps).methods;
  const as = (principal: Principal | null) => {
    const resolve: PrincipalResolver = () => principal;
    const methods = guardMethods(raw, { resolve, now: () => 1, audit });
    const ctx = (): CallContext => ({ requestId: "r", connectionId: "c", signal: new AbortController().signal });
    const call = (m: string, p: unknown = {}) => methods[m]!(p, ctx()) as Promise<any>;
    const refusal = (m: string, p: unknown = {}) => call(m, p).then(() => assert.fail("expected a refusal"), (e: unknown) => { assert.ok(e instanceof RpcError, String(e)); return { error: e.error, reason: e.reason }; });
    return { call, refusal };
  };
  return { raw, as, calls, searches, captions, audit };
}

test("the surface declares exactly the six schema methods, all core and closed, each with an RBAC rule", () => {
  assert.deepEqual(Object.keys(setup().raw).sort(), [...MEDIA_SEARCH_METHODS].sort());
  for (const n of MEDIA_SEARCH_METHODS) {
    assert.equal(schema.$defs.methods[n]["x-server"], "core", n);
    assert.equal(schema.$defs.methods[n].params.additionalProperties, false, n);
    assert.ok(RPC_RULES[n], n);
  }
});

test("search: text query, defaults (limit 20 over-fetched), hits carry caption and thumbnail, segment kept", async () => {
  const s = setup({ hits: [{ mediaId: "a", kind: "image", score: 0.9, captionMemoryId: "cm1" }, { mediaId: "b", kind: "video", score: 0.5, segment: { idx: 1, startMs: 10000, endMs: 20000 } }] });
  const r = await s.as(OWNER).call("media.search", { text: "red bicycle" });
  assert.deepEqual(r, { hits: [
    { mediaId: "a", kind: "image", score: 0.9, caption: "caption of cm1", thumbnailUrl: "/thumb/a" },
    { mediaId: "b", kind: "video", score: 0.5, segment: { idx: 1, startMs: 10000, endMs: 20000 }, thumbnailUrl: "/thumb/b" },
  ] });
  assert.equal(s.searches[0]!.text, "red bicycle");
  assert.equal(s.searches[0]!.limit, 40);
  assert.equal(s.searches[0]!.fuseCaptions, false);
  assert.equal(s.searches[0]!.likeMediaId, undefined);
});

test("search: hits the caller may not read are dropped and the result is cut to the limit", async () => {
  const hits: MediaHit[] = ["a", "secret", "b", "c"].map((mediaId, i) => ({ mediaId, kind: "image", score: 1 - i / 10 }));
  const s = setup({ hits, readable: (_p, id) => id !== "secret" });
  const r = await s.as(MEMBER).call("media.search", { text: "x", limit: 2 });
  assert.deepEqual(r.hits.map((h: any) => h.mediaId), ["a", "b"]);
});

test("search: likeMediaId needs read access to the seed (unknown and unreadable look the same); kinds and fuseCaptions pass through", async () => {
  const s = setup({ hits: [], readable: (_p, id) => id === "seed" });
  await s.as(OWNER).call("media.search", { likeMediaId: "seed", kinds: ["audio"], fuseCaptions: true });
  assert.deepEqual([s.searches[0]!.likeMediaId, s.searches[0]!.kinds, s.searches[0]!.fuseCaptions], ["seed", ["audio"], true]);
  assert.deepEqual(await s.as(OWNER).refusal("media.search", { likeMediaId: "other" }), { error: "E_NOT_FOUND", reason: "unknown-media" });
});

test("search: an agent searches in its own scope", async () => {
  const s = setup();
  await s.as(AGENT).call("media.search", { text: "x" });
  assert.equal((s.searches[0]!.scope as any).agent, "bernd");
});

test("search: parameter validation", async () => {
  const s = setup();
  const c = s.as(OWNER);
  const reason = async (p: unknown) => (await c.refusal("media.search", p));
  assert.deepEqual(await reason({}), { error: "E_INVALID_PARAMS", reason: "text-or-like-required" });
  assert.deepEqual(await reason({ text: "a", likeMediaId: "b" }), { error: "E_INVALID_PARAMS", reason: "text-and-like-exclusive" });
  for (const bad of [{ text: "" }, { text: 5 }, { text: "a", limit: 0 }, { text: "a", limit: 101 }, { text: "a", limit: 1.5 }, { text: "a", kinds: [] }, { text: "a", kinds: ["gif"] }, { text: "a", kinds: ["image", "image"] }, { text: "a", fuseCaptions: "yes" }, { text: "a", extra: 1 }]) {
    assert.equal((await reason(bad)).error, "E_INVALID_PARAMS", JSON.stringify(bad));
  }
  assert.equal(s.searches.length, 0);
});

test("search: no media index or a disabled one is E_MEDIA_UNAVAILABLE; port errors keep their E_MEDIA_* code", async () => {
  assert.deepEqual(await setup({ index: false }).as(OWNER).refusal("media.search", { text: "x" }), { error: "E_MEDIA_UNAVAILABLE", reason: "no-media-index" });
  assert.deepEqual(await setup({ mediaCfg: { enabled: false } }).as(OWNER).refusal("media.search", { text: "x" }), { error: "E_MEDIA_UNAVAILABLE", reason: "media-index-disabled" });
  assert.deepEqual(await setup({ mediaCfg: { provider: "off" } }).as(OWNER).refusal("media.search", { text: "x" }), { error: "E_MEDIA_UNAVAILABLE", reason: "media-index-disabled" });
  const e = Object.assign(new Error("model /Users/x/secret-path missing"), { code: "E_MEDIA_DIMENSION" });
  const r = await setup({ searchError: e }).as(OWNER).call("media.search", { text: "x" }).catch((x) => x);
  assert.ok(r instanceof RpcError);
  assert.equal(r.error, "E_MEDIA_DIMENSION");
  assert.ok(!r.message.includes("/Users"), "the engine text is not forwarded");
  const unknown = await setup({ searchError: new Error("boom") }).as(OWNER).refusal("media.search", { text: "x" });
  assert.equal(unknown.error, "E_STORAGE");
});

test("status: any role incl. viewer and agent reads it; the result is projected onto the schema", async () => {
  const s = setup();
  for (const p of [OWNER, MEMBER, VIEWER, AGENT]) assert.deepEqual(await s.as(p).call("media.index.status"), STATUS);
  assert.equal((await s.as(OWNER).refusal("media.index.status", { x: 1 })).error, "E_INVALID_PARAMS");
});

test("pause, resume, reindex: owner and admin run them, return the status and are audited; reindex needs confirm:true", async () => {
  const s = setup();
  for (const p of [OWNER, { userId: "ad", role: "admin", kind: "person" } as Principal]) {
    assert.deepEqual(await s.as(p).call("media.index.pause"), STATUS);
    assert.deepEqual(await s.as(p).call("media.index.resume"), STATUS);
    assert.deepEqual(await s.as(p).call("media.index.reindex", { confirm: true }), STATUS);
  }
  assert.deepEqual(s.calls, ["pause", "resume", "reindex", "pause", "resume", "reindex"]);
  assert.deepEqual(s.audit.events.filter((e) => e.action.startsWith("media.index.")).map((e) => e.action).slice(0, 3), ["media.index.pause", "media.index.resume", "media.index.reindex"]);
  for (const bad of [{}, { confirm: false }, { confirm: "true" }]) assert.deepEqual(await s.as(OWNER).refusal("media.index.reindex", bad), { error: "E_INVALID_PARAMS", reason: "confirmation-required" });
  assert.equal(s.calls.length, 6);
});

test("caption.set: sets a user caption, trims, audits without the text; unknown or unreadable media is not found; non-editable is denied", async () => {
  const s = setup({ readable: (_p, id) => id !== "hidden", editable: (_p, id) => id !== "readonly" });
  assert.deepEqual(await s.as(MEMBER).call("media.caption.set", { mediaId: "m1", text: "  a red bicycle " }), { ok: true });
  assert.deepEqual(s.captions, [{ id: "m1", text: "a red bicycle", source: "user" }]);
  const ev = s.audit.events.find((e) => e.action === "media.caption.set")!;
  assert.equal(ev.target, "m1");
  assert.ok(!JSON.stringify(ev).includes("bicycle"));
  assert.deepEqual(await s.as(MEMBER).refusal("media.caption.set", { mediaId: "hidden", text: "t" }), { error: "E_NOT_FOUND", reason: "unknown-media" });
  assert.deepEqual(await s.as(MEMBER).refusal("media.caption.set", { mediaId: "readonly", text: "t" }), { error: "E_DENIED", reason: "not-editable" });
  for (const bad of [{ mediaId: "m", text: "" }, { mediaId: "m", text: "   " }, { mediaId: "m" }, { text: "t" }, { mediaId: "m", text: "t", x: 1 }]) assert.equal((await s.as(MEMBER).refusal("media.caption.set", bad)).error, "E_INVALID_PARAMS", JSON.stringify(bad));
  assert.equal(s.captions.length, 1);
});

// --- deny by default ---------------------------------------------------------------------------------------------------

const PARAMS: Record<string, unknown> = {
  "media.search": { text: "x" }, "media.index.status": {}, "media.index.pause": {}, "media.index.resume": {},
  "media.index.reindex": { confirm: true }, "media.caption.set": { mediaId: "m", text: "t" },
};
const UNKNOWN_PRINCIPALS: [string, Principal][] = [
  ["unknown role", { userId: "x", role: "superuser" as never, kind: "person" }],
  ["guest role", { userId: "g", role: "guest" as never, kind: "person" }],
  ["no role", { userId: "x", kind: "person" } as never],
  ["empty user", { userId: "", role: "owner", kind: "person" }],
];
for (const m of MEDIA_SEARCH_METHODS) {
  test(`${m}: unauthenticated, unknown and guest principals are denied and the handler never runs`, async () => {
    const s = setup();
    assert.equal((await s.as(null).refusal(m, PARAMS[m])).error, "E_UNAUTHORIZED");
    for (const [name, p] of UNKNOWN_PRINCIPALS) assert.equal((await s.as(p).refusal(m, PARAMS[m])).error, "E_DENIED", name);
    assert.deepEqual(s.calls, []);
    assert.deepEqual(s.searches, []);
    assert.deepEqual(s.captions, []);
  });
}
for (const m of ["media.index.pause", "media.index.resume", "media.index.reindex", "media.caption.set"]) {
  test(`${m}: agents are denied (human-only)`, async () => {
    const s = setup();
    assert.deepEqual(await s.as(AGENT).refusal(m, PARAMS[m]), { error: "E_DENIED", reason: "agent-principal" });
    assert.deepEqual(await s.as({ ...AGENT, role: "owner" }).refusal(m, PARAMS[m]), { error: "E_DENIED", reason: "agent-principal" });
    assert.deepEqual([s.calls, s.captions], [[], []]);
  });
}
for (const m of ["media.index.pause", "media.index.resume", "media.index.reindex"]) {
  test(`${m}: operator, member and viewer are denied`, async () => {
    const s = setup();
    for (const role of ["operator", "member", "viewer"] as const) assert.deepEqual(await s.as({ userId: "u", role, kind: "person" }).refusal(m, PARAMS[m]), { error: "E_DENIED", reason: "role-denied" });
    assert.deepEqual(s.calls, []);
  });
}
test("caption.set: a viewer is denied by role; even a direct call with an agent principal is refused by the handler", async () => {
  const s = setup();
  assert.deepEqual(await s.as(VIEWER).refusal("media.caption.set", PARAMS["media.caption.set"]), { error: "E_DENIED", reason: "role-denied" });
  const ctx: CallContext = { requestId: "r", connectionId: "c", signal: new AbortController().signal };
  await assert.rejects(() => s.raw["media.caption.set"]!(PARAMS["media.caption.set"], ctx), { error: "E_UNAUTHORIZED" }); // not through the guard: no authenticated principal
  assert.deepEqual(s.captions, []);
});

test("owner ACL: a medium is readable/editable through the rights on the agent that made it; unknown ids and bad ids are denied", async () => {
  const home = mkdtempSync(join(tmpdir(), "p1-media-acl-"));
  try {
    mkdirSync(join(home, "media", "owners"), { recursive: true });
    writeFileSync(join(home, "media", "owners", "m1.json"), JSON.stringify({ agentId: "bernd", userId: "mia", connectionId: "c" }));
    const acl = createMediaOwnerAcl({ home });
    const withRight = { ...MEMBER, agentRights: { bernd: "use" } } as Principal;
    const otherAgent = { ...MEMBER, agentRights: { other: "use" } } as Principal;
    assert.equal(await acl.readable(OWNER, "m1"), true);
    assert.equal(await acl.editable(OWNER, "m1"), true);
    assert.equal(await acl.readable(withRight, "m1"), true);
    assert.equal(await acl.editable(withRight, "m1"), true);
    assert.equal(await acl.readable(otherAgent, "m1"), false);
    assert.equal(await acl.editable(MEMBER, "m1"), false);
    assert.equal(await acl.readable(VIEWER, "m1"), false);
    assert.equal(await acl.readable(OWNER, "nope"), false);
    assert.equal(await acl.readable(OWNER, "../x"), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
