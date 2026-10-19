import { h } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { Dialog } from "../../components/dialog.ts";
import { ConfirmDialog } from "../../components/confirm-dialog.ts";
import { PageLoading } from "../../components/page-state.ts";
import { t, type Key } from "../../i18n.ts";
import { API_ROUTES } from "../../api/routes.ts";
import { Field, bad } from "../common/field.ts";
import { getApi } from "../common/load.ts";
import { loadDefaults } from "./defaults.ts";
import { FailureNote, failureText } from "./failure.ts";
import {
  adaptersFor, buildParams, classifyFailure, editOperations, generateKinds, paramProblem, paramSpecs, parseAdapters,
  type Adapter, type EditOp, type FormValues, type Kind, type MediaFailure, type ParamSpec,
} from "./media-model.ts";
import "../../styles/library-media.css";

/** The medium an edit starts from, and the library images that can serve as an inpainting mask. */
export interface EditSource { id: string; prompt: string; kind: Kind | "audio" }
export interface MaskChoice { id: string; prompt: string }

export type MediaDialogProps =
  | { mode: "generate"; onClose: () => void; onQueued: (jobId: string) => void }
  | { mode: "edit"; source: EditSource; masks: readonly MaskChoice[]; onClose: () => void; onQueued: (jobId: string) => void };

type Loaded = { adapters: Adapter[]; agents: string[] };

const KNOWN_LABELS = new Set(["n", "aspect", "format", "seed", "steps", "guidance", "durationSeconds", "resolution", "fps", "audio", "embedMetadata"]);
const paramLabel = (s: ParamSpec): string => (s.type === "size" ? t("libmedia.param.size") : KNOWN_LABELS.has(s.key) ? t(`libmedia.param.${s.key}` as Key) : (s.label ?? s.key));

function problemText(spec: ParamSpec, code: string): string {
  if (code === "enum") return t("libmedia.param.enum");
  if (code === "number") return t("libmedia.param.number");
  if (spec.type === "int" || spec.type === "number") {
    if (spec.min !== undefined && spec.max !== undefined) return t("libmedia.param.range", { min: spec.min, max: spec.max });
    if (spec.min !== undefined) return t("libmedia.param.min", { min: spec.min });
    if (spec.max !== undefined) return t("libmedia.param.max", { max: spec.max });
  }
  if (spec.type === "size") return t("libmedia.param.range", { min: 1, max: spec.max });
  return t("libmedia.param.number");
}

async function loadAgents(signal: AbortSignal): Promise<string[]> {
  try {
    const r = await getApi().get<{ agents?: { agentId: string }[] }>(API_ROUTES.agents, { signal });
    return Array.isArray(r.agents) ? r.agents.map((a) => a.agentId) : [];
  } catch (e) {
    if ((e as { kind?: string }).kind === "aborted") throw e;
    return [];
  }
}

/** Generate (media.generate) or edit (media.edit) dialog. The form is built from what the chosen adapter advertises in
 *  media.adapters.list; nothing is fixed per provider. A cloud adapter needs a confirmation before anything is sent. */
