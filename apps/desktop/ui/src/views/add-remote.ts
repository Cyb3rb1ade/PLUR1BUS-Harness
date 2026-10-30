import type { Connection, DesktopTransport, Paired, PairPrefill, TransportView } from "../ipc.ts";
import type { MessageKey } from "../i18n.ts";
import { element, append } from "../components/dom.ts";
import { button } from "../components/button.ts";
import { normalizeOrigin } from "../models/origin-input.ts";
import { pairingCode, pairingFailure } from "../models/pairing-model.ts";
import { createTransportModel, errorLine, originHost, type TransportModel } from "../models/transport-model.ts";
import { transportChoice } from "./transport-choice.ts";
export type Translate = (key: MessageKey, values?: Record<string, string>) => string;
/** The one pairing in flight lives outside the form: the shell rebuilds views on late loads and must not unlock a
 * code that was already sent. */
const pairing: { busy: boolean; message: string; live: { sync(): void; failed(refusal?: "confirm" | "target"): void } | null } = { busy: false, message: "", live: null };
/** The path choice of the form in progress (transport choice §7.1) survives re-renders like the pairing state. */
let choice: { model: TransportModel; owner: DesktopTransport } | null = null;
function choiceFor(transport: DesktopTransport): TransportModel {
    if (!choice || choice.owner !== transport) choice = { model: createTransportModel(transport.transportCheck?.bind(transport), "remote"), owner: transport };
    return choice.model;
}
/** A fresh "add" (from the list) starts without the previous attempt's message or path; a pairing in flight is kept. */
export function resetPairing(): void { if (!pairing.busy) { pairing.message = ""; choice?.model.reset(); } }
export function addRemote(t: Translate, transport: DesktopTransport, done: (result: Paired) => void, cancel: () => void, repair?: Connection, prefill?: PairPrefill, repairView?: TransportView): HTMLElement {
    const form = element("form", "page-card pairing-form");
    append(form, element("h2", undefined, t(repair ? "pair.repair" : "pair.add")), element("p", undefined, t("pair.instructions")));
    function field(label: string, value: string, id: string) { const row = element("label", "field"); row.htmlFor = id; const input = element("input"); input.id = id; input.value = value; input.required = true; append(row, element("span", undefined, label), input); form.append(row); return input; }
    const name = field(t("pair.name"), repair?.name ?? "", "pair-name");
    name.maxLength = 120;
    name.readOnly = !!repair;
    const origin = field(t("pair.origin"), repair?.origin ?? prefill?.origin ?? "", "pair-origin");
    origin.maxLength = 2048;
    origin.readOnly = !!repair || !!prefill;
    if (prefill) {
        append(form, element("p", "eyebrow", t("link.origin")), element("h3", "connection-origin", prefill.origin));
        for (const pin of [prefill.pin, prefill.ca]) if (pin) append(form, element("p", undefined, t("link.pin")), element("code", "connection-pin", pin));
    }
    origin.autocomplete = "off";
    origin.spellcheck = false;
    const validation = element("p", "field-note");
    validation.id = "origin-validation";
    validation.setAttribute("aria-live", "polite");
    origin.setAttribute("aria-describedby", validation.id);
    form.append(validation);
    // Transport choice §7.1: the path, its check and a needed confirmation come between origin and code.
    const model = choiceFor(transport);
    if (repair && !model.state.transport && repairView) model.setTransport(repairView.transport);
    const fixedOrigin = repair?.origin ?? prefill?.origin;
    if (fixedOrigin) { const normalized = normalizeOrigin(fixedOrigin); model.setTarget(normalized ? { kind: "origin", origin: normalized } : null, normalized ? originHost(normalized) : ""); }
    form.append(transportChoice(t, model, { idPrefix: "pair-transport", storeReadOnly: repairView?.storeReadOnly, onChange: () => pairing.live?.sync() }));
    const codes = element("fieldset", "code-fields");
    append(codes, element("legend", undefined, t("pair.code")));
    const first = element("input"), second = element("input");
    first.id = "pair-code-first";
    second.id = "pair-code-second";
    for (const [i, input] of [first, second].entries()) {
        input.maxLength = 4;
        input.minLength = 4;
        input.required = true;
        input.autocomplete = "off";
        input.spellcheck = false;
        input.setAttribute("aria-label", t(i === 0 ? "pair.codeFirst" : "pair.codeSecond"));
        input.pattern = "[0-9A-HJKMNP-TV-Z]{4}";
        input.addEventListener("input", () => { input.value = input.value.toUpperCase(); });
        codes.append(input);
    }
    if (prefill) {
        const [a, b] = prefill.code.split("-"); first.value = a ?? ""; second.value = b ?? "";
        first.readOnly = second.readOnly = true;
    }
    form.append(codes, element("p", "field-note", t("pair.once")));
    const complete = field(t("pair.cliCode"), "", "pair-cli-code");
    complete.required = false;
    complete.maxLength = 43;
    complete.minLength = 43;
    complete.autocomplete = "off";
    complete.spellcheck = false;
    complete.pattern = "[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]";
    complete.addEventListener("input", () => { first.required = second.required = !complete.value; });
    if (prefill) complete.closest("label")!.hidden = true;
    else form.append(element("p", "field-note", t("pair.cliHint")));
    const status = element("p", "pair-status");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    form.append(status);
    const footer = element("div", "connection-actions");
    const submit = button(t("pair.submit"), () => { }, "primary");
    submit.type = "submit";
    append(footer, button(t("pair.cancel"), () => { if (!pairing.busy) pairing.message = ""; cancel(); }), submit);
    form.append(footer);
    origin.addEventListener("input", () => {
        const normalized = normalizeOrigin(origin.value);
        validation.textContent = normalized ?? t("pair.error.insecure-origin");
        origin.setAttribute("aria-invalid", String(!normalized));
        model.setTarget(normalized ? { kind: "origin", origin: normalized } : null, normalized ? originHost(normalized) : "");
    });
    pairing.live = {
        // Submit waits for a chosen path and, for a public target, the ticked confirmation.
        sync: () => { submit.disabled = pairing.busy || !model.ready(); status.textContent = pairing.message; },
        failed: refusal => { pairing.live?.sync();
            // A refusal before any harness contact did not use the code: keep it and go to what needs fixing.
            if (refusal === "confirm") (form.querySelector<HTMLInputElement>("#pair-transport-public-ack") ?? form.querySelector<HTMLInputElement>("input[name=pair-transport-transport]:checked"))?.focus();
            else if (refusal === "target") (origin.readOnly ? submit : origin).focus();
            else if (!prefill) { first.value = ""; second.value = ""; complete.value = ""; first.required = second.required = true; first.focus(); }
            else submit.focus();
        },
    };
    pairing.live.sync();
    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (pairing.busy)
            return;
        const normalized = normalizeOrigin(origin.value);
        if (!normalized) {
            validation.textContent = t("pair.error.insecure-origin");
            origin.setAttribute("aria-invalid", "true");
            origin.focus();
            return;
        }
        const path = model.state.transport;
        if (!path || !model.ready())
            return;
        const code = pairingCode(first.value, second.value, complete.value);
        if (!code) return;
        pairing.busy = true;
        pairing.message = t("pair.working");
        pairing.live?.sync();
        try {
            const result = await transport.pairCode({ name: name.value, origin: normalized, code, repairId: repair?.id ?? null, linkId: prefill?.linkId ?? null, transport: path, publicAck: model.state.ack });
            first.value = "";
            second.value = "";
            pairing.busy = false;
            pairing.message = "";
            done(result);
        }
        catch (error) {
            pairing.busy = false;
            // Rust's own check refused before any harness contact (spec §7.1, §8).
            const refusal = typeof error === "string" ? errorLine(error, originHost(normalized)) : null;
            if (refusal) {
                pairing.message = t(refusal.key, refusal.values);
                const confirm = error === "transport-confirm-needed";
                if (confirm) model.checkNow();
                pairing.live?.failed(confirm ? "confirm" : "target");
                return;
            }
            const failure = pairingFailure(error);
            pairing.message = t(`pair.error.${failure.error}`) + (failure.versions ? ` ${t("pair.apiVersions", failure.versions)}` : "");
            pairing.live?.failed();
        }
    });
    return form;
}
