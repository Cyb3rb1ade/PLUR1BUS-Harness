import type { PageStateKind } from "../../components/page-state.ts";
import { formatDateTime, formatNumber, t, type Key } from "../../i18n.ts";
import type { Limit } from "./model.ts";

export type FailState = Extract<PageStateKind, "error" | "forbidden" | "unavailable">;
const kindOf = (e: unknown): unknown => (typeof e === "object" && e !== null ? (e as { kind?: unknown }).kind : undefined);
/** E_DENIED/403 -> forbidden, route or core absent -> unavailable, anything else -> error. */
export const failState = (e: unknown): FailState => (kindOf(e) === "forbidden" ? "forbidden" : kindOf(e) === "unavailable" ? "unavailable" : "error");
export const isForbidden = (e: unknown): boolean => kindOf(e) === "forbidden";
export const isAborted = (e: unknown): boolean => kindOf(e) === "aborted";

/** Bounds and use are token counts (input + output); there is no money dimension. */
export const amount = (n: number): string => formatNumber(n);

export function when(iso: string): string {
  const d = new Date(iso);
  return iso === "" || Number.isNaN(d.getTime()) ? "–" : formatDateTime(d);
}

export function limitTitle(l: Pick<Limit, "period" | "metric">): string {
  return t(`budget.title.${l.period}Tokens` as Key);
}
/** Title with the agent for a button label: "Daily tokens (main)". */
export const fullTitle = (l: Pick<Limit, "period" | "metric" | "agentId" | "scope">): string =>
  l.scope === "agent" && l.agentId ? t("budget.dlg.forAgent", { title: limitTitle(l), agent: l.agentId }) : limitTitle(l);

export const limitKey = (l: Pick<Limit, "scope" | "agentId" | "period" | "metric">): string => `${l.scope}/${l.agentId ?? ""}/${l.period}/${l.metric}`;
