// Settings page (`/settings/<section>`): a section navigation (224 px) next to the content (<= 880 px). Each section is its own
// lazy chunk; `?focus=<key>` (from the palette) is handed to the section so it can scroll to and highlight the field.
import { h } from "preact";
import type { View } from "../../view.ts";
import { Page } from "../../components/page.ts";
import { t } from "../../i18n.ts";
import { navigate, query } from "../../router.ts";
import { DEFAULT_SECTION, SECTIONS, sectionById, type SectionDef } from "../../settings-sections.ts";
import { lazySection } from "../common/lazy-section.ts";
import type { PageProps } from "../registry.ts";

export type SectionProps = { section: SectionDef; focus?: string };

const ConfigSection = lazySection<SectionProps>(() => import("./sections/config.ts").then((m) => m.ConfigSection));
const SecretsSection = lazySection<SectionProps>(() => import("./sections/secrets.ts").then((m) => m.SecretsSection));
const UsersSection = lazySection<SectionProps>(() => import("./sections/users.ts").then((m) => m.UsersSection));
const DevicesSection = lazySection<SectionProps>(() => import("./sections/devices.ts").then((m) => m.DevicesSection));

const MediaSection = lazySection<SectionProps>(() => import("../surfaces/media.ts").then(m => m.MetadataPreference));

const BODY = { media: MediaSection, config: ConfigSection, secrets: SecretsSection, users: UsersSection, devices: DevicesSection } as const;

export function SettingsPage({ sub }: PageProps): View {
  const section = sectionById(sub) ?? sectionById(DEFAULT_SECTION)!;
  const focus = query.value.get("focus") ?? undefined;
  const body = h(BODY[section.kind], { key: section.id, section, ...(focus === undefined ? {} : { focus }) });
  return h(Page, { title: t("settings.title"), width: "full" },
    h("div", { class: "settings-layout" },
      h("nav", { class: "settings-nav", "aria-label": t("settings.nav") },
        h("a", { class: "settings-nav-link", href: "#/identities" }, t("nav.identities")),
        h("ul", null, SECTIONS.map((s) => h("li", { key: s.id },
          h("a", {
            href: `#/settings/${s.id}`, class: "settings-nav-link", ...(s.id === section.id ? { "aria-current": "true" } : {}),
            onClick: (e: MouseEvent) => { if (e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey) { e.preventDefault(); navigate(`/settings/${s.id}`); } },
          }, t(s.label)))))),
      h("div", { class: "settings-content" }, body)));
}
