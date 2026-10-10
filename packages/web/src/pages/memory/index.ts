// Memories & Dreams (`#/memories`, `#/memories/<cardId>`, `#/memories/dreams`, `#/memories/dreams/<runId>`): the tab and the
// selected card or run live in the URL. Live updates come from /events (job.run, memory.proposal) when that channel exists;
// without it the page says so and "Refresh" does the work.
import { h } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { View } from "../../view.ts";
import type { EventsHandle, SseEvent } from "../../api/index.ts";
import { Page } from "../../components/page.ts";
import { Tabs } from "../../components/tabs.ts";
import { t } from "../../i18n.ts";
import { navigate } from "../../router.ts";
import type { PageProps } from "../registry.ts";
import { getApi } from "./data.ts";
import { DreamsTab } from "./dreams-tab.ts";
import { MemoriesTab } from "./memories-tab.ts";
import "./rpc-types.ts";
import "../../styles/memory.css";

export type MemoriesRoute = { tab: "memories"; id: string | null } | { tab: "dreams"; runId: string | null };

function decode(s: string | undefined): string | null {
  if (s === undefined || s === "") return null;
  try { return decodeURIComponent(s); } catch { return s; }
}

/** `undefined` -> the list; `dreams[/<run>]` -> Dreams; anything else is a card id. "dreams" is reserved and never a card id. */
export function parseSub(sub: string | undefined): MemoriesRoute {
  const [first, ...rest] = (sub ?? "").split("/");
  if (first === "dreams") return { tab: "dreams", runId: decode(rest.join("/")) };
  return { tab: "memories", id: decode(first) };
}

/** The event name an SSE message stands for: its `event:` field, or the JSON-RPC `method` of a notification in `data`. */
export function eventName(ev: SseEvent): string {
  if (ev.event !== "message") return ev.event;
  try { const m = (JSON.parse(ev.data) as { method?: unknown }).method; return typeof m === "string" ? m : ev.event; } catch { return ev.event; }
}

type Live = { status: "connecting" | "open" | "retrying" | "closed" | "unavailable" };

function useLiveEvents(onJob: () => void, onProposal: () => void): Live["status"] | "off" {
  const [handle, setHandle] = useState<EventsHandle | null>(null);
  const cb = useRef({ onJob, onProposal });
  cb.current = { onJob, onProposal };
  useEffect(() => {
    const h2 = getApi().events({ onEvent: (ev) => {
      const name = eventName(ev);
      if (name === "job.run") cb.current.onJob();
      else if (name === "memory.proposal") cb.current.onProposal();
    } });
    setHandle(h2);
    return () => { h2.close(); };
  }, []);
  return handle === null ? "off" : handle.status.value;
}

export function MemoriesPage({ sub }: PageProps): View {
  const route = parseSub(sub);
  const [tick, setTick] = useState(0);
  const [jobTick, setJobTick] = useState(0);
  const [proposalTick, setProposalTick] = useState(0);
  const live = useLiveEvents(() => { setJobTick((n) => n + 1); }, () => { setProposalTick((n) => n + 1); });
  const on = live === "open";

  const refresh = h("button", { type: "button", class: "btn", onClick: () => { setTick((n) => n + 1); } }, t("memory.refresh"));
  return h(Page, { title: t("nav.memories"), width: "full", actions: refresh },
    h("p", { class: "m-muted m-live" }, on ? t("memory.live.on") : live === "connecting" || live === "off" ? t("memory.live.connecting") : t("memory.live.off")),
    h(Tabs, {
      label: t("memory.views"), selected: route.tab,
      onSelect: (id) => { navigate(id === "dreams" ? "/memories/dreams" : "/memories"); },
      tabs: [
        { id: "memories", label: t("memory.tab.memories"), panel: h(MemoriesTab, { selectedId: route.tab === "memories" ? route.id : null, tick, proposalTick }) },
        { id: "dreams", label: t("memory.tab.dreams"), panel: h(DreamsTab, { runId: route.tab === "dreams" ? route.runId : null, tick: tick + jobTick }) },
      ],
    }));
}
