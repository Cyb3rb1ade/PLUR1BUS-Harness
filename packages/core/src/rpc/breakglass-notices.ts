// The durable self-scoped inbox is authoritative. Live RPC delivery uses the existing all-audience fail-closed rule.
import type { BreakGlassNotice } from "../rbac/break-glass.ts";
import type { Principal } from "../rbac/types.ts";
export async function deliverBreakglassNotice(notice: BreakGlassNotice, d: {
  subscriptions: () => readonly { connectionId: string; names?: readonly string[] }[];
  principalOf: (connectionId: string) => Promise<Principal | null | undefined>;
  notify: (method: string, params: object, options: { optIn: true }) => void;
  stopped: () => boolean;
}): Promise<boolean> {
  if (d.stopped()) return false;
  const connections = [...new Set(d.subscriptions().filter(s => s.names?.includes("breakglass.notice")).map(s => s.connectionId))];
  if (!connections.length) return false;
  for (const id of connections) {
    const p = await d.principalOf(id);
    if (!p || p.kind !== "person" || p.userId !== notice.userId) return false;
  }
  if (d.stopped()) return false;
  d.notify("breakglass.notice", { notice }, { optIn: true });
  return true;
}
