import { h, type ComponentChildren } from "preact";
import type { View } from "../view.ts";
import { t } from "../i18n.ts";
import { icon, type IconName } from "../icons.ts";

export type PageStateKind = "loading" | "empty" | "error" | "forbidden" | "unavailable";

export type PageStateProps = {
  state: PageStateKind;
  /** Override the default title / detail text of the state (i18n them at the call site). */
  title?: string;
  detail?: string;
  /** Shows a "Try again" button. */
  onRetry?: () => void;
  /** Extra actions (e.g. a "Create" button for an empty list). */
  children?: ComponentChildren;
};

const ICON: Record<Exclude<PageStateKind, "loading">, IconName> = { empty: "inbox", error: "alert", forbidden: "lock", unavailable: "unavailable" };

/** Loading indicator: a polite live region, marked busy, so assistive technology announces it without stealing focus. */
export function PageLoading({ label }: { label?: string }): View {
  return h("div", { class: "page-state", "data-state": "loading", role: "status", "aria-live": "polite", "aria-busy": "true" },
    h("span", { class: "spinner", "aria-hidden": "true" }),
    h("p", { class: "state-title" }, label ?? t("state.loading")));
}

/** One layout for every non-content state of a page: loading, empty, error, forbidden, unavailable.
 *  h(PageState, { state: "error", onRetry: reload })   h(PageState, { state: "empty", title: t("models.none") }, createButton) */
export function PageState({ state, title, detail, onRetry, children }: PageStateProps): View {
  if (state === "loading") return h(PageLoading, title === undefined ? {} : { label: title });
  return h("div", { class: "page-state", "data-state": state, ...(state === "error" ? { role: "alert" } : {}) },
    h("span", { class: "state-icon" }, icon(ICON[state], 28)),
    h("h2", { class: "state-title" }, title ?? t(`state.${state}.title`)),
    h("p", { class: "state-body" }, detail ?? t(`state.${state}.body`)),
    onRetry || children
      ? h("div", { class: "state-actions" }, onRetry ? h("button", { type: "button", class: "btn", onClick: onRetry }, t("state.retry")) : null, children)
      : null);
}
