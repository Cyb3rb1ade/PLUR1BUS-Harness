// Lazy loading for a part of a page (a Settings section, a Logs tab): the module is fetched with a dynamic import() the first time
// it is shown (one chunk, same origin, so the strict CSP holds). Until then a loading state; a failed load shows the error state with
// "Try again". The page-level equivalent is ../lazy.ts.
import { h } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { PageLoading, PageState } from "../../components/page-state.ts";
import { t } from "../../i18n.ts";

export function lazySection<P extends object>(load: () => Promise<(props: P) => View | null>): (props: P) => View {
  let loaded: ((props: P) => View | null) | undefined;
  let inflight: Promise<(props: P) => View | null> | undefined;
  const start = (): Promise<(props: P) => View | null> => {
    inflight ??= load().then((c) => { loaded = c; return c; }, (e: unknown) => { inflight = undefined; throw e; });
    return inflight;
  };

  return function LazySection(props: P): View {
    const [comp, setComp] = useState<((p: P) => View | null) | undefined>(() => loaded);
    const [failed, setFailed] = useState(false);
    const [attempt, setAttempt] = useState(0);
    useEffect(() => {
      if (comp) return;
      let live = true;
      setFailed(false);
      start().then((c) => { if (live) setComp(() => c); }, () => { if (live) setFailed(true); });
      return () => { live = false; };
    }, [attempt]);
    if (comp) return h(comp, props);
    return failed ? h(PageState, { state: "error", onRetry: () => { setAttempt((n) => n + 1); } }) : h(PageLoading, { label: t("state.loading") });
  };
}
