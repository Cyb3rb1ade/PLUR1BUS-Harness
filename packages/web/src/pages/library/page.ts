import { h } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { Page } from "../../components/page.ts";
import { PageLoading, PageState } from "../../components/page-state.ts";
import { Dialog } from "../../components/dialog.ts";
import { ConfirmDialog } from "../../components/confirm-dialog.ts";
import { Field } from "../common/field.ts";
import { FailureState } from "../common/states.ts";
import { currentRole, getApi, useLoad } from "../common/load.ts";
import { t } from "../../i18n.ts";
import { registerArea } from "../../i18n/index.ts";
import { area } from "../home/area.ts";
import { StoredImage } from "../surfaces/stored-image.ts";
import * as mediaArea from "../../i18n/library-media.ts";
import type { EditSource, MediaDialogProps } from "./generate.ts";
import { JobBar } from "./jobs.ts";
import { Preferences } from "./prefs.ts";
import "../../styles/library.css";

registerArea("homeHelpLibrary", area);
registerArea("libraryMedia", mediaArea);

export interface LibraryOutput {
  id: string;
  agentId: string;
  createdAt: number;
  prompt: string;
  kind?: "image" | "video" | "audio" | string;
  mimeType?: string;
  caption?: string;
  metadata?: { adapter?: string; model?: string };
  files?: { path: string; format: string; bytes: number }[];
}

const PAGE_SIZE = 24;

/** An entry the list can render: a record with a string id and prompt. Anything else (null, a number, a half record) is left
 *  out instead of taking the whole page down. */
function isListed(v: unknown): v is LibraryOutput {
  if (!v || typeof v !== "object") return false;
  const o = v as { id?: unknown; prompt?: unknown };
  return typeof o.id === "string" && typeof o.prompt === "string";
}

function kindOf(o: LibraryOutput): string {
  return o.kind || (o.mimeType?.startsWith("video/") ? "video" : o.mimeType?.startsWith("audio/") ? "audio" : "image");
}

/** The generate/edit dialog is its own chunk: it is only fetched the first time a person opens it. */
function LazyMediaDialog(props: MediaDialogProps): View {
  const [Dialog_, setDialog_] = useState<((p: MediaDialogProps) => View) | null>(null);
  useEffect(() => {
    let live = true;
    import("./generate.ts").then((m) => { if (live) setDialog_(() => m.MediaDialog); }, () => { if (live) props.onClose(); });
    return () => { live = false; };
  }, []);
  return Dialog_ ? h(Dialog_, props) : h("span", { class: "sr-only", role: "status" }, t("state.loading"));
}

/** The kind narrowed to the ones the media dialogs know; anything unknown counts as an image. */
function mediumOf(o: LibraryOutput): "image" | "video" | "audio" {
  const k = kindOf(o);
  return k === "video" || k === "audio" ? k : "image";
}

