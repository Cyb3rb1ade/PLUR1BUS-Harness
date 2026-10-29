/** Structured profile/path mappings; no raw source configuration or secret input. */
import { h } from "preact";
import type { View } from "../../view.ts";
import { t } from "../../i18n.ts";
import { storeReplacement, type DiscoveredStore, type UnmappedSourcePath } from "./store-mappings.ts";
import type { AdminImportPlanParams } from "../../../../rpc-schema/generated/types.ts";

type Options = NonNullable<AdminImportPlanParams["options"]>;
/** Edits bounded, explicit mappings. The Core applies Decision8 transport and target-root checks independently. */
export function ImportMappings({
  options,
  set,
  busy,
  hostPathsAllowed,
  stores,
  paths,
}: {
  options: Options;
  set(value: Options): void;
  busy: boolean;
  hostPathsAllowed: boolean;
  stores: readonly DiscoveredStore[];
  paths: readonly UnmappedSourcePath[];
}): View {
  const field = (id: string, label: string, value: string, change: (value: string) => void, length = 256) =>
    h(
      "div",
      { class: "field" },
      h("label", { for: id }, label),
      h("input", {
        id,
        type: "text",
        maxLength: length,
        value,
        disabled: busy,
        onInput: (event: Event) => change((event.target as HTMLInputElement).value),
      }),
    );
  return h(
    "div",
    {},
    h(
      "fieldset",
      { disabled: busy },
      h("legend", null, t("imports.profileMap")),
      (options.mapProfiles ?? []).map((mapping, index) =>
        h(
          "div",
          { key: index },
          field(`import-profile-from-${index}`, t("imports.profileName"), mapping.profile, (value) =>
            set({
              ...options,
              mapProfiles: options.mapProfiles!.map((entry, at) =>
                at === index ? { ...entry, profile: value } : entry,
              ),
            }),
          ),
          field(`import-profile-to-${index}`, t("imports.targetAgent"), mapping.agentId, (value) =>
            set({
              ...options,
              mapProfiles: options.mapProfiles!.map((entry, at) =>
                at === index ? { ...entry, agentId: value } : entry,
              ),
            }),
          ),
          h(
            "button",
            {
              type: "button",
              class: "btn btn-quiet",
              onClick: () =>
                set({ ...options, mapProfiles: options.mapProfiles!.filter((_entry, at) => at !== index) }),
            },
            t("imports.removeMapping"),
          ),
        ),
      ),
      h(
        "button",
        {
          type: "button",
          class: "btn btn-quiet",
          disabled: (options.mapProfiles?.length ?? 0) >= 10000,
          onClick: () =>
            set({ ...options, mapProfiles: [...(options.mapProfiles ?? []), { profile: "", agentId: "" }] }),
        },
        t("imports.addProfile"),
      ),
    ),
    hostPathsAllowed || stores.length || options.maps?.length
      ? h(
          "fieldset",
          { disabled: busy },
          h("legend", null, t("imports.pathMap")),
          h("p", { class: "field-hint" }, t("imports.storeMappingHint")),
          (options.maps ?? []).map((mapping, index) =>
            h(
              "div",
              { key: index },
              paths.length
                ? h(
                    "div",
                    { class: "field" },
                    h("label", { for: `import-map-declared-${index}` }, t("imports.declaredPaths")),
                    h(
                      "select",
                      {
                        id: `import-map-declared-${index}`,
                        value: paths.some((path) => path.path === mapping.from) ? mapping.from : "",
                        onChange: (event: Event) => {
                          const from = (event.target as HTMLSelectElement).value;
                          set({
                            ...options,
                            maps: options.maps!.map((entry, at) => (at === index ? { ...entry, from } : entry)),
                          });
                        },
                      },
                      h("option", { value: "" }, t("imports.choose")),
                      paths.map((path) =>
                        h(
                          "option",
                          { key: path.path, value: path.path },
                          `${path.path} · ${path.kind === "store" ? t("imports.externalStore") : path.kind === "skills" ? t("imports.externalSkills") : t("imports.externalWorkspace")}`,
                        ),
                      ),
                    ),
                  )
                : null,
              field(
                `import-map-from-${index}`,
                t("imports.fromPath"),
                mapping.from,
                (value) =>
                  set({
                    ...options,
                    maps: options.maps!.map((entry, at) => (at === index ? { ...entry, from: value } : entry)),
                  }),
                4096,
              ),
              stores.length
                ? h(
                    "div",
                    { class: "field" },
                    h("label", { for: `import-map-kind-${index}` }, t("imports.replacementLocation")),
                    h(
                      "select",
                      {
                        id: `import-map-kind-${index}`,
                        value: mapping.to.startsWith("store:") ? mapping.to : "path",
                        onChange: (event: Event) => {
                          const selected = (event.target as HTMLSelectElement).value;
                          const to = selected.startsWith("store:") ? storeReplacement(selected.slice(6), stores) : "";
                          set({
                            ...options,
                            maps: options.maps!.map((entry, at) => (at === index ? { ...entry, to } : entry)),
                          });
                        },
                      },
                      h(
                        "option",
                        { value: "path", disabled: !hostPathsAllowed },
                        hostPathsAllowed ? t("imports.toPath") : t("imports.choose"),
                      ),
                      stores.map((store) =>
                        h(
                          "option",
                          { key: store.id, value: `store:${store.id}` },
                          `${store.displayName} (${store.path})`,
                        ),
                      ),
                    ),
                  )
                : null,
              hostPathsAllowed && !mapping.to.startsWith("store:")
                ? field(
                    `import-map-to-${index}`,
                    t("imports.toPath"),
                    mapping.to,
                    (value) =>
                      set({
                        ...options,
                        maps: options.maps!.map((entry, at) => (at === index ? { ...entry, to: value } : entry)),
                      }),
                    4096,
                  )
                : null,
              h(
                "button",
                {
                  type: "button",
                  class: "btn btn-quiet",
                  onClick: () => set({ ...options, maps: options.maps!.filter((_entry, at) => at !== index) }),
                },
                t("imports.removeMapping"),
              ),
            ),
          ),
          h(
            "button",
            {
              type: "button",
              class: "btn btn-quiet",
              disabled: (options.maps?.length ?? 0) >= 64,
              onClick: () => set({ ...options, maps: [...(options.maps ?? []), { from: "", to: "" }] }),
            },
            t("imports.addMap"),
          ),
        )
      : null,
  );
}
