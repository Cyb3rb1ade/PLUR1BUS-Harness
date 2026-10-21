import type { MessageKey } from "../i18n.ts";
import type { Transport } from "../ipc.ts";
import { element, append } from "../components/dom.ts";
import { button } from "../components/button.ts";
import { errorLine, noticeLines, publicLines, type Line, type ModelState, type TransportModel } from "../models/transport-model.ts";

type Translate = (key: MessageKey, values?: Record<string, string>) => string;
export type ChoiceOptions = {
  /** Distinguishes the ids of two choosers on one page (add form, *Weg ändern…* dialog). */
  idPrefix: string;
  /** A confirmation lasts for this app session only (spec §3.2, `transport.public.session`). */
  storeReadOnly?: boolean;
  /** Called after every change the surrounding form may care about (submit state). */
  onChange?: () => void;
};

function text(t: Translate, line: Line): string {
  return t(line.key, line.values);
}

/**
 * The path chooser of spec §7.1: a required radio group without preselection, the check panel (a polite live region:
 * „Prüfe {host} …“, then the notices of §5.3/§7.2), and for a public target the banner (announced once) with the
 * explicit confirmation. The model owns the state; this view repaints itself in place when the model changes.
 */
export function transportChoice(t: Translate, model: TransportModel, options: ChoiceOptions): HTMLElement {
  const p = options.idPrefix;
  const root = element("section", "transport-choice");
  const group = element("fieldset", "transport-options");
  group.setAttribute("role", "radiogroup");
  group.setAttribute("aria-required", "true");
  const legend = element("legend", "transport-question", t("transport.question"));
  legend.id = `${p}-question`;
  group.setAttribute("aria-labelledby", legend.id);
  group.append(legend);
  const radios = new Map<Transport, HTMLInputElement>();
  for (const [value, label, help] of [["tailscale", "transport.tailscale", "transport.tailscale.help"], ["direct", "transport.direct", "transport.direct.help"]] as const) {
    const option = element("label", "choice transport-option");
    const input = element("input");
    input.type = "radio";
    input.name = `${p}-transport`;
    input.id = `${p}-${value}`;
    input.value = value;
    option.htmlFor = input.id;
    const helpText = element("span", "choice-help", t(help));
    helpText.id = `${p}-${value}-help`;
    input.setAttribute("aria-describedby", helpText.id);
    input.addEventListener("change", () => { if (input.checked) model.setTransport(value); });
    const words = element("span", "choice-words");
    append(words, element("span", "choice-title", t(label)), helpText);
    append(option, input, words);
    group.append(option);
    radios.set(value, input);
  }
  const panel = element("div", "transport-check");
  panel.id = `${p}-check`;
  panel.setAttribute("role", "status");
  panel.setAttribute("aria-live", "polite");
  const recheck = button(t("transport.check"), () => model.checkNow());
  recheck.classList.add("transport-recheck");
  const bannerSlot = element("div", "transport-banner-slot");
  append(root, group, panel, recheck, bannerSlot);

  let bannerKey: string | null = null;
  let ack: HTMLInputElement | null = null;
  function banner(state: ModelState): void {
    const report = state.report;
    const lines = report?.needsPublicAck ? publicLines(report, model.purpose) : [];
    if (!report || !lines.length) {
      bannerSlot.replaceChildren();
      bannerKey = null;
      ack = null;
      return;
    }
    const key = JSON.stringify([state.transport, report.addresses, report.hints.map(h => h.code), lines.map(l => l.key)]);
    if (key !== bannerKey) {
      bannerKey = key;
      const node = element("div", "banner banner-warning transport-public");
      const title = element("h3", "transport-public-title", t("transport.public.title"));
      title.id = `${p}-public-title`;
      // Announce a banner once; a view rebuilt with the same banner keeps it as a named region.
      node.setAttribute("role", model.announced.has(key) ? "region" : "alert");
      model.announced.add(key);
      node.setAttribute("aria-labelledby", title.id);
      node.append(title);
      for (const line of lines) node.append(element("p", undefined, text(t, line)));
      const label = element("label", "choice transport-ack");
      ack = element("input");
      ack.type = "checkbox";
      ack.id = `${p}-public-ack`;
      label.htmlFor = ack.id;
      const box = ack;
      box.addEventListener("change", () => model.setAck(box.checked));
      append(label, box, element("span", "choice-title", t("transport.public.confirm")));
      node.append(label);
      if (options.storeReadOnly) node.append(element("p", "transport-session", t("transport.public.session")));
      if (state.transport === "direct") {
        const alt = button(t("transport.public.alt"), () => { model.setTransport("tailscale"); queueMicrotask(() => radios.get("tailscale")?.focus()); }, "secondary");
        alt.classList.add("transport-alt");
        node.append(alt);
      }
      bannerSlot.replaceChildren(node);
    }
    if (ack) ack.checked = state.ack;
  }
  function paint(state: ModelState): void {
    for (const [value, input] of radios) input.checked = state.transport === value;
    const lines: string[] = [];
    if (state.status === "waiting" || state.status === "checking") lines.push(t("transport.checking", { host: state.host }));
    if (state.status === "done" && state.report) lines.push(...noticeLines(state.report).map(line => text(t, line)));
    if (state.status === "error" && state.error) {
      const line = errorLine(state.error, state.host);
      if (line && state.error !== "transport-confirm-needed") lines.push(text(t, line));
    }
    const current = Array.from(panel.children).map(node => node.textContent);
    if (current.length !== lines.length || current.some((value, index) => value !== lines[index])) {
      panel.replaceChildren(...lines.map(line => element("p", "transport-notice", line)));
    }
    recheck.disabled = !state.target || !state.transport;
    banner(state);
  }
  model.subscribe(state => { paint(state); options.onChange?.(); });
  paint(model.state);
  return root;
}