export function MediaDialog(props: MediaDialogProps): View {
  const edit = props.mode === "edit";
  const [data, setData] = useState<Loaded | null>(null);
  const [loadFailure, setLoadFailure] = useState<MediaFailure | null>(null);
  const [kind, setKind] = useState<Kind>("image");
  const [adapterId, setAdapterId] = useState("");
  const [opName, setOpName] = useState("");
  const [agent, setAgent] = useState("main");
  const [prompt, setPrompt] = useState("");
  const [negative, setNegative] = useState("");
  const [maskId, setMaskId] = useState("");
  const [values, setValues] = useState<FormValues>({});
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<MediaFailure | null>(null);
  const [confirming, setConfirming] = useState(false);
  const inFlight = useRef(false);

  useEffect(() => {
    const ctl = new AbortController();
    (async () => {
      try {
        const [list, agents] = await Promise.all([
          getApi().rpc("media.adapters.list", {}, { write: false, signal: ctl.signal }),
          loadAgents(ctl.signal),
        ]);
        if (ctl.signal.aborted) return;
        const adapters = parseAdapters(list);
        setData({ adapters, agents });
        if (agents[0]) setAgent(agents[0]);
      } catch (e) {
        if (!ctl.signal.aborted && (e as { kind?: string }).kind !== "aborted") setLoadFailure(classifyFailure(e));
      }
    })();
    return () => { ctl.abort(); };
  }, []);

  const adapters = data?.adapters ?? [];
  const kinds = edit ? [] : generateKinds(adapters);
  const effectiveKind: Kind = edit ? "image" : kinds.includes(kind) ? kind : (kinds[0] ?? "image");
  const mediumKind = edit ? props.source.kind : null;
  const candidates = edit
    ? adapters.filter((a) => mediumKind !== null && editOperations(a, mediumKind).length > 0)
    : adaptersFor(adapters, effectiveKind);
  const adapter = candidates.find((a) => a.id === adapterId) ?? candidates.find((a) => a.id === loadDefaults()[effectiveKind]) ?? candidates[0] ?? null;
  const ops: EditOp[] = edit && adapter && mediumKind ? editOperations(adapter, mediumKind) : [];
  const op = ops.find((o) => o.op === opName) ?? ops[0] ?? null;
  const submitKind: Kind = edit ? (op?.kind ?? "image") : effectiveKind;
  const specs = adapter ? paramSpecs(adapter, submitKind) : [];
  const set = (key: string, v: string | boolean): void => { setValues((p) => ({ ...p, [key]: v })); };
  const problems = specs.map((s) => [s, paramProblem(s, values)] as const).filter((p): p is readonly [ParamSpec, string] => p[1] !== null);
  const maskMissing = op?.needsMask === true && maskId === "";
  const title = edit ? t("libmedia.edit.title") : t("libmedia.generate.title");

  const perform = async (): Promise<MediaFailure | null> => {
    if (!adapter) return null;
    const built = buildParams({
      operation: edit ? "edit" : "generate", agentId: agent, adapter: adapter.id, kind: submitKind, prompt, negativePrompt: negative, specs, values,
      ...(edit && props.mode === "edit" && op ? (op.op === "videoEdit" ? { referenceVideoId: props.source.id } : { referenceId: props.source.id }) : {}),
      ...(op?.needsMask ? { maskId } : {}),
    });
    try {
      const r = (await getApi().rpc(built.method, built.params, { write: true })) as { jobId?: string };
      if (typeof r.jobId === "string") props.onQueued(r.jobId);
      return null;
    } catch (e) {
      return classifyFailure(e);
    }
  };

  const submit = async (e: Event): Promise<void> => {
    e.preventDefault();
    setTried(true);
    if (!adapter || prompt.trim() === "" || problems.length > 0 || maskMissing || inFlight.current) return;
    if (!adapter.local) { setConfirming(true); return; }
    inFlight.current = true; setBusy(true); setFailure(null);
    const f = await perform();
    inFlight.current = false; setBusy(false);
    if (f) setFailure(f); else props.onClose();
  };

  const body = ((): View => {
    if (loadFailure) return h(FailureNote, { failure: loadFailure });
    if (!data) return h(PageLoading, { label: t("state.loading") });
    if (candidates.length === 0 || (!edit && kinds.length === 0)) return h("p", { class: "libmedia-empty" }, edit ? t("libmedia.edit.none") : t("libmedia.noAdapters"));
    return h("form", { class: "libmedia-form", noValidate: true, onSubmit: (e: Event) => { void submit(e); } },
      edit ? h("p", { class: "libmedia-source" }, t("libmedia.edit.source", { prompt: props.source.prompt })) : null,
      !edit && kinds.length > 1
        ? h(Field, { id: "lm-kind", label: t("libmedia.field.kind") },
            h("select", { id: "lm-kind", value: effectiveKind, onChange: (e: Event) => { setKind((e.currentTarget as HTMLSelectElement).value as Kind); setAdapterId(""); setValues({}); } },
              kinds.map((k) => h("option", { key: k, value: k }, t(`libmedia.kind.${k}`)))))
        : null,
      h(Field, { id: "lm-adapter", label: t("libmedia.field.adapter") },
        h("select", { id: "lm-adapter", value: adapter?.id ?? "", onChange: (e: Event) => { setAdapterId((e.currentTarget as HTMLSelectElement).value); setOpName(""); setValues({}); } },
          candidates.map((a) => h("option", { key: a.id, value: a.id }, a.model ? `${a.id} · ${a.model}` : a.id)))),
      edit && ops.length > 0
        ? h(Field, { id: "lm-op", label: t("libmedia.edit.operation") },
            h("select", { id: "lm-op", value: op?.op ?? "", onChange: (e: Event) => { setOpName((e.currentTarget as HTMLSelectElement).value); setValues({}); } },
              ops.map((o) => h("option", { key: o.op, value: o.op }, t(`libmedia.edit.op.${o.op === "edit" ? "edit" : o.op}` as Key)))))
        : null,
      op?.needsMask && props.mode === "edit"
        ? h(Field, { id: "lm-mask", label: t("libmedia.edit.mask"), error: tried && maskMissing ? t("libmedia.edit.maskNone") : undefined },
            h("select", { id: "lm-mask", value: maskId, ...bad(tried && maskMissing ? "x" : undefined, "lm-mask"), onChange: (e: Event) => { setMaskId((e.currentTarget as HTMLSelectElement).value); } },
              h("option", { value: "" }, t("libmedia.edit.maskNone")),
              props.masks.filter((m) => m.id !== props.source.id).map((m) => h("option", { key: m.id, value: m.id }, m.prompt))))
        : null,
      data.agents.length > 1
        ? h(Field, { id: "lm-agent", label: t("libmedia.field.agent") },
            h("select", { id: "lm-agent", value: agent, onChange: (e: Event) => { setAgent((e.currentTarget as HTMLSelectElement).value); } },
              data.agents.map((a) => h("option", { key: a, value: a }, a))))
        : data.agents.length === 0
          ? h(Field, { id: "lm-agent", label: t("libmedia.field.agent") },
              h("input", { id: "lm-agent", value: agent, onInput: (e: Event) => { setAgent((e.currentTarget as HTMLInputElement).value); } }))
          : null,
      h(Field, { id: "lm-prompt", label: t("libmedia.field.prompt"), error: tried && prompt.trim() === "" ? t("libmedia.field.required") : undefined },
        h("textarea", { id: "lm-prompt", class: "libmedia-prompt", rows: 4, maxLength: 32000, required: true, value: prompt, ...bad(tried && prompt.trim() === "" ? "x" : undefined, "lm-prompt"),
          onInput: (e: Event) => { setPrompt((e.currentTarget as HTMLTextAreaElement).value); } })),
      submitKind === "image"
        ? h(Field, { id: "lm-negative", label: t("libmedia.field.negative") },
            h("textarea", { id: "lm-negative", class: "libmedia-prompt", rows: 2, maxLength: 32000, value: negative, onInput: (e: Event) => { setNegative((e.currentTarget as HTMLTextAreaElement).value); } }))
        : null,
      h("fieldset", { class: "libmedia-params" },
        h("legend", {}, t("libmedia.params")),
        specs.length === 0 ? h("p", { class: "field-hint" }, t("libmedia.params.none")) : null,
        specs.map((spec) => h(ParamField, { key: spec.key, spec, values, set, error: tried ? problems.find(([s]) => s === spec)?.[1] ?? null : null }))),
      failure ? h(FailureNote, { failure }) : null,
      h("div", { class: "dialog-actions" },
        h("button", { type: "button", class: "btn", onClick: props.onClose }, t("dialog.close")),
        h("button", { type: "submit", class: "btn btn-primary", "aria-disabled": busy ? "true" : undefined }, busy ? t("libmedia.generate.sending") : edit ? t("libmedia.edit.submit") : t("libmedia.generate.submit"))));
  })();

  return h("div", {},
    h(Dialog, { title, onClose: props.onClose }, body),
    confirming && adapter
      ? h(ConfirmDialog, {
          title: t("libmedia.cloud.title"), confirmLabel: t("libmedia.cloud.confirm"), onClose: () => { setConfirming(false); },
          onConfirm: async () => {
            const f = await perform();
            if (f) return { ok: false as const, message: failureText(f) };
            props.onClose();
            return { ok: true as const };
          },
        }, t("libmedia.cloud.body", { adapter: adapter.id }))
      : null);
}

