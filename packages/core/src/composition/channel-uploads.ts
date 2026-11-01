/** Authenticated channel uploads: private byte persistence and owner publication before background indexing. */
import type { OutputStore } from "../../../media/src/index.ts";
import type { ChannelAttachmentIngressInput } from "../channels/switchboard.ts";
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES } from "../channels/router.ts";
import type { MediaIndexHook } from "../media-search/hook.ts";
import type { Principal } from "../rbac/types.ts";
import { authorize } from "../rbac/authorize.ts";
import { deriveUserPrincipal } from "../identity/principals.ts";
import { atomicJson } from "../../../media/src/files.ts";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { UploadedMedia } from "../../../media/src/index.ts";
import type { MediaKind } from "../media-search/types.ts";
import { RpcError } from "../rpc/errors.ts";

/** Trusted current host services; no upload field supplies authorization or a path. */
export interface ChannelUploadDeps {
  home: string;
  store: OutputStore;
  hook: MediaIndexHook;
  person: (id: string) => Principal | null;
  hasAgent: (id: string) => boolean;
  signal: AbortSignal;
}

/** Save one admitted message's attachments; captioning and embedding are only enqueued. */
export function createChannelUploadService(deps: ChannelUploadDeps) {
  const check = async (input: ChannelAttachmentIngressInput): Promise<void> => {
    deps.signal.throwIfAborted();
    const { humanId, message } = input;
    const session = await input.revalidate();
    deps.signal.throwIfAborted();
    const principal = deps.person(humanId);
    if (!principal || principal.kind !== "person" || principal.userId !== humanId
      || session.id !== input.session.id || session.agentId !== input.session.agentId
      || session.owner !== input.session.owner || session.chatKey !== input.session.chatKey
      || !deps.hasAgent(session.agentId) || session.kind !== "channel" || session.archivedAt !== null
      || session.memoryMode === "incognito"
      || (message.chatKind === "direct" && session.owner !== deriveUserPrincipal(humanId))
      || authorize(principal, "agent.use", { kind: "agent", agentId: session.agentId }).effect !== "allow") {
      throw new RpcError("E_DENIED", "channel upload requires a current person and agent rights");
    }
  };
  return async (input: ChannelAttachmentIngressInput): Promise<void> => {
    await check(input);
    const attachments = input.message.attachments ?? [];
    if (!attachments.length) return;
    if (attachments.length > MAX_ATTACHMENTS
      || attachments.reduce((sum, a) => sum + a.data.byteLength, 0) > MAX_ATTACHMENT_BYTES) {
      throw new RpcError("E_INVALID_PARAMS", "channel attachments exceed the ingress limit");
    }
    const pending = attachments.map(attachment => {
      const family = attachment.mimeType.split("/", 1)[0];
      if (family !== "image" && family !== "audio" && family !== "video") {
        throw new RpcError("E_INVALID_PARAMS", "channel attachment is not a supported medium");
      }
      return { kind: family as MediaKind, mimeType: attachment.mimeType, data: Uint8Array.from(attachment.data),
        ...(attachment.filename ? { filename: attachment.filename } : {}) };
    });
    const stored: UploadedMedia[] = [];
    const ownerPath = (id: string) => join(deps.home, "media", "owners", `${id}.json`);
    try {
      for (const request of pending) {
        await check(input);
        const result = await deps.store.putUploaded(request);
        stored.push(result);
        await check(input);
        await atomicJson(ownerPath(result.manifest.id), {
          agentId: input.session.agentId, userId: input.humanId, connectionId: `channel:${input.session.id}`,
          provenance: { origin: { system: `channel:${input.message.channel}`, agent: null,
            principal: input.humanId, trust: "untrusted" }, hops: 1, transformedBy: [] },
          channel: input.message.channel, sessionId: input.session.id,
          chatKind: input.message.chatKind, owner: input.session.owner,
          ...(input.message.messageId ? { messageId: input.message.messageId } : {}),
        });
      }
      await check(input);
    } catch (error) {
      const cleanup = await Promise.allSettled(stored.map(async result => {
        await deps.store.deleteUploaded(result.manifest.id);
        await rm(ownerPath(result.manifest.id), { force: true });
      }));
      if (cleanup.some(result => result.status === "rejected")) {
        throw new RpcError("E_STORAGE", "channel upload cleanup failed");
      }
      if (error instanceof RpcError || deps.signal.aborted) throw error;
      throw new RpcError("E_STORAGE", "channel attachment could not be saved");
    }
    for (const result of stored) {
      deps.hook.onUploaded({ mediaId: result.manifest.id, kind: result.manifest.kind, mime: result.manifest.mimeType,
        source: { path: result.file }, agentId: input.session.agentId,
        ...(input.message.text.trim() ? { userCaption: input.message.text } : {}) });
    }
  };
}
