import { h } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { Page } from "../../components/page.ts";
import { PageState } from "../../components/page-state.ts";
import { Dialog } from "../../components/dialog.ts";
import { ConfirmDialog } from "../../components/confirm-dialog.ts";
import { t } from "../../i18n.ts";
import { Field } from "../common/field.ts";
import { useLoad, currentRole } from "../common/load.ts";
import { FailureState } from "../common/states.ts";
import { rpc, imageUrl, filterOutputs, type Output } from "./data.ts";
import { MediaSearch, SimilarButton } from "../media-search/search.ts";
import "../../styles/media.css";

import { StoredImage } from "./stored-image.ts";
export { StoredImage };
function Generate({
  onClose,
  onQueued,
}: {
  onClose: () => void;
  onQueued: (id: string) => void;
}): View {
  const [prompt, setPrompt] = useState(""),
    [agent, setAgent] = useState("main"),
    [adapter, setAdapter] = useState(""),
    [reference, setReference] = useState(""),
    [mask, setMask] = useState(""),
    [metadata, setMetadata] = useState("inherit");
  const [width, setWidth] = useState(1024),
    [height, setHeight] = useState(1024),
    [count, setCount] = useState(1),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(false);
  const { state } = useLoad(
    (signal) =>
      rpc<{
        adapters: {
          id: string;
          capabilities: { generate: boolean; edit: boolean };
        }[];
      }>("media.adapters.list", {}, signal),
    [],
  );
  const text = (
    id: string,
    key: Parameters<typeof t>[0],
    value: string,
    set: (v: string) => void,
  ) =>
    h(
      Field,
      { id, label: t(key) },
      h("input", {
        id,
        value,
        onInput: (e: Event) => set((e.currentTarget as HTMLInputElement).value),
        required: id === "prompt",
      }),
    );
  const number = (
    id: string,
    key: Parameters<typeof t>[0],
    value: number,
    set: (v: number) => void,
    max: number,
  ) =>
    h(
      Field,
      { id, label: t(key) },
      h("input", {
        id,
        type: "number",
        min: 1,
        max,
        value,
        onInput: (e: Event) =>
          set(Number((e.currentTarget as HTMLInputElement).value)),
      }),
    );
  return h(
    Dialog,
    { title: t("media.generate"), onClose },
    h(
      "form",
      {
        onSubmit: async (e: Event) => {
          e.preventDefault();
          if (busy) return;
          setBusy(true);
          setError(false);
          try {
            const result = await rpc<{ jobId: string }>(
              reference ? "media.edit" : "media.generate",
              {
                agentId: agent,
                ...(adapter ? { adapter } : {}),
                request: {
                  prompt,
                  n: count,
                  size: { width, height },
                  ...(reference ? { referenceIds: [reference] } : {}),
                  ...(mask ? { maskId: mask } : {}),
                  ...(metadata === "inherit"
                    ? {}
                    : { embedMetadata: metadata === "on" }),
                },
              },
              undefined,
              true,
            );
            onQueued(result.jobId);
            onClose();
          } catch {
            setError(true);
          } finally {
            setBusy(false);
          }
        },
      },
      text("prompt", "media.prompt", prompt, setPrompt),
      text("agent", "surfaces.agent", agent, setAgent),
      h(
        Field,
        { id: "adapter", label: t("surfaces.adapter") },
        h(
          "select",
          {
            id: "adapter",
            value: adapter,
            onChange: (e: Event) =>
              setAdapter((e.currentTarget as HTMLSelectElement).value),
          },
          h("option", { value: "" }, t("surfaces.all")),
          state.status === "ok"
            ? state.data.adapters
                .filter((a) =>
                  reference ? a.capabilities.edit : a.capabilities.generate,
                )
                .map((a) => h("option", { value: a.id }, a.id))
            : null,
        ),
      ),
      number("width", "media.width", width, setWidth, 8192),
      number("height", "media.height", height, setHeight, 8192),
      number("count", "media.count", count, setCount, 10),
      text("reference", "media.reference", reference, setReference),
      text("mask", "media.mask", mask, setMask),
      h(
        Field,
        { id: "metadata", label: t("media.metadata") },
        h(
          "select",
          {
            id: "metadata",
            value: metadata,
            onChange: (e: Event) =>
              setMetadata((e.currentTarget as HTMLSelectElement).value),
          },
          ["inherit", "on", "off"].map((value) =>
            h(
              "option",
              { value },
              t(
                value === "inherit"
                  ? "media.inherit"
                  : value === "on"
                    ? "media.on"
                    : "media.off",
              ),
            ),
          ),
        ),
      ),
      error ? h("p", { role: "alert" }, t("surfaces.error")) : null,
      h(
        "button",
        {
          class: "btn btn-primary",
          type: "submit",
          disabled: busy || !prompt.trim(),
        },
        t("media.generate"),
      ),
    ),
  );
}
export function MediaPage(): View {
  const { state, reload } = useLoad(
    (signal) => rpc<{ outputs: Output[] }>("media.output.list", {}, signal),
    [],
  );
  const [agent, setAgent] = useState(""),
    [adapter, setAdapter] = useState(""),
    [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [selected, setSelected] = useState<Output | null>(null),
    [generate, setGenerate] = useState(false),
    [remove, setRemove] = useState<Output | null>(null),
    [job, setJob] = useState(""),
    [jobState, setJobState] = useState("");
  useEffect(() => {
    if (!job) return;
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await rpc<{
          state: string;
          progress: { fraction: number };
        }>("media.job.get", { id: job }, ctl.signal);
        if (ctl.signal.aborted) return;
        setJobState(
          `${value.state} ${Math.round(value.progress.fraction * 100)}%`,
        );
        if (["succeeded", "failed", "cancelled"].includes(value.state)) {
          reload();
          return;
        }
        timer = setTimeout(() => void poll(), 500);
      } catch {
        if (!ctl.signal.aborted) setJobState(t("surfaces.error"));
      }
    };
    void poll();
    return () => {
      ctl.abort();
      clearTimeout(timer);
    };
  }, [job]);
  const title = t("nav.media");
  if (state.status === "loading")
    return h(Page, { title }, h(PageState, { state: "loading" }));
  if (state.status === "fail")
    return h(
      Page,
      { title },
      h(FailureState, {
        failure: state.failure,
        unavailable: t("surfaces.unavailable"),
        onRetry: reload,
      }),
    );
  const write = currentRole() !== "viewer";
  const outputs = filterOutputs(state.data.outputs, {
    agent,
    adapter,
    ...(from ? { after: new Date(from).getTime() } : {}),
    ...(to ? { before: new Date(to).getTime() + 86400000 - 1 } : {}),
  });
  const input = (
    id: string,
    label: string,
    value: string,
    set: (v: string) => void,
    type = "text",
  ) =>
    h(
      Field,
      { id, label },
      h("input", {
        id,
        type,
        value,
        onInput: (e: Event) => set((e.currentTarget as HTMLInputElement).value),
      }),
    );
  return h(
    Page,
    { title, width: "full" },
    write
      ? h(
          "button",
          { class: "btn btn-primary", onClick: () => setGenerate(true) },
          t("media.generate"),
        )
      : null,
    job
      ? h("p", { role: "status" }, t("media.job", { id: job }), ": ", jobState)
      : null,
    h(
      "div",
      { class: "surface-filters" },
      input("filter-agent", t("surfaces.agent"), agent, setAgent),
      input("filter-adapter", t("surfaces.adapter"), adapter, setAdapter),
      input("filter-from", t("surfaces.from"), from, setFrom, "date"),
      input("filter-to", t("surfaces.to"), to, setTo, "date"),
    ),
    h(MediaSearch, {}),
    outputs.length
      ? h(
          "div",
          { class: "media-grid" },
          outputs.map((output) =>
            h(
              "article",
              { key: output.id, class: "card" },
              h(
                "button",
                { class: "btn", onClick: () => setSelected(output) },
                h(StoredImage, { id: output.id }),
                h("span", {}, output.prompt),
              ),
              h("p", {}, output.agentId, " · ", output.metadata.adapter),
              h(SimilarButton, { mediaId: output.id }),
            ),
          ),
        )
      : h(PageState, { state: "empty", title: t("surfaces.empty") }),
    selected
      ? h(
          Dialog,
          { title: selected.prompt, onClose: () => setSelected(null) },
          h(StoredImage, { id: selected.id, download: true }),
          h(
            "details",
            {},
            h("summary", {}, t("media.manifest")),
            h("pre", {}, JSON.stringify(selected, null, 2)),
          ),
          write
            ? h(
                "button",
                { class: "btn btn-danger", onClick: () => setRemove(selected) },
                t("surfaces.remove"),
              )
            : null,
        )
      : null,
    generate
      ? h(Generate, { onClose: () => setGenerate(false), onQueued: setJob })
      : null,
    remove
      ? h(
          ConfirmDialog,
          {
            title: t("surfaces.confirm"),
            danger: true,
            confirmLabel: t("surfaces.remove"),
            onClose: () => setRemove(null),
            onConfirm: async () => {
              try {
                await rpc(
                  "media.output.delete",
                  { id: remove.id },
                  undefined,
                  true,
                );
                setSelected(null);
                reload();
                return { ok: true as const };
              } catch {
                return { ok: false as const, message: t("surfaces.error") };
              }
            },
          },
          t("media.deleteBody"),
        )
      : null,
  );
}
export function MetadataPreference(): View {
  const { state, reload } = useLoad(
    (signal) =>
      rpc<{ global: boolean; agents: Record<string, boolean> }>(
        "media.preferences.get",
        {},
        signal,
      ),
    [],
  );
  const [error, setError] = useState(false),
    [agent, setAgent] = useState("");
  if (state.status !== "ok")
    return state.status === "fail"
      ? h(FailureState, {
          failure: state.failure,
          unavailable: t("surfaces.unavailable"),
        })
      : h(PageState, { state: "loading" });
  return h(
    "div",
    {},
    h(
      Field,
      { id: "metadata-agent", label: t("surfaces.agent") },
      h("input", {
        id: "metadata-agent",
        value: agent,
        onInput: (e: Event) =>
          setAgent((e.currentTarget as HTMLInputElement).value),
      }),
    ),
    h(
      "label",
      {},
      h("input", {
        type: "checkbox",
        checked: agent
          ? (state.data.agents[agent] ?? state.data.global)
          : state.data.global,
        disabled:
          currentRole() === "viewer" ||
          (!agent && !["owner", "admin"].includes(currentRole() ?? "")),
        onChange: async (e: Event) => {
          try {
            await rpc(
              "media.preferences.set",
              {
                ...(agent ? { agentId: agent } : {}),
                embedMetadata: (e.currentTarget as HTMLInputElement).checked,
              },
              undefined,
              true,
            );
            reload();
          } catch {
            setError(true);
          }
        },
      }),
      t("media.metadata"),
    ),
    h("p", {}, t("media.metadataHint")),
    error ? h("p", { role: "alert" }, t("surfaces.error")) : null,
  );
}