function ParamField({ spec, values, set, error }: { spec: ParamSpec; values: FormValues; set: (key: string, v: string | boolean) => void; error: string | null }): View {
  const id = `lm-p-${spec.key}`;
  const label = paramLabel(spec);
  const msg = error ? problemText(spec, error) : undefined;
  if (spec.type === "bool") {
    return h("div", { class: "field libmedia-check" },
      h("label", {}, h("input", { id, type: "checkbox", checked: values[spec.key] === true, onChange: (e: Event) => { set(spec.key, (e.currentTarget as HTMLInputElement).checked); } }), " ", label));
  }
  if (spec.type === "enum") {
    return h(Field, { id, label, error: msg },
      h("select", { id, value: String(values[spec.key] ?? ""), ...bad(msg, id), onChange: (e: Event) => { set(spec.key, (e.currentTarget as HTMLSelectElement).value); } },
        h("option", { value: "" }, t("libmedia.param.default")),
        spec.options.map((o) => h("option", { key: o, value: o }, o))));
  }
  if (spec.type === "size") {
    return h("fieldset", { class: "libmedia-size" },
      h("legend", {}, label),
      h(Field, { id: `${id}-w`, label: t("libmedia.param.width"), error: msg },
        h("input", { id: `${id}-w`, type: "number", inputMode: "numeric", min: 1, max: spec.max, value: String(values[`${spec.key}.width`] ?? ""), ...bad(msg, `${id}-w`), onInput: (e: Event) => { set(`${spec.key}.width`, (e.currentTarget as HTMLInputElement).value); } })),
      h(Field, { id: `${id}-h`, label: t("libmedia.param.height") },
        h("input", { id: `${id}-h`, type: "number", inputMode: "numeric", min: 1, max: spec.max, value: String(values[`${spec.key}.height`] ?? ""), onInput: (e: Event) => { set(`${spec.key}.height`, (e.currentTarget as HTMLInputElement).value); } })));
  }
  return h(Field, { id, label, error: msg },
    h("input", { id, type: "number", step: spec.type === "int" ? 1 : "any", ...(spec.min !== undefined ? { min: spec.min } : {}), ...(spec.max !== undefined ? { max: spec.max } : {}),
      value: String(values[spec.key] ?? ""), ...bad(msg, id), onInput: (e: Event) => { set(spec.key, (e.currentTarget as HTMLInputElement).value); } }));
}
