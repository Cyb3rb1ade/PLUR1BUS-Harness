// Logs page (`/logs/<tab>`): the log viewer, the activity feed and the sessions overview as tabs (each a lazy chunk).
import { h } from "preact";
import type { View } from "../../view.ts";
import { Page } from "../../components/page.ts";
import { Tabs } from "../../components/tabs.ts";
import { t } from "../../i18n.ts";
import { navigate } from "../../router.ts";
import { lazySection } from "../common/lazy-section.ts";
import type { PageProps } from "../registry.ts";

type Props = Record<string, unknown>;
const Viewer = lazySection<Props>(() => import("./viewer.ts").then((m) => m.LogViewer));
const Activity = lazySection<Props>(() => import("./activity.ts").then((m) => m.ActivityFeed));
const Sessions = lazySection<Props>(() => import("./sessions.ts").then((m) => m.SessionsOverview));

const TABS = ["logs", "activity", "sessions"] as const;

export function LogsPage({ item, sub }: PageProps): View {
  const selected = TABS.find((x) => x === sub) ?? "logs";
  return h(Page, { title: t(item.label), width: "full" },
    h(Tabs, {
      label: t("logs.tabs"), selected, onSelect: (id: string) => { navigate(id === "logs" ? "/logs" : `/logs/${id}`); },
      tabs: [
        { id: "logs", label: t("logs.tab.logs"), panel: h(Viewer, {}) },
        { id: "activity", label: t("logs.tab.activity"), panel: h(Activity, {}) },
        { id: "sessions", label: t("logs.tab.sessions"), panel: h(Sessions, {}) },
      ],
    }));
}
