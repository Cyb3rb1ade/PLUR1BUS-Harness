import { createApi, type Api } from "../../api/index.ts";
import type { PageStateKind } from "../../components/page-state.ts";
import { formatDateTime, formatNumber, lang, t, type Key } from "../../i18n.ts";
import { initSession } from "../../session.ts";
import type { Limit } from "./model.ts";
import type { BudgetMetric } from "./rpc-types.ts";

let api: Api | undefined;
/** The page's API client (same origin, session cookie); a call that finds the session gone re-checks it, which sends the shell to sign-in. */
export function budgetApi(): Api {
  api ??= createApi({ onUnauthenticated: () => { void initSession(); } });
  return api;
}

export type FailState = Extract<PageStateKind, "error" | "forbidden" | "unavailable">;
const kindOf = (e: unknown): unknown => (typeof e === "object" && e !== null ? (e as { kind?: unknown }).kind : undefined);
/** E_DENIED/403 -> forbidden, route or core absent -> unavailable, anything else -> error. */
export const failState = (e: unknown): FailState => (kindOf(e) === "forbidden" ? "forbidden" : kindOf(e) === "unavailable" ? "unavailable" : "error");
export const isForbidden = (e: unknown): boolean => kindOf(e) === "forbidden";
export const isAborted = (e: unknown): boolean => kindOf(e) === "aborted";

export function money(micros: number): string {
  return new Intl.NumberFormat(lang.value, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(micros / 1_000_000);
}
/** Cost is micro-USD, tokens are plain counts. */
export const amount = (metric: BudgetMetric, n: number): string => (metric === "cost" ? money(n) : formatNumber(n));

export function when(iso: string): string {
  const d = new Date(iso);
  return iso === "" || Number.isNaN(d.getTime()) ? "–" : formatDateTime(d);
}

export function limitTitle(l: Pick<Limit, "period" | "metric">): string {
  const key = `budget.title.${l.period}${l.metric === "cost" ? "Cost" : "Tokens"}`;
  return t(key as Key);
}
/** Title with the agent for a button label: "Daily cost (main)". */
export const fullTitle = (l: Pick<Limit, "period" | "metric" | "agentId" | "scope">): string =>
  l.scope === "agent" && l.agentId ? t("budget.dlg.forAgent", { title: limitTitle(l), agent: l.agentId }) : limitTitle(l);

export const limitKey = (l: Pick<Limit, "scope" | "agentId" | "period" | "metric">): string => `${l.scope}/${l.agentId ?? ""}/${l.period}/${l.metric}`;
