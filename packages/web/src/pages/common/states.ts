// Shared failure and notice pieces for the M3 part 2 pages. `FailureState` maps a failed area onto the shared page states with
// neutral wording (the Memories page has its own, with its own words); `Notice` is the inline variant for a single function that
// this harness does not serve while the rest of the page works.
import { h, type ComponentChildren } from "preact";
import type { View } from "../../view.ts";
import { PageState } from "../../components/page-state.ts";
import { t } from "../../i18n.ts";
import type { Failure } from "./load.ts";

export type FailureStateProps = {
  failure: Failure;
  /** Title of the "not served" state, e.g. t("agents.unavailable.title"). Defaults to the generic one. */
  unavailable?: string;
  /** Title of the not-found state (only used when the failure is a not-found). */
  notFound?: string;
  onRetry?: () => void;
};

/** One mapping of a failed area onto the shared page states: unavailable, forbidden, not found (empty), error with a retry button. */
export function FailureState({ failure, unavailable, notFound, onRetry }: FailureStateProps): View {
  const retry = onRetry ? { onRetry } : {};
  switch (failure.kind) {
    case "unavailable": return h(PageState, { state: "unavailable", ...(unavailable ? { title: unavailable } : {}), detail: t("shared.unavailable.detail"), ...retry });
    case "forbidden": return h(PageState, { state: "forbidden" });
    case "not-found": return h(PageState, { state: "empty", ...(notFound ? { title: notFound } : {}), detail: t("shared.notFound.detail") });
    default: return h(PageState, { state: "error", ...retry });
  }
}

export type NoticeProps = { tone?: "info" | "warn"; children?: ComponentChildren };

/** An inline note ("Not available on this harness yet."). A polite status region, so the text is announced when it appears. */
export function Notice({ tone = "info", children }: NoticeProps): View {
  return h("p", { class: "form-notice", "data-tone": tone, role: "status" }, children);
}

/** The standard one-line note for a function without an RPC on this harness. */
export function UnavailableNote({ what }: { what?: string }): View {
  return h(Notice, {}, what ? t("shared.unavailable.what", { what }) : t("shared.unavailable.inline"));
}
