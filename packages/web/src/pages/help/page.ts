import { h } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { Page } from "../../components/page.ts";
import { PageLoading, PageState } from "../../components/page-state.ts";
import { lang, t } from "../../i18n.ts";
import { registerArea } from "../../i18n/index.ts";
import { area } from "../home/area.ts";
import type { PageProps } from "../registry.ts";
import { parseMarkdown, renderMarkdown } from "./markdown.ts";
import { filterIndex, pickDoc, splitSub } from "./route.ts";
import { DOCS_INDEX as EN_INDEX, loadDoc as loadEnDoc } from "./docs-bundle/en-index.ts";
import { DOCS_INDEX as DE_INDEX, loadDoc as loadDeDoc } from "./docs-bundle/de-index.ts";
import "../../styles/help.css";

registerArea("homeHelpLibrary", area);

type Doc = { slug: string; title: string; content: string };
type Load = { status: "loading" } | { status: "ready"; doc: Doc } | { status: "missing" } | { status: "error" };

export function HelpPage({ sub }: PageProps): View {
  // The UI language signal (not <html lang>, which is only set by an effect after render): a language switch re-renders this page.
  const isDe = lang.value === "de";
  const index = isDe ? DE_INDEX : EN_INDEX;

  // #/help/<slug>[#anchor]: the router hands over "slug#anchor". A slug the language lacks falls back to the English page.
  const { slug: wanted, anchor } = splitSub(sub);
  const picked = pickDoc(wanted, index, EN_INDEX);
  const selectedSlug = picked?.slug ?? wanted;
  const useFallback = picked?.useFallback ?? false;
  const loadDoc = isDe && !useFallback ? loadDeDoc : loadEnDoc;

  const [state, setState] = useState<Load>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    if (!picked) { setState({ status: "missing" }); return; }
    let active = true;
    setState({ status: "loading" });
    loadDoc(selectedSlug).then(
      (doc) => { if (active) setState(doc ? { status: "ready", doc } : { status: "missing" }); },
      () => { if (active) setState({ status: "error" }); },
    );
    return () => {
      active = false;
    };
  }, [selectedSlug, isDe, useFallback, attempt]);

  // Anchor navigation: once the page is on screen, bring the heading the link names into view.
  useEffect(() => {
    if (state.status !== "ready" || anchor === "") return;
    const target = [...(document.getElementById("help-article")?.querySelectorAll("[id]") ?? [])].find((el) => el.id === anchor);
    target?.scrollIntoView();
  }, [state, anchor]);

  // Local search filter over table of contents
  const filteredIndex = useMemo(() => filterIndex(index, searchQuery), [index, searchQuery]);

  const doc = state.status === "ready" ? state.doc : null;
  const rendered = useMemo(() => {
    if (!doc) return null;
    const known = (s: string): boolean => index.some((e) => e.slug === s) || EN_INDEX.some((e) => e.slug === s);
    return renderMarkdown(parseMarkdown(doc.content), { slug: doc.slug, hasDoc: known });
  }, [doc, index]);

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
        state.status === "loading"
          ? h(PageLoading, { label: t("help.loading") })
          : state.status === "error"
          ? h(PageState, { state: "error", onRetry: () => { setAttempt((n) => n + 1); } })
          : rendered ?? h(PageState, { state: "empty", title: t("help.notFound") }),
      ),
    ),
  );
}
