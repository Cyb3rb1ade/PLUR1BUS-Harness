/** Shared-room membership permits conversation; rewind authority comes from the stored owner or live global role. */
import type { Role } from "../rbac/types.ts";
import { deriveUserPrincipal } from "../identity/principals.ts";
import { RpcError } from "../rpc/errors.ts";
import { isRewindCommand } from "../session/rewind.ts";
import type { ChatKind } from "./types.ts";

const DENIED = {
  de: "Nur die Person, der dieses Gespräch gehört, oder Owner/Admin darf hier zurückspulen.",
  en: "Only the owner of this conversation or an Owner/Admin can rewind it.",
} as const;

/** The typed Core refusal has a bounded public explanation; arbitrary error messages never become replies. */
export function rewindDeniedReply(error: unknown, locale: "de" | "en"): string | undefined {
  return error instanceof RpcError && error.error === "E_DENIED" && error.reason === "rewind-not-allowed"
    ? DENIED[locale] : undefined;
}

export function requireRewindSender(input: { text: string; chatKind: ChatKind | undefined; owner: string; person: string; role?: Role }): void {
  if (input.chatKind === "direct" || !isRewindCommand(input.text)) return;
  if (input.owner === deriveUserPrincipal(input.person) || input.role === "owner" || input.role === "admin") return;
  throw new RpcError("E_DENIED", "rewind in a shared channel requires the session owner or an Owner/Admin", { reason: "rewind-not-allowed" });
}
