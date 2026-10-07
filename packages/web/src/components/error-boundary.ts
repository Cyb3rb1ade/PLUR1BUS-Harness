import { Fragment, h, type ComponentChildren } from "preact";
import { useErrorBoundary, useLayoutEffect, useRef } from "preact/hooks";
import type { View } from "../view.ts";
import { Page } from "./page.ts";
import { PageState } from "./page-state.ts";

/** Catches a render error in its subtree and shows the error state with "Try again" instead of a blank screen.
 * `title` is the page heading shown by the fallback (the failed page's own <h1> is gone). Retry calls `onReset` (reset the
 * failed state) and then re-renders the children. The shell keys one boundary per page, so navigating away resets it.
 *  h(ErrorBoundary, { title: t("nav.models") }, h(ModelsPage, {})) */
export function ErrorBoundary({ title, onReset, children }: { title: string; onReset?: () => void; children?: ComponentChildren }): View {
  const [error, reset] = useErrorBoundary((e) => { console.error("page failed to render", e); });
  const box = useRef<HTMLDivElement>(null);
  const failed = error !== undefined;
  // The page heading the user was on has vanished: put focus on the fallback's heading.
  useLayoutEffect(() => { if (failed) box.current?.querySelector<HTMLElement>("h1")?.focus(); }, [failed]);
  if (!failed) return h(Fragment, null, children);
  return h("div", { ref: box }, h(Page, { title }, h(PageState, { state: "error", onRetry: () => { onReset?.(); reset(); } })));
}
