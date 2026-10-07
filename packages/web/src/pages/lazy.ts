// Lazy page loading: a page module is fetched with a dynamic import() the first time its route opens (esbuild splitting puts
// it into its own chunk next to main.js; same origin, so the strict CSP `script-src 'self'` holds). Until it is there the
// page frame shows its heading and the loading state; a failed load shows the error state with "Try again". The ErrorBoundary
// of the shell stays around this for render errors.
import { h } from "preact";
import { useLayoutEffect, useEffect, useRef, useState } from "preact/hooks";
import { Page } from "../components/page.ts";
import { PageLoading, PageState } from "../components/page-state.ts";
import { t } from "../i18n.ts";
import type { View } from "../view.ts";
import type { PageComponent, PageProps } from "./registry.ts";

export function lazyPage(load: () => Promise<PageComponent>): PageComponent {
  let loaded: PageComponent | undefined;
  let inflight: Promise<PageComponent> | undefined;
  const start = (): Promise<PageComponent> => {
    inflight ??= load().then((c) => { loaded = c; return c; }, (e: unknown) => { inflight = undefined; throw e; });
    return inflight;
  };

  return function LazyPage(props: PageProps): View {
    const [comp, setComp] = useState<PageComponent | undefined>(() => loaded);
    const [failed, setFailed] = useState(false);
    const [attempt, setAttempt] = useState(0);
    const headingHadFocus = useRef(false);

    useEffect(() => {
      if (comp) return;
      let live = true;
      setFailed(false);
      start().then((c) => { if (live) setComp(() => c); }, () => {
        if (!live) return;
        // Browsers may remember a failed import() of the same URL (and after a deploy the old main.js names chunks that are
        // gone): when "Try again" fails as well, a reload fetches a fresh main.js and tries once more from scratch.
        if (attempt > 0) { location.reload(); return; }
        setFailed(true);
      });
      return () => { live = false; };
    }, [attempt]);

    // While the frame stands in for the page, remember whether the shell put focus on its heading (it does that on
    // navigation); the loaded page has a new heading and takes the focus over.
    useEffect(() => {
      if (!comp) headingHadFocus.current = document.activeElement?.tagName === "H1" && document.activeElement.closest("main") !== null;
    });
    useLayoutEffect(() => {
      if (comp && headingHadFocus.current) {
        headingHadFocus.current = false;
        document.querySelector<HTMLElement>("main h1")?.focus();
      }
    }, [comp]);

    if (comp) return h(comp, props);
    const title = t(props.item.label);
    return h(Page, { title, width: "full" },
      failed ? h(PageState, { state: "error", onRetry: () => { setAttempt((n) => n + 1); } }) : h(PageLoading, { label: t("state.loading") }));
  };
}
