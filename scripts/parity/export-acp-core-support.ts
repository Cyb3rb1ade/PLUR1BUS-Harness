// Helpers of the Core-backed ACP scenarios: wire events, scripted Core answers and approval records.
import { line, uuids } from "./export-acp-support.ts";

export type Rpc = Record<string, any>;
export const PLAIN = ["session.create", "session.submit", "session.events", "session.cancel"];
export const CODE = [...PLAIN, "session.archive", "code.session.open", "code.session.mode"];
export const QUEUE = [...PLAIN, "session.queue.list"];
export const APPR = ["approval.list", "approval.get", "approval.decide", "approval.cancel"];

export const okj = (v: unknown) => ({ okJson: JSON.stringify(v) });
export const E = (seq: number, type: string, data: unknown, turnId: string | null = "t1") => ({ seq, turnId, type, data });
export const page = (events: unknown[], running = true) => ({ events, running });
export const completed = page([E(1, "turn.completed", {})]);
const isItem = (p: any) => p && typeof p === "object" && ("okJson" in p || "err" in p || "gate" in p);
const rep = (item: unknown) => ({ ...(item as object), repeat: true });

/** A scripted Core: defaults answer every `session.*` call so a scenario only states what it varies. */
export function rpcOf(o: { methods?: string[]; pages: unknown[]; create?: unknown[]; submit?: unknown[]; cancel?: unknown[]; open?: unknown[]; mode?: unknown[]; archive?: unknown[]; approvals?: Record<string, unknown[]> }): Rpc {
  const calls: Record<string, unknown[]> = {
    "session.create": o.create ?? [rep(okj({ session: { id: "c1" } }))],
    "session.submit": o.submit ?? [rep(okj({ turnId: "t1" }))],
    "session.events": o.pages.map((p) => (isItem(p) ? p : okj(p))),
    "session.cancel": o.cancel ?? [rep(okj({}))],
    "session.archive": o.archive ?? [rep(okj({}))],
    "code.session.open": o.open ?? [rep(okj({ state: "open", root: "/work" }))],
    "code.session.mode": o.mode ?? [rep(okj({ mode: "chat", changed: false }))],
  };
  for (const [k, v] of Object.entries(o.approvals ?? {})) calls[`approval.${k}`] = v;
  return { methods: o.methods ?? PLAIN, calls };
}

/** An approval record of the scripted Core; `undefined` members vanish in JSON like absent ones. */
export const rec = (over: Record<string, unknown> = {}) => ({
  id: "ap1", status: "pending", sessionId: "c1", turnId: "t1", subject: { kind: "agent", id: "bernd" }, capability: "fs.write", tool: "file.write",
  actionHash: "h1", summary: "Write a.txt", requiredSurface: 1, grantOptions: [{ scope: "once", requiredSurface: 1 }, { scope: "session", requiredSurface: 1 }], ...over,
});
export const ap = rec;

/** The id of the k-th permission request the server issues (the scenario carries `ids`). */
export const pid = (k: number) => `acp-permission-${uuids(k)[k - 1]}`;
export const pick = (k: number, optionId: unknown) => line({ jsonrpc: "2.0", id: pid(k), result: { outcome: { outcome: "selected", optionId } } });
