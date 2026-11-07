import { element, append } from "../components/dom.ts";
import { icon } from "../components/icon.ts";
import type { Connection, TrayView } from "../ipc.ts";
import type { MessageKey } from "../i18n.ts";

type Translate = (key: MessageKey, values?: Record<string, string>) => string;
const harnessWords = new Set(["starting", "ready", "degraded", "down", "disconnected", "unpaired", "updating", "rollback", "crashed"]);

/**
 * #740 Home chip (owner decision 2026-11-07, proposal 1): what the tray header says, one click from Connections.
 * Connection name, a status dot in the tray badge's colour and the tray's state word. The path stays in the tooltip,
 * except a public direct path or a Tailscale disconnect, which the chip shows in amber. Without a tray view (no native
 * shell, or not loaded yet) it names the active connection and says that the status is unknown; it never claims a state.
 */
export function connectionChip(tray: TrayView | null, fallback: Connection | null, t: Translate, open: () => void): HTMLButtonElement {
  const kind = tray ? tray.connectionKind : fallback?.kind ?? null;
  const name = (tray ? tray.connectionName : fallback?.name) ?? t("tray.noConnection");
  const word = tray && harnessWords.has(tray.harness) ? t(`tray.state.${tray.harness}` as MessageKey) : t("tray.unknown");
  const path = !tray ? null
    : tray.tailscaleNotice ? t("transport.path.tailscale-attention")
    : tray.path === "tailscale" ? t("transport.path.tailscale")
    : tray.path === "direct-public" ? t("transport.path.public")
    : tray.path === "direct" ? t("transport.path.direct")
    : null;
  const loud = tray?.path === "direct-public" || tray?.tailscaleNotice === true;
  const badge = tray?.badge ?? "unknown";
  const tone = badge === "attention" || loud ? "warning" : badge === "running" ? "ok" : "neutral";
  const control = element("button", `chip chip-${tone} connection-chip`);
  control.type = "button";
  control.dataset.badge = badge;
  control.dataset.focusKey = "connection-chip";
  const glyph = icon(kind === "remote" ? "remote" : kind ? "local" : "connections");
  glyph.setAttribute("width", "16");
  glyph.setAttribute("height", "16");
  const separator = () => { const node = element("span", "chip-separator", "·"); node.setAttribute("aria-hidden", "true"); return node; };
  const dot = element("span", "status-dot");
  dot.setAttribute("aria-hidden", "true");
  append(control, glyph, element("span", "chip-name", name), separator(), dot, element("span", "chip-state", word));
  if (path && loud) append(control, separator(), element("span", "chip-path", path));
  control.setAttribute("aria-label", [name, word, path].filter(Boolean).join(", "));
  const reasons = [
    path && !loud ? path : null,
    tray?.approvalsPending ? t("tray.approvalsPending") : null,
    tray?.secretsLocked ? t("tray.secretsLocked") : null,
  ].filter((reason): reason is string => !!reason);
  control.title = [...reasons, t("home.openConnections")].join(" · ");
  control.addEventListener("click", open);
  return control;
}
