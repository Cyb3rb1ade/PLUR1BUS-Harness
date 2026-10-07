import { h, type ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { Dialog } from "../../components/dialog.ts";
import { t } from "../../i18n.ts";
import { CAPABILITIES, KINDS, type ModelEntry } from "./model.ts";
import type { ModelCapability, ModelKind, ModelOverrides } from "./rpc-types.ts";
import { capText, isForbidden, kindText, modelsApi } from "./shared.ts";

type Errors = Partial<Record<"provider" | "id" | "context", string>>;

function Field({ id, label, error, children }: { id: string; label: string; error?: string | undefined; children?: ComponentChildren }): View {
  return h("div", { class: "field" },
    h("label", { for: id }, label),
    children,
    error ? h("p", { class: "form-error", id: `${id}-err` }, error) : null);
}

const capLabel = capText;

/** Edit the overrides of one model, or (without `model`) add a manual model. Empty fields are left out, so the provider's value stays. */
export function OverrideDialog({ model, onClose, onSaved }: { model?: ModelEntry; onClose: () => void; onSaved: () => void }): View {
  const o: ModelOverrides = model?.overrides ?? {};
  const [provider, setProvider] = useState("");
  const [id, setId] = useState("");
  const [displayName, setDisplayName] = useState(o.displayName ?? "");
  const [kind, setKind] = useState<ModelKind | "">(o.kind ?? "");
  const [context, setContext] = useState(o.contextWindow === undefined ? "" : String(o.contextWindow));
  const [aliases, setAliases] = useState((o.aliases ?? []).join(", "));
  const [caps, setCaps] = useState<ReadonlySet<ModelCapability>>(new Set(o.capabilities ?? []));
  const [errors, setErrors] = useState<Errors>({});
  const [failure, setFailure] = useState("");
  const [busy, setBusy] = useState(false);
  const add = model === undefined;

  const call = async (params: Parameters<typeof send>[0]): Promise<void> => {
    setBusy(true); setFailure("");
    try { await send(params); onSaved(); } catch (e) { setFailure(isForbidden(e) ? t("models.err.forbidden") : t("models.err.failed")); setBusy(false); }
  };

  const save = (): void => {
    if (busy) return;
    const errs: Errors = {};
    if (add && provider.trim() === "") errs.provider = t("models.err.required");
    if (add && id.trim() === "") errs.id = t("models.err.required");
    const ctx = context.trim();
    let contextWindow: number | undefined;
    if (ctx !== "") {
      if (/^\d+$/.test(ctx) && Number(ctx) >= 1 && Number.isSafeInteger(Number(ctx))) contextWindow = Number(ctx);
      else errs.context = t("models.err.context");
    }
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    const set: ModelOverrides = {};
    if (displayName.trim()) set.displayName = displayName.trim();
    if (kind) set.kind = kind;
    if (contextWindow !== undefined) set.contextWindow = contextWindow;
    const names = aliases.split(",").map((a) => a.trim()).filter((a) => a !== "");
    if (names.length > 0) set.aliases = names;
    if (caps.size > 0) set.capabilities = CAPABILITIES.filter((c) => caps.has(c));
    void call(add ? { provider: provider.trim(), id: id.trim(), set, create: true } : { provider: model.provider, id: model.id, set });
  };

  const toggle = (c: ModelCapability): void => { const n = new Set(caps); if (n.has(c)) n.delete(c); else n.add(c); setCaps(n); };

  return h(Dialog, {
    title: add ? t("models.addManual") : t("models.editTitle", { name: model.displayName }), onClose,
    actions: [
      !add ? h("button", { key: "reset", type: "button", class: "btn btn-quiet", onClick: () => { if (!busy) void call({ provider: model.provider, id: model.id, clear: "all" }); } }, t("models.resetAll")) : null,
      h("button", { key: "cancel", type: "button", class: "btn", onClick: onClose }, t("models.cancel")),
      h("button", { key: "save", type: "button", class: "btn btn-primary", "aria-disabled": busy, onClick: save }, t("models.save")),
    ],
  },
    h("p", { class: "reading" }, t("models.form.help")),
    h("p", { class: "form-error", role: "alert" }, failure),
    add ? h(Field, { id: "ov-provider", label: t("models.form.provider"), error: errors.provider },
      h("input", { id: "ov-provider", type: "text", value: provider, "aria-invalid": errors.provider !== undefined, ...(errors.provider ? { "aria-describedby": "ov-provider-err" } : {}), onInput: (e: Event) => setProvider((e.target as HTMLInputElement).value) })) : null,
    add ? h(Field, { id: "ov-id", label: t("models.form.id"), error: errors.id },
      h("input", { id: "ov-id", type: "text", value: id, "aria-invalid": errors.id !== undefined, ...(errors.id ? { "aria-describedby": "ov-id-err" } : {}), onInput: (e: Event) => setId((e.target as HTMLInputElement).value) })) : null,
    h(Field, { id: "ov-name", label: t("models.form.displayName") },
      h("input", { id: "ov-name", type: "text", value: displayName, onInput: (e: Event) => setDisplayName((e.target as HTMLInputElement).value) })),
    h(Field, { id: "ov-kind", label: t("models.form.kind") },
      h("select", { id: "ov-kind", value: kind, onChange: (e: Event) => setKind((e.target as HTMLSelectElement).value as ModelKind | "") },
        h("option", { value: "", selected: kind === "" }, t("models.form.keep")),
        KINDS.map((k) => h("option", { key: k, value: k, selected: k === kind }, kindText(k))))),
    h(Field, { id: "ov-context", label: t("models.form.context"), error: errors.context },
      h("input", { id: "ov-context", type: "text", inputMode: "numeric", value: context, "aria-invalid": errors.context !== undefined, ...(errors.context ? { "aria-describedby": "ov-context-err" } : {}), onInput: (e: Event) => setContext((e.target as HTMLInputElement).value) })),
    h(Field, { id: "ov-aliases", label: t("models.form.aliases") },
      h("input", { id: "ov-aliases", type: "text", value: aliases, onInput: (e: Event) => setAliases((e.target as HTMLInputElement).value) })),
    h("fieldset", { class: "toggle-group" },
      h("legend", {}, t("models.form.capabilities")),
      CAPABILITIES.map((c) => h("button", { key: c, type: "button", class: "btn btn-quiet", "aria-pressed": caps.has(c), onClick: () => toggle(c) }, capLabel(c)))));
}

function send(p: { provider: string; id: string; set?: ModelOverrides; clear?: "all"; create?: boolean }): Promise<unknown> {
  return modelsApi().rpc("models.setOverride", p);
}

/** Confirm removing a manual entry (a scan cannot bring it back). */
export function RemoveDialog({ model, onClose, onRemoved }: { model: ModelEntry; onClose: () => void; onRemoved: () => void }): View {
  const [failure, setFailure] = useState("");
  const [busy, setBusy] = useState(false);
  const remove = async (): Promise<void> => {
    if (busy) return;
    setBusy(true); setFailure("");
    try { await modelsApi().rpc("models.removeManual", { provider: model.provider, id: model.id }); onRemoved(); } catch (e) { setFailure(isForbidden(e) ? t("models.err.forbidden") : t("models.err.failed")); setBusy(false); }
  };
  return h(Dialog, {
    title: t("models.removeManual"), onClose,
    actions: [
      h("button", { key: "c", type: "button", class: "btn", onClick: onClose }, t("models.cancel")),
      h("button", { key: "r", type: "button", class: "btn btn-primary", "aria-disabled": busy, onClick: () => { void remove(); } }, t("models.remove")),
    ],
  },
    h("p", { class: "form-error", role: "alert" }, failure),
    h("p", {}, t("models.removeConfirm", { provider: model.provider, id: model.id })),
    h("p", { class: "reading" }, t("models.removeBody")));
}