export function LibraryPage(): View {
  const { state, reload } = useLoad<{ outputs: LibraryOutput[] }>(
    async (signal) =>
      (await getApi().rpc(
        "media.output.list",
        {},
        { write: false, signal },
      )) as { outputs: LibraryOutput[] },
    [],
  );

  const [kindFilter, setKindFilter] = useState<string>("");
  const [shown, setShown] = useState(PAGE_SIZE);
  const [selected, setSelected] = useState<LibraryOutput | null>(null);
  const [previewData, setPreviewData] = useState<{
    data?: string | undefined;
    mimeType?: string | undefined;
  } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<LibraryOutput | null>(null);
  // Generate / edit dialog, the jobs it started (watched by the job bar) and a result the job bar asked to open.
  const [dialog, setDialog] = useState<{ mode: "generate" } | { mode: "edit"; source: EditSource } | null>(null);
  const [watch, setWatch] = useState<string[]>([]);
  const [openId, setOpenId] = useState("");

  // Caption editing
  const [editingCaption, setEditingCaption] = useState(false);
  const [captionText, setCaptionText] = useState("");
  const [savingCaption, setSavingCaption] = useState(false);
  const [captionError, setCaptionError] = useState("");

  const write = currentRole() !== "viewer";

  // When an item is selected for preview, fetch full data via media.output.get
  useEffect(() => {
    if (!selected) {
      setPreviewData(null);
      setEditingCaption(false);
      setCaptionText("");
      setCaptionError("");
      return;
    }
    setCaptionText(selected.caption || "");
    setPreviewLoading(true);
    let active = true;

    (getApi()
      .rpc("media.output.get", { id: selected.id }, { write: false }) as Promise<{
        manifest: LibraryOutput;
        data?: string;
        mimeType?: string;
      }>)
      .then((res) => {
        if (!active) return;
        setPreviewData({ data: res.data, mimeType: res.mimeType });
        if (res.manifest?.caption) {
          setCaptionText(res.manifest.caption);
        }
      })
      .catch(() => {
        // Fallback: previewData stays null
      })
      .finally(() => {
        if (active) setPreviewLoading(false);
      });

    return () => {
      active = false;
    };
  }, [selected]);

  const saveCaption = async () => {
    if (!selected) return;
    setSavingCaption(true);
    setCaptionError("");
    try {
      await getApi().rpc(
        "media.caption.set",
        { mediaId: selected.id, text: captionText },
        { write: true },
      );
      selected.caption = captionText;
      setEditingCaption(false);
      reload();
    } catch {
      setCaptionError(t("library.error"));
    } finally {
      setSavingCaption(false);
    }
  };

  const loadedOutputs = state.status === "ok" ? state.data.outputs : null;
  useEffect(() => {
    if (!openId || !loadedOutputs) return;
    const hit = loadedOutputs.find((o) => o.id === openId);
    if (hit) { setSelected(hit); setOpenId(""); }
  }, [openId, loadedOutputs]);

  const title = t("library.title");

  if (state.status === "loading") {
    return h(Page, { title }, h(PageLoading, { label: t("state.loading") }));
  }

  if (state.status === "fail") {
    return h(
      Page,
      { title },
      h(FailureState, {
        failure: state.failure,
        unavailable: t("library.unavailable"),
        onRetry: reload,
      }),
    );
  }

  const rawOutputs = Array.isArray(state.data?.outputs) ? state.data.outputs.filter(isListed) : [];
  const filteredOutputs = rawOutputs.filter((o) => !kindFilter || kindOf(o) === kindFilter);
  const visibleOutputs = filteredOutputs.slice(0, shown);

  return h(
    Page,
    { title, lead: t("library.lead"), width: "full" },
    h(
      "div",
      { class: "library-toolbar" },
      h(
        "div",
        { class: "library-filters" },
        h(
          Field,
          { id: "kind-filter", label: t("library.filter.kind") },
          h(
            "select",
            {
              id: "kind-filter",
              value: kindFilter,
              onChange: (e: Event) => {
                setKindFilter((e.currentTarget as HTMLSelectElement).value);
                setShown(PAGE_SIZE);
              },
            },
            h("option", { value: "" }, t("library.filter.all")),
            h("option", { value: "image" }, t("library.filter.image")),
            h("option", { value: "video" }, t("library.filter.video")),
            h("option", { value: "audio" }, t("library.filter.audio")),
          ),
        ),
      ),
      h(
        "div",
        { class: "library-actions" },
        write
          ? h("button", { type: "button", class: "btn btn-primary", onClick: () => setDialog({ mode: "generate" }) }, t("libmedia.generate"))
          : null,
        h(
          "a",
          { href: "#/media", class: "btn" },
          t("library.searchLink"),
        ),
      ),
    ),
    h(JobBar, {
      watch,
      onOpenOutput: (id: string) => { reload(); setOpenId(id); },
      onFinished: reload,
    }),
    h(Preferences, {}),
    filteredOutputs.length === 0
      ? h(PageState, { state: "empty", title: rawOutputs.length === 0 ? t("library.empty") : t("library.emptyFiltered") })
      : h(
          "div",
          { class: "library-grid" },
          visibleOutputs.map((item) =>
            h(
              "article",
              { key: item.id, class: "card library-card" },
              h(
                "div",
                {
                  class: "library-thumb-wrapper",
                  onClick: () => setSelected(item),
                  onKeyDown: (e: KeyboardEvent) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelected(item);
                    }
                  },
                  tabIndex: 0,
                  role: "button",
                  "aria-label": `${t("library.preview")}: ${item.prompt}`,
                },
                kindOf(item) === "image"
                  ? h(StoredImage, { id: item.id, alt: item.caption || item.prompt })
                  : h("span", { class: "library-kind-tile" }, t(`library.filter.${kindOf(item)}` as "library.filter.image")),
              ),
              h(
                "div",
                { class: "library-card-info" },
                h("p", { class: "library-prompt", id: `library-prompt-${item.id}`, title: item.prompt }, item.prompt),
                item.caption
                  ? h("p", { class: "library-caption-preview" }, item.caption)
                  : null,
                h(
                  "p",
                  { class: "library-meta" },
                  item.agentId,
                  item.metadata?.adapter ? ` · ${item.metadata.adapter}` : "",
                ),
              ),
              h(
                "div",
                { class: "library-card-actions" },
                h(
                  "button",
                  {
                    type: "button",
                    class: "btn btn-quiet",
                    "aria-describedby": `library-prompt-${item.id}`,
                    onClick: () => setSelected(item),
                  },
                  t("library.preview"),
                ),
                write && mediumOf(item) !== "audio"
                  ? h("button", {
                      type: "button",
                      class: "btn btn-quiet",
                      "aria-describedby": `library-prompt-${item.id}`,
                      onClick: () => setDialog({ mode: "edit" as const, source: { id: item.id, prompt: item.prompt, kind: mediumOf(item) } }),
                    }, t("libmedia.edit"))
                  : null,
                write
                  ? h(
                      "button",
                      {
                        type: "button",
                        class: "btn btn-danger btn-quiet",
                        "aria-describedby": `library-prompt-${item.id}`,
                        onClick: () => setDeleteTarget(item),
                      },
                      t("library.delete"),
                    )
                  : null,
              ),
            ),
          ),
        ),
    filteredOutputs.length > shown
      ? h(
          "div",
          { class: "library-more" },
          h("button", { type: "button", class: "btn", onClick: () => setShown((n) => n + PAGE_SIZE) }, t("library.more")),
        )
      : null,
    selected
      ? h(
          Dialog,
          { title: selected.prompt, onClose: () => setSelected(null) },
          h(
            "div",
            { class: "library-dialog-content" },
            previewLoading
              ? h(PageLoading, { label: t("state.loading") })
              : previewData?.data
              ? previewData.mimeType?.startsWith("video/")
                ? h("video", {
                    controls: true,
                    src: `data:${previewData.mimeType};base64,${previewData.data}`,
                    class: "library-preview-player",
                  })
                : previewData.mimeType?.startsWith("audio/")
                ? h("audio", {
                    controls: true,
                    src: `data:${previewData.mimeType};base64,${previewData.data}`,
                    class: "library-preview-player",
                  })
                : h(StoredImage, { id: selected.id, download: true, alt: selected.caption || selected.prompt })
              : h(StoredImage, { id: selected.id, download: true, alt: selected.caption || selected.prompt }),
            h(
              "div",
              { class: "library-caption-section" },
              h("h3", {}, t("library.caption")),
              editingCaption
                ? h(
                    "div",
                    { class: "library-caption-edit" },
                    h("textarea", {
                      "aria-label": t("library.caption"),
                      class: "library-caption-textarea",
                      value: captionText,
                      placeholder: t("library.captionPlaceholder"),
                      onInput: (e: Event) =>
                        setCaptionText((e.currentTarget as HTMLTextAreaElement).value),
                    }),
                    captionError
                      ? h("p", { role: "alert", class: "form-error" }, captionError)
                      : null,
                    h(
                      "div",
                      { class: "library-caption-buttons" },
                      h(
                        "button",
                        {
                          type: "button",
                          class: "btn btn-primary",
                          disabled: savingCaption,
                          onClick: saveCaption,
                        },
                        savingCaption ? t("library.captionSaving") : t("library.captionSave"),
                      ),
                      h(
                        "button",
                        {
                          type: "button",
                          class: "btn",
                          onClick: () => {
                            setCaptionText(selected.caption || "");
                            setCaptionError("");
                            setEditingCaption(false);
                          },
                        },
                        t("library.captionCancel"),
                      ),
                    ),
                  )
                : h(
                    "div",
                    { class: "library-caption-view" },
                    h(
                      "p",
                      { class: "library-caption-text" },
                      selected.caption || t("library.captionEmpty"),
                    ),
                    write
                      ? h(
                          "button",
                          {
                            type: "button",
                            class: "btn",
                            onClick: () => setEditingCaption(true),
                          },
                          t("library.captionEdit"),
                        )
                      : null,
                  ),
            ),
            h(
              "div",
              { class: "library-dialog-footer" },
              h(
                "details",
                {},
                h("summary", {}, t("media.manifest")),
                h("pre", {}, JSON.stringify(selected, null, 2)),
              ),
              write
                ? h(
                    "button",
                    {
                      type: "button",
                      class: "btn btn-danger",
                      onClick: () => {
                        setDeleteTarget(selected);
                      },
                    },
                    t("library.delete"),
                  )
                : null,
            ),
          ),
        )
      : null,
    dialog
      ? h(LazyMediaDialog, {
          ...dialog,
          ...(dialog.mode === "edit"
            ? { masks: rawOutputs.filter((o) => mediumOf(o) === "image").map((o) => ({ id: o.id, prompt: o.prompt })) }
            : {}),
          onClose: () => setDialog(null),
          onQueued: (id: string) => { setWatch((w) => [...w, id]); },
        } as MediaDialogProps)
      : null,
    deleteTarget
      ? h(
          ConfirmDialog,
          {
            title: t("surfaces.confirm"),
            danger: true,
            confirmLabel: t("library.delete"),
            onClose: () => setDeleteTarget(null),
            onConfirm: async () => {
              try {
                await getApi().rpc(
                  "media.output.delete",
                  { id: deleteTarget.id },
                  { write: true },
                );
                if (selected?.id === deleteTarget.id) {
                  setSelected(null);
                }
                setDeleteTarget(null);
                reload();
                return { ok: true as const };
              } catch {
                return { ok: false as const, message: t("library.error") };
              }
            },
          },
          t("library.deleteConfirm"),
        )
      : null,
  );
}
