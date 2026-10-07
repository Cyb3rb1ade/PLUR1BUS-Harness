// "New chat": pick an agent (GET /api/v1/agents), optionally not remembered, write the first message. session.create is
// documented with `memoryMode`, so the incognito switch is real; a per-chat model is not in docs/rpc.md, so none is offered.
import { h } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import { t, type Key } from "../../i18n.ts";
import { navigate } from "../../router.ts";
import type { View } from "../../view.ts";
import { Composer } from "./composer.ts";
import type { MemoryMode } from "./rpc-types.ts";
import { agents, api, carryDraft, loadAgents, refreshList, submitErrorKey } from "./store.ts";

export function NewChat(): View {
  const id = useId();
  const [pick, setPick] = useState<string | null>(null);
  const [incognito, setIncognito] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Key | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { void loadAgents(); }, []);

  const a = agents.value;
  const names = a.status === "ready" ? a.agents : [];
  const agentId = pick !== null && names.includes(pick) ? pick : (names[0] ?? null);

  const start = async (): Promise<void> => {
    const first = text.replace(/\s+$/, "");
    if (busy || agentId === null || first === "") return;
    setBusy(true);
    setNotice(null);
    const memoryMode: MemoryMode = incognito ? "incognito" : "remember";
    let sessionId: string;
    try {
      sessionId = (await api.rpc("session.create", { agentId, kind: "direct", memoryMode })).session.id;
    } catch (e) {
      setNotice(submitErrorKey(e));
      setBusy(false);
      box.current?.focus();
      return;
    }
    let error: Key | null = null;
    try { await api.rpc("session.submit", { sessionId, text: first }); } catch (e) { error = submitErrorKey(e); }
    // The chat exists either way; if the first message did not go out it is put back into that chat's composer.
    if (error !== null) carryDraft(sessionId, first, error);
    void refreshList(true);
    navigate(`/chat/${encodeURIComponent(sessionId)}`);
  };

  return h("div", { class: "chat-pane transcript" },
    h("h2", null, t("chat.new.heading")),
    h("p", { class: "lead" }, t("chat.new.lead")),
    a.status === "loading" ? h("p", { class: "chat-note", role: "status" }, t("chat.agents.loading")) : null,
    a.status === "error"
      ? h("div", { class: "chat-notice", role: "alert" }, t("chat.agents.failed"), " ", h("button", { type: "button", class: "btn btn-quiet", onClick: () => { void loadAgents(); } }, t("state.retry")))
      : null,
    a.status === "ready" && names.length === 0 ? h("p", { class: "chat-note" }, t("chat.agents.none")) : null,
    names.length > 0
      ? h("div", { class: "chat-field" },
        h("label", { for: `${id}-agent` }, t("chat.agent")),
        h("select", { id: `${id}-agent`, value: agentId ?? "", onChange: (e: Event) => { setPick((e.target as HTMLSelectElement).value); } },
          names.map((n) => h("option", { key: n, value: n, selected: n === agentId }, n))))
      : null,
    h("div", { class: "chat-field" },
      h("label", { class: "chat-check" },
        h("input", { type: "checkbox", checked: incognito, "aria-describedby": `${id}-incognito`, onChange: (e: Event) => { setIncognito((e.target as HTMLInputElement).checked); } }),
        t("chat.incognito.label")),
      h("p", { class: "chat-hint", id: `${id}-incognito` }, t("chat.incognito.hint"))),
    notice ? h("p", { class: "chat-notice", role: "alert" }, t(notice)) : null,
    h(Composer, {
      label: t("chat.compose.first"), placeholder: agentId === null ? "" : t("chat.compose.placeholder", { agent: agentId }), value: text, onInput: setText,
      onSend: () => { void start(); }, sendLabel: t("chat.start"), ready: !busy && agentId !== null, box,
    }));
}
