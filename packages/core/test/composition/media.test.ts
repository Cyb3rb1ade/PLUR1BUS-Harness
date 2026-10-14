import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { composeMedia, type MediaDefinition } from "../../src/composition/media.ts";
import { MediaError, OutputStore } from "../../../media/src/index.ts";
import { fakeEgress, fakeSecretService, useTempDirs } from "./helpers.ts";

const tmp = useTempDirs("p1b-media-comp-");
const openai = (over: Record<string, unknown> = {}): MediaDefinition => ({ id: "openai", model: "image-model-1", ...over }) as MediaDefinition;
const badRequest = { prompt: "" } as never; // fails request validation before any network call, after composeMedia's own gates

describe("composition/media composeMedia", () => {
  it("returns null when no adapter is configured", async () => {
    assert.equal(await composeMedia(tmp.make(), [], fakeSecretService().service, fakeEgress().egress), null);
  });

  it("refuses a plaintext apiKey in the configuration (references only)", async () => {
    await assert.rejects(() => composeMedia(tmp.make(), [openai({ apiKey: "redact-probe-alpha" })], fakeSecretService().service, fakeEgress().egress), (e) => e instanceof MediaError && e.code === "unsupported_parameter");
  });

  it("an empty-string apiKey is still refused: the key must not be present at all", async () => {
    await assert.rejects(() => composeMedia(tmp.make(), [openai({ apiKey: "" })], fakeSecretService().service, fakeEgress().egress), (e) => e instanceof MediaError && e.code === "unsupported_parameter");
  });

  it("selects the first configured adapter only and exposes its identity and capabilities", async () => {
    const home = tmp.make();
    const media = await composeMedia(home, [openai(), { id: "fal", model: "other" } as MediaDefinition], fakeSecretService().service, fakeEgress().egress);
    assert.equal(media!.adapter.id, "openai");
    assert.equal(media!.adapter.model, "image-model-1");
    assert.equal(media!.adapter.capabilities().generate, true);
    assert.equal(media!.adapter.capabilities().edit, true, "openai can edit");
    const fal = await composeMedia(home, [{ id: "together", model: "m" } as MediaDefinition], fakeSecretService().service, fakeEgress().egress);
    assert.equal(fal!.adapter.capabilities().edit, false, "capabilities come from the selected adapter");
  });

  it("creates the output store under <home>/media/outputs and discards unpublished staging", async () => {
    const home = tmp.make();
    const root = join(home, "media", "outputs");
    mkdirSync(join(root, ".stage-0123abcd"), { recursive: true });
    mkdirSync(join(root, ".lock"), { recursive: true });
    const media = await composeMedia(home, [openai()], fakeSecretService().service, fakeEgress().egress);
    assert.ok(media!.store instanceof OutputStore);
    assert.equal(media!.store.root, root);
    assert.ok(existsSync(root));
    assert.equal(existsSync(join(root, ".stage-0123abcd")), false);
    assert.equal(existsSync(join(root, ".lock")), false);
  });

  it("a fresh output directory is private to the owner (docs/media.md: directories 0700 on POSIX)", async () => {
    const home = tmp.make();
    await composeMedia(home, [openai()], fakeSecretService().service, fakeEgress().egress);
    if (process.platform !== "win32") assert.equal(statSync(join(home, "media", "outputs")).mode & 0o777, 0o700);
  });

  it("construction itself needs no secret and no egress decision", async () => {
    const secrets = fakeSecretService({ "media.key": "redact-probe-alpha" }); const egress = fakeEgress();
    await composeMedia(tmp.make(), [openai({ secretRef: "media.key" })], secrets.service, egress.egress);
    assert.deepEqual(secrets.leases, []);
    assert.deepEqual(egress.asked, []);
  });

  it("an egress denial for the provider host blocks the operation before the secret is read", async () => {
    const secrets = fakeSecretService({ "media.key": "redact-probe-alpha" }); const egress = fakeEgress(() => false);
    const media = await composeMedia(tmp.make(), [openai({ secretRef: "media.key" })], secrets.service, egress.egress);
    await assert.rejects(() => media!.adapter.generate(badRequest), (e) => e instanceof MediaError && e.code === "backend_unavailable");
    assert.deepEqual(egress.asked, ["https://api.openai.com/v1"]);
    assert.deepEqual(secrets.leases, [], "no credential is leased for a destination egress refuses");
  });

  it("asks egress about the base URL and every download host, in that order; one refusal stops the operation", async () => {
    const egress = fakeEgress((url) => !url.includes("cdn-b"));
    const media = await composeMedia(tmp.make(), [openai({ baseUrl: "https://gateway.example.invalid/v1", downloadHosts: ["cdn-a.example.invalid", "cdn-b.example.invalid", "cdn-c.example.invalid"] })], fakeSecretService().service, egress.egress);
    await assert.rejects(() => media!.adapter.edit(badRequest), (e) => e instanceof MediaError && e.code === "backend_unavailable");
    assert.deepEqual(egress.asked, ["https://gateway.example.invalid/v1", "https://cdn-a.example.invalid/", "https://cdn-b.example.invalid/"]);
  });

  it("a missing secret is a backend_unavailable error, not a keyless request", async () => {
    const secrets = fakeSecretService({});
    const media = await composeMedia(tmp.make(), [openai({ secretRef: "media.absent" })], secrets.service, fakeEgress().egress);
    await assert.rejects(() => media!.adapter.generate(badRequest), (e) => e instanceof MediaError && e.code === "backend_unavailable");
    assert.equal(secrets.leases.length, 1);
    assert.equal(secrets.leases[0]!.ref, "media.absent");
  });

  it("leases the secret as the core at operation time and revokes the lease right away, per operation", async () => {
    const secrets = fakeSecretService({ "media.key": "redact-probe-alpha" });
    const media = await composeMedia(tmp.make(), [openai({ secretRef: "media.key" })], secrets.service, fakeEgress().egress);
    await assert.rejects(() => media!.adapter.generate(badRequest), (e) => e instanceof MediaError && e.code !== "backend_unavailable");
    await assert.rejects(() => media!.adapter.edit(badRequest), MediaError);
    assert.equal(secrets.leases.length, 2, "one lease per operation");
    assert.deepEqual(secrets.leases.map((l) => l.principal), [{ kind: "core" }, { kind: "core" }]);
    assert.deepEqual(secrets.revoked, ["lease-1", "lease-2"]);
  });

  it("without a secretRef no lease is taken", async () => {
    const secrets = fakeSecretService();
    const media = await composeMedia(tmp.make(), [openai()], secrets.service, fakeEgress().egress);
    await assert.rejects(() => media!.adapter.generate(badRequest), MediaError);
    assert.deepEqual(secrets.leases, []);
  });

  it("an aborted signal stops the operation before egress is consulted", async () => {
    const egress = fakeEgress(); const ac = new AbortController(); const reason = new Error("user cancelled"); ac.abort(reason);
    const media = await composeMedia(tmp.make(), [openai()], fakeSecretService().service, egress.egress);
    await assert.rejects(() => media!.adapter.generate(badRequest, { signal: ac.signal }), (e) => e === reason);
    assert.deepEqual(egress.asked, []);
  });

  // The abort signal is checked after every egress decision, before the secret is leased: a late cancel leases nothing.
  it("a signal aborted while egress decides leases no secret and throws the abort reason", async () => {
    const ac = new AbortController(); const reason = new Error("late cancel"); const secrets = fakeSecretService({ "media.key": "redact-probe-alpha" });
    const egress = { async decide() { ac.abort(reason); return { allowed: true, host: "h", port: 443, address: "192.0.2.1", family: 4 }; } } as never;
    const media = await composeMedia(tmp.make(), [openai({ secretRef: "media.key" })], secrets.service, egress);
    await assert.rejects(() => media!.adapter.generate(badRequest, { signal: ac.signal }), (e) => e === reason);
    assert.deepEqual(secrets.leases, []);
    assert.deepEqual(secrets.revoked, []);
  });

  it("a cancel during the base-URL decision stops before the download hosts are asked", async () => {
    const ac = new AbortController(); const reason = new Error("late cancel"); const asked: string[] = [];
    const egress = { async decide(url: string) { asked.push(url); ac.abort(reason); return { allowed: true, host: "h", port: 443, address: "192.0.2.1", family: 4 }; } } as never;
    const media = await composeMedia(tmp.make(), [openai({ downloadHosts: ["cdn.example.invalid"] })], fakeSecretService().service, egress);
    await assert.rejects(() => media!.adapter.generate(badRequest, { signal: ac.signal }), (e) => e === reason);
    assert.equal(asked.length, 1);
  });

  it("invalid adapter configuration fails at composition, not at first use", async () => {
    await assert.rejects(() => composeMedia(tmp.make(), [openai({ model: "" })], fakeSecretService().service, fakeEgress().egress), (e) => e instanceof MediaError && e.code === "unsupported_parameter");
    await assert.rejects(() => composeMedia(tmp.make(), [openai({ model: "../escape" })], fakeSecretService().service, fakeEgress().egress), (e) => e instanceof MediaError);
  });
});
