// The durable break-glass notices (`admin_notices`, F41) stay the fail-closed record behind `breakglass.notices`. This copies
// them into the inbox once, keyed by grant id, so nothing a person was told before the inbox existed is lost.
import type { BreakGlassNotice } from "../rbac/break-glass.ts";
import type { InboxDraft, InboxStore } from "./store.ts";

/** Metadata only: the reason text stays in `breakglass.notices` and is not copied. */
export function breakglassDraft(n: BreakGlassNotice): InboxDraft {
  return {
    userId: n.userId, kind: "breakglass", severity: "critical", titleKey: "inbox.breakglass.granted",
    params: { holderUserId: n.holderUserId, expiresAt: n.expiresAt }, ref: { route: "/inbox", objectId: n.grantId }, dedupeKey: `breakglass:${n.grantId}`,
  };
}
/** Returns how many notices were new to the inbox. */
export function migrateBreakglassNotices(store: InboxStore, notices: readonly BreakGlassNotice[]): number {
  let created = 0;
  for (const n of notices) if (store.publish(breakglassDraft(n)).created) created++;
  return created;
}
