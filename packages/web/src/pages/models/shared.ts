import { createApi, type Api } from "../../api/index.ts";
import { formatDateTime, t, type Key } from "../../i18n.ts";
import { initSession } from "../../session.ts";
import type { PageStateKind } from "../../components/page-state.ts";
import type { ModelKind, ModelScanOutcomeCode } from "./rpc-types.ts";

let api: Api | undefined;
/** The page's API client (same origin, session cookie). A call that finds the session gone re-checks it, which sends the
 *  shell to the sign-in page. Created lazily so that importing the page does not touch `fetch`. */
export function modelsApi(): Api {
  api ??= createApi({ onUnauthenticated: () => { void initSession(); } });
  return api;
}

export type FailState = Extract<PageStateKind, "error" | "forbidden" | "unavailable">;
/** Which page state a failed call maps to: E_DENIED/403 -> forbidden, route or core absent -> unavailable, anything else -> error. */
export function failState(e: unknown): FailState {
  const kind = typeof e === "object" && e !== null ? (e as { kind?: unknown }).kind : undefined;
  return kind === "forbidden" ? "forbidden" : kind === "unavailable" ? "unavailable" : "error";
}
export const isForbidden = (e: unknown): boolean => failState(e) === "forbidden";
export const isAborted = (e: unknown): boolean => typeof e === "object" && e !== null && (e as { kind?: unknown }).kind === "aborted";

export function when(iso: string | undefined): string {
  if (!iso) return t("models.unknown");
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? t("models.unknown") : formatDateTime(d);
}

export function outcomeText(code: ModelScanOutcomeCode): string {
  switch (code) {
    case "ok": return t("models.outcome.ok");
    case "failed:auth": return t("models.outcome.failedAuth");
    case "failed:network": return t("models.outcome.failedNetwork");
    case "failed:server": return t("models.outcome.failedServer");
    case "failed:invalid": return t("models.outcome.failedInvalid");
    case "failed:empty": return t("models.outcome.failedEmpty");
    case "already_running": return t("models.outcome.alreadyRunning");
    case "disabled": return t("models.outcome.disabled");
    case "no-scanner": return t("models.outcome.noScanner");
  }
}

export function kindText(k: ModelKind): string {
  switch (k) {
    case "chat": return t("models.kind.chat");
    case "embedding": return t("models.kind.embedding");
    case "tts": return t("models.kind.tts");
    case "asr": return t("models.kind.asr");
    case "image": return t("models.kind.image");
    case "moderation": return t("models.kind.moderation");
    case "rerank": return t("models.kind.rerank");
    case "realtime": return t("models.kind.realtime");
    case "unknown": return t("models.kind.unknown");
  }
}

const camel = (s: string): string => s.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
/** i18n text of a capability id (`audio_in` -> models.cap.audioIn). */
export const capText = (c: string): string => t(`models.cap.${camel(c)}` as Key);
/** i18n text of a scan warning (`role_unavailable` -> models.warn.roleUnavailable). */
export const warnText = (code: string, p: Record<string, string>): string => t(`models.warn.${camel(code)}` as Key, p);
