/** Raw channel upload ownership, private persistence and asynchronous index admission. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutputStore } from "../../../media/src/index.ts";
import { defaults } from "@plur1bus/config-schema";
import { createChannelUploadService } from "../../src/composition/channel-uploads.ts";
import { composeMediaSearch } from "../../src/composition/media-search.ts";
import { deriveUserPrincipal } from "../../src/identity/principals.ts";
import type { ChannelAttachmentIngressInput } from "../../src/channels/switchboard.ts";
import type { MediaRecord } from "../../src/media-search/hook.ts";
import type { Principal } from "../../src/rbac/types.ts";
import { FakePort } from "./fakes.ts";
import { silentLogger } from "@plur1bus/module-api";
import { makeRig } from "../channels/switchboard-rig.ts";
import { FAILED_TEXT } from "../../src/channels/router.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aW5kAAAAASUVORK5CYII=", "base64");
const person = (): Principal => ({ kind: "person", userId: "alice", role: "member", agentRights: { main: "use" } });
const input = (): ChannelAttachmentIngressInput => {
  const value: Omit<ChannelAttachmentIngressInput, "revalidate"> = {
  humanId: "alice",
  message: { channel: "telegram", chatId: "dm", chatKind: "direct", senderId: "42", text: "beach photo", messageId: "msg-1",
    attachments: [{ kind: "photo", mimeType: "image/png", data: PNG, filename: "../beach.png" }] },
  session: { id: "session", kind: "channel", agentId: "main", owner: deriveUserPrincipal("alice"), scope: "agent",
    chatKey: "chat", title: "", pinned: false, memoryMode: "remember", createdAt: 1, updatedAt: 1,
    lastTurnAt: null, archivedAt: null, turnCount: 0 },
  };
  return { ...value, revalidate: async () => value.session };
};

describe("authenticated channel uploads", () => {
  for (const mode of ["incognito", "archive", "unlink"] as const) {
    it(`rolls back a real channel upload when ${mode} changes during storage`, { timeout: 5_000 }, async () => {
      const home = await mkdtemp(join(tmpdir(), "mm-channel-race-"));
      let begin!: () => void;
      let release!: () => void;
      const entered = new Promise<void>(resolve => { begin = resolve; });
      const blocked = new Promise<void>(resolve => { release = resolve; });
      class BlockedStore extends OutputStore {
        override async putUploaded(request: Parameters<OutputStore["putUploaded"]>[0]) {
          begin();
          await blocked;
          return super.putUploaded(request);
        }
      }
      const store = new BlockedStore(join(home, "media", "outputs"));
      const seen: string[] = [];
      let humanId = "";
      const service = createChannelUploadService({ home, store, signal: new AbortController().signal, hasAgent: () => true,
        person: () => ({ ...person(), userId: humanId }),
        hook: { onStored() {}, onDeleted() {}, async idle() {}, onUploaded(r) { seen.push(r.mediaId); } } });
      const rig = makeRig({ switchboard: { ingestAttachments: service } });
      try {
        rig.secrets.put("channels.discord.token", "unit-test-token-0123456789");
        rig.config.set("discord", { enabled: true });
        await rig.switchboard.start();
        await rig.clock.advance(0);
        humanId = rig.link("discord", "bot-1", "sender-1").humanId;
        const pending = rig.adapter().host!.receive({ channel: "discord", chatId: "chat-1", chatKind: "direct",
          senderId: "sender-1", text: "", attachments: [{ kind: "image", mimeType: "image/png", data: PNG }] });
        await entered;
        const session = rig.store.activeForChat("discord:chat-1")!;
        if (mode === "incognito") rig.store.updateSession(session.id, { memoryMode: "incognito" });
        if (mode === "archive") rig.store.archiveSession(session.id);
        if (mode === "unlink") {
          const link = rig.identity.list({}).humans.find(h => h.id === humanId)!.identities[0]!;
          rig.identity.unlink({ linkId: link.id }, { user: humanId, host: "test", kind: "person", role: "member" });
        }
        release();
        await pending;
        assert.deepEqual(seen, []);
        assert.deepEqual(await readdir(join(store.root, ".uploads")), []);
        assert.deepEqual(rig.adapter().sent.map(m => m.text), [FAILED_TEXT]);
      } finally {
        release();
        rig.close();
        await rm(home, { recursive: true, force: true });
      }
    });
  }

  it("publishes a private owner with host provenance before exactly one upload hook", async t => {
    const home = await mkdtemp(join(tmpdir(), "mm-channel-upload-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    const store = new OutputStore(join(home, "media", "outputs"));
    const seen: MediaRecord[] = [];
    const upload = createChannelUploadService({ home, store, person: person, hasAgent: id => id === "main", signal: new AbortController().signal,
      hook: { onStored() { assert.fail("uploads must not become generated media"); }, onDeleted() {}, async idle() {}, onUploaded(record) {
        const owner = JSON.parse(readFileSync(join(home, "media", "owners", `${record.mediaId}.json`), "utf8"));
        assert.equal(owner.userId, "alice");
        assert.equal(owner.agentId, "main");
        assert.equal(owner.chatKind, "direct");
        assert.equal(owner.owner, deriveUserPrincipal("alice"));
        assert.equal(owner.provenance.origin.system, "channel:telegram");
        assert.equal(owner.provenance.origin.principal, "alice");
        assert.equal(owner.provenance.origin.trust, "untrusted");
        seen.push(record);
      } } });
    await upload(input());
    assert.equal(seen.length, 1);
    const record = seen[0]!;
    assert.equal(record.agentId, "main");
    assert.equal(record.userCaption, "beach photo");
    assert.equal(record.prompt, undefined);
    assert.ok("path" in record.source);
    assert.deepEqual(await readFile(record.source.path), PNG);
    assert.equal((await store.getUploaded(record.mediaId))?.manifest.kind, "image");
    assert.equal(await store.get(record.mediaId), null);
    if (process.platform !== "win32") {
      assert.equal((await stat(record.source.path)).mode & 0o777, 0o600);
      assert.equal((await stat(join(home, "media", "owners", `${record.mediaId}.json`))).mode & 0o777, 0o600);
    }
  });

  it("rechecks current rights and the session binding before any bytes are saved", async t => {
    const home = await mkdtemp(join(tmpdir(), "mm-channel-denied-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    const store = new OutputStore(join(home, "media", "outputs"));
    let current: Principal | null = null;
    const upload = createChannelUploadService({ home, store, person: () => current, hasAgent: () => true, signal: new AbortController().signal,
      hook: { onStored() {}, onDeleted() {}, async idle() {}, onUploaded() { assert.fail("denied upload indexed"); } } });
    for (const p of [null, { kind: "person", userId: "alice", role: "member" }, { ...person(), userId: "bob" }] as const) {
      current = p;
      await assert.rejects(upload(input()), { error: "E_DENIED" });
    }
    current = person();
    const wrongOwner = input(); wrongOwner.session.owner = deriveUserPrincipal("bob");
    await assert.rejects(upload(wrongOwner), { error: "E_DENIED" });
    const incognito = input(); incognito.session.memoryMode = "incognito";
    await assert.rejects(upload(incognito), { error: "E_DENIED" });
    assert.deepEqual(await readdir(home), []);
  });

  it("removes unpublished upload bytes if the private owner record cannot be written", async t => {
    const home = await mkdtemp(join(tmpdir(), "mm-channel-rollback-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    const store = new OutputStore(join(home, "media", "outputs"));
    const records: MediaRecord[] = [];
    const upload = createChannelUploadService({ home, store, person: person, hasAgent: () => true, signal: new AbortController().signal,
      hook: { onStored() {}, onDeleted() {}, async idle() {}, onUploaded(r) { records.push(r); } } });
    await store.recoverStaging();
    await writeFile(join(home, "media", "owners"), "not a directory");
    await assert.rejects(upload(input()), { error: "E_STORAGE" });
    assert.deepEqual(records, []);
    assert.deepEqual(await readdir(join(store.root, ".uploads")), []);
  });

  it("returns with stored bytes while a real background hook is waiting on its encoder", async t => {
    const home = await mkdtemp(join(tmpdir(), "mm-channel-background-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    const config = defaults();
    config.memory.mediaEmbedding.backfill = "manual";
    const store = new OutputStore(join(home, "media", "outputs"));
    const port = new FakePort();
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    port.indexImpl = async () => { await blocked; return { state: "indexed", segments: 1 }; };
    const composition = await composeMediaSearch({ home, store, config: () => config, engine: {}, budget: null, testPort: port,
      agents: { workspaceOf: () => home }, logger: silentLogger() });
    t.after(async () => { release(); await composition.close(); });
    const upload = createChannelUploadService({ home, store, person: person, hasAgent: () => true,
      signal: new AbortController().signal, hook: composition.hook });
    await upload(input());
    // Reaching here is the invariant: no release is possible until ingress has returned.
    release();
    await composition.hook.idle();
    assert.equal(port.indexed.length, 1);
    assert.equal(port.indexed[0]?.scope.agentId, "main");
  });
});
