import { h } from "preact";
import { useState } from "preact/hooks";
import type { View } from "../view.ts";
import { Badge, Card } from "../components/card.ts";
import { Dialog } from "../components/dialog.ts";
import { ListDetail } from "../components/list-detail.ts";
import { Page } from "../components/page.ts";
import { PageState, type PageStateKind } from "../components/page-state.ts";
import { Tabs } from "../components/tabs.ts";
import { t } from "../i18n.ts";
import { navigate } from "../router.ts";
import type { PageProps } from "./registry.ts";

// Development and test fixture (see nav.ts GALLERY_ENABLED): one route per shared pattern, so each can be exercised, measured
// and axe-checked in isolation. Texts reuse core keys; example data is deliberately plain.
const STATES: readonly PageStateKind[] = ["loading", "empty", "error", "forbidden", "unavailable"];
const ITEMS = [{ id: "1", name: "Alpha" }, { id: "2", name: "Beta" }, { id: "3", name: "Gamma" }] as const;
let healed = false;

function Boom(): View {
  if (!healed) { healed = true; throw new Error("gallery boom"); }
  return h("p", { id: "recovered" }, "Recovered");
}

function Patterns(): View {
  const [tab, setTab] = useState("one");
  return h(Page, { title: t("nav.gallery") },
    h(Card, { title: "Card", aside: h(Badge, { tone: "ok" }, "Ready") },
      h("p", {}, "Body text."), h("p", {}, h(Badge, {}, "Neutral"), " ", h(Badge, { tone: "warn" }, "Warn"), " ", h(Badge, { tone: "err" }, "Error"), " ", h(Badge, { tone: "info" }, "Info"))),
    h(Tabs, {
      label: "Example tabs", selected: tab, onSelect: setTab,
      tabs: [{ id: "one", label: "One", panel: h("p", {}, "Panel one") }, { id: "two", label: "Two", panel: h("p", {}, "Panel two") }, { id: "three", label: "Three", panel: h("p", {}, "Panel three") }],
    }));
}

function DialogDemo(): View {
  const [open, setOpen] = useState(false);
  return h(Page, { title: t("nav.gallery") },
    h("button", { type: "button", class: "btn", id: "open-dialog", onClick: () => setOpen(true) }, "Open dialog"),
    open ? h(Dialog, { title: "Example dialog", onClose: () => setOpen(false), actions: h("button", { type: "button", class: "btn btn-primary", onClick: () => setOpen(false) }, "Done") },
      h("p", {}, "Dialog body."), h("input", { "aria-label": "Example field", type: "text" })) : null);
}

function ListDetailDemo({ id }: { id: string | null }): View {
  const item = ITEMS.find((i) => i.id === id);
  return h(Page, { title: t("nav.gallery"), width: "full" },
    h(ListDetail, {
      selected: item !== undefined, listLabel: "Items", detailLabel: "Item details", onBack: () => navigate("/gallery/list-detail"),
      list: h("ul", { class: "plain-list" }, ITEMS.map((i) => h("li", { key: i.id }, h("a", { class: "nav-link", href: `#/gallery/list-detail/${i.id}`, ...(i.id === id ? { "aria-current": "true" } : {}) }, i.name)))),
      detail: item ? h(Card, { title: item.name }, h("p", {}, `Details of ${item.name}.`)) : null,
    }));
}

function Actions(): View {
  return h(Page, { title: t("nav.gallery"), lead: "Actions move into a More menu in compact.", actions: [
    h("button", { key: "a", type: "button", class: "btn" }, "First"), h("button", { key: "b", type: "button", class: "btn btn-primary" }, "Second"),
  ] }, h("p", {}, "Body."));
}

export function GalleryPage({ sub }: PageProps): View {
  const [kind = "patterns", arg] = (sub ?? "").split("/");
  if ((STATES as readonly string[]).includes(kind)) {
    const state = kind as PageStateKind;
    return h(Page, { title: t("nav.gallery") }, h(PageState, state === "error" ? { state, onRetry: () => navigate("/gallery/patterns") } : { state }));
  }
  switch (kind) {
    case "boundary": return h(Boom, {});
    case "dialog": return h(DialogDemo, {});
    case "list-detail": return h(ListDetailDemo, { id: arg ?? null });
    case "actions": return h(Actions, {});
    default: return h(Patterns, {});
  }
}
