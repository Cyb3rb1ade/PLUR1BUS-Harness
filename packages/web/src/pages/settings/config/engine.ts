// The memory engine's models, read-only, at the end of the "Model roles" group of Settings → Models & providers. They are not model
// roles: the engine runs what `engine.embedding` and `engine.reranker` set (packages/core/src/engine-config.ts), so a role field for
// them would not change the models it runs. Shown is what `core.status` reports (`engine.models`: the embedder's model name, the
// reranker's provider) and how to change them; there is no control.
import { h } from "preact";
import type { View } from "../../../view.ts";
import { t, type Key } from "../../../i18n.ts";

export type EngineModel = { state: string; warming: boolean; id: string | null };
/** A model that is missing has not been reported by the engine yet. */
export type EngineModels = { embedder?: EngineModel; reranker?: EngineModel };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const STATES = new Set(["ready", "loading", "failed", "disabled"]);

function readModel(v: unknown): EngineModel | undefined {
  if (!isObj(v) || typeof v.state !== "string") return undefined;
  return { state: v.state, warming: v.warming === true, id: typeof v.id === "string" && v.id !== "" ? v.id : null };
}

/** `engine.models` of a `core.status` answer; null when the answer has no engine object (it is not a core status). */
export function readEngineModels(status: unknown): EngineModels | null {
  if (!isObj(status) || !isObj(status.engine)) return null;
  const models = isObj(status.engine.models) ? status.engine.models : {};
  const embedder = readModel(models.embedder), reranker = readModel(models.reranker);
  return { ...(embedder ? { embedder } : {}), ...(reranker ? { reranker } : {}) };
}

/** "intfloat/multilingual-e5-small (ready)"; only the state when the engine names no model. */
export function modelLine(m: EngineModel | undefined): string {
  if (!m) return t("settings.engine.unreported");
  const state = t(`settings.engine.state.${STATES.has(m.state) ? m.state : "unknown"}` as Key);
  const detail = m.warming ? `${state}, ${t("settings.engine.warming")}` : state;
  return m.id ? `${m.id} (${detail})` : detail;
}

/** `models` is null when core.status could not be read; `setupLink` for a role that may run the first-run setup. */
export function EngineModelsNote({ models, setupLink }: { models: EngineModels | null; setupLink: boolean }): View {
  return h("div", { class: "cfg-field", role: "group", "aria-labelledby": "cfg-engine-h" },
    h("h4", { id: "cfg-engine-h", class: "cfg-engine-h" }, t("settings.engine.title")),
    models ? h("dl", { class: "cfg-engine-facts" },
      h("dt", {}, t("settings.engine.embedding")), h("dd", {}, modelLine(models.embedder)),
      h("dt", {}, t("settings.engine.reranker")), h("dd", {}, modelLine(models.reranker)))
      : h("p", { class: "field-hint" }, t("settings.engine.unavailable")),
    h("p", { class: "field-hint" }, t("settings.engine.how")),
    setupLink ? h("div", {}, h("a", { href: "#/setup", class: "btn btn-quiet" }, t("settings.engine.setup"))) : null);
}
