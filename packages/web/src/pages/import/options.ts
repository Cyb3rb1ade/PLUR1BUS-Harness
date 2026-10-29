/** Import option controls reset the immutable preview whenever any requested transformation changes. */
import { h } from "preact";
import type { View } from "../../view.ts";
import { Card } from "../../components/card.ts";
import { t, type Key } from "../../i18n.ts";
import { ImportMappings } from "./mappings.ts";
import { importMappingsReady, sourceStoreReady } from "./store-mappings.ts";
import { ImportStoreModels } from "./store-models.ts";
import type { ImportFlow } from "./use-flow.ts";

/** Edits agent-independent options; the service validates store, licence, mapping and Owner-only secret proof. */
export function ImportOptions({ flow, hostPathsAllowed }: { flow: ImportFlow; hostPathsAllowed: boolean }): View {
  const { options, setOptions, setPlan, setPreflight, setSkills, busy, owner, createPlan, discoveredStores } = flow;
  const field = (id: string, label: string, value: string, set: (value: string) => void, maxLength = 256): View =>
    h(
      "div",
      { class: "field" },
      h("label", { for: id }, label),
      h("input", {
        id,
        type: "text",
        value,
        disabled: busy,
        maxLength,
        onInput: (event: Event) => set((event.target as HTMLInputElement).value),
      }),
    );
  const checkbox = (label: string, checked: boolean, set: (value: boolean) => void, disabled = false): View =>
    h(
      "label",
      { class: "checkbox-label" },
      h("input", {
        type: "checkbox",
        checked,
        disabled: busy || disabled,
        onChange: (event: Event) => set((event.target as HTMLInputElement).checked),
      }),
      " ",
      label,
    );
  const policy = h(
    "div",
    { class: "field" },
    h("label", { for: "import-conflict-policy" }, t("imports.conflictPolicy")),
    h(
      "select",
      {
        id: "import-conflict-policy",
        value: options.onConflict ?? "skip",
        disabled: busy,
        onChange: (event: Event) => {
          setOptions((current) => ({
            ...current,
            onConflict: (event.target as HTMLSelectElement).value as "skip" | "rename" | "replace",
          }));
          setPlan(null);
          setPreflight(null);
          setSkills(null);
        },
      },
      (["skip", "rename", "replace"] as const).map((choice) =>
        h("option", { value: choice }, t(`imports.${choice}` as Key)),
      ),
    ),
  );
  return h(
    Card,
    { title: t("imports.options") },
    policy,
    checkbox(
      t("imports.secretMigration"),
      !!options.migrateSecrets,
      (checked) => {
        setOptions((current) => ({ ...current, migrateSecrets: checked }));
        setPlan(null);
        setPreflight(null);
      },
      !owner,
    ),
    h("p", { class: "field-hint" }, t("imports.secretHint")),
    checkbox(t("imports.mergeProfiles"), !!options.mergeProfiles, (checked) => {
      setOptions((current) => ({ ...current, mergeProfiles: checked }));
      setPlan(null);
      setPreflight(null);
    }),
    h(
      "div",
      { class: "field" },
      h("label", { for: "import-adopt-store" }, t("imports.adoptStore")),
      h(
        "select",
        {
          id: "import-adopt-store",
          disabled: busy || !flow.detected?.stores?.length,
          value: options.adoptStoreId ?? "",
          onChange: (event: Event) => {
            const value = (event.target as HTMLSelectElement).value;
            setOptions((current) => {
              const next = { ...current };
              if (value) next.adoptStoreId = value;
              else delete next.adoptStoreId;
              return next;
            });
            setPlan(null);
            setPreflight(null);
          },
        },
        h("option", { value: "" }, t("imports.noAdoption")),
        (flow.detected?.stores ?? []).map((store) =>
          h(
            "option",
            { key: store.id, value: store.id },
            `${store.displayName} · ${store.kind === "shared" ? t("imports.sharedStore") : (flow.detected?.agents.find((agent) => agent.id === store.agentId)?.displayName ?? t("imports.targetAgent"))}${store.rows === undefined ? "" : ` · ${t("imports.storeRows", { rows: store.rows })}`}`,
          ),
        ),
      ),
      !flow.detected?.stores?.length ? h("p", { class: "field-hint" }, t("imports.noSourceStores")) : null,
    ),
    h(
      "div",
      { class: "field" },
      h("label", { for: "import-adopt-strategy" }, t("imports.adoptStrategy")),
      h(
        "select",
        {
          id: "import-adopt-strategy",
          value: options.adoptStrategy ?? "take-over",
          disabled: busy,
          onChange: (event: Event) => {
            setOptions((current) => ({
              ...current,
              adoptStrategy: (event.target as HTMLSelectElement).value as "take-over" | "re-embed",
            }));
            setPlan(null);
            setPreflight(null);
          },
        },
        h("option", { value: "take-over" }, t("imports.takeOver")),
        h("option", { value: "re-embed" }, t("imports.reembed")),
      ),
    ),
    options.adoptStrategy === "re-embed"
      ? h(
          "div",
          {},
          field("import-reembed-model", t("imports.reembedModel"), options.reembed?.model ?? "", (value) => {
            setOptions((current) => ({ ...current, reembed: { ...current.reembed, model: value } }));
            setPlan(null);
            setPreflight(null);
          }),
        )
      : null,
    h(ImportStoreModels, {
      store: flow.detected?.stores?.find((store) => store.id === options.adoptStoreId),
      reembed: options.adoptStrategy === "re-embed",
      targetModel: options.reembed?.model ?? "",
      onConfirmed: (role, model, selector) => {
        if (role === "target")
          setOptions((current) =>
            current.reembed?.model === model
              ? { ...current, reembed: { ...current.reembed, licenceId: selector } }
              : current,
          );
        setPlan(null);
        setPreflight(null);
      },
    }),
    h(ImportMappings, {
      options,
      busy,
      hostPathsAllowed,
      stores: discoveredStores,
      paths: flow.detected?.portability?.unmapped ?? [],
      set: (value) => {
        setOptions(value);
        setPlan(null);
        setPreflight(null);
      },
    }),
    h(
      "button",
      {
        type: "button",
        class: "btn btn-primary",
        disabled:
          busy ||
          !importMappingsReady(options.maps, discoveredStores, hostPathsAllowed) ||
          !sourceStoreReady(options.adoptStoreId, flow.detected?.stores),
        onClick: createPlan,
      },
      t("imports.plan"),
    ),
  );
}
