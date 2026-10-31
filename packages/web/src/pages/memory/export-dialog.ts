/** Memory portable text export dialog. */
import { h } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { Dialog } from "../../components/dialog.ts";
import { Notice } from "../common/states.ts";
import { t } from "../../i18n.ts";
import { getApi } from "./data.ts";

export interface ExportDialogProps {
  onClose: () => void;
}

export function ExportDialog({ onClose }: ExportDialogProps): View {
  const [includeAgent, setIncludeAgent] = useState(false);
  const [agentId, setAgentId] = useState("");
  const [availableAgents, setAvailableAgents] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [exportedText, setExportedText] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getApi()
      .rpc("agent.list", {})
      .then((res: any) => {
        if (active && res?.agents) {
          const ids = res.agents.map((a: any) => a.agentId ?? a.id ?? a.name).filter(Boolean);
          setAvailableAgents(ids);
          if (ids.length > 0 && !agentId) setAgentId(ids[0]);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const handleExport = async () => {
    setLoading(true);
    setError(null);
    try {
      const params: any = {};
      if (includeAgent && agentId) {
        params.agentId = agentId;
      }
      const res: any = await getApi().rpc("memory.exportText", params);
      setExportedText(res?.text ?? "");
    } catch (err: any) {
      setError(err?.message ?? t("memory.action.failed"));
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = () => {
    if (exportedText) {
      void navigator.clipboard?.writeText(exportedText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleDownload = () => {
    if (!exportedText) return;
    const blob = new Blob([exportedText], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const today = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `plur1bus-memories-${today}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return h(
    Dialog,
    {
      title: t("memory.export.title"),
      onClose,
      actions: exportedText
        ? [
            h(
              "button",
              { type: "button", class: "btn", onClick: handleCopy },
              copied ? t("memory.export.copied") : t("memory.export.copy"),
            ),
            h(
              "button",
              { type: "button", class: "btn btn-primary", onClick: handleDownload },
              t("memory.export.download"),
            ),
            h(
              "button",
              { type: "button", class: "btn btn-quiet", onClick: onClose },
              t("memory.export.close"),
            ),
          ]
        : [
            h(
              "button",
              {
                type: "button",
                class: "btn btn-primary",
                disabled: loading,
                onClick: handleExport,
              },
              t("memory.export.run"),
            ),
            h(
              "button",
              { type: "button", class: "btn btn-quiet", onClick: onClose },
              t("memory.dialog.cancel"),
            ),
          ],
    },
    error ? h("p", { role: "alert", class: "form-error" }, error) : null,
    !exportedText
      ? h(
          "div",
          {},
          h(
            "label",
            { class: "checkbox-label" },
            h("input", {
              type: "checkbox",
              checked: includeAgent,
              onChange: (e: Event) => setIncludeAgent((e.target as HTMLInputElement).checked),
            }),
            " ",
            t("memory.export.includeAgentPrivate"),
          ),
          includeAgent
            ? h(
                "div",
                {},
                h(Notice, {}, t("memory.export.agentPrivateWarning")),
                h(
                  "div",
                  { class: "field" },
                  h("label", { for: "export-agent-select" }, t("memory.export.selectAgents")),
                  h(
                    "select",
                    {
                      id: "export-agent-select",
                      value: agentId,
                      onChange: (e: Event) => setAgentId((e.target as HTMLSelectElement).value),
                    },
                    availableAgents.map((id) => h("option", { key: id, value: id }, id)),
                  ),
                ),
              )
            : null,
        )
      : h(
          "div",
          {},
          h("p", { class: "reading" }, h("strong", null, t("memory.export.phrase"))),
          h("pre", { class: "export-text-display", "aria-label": t("memory.export.title") }, exportedText),
        ),
  );
}
