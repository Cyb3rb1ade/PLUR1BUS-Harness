import { h } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { Page } from "../../components/page.ts";
import { PageLoading, PageState } from "../../components/page-state.ts";
import { t } from "../../i18n.ts";
import { registerArea } from "../../i18n/index.ts";
import { area } from "../home/area.ts";
import type { PageProps } from "../registry.ts";
import { parseMarkdown, renderMarkdown } from "./markdown.ts";
import { DOCS_INDEX as EN_INDEX, loadDoc as loadEnDoc } from "./docs-bundle/en-index.ts";
import { DOCS_INDEX as DE_INDEX, loadDoc as loadDeDoc } from "./docs-bundle/de-index.ts";
import "../../styles/help.css";

registerArea("homeHelpLibrary", area);

export function HelpPage({ sub }: PageProps): View {
  // Determine UI language
  const isDe = document.documentElement.lang.startsWith("de");
  const index = isDe ? DE_INDEX : EN_INDEX;
  const loadDoc = isDe ? loadDeDoc : loadEnDoc;

  // Selected slug: from subroute #/help/<slug> or first index entry
  const selectedSlug = sub || index[0]?.slug || "quickstart";

  const [currentDoc, setCurrentDoc] = useState<{ slug: string; title: string; content: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    let active = true;
    setLoading(true);
    loadDoc(selectedSlug).then((doc) => {
      if (!active) return;
      setCurrentDoc(doc);
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [selectedSlug, isDe]);

  // Local search filter over table of contents
  const filteredIndex = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return index;
    return index.filter((item) => item.title.toLowerCase().includes(q) || item.slug.toLowerCase().includes(q));
  }, [index, searchQuery]);

  const parsedNodes = useMemo(() => {
    if (!currentDoc) return [];
    return parseMarkdown(currentDoc.content);
  }, [currentDoc]);

  return h(
    Page,
    { title: t("help.title"), width: "full" },
    h(
      "div",
      { class: "help-layout" },
      h(
        "aside",
        { class: "help-sidebar", "aria-label": t("help.toc") },
        h(
          "div",
          { class: "help-search-box" },
          h("input", {
            type: "search",
            class: "help-search-input",
            placeholder: t("help.search"),
            value: searchQuery,
            onInput: (e: Event) => setSearchQuery((e.currentTarget as HTMLInputElement).value),
            "aria-label": t("help.search"),
          }),
        ),
        h(
          "nav",
          { class: "help-toc-nav" },
          filteredIndex.length === 0
            ? h("p", { class: "help-no-results" }, t("help.noResults"))
            : h(
                "ul",
                { class: "help-toc-list" },
                filteredIndex.map((item) => {
                  const isActive = item.slug === selectedSlug;
                  return h(
                    "li",
                    { key: item.slug },
                    h(
                      "a",
                      {
                        href: `#/help/${item.slug}`,
                        class: `help-toc-link ${isActive ? "active" : ""}`,
                        ...(isActive ? { "aria-current": "page" } : {}),
                      },
                      item.title,
                    ),
                  );
                }),
              ),
        ),
      ),
      h(
        "article",
        { class: "help-content", id: "help-article" },
        loading
          ? h(PageLoading, { label: t("help.loading") })
          : currentDoc
          ? renderMarkdown(parsedNodes)
          : h(PageState, { state: "empty", title: t("help.notFound") }),
      ),
    ),
  );
}
