// Doctor / status page (`#/doctor`). Live data: GET /api/v1/health and GET /api/v1/agents (real routes), core.status over
// /rpc (assumed, shown as "not available" until served). Re-checks every REFRESH_MS while the tab is visible; the timer
// and any request in flight end with the page. A lost session hands over to the shell's sign-in, which returns here.
import { h } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { isApiError, type Api } from "../../api/index.ts";
import { getApi } from "../../api/shared.ts";
import { Page } from "../../components/page.ts";
import { PageLoading, PageState } from "../../components/page-state.ts";
import { lang, t } from "../../i18n.ts";
import { sessionNotice, sessionState } from "../../session.ts";
import type { View } from "../../view.ts";
import { loadSnapshot, type Snapshot } from "./data.ts";
import { ProvisioningCard } from "./provisioning.ts";
import { AgentsCard, Banner, CoreCard, HealthCard } from "./views.ts";
import { registerArea } from "../../i18n/index.ts";
import * as doctorArea from "../../i18n/doctor.ts";
import "../../styles/doctor.css";

registerArea("doctor", doctorArea);

export const REFRESH_MS = 30_000;

type Doctor = { snap: Snapshot | null; busy: boolean; announce: string; recheck: () => void };

function useDoctor(api: Api): Doctor {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(true);
  const [announce, setAnnounce] = useState("");
  const trigger = useRef<(manual: boolean) => void>(() => {});

  useEffect(() => {
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    let last = 0;
    const stop = (): void => { if (timer !== undefined) { clearTimeout(timer); timer = undefined; } };
    const schedule = (delay: number): void => {
      stop();
      if (!ctl.signal.aborted && !document.hidden) timer = setTimeout(() => { void go(false); }, delay);
    };
    const go = async (manual: boolean): Promise<void> => {
      if (running || ctl.signal.aborted) return;
      running = true;
      stop();
      setBusy(true);
      let again = true;
      try {
        const s = await loadSnapshot(api, ctl.signal);
        if (ctl.signal.aborted) return;
        last = Date.now();
        setSnap(s);
        if (manual) setAnnounce(t("doctor.lastChecked", { time: new Intl.DateTimeFormat(lang.value, { timeStyle: "medium" }).format(new Date(last)) }));
      } catch (e) {
        if (ctl.signal.aborted) return;
        if (isApiError(e) && (e.kind === "unauthenticated" || e.kind === "session-expired")) {
          again = false;
          sessionNotice.value = "expired";
          sessionState.value = { status: "anonymous" };
        }
      } finally {
        running = false;
        if (!ctl.signal.aborted) { setBusy(false); if (again) schedule(REFRESH_MS); }
      }
    };
    const onVisibility = (): void => {
      if (document.hidden) { stop(); return; }
      if (running) return;
      const age = Date.now() - last;
      if (last === 0 || age >= REFRESH_MS) void go(false); else schedule(REFRESH_MS - age);
    };
    document.addEventListener("visibilitychange", onVisibility);
    trigger.current = (manual) => { void go(manual); };
    void go(false);
    return () => { ctl.abort(); stop(); document.removeEventListener("visibilitychange", onVisibility); };
  }, [api]);

  return { snap, busy, announce, recheck: () => { trigger.current(true); } };
}

function healthCard(hp: Snapshot["health"]): View | null {
  if (hp.kind === "ok") return h(HealthCard, { health: hp.value, down: hp.value.status === "down" });
  return hp.kind === "down" && hp.body !== null ? h(HealthCard, { health: hp.body, down: true }) : null;
}

export function DoctorPage(): View {
  const api = useMemo(() => getApi(), []);
  const { snap, busy, announce, recheck } = useDoctor(api);
  const lastChecked = snap ? t("doctor.lastChecked", { time: new Intl.DateTimeFormat(lang.value, { timeStyle: "medium" }).format(new Date(snap.at)) }) : "";

  return h(Page, { title: t("nav.doctor"), lead: t("doctor.lead"), width: "full" },
    h("p", null,
      h("button", { type: "button", class: "btn btn-primary", ...(busy ? { "aria-disabled": "true" } : {}), onClick: () => { if (!busy) recheck(); } }, t("doctor.recheck")),
      " ", h("span", null, busy ? t("doctor.checking") : lastChecked),
      // Read out only after a check the user asked for; the automatic ones stay silent.
      h("span", { class: "sr-only", role: "status" }, announce)),
    h("p", { class: "reading" }, t("doctor.auto", { seconds: REFRESH_MS / 1000 })),
    snap === null ? h(PageLoading, { label: t("state.loading") })
      : snap.health.kind === "forbidden" ? h(PageState, { state: "forbidden" })
      : h("div", null,
          h(Banner, { snap }),
          healthCard(snap.health),
          h(CoreCard, { core: snap.core }),
          h(AgentsCard, { agents: snap.agents })),
    h(ProvisioningCard, {}));
}
