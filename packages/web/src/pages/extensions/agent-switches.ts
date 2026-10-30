/** Per-agent activation delegates to fresh capability consent before enabling. */
import { h } from "preact";
import { useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { t } from "../../i18n.ts";
import { PageLoading } from "../../components/page-state.ts";
import { FailureState } from "../common/states.ts";
import { getApi, useLoad } from "../common/load.ts";
import type { ExtItem } from "../common/surfaces-rpc.ts";

export function AgentSwitches({
  item,
  onEnable,
  onChanged,
}: {
  item: ExtItem;
  onEnable(agents: string[]): void;
  onChanged(): void;
}): View {
  const { state, reload } = useLoad(
    (signal) =>
      getApi().rpc("agent.list", {}, { write: false, signal }) as Promise<{
        agents: { agentId: string; name?: string }[];
      }>,
    [],
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  if (state.status === "loading") return h(PageLoading, { label: t("state.loading") });
  if (state.status === "fail") return h(FailureState, { failure: state.failure, onRetry: reload });
  const disable = async (agentId: string): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      await getApi().rpc("ext.disable", { name: item.name, agents: [agentId] });
      onChanged();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("extensions.error.required"));
    } finally {
      setBusy(false);
    }
  };
  return h(
    "fieldset",
    { disabled: busy },
    h("legend", null, t("extensions.agents.enableFor")),
    error ? h("p", { role: "alert", class: "form-error" }, error) : null,
    state.data.agents.map((agent) => {
      const enabled = item.enabled && (item.agents === "all" || item.agents.includes(agent.agentId));
      return h(
        "button",
        {
          key: agent.agentId,
          type: "button",
          role: "switch",
          "aria-checked": enabled,
          class: enabled ? "btn btn-primary" : "btn btn-quiet",
          onClick: () => {
            if (enabled) void disable(agent.agentId);
            else onEnable([agent.agentId]);
          },
        },
        agent.name ?? agent.agentId,
      );
    }),
  );
}
