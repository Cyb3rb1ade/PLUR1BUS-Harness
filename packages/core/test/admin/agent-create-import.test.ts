import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { defaults } from "@plur1bus/config-schema";
import { agentCreation } from "../../src/agents/create.ts";
import { readAgentBundle } from "../../src/agents/import.ts";
import { exportAgent } from "../../src/agents/export.ts";
import { agentRequiredSecrets } from "../../src/agents/secrets.ts";
import { buildAgentCreationSurface, AGENT_CREATION_RULES } from "../../src/rpc/agent-create-surface.ts";
import { guardMethods } from "../../src/rbac/guard.ts";
import { memoryAuditSink } from "../../src/rbac/audit.ts";
import type { Principal } from "../../src/rbac/types.ts";
import { AdminStore } from "../../src/identity/admin-store.ts";
import { layout } from "../../src/paths.ts";
import { RpcError } from "../../src/rpc/errors.ts";
const owner: Principal = { userId: "person-one", role: "owner", kind: "person" };
const ctx = () => ({ requestId: "test", connectionId: "offline", signal: new AbortController().signal });
const error = (code: string) => (e: unknown) => e instanceof RpcError && e.error === code;
function setup(t: { after(fn: () => void): void }) {
  const home = mkdtempSync(join(tmpdir(), "agent-create-")), l = layout(home), config = defaults(), audit = memoryAuditSink();
  config.modelProfiles.local = { strategy: "fallback", candidates: [{ model: "local/offline", weight: 1 }], params: {}, cache: { hint: "none" } };
  const people = new AdminStore({ path: ":memory:", ownerId: owner.userId });
  const imports: unknown[] = []; const paused: string[] = []; let secrets: string[] = []; let failSet = false; let failMemory = false;
  const service = agentCreation({ config: () => config, layout: l, clock: () => 1000, audit,
    set: async (id, value) => { if (failSet) throw new RpcError("E_CONFLICT", "revision changed"); config.agents[id] = value; },
    people: () => [owner.userId, "person-two"], setRight: (id, user, right) => people.setRight(id, user, right),
    secrets: async () => secrets, requiredSecrets: a => agentRequiredSecrets(config, a),
    importMemory: async (id, cards, hash, who) => { if (failMemory) throw new Error("offline storage failure"); imports.push({ id, cards, hash, who }); }, pause: id => { paused.push(id); },
  });
  const as = (who: Principal) => guardMethods(buildAgentCreationSurface(service), { resolve: () => who, now: () => 1000, audit, rules: AGENT_CREATION_RULES });
  t.after(() => { people.close(); rmSync(home, { recursive: true, force: true }); });
  return { home, l, config, people, audit, imports, paused, service, as, setSecrets: (v: string[]) => { secrets = v; }, failSet: () => { failSet = true; }, failMemory: () => { failMemory = true; } };
}
const keys = generateKeyPairSync("ed25519");
const signer = async (hash: string) => ({ publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64"), signature: sign(null, Buffer.from(hash, "hex"), keys.privateKey).toString("base64") });
async function bundle(s: ReturnType<typeof setup>, extra: Record<string, any> = {}) {
  const root = join(s.home, "source"); mkdirSync(root, { recursive: true });
  return exportAgent({ root, agentId: "alpha", config: { persona: "A plain {{agentId}} persona.", model: "local" }, memories: [{ id: "card-one", text: "The project uses Rust.", scope: "agent-private" }], signer, ...extra });
}

test("create validates Config Schema, stores rights only in AdminStore and grants creator manage", async t => {
  const s = setup(t), payload = { name: "alpha", persona: "Hello {{agentId}}", model: "local", memory: { mediaEmbedding: { enabled: false } }, channels: ["telegram"], rights: { "person-two": "use" } };
  assert.deepEqual(await s.as(owner)["agent.create"]!(payload, ctx()), { agentId: "alpha" });
  assert.equal(readFileSync(join(s.l.agentDir("alpha"), "SOUL.md"), "utf8"), payload.persona);
  assert.equal(Object.hasOwn(s.config.agents.alpha!, "rights"), false);
  assert.deepEqual(s.people.rights("alpha").map(r => ({ ...r })), [{ userId: "person-one", right: "manage" }, { userId: "person-two", right: "use" }]);
  assert.ok(s.audit.events.some(e => e.action === "agent.created"));
  await assert.rejects(s.as(owner)["agent.create"]!(payload, ctx()), error("E_AGENT_EXISTS"));
});
test("Owner/Admin people only, including an Owner-shaped agent and narrowed tokens", async t => {
  const s = setup(t);
  for (const who of [{ ...owner, kind: "agent" as const }, { ...owner, role: "member" as const }, { ...owner, role: "operator" as const }, { ...owner, tokenScopes: [] }]) {
    for (const method of ["agent.create", "agent.validate", "agent.import"]) await assert.rejects(s.as(who)[method]!({ name: "alpha", bundle: {} }, ctx()), error("E_DENIED"));
  }
  await s.as({ ...owner, role: "admin" })["agent.create"]!({ name: "alpha" }, ctx());
  assert.equal(s.people.rights("alpha")[0]!.right, "manage");
});
test("validate groups field errors by all three wizard steps without mutation", t => {
  const s = setup(t);
  const v = s.service.validate({ name: "Bad", persona: "a".repeat(4001), model: "unknown", channels: ["unknown"], memory: { mediaEmbedding: { dimensions: 0 } }, rights: { absent: "manage" } }, owner);
  assert.equal(v.valid, false);
  assert.deepEqual(new Set(v.errors.map(e => e.step)), new Set(["identity", "model", "rights"]));
  assert.ok(v.errors.some(e => e.field === "persona")); assert.ok(v.errors.some(e => e.field === "channels/0"));
  assert.equal(existsSync(s.l.agents), false); assert.deepEqual(s.config.agents, {}); assert.equal(s.audit.events.length, 0);
});
test("create rejects unknown persons/agent IDs, excessive rights and invalid settings before writes", async t => {
  const s = setup(t); s.config.agents.agent = {};
  for (const rights of [{ absent: "use" }, { agent: "manage" }, { "person-two": "owner" }]) await assert.rejects(s.service.create({ name: "alpha", rights }, owner), error("E_AGENT_RIGHTS"));
  await assert.rejects(s.service.create({ name: "alpha", rights: { "person-two": "manage" } }, { ...owner, tokenScopes: ["settings.write"] }), error("E_AGENT_RIGHTS"));
  for (const settings of [{ model: "unknown" }, { channels: ["unknown"] }, { persona: "a".repeat(4001) }, { memory: { mediaEmbedding: { dimensions: 0 } } }]) await assert.rejects(s.service.create({ name: "alpha", ...settings }, owner), error("E_INVALID_PARAMS"));
  assert.deepEqual(Object.keys(s.config.agents), ["agent"]);
});
test("concurrent create admits exactly one name; failed config CAS removes staged files", async t => {
  const s = setup(t);
  const results = await Promise.allSettled([s.service.create({ name: "alpha" }, owner), s.service.create({ name: "alpha" }, owner)]);
  assert.deepEqual(results.map(r => r.status), ["fulfilled", "rejected"]);
  s.failSet(); await assert.rejects(s.service.create({ name: "beta" }, owner), error("E_CONFLICT"));
  assert.equal(existsSync(s.l.agentDir("beta")), false); assert.equal(s.config.agents.beta, undefined);
});
test("signed export/import roundtrip renames, restores persona/cards and reports foreign person rights", async t => {
  const s = setup(t); await s.service.create({ name: "alpha" }, owner);
  const b = await bundle(s, { rights: { "person-two": "manage", foreign: "use" } });
  await assert.rejects(s.service.import(b, undefined, owner), error("E_AGENT_EXISTS"));
  const result = await s.as(owner)["agent.import"]!({ bundle: b, onConflict: "rename" }, ctx());
  assert.deepEqual(result, { agentId: "alpha-2", discardedRights: ["foreign"] });
  assert.equal(s.imports.length, 1); assert.equal((s.imports[0] as any).cards[0].text, "The project uses Rust.");
  assert.equal(readFileSync(join(s.l.agentDir("alpha-2"), "SOUL.md"), "utf8"), "A plain {{agentId}} persona.");
  assert.equal(s.people.rights("alpha-2").find(r => r.userId === "person-two")!.right, "manage");
});
test("import bounds existing-person rights by caller scopes and always grants caller manage", async t => {
  const s = setup(t), b = await bundle(s, { rights: { "person-two": "manage" } });
  const result = await s.service.import(b, "fail", { ...owner, tokenScopes: ["settings.write", "agent.read"] });
  assert.deepEqual(result.discardedRights, []);
  assert.deepEqual(s.people.rights("alpha").map(r => ({ ...r })), [{ userId: "person-one", right: "manage" }, { userId: "person-two", right: "use" }]);
});
test("import missing secrets lists names only before mutation, then succeeds after provisioning", async t => {
  const s = setup(t), b = await bundle(s, { requiredSecrets: ["providers.example.key"] });
  await assert.rejects(s.service.import(b, "fail", owner), (e: any) => { assert.equal(e.error, "E_AGENT_SECRETS_MISSING"); assert.deepEqual(e.toJSON().data.ids, { "providers.example.key": "providers.example.key" }); return true; });
  assert.deepEqual(s.config.agents, {}); assert.equal(existsSync(s.l.agents), false);
  s.setSecrets(["providers.example.key"]); await s.service.import(b, "fail", owner);
});
test("target channel references require local secrets even when an old export lacks secret metadata", async t => {
  const s = setup(t), b = await bundle(s, { config: { channels: ["telegram"] } });
  await assert.rejects(s.service.import(b, "fail", owner), error("E_AGENT_SECRETS_MISSING"));
});
test("version, file checksums, manifest checksum and signature are verified before secrets or writes", async t => {
  const s = setup(t), b = await bundle(s);
  for (const change of [(v: any) => { v.format = "plur1bus.agent-export/2"; }, (v: any) => { v.files[0].text += " "; }, (v: any) => { v.manifestHash = "0".repeat(64); }, (v: any) => { v.signature = Buffer.alloc(64).toString("base64"); }, (v: any) => { delete v.signature; }]) {
    const v = structuredClone(b); change(v); await assert.rejects(s.service.import(v, "fail", owner), error("E_INVALID_PARAMS"));
  }
  assert.deepEqual(s.config.agents, {});
});
test("unsigned checksum-valid export is sanitized, traversal/duplicates refused", async t => {
  const s = setup(t), b: any = await bundle(s, { config: { persona: "Plain text.", apiKey: "fixture-value" } });
  // Export already omits secrets. Inject an unsigned foreign credential to test the independent import boundary.
  delete b.signature; delete b.publicKey; delete b.algorithm;
  b.files[0].text = JSON.stringify({ persona: "Plain text.", apiKey: "fixture-value" });
  const hash = (v: string) => createHash("sha256").update(v).digest("hex");
  const seal = () => { b.manifest.files = b.files.map((f: any) => ({ path: f.path, bytes: Buffer.byteLength(f.text), sha256: hash(f.text) })); b.manifestHash = hash(JSON.stringify(b.manifest)); };
  seal(); await s.service.import(b, "fail", owner); assert.equal(Object.hasOwn(s.config.agents.alpha!, "apiKey"), false);
  for (const path of ["../outside.md", "/outside.md", "workspace/../outside.md", "workspace/memory/NUL.md", "workspace/memory/key-secret.md"]) { b.files.push({ path, text: "text" }); seal(); assert.throws(() => readAgentBundle(b), error("E_INVALID_PARAMS")); b.files.pop(); }
  b.files.push(b.files[0]); seal(); assert.throws(() => readAgentBundle(b), error("E_INVALID_PARAMS"));
});
test("an engine import failure keeps the recoverable agent paused and returns its ID", async t => {
  const s = setup(t); s.failMemory(); await assert.rejects(s.service.import(await bundle(s), "fail", owner), error("E_STORAGE"));
  assert.deepEqual(s.paused, ["alpha"]); assert.ok(s.config.agents.alpha);
});


test("required secrets use the target profile's native secret_ref, pool secretRef and channel fields", t => {
  const s = setup(t);
  s.config.providers.local = { profile: { secret_ref: "providers/local:key" }, entries: [{ secretRef: "providers.local.spare" }] };
  assert.deepEqual(agentRequiredSecrets(s.config, { model: "local", channels: ["telegram"] }), ["channels.telegram.botToken", "providers.local.spare", "providers/local:key"]);
});


test("export integrity survives recursively reordered JSON keys, including the Rust CLI", async t => {
  const s = setup(t), b = await bundle(s, { rights: { "person-two": "use" }, requiredSecrets: [] });
  const reordered = (v: any): any => Array.isArray(v) ? v.map(reordered) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().reverse().map(k => [k, reordered(v[k])])) : v;
  assert.equal(readAgentBundle(reordered(b)).hash, b.manifestHash);
  assert.deepEqual(await s.service.import(reordered(b), "fail", owner), { agentId: "alpha", discardedRights: [] });
});

test("old construction-order v1 hashes/signatures also survive CLI key ordering", async t => {
  const s = setup(t), b: any = await bundle(s);
  const original = { format: b.manifest.format, agentId: b.manifest.agentId, files: b.manifest.files.map((f: any) => ({ path: f.path, bytes: f.bytes, sha256: f.sha256 })) };
  b.manifestHash = createHash("sha256").update(JSON.stringify(original)).digest("hex"); Object.assign(b, await signer(b.manifestHash));
  const sort = (v: any): any => Array.isArray(v) ? v.map(sort) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sort(v[k])])) : v;
  b.manifest = sort(original);
  assert.equal(readAgentBundle(b).hash, b.manifestHash);
});
