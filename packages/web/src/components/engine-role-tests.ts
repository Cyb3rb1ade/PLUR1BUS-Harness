import { h } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { View } from "../view.ts";
import { Card } from "./card.ts";
import { getApi } from "../api/shared.ts";
import { t, type Key } from "../i18n.ts";
import { currentRole } from "../pages/common/load.ts";

type Role = "embedder" | "reranker";
type Result = { ok: boolean; role: Role; durationMs: number; model?: string; dimensions?: number; errorClass?: string };
declare module "../api/index.ts" {
  interface RpcMethods { "admin.engine.test": { params: { role: Role }; result: Result } }
}
type State = { running: boolean; result?: Result; failed?: boolean };
const errorKeys: Record<string, Key> = {
  egress: "models.engine.error.egress", key: "models.engine.error.key", download: "models.engine.error.download",
  provider: "models.engine.error.provider", timeout: "models.engine.error.timeout", unsupported: "models.engine.error.unsupported",
};
function RoleTest({ role }: { role: Role }): View {
  const [state, setState] = useState<State>({ running: false });
  const inFlight = useRef(false), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const run = async () => {
    if (inFlight.current) return;
    inFlight.current = true; setState({ running: true });
    try {
      const result = await getApi().rpc("admin.engine.test", { role });
      if (alive.current) setState({ running: false, result });
    } catch { if (alive.current) setState({ running: false, failed: true }); }
    finally { inFlight.current = false; }
  };
  const r = state.result;
  return h("div", { class: "card" },
    h("h3", { class: "card-title" }, t(`models.engine.role.${role}`)),
    h("button", { type: "button", class: "btn", disabled: state.running, onClick: () => { void run(); }, "aria-label": t(`models.engine.${state.running ? "testing" : "test"}.${role}`) }, t(state.running ? "models.engine.testing" : "models.engine.test")),
    state.running ? h("p", { role: "status" }, t("models.engine.running")) : null,
    r?.ok ? h("p", { role: "status" }, t("models.engine.success", { ms: r.durationMs }), r.model ? ` · ${r.model}` : "", r.dimensions ? ` · ${t("models.engine.dimensions", { count: r.dimensions })}` : "") : null,
    (r && !r.ok) || state.failed ? h("p", { role: "alert", class: "form-error" }, t(errorKeys[r?.errorClass ?? ""] ?? "models.engine.error.provider")) : null);
}
/** The current engine configuration is tested only after an explicit human action. */
export function EngineRoleTests(): View | null {
  const role = currentRole();
  if (role !== "owner" && role !== "admin") return null;
  return h(Card, { title: t("models.engine.title") },
    h("p", { class: "reading" }, t("models.engine.note")),
    h(RoleTest, { role: "embedder" }), h(RoleTest, { role: "reranker" }),
    h("p", { class: "reading" }, t("models.engine.captionerUnsupported")));
}
